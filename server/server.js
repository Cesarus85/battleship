// server/server.js — HTTPS + WSS Signaling-Server (1:1 WebRTC)
// Start: node server/server.js
// Erwartet Zertifikate unter ./server/cert/cert.pem und ./server/cert/key.pem

import fs from 'fs';
import path from 'path';
import https from 'https';
import { WebSocketServer } from 'ws';

// ---------- TLS laden ----------
const CERT_DIR = path.resolve(process.cwd(), 'server', 'cert');
const KEY_PATH  = path.join(CERT_DIR, 'key.pem');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');

if (!fs.existsSync(KEY_PATH) || !fs.existsSync(CERT_PATH)) {
  console.error('[SIGNAL] TLS-Zertifikate fehlen.');
  console.error('Erwartet:', KEY_PATH, 'und', CERT_PATH);
  console.error('Siehe Anleitung unten, wie du sie erzeugst.');
  process.exit(1);
}

const server = https.createServer({
  key:  fs.readFileSync(KEY_PATH),
  cert: fs.readFileSync(CERT_PATH),
});

const wss = new WebSocketServer({ server /*, path: '/signal'*/ });

// ---------- Simple Rooms (max 2 Peers) ----------
/** rooms: Map<roomId, Set<ws>> */
const rooms = new Map();

function peerSend(roomId, sender, obj) {
  const set = rooms.get(roomId);
  if (!set) return;
  for (const ws of set) {
    if (ws !== sender && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }
}

// ---------- Heartbeat (Zombie-Verbindungen vermeiden) ----------
function heartbeat() { this.isAlive = true; }

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', heartbeat);
  ws.roomId = null;

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // --- Raum beitreten ---
    if (msg.type === 'join') {
      const roomId = String(msg.room || '').trim();
      if (!roomId) {
        ws.send(JSON.stringify({ type: 'error', reason: 'no_room' }));
        return;
      }
      let set = rooms.get(roomId);
      if (!set) { set = new Set(); rooms.set(roomId, set); }
      if (set.size >= 2) {
        ws.send(JSON.stringify({ type: 'room_full' }));
        return;
      }
      set.add(ws);
      ws.roomId = roomId;
      const role = set.size === 1 ? 'host' : 'guest';
      ws.send(JSON.stringify({ type: 'joined', room: roomId, role }));
      peerSend(roomId, ws, { type: 'peer_joined' });
      console.log(`[SIGNAL] ${role} joined room=${roomId} (size=${set.size})`);
      return;
    }

    if (!ws.roomId) return;

    // --- Signalisierungs-Daten weiterreichen ---
    if (msg.type === 'signal') {
      peerSend(ws.roomId, ws, { type: 'signal', data: msg.data });
      return;
    }

    // --- Raum verlassen ---
    if (msg.type === 'leave') {
      const set = rooms.get(ws.roomId);
      if (set) { set.delete(ws); if (set.size === 0) rooms.delete(ws.roomId); }
      peerSend(ws.roomId, ws, { type: 'peer_left' });
      console.log(`[SIGNAL] leave room=${ws.roomId}`);
      ws.roomId = null;
      return;
    }
  });

  ws.on('close', () => {
    if (ws.roomId) {
      const set = rooms.get(ws.roomId);
      if (set) { set.delete(ws); if (set.size === 0) rooms.delete(ws.roomId); }
      peerSend(ws.roomId, ws, { type: 'peer_left' });
      console.log(`[SIGNAL] close room=${ws.roomId}`);
      ws.roomId = null;
    }
  });

  ws.on('error', (err) => {
    if (ws.roomId) {
      const set = rooms.get(ws.roomId);
      if (set) { set.delete(ws); if (set.size === 0) rooms.delete(ws.roomId); }
      peerSend(ws.roomId, ws, { type: 'peer_left' });
      console.log(`[SIGNAL] error room=${ws.roomId}:`, err);
      ws.roomId = null;
    }
  });
});

// Ping alle 30s
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);
wss.on('close', () => clearInterval(interval));

const PORT = Number(process.env.PORT || 8443);
server.listen(PORT, () => {
  console.log(`[SIGNAL] Listening on wss://localhost:${PORT}`);
  console.log(`[SIGNAL] Cert: ${CERT_PATH}`);
});
