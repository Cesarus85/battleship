// [BATTLESHIP_AR:STEP 4] Board: Ghost-Vorschau & Schiffs-Visuals
import * as THREE from 'https://unpkg.com/three@0.166.1/build/three.module.js';

export class Board extends THREE.Group {
  constructor({ size = 1.0, divisions = 10 } = {}) {
    super();
    this.name = 'Board';
    this.userData.type = 'board-10x10';

    this.size = size;
    this.divisions = divisions;
    this.cellSize = size / divisions;

    // Grundfläche
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ color: 0x0a0a12, transparent: true, opacity: 0.9 })
    );
    base.rotateX(-Math.PI / 2);
    base.name = 'base';
    this.add(base);

    // Grid-Linien
    const grid = new THREE.GridHelper(size, divisions, 0x00ffcc, 0x00ffcc);
    grid.material.transparent = true;
    grid.material.opacity = 0.65;
    grid.rotateX(Math.PI / 2);
    grid.name = 'grid';
    this.add(grid);

    // Rand
    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(size + 0.02, size + 0.02)),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })
    );
    border.rotateX(-Math.PI / 2);
    border.name = 'border';
    this.add(border);

    // Unsichtbare Picking-Ebene
    const pickMat = new THREE.MeshBasicMaterial({ visible: false });
    const pickingPlane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), pickMat);
    pickingPlane.rotateX(-Math.PI / 2);
    pickingPlane.name = 'pickingPlane';
    this.pickingPlane = pickingPlane;
    this.add(pickingPlane);

    // Hover-Highlight (einzelne Zelle)
    const hlGeom = new THREE.PlaneGeometry(this.cellSize, this.cellSize);
    const hlMat = new THREE.MeshBasicMaterial({ color: 0x33ffaa, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
    const highlight = new THREE.Mesh(hlGeom, hlMat);
    highlight.rotateX(-Math.PI / 2);
    highlight.position.y = 0.002;
    highlight.visible = false;
    highlight.name = 'highlight';
    this.highlight = highlight;
    this.add(highlight);

    // Ghost-Vorschau & platzierte Schiffe
    this.ghostGroup = new THREE.Group();
    this.ghostGroup.position.y = 0.003;
    this.add(this.ghostGroup);

    this.shipsGroup = new THREE.Group();
    this.shipsGroup.position.y = 0.004;
    this.add(this.shipsGroup);

    // Zellenmarkierungen (aus Step 2 – weiterhin vorhanden)
    this.markers = new Map();
  }

  // World → Cell (i,j) / null wenn außerhalb
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

  // Zellzentrum (i,j) → lokale Position (X,Z)
  cellCenterLocal(i, j) {
    const half = this.size / 2;
    const cx = -half + (i + 0.5) * this.cellSize;
    const cz = -half + (j + 0.5) * this.cellSize;
    return new THREE.Vector3(cx, 0, cz);
  }

  // Hover-Highlight für einzelne Zelle
  setHoverCell(cell) {
    if (!cell) {
      this.highlight.visible = false;
      return;
    }
    const p = this.cellCenterLocal(cell.i, cell.j);
    this.highlight.position.set(p.x, 0.002, p.z);
    this.highlight.visible = true;
  }

  // Markierung auf Zelle toggeln (Test-Feature)
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

  // --- Schritt 4: Ghost-Vorschau & Platzieren ---

  // Liefert die Zellenliste für Start-/Richtung/Länge (ohne Gültigkeitsprüfung)
  cellsForShip(startCell, length, orientation /* 'h' | 'v' */) {
    const arr = [];
    for (let k = 0; k < length; k++) {
      const i = startCell.i + (orientation === 'h' ? k : 0);
      const j = startCell.j + (orientation === 'v' ? k : 0);
      arr.push({ i, j });
    }
    return arr;
  }

  // Zeigt Ghost-Kacheln (grün/rot) – erwartet: cells[] & valid:boolean
  showGhost(cells, valid) {
    this.clearGhost();

    const color = valid ? 0x44ff66 : 0xff5566;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, side: THREE.DoubleSide });

    for (const c of cells) {
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(this.cellSize, this.cellSize), mat);
      quad.rotateX(-Math.PI / 2);
      const p = this.cellCenterLocal(c.i, c.j);
      quad.position.set(p.x, 0, p.z);
      this.ghostGroup.add(quad);
    }
  }
  clearGhost() {
    this.ghostGroup.clear();
  }

  // Dauerhafte Visuals für ein platziertes Schiff
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
}
