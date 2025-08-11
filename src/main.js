// [BATTLESHIP_AR:STEP 1] AR Boot + Retikel + Brett-Platzierung
import * as THREE from 'https://unpkg.com/three@0.166.1/build/three.module.js';
import { ARButton } from 'https://unpkg.com/three@0.166.1/examples/jsm/webxr/ARButton.js';

let scene, camera, renderer;
let reticle, hitTestSource = null, viewerSpace = null;
let board = null; // Dummy-Brett
let referenceSpace = null;
let controller = null;

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

  // Dezentes Licht
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

  // Controller
  controller = renderer.xr.getController(0);
  controller.addEventListener('select', onSelect);
  scene.add(controller);

  // AR-Button (Hit-Test + DOM Overlay)
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
  // Hit-Test-Quelle anfordern
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
  if (frame && hitTestSource && !board) {
    const hitTestResults = frame.getHitTestResults(hitTestSource);
    if (hitTestResults && hitTestResults.length > 0) {
      const hit = hitTestResults[0];
      const pose = hit.getPose(renderer.xr.getReferenceSpace());
      if (pose) {
        reticle.visible = true;
        reticle.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
        // Orientierung flach auf die Fläche legen
        const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
        reticle.quaternion.setFromRotationMatrix(m);
      }
    } else {
      reticle.visible = false;
    }
  }

  renderer.render(scene, camera);
}

// Trigger: Brett platzieren
function onSelect() {
  if (!reticle.visible || board) return;
  board = createDummyBoard();
  board.position.copy(reticle.position);
  board.quaternion.copy(reticle.quaternion);
  scene.add(board);

  // Kleiner Hinweis als „Bestätigung“
  const hud = document.getElementById('hud');
  if (hud) hud.querySelector('.small').textContent = 'Brett platziert. (Step 1 abgeschlossen)';
}

// Einfaches 1m x 1m Dummy-Brett mit Grid-Linien
function createDummyBoard() {
  const group = new THREE.Group();

  // Grundfläche
  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0x0a0a12, transparent: true, opacity: 0.9 })
  );
  base.rotateX(-Math.PI / 2);
  group.add(base);

  // Grid-Linien (10x10)
  const divisions = 10;
  const size = 1;
  const grid = new THREE.GridHelper(size, divisions, 0x00ffcc, 0x00ffcc);
  grid.material.opacity = 0.65;
  grid.material.transparent = true;
  grid.rotateX(Math.PI / 2); // GridHelper steht vertikal, drehen für Boden
  group.add(grid);

  // Leichter Rand
  const border = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(1.02, 1.02)),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })
  );
  border.rotateX(-Math.PI / 2);
  group.add(border);

  // Marker-Tag
  group.userData.type = 'dummy-board'; // [BATTLESHIP_AR:STEP 1]
  return group;
}
