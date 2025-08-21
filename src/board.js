// [BATTLESHIP_AR:STEP 5 PATCH] Board: Ghost klar sichtbar (mit Outline), höher gelegt
import * as THREE from 'https://unpkg.com/three@0.166.1/build/three.module.js';

export class Board extends THREE.Group {
  constructor({ size = 1.0, divisions = 10 } = {}) {
    super();
    this.name = 'Board';
    this.userData.type = 'board-10x10';

    this.size = size;
    this.divisions = divisions;
    this.cellSize = size / divisions;

    // Basis
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ color: 0x0a0a12, transparent: true, opacity: 0.9 })
    );
    base.rotateX(-Math.PI / 2);
    this.add(base);

    const grid = new THREE.GridHelper(size, divisions, 0x00ffcc, 0x00ffcc);
    grid.material.transparent = true;
    grid.material.opacity = 0.65;
    grid.rotateX(Math.PI / 2);
    this.add(grid);

    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(size + 0.02, size + 0.02)),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })
    );
    border.rotateX(-Math.PI / 2);
    this.add(border);

    // Picking
    const pickingPlane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ visible: false }));
    pickingPlane.rotateX(-Math.PI / 2);
    this.pickingPlane = pickingPlane;
    this.add(pickingPlane);

    // Einzel-Highlight (nur für Hover außerhalb Platzierung)
    const hlGeom = new THREE.PlaneGeometry(this.cellSize, this.cellSize);
    const hlMat = new THREE.MeshBasicMaterial({ color: 0x33ffaa, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
    const highlight = new THREE.Mesh(hlGeom, hlMat);
    highlight.rotateX(-Math.PI / 2);
    highlight.position.y = 0.002;
    highlight.visible = false;
    this.highlight = highlight;
    this.add(highlight);

    // Ghost & Visuals
    this.ghostGroup = new THREE.Group();
    this.ghostGroup.position.y = 0.010; // höher als Highlight -> immer sichtbar
    this.add(this.ghostGroup);

    this.shipsGroup = new THREE.Group();
    this.shipsGroup.position.y = 0.012;
    this.add(this.shipsGroup);

    this.shotsGroup = new THREE.Group();
    this.shotsGroup.position.y = 0.014;
    this.add(this.shotsGroup);

    // Testpins (Step 2)
    this.markers = new Map();
  }

  worldToCell(worldPoint) {
    const local = worldPoint.clone();
    this.worldToLocal(local);
    const half = this.size / 2;
    const x = THREE.MathUtils.clamp(local.x, -half, half - 1e-6);
    const z = THREE.MathUtils.clamp(local.z, -half, half - 1e-6);
    const i = Math.floor((x + half) / this.cellSize);
    const j = Math.floor((z + half) / this.cellSize);
    if (i < 0 || i >= this.divisions || j < 0 || j >= this.divisions) return null;
    return { i, j };
  }

  cellCenterLocal(i, j) {
    const half = this.size / 2;
    const cx = -half + (i + 0.5) * this.cellSize;
    const cz = -half + (j + 0.5) * this.cellSize;
    return new THREE.Vector3(cx, 0, cz);
  }

  setHoverCell(cell) {
    if (!cell) { this.highlight.visible = false; return; }
    const p = this.cellCenterLocal(cell.i, cell.j);
    this.highlight.position.set(p.x, 0.002, p.z);
    this.highlight.visible = true;
  }

  toggleMarker(cell) {
    const key = `${cell.i},${cell.j}`;
    if (this.markers.has(key)) {
      const m = this.markers.get(key);
      this.remove(m);
      this.markers.delete(key);
      return false;
    } else {
      const marker = this.createMarkerMesh();
      const p = this.cellCenterLocal(cell.i, cell.j);
      marker.position.set(p.x, 0.01, p.z);
      this.add(marker);
      this.markers.set(key, marker);
      return true;
    }
  }
  createMarkerMesh() {
    const g = new THREE.CylinderGeometry(0.015, 0.015, 0.02, 16);
    const m = new THREE.MeshBasicMaterial({ color: 0xff3355 });
    const mesh = new THREE.Mesh(g, m);
    mesh.name = 'cellMarker';
    return mesh;
  }

  // --- Ghost & Schiffe ---
  cellsForShip(startCell, length, orientation) {
    const arr = [];
    for (let k = 0; k < length; k++) {
      const i = startCell.i + (orientation === 'h' ? k : 0);
      const j = startCell.j + (orientation === 'v' ? k : 0);
      arr.push({ i, j });
    }
    return arr;
  }

  showGhost(cells, valid) {
    this.clearGhost();

    // Deutlichere Ghost-Kacheln
    const fillMat = new THREE.MeshBasicMaterial({
      color: valid ? 0x00ff66 : 0xff3366,
      transparent: true,
      opacity: 0.40,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9
    });

    for (const c of cells) {
      const p = this.cellCenterLocal(c.i, c.j);

      const quad = new THREE.Mesh(new THREE.PlaneGeometry(this.cellSize, this.cellSize), fillMat);
      quad.rotateX(-Math.PI / 2);
      quad.position.set(p.x, 0, p.z);
      this.ghostGroup.add(quad);

      // Umrandung je Kachel
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(this.cellSize, this.cellSize)),
        edgeMat
      );
      edges.rotateX(-Math.PI / 2);
      edges.position.set(p.x, 0.0002, p.z);
      this.ghostGroup.add(edges);
    }
  }

  clearGhost() {
    for (const child of this.ghostGroup.children) {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
        else child.material.dispose();
      }
    }
    this.ghostGroup.clear();
  }

  placeShipVisual(cells) {
    const mat = new THREE.MeshBasicMaterial({ color: 0x3399ff, transparent: true, opacity: 0.65, side: THREE.DoubleSide });
    for (const c of cells) {
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(this.cellSize, this.cellSize), mat);
      quad.rotateX(-Math.PI / 2);
      const p = this.cellCenterLocal(c.i, c.j);
      quad.position.set(p.x, 0, p.z);
      this.shipsGroup.add(quad);
    }
  }

  addShotMarker(i, j, isHit) {
    const p = this.cellCenterLocal(i, j);
    if (isHit) {
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(this.cellSize * 0.28, 24).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xff4444, transparent: true, opacity: 0.95 })
      );
      m.position.set(p.x, 0, p.z);
      this.shotsGroup.add(m);
    } else {
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(this.cellSize * 0.16, 16).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
      );
      m.position.set(p.x, 0, p.z);
      this.shotsGroup.add(m);
    }
  }

  // Kurze Versenk-Animation pro Zellposition
  animateSunkShip(cells) {
    for (const c of cells) {
      const p = this.cellCenterLocal(c.i, c.j);
      const quad = new THREE.Mesh(
        new THREE.PlaneGeometry(this.cellSize, this.cellSize),
        new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.8, side: THREE.DoubleSide })
      );
      quad.rotateX(-Math.PI / 2);
      quad.position.set(p.x, 0.001, p.z);
      this.add(quad);

      const start = performance.now();
      const duration = 300;
      const animate = (now) => {
        const k = (now - start) / duration;
        if (k < 1) {
          const s = 1 + k * 0.5;
          quad.scale.set(s, s, s);
          quad.material.opacity = 0.8 * (1 - k);
          requestAnimationFrame(animate);
        } else {
          this.remove(quad);
          quad.geometry.dispose();
          quad.material.dispose();
        }
      };
      requestAnimationFrame(animate);
    }
  }
}
