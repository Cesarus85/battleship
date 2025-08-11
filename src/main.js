// [BATTLESHIP_AR:STEP 4] Echte Spieler-Platzierung: Ghost, Rotate (Y/B), Place (Trigger)
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
const prevButtons = new Map(); // controller -> prev pressed bitmask
const BTN = { A: 0, B: 1, X: 2, Y: 3 }; // typische Indizes; Quest: rechts A/B, links X/Y

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

    // --- Schritt 4: Ghost-Vorschau + Rotate-Input ---
    if (game.phase === PHASE.PLACE_PLAYER) {
      // 1) Rotate per Y/B (Edge)
      pollRotateButtons(frame);

      // 2) Ghost zeigen (falls Hover)
      if (lastHoverCell) {
        const type = game.player.fleet[game.player.nextShipIndex];
        if (type) {
          const cells = board.cellsForShip(lastHoverCell, type.length, game.player.orientation);
          // Prüfen gegen Modell (Bounds/Kollision)
          const valid = game.player.board.canPlaceShip(lastHoverCell.i, lastHoverCell.j, type.length, game.player.orientation);
          board.showGhost(cells, valid);
          setHUD(`Phase: ${game.phase} — Schiff ${game.player.nextShipIndex + 1}/${game.player.fleet.length}: ${type.name} (${type.length}) | Ausrichtung: ${game.player.orientation}${valid ? '' : ' — ungültig'}`);
        }
      } else {
        board.clearGhost();
      }
    } else {
      // außerhalb Platzierungsphase kein Ghost
      board.clearGhost();
    }
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

// Platzieren / Test-Toggle
function onSelect() {
  // 1) Board visuell platzieren
  if (!board && reticle.visible) {
    board = new Board({ size: 1.0, divisions: 10 });
    board.position.copy(reticle.position);
    board.quaternion.copy(reticle.quaternion);
    scene.add(board);

    game.beginPlacement();
    setHUD(`Phase: ${game.phase} — Platziere deine Schiffe. Y/B: drehen, Trigger: setzen.`);
    return;
  }

  // 2) Spieler-Schiff platzieren (echte Logik in Step 4)
  if (board && lastHoverCell && game.phase === PHASE.PLACE_PLAYER) {
    const type = game.player.fleet[game.player.nextShipIndex];
    if (!type) return;

    const ok = game.player.board.canPlaceShip(lastHoverCell.i, lastHoverCell.j, type.length, game.player.orientation);
    if (!ok) {
      setHUD(`Phase: ${game.phase} — Position ungültig. Drehe (Y/B) oder wähle andere Zelle.`);
      return;
    }

    const res = game.tryPlaceNextPlayerShip(lastHoverCell.i, lastHoverCell.j);
    if (res.ok) {
      // Visuals setzen
      const cells = board.cellsForShip(lastHoverCell, type.length, res.shipType ? game.player.orientation : game.player.orientation);
      board.placeShipVisual(cells);
      board.clearGhost();

      if (res.placedAll) {
        game.aiPlaceFleetRandomStub(); // Schritt 5: echte Platzierung
        setHUD(`Phase: ${game.phase} — (KI platziert als Nächstes; folgt in Schritt 5)`);
      } else {
        const next = game.player.fleet[game.player.nextShipIndex];
        setHUD(`Phase: ${game.phase} — Nächstes Schiff: ${next.name} (${next.length}) | Ausrichtung: ${game.player.orientation}`);
      }
    } else {
      setHUD(`Phase: ${game.phase} — Position ungültig.`);
    }
    return;
  }

  // 3) Andere Phasen: Test-Toggle beibehalten (optional)
  if (board && lastHoverCell) {
    const added = board.toggleMarker(lastHoverCell);
    setHUD(`Phase: ${game.phase} — ${added ? 'Markiert' : 'Entfernt'}: (${lastHoverCell.i},${lastHoverCell.j})`);
  }
}

// Y/B erkennen (Edge): Dreht h<->v
function pollRotateButtons(frame) {
  for (const c of controllers) {
    const src = c.userData.inputSource;
    const gp = src?.gamepad;
    if (!gp) continue;

    // pressed bitmask bilden
    let mask = 0;
    gp.buttons.forEach((b, idx) => {
      if (b?.pressed) mask |= (1 << idx);
    });

    const prev = prevButtons.get(c) ?? 0;
    const justPressedY = ((mask & (1 << BTN.Y)) && !(prev & (1 << BTN.Y)));
    const justPressedB = ((mask & (1 << BTN.B)) && !(prev & (1 << BTN.B)));

    if (justPressedY || justPressedB) {
      const ori = game.toggleOrientation();
      setHUD(`Phase: ${game.phase} — Ausrichtung gewechselt: ${ori}`);
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
