// [BATTLESHIP_AR:STEP 3] Model: Zellen, Schiffe, Board-Logik

export const CELL = {
  Empty: 0,
  Ship: 1,
  Hit: 2,
  Miss: 3,
};

export class ShipType {
  constructor(name, length, count = 1) {
    this.name = name;
    this.length = length;
    this.count = count;
  }
}

// Klassische Flotte (kannst du später anpassen)
export const DEFAULT_FLEET = [
  new ShipType('Schlachtschiff', 4, 1), // 1×4
  new ShipType('Kreuzer',       3, 2), // 2×3
  new ShipType('Zerstörer',     2, 3), // 3×2
  new ShipType('U-Boot',        1, 4), // 4×1
];

export class BoardModel {
  constructor(size = 10) {
    this.size = size;
    this.grid = Array.from({ length: size }, () => new Array(size).fill(CELL.Empty));
    // Liste der platzierten Schiffe: {type, cells:[{i,j}], hits:Set('i,j')}
    this.ships = [];
    this.totalShipCells = 0;
    this.totalHits = 0;
  }

  inBounds(i, j) {
    return i >= 0 && i < this.size && j >= 0 && j < this.size;
  }

  // Prüfen, ob ein Schiff ab Start (i,j) in Richtung dir ('h' | 'v') passt
  canPlaceShip(i, j, length, dir = 'h') {
    for (let k = 0; k < length; k++) {
      const ii = i + (dir === 'h' ? k : 0);
      const jj = j + (dir === 'v' ? k : 0);
      if (!this.inBounds(ii, jj)) return false;

      // Prüfe Zelle sowie alle Nachbarn (inkl. Diagonalen) auf Leerheit
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const ni = ii + di;
          const nj = jj + dj;
          if (!this.inBounds(ni, nj)) continue;
          if (this.grid[nj][ni] !== CELL.Empty) return false;
        }
      }
    }
    return true;
  }

  // Schiff platzieren (ohne Visuals – reine Logik)
  placeShip(type, i, j, dir = 'h') {
    if (!this.canPlaceShip(i, j, type.length, dir)) return false;
    const cells = [];
    for (let k = 0; k < type.length; k++) {
      const ii = i + (dir === 'h' ? k : 0);
      const jj = j + (dir === 'v' ? k : 0);
      this.grid[jj][ii] = CELL.Ship;
      cells.push({ i: ii, j: jj });
    }
    this.ships.push({ type, cells, hits: new Set() });
    this.totalShipCells += type.length;
    return true;
  }

  // Schuss abgeben – gibt Ergebnis zurück
  shoot(i, j) {
    if (!this.inBounds(i, j)) return { ok: false, repeat: false, result: 'out' };

    const cell = this.grid[j][i];
    if (cell === CELL.Hit || cell === CELL.Miss) {
      return { ok: false, repeat: true, result: 'repeat' }; // bereits beschossen
    }

    if (cell === CELL.Ship) {
      this.grid[j][i] = CELL.Hit;
      this.totalHits++;
      // markiere Treffer auf dem betroffenen Schiff
      const ship = this.ships.find(s =>
        s.cells.some(c => c.i === i && c.j === j)
      );
      if (ship) {
        ship.hits.add(`${i},${j}`);
        const sunk = ship.hits.size === ship.type.length;
        const gameOver = this.totalHits === this.totalShipCells;
        return { ok: true, result: sunk ? 'sunk' : 'hit', sunk, gameOver, ship };
      }
      // sollte nie passieren – defensiv:
      return { ok: true, result: 'hit', sunk: false, gameOver: this.totalHits === this.totalShipCells };
    }

    // Wasser
    this.grid[j][i] = CELL.Miss;
    return { ok: true, result: 'miss', sunk: false, gameOver: false };
  }
}
