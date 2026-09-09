const VALID_ROLES = new Set(['publisher', 'viewer']);
const MAX_WS_MESSAGE_CHARS = 128 * 1024;

export class CameraRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  sockets(role) {
    return this.ctx.getWebSockets(role);
  }

  send(ws, data) {
    try { ws.send(JSON.stringify(data)); } catch (_) {}
  }

  broadcast(data, except = null) {
    const payload = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(payload); } catch (_) {}
    }
  }

  findPeer(peerId) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment?.();
      if (a?.peerId === peerId) return ws;
    }
    return null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/state') {
      return Response.json({
        publisherOnline: this.sockets('publisher').length > 0,
        viewers: this.sockets('viewer').length
      });
    }

    if (url.pathname === '/stop' && request.method === 'POST') {
      for (const ws of this.sockets('publisher')) {
        try { ws.close(4000, 'publisher stopped'); } catch (_) {}
      }
      this.broadcast({ type: 'publisher-offline' });
      return Response.json({ ok: true });
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const role = request.headers.get('X-MW-Role') || 'viewer';
    if (!VALID_ROLES.has(role)) {
      return new Response('invalid websocket role', { status: 400 });
    }
    const peerId = request.headers.get('X-MW-Peer') || crypto.randomUUID();
    const cameraId = request.headers.get('X-MW-Camera') || '';
    const maxViewers = Math.max(1, Math.min(8, Number(request.headers.get('X-MW-Max-Viewers')) || 4));

    if (role === 'publisher' && this.sockets('publisher').length > 0) {
      return new Response('publisher already connected', { status: 409 });
    }
    if (role === 'viewer' && this.sockets('viewer').length >= maxViewers) {
      return new Response('camera full', { status: 429 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ role, peerId, cameraId });
    this.ctx.acceptWebSocket(server, [role, peerId]);

    this.send(server, { type: 'hello', role, peerId, cameraId, viewers: this.sockets('viewer').length });

    if (role === 'publisher') {
      await this.env.DB.prepare("UPDATE cameras SET status='online', last_seen=? WHERE id=?").bind(Date.now(), Number(cameraId)).run();
      for (const viewer of this.sockets('viewer')) {
        const a = viewer.deserializeAttachment?.();
        if (a?.peerId) this.send(server, { type: 'viewer-join', peerId: a.peerId });
      }
      this.broadcast({ type: 'publisher-online' }, server);
    } else {
      for (const publisher of this.sockets('publisher')) this.send(publisher, { type: 'viewer-join', peerId });
      this.broadcast({ type: 'viewer-count', viewers: this.sockets('viewer').length });
    }

    const history = await this.ctx.storage.get('chat') || [];
    if (history.length) this.send(server, { type: 'chat-history', messages: history.slice(-30) });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    if (message.length > MAX_WS_MESSAGE_CHARS) {
      try { ws.close(1009, 'message too large'); } catch (_) {}
      return;
    }
    let data;
    try { data = JSON.parse(message); } catch (_) { return; }
    const me = ws.deserializeAttachment?.() || {};

    if (data.type === 'offer' || data.type === 'answer' || data.type === 'ice') {
      const target = String(data.target || '').slice(0, 80);
      if (!target) return;
      const targetWs = this.findPeer(target);
      if (!targetWs) return;
      const them = targetWs.deserializeAttachment?.() || {};
      // Publisher may signal a viewer; a viewer may signal only the publisher.
      if (me.role === 'viewer' && them.role !== 'publisher') return;
      if (me.role === 'publisher' && them.role !== 'viewer') return;
      this.send(targetWs, { ...data, from: me.peerId, target: undefined });
      return;
    }

    if (data.type === 'chat') {
      const text = String(data.text || '').trim().slice(0, 240);
      if (!text) return;
      const name = String(data.name || (me.role === 'publisher' ? 'camera' : 'anonymous')).trim().slice(0, 24) || 'anonymous';
      const item = { id: crypto.randomUUID(), name, text, ts: Date.now(), role: me.role };
      const history = await this.ctx.storage.get('chat') || [];
      history.push(item);
      if (history.length > 50) history.splice(0, history.length - 50);
      await this.ctx.storage.put('chat', history);
      this.broadcast({ type: 'chat', message: item });
    }
  }

  async webSocketClose(ws) {
    const me = ws.deserializeAttachment?.() || {};
    if (me.role === 'publisher') {
      await this.env.DB.prepare("UPDATE cameras SET status='offline', last_seen=? WHERE id=?").bind(Date.now(), Number(me.cameraId)).run();
      this.broadcast({ type: 'publisher-offline' }, ws);
    } else if (me.role === 'viewer') {
      for (const publisher of this.sockets('publisher')) this.send(publisher, { type: 'viewer-leave', peerId: me.peerId });
      this.broadcast({ type: 'viewer-count', viewers: Math.max(0, this.sockets('viewer').length - 1) }, ws);
    }
  }

  webSocketError(ws) {
    try { ws.close(1011, 'websocket error'); } catch (_) {}
  }
}
