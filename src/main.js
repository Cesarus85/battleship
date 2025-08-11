// [BATTLESHIP_AR:STEP 2 FIX] AR Boot + Hit-Test + Board + Robustes Ray-Picking (Controller 0/1 + Fallback Gaze)
import * as THREE from 'https://unpkg.com/three@0.166.1/build/three.module.js';
import { ARButton } from 'https://unpkg.com/three@0.166.1/examples/jsm/webxr/ARButton.js';
import { Board } from './board.js';

let scene, camera, renderer;
let reticle, hitTestSource = null, viewerSpace = null;
let board = null;
let referenceSpace = null;

const controllers = [];
const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();

let debugRay = null;

init();
animate();

async function init() {
  // Szene & Renderer
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

  // Controller 0 & 1 einrichten
  for (let i = 0; i < 2; i++) {
    const c = renderer.xr.getController(i);
    c.userData.index = i;
    c.addEventListener('select', onSelect);
    c.addEventListener('connected', (e) => {
      // Merke InputSource (wichtig für AR targetRaySpace)
      c.userData.inputSource = e.data;
    });
    c.addEventListener('disconnected', () => {
      delete c.userData.inputSource;
    });
    scene.add(c);
    controllers.push(c);
  }

  // Debug-Ray (sichtbarer Strahl)
  const rayGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0,0,-0.8)]);
  const rayMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.6 });
  debugRay = new THREE.Line(rayGeom, rayMat);
  debugRay.visible = false; // schalte auf true, wenn du dauerhaft sehen willst
  scene.add(debugRay);

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

function render(timestamp, frame) {
  // Hit-Test für Retikel, solange kein Board platziert ist
  if (frame && hitTestSource && !board) {
    const hitTestResults = frame.getHitTestResults(hitTestSource);
    if (hitTestResults && hitTestResults.length > 0) {
      const hit = hitTestResults[0];
      const pose = hit.getPose(renderer.xr.getReferenceSpace());
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

  // Picking nur wenn Board existiert
  if (board && referenceSpace && frame) {
    // Baue Ray aus aktivem Controller (tracked-pointer) oder fallback Gaze
    const { origin, direction, from } = getXRRay(frame);

    if (origin && direction) {
      raycaster.set(origin, direction);

      // Debug-Ray visualisieren
      updateDebugRay(origin, direction);

      const intersects = raycaster.intersectObject(board.pickingPlane, false);
      if (intersects.length > 0) {
        const p = intersects[0].point;
        const cell = board.worldToCell(p);
        board.setHoverCell(cell);
      } else {
        board.setHoverCell(null);
      }
    } else {
      board.setHoverCell(null);
      debugRay.visible = false;
    }
  }

  renderer.render(scene, camera);
}

// Liefert Ray aus XRInputSource (tracked-pointer Controller bevorzugt), sonst Gaze (Kamera-Vorwärts)
function getXRRay(frame) {
  const session = renderer.xr.getSession();
  if (!session || !referenceSpace) return { origin: null, direction: null, from: null };

  // 1) Versuche "tracked-pointer" Controller (0/1)
  for (const c of controllers) {
    const src = c.userData.inputSource;
    if (!src) continue;
    if (src.targetRayMode === 'tracked-pointer') {
      const pose = frame.getPose(src.targetRaySpace, referenceSpace);
      if (pose) {
        const o = new THREE.Vector3(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
        const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
        const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(m).sub(o).normalize();
        return { origin: o, direction: dir, from: 'controller' };
      }
    }
  }

  // 2) Fallback: „screen“/Gaze – nutze Kamera-Vorwärtsvektor
  const cam = renderer.xr.getCamera(camera);
  const o = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(new THREE.Matrix4().extractRotation(cam.matrixWorld)).normalize();
  return { origin: o, direction: dir, from: 'gaze' };
}

// Trigger: Platzieren ODER Zelle toggeln
function onSelect() {
  // 1) Board platzieren
  if (!board && reticle.visible) {
    board = new Board({ size: 1.0, divisions: 10 });
    board.position.copy(reticle.position);
    board.quaternion.copy(reticle.quaternion);
    scene.add(board);

    setHUD('Brett platziert. Zielen & Trigger: Zelle markieren/entfernen.');
    return;
  }

  // 2) Zelle toggeln
  if (board) {
    // Nutze den letzten berechneten Ray im Render-Loop erneut
    const session = renderer.xr.getSession();
    const frame = renderer.xr.getFrame?.();
    if (!session || !frame || !referenceSpace) return;

    const { origin, direction } = getXRRay(frame);
    if (!origin || !direction) return;

    raycaster.set(origin, direction);
    const intersects = raycaster.intersectObject(board.pickingPlane, false);
    if (intersects.length > 0) {
      const p = intersects[0].point;
      const cell = board.worldToCell(p);
      if (cell) {
        const added = board.toggleMarker(cell);
        setHUD(added ? `Markiert: (${cell.i}, ${cell.j})` : `Entfernt: (${cell.i}, ${cell.j})`);
      }
    }
  }
}

function updateDebugRay(origin, direction) {
  if (!debugRay) return;
  const pts = debugRay.geometry.attributes.position.array;
  pts[0] = origin.x; pts[1] = origin.y; pts[2] = origin.z;
  const end = new THREE.Vector3().copy(direction).multiplyScalar(0.8).add(origin);
  pts[3] = end.x; pts[4] = end.y; pts[5] = end.z;
  debugRay.geometry.attributes.position.needsUpdate = true;
  // Stelle sichtbar – schalte auf false, wenn es dich stört
  debugRay.visible = true;
}

function setHUD(text) {
  const hud = document.getElementById('hud');
  if (hud) hud.querySelector('.small').textContent = text;
}
