// [BATTLESHIP_AR:STEP 2] AR Boot + Hit-Test + echtes Board + Ray-Picking (Hover/Mark)
import * as THREE from 'https://unpkg.com/three@0.166.1/build/three.module.js';
import { ARButton } from 'https://unpkg.com/three@0.166.1/examples/jsm/webxr/ARButton.js';
import { Board } from './board.js';

let scene, camera, renderer;
let reticle, hitTestSource = null, viewerSpace = null;
let board = null;
let referenceSpace = null;
let controller = null;

const raycaster = new THREE.Raycaster();
const tempMatrix = new THREE.Matrix4();

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

  const light = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
  scene.add(light);

  // Retikel
  reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.07, 0.09, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x00ffcc, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
  );
  reticle.matrixAutoUpdate = true;
  reticle.visible = false;
  scene.add(reticle);

  // Controller 0 (linke oder erste Quelle)
  controller = renderer.xr.getController(0);
  controller.addEventListener('select', onSelect);
  scene.add(controller);

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
  // Hit-Test für Retikel, solange kein Board platziert
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

  // Ray-Picking nur wenn Board existiert
  if (board) {
    // Ray aus Controller: Ursprung an Controller-Position, Richtung -Z aus Controller-Rotation
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix).normalize();

    const intersects = raycaster.intersectObject(board.pickingPlane, false);
    if (intersects.length > 0) {
      const p = intersects[0].point;
      const cell = board.worldToCell(p);
      board.setHoverCell(cell);
    } else {
      board.setHoverCell(null);
    }
  }

  renderer.render(scene, camera);
}

// Trigger: Platzieren ODER Markieren
function onSelect() {
  // 1) Falls noch kein Board: platziere an Retikel
  if (!board && reticle.visible) {
    board = new Board({ size: 1.0, divisions: 10 }); // 10x10
    board.position.copy(reticle.position);
    board.quaternion.copy(reticle.quaternion);
    scene.add(board);

    const hud = document.getElementById('hud');
    if (hud) hud.querySelector('.small').textContent = 'Brett platziert. Zielen & Trigger: Zelle markieren/entfernen.';
    return;
  }

  // 2) Wenn Board existiert: Zellen-Toggle
  if (board) {
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    const origin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix).normalize();
    raycaster.set(origin, dir);

    const intersects = raycaster.intersectObject(board.pickingPlane, false);
    if (intersects.length > 0) {
      const p = intersects[0].point;
      const cell = board.worldToCell(p);
      if (cell) {
        const added = board.toggleMarker(cell);
        const hud = document.getElementById('hud');
        if (hud) {
          hud.querySelector('.small').textContent = added
            ? `Markiert: (${cell.i}, ${cell.j})`
            : `Entfernt: (${cell.i}, ${cell.j})`;
        }
      }
    }
  }
}
