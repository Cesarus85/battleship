// [BATTLESHIP_AR:STEP 5 FIX] Korrekte Button-Mappings (A/X=3, Y/B=4, Stick=2) + Fallback
import * as THREE from 'https://unpkg.com/three@0.166.1/build/three.module.js';
import { ARButton } from 'https://unpkg.com/three@0.166.1/examples/jsm/webxr/ARButton.js';
import { Board } from './board.js';
import { GameState, PHASE } from './state.js';

let scene, camera, renderer;
let reticle, hitTestSource = null, viewerSpace = null;
let referenceSpace = null;

let board = null;
let game = null;

const controllers = [];
const raycaster = new THREE.Raycaster();

let lastHoverCell = null;
let debugRay = null;
let debugDot = null;

// Button-Edge-Detection
const prevButtons = new Map();
// WebXR (Quest Touch) übliche Indizes:
const IDX = {
  TRIGGER: 0,
  SQUEEZE: 1,
  STICK: 2, // Thumbstick-Press
  AX: 3,    // A (rechts) / X (links)
  BY: 4     // B (rechts) / Y (links)
};

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
  debugRay = new THREE.Line(rayGeom, new THREE.LineBasicMaterial({ transparent:true, opacity:0.4 }));
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

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

async function onSessionStart() {
  const session = renderer.xr.getSession();
  referenceSpace = await session.requestReferenceSpace('local');
  viewerSpace = await session.requestReferenceSpace('viewer');
  hitTestSource = await session.requestHitTestSource?.({ space: viewerSpace });
}

function onSessionEnd() {
  hitTestSource = null;
  viewerSpace = null;
  referenceSpace = null;
}

function animate() {
  renderer.setAnimationLoop(render);
}

function render(_, frame) {
  // Hit-Test / Retikel
  if (frame && hitTestSource && !board) {
    const hits = frame.getHitTestResults(hitTestSource);
    if (hits && hits.length > 0) {
      const pose = hits[0].getPose(renderer.xr.getReferenceSpace());
      if (pose) {
        reticle.visible = true;
        reticle.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
        const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
        reticle.quaternion.setFromRotationMatrix(m);
      }
    } else {
      reticle.visible = false;
    }
  }

  // Ray + Hover
  if (board && referenceSpace && frame) {
    const ray = getXRRay(frame);
    if (ray) {
      raycaster.set(ray.origin, ray.direction);
      updateDebugRay(ray.origin, ray.direction);

      const hit = raycaster.intersectObject(board.pickingPlane, false)[0];
      if (hit) {
        const cell = board.worldToCell(hit.point);
        lastHoverCell = cell || null;
        board.setHoverCell(lastHoverCell);
        debugDot.position.copy(hit.point);
        debugDot.visible = !!cell;
      } else {
        lastHoverCell = null;
        board.setHoverCell(null);
        debugDot.visible = false;
      }
    } else {
      lastHoverCell = null;
      board.setHoverCell(null);
      debugRay.visible = false;
      debugDot.visible = false;
    }

    // Buttons pollen (Rotation & KI-Testschuss)
    pollButtons(frame);
  }

  renderer.render(scene, camera);
}

function getXRRay(frame) {
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
      const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize();
      return { origin, direction, controller: c };
    }
  }

  // Fallback Gaze
  const cam = renderer.xr.getCamera(camera);
  const origin = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const direction = new THREE.Vector3(0, 0, -1).applyMatrix4(new THREE.Matrix4().extractRotation(cam.matrixWorld)).normalize();
  return { origin, direction, controller: null };
}

// Platzieren / Interaktion
function onSelect() {
  // 1) Brett platzieren
  if (!board && reticle.visible) {
    board = new Board({ size: 1.0, divisions: 10 });
    board.position.copy(reticle.position);
    board.quaternion.copy(reticle.quaternion);
    scene.add(board);

    game.beginPlacement();
    setHUD(`Phase: ${game.phase} — Platziere deine Schiffe (Y/B: drehen, Trigger: setzen).`);
    return;
  }

  // 2) Spieler-Schiff setzen (aus Schritt 4)
  if (board && lastHoverCell && game.phase === PHASE.PLACE_PLAYER) {
    const type = game.player.fleet[game.player.nextShipIndex];
    if (!type) return;

    const ok = game.player.board.canPlaceShip(lastHoverCell.i, lastHoverCell.j, type.length, game.player.orientation);
    if (!ok) { setHUD(`Phase: ${game.phase} — Ungültig. Drehe (Y/B) oder andere Zelle.`); return; }

    const res = game.tryPlaceNextPlayerShip(lastHoverCell.i, lastHoverCell.j);
    if (res.ok) {
      const cells = board.cellsForShip(lastHoverCell, type.length, game.player.orientation);
      board.placeShipVisual(cells);
      board.clearGhost();

      if (res.placedAll) {
        const ar = game.aiPlaceFleetRandom();
        if (!ar.ok) { setHUD(`Fehler bei KI-Platzierung: ${ar.reason}`); return; }
        setHUD(`Phase: ${game.phase} — Deine Runde. (Test: A/X ODER Stick drücken für KI-Schuss)`);
      } else {
        const next = game.player.fleet[game.player.nextShipIndex];
        setHUD(`Phase: ${game.phase} — Nächstes Schiff: ${next.name} (${next.length}) | Ausrichtung: ${game.player.orientation}`);
      }
    } else {
      setHUD(`Phase: ${game.phase} — Position ungültig.`);
    }
    return;
  }
}

// Buttons: Y/B zum Drehen (Index 4), A/X oder Stick-Press (Index 3/2) für KI-Testschuss
function pollButtons(frame) {
  for (const c of controllers) {
    const src = c.userData.inputSource;
    const gp = src?.gamepad;
    if (!gp) continue;

    // Bitmask aufbauen
    let mask = 0;
    gp.buttons.forEach((b, idx) => { if (b?.pressed) mask |= (1 << idx); });

    const prev = prevButtons.get(c) ?? 0;
    const edge = (idx) => ((mask & (1 << idx)) && !(prev & (1 << idx)));

    const justAX   = edge(IDX.AX);    // A (rechts) / X (links)
    const justBY   = edge(IDX.BY);    // B (rechts) / Y (links)
    const justSTK  = edge(IDX.STICK); // Thumbstick-Press

    // Debug: zeigen, welche Indizes erkannt wurden (einmalig pro Edge)
    if (justAX || justBY || justSTK) {
      setHUD(`Phase: ${game.phase} — Button Edge: ${[
        justAX ? 'AX(3)' : null,
        justBY ? 'BY(4)' : null,
        justSTK ? 'STICK(2)' : null
      ].filter(Boolean).join(', ')}`);
    }

    // Drehen nur in Platzierungsphase
    if (game.phase === PHASE.PLACE_PLAYER && justBY) {
      setHUD(`Phase: ${game.phase} — Ausrichtung: ${game.toggleOrientation()}`);
    }

    // KI-Testschuss in PLAYER_TURN (A/X ODER Stick)
    if (game.phase === PHASE.PLAYER_TURN && (justAX || justSTK)) {
      game.phase = PHASE.AI_TURN;
      const r = game.aiShootRandom();
      if (r && r.ok) {
        board.addShotMarker(r.cell.i, r.cell.j, r.result === 'hit' || r.result === 'sunk');
        if (r.result === 'hit') {
          setHUD(`KI: Treffer bei (${r.cell.i},${r.cell.j})${r.sunk ? ' — Schiff versenkt!' : ''}${r.gameOver ? ' — GAME OVER (KI)' : ''}`);
        } else if (r.result === 'sunk') {
          setHUD(`KI: Schiff versenkt bei (${r.cell.i},${r.cell.j})${r.gameOver ? ' — GAME OVER (KI)' : ''}`);
        } else if (r.result === 'miss') {
          setHUD(`KI: Wasser bei (${r.cell.i},${r.cell.j}). Dein Zug (Spielerschuss kommt in Schritt 6).`);
        } else if (r.result === 'repeat') {
          setHUD('KI: Wiederholung — drücke erneut.');
        }
      } else {
        setHUD(r?.reason ? `KI-Schuss fehlgeschlagen: ${r.reason}` : 'KI-Schuss fehlgeschlagen.');
      }
    }

    prevButtons.set(c, mask);
  }
}

function updateDebugRay(origin, direction) {
  const arr = debugRay.geometry.attributes.position.array;
  arr[0] = origin.x; arr[1] = origin.y; arr[2] = origin.z;
  const end = new THREE.Vector3().copy(direction).multiplyScalar(0.9).add(origin);
  arr[3] = end.x; arr[4] = end.y; arr[5] = end.z;
  debugRay.geometry.attributes.position.needsUpdate = true;
}

function setHUD(text) {
  const hud = document.getElementById('hud');
  if (hud) hud.querySelector('.small').textContent = text;
}
