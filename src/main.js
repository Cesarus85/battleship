// [BATTLESHIP_AR:STEP 12 + XR UI PATCH + Controller/Ship Fix]
// - XR-Toasts & XR-GameOver
// - Rejoin/Resync + Commit/Reveal
// - CONTROLLER: Aiming-Logik wählt den Controller, der ein Brett trifft (rechts/links).
//   Nur der aktive "Aimer" darf Platzieren/Schießen (andere Controller-Trigger werden ignoriert).
// - Singleplayer + KI-Gegenschuss

import * as THREE from 'https://unpkg.com/three@0.166.1/build/three.module.js';
import { ARButton } from 'https://unpkg.com/three@0.166.1/examples/jsm/webxr/ARButton.js';
import { Board } from './board.js';
import { GameState, PHASE } from './state.js';
import { CELL } from './model.js';
import { MPClient } from './net.js';
import { sha256Hex, randomSalt } from './crypto.js';

// ---------- Szene / Renderer ----------
let scene, camera, renderer;
let reticle, hitTestSource = null, viewerSpace = null;
let referenceSpace = null;

let boardPlayer = null;
let boardAI = null;
let game = null;

const controllers = [];
const raycaster = new THREE.Raycaster();

// Hover-State
let lastHoverCell = null;
let lastHoverTarget = null; // 'player' | 'ai' | null
let aimCtrl = null;         // aktuell verwendeter Controller zum Zielen

// Debug (aus)
let debugRay = null;

// UI (DOM – Buttons)
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

// Labels
let labelPlayer = null;
let labelAI = null;

// Buttons / Timing
const prevButtons = new Map();
const IDX = { BY: 4 };
const BOARD_GAP = 1.2;
let clock = new THREE.Clock();
let effects = [];

// ---------- SFX & Haptik ----------
const SFX = (() => {
  let ctx = null;
  let enabled = false;
  function ensure(){ if(!enabled) return false; if(!ctx) ctx=new (window.AudioContext||window.webkitAudioContext)(); if(ctx.state==='suspended') ctx.resume(); return true; }
  function env(g,t0,a=0.005,d=0.12,r=0.06,peak=0.8,sustain=0){ g.cancelScheduledValues(t0); g.setValueAtTime(0.0001,t0); g.linearRampToValueAtTime(peak,t0+a); g.linearRampToValueAtTime(sustain,t0+a+d); g.linearRampToValueAtTime(0.0001,t0+a+d+r); }
  function osc(type,freq,dur,vol=0.2){ if(!ensure())return; const t0=ctx.currentTime; const o=ctx.createOscillator(); const g=ctx.createGain(); o.type=type; o.frequency.value=freq; env(g.gain,t0,0.004,dur*0.6,dur*0.4,vol,0.0001); o.connect(g).connect(ctx.destination); o.start(t0); o.stop(t0+Math.max(0.02,dur)); }
  function sweep(type,f0,f1,dur=0.18,vol=0.25){ if(!ensure())return; const t0=ctx.currentTime; const o=ctx.createOscillator(); const g=ctx.createGain(); o.type=type; o.frequency.setValueAtTime(f0,t0); o.frequency.exponentialRampToValueAtTime(Math.max(1,f1),t0+dur); env(g.gain,t0,0.005,dur*0.7,dur*0.3,vol,0.0001); o.connect(g).connect(ctx.destination); o.start(t0); o.stop(t0+dur+0.05); }
  return {
    toggle(on){ enabled=on; if(on) ensure(); },
    place(){ osc('triangle',440,0.09,0.18); },
    rotate(){ osc('square',620,0.06,0.12); },
    miss(){ osc('sine',820,0.07,0.12); },
    hit(){ sweep('sawtooth',700,220,0.16,0.28); },
    sunk(){ sweep('square',600,200,0.20,0.30); setTimeout(()=>sweep('square',500,160,0.22,0.26),70); },
    win(){ osc('sine',660,0.12,0.18); setTimeout(()=>osc('sine',880,0.14,0.18),120); },
    lose(){ sweep('sawtooth',300,120,0.35,0.28); },
  };
})();

function hapticPulse(intensity=0.5, duration=60) {
  for (const c of controllers) {
    const gp = c?.userData?.inputSource?.gamepad;
    if (!gp) continue;
    (gp.hapticActuators||[]).forEach(h=>{ try{ h.pulse?.(intensity,duration); }catch{} });
    if (gp.vibrationActuator?.playEffect) {
      try { gp.vibrationActuator.playEffect('dual-rumble',{ startDelay:0,duration,weakMagnitude:intensity,strongMagnitude:intensity }); } catch {}
    }
  }
}

// ==== XR UI (Toast & Modal) ====
let xrToast = null;
let xrModal = null;

function makeXRPanel(text, w=0.72, h=0.22, bg='#0b132b', fg='#ffffff') {
  const pxW = 1024, pxH = Math.round(pxW * (h / w));
  const canvas = document.createElement('canvas');
  canvas.width = pxW; canvas.height = pxH;
  const ctx = canvas.getContext('2d');

  const r = Math.round(32 * (pxW / 1024));
  (function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x+rr, y);
    ctx.arcTo(x+w, y,   x+w, y+h, rr);
    ctx.arcTo(x+w, y+h, x,   y+h, rr);
    ctx.arcTo(x,   y+h, x,   y,   rr);
    ctx.arcTo(x,   y,   x+w, y,   rr);
    ctx.closePath();
  })(ctx, 0, 0, pxW, pxH, r);
  ctx.fillStyle = bg; ctx.fill();

  ctx.fillStyle = fg;
  ctx.font = `bold ${Math.floor(pxH*0.32)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  wrapText(ctx, text, pxW/2, pxH/2, pxW*0.86, pxH*0.38);

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 8; tex.needsUpdate = true;

  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  const geo = new THREE.PlaneGeometry(w, h);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 999;
  return mesh;

  function wrapText(ctx, text, cx, cy, maxW, lineH){
    const words = text.split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = (line ? line+' ' : '') + w;
      if (ctx.measureText(test).width > maxW) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    const totalH = lines.length * lineH;
    let y = cy - totalH/2 + lineH/2;
    for (const ln of lines) { ctx.fillText(ln, cx, y); y += lineH; }
  }
}

function showToastXR(text, seconds=3, color='#0b132b') {
  hideToastXR();
  xrToast = makeXRPanel(text, 0.8, 0.22, color, '#ffffff');
  const pos = getMidpointForUI();
  xrToast.position.copy(pos);
  faceCamera(xrToast);
  scene.add(xrToast);
  setTimeout(() => hideToastXR(), Math.max(500, seconds*1000));
}
function hideToastXR(){ if (xrToast){ scene.remove(xrToast); xrToast.geometry.dispose(); xrToast.material.map.dispose(); xrToast.material.dispose(); xrToast = null; } }

function showGameOverXR(playerWon) {
  hideGameOverXR();
  xrModal = makeXRPanel(playerWon ? '🎉 Du hast gewonnen!' : '💥 Du hast verloren', 0.9, 0.28, playerWon ? '#064e3b' : '#5b0a0a', '#ffffff');
  const cam = renderer.xr.getCamera(camera);
  const dir = new THREE.Vector3(0,0,-1).applyMatrix4(new THREE.Matrix4().extractRotation(cam.matrixWorld));
  const pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld).addScaledVector(dir, 1.0);
  pos.y += 0.05;
  xrModal.position.copy(pos);
  faceCamera(xrModal);
  scene.add(xrModal);
}
function hideGameOverXR(){ if (xrModal){ scene.remove(xrModal); xrModal.geometry.dispose(); xrModal.material.map.dispose(); xrModal.material.dispose(); xrModal=null; } }
function faceCamera(obj){ const cam = renderer.xr.getCamera(camera); obj.lookAt(cam.position); }
function getMidpointForUI() {
  if (boardPlayer && boardAI) { const mid = new THREE.Vector3().addVectors(boardPlayer.position, boardAI.position).multiplyScalar(0.5); mid.y += 0.12; return mid; }
  if (reticle?.visible) return reticle.position.clone().add(new THREE.Vector3(0,0.12,0));
  const cam = renderer.xr.getCamera(camera);
  const dir = new THREE.Vector3(0,0,-1).applyMatrix4(new THREE.Matrix4().extractRotation(cam.matrixWorld));
  return new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld).addScaledVector(dir, 0.9);
}

// ---------- Multiplayer + Commit/Reveal + Resync ----------
let mp = null;
let mpActive = false;
let mpRole = null;
let mpMyReady = false;
let mpPeerReady = false;
let mpPendingShot = null;

let mpMyCommit = null;
let mpPeerCommitHash = null;
let mpPeerVerified = null;

let mpIsFresh = false;
let mpPeerNewlyJoined = false;

const mpHist = { myShots: [], peerShots: [] };
const rendered = { my: new Set(), peer: new Set() };

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
    c.addEventListener('disconnected', () => { delete c.userData.inputSource; prevButtons.delete(c); if (aimCtrl === c) aimCtrl = null; });
    // Wir merken uns, welcher Controller zuletzt aktiv war
    c.addEventListener('selectstart', () => { aimCtrl = c; });
    c.addEventListener('select', onSelect);
    scene.add(c);
    controllers.push(c);
  }

  const rayGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0,0,-0.9)]);
  debugRay = new THREE.Line(rayGeom, new THREE.LineBasicMaterial({ transparent:true, opacity:0.25 }));
  debugRay.visible = false; scene.add(debugRay);

  const btn = ARButton.createButton(renderer, {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: document.body }
  });
  document.body.appendChild(btn);

  window.addEventListener('resize', onWindowResize);
  renderer.xr.addEventListener('sessionstart', onSessionStart);
  renderer.xr.addEventListener('sessionend', onSessionEnd);

  btnReset?.addEventListener('click', () => resetGame());
  btnAgain?.addEventListener('click', () => { hideGameOverXR(); resetGame(); });
  btnAudio?.addEventListener('click', () => {
    const on = btnAudio.textContent.includes('an');
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
  mpMyCommit = null; mpPeerCommitHash = null; mpPeerVerified = null;

  mpIsFresh = false; mpPeerNewlyJoined = false;
  mpHist.myShots = []; mpHist.peerShots = [];
  rendered.my.clear(); rendered.peer.clear();
}

function onWindowResize(){ camera.aspect=window.innerWidth/window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); }
async function onSessionStart(){ const session=renderer.xr.getSession(); referenceSpace=await session.requestReferenceSpace('local'); viewerSpace=await session.requestReferenceSpace('viewer'); hitTestSource=await session.requestHitTestSource?.({ space: viewerSpace }); }
function onSessionEnd(){ hitTestSource=null; viewerSpace=null; referenceSpace=null; }
function animate(){ renderer.setAnimationLoop(render); }

function render(_, frame) {
  const dt = clock.getDelta();

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

  const rayData = pickBestControllerRay(frame);
  if (!rayData) {
    clearHover();
    renderer.render(scene, camera);
    return;
  }
  if (rayData.controller) aimCtrl = rayData.controller; // aktueller Aimer
  updateDebugRay(rayData.origin, rayData.direction);

  let hitPlayer = null, hitAI = null;
  if (boardPlayer) { raycaster.set(rayData.origin, rayData.direction); hitPlayer = raycaster.intersectObject(boardPlayer.pickingPlane, false)[0] || null; }
  if (boardAI)     { raycaster.set(rayData.origin, rayData.direction); hitAI     = raycaster.intersectObject(boardAI.pickingPlane, false)[0]     || null; }

  if (game.phase === PHASE.PLACE_PLAYER) {
    applyHover('player', hitPlayer);
    pollRotateButtons();
    if (lastHoverCell && boardPlayer) {
      const type = game.player.fleet[game.player.nextShipIndex];
      if (type) {
        const len = typeof type.length === 'number' ? type.length : Number(type.len || type.size || 1);
        const cells = boardPlayer.cellsForShip(lastHoverCell, len, game.player.orientation);
        const valid = game.player.board.canPlaceShip(lastHoverCell.i, lastHoverCell.j, len, game.player.orientation);
        boardPlayer.showGhost(cells, valid);
        setHUD(`Phase: ${game.phase} — Schiff ${game.player.nextShipIndex + 1}/${game.player.fleet.length}: ${type.name ?? ''} (${len}) | Ausrichtung: ${game.player.orientation}${valid ? '' : ' — ungültig'}`);
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
    effects = effects.filter((fx) => { try { return fx.update(dt) !== false; } catch { return false; } });
  }

  renderer.render(scene, camera);
}

// --- Controller-Ray: wählt den Controller, der tatsächlich ein Board schneidet (nächster Hit gewinnt) ---
function pickBestControllerRay(frame){
  const session = renderer.xr.getSession();
  if (!session || !referenceSpace) return null;

  let best = null; // {origin,direction,controller,dist}
  for (const c of controllers) {
    const src = c.userData.inputSource;
    if (!src) continue;
    const pose = frame.getPose(src.targetRaySpace, referenceSpace);
    if (!pose) continue;

    const { position, orientation } = pose.transform;
    const origin = new THREE.Vector3(position.x, position.y, position.z);
    const q = new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w);
    const direction = new THREE.Vector3(0,0,-1).applyQuaternion(q).normalize();

    // Teste Intersections gegen beide Picking-Planes; nimm die näheste
    let dist = Infinity;
    if (boardPlayer) {
      raycaster.set(origin, direction);
      const h = raycaster.intersectObject(boardPlayer.pickingPlane, false)[0];
      if (h) dist = Math.min(dist, h.distance);
    }
    if (boardAI) {
      raycaster.set(origin, direction);
      const h = raycaster.intersectObject(boardAI.pickingPlane, false)[0];
      if (h) dist = Math.min(dist, h.distance);
    }
    if (dist < Infinity) {
      if (!best || dist < best.dist) best = { origin, direction, controller: c, dist };
    }
  }

  if (best) return best;

  // Fallback: bevorzugt right, dann left, dann Kamera
  const right = controllers.find(c => c.userData.inputSource?.handedness === 'right');
  const left  = controllers.find(c => c.userData.inputSource?.handedness === 'left');
  const pick = right || left || controllers[0];
  if (pick) {
    const pose = frame.getPose(pick.userData.inputSource.targetRaySpace, referenceSpace);
    if (pose) {
      const { position, orientation } = pose.transform;
      const origin = new THREE.Vector3(position.x, position.y, position.z);
      const q = new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w);
      const direction = new THREE.Vector3(0,0,-1).applyQuaternion(q).normalize();
      return { origin, direction, controller: pick, dist: 0 };
    }
  }

  // letzte Rettung: Kamera
  const cam = renderer.xr.getCamera(camera);
  const origin = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const direction = new THREE.Vector3(0,0,-1).applyMatrix4(new THREE.Matrix4().extractRotation(cam.matrixWorld)).normalize();
  return { origin, direction, controller:null, dist: 0 };
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
function updateDebugRay(origin, direction){
  if (!debugRay) return;
  const arr = debugRay.geometry.attributes.position.array;
  arr[0]=origin.x; arr[1]=origin.y; arr[2]=origin.z;
  const end = new THREE.Vector3().copy(direction).multiplyScalar(0.9).add(origin);
  arr[3]=end.x; arr[4]=end.y; arr[5]=end.z;
  debugRay.geometry.attributes.position.needsUpdate = true;
}

// ---------- Interaktion ----------
async function onSelect(e){
  // Ignoriere Trigger von NICHT-aimendem Controller (verhindert Doppel-Inputs)
  if (aimCtrl && e?.target && e.target !== aimCtrl) return;

  // 1) Bretter+Labels platzieren
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
    showToastXR('Platziere deine Schiffe: Y/B drehen, Trigger setzt.', 4);
    SFX.toggle(btnAudio?.textContent.includes('an'));
    return;
  }

  // 2) Spieler-Schiffe setzen (nur auf Spielerbrett)
  if (boardPlayer && game.phase === PHASE.PLACE_PLAYER && lastHoverCell && lastHoverTarget === 'player') {
    const type = game.player.fleet[game.player.nextShipIndex];
    if (!type) return;

    const len = typeof type.length === 'number' ? type.length : Number(type.len || type.size || 1);
    const ok = game.player.board.canPlaceShip(lastHoverCell.i, lastHoverCell.j, len, game.player.orientation);
    if (!ok) { setHUD(`Phase: ${game.phase} — Ungültig. Drehe (Y/B) oder andere Zelle.`); SFX.miss(); hapticPulse(0.2, 40); return; }

    const res = game.tryPlaceNextPlayerShip(lastHoverCell.i, lastHoverCell.j);
    if (res.ok) {
      const cells = boardPlayer.cellsForShip(lastHoverCell, len, game.player.orientation);
      boardPlayer.placeShipVisual(cells);
      boardPlayer.clearGhost();
      SFX.place(); hapticPulse(0.35, 60);

      if (res.placedAll) {
        if (mpActive) {
          mpMyCommit = await buildCommit(game.player.board);
          mp?.send({ type: 'commit', hash: mpMyCommit.hash });
          mpMyReady = true;
          tryStartMPGame();
          setHUD(mpPeerCommitHash ? 'Beide bereit. Warte auf Start...' : 'Commit gesendet. Warte auf Gegner...');
        } else {
          const ar = game.aiPlaceFleetRandom();
          if (!ar.ok) { setHUD(`Fehler bei KI-Platzierung: ${ar.reason}`); return; }
          setHUD(`Phase: ${game.phase} — Deine Runde: Ziele auf das rechte Brett und drücke Trigger.`);
          showToastXR('Dein Zug: Greife das rechte Brett an!', 3, '#14213d');
        }
      } else {
        const nxt = game.player.fleet[game.player.nextShipIndex];
        const nlen = typeof nxt?.length === 'number' ? nxt.length : Number(nxt?.len || nxt?.size || 1);
        setHUD(`Phase: ${game.phase} — Nächstes Schiff: ${nxt?.name ?? ''} (${nlen}) | Ausrichtung: ${game.player.orientation}`);
      }
    } else {
      setHUD(`Phase: ${game.phase} — Position ungültig.`);
      SFX.miss(); hapticPulse(0.2, 40);
    }
    return;
  }

  // 3) Schießen auf Gegnerbrett
  if (boardAI && game.phase === PHASE.PLAYER_TURN && lastHoverCell && lastHoverTarget === 'ai') {

    if (mpActive) {
      if (mpPendingShot) return;
      mpPendingShot = { i: lastHoverCell.i, j: lastHoverCell.j };
      setHUD(`Schuss (${mpPendingShot.i},${mpPendingShot.j}) gesendet — warte auf Ergebnis...`);
      mp?.send({ type: 'shot', cell: mpPendingShot });
      return;
    }

    // --- Singleplayer ---
    {
      const res = game.playerShoot(lastHoverCell.i, lastHoverCell.j);
      if (!res.ok) {
        if (res.result === 'repeat') setHUD('Bereits beschossen. Andere Zelle wählen.');
        else setHUD('Ungültiger Schuss.');
        SFX.miss(); hapticPulse(0.15, 40);
        return;
      }

      const isHit = (res.result === 'hit' || res.result === 'sunk');
      markMyShot(lastHoverCell.i, lastHoverCell.j, isHit, false);

      if (res.result === 'hit') {
        setHUD(`Treffer (${lastHoverCell.i},${lastHoverCell.j})${res.sunk ? ' — versenkt!' : ''}${res.gameOver ? ' — GAME OVER' : ''}`);
      } else if (res.result === 'sunk') {
        setHUD(`Schiff versenkt (${lastHoverCell.i},${lastHoverCell.j})${res.gameOver ? ' — GAME OVER' : ''}`);
        SFX.sunk(); hapticPulse(0.9, 200);
      } else if (res.result === 'miss') {
        setHUD(`Wasser (${lastHoverCell.i},${lastHoverCell.j}) — KI ist dran...`);
        showToastXR('KI schießt…', 2, '#402218');
      }

      if (res.gameOver) { showGameOverXR(true); SFX.win(); return; }

      if (game.phase === PHASE.AI_TURN) {
        const k = game.aiShootRandom();
        if (k && k.ok) {
          const aiHit = (k.result === 'hit' || k.result === 'sunk');
          markPeerShot(k.cell.i, k.cell.j, aiHit, false);

          if (k.result === 'hit') setHUD(`KI: Treffer (${k.cell.i},${k.cell.j})${k.sunk ? ' — versenkt!' : ''}${k.gameOver ? ' — GAME OVER (KI)' : ''}`);
          else if (k.result === 'sunk') { setHUD(`KI: versenkt (${k.cell.i},${k.cell.j})${k.gameOver ? ' — GAME OVER (KI)' : ''}`); SFX.sunk(); }
          else if (k.result === 'miss') setHUD(`KI: Wasser (${k.cell.i},${k.cell.j}). Dein Zug.`);

          if (k.gameOver) { showGameOverXR(false); SFX.lose(); }
          else { game.phase = PHASE.PLAYER_TURN; }
        }
      }
    }
  }
}

// ---------- MP: Start/Stop & Messages (unverändert zur letzten Version, nur gekürzt für Kontext) ----------
async function startMP(asHost) {
  if (mpActive) return;
  let url = (mpUrl?.value || '').trim();
  if (!url) { const scheme = (location.protocol === 'https:') ? 'wss' : 'ws'; url = `${scheme}://${location.hostname}:8443`; }
  if (location.protocol === 'https:' && url.startsWith('ws://')) url = url.replace(/^ws:\/\//,'wss://');
  const room = (mpRoom?.value || '').trim(); if (!room) { mpStatus.textContent = 'Bitte Raumcode setzen.'; return; }

  mp = new MPClient(); mpIsFresh = true; mpStatus.textContent = 'Verbinde...';
  mp.addEventListener('joined', (e) => { mpRole = e.detail.role; mpStatus.textContent = `WS verbunden — Rolle: ${mpRole}. Warte auf DataChannel...`; });
  mp.addEventListener('dc_open', () => {
    mpActive = true; mpLeaveBtn.disabled = false;
    if (mpIsFresh) mp?.send({ type: 'syncRequest' }); else if (mpPeerNewlyJoined) { setTimeout(()=> sendSyncState(), 200); mpPeerNewlyJoined = false; }
    mpStatus.textContent = `MP aktiv (Raum ${room}) — ${mpRole === 'host' ? 'Du startest nach „Bereit“' : 'Gegner startet'}`;
  });
  mp.addEventListener('dc_close', () => { mpActive = false; mpStatus.textContent = 'DataChannel geschlossen.'; });
  mp.addEventListener('peer_joined', () => { mpPeerNewlyJoined = true; mpStatus.textContent = 'Peer beigetreten — synchronisiere gleich...'; });
  mp.addEventListener('peer_left', () => { mpStatus.textContent = 'Gegner hat verlassen.'; if (game.phase !== PHASE.PLACE_PLAYER) setHUD('Gegner weg — warte auf Rejoin oder trenne.'); });
  mp.addEventListener('message', (e) => onMPMessage(e.detail));
  mp.addEventListener('error', (e) => { mpStatus.textContent = `Fehler: ${e.detail?.reason || 'unbekannt'}`; });

  try { await mp.connect(url, room); } catch (err) { mpStatus.textContent = `Verbindung fehlgeschlagen: ${err?.message || err}`; }
}

function stopMP() {
  mp?.disconnect();
  mpActive = false; mpRole = null; mpMyReady = false; mpPeerReady = false; mpPendingShot = null;
  mpMyCommit = null; mpPeerCommitHash = null; mpPeerVerified = null;
  mpIsFresh = false; mpPeerNewlyJoined = false;
  mpHist.myShots = []; mpHist.peerShots = [];
  rendered.my.clear(); rendered.peer.clear();
  mpStatus.textContent = 'Offline'; mpLeaveBtn.disabled = true;
}

// ... (onMPMessage, tryStartMPGame, Snapshot-Helpers, Commit-Helpers bleiben identisch wie in deiner letzten Version) ...

// ---------- Buttons / Rotation ----------
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

// ---------- Labels / Reset / Effekte / Marker/Historie / HUD ----------
function makeTextSprite(text, bg='#00ffc8', fg='#000') {
  const pad = 16;
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const r = 28;
  (function roundRect(ctx, x, y, w, h, r){
    const rr = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x+rr, y);
    ctx.arcTo(x+w, y,   x+w, y+h, rr);
    ctx.arcTo(x+w, y+h, x,   y+h, rr);
    ctx.arcTo(x,   y+h, x,   y,   rr);
    ctx.arcTo(x,   y,   x+w, y,   rr);
    ctx.closePath();
  })(ctx, pad, pad, canvas.width-2*pad, canvas.height-2*pad, r);
  ctx.fillStyle = bg; ctx.fill();
  ctx.fillStyle = fg; ctx.font = 'bold 96px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width/2, canvas.height/2);
  const tex = new THREE.CanvasTexture(canvas); tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat); sprite.scale.set(0.45, 0.22, 1); return sprite;
}
function placeLabelAboveBoard(sprite, board, boardQuat) { const local = new THREE.Vector3(0, 0.08, -0.6); const world = local.clone().applyQuaternion(boardQuat).add(board.position); sprite.position.copy(world); scene.add(sprite); }
function resetGame() { hideGameOverXR(); hideToastXR(); clearBoardsAndLabels(); newGame(); setHUD('Zurückgesetzt. Platziere die Bretter neu (Trigger).'); }
function clearBoardsAndLabels() { if (boardPlayer) scene.remove(boardPlayer); if (boardAI) scene.remove(boardAI); if (labelPlayer) scene.remove(labelPlayer); if (labelAI) scene.remove(labelAI); boardPlayer=null; boardAI=null; labelPlayer=null; labelAI=null; lastHoverCell=null; lastHoverTarget=null; }
function spawnRipple(board, i, j, color=0xffffff, startAlpha=0.9, life=0.6) { const p = board.cellCenterLocal(i, j); const ring = new THREE.Mesh(new THREE.RingGeometry(board.cellSize*0.05, board.cellSize*0.06, 32).rotateX(-Math.PI/2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: startAlpha })); ring.position.set(p.x, 0.006, p.z); board.add(ring); const maxScale=3.2; let t=0; effects.push({ mesh:ring, update:(dt)=>{ t+=dt; const k=t/life; ring.scale.setScalar(1+k*maxScale); ring.material.opacity=startAlpha*(1-k); if(k>=1){ board.remove(ring); return false; } return true; } }); }
function spawnBurst(board, i, j) { const p = board.cellCenterLocal(i, j); const group = new THREE.Group(); group.position.set(p.x, 0.008, p.z); board.add(group); const count = 10; const parts = []; for (let k=0;k<count;k++){ const m = new THREE.Mesh(new THREE.CircleGeometry(board.cellSize*0.08, 10).rotateX(-Math.PI/2), new THREE.MeshBasicMaterial({ color: 0xff5533, transparent: true, opacity: 0.95 })); group.add(m); const angle=(Math.PI*2)*(k/count)+Math.random()*0.5; const speed = board.cellSize*(1.8+Math.random()*0.8); parts.push({ m, vx:Math.cos(angle)*speed, vz:Math.sin(angle)*speed }); } let t=0; effects.push({ mesh:group, update:(dt)=>{ t+=dt; for(const p of parts){ p.m.position.x += p.vx*dt; p.m.position.z += p.vz*dt; p.vx*=0.92; p.vz*=0.92; p.m.material.opacity*=0.92; p.m.scale.multiplyScalar(0.98);} if(t>0.35){ board.remove(group); return false; } return true; } }); }
function shotKey(i,j){ return `${i},${j}`; }
function markMyShot(i,j,hit,silent=false){ const key=shotKey(i,j); if(!rendered.my.has(key)){ boardAI?.addShotMarker(i,j,hit); rendered.my.add(key); } if(!mpHist.myShots.some(s=>s.i===i&&s.j===j)){ mpHist.myShots.push({ i,j,result:hit?'hit':'miss',sunk:false }); } if(!silent){ if(hit){ SFX.hit(); hapticPulse(0.7,120); spawnBurst(boardAI,i,j);} else { SFX.miss(); hapticPulse(0.2,60); spawnRipple(boardAI,i,j);} } }
function markPeerShot(i,j,hit,silent=false){ const key=shotKey(i,j); if(!rendered.peer.has(key)){ boardPlayer?.addShotMarker(i,j,hit); rendered.peer.add(key); } if(!mpHist.peerShots.some(s=>s.i===i&&s.j===j)){ mpHist.peerShots.push({ i,j,result:hit?'hit':'miss',sunk:false }); } if(!silent){ if(hit){ SFX.hit(); hapticPulse(0.6,120); spawnBurst(boardPlayer,i,j);} else { SFX.miss(); hapticPulse(0.2,60); spawnRipple(boardPlayer,i,j);} } }
function setHUD(t){ const hud=document.getElementById('hud'); if(hud) hud.querySelector('.small').textContent=t; }
