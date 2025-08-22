// [BATTLESHIP_AR:STEP 12] Rejoin & Resync (Snapshot-Handshake) + Commit/Reveal + MP/SP
import * as THREE from 'https://unpkg.com/three@0.166.1/build/three.module.js';
import { ARButton } from 'https://unpkg.com/three@0.166.1/examples/jsm/webxr/ARButton.js';
import { Board } from './board.js';
import { GameState, PHASE } from './state.js';
import { CELL, ShipType, DEFAULT_FLEET } from './model.js';
import { MPClient } from './net.js';
import { sha256Hex, randomSalt } from './crypto.js';

// ---------- Szene / Renderer ----------
let scene, camera, renderer;
let reticle, hitTestSource = null, viewerSpace = null;
let referenceSpace = null;
let lastHit = null;
let lastHitPlane = null;
let lastPlaneMatrix = null;
let lowNormalWarned = false;

const RETICLE_COLOR_FOUND = 0x00ffcc;
const RETICLE_COLOR_NOHIT = 0xff4444;
const FALLBACK_DISTANCE = 1.0;
let noHit = false;
let hudPrevText = '';

let repositioning = false;

let boardPlayer = null;
let boardAI = null;
let boardAnchor = null;
let game = null;

const controllers = [];
const raycaster = new THREE.Raycaster();

// Hover-State
let lastHoverCell = null;
let lastHoverTarget = null; // 'player' | 'ai' | null

// Debug (aus)
let debugRay = null;
let debugDot = null;

// UI
const overlay = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlayTitle');
const overlayMsg = document.getElementById('overlayMsg');
const btnAgain = document.getElementById('btnAgain');
const btnReset = document.getElementById('btnReset');
const btnAudio = document.getElementById('btnAudio');
const btnReposition = document.getElementById('btnReposition');

// HUD-Statistiken
const hudStats = (() => {
  const hud = document.getElementById('hud');
  if (!hud) return null;
  const div = document.createElement('div');
  div.className = 'small';
  div.id = 'hudStats';
  div.style.marginTop = '4px';
  hud.appendChild(div);
  return div;
})();

// 3D Statistiktafel
let statsSprite = null;
let statsCanvas = null;
let statsCtx = null;
let statsTex = null;

// MP UI
const mpUrl = document.getElementById('mpUrl');
const mpRoom = document.getElementById('mpRoom');
const mpHostBtn = document.getElementById('mpHost');
const mpJoinBtn = document.getElementById('mpJoin');
const mpLeaveBtn = document.getElementById('mpLeave');
const mpStatus = document.getElementById('mpStatus');

function preventXRSelect(el) {
  const stop = e => { e.preventDefault(); e.stopPropagation(); };
  el.addEventListener('beforexrselect', stop, { passive: false, capture: true });
  el.addEventListener('pointerdown', e => e.stopPropagation(), { capture: true });
  el.addEventListener('touchstart', e => e.stopPropagation(), { capture: true });
}

// Schwierigkeitsauswahl
const difficultySelect = (() => {
  const box = document.createElement('div');
  box.style.position = 'fixed';
  box.style.top = '12px';
  box.style.left = '12px';
  box.style.background = 'rgba(0,0,0,0.45)';
  box.style.color = '#fff';
  box.style.borderRadius = '12px';
  box.style.padding = '10px 12px';
  box.style.font = '13px system-ui, sans-serif';
  const label = document.createElement('label');
  label.textContent = 'KI:';
  label.setAttribute('for', 'difficulty');
  label.style.marginRight = '6px';
  const sel = document.createElement('select');
  sel.id = 'difficulty';
  sel.innerHTML = `
    <option value="easy">Leicht</option>
    <option value="medium">Mittel</option>
    <option value="smart" selected>Schwer</option>
  `;
  preventXRSelect(sel);
  box.appendChild(label);
  box.appendChild(sel);
  document.body.appendChild(box);
  return sel;
})();

// Brettgröße & Flottenkonfiguration
const setupConfig = (() => {
  const box = document.createElement('div');
  box.style.position = 'fixed';
  box.style.top = '60px';
  box.style.left = '12px';
  box.style.background = 'rgba(0,0,0,0.45)';
  box.style.color = '#fff';
  box.style.borderRadius = '12px';
  box.style.padding = '10px 12px';
  box.style.font = '13px system-ui, sans-serif';

  const sizeLabel = document.createElement('label');
  sizeLabel.textContent = 'Größe:';
  sizeLabel.setAttribute('for', 'boardSize');
  sizeLabel.style.marginRight = '6px';
  const sizeSel = document.createElement('select');
  sizeSel.id = 'boardSize';
  for (let s = 8; s <= 12; s++) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = `${s}×${s}`;
    if (s === 10) opt.selected = true;
    sizeSel.appendChild(opt);
  }
  preventXRSelect(sizeSel);

  const fleetLabel = document.createElement('label');
  fleetLabel.textContent = 'Flotte (Name,Länge,Anzahl pro Zeile):';
  fleetLabel.style.display = 'block';
  fleetLabel.style.marginTop = '6px';
  const fleetInput = document.createElement('textarea');
  fleetInput.id = 'fleetDef';
  fleetInput.rows = 4;
  fleetInput.style.width = '180px';
  fleetInput.value = DEFAULT_FLEET.map(t => `${t.name},${t.length},${t.count}`).join('\n');
  preventXRSelect(fleetInput);

  box.appendChild(sizeLabel);
  box.appendChild(sizeSel);
  box.appendChild(fleetLabel);
  box.appendChild(fleetInput);
  document.body.appendChild(box);
  return { sizeSel, fleetInput };
})();

// Labels
let labelPlayer = null;
let labelAI = null;

// Buttons / Timing
const prevButtons = new Map();
const IDX = { BY: 4, TRIGGER: 0 };
const BOARD_GAP = 1.2;
const boardAIOffset = new THREE.Vector3(BOARD_GAP, 0, 0);
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

// ---------- Multiplayer + Commit/Reveal + Resync ----------
let mp = null;
let mpActive = false;
let mpRole = null;             // 'host' | 'guest'
let mpMyReady = false;
let mpPeerReady = false;
let mpPendingShot = null;      // {i,j}

// Commit/Reveal
let mpMyCommit = null;         // { salt, layout, hash }
let mpPeerCommitHash = null;   // string
let mpPeerVerified = null;     // true | false | null

// Rejoin/Resync
let mpIsFresh = false;         // dieser Client hat gerade (neu) verbunden
let mpPeerNewlyJoined = false; // wir laufen schon, Peer kommt neu rein

// Shot-Historie (für Resync-Snapshot)
const mpHist = { myShots: [], peerShots: [] }; // myShots = von mir auf Gegner; peerShots = vom Gegner auf mich
const rendered = { my: new Set(), peer: new Set() }; // dedup Keys "i,j"

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

  // Retikel
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.07, 0.09, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: RETICLE_COLOR_FOUND, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
  );
  reticle.visible = false;
  scene.add(reticle);

  // Controller
  for (let i = 0; i < 2; i++) {
    const c = renderer.xr.getController(i);
    c.userData.index = i;
    c.addEventListener('connected', (e) => { c.userData.inputSource = e.data; });
    c.addEventListener('disconnected', () => { delete c.userData.inputSource; prevButtons.delete(c); });
    c.addEventListener('select', onSelect);
    scene.add(c);
    controllers.push(c);
  }

  // Debug (aus)
  const rayGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0,0,-0.9)]);
  debugRay = new THREE.Line(rayGeom, new THREE.LineBasicMaterial({ transparent:true, opacity:0.25 }));
  debugRay.visible = false; scene.add(debugRay);

  debugDot = new THREE.Mesh(new THREE.SphereGeometry(0.01, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffff00 }));
  debugDot.visible = false; scene.add(debugDot);

  // AR-Button
  const btn = ARButton.createButton(renderer, {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay', 'anchors'],
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
    const on = btnAudio.textContent.includes('an');
    SFX.toggle(on);
    btnAudio.textContent = on ? '🔇 SFX aus' : '🔊 SFX an';
    if (on) { SFX.place(); hapticPulse(0.2, 40); }
  });
  btnReposition?.addEventListener('click', () => toggleReposition());

  mpHostBtn?.addEventListener('click', () => startMP(true));
  mpJoinBtn?.addEventListener('click', () => startMP(false));
  mpLeaveBtn?.addEventListener('click', () => stopMP());

  newGame();
  setHUD(`Phase: ${game.phase} — Platziere die Bretter mit Trigger.`);
}

function parseFleetInput(str = '') {
  const lines = str.split('\n').map(l => l.trim()).filter(Boolean);
  const fleet = [];
  for (const line of lines) {
    const [name, lenStr, countStr] = line.split(',').map(s => s.trim());
    const length = parseInt(lenStr, 10);
    const count = parseInt(countStr, 10);
    if (!name || isNaN(length) || isNaN(count)) continue;
    fleet.push(new ShipType(name, length, count));
  }
  return fleet.length ? fleet : DEFAULT_FLEET;
}

function newGame() {
  const size = parseInt(setupConfig?.sizeSel?.value, 10) || 10;
  const fleet = parseFleetInput(setupConfig?.fleetInput?.value);
  game = new GameState(difficultySelect?.value, size, fleet);
  clearBoardsAndLabels();
  effects = [];
  clock.start();

  mpMyReady = false; mpPeerReady = false; mpPendingShot = null;
  mpMyCommit = null; mpPeerCommitHash = null; mpPeerVerified = null;

  mpIsFresh = false; mpPeerNewlyJoined = false;
  mpHist.myShots = []; mpHist.peerShots = [];
  rendered.my.clear(); rendered.peer.clear();
  updateStatsHUD();
}

function onWindowResize(){ camera.aspect=window.innerWidth/window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); }

async function onSessionStart(){
  const session = renderer.xr.getSession();
  referenceSpace = await session.requestReferenceSpace('local');
  viewerSpace = await session.requestReferenceSpace('viewer');
  hitTestSource = await session.requestHitTestSource?.({
    space: viewerSpace,
    entityTypes: ['plane', 'point']
  });
}
function onSessionEnd(){ hitTestSource=null; viewerSpace=null; referenceSpace=null; boardAnchor=null; }

async function toggleReposition(){
  if (!boardPlayer || !boardAI) return;
  if (!repositioning) {
    repositioning = true;
    boardAnchor = null;
    reticle.visible = true;
    lastHit = null;
    btnReposition.textContent = 'Brett fixieren';
    setHUD('Bretter verschieben: ausrichten und erneut bestätigen.');
  } else {
    repositioning = false;
    reticle.visible = false;
    btnReposition.textContent = 'Brett verschieben';
    if (lastHit?.createAnchor) {
      try { boardAnchor = await lastHit.createAnchor(); } catch (e) { console.warn('Anchor creation failed', e); }
    }
    const q = reticle.quaternion;
    if (labelPlayer) { labelPlayer.position.copy(new THREE.Vector3(0,0.08,-0.6).applyQuaternion(q).add(boardPlayer.position)); }
    if (labelAI) { labelAI.position.copy(new THREE.Vector3(0,0.08,-0.6).applyQuaternion(q).add(boardAI.position)); }
    if (statsSprite) { statsSprite.position.copy(boardAI.position).add(new THREE.Vector3(0.8,0.25,-0.6).applyQuaternion(q)); }
    setHUD(`Phase: ${game.phase}`);
  }
}

function animate(){ renderer.setAnimationLoop(render); }

function render(_, frame) {
  const dt = clock.getDelta();

  // Hit-Test solange keine Boards oder beim Verschieben
  if (frame && hitTestSource && (!boardPlayer && !boardAI || repositioning)) {
    const hits = frame.getHitTestResults(hitTestSource);
    let found = false;
    if (hits?.length) {
      const refSpace = renderer.xr.getReferenceSpace();
      for (const hit of hits) {
        const pose = hit.getPose?.(refSpace);
        if (!pose) continue;

        const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
        const normal = new THREE.Vector3(0, 1, 0)
          .applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(m));

        if (normal.y >= 0.6) {
          reticle.visible = true;
          // Set position from hit test result, with small offset to place on surface
          reticle.position.set(
            pose.transform.position.x,
            pose.transform.position.y + 0.001, // Minimal offset to avoid z-fighting
            pose.transform.position.z
          );
          // Use the original rotation logic but ensure proper surface alignment
          reticle.quaternion.setFromRotationMatrix(m);
          lastHit = hit;
          lastHitPlane = hit?.plane || null;
          if (lastHitPlane) {
            const planePose = frame.getPose(lastHitPlane.planeSpace, refSpace);
            lastPlaneMatrix = planePose ? new THREE.Matrix4().fromArray(planePose.transform.matrix) : null;
          } else {
            lastPlaneMatrix = null;
          }
          found = true;
          break;
        } else {
          reticle.visible = true;
          // Set position from hit test result, with small offset to place on surface
          reticle.position.set(
            pose.transform.position.x,
            pose.transform.position.y + 0.001, // Minimal offset to avoid z-fighting
            pose.transform.position.z
          );
          // Use the original rotation logic but ensure proper surface alignment
          reticle.quaternion.setFromRotationMatrix(m);
          if (!lowNormalWarned) {
            console.warn('Surface is steep; placement may be unreliable.');
            lowNormalWarned = true;
          }
          lastHit = hit;
          lastHitPlane = hit?.plane || null;
          if (lastHitPlane) {
            const planePose = frame.getPose(lastHitPlane.planeSpace, refSpace);
            lastPlaneMatrix = planePose ? new THREE.Matrix4().fromArray(planePose.transform.matrix) : null;
          } else {
            lastPlaneMatrix = null;
          }
          found = true;
          break;
        }
      }
    }
    if (!found) {
      const camPos = new THREE.Vector3();
      camera.getWorldPosition(camPos);
      const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      reticle.visible = true;
      reticle.position.copy(camPos.add(dir.multiplyScalar(FALLBACK_DISTANCE)));
      reticle.quaternion.copy(camera.quaternion);
      lastHit = null;
      if (!noHit) {
        hudPrevText = getHUDText();
        setHUD('Keine Ebene erkannt – Objekt wird vor dir platziert.');
        reticle.material.color.setHex(RETICLE_COLOR_NOHIT);
        noHit = true;
      }
    } else if (noHit) {
      reticle.material.color.setHex(RETICLE_COLOR_FOUND);
      setHUD(hudPrevText);
      noHit = false;
    }
  }

  if (!referenceSpace || !frame) { renderer.render(scene, camera); return; }

  if (boardAnchor && boardPlayer && boardAI) {
    const anchorPose = frame.getPose(boardAnchor.anchorSpace, referenceSpace);
    if (anchorPose) {
      const { position, orientation } = anchorPose.transform;
      const anchorPos = new THREE.Vector3(position.x, position.y, position.z);
      const anchorQuat = new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w);
      boardPlayer.position.copy(anchorPos);
      boardPlayer.quaternion.copy(anchorQuat);
      const offsetWorld = boardAIOffset.clone().applyQuaternion(anchorQuat);
      boardAI.position.copy(anchorPos).add(offsetWorld);
      boardAI.quaternion.copy(anchorQuat);
    }
  }

  if (repositioning && boardPlayer && boardAI && reticle.visible) {
    boardPlayer.position.copy(reticle.position);
    boardPlayer.quaternion.copy(reticle.quaternion);
    const offsetWorld = boardAIOffset.clone().applyQuaternion(reticle.quaternion);
    boardAI.position.copy(reticle.position).add(offsetWorld);
    boardAI.quaternion.copy(reticle.quaternion);
    const q = reticle.quaternion;
    if (labelPlayer) labelPlayer.position.copy(new THREE.Vector3(0,0.08,-0.6).applyQuaternion(q).add(boardPlayer.position));
    if (labelAI) labelAI.position.copy(new THREE.Vector3(0,0.08,-0.6).applyQuaternion(q).add(boardAI.position));
    if (statsSprite) statsSprite.position.copy(boardAI.position).add(new THREE.Vector3(0.8,0.25,-0.6).applyQuaternion(q));
  }

  const ray = getXRRay(frame);
  if (!ray) {
    clearHover();
    renderer.render(scene, camera);
    return;
  }
  updateDebugRay(ray.origin, ray.direction);

  // beide Bretter intersecten
  let hitPlayer = null, hitAI = null;
  if (boardPlayer) { raycaster.set(ray.origin, ray.direction); hitPlayer = raycaster.intersectObject(boardPlayer.pickingPlane, false)[0] || null; }
  if (boardAI)     { raycaster.set(ray.origin, ray.direction); hitAI     = raycaster.intersectObject(boardAI.pickingPlane, false)[0]     || null; }

  if (game.phase === PHASE.PLACE_PLAYER) {
    applyHover('player', hitPlayer);
    pollRotateButtons();
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

  // Effekte
  if (effects.length) {
    effects = effects.filter((fx) => { try { return fx.update(dt) !== false; } catch { return false; } });
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

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].y;
    const xj = poly[j].x, zj = poly[j].y;
    const intersect = ((zi > pt.y) !== (zj > pt.y)) &&
      (pt.x < (xj - xi) * (pt.y - zi) / (zj - zi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function boardOverhang(pos, quat, plane, planeMatrix, size) {
  if (!plane || !plane.polygon || !planeMatrix) return false;
  const inv = new THREE.Matrix4().copy(planeMatrix).invert();
  const half = size / 2;
  const corners = [
    new THREE.Vector3(-half, 0, -half),
    new THREE.Vector3(-half, 0, half),
    new THREE.Vector3(half, 0, half),
    new THREE.Vector3(half, 0, -half)
  ];
  const polygon = [];
  if (Array.isArray(plane.polygon)) {
    for (const p of plane.polygon) {
      polygon.push(new THREE.Vector2(p.x, p.z));
    }
  } else {
    for (let i = 0; i < plane.polygon.length; i += 3) {
      polygon.push(new THREE.Vector2(plane.polygon[i], plane.polygon[i + 2]));
    }
  }
  for (const c of corners) {
    const world = c.clone().applyQuaternion(quat).add(pos);
    const local = world.clone().applyMatrix4(inv);
    const pt = new THREE.Vector2(local.x, local.z);
    if (!pointInPolygon(pt, polygon)) return true;
  }
  return false;
}

function addOverhangVisual(board) {
  const geom = new THREE.EdgesGeometry(new THREE.PlaneGeometry(board.size + 0.04, board.size + 0.04));
  const mat = new THREE.LineBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.8 });
  const line = new THREE.LineSegments(geom, mat);
  line.rotateX(-Math.PI / 2);
  line.position.y = 0.015;
  board.add(line);
}

// ---------- Interaktion ----------
async function onSelect(){
  if (repositioning) return;
  // 1) Bretter platzieren
  if (!boardPlayer && !boardAI && reticle.visible) {
    const basePos = reticle.position.clone();
    const baseQuat = reticle.quaternion.clone();
    const offsetWorld = boardAIOffset.clone().applyQuaternion(baseQuat);
    const aiPos = basePos.clone().add(offsetWorld);

    let overPlayer = false, overAI = false;
    if (lastHitPlane && lastPlaneMatrix) {
      overPlayer = boardOverhang(basePos, baseQuat, lastHitPlane, lastPlaneMatrix, 1.0);
      overAI = boardOverhang(aiPos, baseQuat, lastHitPlane, lastPlaneMatrix, 1.0);
      if (overPlayer || overAI) {
        const ok = confirm('Brett ragt über Tisch hinaus – trotzdem platzieren?');
        if (!ok) return;
      }
    }

    if (lastHit?.createAnchor) {
      try { boardAnchor = await lastHit.createAnchor(); } catch (e) { console.warn('Anchor creation failed', e); }
    }

    boardPlayer = new Board({ size: 1.0, divisions: game.player.board.size });
    boardPlayer.position.copy(basePos);
    boardPlayer.quaternion.copy(baseQuat);
    scene.add(boardPlayer);

    boardAI = new Board({ size: 1.0, divisions: game.ai.board.size });
    boardAI.position.copy(aiPos);
    boardAI.quaternion.copy(baseQuat);
    scene.add(boardAI);

    if (overPlayer) addOverhangVisual(boardPlayer);
    if (overAI) addOverhangVisual(boardAI);

    lastHit = null;

    labelPlayer = makeTextSprite('DU', '#2ad3ff', '#001018');
    labelAI = makeTextSprite('GEGNER', '#ff5a5a', '#220000');
    placeLabelAboveBoard(labelPlayer, boardPlayer, baseQuat);
    placeLabelAboveBoard(labelAI, boardAI, baseQuat);

    createStatsSprite();

    game.beginPlacement();
    setHUD(`Phase: ${game.phase} — Platziere deine Schiffe (Y/B: drehen, Trigger: setzen).`);
    SFX.toggle(btnAudio?.textContent.includes('an'));
    return;
  }

  // 2) Spieler-Schiffe setzen (auf Spielerbrett)
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
        if (mpActive) {
          // COMMIT: Hash senden (ohne Reveal)
          mpMyCommit = await buildCommit(game.player.board);
          mp?.send({ type: 'commit', hash: mpMyCommit.hash });
          mpMyReady = true;
          tryStartMPGame();
          setHUD(mpPeerCommitHash ? 'Beide bereit. Warte auf Start...' : 'Commit gesendet. Warte auf Gegner...');
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

  // 3) Schießen auf Gegnerbrett
  if (boardAI && game.phase === PHASE.PLAYER_TURN && lastHoverCell && lastHoverTarget === 'ai') {

    // Multiplayer: Schuss senden & auf Resultat warten
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
        boardAI?.animateSunkShip(res.ship.cells);
        SFX.sunk(); hapticPulse(0.9, 200);
      } else if (res.result === 'miss') {
        setHUD(`Wasser (${lastHoverCell.i},${lastHoverCell.j}) — KI ist dran...`);
      }

      if (res.gameOver) { showOverlay(true); SFX.win(); return; }

      // KI antwortet
      if (game.phase === PHASE.AI_TURN) {
        const k = game.aiShootRandom();
        if (k && k.ok) {
          const aiHit = (k.result === 'hit' || k.result === 'sunk');
          markPeerShot(k.cell.i, k.cell.j, aiHit, false);

          if (k.result === 'hit') setHUD(`KI: Treffer (${k.cell.i},${k.cell.j})${k.sunk ? ' — versenkt!' : ''}${k.gameOver ? ' — GAME OVER (KI)' : ''}`);
          else if (k.result === 'sunk') { setHUD(`KI: versenkt (${k.cell.i},${k.cell.j})${k.gameOver ? ' — GAME OVER (KI)' : ''}`); boardPlayer?.animateSunkShip(k.ship.cells); SFX.sunk(); hapticPulse(0.9, 200); }
          else if (k.result === 'miss') setHUD(`KI: Wasser (${k.cell.i},${k.cell.j}). Dein Zug.`);

          if (k.gameOver) { showOverlay(false); SFX.lose(); }
          else { game.phase = PHASE.PLAYER_TURN; }
        }
      }
    }
  }
}

// ---------- MP: Start/Stop & Messages ----------
async function startMP(asHost) {
  if (mpActive) return;
  let url = (mpUrl?.value || '').trim();
  if (!url) {
    const scheme = (location.protocol === 'https:') ? 'wss' : 'ws';
    url = `${scheme}://${location.hostname}:8443`;
  }
  if (location.protocol === 'https:' && url.startsWith('ws://')) url = url.replace(/^ws:\/\//,'wss://');

  const room = (mpRoom?.value || '').trim();
  if (!room) { mpStatus.textContent = 'Bitte Raumcode setzen.'; return; }

  mp = new MPClient();
  mpIsFresh = true;            // wir sind der frisch verbundene Client

  mpStatus.textContent = 'Verbinde...';

  mp.addEventListener('joined', (e) => {
    mpRole = e.detail.role;
    mpStatus.textContent = `WS verbunden — Rolle: ${mpRole}. Warte auf DataChannel...`;
  });
  mp.addEventListener('dc_open', () => {
    mpActive = true; mpLeaveBtn.disabled = false;

    // Handshake: Frischer Client fragt nach Snapshot, „alter“ Client sendet proaktiv beim Peer-Join
    if (mpIsFresh) {
      mp?.send({ type: 'syncRequest' });
    } else if (mpPeerNewlyJoined) {
      setTimeout(()=> sendSyncState(), 200);
      mpPeerNewlyJoined = false;
    }

    mpStatus.textContent = `MP aktiv (Raum ${room}) — ${mpRole === 'host' ? 'Du startest nach „Bereit“' : 'Gegner startet'}`;
  });
  mp.addEventListener('dc_close', () => {
    mpActive = false;
    mpStatus.textContent = 'DataChannel geschlossen.';
  });
  mp.addEventListener('peer_joined', () => {
    // Peer kam neu rein (WS-Ebene); sobald DC offen ist, Snapshot senden
    mpPeerNewlyJoined = true;
    mpStatus.textContent = 'Peer beigetreten — synchronisiere gleich...';
  });
  mp.addEventListener('peer_left', () => {
    mpStatus.textContent = 'Gegner hat verlassen.';
    if (game.phase !== PHASE.PLACE_PLAYER) setHUD('Gegner weg — warte auf Rejoin oder trenne.');
  });
  mp.addEventListener('message', (e) => onMPMessage(e.detail));
  mp.addEventListener('error', (e) => { mpStatus.textContent = `Fehler: ${e.detail?.reason || 'unbekannt'}`; });
  mp.addEventListener('ws_close', () => { stopMP(); mpStatus.textContent = 'WebSocket geschlossen.'; });

  try {
    await mp.connect(url, room);
  } catch (err) {
    mpStatus.textContent = `Verbindung fehlgeschlagen: ${err?.message || err}`;
  }
}

function stopMP() {
  mp?.disconnect();
  mpActive = false; mpRole = null; mpMyReady = false; mpPeerReady = false; mpPendingShot = null;
  mpMyCommit = null; mpPeerCommitHash = null; mpPeerVerified = null;
  mpIsFresh = false; mpPeerNewlyJoined = false;
  mpHist.myShots = []; mpHist.peerShots = [];
  rendered.my.clear(); rendered.peer.clear();
  mpStatus.textContent = 'Offline';
  mpLeaveBtn.disabled = true;
}

async function onMPMessage(msg) {
  switch (msg.type) {
    case 'placeReady': { mpPeerReady = true; tryStartMPGame(); break; }

    case 'commit': {
      mpPeerCommitHash = msg.hash;
      mpStatus.textContent = `Commit empfangen (${msg.hash.slice(0,8)}…). ${mpMyCommit ? 'Warte auf Start…' : 'Platziere deine Flotte.'}`;
      tryStartMPGame();
      break;
    }

    // --- Rejoin/Resync ---
    case 'syncRequest': {
      // Sende Snapshot unseres aktuellen Zustands
      sendSyncState();
      break;
    }
    case 'syncState': {
      applySyncState(msg.snapshot);
      mpIsFresh = false;
      break;
    }

    // --- Gameplay ---
    case 'shot': {
      if (!boardPlayer) return;
      const { i, j } = msg.cell;
      const res = game.player.board.shoot(i, j);
      const isHit = (res.result === 'hit' || res.result === 'sunk');

      markPeerShot(i, j, isHit, false);
      // Ergebnis zurück
      const payload = { type: 'shotResult', cell: { i, j }, result: res.result, sunk: !!res.sunk, gameOver: !!res.gameOver };
      if (res.sunk) payload.shipCells = res.ship.cells;
      mp?.send(payload);

      if (res.result === 'hit') setHUD(`Gegner: Treffer (${i},${j})${res.sunk ? ' — versenkt!' : ''}${res.gameOver ? ' — GAME OVER (du verlierst)' : ''}`);
      else if (res.result === 'sunk') { setHUD(`Gegner: versenkt (${i},${j})${res.gameOver ? ' — GAME OVER (du verlierst)' : ''}`); boardPlayer?.animateSunkShip(res.ship.cells); SFX.sunk(); hapticPulse(0.9, 200); }
      else if (res.result === 'miss') setHUD(`Gegner: Wasser (${i},${j}). Dein Zug.`);

      if (res.gameOver) {
        showOverlay(false); SFX.lose();
        if (mpMyCommit) mp?.send({ type: 'reveal', salt: mpMyCommit.salt, layout: mpMyCommit.layout });
      } else {
        game.phase = PHASE.PLAYER_TURN;
      }
      break;
    }

    case 'shotResult': {
      if (!mpPendingShot) return;
      const { i, j } = msg.cell;
      const isHit = (msg.result === 'hit' || msg.result === 'sunk');

      markMyShot(i, j, isHit, false);
      mpPendingShot = null;

      if (msg.result === 'hit') setHUD(`Treffer (${i},${j})${msg.sunk ? ' — versenkt!' : ''}${msg.gameOver ? ' — GAME OVER (Du gewinnst)' : ''}`);
      else if (msg.result === 'sunk') { setHUD(`Schiff versenkt (${i},${j})${msg.gameOver ? ' — GAME OVER (Du gewinnst)' : ''}`); if (msg.shipCells) boardAI?.animateSunkShip(msg.shipCells); SFX.sunk(); hapticPulse(0.9, 200); }
      else if (msg.result === 'miss') setHUD(`Wasser (${i},${j}) — Gegner ist dran...`);

      if (msg.gameOver) {
        showOverlay(true); SFX.win();
        if (mpMyCommit) mp?.send({ type: 'reveal', salt: mpMyCommit.salt, layout: mpMyCommit.layout });
      } else {
        game.phase = PHASE.AI_TURN;
      }
      break;
    }

    // --- Reveal/Verify ---
    case 'reveal': {
      const calc = await sha256Hex(`${msg.salt}|${msg.layout}`);
      const ok = (calc === mpPeerCommitHash);
      mpPeerVerified = ok;
      mpStatus.textContent = ok ? 'Reveal: ✓ verifiziert' : 'Reveal: ✗ MISMATCH!';
      setHUD(ok ? 'Peer-Reveal verifiziert.' : 'Commit/Reveal MISMATCH – mögliches Cheating.');
      break;
    }

    default: break;
  }
}

function tryStartMPGame() {
  // Start erst, wenn BEIDE bereit + BEIDE Commits vorhanden
  if (!mpActive) return;
  if (!mpMyReady || !mpPeerReady) return;
  if (!mpMyCommit || !mpPeerCommitHash) return;

  if (mpRole === 'host') {
    game.phase = PHASE.PLAYER_TURN;
    setHUD('Beide bereit. **Du startest.** Ziele auf das rechte Brett und drücke Trigger.');
  } else {
    game.phase = PHASE.AI_TURN;
    setHUD('Beide bereit. **Gegner beginnt.** Bitte warten…');
  }
}

// ---------- Snapshot-Helpers ----------
function sendSyncState() {
  const snapshot = buildSyncState();
  mp?.send({ type: 'syncState', snapshot });
  mpStatus.textContent = 'Snapshot gesendet.';
}

function buildSyncState() {
  return {
    v: 1,
    role: mpRole,
    phase: game.phase,                // aus Sicht des Senders
    myReady: mpMyReady,
    peerReady: mpPeerReady,
    myCommitHash: mpMyCommit?.hash || null,
    peerCommitHash: mpPeerCommitHash || null,
    myShots: mpHist.myShots.slice(),  // {i,j,result,sunk}
    peerShots: mpHist.peerShots.slice(),
    pendingShot: mpPendingShot ? { ...mpPendingShot } : null,
    peerVerified: mpPeerVerified,
  };
}

function applySyncState(snap) {
  // Phase übersetzen: „PLAYER_TURN“ (Sender) = bei uns „AI_TURN“
  let mappedPhase = PHASE.PLAYER_TURN;
  if (snap.phase === PHASE.PLAYER_TURN) mappedPhase = PHASE.AI_TURN;
  else if (snap.phase === PHASE.AI_TURN) mappedPhase = PHASE.PLAYER_TURN;
  else mappedPhase = snap.phase; // PLACE_PLAYER/GAME_OVER theoretisch nicht im MP-Spielbetrieb

  // Commit/Ready übernehmen (aus Sicht des Peers)
  mpPeerReady = !!snap.myReady;
  if (typeof snap.myCommitHash === 'string') mpPeerCommitHash = snap.myCommitHash;

  // Historie zeichnen (idempotent, ohne SFX/Haptik)
  // 1) Shots des Peers (auf UNS) ⇒ Marker auf boardPlayer
  for (const s of (snap.myShots || [])) {
    markPeerShot(s.i, s.j, s.result === 'hit' || s.result === 'sunk', true);
  }
  // 2) Shots von uns (die der Peer gespeichert hat) ⇒ Marker auf boardAI
  for (const s of (snap.peerShots || [])) {
    markMyShot(s.i, s.j, s.result === 'hit' || s.result === 'sunk', true);
  }

  // Pending-Edgecases ignorieren (vereinfachen): Turn aus Phase
  game.phase = mappedPhase;

  // UI
  const who =
    game.phase === PHASE.PLAYER_TURN ? 'Du bist dran.' :
    game.phase === PHASE.AI_TURN ? 'Gegner ist dran…' : `${game.phase}`;
  setHUD(`Resync fertig. ${who}`);
  mpStatus.textContent = 'Snapshot angewendet.';
}

// ---------- Commit-Helfer ----------
async function buildCommit(boardModel) {
  const layout = layoutString(boardModel);
  const salt = randomSalt(16);
  const hash = await sha256Hex(`${salt}|${layout}`);
  return { salt, layout, hash };
}

function layoutString(boardModel) {
  const out = [];
  const N = boardModel.size ?? (boardModel.grid?.length || 10);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const v = boardModel.grid[j][i];
      if (v === CELL.Ship) out.push(`${i},${j}`);
    }
  }
  out.sort(); // deterministisch
  return out.join(';');
}

// ---------- Buttons / Rotation ----------
function pollRotateButtons(){
  if (game.phase !== PHASE.PLACE_PLAYER) return;
  const now = performance.now();
  for (const c of controllers) {
    const gp = c.userData.inputSource?.gamepad;
    if (!gp) continue;
    let mask = 0; gp.buttons.forEach((b,i)=>{ if(b?.pressed) mask|=(1<<i); });
    const state = prevButtons.get(c) ?? { mask:0, t0:0, handled:false };

    const justBY = ((mask & (1<<IDX.BY)) && !(state.mask & (1<<IDX.BY)));
    if (justBY) { setHUD(`Phase: ${game.phase} — Ausrichtung: ${game.toggleOrientation()}`); SFX.rotate(); hapticPulse(0.25, 40); }

    // Langer Triggerdruck zum Entfernen des letzten Schiffs
    if (mask & (1<<IDX.TRIGGER)) {
      if (!(state.mask & (1<<IDX.TRIGGER))) {
        state.t0 = now; state.handled = false;
      } else if (!state.handled && (now - state.t0) > 600) {
        state.handled = true;
        if (lastHoverCell && lastHoverTarget === 'player') {
          const res = game.removePlayerShip(lastHoverCell.i, lastHoverCell.j);
          if (res.ok) {
            refreshPlayerShips();
            const next = game.player.fleet[game.player.nextShipIndex];
            if (next) setHUD(`Phase: ${game.phase} — Schiff ${game.player.nextShipIndex + 1}/${game.player.fleet.length}: ${next.name} (${next.length}) | Ausrichtung: ${game.player.orientation}`);
            SFX.miss(); hapticPulse(0.25, 40);
          }
        }
      }
    } else {
      state.t0 = 0; state.handled = false;
    }

    state.mask = mask;
    prevButtons.set(c, state);
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

// ---------- Labels / Overlay / Reset ----------
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
  const summary = storeStats();
  overlayTitle.textContent = playerWon ? '🎉 Du hast gewonnen!' : '💥 Du hast verloren';
  let msg = playerWon
    ? 'Alle gegnerischen Schiffe wurden versenkt.'
    : 'Deine Flotte wurde versenkt.';
  if (summary) {
    msg += `<br>Schüsse: ${summary.shots}, Treffer: ${summary.hits}, Versenkt: ${summary.sunk}, Quote: ${summary.acc}%`;
    msg += `<br>Ø-Quote (${summary.games} Spiele): ${summary.avgAcc}%`;
  }
  overlayMsg.innerHTML = msg;
  overlay.style.display = 'flex';
}
function hideOverlay() { overlay.style.display = 'none'; }

function storeStats() {
  if (!game) return null;
  const s = game.stats.player;
  const key = 'battleshipStats';
  const data = JSON.parse(localStorage.getItem(key) || '{"games":0,"shots":0,"hits":0,"sunk":0}');
  data.games += 1;
  data.shots += s.shots;
  data.hits += s.hits;
  data.sunk += s.sunk;
  localStorage.setItem(key, JSON.stringify(data));
  const acc = s.shots ? Math.round(100 * s.hits / s.shots) : 0;
  const avgAcc = data.shots ? Math.round(100 * data.hits / data.shots) : 0;
  return { shots: s.shots, hits: s.hits, sunk: s.sunk, acc, avgAcc, games: data.games };
}

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
  if (statsSprite) {
    scene.remove(statsSprite);
    statsSprite.material?.dispose();
  }
  if (statsTex) statsTex.dispose();
  statsSprite = null; statsCanvas = null; statsCtx = null; statsTex = null;
  boardPlayer = null; boardAI = null; labelPlayer = null; labelAI = null;
  boardAnchor = null;
  lastHoverCell = null; lastHoverTarget = null;
  repositioning = false;
  if (btnReposition) btnReposition.textContent = 'Brett verschieben';
  reticle.visible = false;
}

// ---------- Effekte ----------
function refreshPlayerShips(){
  if (!boardPlayer) return;
  const group = boardPlayer.shipsGroup;
  for (const child of [...group.children]) {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach(m=>m.dispose());
      else child.material.dispose();
    }
  }
  group.clear();
  for (const s of game.player.board.ships) {
    boardPlayer.placeShipVisual(s.cells);
  }
}

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

// ---------- Marker/Historie Helpers ----------
function shotKey(i,j){ return `${i},${j}`; }

function markMyShot(i, j, hit, silent=false) {
  const key = shotKey(i,j);
  if (!rendered.my.has(key)) {
    boardAI?.addShotMarker(i, j, hit);
    rendered.my.add(key);
  }
  // Historie (idempotent)
  if (!mpHist.myShots.some(s => s.i===i && s.j===j)) {
    mpHist.myShots.push({ i, j, result: hit ? 'hit' : 'miss', sunk: false });
  }
  if (!silent) {
    if (hit) { SFX.hit(); hapticPulse(0.7, 120); spawnBurst(boardAI, i, j); }
    else { SFX.miss(); hapticPulse(0.2, 60); spawnRipple(boardAI, i, j); }
    updateStatsHUD();
  }
}

function markPeerShot(i, j, hit, silent=false) {
  const key = shotKey(i,j);
  if (!rendered.peer.has(key)) {
    boardPlayer?.addShotMarker(i, j, hit);
    rendered.peer.add(key);
  }
  if (!mpHist.peerShots.some(s => s.i===i && s.j===j)) {
    mpHist.peerShots.push({ i, j, result: hit ? 'hit' : 'miss', sunk: false });
  }
  if (!silent) {
    if (hit) { SFX.hit(); hapticPulse(0.6, 120); spawnBurst(boardPlayer, i, j); }
    else { SFX.miss(); hapticPulse(0.2, 60); spawnRipple(boardPlayer, i, j); }
    updateStatsHUD();
  }
}

// ---------- HUD ----------
function setHUD(t){ const hud=document.getElementById('hud'); if(hud) hud.querySelector('.small').textContent=t; }
function getHUDText(){ const hud=document.getElementById('hud'); return hud ? hud.querySelector('.small').textContent : ''; }
function createStatsSprite(){
  statsCanvas = document.createElement('canvas');
  // Increase canvas width so longer text fits without wrapping
  statsCanvas.width = 1024; statsCanvas.height = 256;
  statsCtx = statsCanvas.getContext('2d');
  statsTex = new THREE.CanvasTexture(statsCanvas);
  // Disable depth testing so the stats panel is always visible above labels
  const mat = new THREE.SpriteMaterial({ map: statsTex, transparent: true, depthTest: false });
  statsSprite = new THREE.Sprite(mat);
  // Keep panel in front of the enemy label
  statsSprite.renderOrder = 1;
  // Adjust scale proportionally to the wider canvas
  statsSprite.scale.set(1.2, 0.35, 1);
  scene.add(statsSprite);
  // Position the stats sprite slightly offset from the enemy label
  const offset = new THREE.Vector3(0.8, 0.25, -0.6).applyQuaternion(boardAI.quaternion);
  statsSprite.position.copy(boardAI.position).add(offset);
  updateStatsHUD();
}

function updateStatsHUD(){ if(!hudStats||!game) return; const ps=game.stats.player; const as=game.stats.ai; hudStats.textContent=`Du: ${ps.shots} Schüsse, ${ps.hits} Treffer, ${ps.sunk} versenkt | KI: ${as.shots} Schüsse, ${as.hits} Treffer, ${as.sunk} versenkt`; if(statsCtx && statsTex){ statsCtx.clearRect(0,0,statsCanvas.width,statsCanvas.height); statsCtx.fillStyle='rgba(0,0,0,0.55)'; statsCtx.fillRect(0,0,statsCanvas.width,statsCanvas.height); statsCtx.fillStyle='#fff'; statsCtx.font='40px sans-serif'; statsCtx.textBaseline='top'; statsCtx.fillText(`Du: ${ps.shots} Schüsse, ${ps.hits} Treffer, ${ps.sunk} versenkt`,20,40); statsCtx.fillText(`KI: ${as.shots} Schüsse, ${as.hits} Treffer, ${as.sunk} versenkt`,20,140); statsTex.needsUpdate=true; } }
