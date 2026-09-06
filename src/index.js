export { CameraRoom } from './room.js';

const json = (data, init = {}) => new Response(JSON.stringify(data), {
  ...init,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(init.headers || {})
  }
});

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  return origin ? {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-credentials': 'true',
    'vary': 'Origin'
  } : {};
}

function randomHex(bytes = 24) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function createCamera(env, body) {
  const title = String(body.title || 'Untitled camera').slice(0, 80);
  const visibility = body.visibility === 'unlisted' ? 'unlisted' : 'public';
  const maxViewers = Math.max(1, Math.min(8, Number(body.maxViewers) || 4));
  const relayOnly = body.relayOnly ? 1 : 0;
  const bitrateKbps = Math.max(250, Math.min(2500, Number(body.bitrateKbps) || 900));
  const token = randomHex(24);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();

  for (let i = 0; i < 20; i++) {
    const id = 1000 + Math.floor(Math.random() * 9000);
    try {
      await env.DB.prepare(`
        INSERT INTO cameras
        (id, title, status, visibility, token_hash, max_viewers, relay_only, bitrate_kbps, created_at, last_seen)
        VALUES (?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, title, visibility, tokenHash, maxViewers, relayOnly, bitrateKbps, now, now).run();
      return { id, title, visibility, maxViewers, relayOnly: !!relayOnly, bitrateKbps, token };
    } catch (e) {
      if (!String(e).toLowerCase().includes('unique') && !String(e).toLowerCase().includes('constraint')) throw e;
    }
  }
  throw new Error('Could not allocate a camera ID');
}

async function getCamera(env, id) {
  return env.DB.prepare(`
    SELECT id, title, status, visibility, max_viewers, relay_only, bitrate_kbps, created_at, last_seen
    FROM cameras WHERE id = ?
  `).bind(id).first();
}

async function requirePublisher(env, id, token) {
  const row = await env.DB.prepare('SELECT token_hash FROM cameras WHERE id = ?').bind(id).first();
  if (!row || !token) return false;
  return (await sha256Hex(token)) === row.token_hash;
}

async function turnConfig(env, cameraId) {
  const stunOnly = {
    iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
    turn: false
  };
  if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN) return stunOnly;

  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${env.TURN_API_TOKEN}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ ttl: 3600, customIdentifier: `camera-${cameraId}` })
  });
  if (!r.ok) return stunOnly;
  const data = await r.json();
  // Browsers tend to reject/timeout on alternate port 53; remove it here.
  for (const server of (data.iceServers || [])) {
    if (Array.isArray(server.urls)) server.urls = server.urls.filter(u => !String(u).includes(':53'));
  }
  return { iceServers: data.iceServers || stunOnly.iceServers, turn: true };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === '/api/health') return json({ ok: true, service: 'minewatch-p2p' }, { headers: cors });

      if (url.pathname === '/api/cameras' && request.method === 'GET') {
        const result = await env.DB.prepare(`
          SELECT id, title, status, max_viewers, relay_only, bitrate_kbps, created_at, last_seen
          FROM cameras WHERE visibility = 'public'
          ORDER BY created_at DESC LIMIT 24
        `).all();
        return json({ cameras: result.results || [] }, { headers: cors });
      }

      if (url.pathname === '/api/cameras' && request.method === 'POST') {
        if (env.CREATE_SECRET) {
          const auth = request.headers.get('authorization') || '';
          if (auth !== `Bearer ${env.CREATE_SECRET}`) return json({ error: 'invite_required' }, { status: 401, headers: cors });
        }
        const body = await request.json().catch(() => ({}));
        const cam = await createCamera(env, body);
        return json(cam, { status: 201, headers: cors });
      }

      const camMatch = url.pathname.match(/^\/api\/camera\/(\d{4})$/);
      if (camMatch && request.method === 'GET') {
        const id = Number(camMatch[1]);
        const row = await getCamera(env, id);
        if (!row) return json({ error: 'not_found' }, { status: 404, headers: cors });
        return json({ camera: {
          id: row.id,
          title: row.title,
          status: row.status,
          visibility: row.visibility,
          maxViewers: row.max_viewers,
          relayOnly: !!row.relay_only,
          bitrateKbps: row.bitrate_kbps,
          createdAt: row.created_at,
          lastSeen: row.last_seen
        }}, { headers: cors });
      }

      const liveMatch = url.pathname.match(/^\/api\/camera\/(\d{4})\/live$/);
      if (liveMatch && request.method === 'GET') {
        const id = Number(liveMatch[1]);
        const roomId = env.CAMERA_ROOMS.idFromName(String(id));
        const stub = env.CAMERA_ROOMS.get(roomId);
        const r = await stub.fetch(new Request('https://room/state'));
        const data = await r.json();
        return json(data, { headers: cors });
      }

      const stopMatch = url.pathname.match(/^\/api\/camera\/(\d{4})\/stop$/);
      if (stopMatch && request.method === 'POST') {
        const id = Number(stopMatch[1]);
        const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
        if (!(await requirePublisher(env, id, token))) return json({ error: 'unauthorized' }, { status: 401, headers: cors });
        const roomId = env.CAMERA_ROOMS.idFromName(String(id));
        const stub = env.CAMERA_ROOMS.get(roomId);
        await stub.fetch(new Request('https://room/stop', { method: 'POST' }));
        await env.DB.prepare("UPDATE cameras SET status='offline', last_seen=? WHERE id=?").bind(Date.now(), id).run();
        return json({ ok: true }, { headers: cors });
      }

      if (url.pathname === '/api/random' && request.method === 'GET') {
        const row = await env.DB.prepare(`
          SELECT id FROM cameras WHERE visibility='public' AND status='online'
          ORDER BY RANDOM() LIMIT 1
        `).first();
        if (!row) return json({ error: 'none_online' }, { status: 404, headers: cors });
        return json({ id: row.id }, { headers: cors });
      }

      const reportMatch = url.pathname.match(/^\/api\/camera\/(\d{4})\/report$/);
      if (reportMatch && request.method === 'POST') {
        const id = Number(reportMatch[1]);
        const body = await request.json().catch(() => ({}));
        const reason = String(body.reason || 'other').slice(0, 40);
        const detail = String(body.detail || '').slice(0, 500);
        const ip = request.headers.get('CF-Connecting-IP') || '';
        const remoteHash = ip ? await sha256Hex(`${ip}:${env.REPORT_SALT || 'minewatch'}`) : null;
        await env.DB.prepare('INSERT INTO reports(camera_id, reason, detail, created_at, remote_hash) VALUES (?, ?, ?, ?, ?)')
          .bind(id, reason, detail, Date.now(), remoteHash).run();
        return json({ ok: true }, { status: 201, headers: cors });
      }

      const turnMatch = url.pathname.match(/^\/api\/camera\/(\d{4})\/ice$/);
      if (turnMatch && request.method === 'GET') {
        const id = Number(turnMatch[1]);
        const row = await getCamera(env, id);
        if (!row) return json({ error: 'not_found' }, { status: 404, headers: cors });
        return json(await turnConfig(env, id), { headers: cors });
      }

      const wsMatch = url.pathname.match(/^\/ws\/(\d{4})$/);
      if (wsMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        const id = Number(wsMatch[1]);
        const row = await env.DB.prepare('SELECT token_hash, max_viewers FROM cameras WHERE id=?').bind(id).first();
        if (!row) return new Response('camera not found', { status: 404 });

        const role = url.searchParams.get('role') === 'publisher' ? 'publisher' : 'viewer';
        const peer = (url.searchParams.get('peer') || randomHex(8)).slice(0, 80);
        if (role === 'publisher') {
          const token = url.searchParams.get('token') || '';
          if (!token || (await sha256Hex(token)) !== row.token_hash) return new Response('unauthorized', { status: 401 });
        }

        const roomId = env.CAMERA_ROOMS.idFromName(String(id));
        const stub = env.CAMERA_ROOMS.get(roomId);
        const headers = new Headers(request.headers);
        headers.set('X-MW-Role', role);
        headers.set('X-MW-Peer', peer);
        headers.set('X-MW-Camera', String(id));
        headers.set('X-MW-Max-Viewers', String(row.max_viewers));
        return stub.fetch(new Request('https://room/connect', { headers }));
      }

      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(e);
      return json({ error: 'internal_error', detail: String(e?.message || e) }, { status: 500, headers: cors });
    }
  }
};
