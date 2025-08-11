// [BATTLESHIP_AR:STEP 6] Zwei Boards (Spieler & Gegner), Spielerschuss + automatischer KI-Gegenschuss
import * as THREE from 'https://unpkg.com/three@0.166.1/build/three.module.js';
import { ARButton } from 'https://unpkg.com/three@0.166.1/examples/jsm/webxr/ARButton.js';
import { Board } from './board.js';
import { GameState, PHASE } from './state.js';

let scene, camera, renderer;
let reticle, hitTestSource = null, viewerSpace = null;
let referenceSpace = null;

let boardPlayer = null;  // dein Brett (links)
let boardAI = null;      // Gegner-Brett (rechts)
let game = null;

const controllers = [];
const raycaster = new THREE.Raycaster();

let lastHoverCell = null;
let debugRay = null;
let debugDot = null;

// Button-Edge-Detection (Rotate Y/B)
const prevButtons = new Map();
const IDX = { TRIGGER:0, SQUEEZE:1, STICK:2, AX:3, BY:4 };

const BOARD_GAP = 1.2; // Abstand zwischen den beiden Boards (Meter)

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

  // Controller 0 & 1
  for (let i = 0; i < 2; i++) {
    const c = renderer.xr.getController(i);
    c.userData.index = i;
    c.addEventListener('connected', (e) => { c.userData.inputSource = e.data; });
    c.addEventListener('disconnected', () => { delete c.userData.inputSource; prevButtons.delete(c); });
    c.addEventListener('select', onSelect);
    scene.add(c);
    controllers.push(c);
  }

  // Debug
  const rayGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0,0,-0.9)]);
  debugRay = new THREE.Line(rayGeom, new THREE.LineBasicMaterial({ transparent:true, opacity:0.35 }));
  debugRay.visible = false; // bei Bedarf true
  scene.add(debugRay);

  debugDot = new THREE.Mesh(new THREE.SphereGeometry(0.01, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffff00 }));
  debugDot.visible = false;
  scene.add(debugDot);

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

  // GameState
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
  // Hit-Test / Retikel, solange noch keine Boards stehen
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

  if (referenceSpace && frame) {
    const ray = getXRRay(frame);
    let hoverBoard = null;

    if (ray) {
      // Je nach Phase auf das passende Brett raycasten
      if (game.phase === PHASE.PLACE_PLAYER && boardPlayer) {
        hoverBoard = boardPlayer;
      } else if (game.phase === PHASE.PLAYER_TURN && boardAI) {
        hoverBoard = boardAI;
      }

      if (hoverBoard) {
        raycaster.set(ray.origin, ray.direction);
        const hit = raycaster.intersectObject(hoverBoard.pickingPlane, false)[0];
        if (hit) {
          const cell = hoverBoard.worldToCell(hit.point);
          lastHoverCell = cell || null;

          // In PLACE_PLAYER: Ghost (kein Einzel-Highlight)
          if (game.phase === PHASE.PLACE_PLAYER) {
            hoverBoard.highlight.visible = false;
            const type = game.player.fleet[game.player.nextShipIndex];
            if (type && lastHoverCell) {
              const cells = hoverBoard.cellsForShip(lastHoverCell, type.length, game.player.orientation);
              const valid = game.player.board.canPlaceShip(lastHoverCell.i, lastHoverCell.j, type.length, game.player.orientation);
              boardPlayer.showGhost(cells, valid);
              setHUD(`Phase: ${game.phase} — Schiff ${game.player.nextShipIndex + 1}/${game.player.fleet.length}: ${type.name} (${type.length}) | Ausrichtung: ${game.player.orientation}${valid ? '' : ' — ungültig'}`);
            } else {
              boardPlayer.clearGhost();
            }
          }
          // In PLAYER_TURN: Ziel-Highlight auf Gegner-Brett
          if (game.phase === PHASE.PLAYER_TURN) {
            boardAI.setHoverCell(lastHoverCell);
          }

          debugDot.position.copy(hit.point);
          debugDot.visible = !!cell;
        } else {
          lastHoverCell = null;
          if (boardPlayer) boardPlayer.clearGhost();
          if (boardAI) boardAI.setHoverCell(null);
          debugDot.visible = false;
        }

        updateDebugRay(ray.origin, ray.direction);
      } else {
        // keine Interaktion in anderen Phasen
        lastHoverCell = null;
        if (boardPlayer) { boardPlayer.clearGhost(); boardPlayer.setHoverCell(null); }
        if (boardAI) boardAI.setHoverCell(null);
        debugDot.visible = false;
        debugRay.visible = false;
      }

      // Buttons: Rotation nur in Platzierungsphase
      if (boardPlayer) pollRotateButtons(frame);
    }
  }

  renderer.render(scene, camera);
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
  // 1) Beide Boards platzieren (Spieler links, Gegner rechts)
  if (!boardPlayer && !boardAI && reticle.visible) {
    const basePos = reticle.position.clone();
    const baseQuat = reticle.quaternion.clone();

    // Spieler-Brett
    boardPlayer = new Board({ size: 1.0, divisions: 10 });
    boardPlayer.position.copy(basePos);
    boardPlayer.quaternion.copy(baseQuat);
    scene.add(boardPlayer);

    // Gegner-Brett (seitlich versetzt)
    boardAI = new Board({ size: 1.0, divisions: 10 });
    const offsetLocal = new THREE.Vector3(BOARD_GAP, 0, 0); // +X = rechts
    const offsetWorld = offsetLocal.clone().applyQuaternion(baseQuat);
    boardAI.position.copy(basePos).add(offsetWorld);
    boardAI.quaternion.copy(baseQuat);
    scene.add(boardAI);

    game.beginPlacement();
    setHUD(`Phase: ${game.phase} — Platziere deine Schiffe (Y/B: drehen, Trigger: setzen).`);
    return;
  }

  // 2) Spieler-Schiffe setzen
  if (boardPlayer && game.phase === PHASE.PLACE_PLAYER && lastHoverCell) {
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

  // 3) Spieler schießt auf das Gegner-Brett
  if (boardAI && game.phase === PHASE.PLAYER_TURN && lastHoverCell) {
    const res = game.playerShoot(lastHoverCell.i, lastHoverCell.j);
    if (!res.ok) {
      if (res.result === 'repeat') setHUD('Bereits beschossen. Wähle eine andere Zelle.');
      else setHUD('Ungültiger Schuss.');
      return;
    }

    // Marker auf Gegner-Brett
    boardAI.addShotMarker(lastHoverCell.i, lastHoverCell.j, res.result === 'hit' || res.result === 'sunk');
    if (res.result === 'hit') {
      setHUD(`Treffer bei (${lastHoverCell.i},${lastHoverCell.j})${res.sunk ? ' — Schiff versenkt!' : ''}${res.gameOver ? ' — GAME OVER (Du gewinnst)' : ''}`);
    } else if (res.result === 'sunk') {
      setHUD(`Schiff versenkt bei (${lastHoverCell.i},${lastHoverCell.j})${res.gameOver ? ' — GAME OVER (Du gewinnst)' : ''}`);
    } else if (res.result === 'miss') {
      setHUD(`Wasser bei (${lastHoverCell.i},${lastHoverCell.j}) — KI ist dran...`);
    }

    // Falls noch nicht vorbei: automatischer KI-Gegenschuss
    if (game.phase === PHASE.AI_TURN && !res.gameOver) {
      const k = game.aiShootRandom();
      if (k && k.ok) {
        boardPlayer.addShotMarker(k.cell.i, k.cell.j, k.result === 'hit' || k.result === 'sunk');
        if (k.result === 'hit') {
          setHUD(`KI: Treffer bei (${k.cell.i},${k.cell.j})${k.sunk ? ' — Schiff versenkt!' : ''}${k.gameOver ? ' — GAME OVER (KI)' : ''}`);
        } else if (k.result === 'sunk') {
          setHUD(`KI: Schiff versenkt bei (${k.cell.i},${k.cell.j})${k.gameOver ? ' — GAME OVER (KI)' : ''}`);
        } else if (k.result === 'miss') {
          setHUD(`KI: Wasser bei (${k.cell.i},${k.cell.j}). Dein Zug.`);
        }
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
