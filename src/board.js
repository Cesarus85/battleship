// Visual-Board für AR Battleship
// - Unsichtbare pickingPlane (transparent, opacity 0) -> raycastbar
// - Grid-Linien nur auf den Boards (kein separates „Mittelgitter“)
// - Hover-Zelle, Ghost-Schiff, Schiffs-Segmente, Schussmarker

import * as THREE from 'https://unpkg.com/three@0.166.1/build/three.module.js';

export class Board extends THREE.Group {
  constructor({ size = 1.0, divisions = 10 } = {}) {
    super();
    this.size = size;
    this.divisions = divisions;
    this.cellSize = size / divisions;

    // Basis: dünne Platte optional (hier nur Grid-Linien)
    this.add(this._makeGridLines());

    // Picking-Plane: unsichtbar, aber sichtbar=true (sonst kein Raycast)
    const planeGeo = new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2);
    const planeMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.0,
      depthWrite: false
    });
    this.pickingPlane = new THREE.Mesh(planeGeo, planeMat);
    this.pickingPlane.renderOrder = -10;
    this.add(this.pickingPlane);

    // Layer: Hover / Ghost / Ships / Shots
    this.hoverMesh = this._makeCellQuad(0x22ccff, 0.25);
    this.hoverMesh.visible = false;
    this.add(this.hoverMesh);

    this.ghostGroup = new THREE.Group();
    this.add(this.ghostGroup);

    this.shipsGroup = new THREE.Group();
    this.add(this.shipsGroup);

    this.shotsGroup = new THREE.Group();
    this.add(this.shotsGroup);
  }

  _makeGridLines() {
    const group = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: 0x333a40, transparent: true, opacity: 0.7 });

    const geo = new THREE.BufferGeometry();
    const verts = [];
    const half = this.size / 2;

    // Linien parallel zu X (gehen entlang Z)
    for (let d = 0; d <= this.divisions; d++) {
      const z = -half + d * this.cellSize;
      verts.push(-half, 0.001, z,  half, 0.001, z);
    }
    // Linien parallel zu Z (gehen entlang X)
    for (let d = 0; d <= this.divisions; d++) {
      const x = -half + d * this.cellSize;
      verts.push(x, 0.001, -half, x, 0.001,  half);
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const lines = new THREE.LineSegments(geo, mat);
    group.add(lines);
    return group;
  }

  _makeCellQuad(hex, opacity = 0.35) {
    const geo = new THREE.PlaneGeometry(this.cellSize * 0.98, this.cellSize * 0.98).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity });
    const m = new THREE.Mesh(geo, mat);
    m.position.y = 0.005;
    return m;
  }

  _cellToLocal(i, j) {
    const x = -this.size / 2 + (i + 0.5) * this.cellSize;
    const z = -this.size / 2 + (j + 0.5) * this.cellSize;
    return new THREE.Vector3(x, 0, z);
  }

  worldToCell(worldPoint) {
    const p = worldPoint.clone();
    this.worldToLocal(p);
    const x = p.x + this.size / 2;
    const z = p.z + this.size / 2;
    if (x < 0 || z < 0 || x >= this.size || z >= this.size) return null;

    const i = Math.floor(x / this.cellSize);
    const j = Math.floor(z / this.cellSize);
    if (i < 0 || j < 0 || i >= this.divisions || j >= this.divisions) return null;
    return { i, j };
  }

  setHoverCell(cell) {
    if (!cell) { this.hoverMesh.visible = false; return; }
    this.hoverMesh.position.copy(this._cellToLocal(cell.i, cell.j));
    this.hoverMesh.visible = true;
  }

  showGhost(cells, valid) {
    this.clearGhost();
    const color = valid ? 0x1dd1a1 : 0xd63031;
    for (const c of cells) {
      const quad = this._makeCellQuad(color, valid ? 0.32 : 0.28);
      quad.position.copy(this._cellToLocal(c.i, c.j));
      quad.position.y = 0.006;
      this.ghostGroup.add(quad);
    }
  }

  clearGhost() {
    while (this.ghostGroup.children.length) {
      const m = this.ghostGroup.children.pop();
      m.geometry.dispose();
      m.material.dispose();
    }
  }

  placeShipVisual(cells) {
    for (const c of cells) {
      const quad = this._makeCellQuad(0x2e86de, 0.55);
      quad.position.copy(this._cellToLocal(c.i, c.j));
      quad.position.y = 0.004;
      this.shipsGroup.add(quad);
    }
  }

  addShotMarker(i, j, hit) {
    const r = this.cellSize * 0.08;
    const geo = new THREE.CircleGeometry(r, 16).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: hit ? 0xff4d4d : 0xffffff, transparent: true, opacity: hit ? 0.95 : 0.88 });
    const m = new THREE.Mesh(geo, mat);
    const p = this._cellToLocal(i, j);
    m.position.set(p.x, 0.008, p.z);
    this.shotsGroup.add(m);
  }

  cellsForShip(anchor, length, orientation /* 'H' | 'V' */) {
    const out = [];
    for (let k = 0; k < length; k++) {
      const i = anchor.i + (orientation === 'H' ? k : 0);
      const j = anchor.j + (orientation === 'V' ? k : 0);
      out.push({ i, j });
    }
    return out;
  }

  cellCenterLocal(i, j) {
    return this._cellToLocal(i, j);
  }
}
