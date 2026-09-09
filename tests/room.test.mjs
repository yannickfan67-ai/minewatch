import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraRoom } from '../src/room.js';

function context(){
  return {
    getWebSockets(){ return []; },
    storage: {
      async get(){ return []; },
      async put(){}
    }
  };
}

test('non-websocket requests are rejected', async () => {
  const room=new CameraRoom(context(),{});
  const response=await room.fetch(new Request('https://room/connect'));
  assert.equal(response.status,426);
});

test('unknown websocket roles are rejected before upgrade', async () => {
  const room=new CameraRoom(context(),{});
  const request=new Request('https://room/connect',{headers:{Upgrade:'websocket','X-MW-Role':'admin'}});
  const response=await room.fetch(request);
  assert.equal(response.status,400);
  assert.match(await response.text(),/invalid websocket role/);
});

test('oversized websocket messages close with code 1009', async () => {
  const room=new CameraRoom(context(),{});
  const closed=[];
  const ws={
    close(code,reason){ closed.push([code,reason]); },
    deserializeAttachment(){ return {role:'viewer',peerId:'v1'}; }
  };
  await room.webSocketMessage(ws,'x'.repeat(128*1024+1));
  assert.deepEqual(closed,[[1009,'message too large']]);
});

test('malformed small JSON is ignored without closing the peer', async () => {
  const room=new CameraRoom(context(),{});
  let closed=false;
  const ws={close(){closed=true;},deserializeAttachment(){return {role:'viewer',peerId:'v1'};}};
  await room.webSocketMessage(ws,'{not json');
  assert.equal(closed,false);
});
