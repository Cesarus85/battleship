// [BATTLESHIP_AR:STEP 10] Multiplayer-Integration (WebRTC DataChannel) + SFX/Haptik/Effekte aus Step 9
import * as THREE from 'https://unpkg.com/three@0.166.1/build/three.module.js';
import { ARButton } from 'https://unpkg.com/three@three@0.166.1/examples/jsm/webxr/ARButton.js'; // keep same import as vorher, falls nötig korrigieren
import { Board } from './board.js';
import { GameState, PHASE } from './state.js';
import { MPClient } from './net.js';

// --- Falls dein Bundler pingelig ist: obige ARButton-URL ggf. auf die aus Schritt 9 zurücksetzen. ---

let scene, camera, renderer;
let reticle, hitTestSource = null, viewerSpace = null;
let referenceSpace = null;

let boardPlayer = null;
let boardAI = null;
let game = null;

const controllers = [];
const raycaster = new THREE.Raycaster();

let lastHoverCell = null;
let lastHoverTarget = null; // 'player' | 'ai' | null

// Debug aus
let debugRay = null;
let debugDot = null;

// UI
const overlay = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlayTitle');
const overlayMsg = document.getElementById('overlayMsg');
const btnAgain = document.getElementById('btnAgain');
const btnReset = document.getElementById('btnReset');
const btnAudio = document.getElementById('btnAudio');

// MP UI
const mpUrl = document.getElementById('mpUrl');
const mpRoom = document.getElementById('mpRoom');
const mpHostBtn = document.getElementById('mpHost');
const mpJoinBtn = document.getElementById('mpJoin');
const mpLeaveBtn = document.getElementById('mpLeave');
const mpStatus = document.getElementById('mpStatus');

// Labels (Sprites)
let labelPlayer = null;
let labelAI = null;

// SFX/Haptik aus Step 9 (leicht gekürzt – identisch zur letzten Version)
const SFX = (() => {
  let ctx = null;
  let enabled = false;
  function ensure(){ if(!enabled) return false; if(!ctx) ctx = new (window.AudioContext||window.webkitAudioContext)(); if(ctx.state==='suspended') ctx.resume(); return true; }
  function env(g, t0,a=0.005,d=0.12,r=0.06, peak=0.8, sustain=0) { g.cancelScheduledValues(t0); g.setValueAtTime(0.0001,t0); g.linearRampToValueAtTime(peak,t0+a); g.linearRampToValueAtTime(sustain,t0+a+d); g.linearRampToValueAtTime(0.0001,t0+a+d+r); }
  function osc(type,freq,dur,vol=0.2){ if(!ensure())return; const t0=ctx.currentTime; const o=ctx.createOscillator(); const g=ctx.createGain(); o.type=type; o.frequency.value=freq; env(g.gain,t0,0.004,dur*0.6,dur*0.4,vol,0.0001); o.connect(g).connect(ctx.destination); o.start(t0); o.stop(t0+Math.max(0.02,dur)); }
  function sweep(type,f0,f1,dur=0.18,vol=0.25){ if(!ensure())return; const t0=ctx.currentTime; const o=ctx.createOscillator(); const g=ctx.createGain(); o.type=type; o.frequency.setValueAtTime(f0,t0); o.frequency.exponentialRampToValueAtTime(Math.max(1,f1),t0+dur); env(g.gain,t0,0.005,dur*0.7,dur*0.3,vol,0.0001); o.connect(g).connect(ctx.destination); o.start(t0); o.stop(t0+dur+0.05); }
  return {
    toggle(on){ enabled = on; if(on) ensure(); },
    place(){ osc('triangle', 440, 0.09, 0.18); },
    rotate(){ osc('square', 620, 0.06, 0.12); },
    miss(){ osc('sine', 820, 0.07, 0.12); },
    hit(){ sweep('sawtooth', 700, 220, 0.16, 0.28); },
    sunk(){ sweep('square', 600, 200, 0.20, 0.30); setTimeout(()=>sweep('square', 500, 160, 0.22, 0.26), 70); },
    win(){ osc('sine', 660, 0.12, 0.18); setTimeout(()=>osc('sine', 880, 0.14, 0.18), 120); },
    lose(){ sweep('sawtooth', 300, 120, 0.35, 0.28); },
  };
})();

function hapticPulse(intensity=0.5, duration=60) {
  for (const c of controllers) {
    const gp = c?.userData?.inputSource?.gamepad;
    if (!gp) continue;
    const acts = gp.hapticActuators || [];
    for (const h of acts) { try { h.pulse?.(intensity, duration); } catch {} }
    if (gp.vibrationActuator?.playEffect) {
      try { gp.vibrationActuator.playEffect('dual-rumble', { startDelay:0, duration, weakMagnitude:intensity, strongMagnitude:intensity }); } catch {}
    }
  }
}

const prevButtons = new Map();
const IDX = { BY: 4 };
const BOARD_GAP = 1.2;

let clock = new THREE.Clock();
let effects = [];

// ---- Multiplayer State ----
let mp = null;
let mpActive = false;
let mpRole = null;             // 'host' | 'guest'
let mpMyReady = false;
let mpPeerReady = false;
let mpPendingShot = null;      // {i,j} während auf Ergebnis gewartet wird

// ---------- Setup ----------
init();
animate();

async function init() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.0));

  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.07, 0.09, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x00ffcc, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
  );
  reticle.visible = false;
  scene.add(reticle);

  for (let i = 0; i < 2; i++) {
    const c = renderer.xr.getController(i);
    c.userData.index = i;
    c.addEventListener('connected', (e) => { c.userData.inputSource = e.data; });
    c.addEventListener('disconnected', () => { delete c.userData.inputSource; prevButtons.delete(c); });
    c.addEventListener('select', onSelect);
    scene.add(c);
    controllers.push(c);
  }

  const rayGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0,0,-0.9)]);
  debugRay = new THREE.Line(rayGeom, new THREE.LineBasicMaterial({ transparent:true, opacity:0.25 }));
  debugRay.visible = false; scene.add(debugRay);

  debugDot = new THREE.Mesh(new THREE.SphereGeometry(0.01, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffff00 }));
  debugDot.visible = false; scene.add(debugDot);

  const btn = ARButton.createButton(renderer, {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: document.body }
  });
  document.body.appendChild(btn);

  window.addEventListener('resize', onWindowResize);
  renderer.xr.addEventListener('sessionstart', onSessionStart);
  renderer.xr.addEventListener('sessionend', onSessionEnd);

  // UI Events
  btnReset?.addEventListener('click', () => resetGame());
  btnAgain?.addEventListener('click', () => { hideOverlay(); resetGame(); });
  btnAudio?.addEventListener('click', () => {
    const on = btnAudio.textContent.includes('an') ? true : false;
    SFX.toggle(on);
    btnAudio.textContent = on ? '🔇 SFX aus' : '🔊 SFX an';
    if (on) { SFX.place(); hapticPulse(0.2, 40); }
  });

  mpHostBtn?.addEventListener('click', () => startMP(true));
  mpJoinBtn?.addEventListener('click', () => startMP(false));
  mpLeaveBtn?.addEventListener('click', () => stopMP());

  newGame();
  setHUD(`Phase: ${game.phase} — Platziere die Bretter mit Trigger.`);
}

function newGame() {
  game = new GameState();
  clearBoardsAndLabels();
  effects = [];
  clock.start();
  mpMyReady = false; mpPeerReady = false; mpPendingShot = null;
}

function onWindowResize(){ camera.aspect=window.innerWidth/window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); }

async function onSessionStart(){
  const session = renderer.xr.getSession();
  referenceSpace = await session.requestReferenceSpace('local');
  viewerSpace = await session.requestReferenceSpace('viewer');
  hitTestSource = await session.requestHitTestSource?.({ space: viewerSpace });
}
function onSessionEnd(){ hitTestSource=null; viewerSpace=null; referenceSpace=null; }

function animate(){ renderer.setAnimationLoop(render); }

function render(_, frame) {
  const dt = clock.getDelta();

  // Hit-Test solange keine Boards
  if (frame && hitTestSource && !boardPlayer && !boardAI) {
    const hits = frame.getHitTestResults(hitTestSource);
    if (hits?.length) {
      const pose = hits[0].getPose(renderer.xr.getReferenceSpace());
      if (pose) {
        reticle.visible = true;
        reticle.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
        const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
        reticle.quaternion.setFromRotationMatrix(m);
      }
    } else reticle.visible = false;
  }

  if (!referenceSpace || !frame) { renderer.render(scene, camera); return; }

  const ray = getXRRay(frame);
  if (!ray) {
    clearHover();
    renderer.render(scene, camera);
    return;
  }
  updateDebugRay(ray.origin, ray.direction);

  let hitPlayer = null, hitAI = null;
  if (boardPlayer) { raycaster.set(ray.origin, ray.direction); hitPlayer = raycaster.intersectObject(boardPlayer.pickingPlane, false)[0] || null; }
  if (boardAI)     { raycaster.set(ray.origin, ray.direction); hitAI     = raycaster.intersectObject(boardAI.pickingPlane, false)[0]     || null; }

  if (game.phase === PHASE.PLACE_PLAYER) {
    applyHover('player', hitPlayer);
    pollRotateButtons(frame);

    if (lastHoverCell && boardPlayer) {
      const type = game.player.fleet[game.player.nextShipIndex];
      if (type) {
        const cells = boardPlayer.cellsForShip(lastHoverCell, type.length, game.player.orientation);
        const valid = game.player.board.canPlaceShip(lastHoverCell.i, lastHoverCell.j, type.length, game.player.orientation);
        boardPlayer.showGhost(cells, valid);
        setHUD(`Phase: ${game.phase} — Schiff ${game.player.nextShipIndex + 1}/${game.player.fleet.length}: ${type.name} (${type.length}) | Ausrichtung: ${game.player.orientation}${valid ? '' : ' — ungültig'}`);
      }
    } else {
      boardPlayer?.clearGhost();
    }
  } else if (game.phase === PHASE.PLAYER_TURN) {
    boardPlayer?.clearGhost();
    applyHover('ai', hitAI);
  } else {
    clearHover();
    boardPlayer?.clearGhost();
  }

  if (effects.length) {
    effects = effects.filter((fx) => {
      try { return fx.update(dt) !== false; } catch { return false; }
    });
  }

  renderer.render(scene, camera);
}

function applyHover(target, hit) {
  lastHoverTarget = null;
  lastHoverCell = null;
  boardPlayer?.setHoverCell(null);
  boardAI?.setHoverCell(null);

  if (!hit) return;

  const board = (target === 'player') ? boardPlayer : boardAI;
  const cell = board?.worldToCell(hit.point) || null;
  if (cell) {
    lastHoverTarget = target;
    lastHoverCell = cell;
    if (target === 'ai') boardAI.setHoverCell(cell);
  }
}

function clearHover() {
  lastHoverTarget = null;
  lastHoverCell = null;
  boardPlayer?.setHoverCell(null);
  boardAI?.setHoverCell(null);
}

function getXRRay(frame){
  const session = renderer.xr.getSession();
  if (!session || !referenceSpace) return null;
  for (const c of controllers) {
    const src = c.userData.inputSource;
    if (!src) continue;
    const pose = frame.getPose(src.targetRaySpace, referenceSpace);
    if (pose) {
      const { position, orientation } = pose.transform;
      const origin = new THREE.Vector3(position.x, position.y, position.z);
      const q = new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w);
      const direction = new THREE.Vector3(0,0,-1).applyQuaternion(q).normalize();
      return { origin, direction, controller:c };
    }
  }
  const cam = renderer.xr.getCamera(camera);
  const origin = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const direction = new THREE.Vector3(0,0,-1).applyMatrix4(new THREE.Matrix4().extractRotation(cam.matrixWorld)).normalize();
  return { origin, direction, controller:null };
}

function onSelect(){
  // 1) Boards + Labels
  if (!boardPlayer && !boardAI && reticle.visible) {
    const basePos = reticle.position.clone();
    const baseQuat = reticle.quaternion.clone();

    boardPlayer = new Board({ size: 1.0, divisions: 10 });
    boardPlayer.position.copy(basePos);
    boardPlayer.quaternion.copy(baseQuat);
    scene.add(boardPlayer);

    boardAI = new Board({ size: 1.0, divisions: 10 });
    const offsetLocal = new THREE.Vector3(BOARD_GAP, 0, 0);
    const offsetWorld = offsetLocal.clone().applyQuaternion(baseQuat);
    boardAI.position.copy(basePos).add(offsetWorld);
    boardAI.quaternion.copy(baseQuat);
    scene.add(boardAI);

    labelPlayer = makeTextSprite('DU', '#2ad3ff', '#001018');
    labelAI = makeTextSprite('GEGNER', '#ff5a5a', '#220000');
    placeLabelAboveBoard(labelPlayer, boardPlayer, baseQuat);
    placeLabelAboveBoard(labelAI, boardAI, baseQuat);

    game.beginPlacement();
    setHUD(`Phase: ${game.phase} — Platziere deine Schiffe (Y/B: drehen, Trigger: setzen).`);
    SFX.toggle(btnAudio?.textContent.includes('an'));
    return;
  }

  // 2) Spieler-Schiffe setzen
  if (boardPlayer && game.phase === PHASE.PLACE_PLAYER && lastHoverCell && lastHoverTarget === 'player') {
    const type = game.player.fleet[game.player.nextShipIndex];
    if (!type) return;

    const ok = game.player.board.canPlaceShip(lastHoverCell.i, lastHoverCell.j, type.length, game.player.orientation);
    if (!ok) { setHUD(`Phase: ${game.phase} — Ungültig. Drehe (Y/B) oder andere Zelle.`); SFX.miss(); hapticPulse(0.2, 40); return; }

    const res = game.tryPlaceNextPlayerShip(lastHoverCell.i, lastHoverCell.j);
    if (res.ok) {
      const cells = boardPlayer.cellsForShip(lastHoverCell, type.length, game.player.orientation);
      boardPlayer.placeShipVisual(cells);
      boardPlayer.clearGhost();
      SFX.place(); hapticPulse(0.35, 60);
      spawnRipple(boardPlayer, cells[0].i, cells[0].j, 0x22ffaa, 0.9, 0.55);

      if (res.placedAll) {
        // MP: „ready“ senden; SP (kein MP) → AI platzieren
        if (mpActive) {
          mpMyReady = true;
          mp?.send({ type: 'placeReady' });
          tryStartMPGame();
          setHUD(`Warte auf Gegner...`);
        } else {
          const ar = game.aiPlaceFleetRandom();
          if (!ar.ok) { setHUD(`Fehler bei KI-Platzierung: ${ar.reason}`); return; }
          setHUD(`Phase: ${game.phase} — Deine Runde: Ziele auf das rechte Brett und drücke Trigger.`);
        }
      } else {
        const next = game.player.fleet[game.player.nextShipIndex];
        setHUD(`Phase: ${game.phase} — Nächstes Schiff: ${next.name} (${next.length}) | Ausrichtung: ${game.player.orientation}`);
      }
    } else {
      setHUD(`Phase: ${game.phase} — Position ungültig.`);
      SFX.miss(); hapticPulse(0.2, 40);
    }
    return;
  }

  // 3) Schießen
  if (boardAI && game.phase === PHASE.PLAYER_TURN && lastHoverCell && lastHoverTarget === 'ai') {
    if (mpActive) {
      if (mpPendingShot) return; // warte auf Ergebnis
      mpPendingShot = { i: lastHoverCell.i, j: lastHoverCell.j };
      setHUD(`Schuss (${mpPendingShot.i},${mpPendingShot.j}) gesendet — warte auf Ergebnis...`);
      mp?.send({ type: 'shot', cell: mpPendingShot });
      // Sperre weitere Schüsse bis Ergebnis kommt
      return;
    }

    // Singleplayer-Altpfad (AI) – nur falls kein MP aktiv
    const res = game.playerShoot(lastHoverCell.i, lastHoverCell.j);
    if (!res.ok) {
      if (res.result === 'repeat') setHUD('Bereits beschossen. Andere Zelle wählen.');
      else setHUD('Ungültiger Schuss.');
      SFX.miss(); hapticPulse(0.15, 40);
      return;
    }
    const isHit = (res.result === 'hit' || res.result === 'sunk');
    boardAI.addShotMarker(lastHoverCell.i, lastHoverCell.j, isHit);
    if (isHit) { SFX.hit(); hapticPulse(0.7, 120); spawnBurst(boardAI, lastHoverCell.i, lastHoverCell.j); }
    else { SFX.miss(); hapticPulse(0.2, 60); spawnRipple(boardAI, lastHoverCell.i, lastHoverCell.j); }

    if (res.result === 'hit') setHUD(`Treffer (${lastHoverCell.i},${lastHoverCell.j})${res.sunk ? ' — versenkt!' : ''}${res.gameOver ? ' — GAME OVER' : ''}`);
    else if (res.result === 'sunk') { setHUD(`Schiff versenkt (${lastHoverCell.i},${lastHoverCell.j})${res.gameOver ? ' — GAME OVER' : ''}`); SFX.sunk(); hapticPulse(0.9, 200); }
    else if (res.result === 'miss') setHUD(`Wasser (${lastHoverCell.i},${lastHoverCell.j}) — KI ist dran...`);
  }
}

// --- MP: host/join/leave & Events ---
async function startMP(asHost) {
  if (mpActive) return;
  const url = (mpUrl?.value || '').trim();
  const room = (mpRoom?.value || '').trim();
  if (!url || !room) { mpStatus.textContent = 'Bitte URL & Raumcode setzen.'; return; }

  mp = new MPClient();
  mpStatus.textContent = 'Verbinde...';

  mp.addEventListener('joined', (e) => {
    mpRole = e.detail.role;
    mpStatus.textContent = `WS verbunden — Rolle: ${mpRole}. Warte auf DataChannel...`;
  });
  mp.addEventListener('dc_open', () => {
    mpActive = true;
    mpStatus.textContent = `MP aktiv (Raum ${room}) — ${mpRole === 'host' ? 'Du startest nach „Bereit“' : 'Gegner startet'}`;
    mpLeaveBtn.disabled = false;
  });
  mp.addEventListener('dc_close', () => {
    mpActive = false;
    mpStatus.textContent = 'DataChannel geschlossen.';
  });
  mp.addEventListener('peer_left', () => {
    mpStatus.textContent = 'Gegner hat verlassen.';
    // Spiel pausieren
    if (game.phase !== PHASE.PLACE_PLAYER) setHUD('Gegner weg — warte auf Rejoin oder trenne.');
  });
  mp.addEventListener('message', (e) => onMPMessage(e.detail));
  mp.addEventListener('error', (e) => { mpStatus.textContent = `Fehler: ${e.detail?.reason || 'unbekannt'}`; });

  try {
    await mp.connect(url, room);
  } catch (err) {
    mpStatus.textContent = `Verbindung fehlgeschlagen: ${err?.message || err}`;
  }
}

function stopMP() {
  mp?.disconnect();
  mpActive = false; mpRole = null; mpMyReady = false; mpPeerReady = false; mpPendingShot = null;
  mpStatus.textContent = 'Offline';
  mpLeaveBtn.disabled = true;
}

function onMPMessage(msg) {
  switch (msg.type) {
    case 'placeReady':
      mpPeerReady = true; tryStartMPGame(); break;

    case 'shot': {
      // Gegner schießt auf unser Brett
      if (!boardPlayer) return;
      const { i, j } = msg.cell;
      const res = game.player.board.shoot(i, j); // autoritativ bei uns
      const isHit = (res.result === 'hit' || res.result === 'sunk');
      boardPlayer.addShotMarker(i, j, isHit);
      if (isHit) { SFX.hit(); hapticPulse(0.6, 120); spawnBurst(boardPlayer, i, j); }
      else { SFX.miss(); hapticPulse(0.2, 60); spawnRipple(boardPlayer, i, j); }

      // Overlay/Status
      if (res.result === 'hit') setHUD(`KI/Gegner: Treffer (${i},${j})${res.sunk ? ' — versenkt!' : ''}${res.gameOver ? ' — GAME OVER (du verlierst)' : ''}`);
      else if (res.result === 'sunk') { setHUD(`KI/Gegner: versenkt (${i},${j})${res.gameOver ? ' — GAME OVER (du verlierst)' : ''}`); SFX.sunk(); }
      else if (res.result === 'miss') setHUD(`Gegner: Wasser (${i},${j}). Dein Zug.`);

      // Ergebnis zurücksenden
      mp?.send({ type: 'shotResult', cell: { i, j }, result: res.result, sunk: !!res.sunk, gameOver: !!res.gameOver });

      if (res.gameOver) { showOverlay(false); SFX.lose(); }
      else {
        // Nach gegnerischem Schuss sind wir wieder dran
        game.phase = PHASE.PLAYER_TURN;
      }
      break;
    }

    case 'shotResult': {
      if (!mpPendingShot) return;
      const { i, j } = msg.cell;
      const isHit = (msg.result === 'hit' || msg.result === 'sunk');
      // Marker auf Gegnerbrett
      boardAI.addShotMarker(i, j, isHit);
      if (isHit) { SFX.hit(); hapticPulse(0.7, 120); spawnBurst(boardAI, i, j); }
      else { SFX.miss(); hapticPulse(0.2, 60); spawnRipple(boardAI, i, j); }

      if (msg.result === 'hit') setHUD(`Treffer (${i},${j})${msg.sunk ? ' — versenkt!' : ''}${msg.gameOver ? ' — GAME OVER (Du gewinnst)' : ''}`);
      else if (msg.result === 'sunk') { setHUD(`Schiff versenkt (${i},${j})${msg.gameOver ? ' — GAME OVER (Du gewinnst)' : ''}`); SFX.sunk(); hapticPulse(0.9, 200); }
      else if (msg.result === 'miss') setHUD(`Wasser (${i},${j}) — Gegner ist dran...`);

      mpPendingShot = null;

      if (msg.gameOver) { showOverlay(true); SFX.win(); }
      else {
        // Nach unserem Schuss ist der Gegner dran
        game.phase = PHASE.AI_TURN;
      }
      break;
    }

    default:
      break;
  }
}

function tryStartMPGame() {
  if (!mpActive || !mpMyReady || !mpPeerReady) return;
  // Wer beginnt? Host fängt an
  if (mpRole === 'host') {
    game.phase = PHASE.PLAYER_TURN;
    setHUD('Beide bereit. **Du startest.** Ziele auf das rechte Brett und drücke Trigger.');
  } else {
    game.phase = PHASE.AI_TURN;
    setHUD('Beide bereit. **Gegner beginnt.** Bitte warten...');
  }
}

// --- Buttons, Effekte, Labels, Overlay/Reset (identisch Step 9, gekürzt) ---
function pollRotateButtons(){
  if (game.phase !== PHASE.PLACE_PLAYER) return;
  for (const c of controllers) {
    const gp = c.userData.inputSource?.gamepad;
    if (!gp) continue;
    let mask = 0; gp.buttons.forEach((b,i)=>{ if(b?.pressed) mask|=(1<<i); });
    const prev = prevButtons.get(c) ?? 0;
    const justBY = ((mask & (1<<IDX.BY)) && !(prev & (1<<IDX.BY)));
    if (justBY) { setHUD(`Phase: ${game.phase} — Ausrichtung: ${game.toggleOrientation()}`); SFX.rotate(); hapticPulse(0.25, 40); }
    prevButtons.set(c, mask);
  }
}

function updateDebugRay(origin, direction){
  if (!debugRay) return;
  const arr = debugRay.geometry.attributes.position.array;
  arr[0]=origin.x; arr[1]=origin.y; arr[2]=origin.z;
  const end = new THREE.Vector3().copy(direction).multiplyScalar(0.9).add(origin);
  arr[3]=end.x; arr[4]=end.y; arr[5]=end.z;
  debugRay.geometry.attributes.position.needsUpdate = true;
}

function makeTextSprite(text, bg='#00ffc8', fg='#000') {
  const pad = 16;
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const r = 28;
  roundRect(ctx, pad, pad, canvas.width-2*pad, canvas.height-2*pad, r); ctx.fillStyle = bg; ctx.fill();
  ctx.fillStyle = fg; ctx.font = 'bold 96px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width/2, canvas.height/2);
  const tex = new THREE.CanvasTexture(canvas); tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat); sprite.scale.set(0.45, 0.22, 1); return sprite;
}
function roundRect(ctx, x, y, w, h, r){
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath(); ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y,   x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x,   y+h, rr);
  ctx.arcTo(x,   y+h, x,   y,   rr);
  ctx.arcTo(x,   y,   x+w, y,   rr); ctx.closePath();
}
function placeLabelAboveBoard(sprite, board, boardQuat) {
  const local = new THREE.Vector3(0, 0.08, -0.6);
  const world = local.clone().applyQuaternion(boardQuat).add(board.position);
  sprite.position.copy(world); scene.add(sprite);
}

function showOverlay(playerWon) {
  overlayTitle.textContent = playerWon ? '🎉 Du hast gewonnen!' : '💥 Du hast verloren';
  overlayMsg.textContent = playerWon
    ? 'Alle gegnerischen Schiffe wurden versenkt.'
    : 'Deine Flotte wurde versenkt.';
  overlay.style.display = 'flex';
}
function hideOverlay() { overlay.style.display = 'none'; }

function resetGame() {
  hideOverlay();
  clearBoardsAndLabels();
  newGame();
  setHUD('Zurückgesetzt. Platziere die Bretter neu (Trigger).');
}

function clearBoardsAndLabels() {
  if (boardPlayer) scene.remove(boardPlayer);
  if (boardAI) scene.remove(boardAI);
  if (labelPlayer) scene.remove(labelPlayer);
  if (labelAI) scene.remove(labelAI);
  boardPlayer = null; boardAI = null; labelPlayer = null; labelAI = null;
  lastHoverCell = null; lastHoverTarget = null;
}

// Effekte (Ripple/Burst) – identisch Step 9
function spawnRipple(board, i, j, color=0xffffff, startAlpha=0.9, life=0.6) {
  const p = board.cellCenterLocal(i, j);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(board.cellSize*0.05, board.cellSize*0.06, 32).rotateX(-Math.PI/2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: startAlpha })
  );
  ring.position.set(p.x, 0.006, p.z); board.add(ring);
  const maxScale = 3.2; let t = 0;
  effects.push({ mesh: ring, update: (dt) => { t+=dt; const k=t/life; ring.scale.setScalar(1+k*maxScale); ring.material.opacity = startAlpha*(1-k); if(k>=1){ board.remove(ring); return false; } return true; } });
}
function spawnBurst(board, i, j) {
  const p = board.cellCenterLocal(i, j);
  const group = new THREE.Group(); group.position.set(p.x, 0.008, p.z); board.add(group);
  const count = 10; const parts = [];
  for (let k = 0; k < count; k++) {
    const m = new THREE.Mesh(
      new THREE.CircleGeometry(board.cellSize*0.08, 10).rotateX(-Math.PI/2),
      new THREE.MeshBasicMaterial({ color: 0xff5533, transparent: true, opacity: 0.95 })
    );
    group.add(m);
    const angle = (Math.PI*2) * (k / count) + Math.random()*0.5;
    const speed = board.cellSize * (1.8 + Math.random()*0.8);
    parts.push({ m, vx: Math.cos(angle)*speed, vz: Math.sin(angle)*speed });
  }
  let t = 0;
  effects.push({ mesh: group, update: (dt) => { t += dt; for (const p of parts) { p.m.position.x += p.vx*dt; p.m.position.z += p.vz*dt; p.vx*=0.92; p.vz*=0.92; p.m.material.opacity*=0.92; p.m.scale.multiplyScalar(0.98); } if (t>0.35){ board.remove(group); return false; } return true; } });
}

function setHUD(t){ const hud=document.getElementById('hud'); if(hud) hud.querySelector('.small').textContent=t; }
