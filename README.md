# MineWatch P2P

Opt-in Minecraft camera sharing with a Cloudflare control plane and direct WebRTC video.

## Architecture

- Cloudflare Workers + Static Assets: site and REST API
- Durable Objects + WebSocket Hibernation: signaling, chat, viewer presence
- D1: camera directory and reports
- WebRTC: publisher -> viewer video path
- Cloudflare STUN: direct P2P NAT discovery
- Cloudflare TURN (optional): fallback or relay-only privacy mode

The Worker/DO never proxies the normal media path in direct mode.

## Included MVP

- public/unlisted Camera IDs
- random camera
- online/offline state
- max viewers (1-8)
- direct P2P WebRTC
- optional TURN fallback / relay-only mode
- bitrate cap
- optional audio
- live viewer count
- ephemeral-ish room chat (last 50 messages kept in DO storage)
- report endpoint
- browser publisher for end-to-end testing
- old MineWatch-inspired UI

## Deploy

1. Install dependencies:

```bash
npm install
```

2. Create D1:

```bash
npx wrangler d1 create minewatch-db
```

Copy the returned database ID into `wrangler.jsonc`.

3. Apply migrations:

```bash
npm run db:remote
```

4. Optional secrets:

```bash
npx wrangler secret put CREATE_SECRET
npx wrangler secret put REPORT_SALT
```

`CREATE_SECRET` turns camera creation into invite-only mode.

5. Optional Cloudflare Realtime TURN:

Create a TURN key in Cloudflare Realtime, then store the key ID and API token:

```bash
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_API_TOKEN
```

Without these, the app runs STUN-only direct P2P. Cameras marked relay-only will not be usable until TURN is configured.

6. Deploy:

```bash
npm run deploy
```

## Signaling protocol

WebSocket:

```text
/ws/:cameraId?role=publisher|viewer&peer=<uuid>&token=<publisher-token>
```

Messages:

```json
{"type":"viewer-join","peerId":"..."}
{"type":"offer","target":"peer-id","sdp":{}}
{"type":"answer","target":"peer-id","sdp":{}}
{"type":"ice","target":"peer-id","candidate":{}}
{"type":"chat","name":"user","text":"hello"}
```

The publisher maintains one `RTCPeerConnection` per viewer. That is true mesh/P2P broadcasting, so publisher upload is approximately:

```text
bitrate × simultaneous viewers
```

At 900 kbps and 4 viewers, allow roughly 3.6 Mbps plus overhead.

## Minecraft client mod plan

The Fabric client mod should:

1. show a persistent `MINEWATCH LIVE` HUD while sharing;
2. capture the Minecraft render framebuffer;
3. encode frames to a WebRTC video track;
4. connect to the same signaling WebSocket;
5. create one peer connection per viewer;
6. apply the camera bitrate cap;
7. stop immediately on user action, world disconnect, or game shutdown.

The browser publisher in `public/publish.html` is the protocol reference and can be used now to validate Cloudflare signaling before native Minecraft capture is added.

## Important privacy detail

Direct WebRTC peers can learn network-address information through ICE candidates. If that is unacceptable, use relay-only mode with TURN. Do not represent the service as private/anonymous when direct P2P is enabled.
