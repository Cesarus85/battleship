// [BATTLESHIP_AR:STEP 6 PATCH] Raycast auf BEIDE Boards + sauberes Targeting
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

let lastHoverCell = null;
let lastHoverTarget = null; // 'player' | 'ai' | null
let debugRay = null;
let debugDot = null;

const prevButtons = new Map();
const IDX = { BY: 4 }; // für Rotation in Platzierungsphase
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
  debugRay = new THREE.Line(rayGeom, new THREE.LineBasicMaterial({ transparent:true, opacity:0.35 }));
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

  game = new GameState();
  setHUD(`Phase: ${game.phase} — Platziere das AR-Brett.`);
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
    if (hits && hits.length > 0) {
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

  // XR-Ray bestimmen
  const ray = getXRRay(frame);
  if (!ray) {
    clearHover();
    renderer.render(scene, camera);
    return;
  }
  updateDebugRay(ray.origin, ray.direction);

  // Beide Bretter intersecten (falls vorhanden)
  let hitPlayer = null, hitAI = null;
  if (boardPlayer) { raycaster.set(ray.origin, ray.direction); hitPlayer = raycaster.intersectObject(boardPlayer.pickingPlane, false)[0] || null; }
  if (boardAI)     { raycaster.set(ray.origin, ray.direction); hitAI     = raycaster.intersectObject(boardAI.pickingPlane, false)[0]     || null; }

  // Zielwahl je Phase (aber Raycast immer auf beide)
  if (game.phase === PHASE.PLACE_PLAYER) {
    // Nur Spielerbrett relevant
    applyHover('player', hitPlayer);
    pollRotateButtons(frame);
    // Ghost-Vorschau
    if (lastHoverCell) {
      const type = game.player.fleet[game.player.nextShipIndex];
      if (type) {
        const cells = boardPlayer.cellsForShip(lastHoverCell, type.length, game.player.orientation);
        const valid = game.player.board.canPlaceShip(lastHoverCell.i, lastHoverCell.j, type.length, game.player.orientation);
        boardPlayer.showGhost(cells, valid);
        setHUD(`Phase: ${game.phase} — Schiff ${game.player.nextShipIndex + 1}/${game.player.fleet.length}: ${type.name} (${type.length}) | Ausrichtung: ${game.player.orientation}${valid ? '' : ' — ungültig'}`);
      }
    } else {
      boardPlayer.clearGhost();
    }
  } else if (game.phase === PHASE.PLAYER_TURN) {
    // Nur Gegnerbrett relevant
    boardPlayer.clearGhost();
    applyHover('ai', hitAI);
  } else {
    // Andere Phasen: nichts anvisieren
    clearHover();
    boardPlayer?.clearGhost();
  }

  renderer.render(scene, camera);
}

function applyHover(target, hit) {
  lastHoverTarget = null;
  lastHoverCell = null;
  // Highlight ausblenden auf beiden
  if (boardPlayer) boardPlayer.setHoverCell(null);
  if (boardAI) boardAI.setHoverCell(null);

  if (!hit) { debugDot.visible = false; return; }

  const board = (target === 'player') ? boardPlayer : boardAI;
  const cell = board?.worldToCell(hit.point) || null;
  if (cell) {
    lastHoverTarget = target;
    lastHoverCell = cell;
    if (target === 'player') {
      // In PLACE_PLAYER: kein Einzel-Highlight (Ghost übernimmt)
      debugDot.position.copy(hit.point); debugDot.visible = true;
    } else {
      // In PLAYER_TURN: Gegner-Highlight zeigen
      boardAI.setHoverCell(cell);
      debugDot.position.copy(hit.point); debugDot.visible = true;
    }
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
  // 1) Boards platzieren
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

    game.beginPlacement();
    setHUD(`Phase: ${game.phase} — Platziere deine Schiffe (Y/B: drehen, Trigger: setzen).`);
    return;
  }

  // 2) Spieler-Schiffe setzen (nur wenn wir tatsächlich über dem Spielerbrett stehen)
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

  // 3) Spielerschuss NUR wenn tatsächlich das Gegnerbrett anvisiert ist
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

    // Automatischer KI-Gegenschuss (falls nicht vorbei)
    if (game.phase === PHASE.AI_TURN && !res.gameOver) {
      const k = game.aiShootRandom();
      if (k && k.ok) {
        boardPlayer.addShotMarker(k.cell.i, k.cell.j, k.result === 'hit' || k.result === 'sunk');
        if (k.result === 'hit') setHUD(`KI: Treffer (${k.cell.i},${k.cell.j})${k.sunk ? ' — versenkt!' : ''}${k.gameOver ? ' — GAME OVER (KI)' : ''}`);
        else if (k.result === 'sunk') setHUD(`KI: versenkt (${k.cell.i},${k.cell.j})${k.gameOver ? ' — GAME OVER (KI)' : ''}`);
        else if (k.result === 'miss') setHUD(`KI: Wasser (${k.cell.i},${k.cell.j}). Dein Zug.`);
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
}

function setHUD(t){ const hud=document.getElementById('hud'); if(hud) hud.querySelector('.small').textContent=t; }
