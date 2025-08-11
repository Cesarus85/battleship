// [BATTLESHIP_AR:STEP 10] Sehr schlankes WebRTC + WebSocket-Signaling (1:1)
export class MPClient extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.pc = null;
    this.dc = null;
    this.room = null;
    this.role = null;
  }

  async connect(signalingUrl, roomId) {
    this.room = roomId;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(signalingUrl);
      this.ws.onopen = () => {
        this.wsSend({ type: 'join', room: roomId });
      };
      this.ws.onerror = (e) => this.dispatch('error', { reason: 'ws_error', e });

      this.ws.onmessage = async (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'room_full') {
          this.dispatch('error', { reason: 'room_full' });
          return reject(new Error('room_full'));
        }
        if (msg.type === 'joined') {
          this.role = msg.role;
          await this.setupPeer();
          if (this.role === 'host') await this.createOffer();
          this.dispatch('joined', { role: this.role, room: this.room });
          resolve(true);
          return;
        }
        if (msg.type === 'peer_joined') {
          this.dispatch('peer_joined', {});
          return;
        }
        if (msg.type === 'peer_left') {
          this.dispatch('peer_left', {});
          this.closePeer();
          return;
        }
        if (msg.type === 'signal') {
          await this.handleSignal(msg.data);
          return;
        }
      };
    });
  }

  wsSend(obj) { try { this.ws?.send(JSON.stringify(obj)); } catch {} }
  dispatch(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }

  async setupPeer() {
    if (this.pc) return;
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.wsSend({ type: 'signal', data: { candidate: e.candidate } });
    };
    this.pc.onconnectionstatechange = () => {
      this.dispatch('pc_state', { state: this.pc.connectionState });
    };
    if (this.role === 'host') {
      this.dc = this.pc.createDataChannel('game');
      this.attachDC();
    } else {
      this.pc.ondatachannel = (e) => { this.dc = e.channel; this.attachDC(); };
    }
  }

  attachDC() {
    if (!this.dc) return;
    this.dc.onopen = () => this.dispatch('dc_open', {});
    this.dc.onclose = () => this.dispatch('dc_close', {});
    this.dc.onmessage = (ev) => {
      try { this.dispatch('message', JSON.parse(ev.data)); } catch {}
    };
  }

  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.wsSend({ type: 'signal', data: { desc: this.pc.localDescription } });
  }

  async handleSignal(data) {
    if (data.desc) {
      const desc = data.desc;
      if (desc.type === 'offer') {
        await this.pc.setRemoteDescription(desc);
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.wsSend({ type: 'signal', data: { desc: this.pc.localDescription } });
      } else if (desc.type === 'answer') {
        await this.pc.setRemoteDescription(desc);
      }
      return;
    }
    if (data.candidate) {
      try { await this.pc.addIceCandidate(data.candidate); } catch {}
    }
  }

  send(obj) {
    if (this.dc && this.dc.readyState === 'open') {
      this.dc.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  disconnect() {
    try { this.ws?.close(); } catch {}
    this.closePeer();
  }

  closePeer() {
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    this.dc = null; this.pc = null; this.role = null;
  }
}
