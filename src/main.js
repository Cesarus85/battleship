// [BATTLESHIP_AR:STEP 7] Labels (DU/GEGNER), Reset, Game-Over-Overlay, Debug aus
import * as THREE from 'https://unpkg.com/three@0.166.1/build/three.module.js';
import { ARButton } from 'https://unpkg.com/three@0.166.1/examples/jsm/webxr/ARButton.js';
import { Board } from './board.js';
import { GameState, PHASE } from './state.js';

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

// Debug (standardmäßig AUS)
let debugRay = null;
let debugDot = null;

// UI
const overlay = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlayTitle');
const overlayMsg = document.getElementById('overlayMsg');
const btnAgain = document.getElementById('btnAgain');
const btnReset = document.getElementById('btnReset');

// Board-Labels (Sprites)
let labelPlayer = null;
let labelAI = null;

const prevButtons = new Map();
const IDX = { BY: 4 }; // Y/B zum Drehen
const BOARD_GAP = 1.2;

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
    new THREE.MeshBasicMaterial({ color: 0x00ffcc, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
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

  // Debug-Helfer (unsichtbar)
  const rayGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0,0,-0.9)]);
  debugRay = new THREE.Line(rayGeom, new THREE.LineBasicMaterial({ transparent:true, opacity:0.25 }));
  debugRay.visible = false; scene.add(debugRay);

  debugDot = new THREE.Mesh(new THREE.SphereGeometry(0.01, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffff00 }));
  debugDot.visible = false; scene.add(debugDot);

  // AR-Button
  const btn = ARButton.createButton(renderer, {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: document.body }
  });
  document.body.appendChild(btn);

  window.addEventListener('resize', onWindowResize);
  renderer.xr.addEventListener('sessionstart', onSessionStart);
  renderer.xr.addEventListener('sessionend', onSessionEnd);

  // UI-Events
  btnReset?.addEventListener('click', () => resetGame());
  btnAgain?.addEventListener('click', () => { hideOverlay(); resetGame(); });

  // GameState
  newGame();
  setHUD(`Phase: ${game.phase} — Platziere die Bretter mit Trigger.`);
}

function newGame() {
  game = new GameState();
  // Aufräumen falls vorher etwas da war
  clearBoardsAndLabels();
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

  // Intersections auf beide Boards prüfen
  let hitPlayer = null, hitAI = null;
  if (boardPlayer) { raycaster.set(ray.origin, ray.direction); hitPlayer = raycaster.intersectObject(boardPlayer.pickingPlane, false)[0] || null; }
  if (boardAI)     { raycaster.set(ray.origin, ray.direction); hitAI     = raycaster.intersectObject(boardAI.pickingPlane, false)[0]     || null; }

  // Zielwahl je Phase
  if (game.phase === PHASE.PLACE_PLAYER) {
    applyHover('player', hitPlayer);
    pollRotateButtons(frame);

    // Ghost-Vorschau auf Spielerbrett
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
    // Zielen nur auf Gegnerbrett
    boardPlayer?.clearGhost();
    applyHover('ai', hitAI);
  } else {
    clearHover();
    boardPlayer?.clearGhost();
  }

  // Labels (Sprites) brauchen keine lookAt, sie sind Sprites: sie „billboarden“ automatisch

  renderer.render(scene, camera);
}

function applyHover(target, hit) {
  lastHoverTarget = null;
  lastHoverCell = null;
  boardPlayer?.setHoverCell(null);
  boardAI?.setHoverCell(null);

  if (!hit) { debugDot.visible = false; return; }

  const board = (target === 'player') ? boardPlayer : boardAI;
  const cell = board?.worldToCell(hit.point) || null;
  if (cell) {
    lastHoverTarget = target;
    lastHoverCell = cell;
    if (target === 'ai') boardAI.setHoverCell(cell); // nur auf Gegnerbrett Highlight
    debugDot.position.copy(hit.point);
    debugDot.visible = false; // Debug-Punkt ist standardmäßig aus
  } else {
    debugDot.visible = false;
  }
}

function clearHover() {
  lastHoverTarget = null;
  lastHoverCell = null;
  boardPlayer?.setHoverCell(null);
  boardAI?.setHoverCell(null);
  debugDot.visible = false;
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
  // 1) Boards + Labels platzieren
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

    // Labels setzen
    labelPlayer = makeTextSprite('DU', '#2ad3ff', '#001018');
    labelAI = makeTextSprite('GEGNER', '#ff5a5a', '#220000');
    placeLabelAboveBoard(labelPlayer, boardPlayer, baseQuat);
    placeLabelAboveBoard(labelAI, boardAI, baseQuat);

    game.beginPlacement();
    setHUD(`Phase: ${game.phase} — Platziere deine Schiffe (Y/B: drehen, Trigger: setzen).`);
    return;
  }

  // 2) Spieler-Schiffe setzen (nur auf Spielerbrett wirksam)
  if (boardPlayer && game.phase === PHASE.PLACE_PLAYER && lastHoverCell && lastHoverTarget === 'player') {
    const type = game.player.fleet[game.player.nextShipIndex];
    if (!type) return;

    const ok = game.player.board.canPlaceShip(lastHoverCell.i, lastHoverCell.j, type.length, game.player.orientation);
    if (!ok) { setHUD(`Phase: ${game.phase} — Ungültig. Drehe (Y/B) oder andere Zelle.`); return; }

    const res = game.tryPlaceNextPlayerShip(lastHoverCell.i, lastHoverCell.j);
    if (res.ok) {
      const cells = boardPlayer.cellsForShip(lastHoverCell, type.length, game.player.orientation);
      boardPlayer.placeShipVisual(cells);
      boardPlayer.clearGhost();

      if (res.placedAll) {
        const ar = game.aiPlaceFleetRandom();
        if (!ar.ok) { setHUD(`Fehler bei KI-Platzierung: ${ar.reason}`); return; }
        setHUD(`Phase: ${game.phase} — Deine Runde: Ziele auf das rechte Brett und drücke Trigger.`);
      } else {
        const next = game.player.fleet[game.player.nextShipIndex];
        setHUD(`Phase: ${game.phase} — Nächstes Schiff: ${next.name} (${next.length}) | Ausrichtung: ${game.player.orientation}`);
      }
    } else {
      setHUD(`Phase: ${game.phase} — Position ungültig.`);
    }
    return;
  }

  // 3) Spielerschuss nur auf Gegnerbrett
  if (boardAI && game.phase === PHASE.PLAYER_TURN && lastHoverCell && lastHoverTarget === 'ai') {
    const res = game.playerShoot(lastHoverCell.i, lastHoverCell.j);
    if (!res.ok) {
      if (res.result === 'repeat') setHUD('Bereits beschossen. Andere Zelle wählen.');
      else setHUD('Ungültiger Schuss.');
      return;
    }

    boardAI.addShotMarker(lastHoverCell.i, lastHoverCell.j, res.result === 'hit' || res.result === 'sunk');
    if (res.result === 'hit') setHUD(`Treffer (${lastHoverCell.i},${lastHoverCell.j})${res.sunk ? ' — versenkt!' : ''}${res.gameOver ? ' — GAME OVER (Du gewinnst)' : ''}`);
    else if (res.result === 'sunk') setHUD(`Schiff versenkt (${lastHoverCell.i},${lastHoverCell.j})${res.gameOver ? ' — GAME OVER (Du gewinnst)' : ''}`);
    else if (res.result === 'miss') setHUD(`Wasser (${lastHoverCell.i},${lastHoverCell.j}) — KI ist dran...`);

    // Game Over?
    if (res.gameOver) { showOverlay(true); return; }

    // KI-Gegenschuss
    if (game.phase === PHASE.AI_TURN) {
      const k = game.aiShootRandom();
      if (k && k.ok) {
        boardPlayer.addShotMarker(k.cell.i, k.cell.j, k.result === 'hit' || k.result === 'sunk');
        if (k.result === 'hit') setHUD(`KI: Treffer (${k.cell.i},${k.cell.j})${k.sunk ? ' — versenkt!' : ''}${k.gameOver ? ' — GAME OVER (KI)' : ''}`);
        else if (k.result === 'sunk') setHUD(`KI: versenkt (${k.cell.i},${k.cell.j})${k.gameOver ? ' — GAME OVER (KI)' : ''}`);
        else if (k.result === 'miss') setHUD(`KI: Wasser (${k.cell.i},${k.cell.j}). Dein Zug.`);
        if (k.gameOver) { showOverlay(false); }
      }
    }
  }
}

function pollRotateButtons(frame){
  if (game.phase !== PHASE.PLACE_PLAYER) return;
  for (const c of controllers) {
    const gp = c.userData.inputSource?.gamepad;
    if (!gp) continue;
    let mask = 0; gp.buttons.forEach((b,i)=>{ if(b?.pressed) mask|=(1<<i); });
    const prev = prevButtons.get(c) ?? 0;
    const justBY = ((mask & (1<<IDX.BY)) && !(prev & (1<<IDX.BY)));
    if (justBY) setHUD(`Phase: ${game.phase} — Ausrichtung: ${game.toggleOrientation()}`);
    prevButtons.set(c, mask);
  }
}

function updateDebugRay(origin, direction){
  const arr = debugRay.geometry.attributes.position.array;
  arr[0]=origin.x; arr[1]=origin.y; arr[2]=origin.z;
  const end = new THREE.Vector3().copy(direction).multiplyScalar(0.9).add(origin);
  arr[3]=end.x; arr[4]=end.y; arr[5]=end.z;
  debugRay.geometry.attributes.position.needsUpdate = true;
  // debugRay.visible = true; // nur bei Bedarf!
}

// ---------- Labels / Overlay / Reset ----------

function makeTextSprite(text, bg='#00ffc8', fg='#000') {
  const pad = 16;
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);

  // Hintergrund (rounded)
  const r = 28;
  roundRect(ctx, pad, pad, canvas.width-2*pad, canvas.height-2*pad, r);
  ctx.fillStyle = bg; ctx.fill();

  // Text
  ctx.fillStyle = fg;
  ctx.font = 'bold 96px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width/2, canvas.height/2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.45, 0.22, 1); // Meter: Breite/Höhe
  return sprite;
}

function roundRect(ctx, x, y, w, h, r){
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y,   x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x,   y+h, rr);
  ctx.arcTo(x,   y+h, x,   y,   rr);
  ctx.arcTo(x,   y,   x+w, y,   rr);
  ctx.closePath();
}

function placeLabelAboveBoard(sprite, board, boardQuat) {
  // Position etwas "hinter" der oberen Kante, relativ zur Brett-Ausrichtung
  const local = new THREE.Vector3(0, 0.08, -0.6 * 1.0); // y: Höhe, z: hintere Kante
  const world = local.clone().applyQuaternion(boardQuat).add(board.position);
  sprite.position.copy(world);
  scene.add(sprite);
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
  // Scene cleanup
  clearBoardsAndLabels();
  // State
  newGame();
  setHUD('Zurückgesetzt. Platziere die Bretter neu (Trigger).');
}

function clearBoardsAndLabels() {
  if (boardPlayer) scene.remove(boardPlayer);
  if (boardAI) scene.remove(boardAI);
  if (labelPlayer) scene.remove(labelPlayer);
  if (labelAI) scene.remove(labelAI);
  boardPlayer = null; boardAI = null;
  labelPlayer = null; labelAI = null;
  lastHoverCell = null; lastHoverTarget = null;
}

function setHUD(t){ const hud=document.getElementById('hud'); if(hud) hud.querySelector('.small').textContent=t; }
