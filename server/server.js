// Minimaler WebSocket-Signaling-Server für 1:1 WebRTC
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const server = createServer();
const wss = new WebSocketServer({ server });

/** rooms: Map<roomId, Set<ws>> (max 2) */
const rooms = new Map();

/** Broadcast helper (to other peer only) */
function peerSend(roomId, sender, obj) {
  const set = rooms.get(roomId);
  if (!set) return;
  for (const ws of set) {
    if (ws !== sender && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }
}

wss.on('connection', (ws) => {
  ws.roomId = null;

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'join') {
      const roomId = String(msg.room || '').trim();
      if (!roomId) return ws.send(JSON.stringify({ type: 'error', reason: 'no_room' }));

      let set = rooms.get(roomId);
      if (!set) { set = new Set(); rooms.set(roomId, set); }
      if (set.size >= 2) {
        return ws.send(JSON.stringify({ type: 'room_full' }));
      }
      set.add(ws);
      ws.roomId = roomId;

      const role = set.size === 1 ? 'host' : 'guest';
      ws.send(JSON.stringify({ type: 'joined', room: roomId, role }));
      // inform the other peer
      peerSend(roomId, ws, { type: 'peer_joined' });
      return;
    }

    if (!ws.roomId) return;

    // Forward all signaling payload to the peer
    if (msg.type === 'signal') {
      return peerSend(ws.roomId, ws, { type: 'signal', data: msg.data });
    }

    if (msg.type === 'leave') {
      const set = rooms.get(ws.roomId);
      if (set) { set.delete(ws); if (set.size === 0) rooms.delete(ws.roomId); }
      peerSend(ws.roomId, ws, { type: 'peer_left' });
      ws.roomId = null;
      return;
    }
  });

  ws.on('close', () => {
    if (!ws.roomId) return;
    const set = rooms.get(ws.roomId);
    if (set) { set.delete(ws); if (set.size === 0) rooms.delete(ws.roomId); }
    peerSend(ws.roomId, ws, { type: 'peer_left' });
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Signaling server listening on ws://localhost:${PORT}`);
});
