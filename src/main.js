// [BATTLESHIP_AR:STEP 2 FIX v2] Stabiler XR-Ray (Quaternion), Caching der Hover-Zelle, robustes Select
import * as THREE from 'https://unpkg.com/three@0.166.1/build/three.module.js';
import { ARButton } from 'https://unpkg.com/three@0.166.1/examples/jsm/webxr/ARButton.js';
import { Board } from './board.js';

let scene, camera, renderer;
let reticle, hitTestSource = null, viewerSpace = null;
let referenceSpace = null;
let board = null;

const controllers = [];
const raycaster = new THREE.Raycaster();

let lastHoverCell = null;
let lastIntersectPoint = null;

let debugRay = null;
let debugDot = null;

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
    c.addEventListener('disconnected', () => { delete c.userData.inputSource; });
    c.addEventListener('select', onSelect);
    scene.add(c);
    controllers.push(c);
  }

  // Debug-Ray (sichtbare Linie)
  const rayGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0,0,-0.8)]);
  debugRay = new THREE.Line(rayGeom, new THREE.LineBasicMaterial({ transparent:true, opacity:0.7 }));
  debugRay.visible = true; // auf false stellen, wenn es stört
  scene.add(debugRay);

  // Debug-Dot für Intersection
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
  // Hit-Test/Retikel solange kein Board
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

  // Hover/Intersection nur wenn Board existiert
  if (board && referenceSpace && frame) {
    const ray = getXRRay(frame); // {origin, direction}
    if (ray) {
      raycaster.set(ray.origin, ray.direction);

      // Debug-Ray aktualisieren
      updateDebugRay(ray.origin, ray.direction);

      const hit = raycaster.intersectObject(board.pickingPlane, false)[0];
      if (hit) {
        lastIntersectPoint = hit.point;
        const cell = board.worldToCell(hit.point);
        lastHoverCell = cell || null;
        board.setHoverCell(lastHoverCell);
        // Debug-Dot
        debugDot.position.copy(hit.point);
        debugDot.visible = true;
      } else {
        lastIntersectPoint = null;
        lastHoverCell = null;
        board.setHoverCell(null);
        debugDot.visible = false;
      }
    } else {
      lastIntersectPoint = null;
      lastHoverCell = null;
      board.setHoverCell(null);
      debugDot.visible = false;
      debugRay.visible = false;
    }
  }

  renderer.render(scene, camera);
}

// XR-Ray robust aus InputSource-Quaternion oder Fallback Kamera
function getXRRay(frame) {
  const session = renderer.xr.getSession();
  if (!session || !referenceSpace) return null;

  // 1) Bevorzuge Controller mit tracked-pointer ODER screen
  for (const c of controllers) {
    const src = c.userData.inputSource;
    if (!src) continue;

    const space = src.targetRaySpace;
    const pose = frame.getPose(space, referenceSpace);
    if (pose) {
      const { position, orientation } = pose.transform;
      const origin = new THREE.Vector3(position.x, position.y, position.z);
      // Richtung = -Z, rotiert durch Orientierung
      const q = new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w);
      const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize();
      return { origin, direction };
    }
  }

  // 2) Fallback: Kamera-Vorwärts (Gaze)
  const cam = renderer.xr.getCamera(camera);
  const origin = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const direction = new THREE.Vector3(0, 0, -1).applyMatrix4(new THREE.Matrix4().extractRotation(cam.matrixWorld)).normalize();
  return { origin, direction };
}

function updateDebugRay(origin, direction) {
  const arr = debugRay.geometry.attributes.position.array;
  arr[0] = origin.x; arr[1] = origin.y; arr[2] = origin.z;
  const end = new THREE.Vector3().copy(direction).multiplyScalar(0.9).add(origin);
  arr[3] = end.x; arr[4] = end.y; arr[5] = end.z;
  debugRay.geometry.attributes.position.needsUpdate = true;
  debugRay.visible = true;
}

function onSelect() {
  // 1) Board platzieren
  if (!board && reticle.visible) {
    board = new Board({ size: 1.0, divisions: 10 });
    board.position.copy(reticle.position);
    board.quaternion.copy(reticle.quaternion);
    scene.add(board);
    setHUD('Brett platziert. Ziele auf eine Zelle und drücke Trigger, um zu toggeln.');
    return;
  }

  // 2) Zelle toggeln – benutze die im Render-Loop berechnete Hover-Zelle
  if (board && lastHoverCell) {
    const added = board.toggleMarker(lastHoverCell);
    setHUD(added
      ? `Markiert: (${lastHoverCell.i}, ${lastHoverCell.j})`
      : `Entfernt: (${lastHoverCell.i}, ${lastHoverCell.j})`);
  }
}

function setHUD(text) {
  const hud = document.getElementById('hud');
  if (hud) hud.querySelector('.small').textContent = text;
}
