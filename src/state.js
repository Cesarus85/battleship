// [BATTLESHIP_AR:STEP 8] KI: Hunt/Target + Parität (smart shooting)
import { BoardModel, DEFAULT_FLEET, CELL } from './model.js';

export const PHASE = {
  INIT: 'INIT',
  PLACE_PLAYER: 'PLACE_PLAYER',
  PLACE_AI: 'PLACE_AI',
  PLAYER_TURN: 'PLAYER_TURN',
  AI_TURN: 'AI_TURN',
  GAME_OVER: 'GAME_OVER',
};

export class GameState {
  constructor() {
    this.phase = PHASE.INIT;

    this.player = {
      board: new BoardModel(10),
      fleet: expandFleet(DEFAULT_FLEET),
      nextShipIndex: 0,
      orientation: 'h',
    };

    this.ai = {
      board: new BoardModel(10),
      fleet: expandFleet(DEFAULT_FLEET),
    };

    // KI-Gedächtnis für gegnerische (Spieler-)Flotte
    this.aiMemory = {
      mode: 'hunt',                        // 'hunt' | 'target'
      hits: [],                            // laufender Treffer-Cluster [{i,j}]
      orientation: null,                   // null | 'h' | 'v'
      frontier: new Set(),                 // Kandidaten im Target-Modus (Keys "i,j")
      remainingLengths: flattenFleetLengths(DEFAULT_FLEET), // z.B. [4,3,3,2,2,2,1,1,1,1]
      parity: 2,                           // 2 solange minLength>=2, sonst 1
    };
    this.aiMemory.parity = computeParity(this.aiMemory.remainingLengths);

    this.winner = null;
  }

  beginPlacement() { this.phase = PHASE.PLACE_PLAYER; }
  toggleOrientation() {
    this.player.orientation = this.player.orientation === 'h' ? 'v' : 'h';
    return this.player.orientation;
  }

  tryPlaceNextPlayerShip(i, j) {
    if (this.phase !== PHASE.PLACE_PLAYER) return { ok: false, reason: 'wrong_phase' };
    const shipType = this.player.fleet[this.player.nextShipIndex];
    if (!shipType) return { ok: false, reason: 'no_more_ships' };
    const ok = this.player.board.placeShip(shipType, i, j, this.player.orientation);
    if (!ok) return { ok: false, reason: 'invalid_position' };

    this.player.nextShipIndex++;
    if (this.player.nextShipIndex >= this.player.fleet.length) this.phase = PHASE.PLACE_AI;
    return { ok: true, shipType, placedAll: this.phase === PHASE.PLACE_AI };
  }

  // KI platziert ihre Flotte zufällig (regelkonform)
  aiPlaceFleetRandom() {
    if (this.phase !== PHASE.PLACE_AI) return { ok: false, reason: 'wrong_phase' };
    for (const type of this.ai.fleet) {
      let placed = false, safety = 0;
      while (!placed && safety++ < 500) {
        const dir = Math.random() < 0.5 ? 'h' : 'v';
        const maxI = dir === 'h' ? this.ai.board.size - type.length : this.ai.board.size - 1;
        const maxJ = dir === 'v' ? this.ai.board.size - type.length : this.ai.board.size - 1;
        const i = Math.floor(Math.random() * (maxI + 1));
        const j = Math.floor(Math.random() * (maxJ + 1));
        placed = this.ai.board.placeShip(type, i, j, dir);
      }
      if (!placed) return { ok: false, reason: 'placement_failed' };
    }
    this.phase = PHASE.PLAYER_TURN;
    return { ok: true };
  }

  // --- Spieler schießt auf KI-Board (unverändert) ---
  playerShoot(i, j) {
    if (this.phase !== PHASE.PLAYER_TURN) return { ok: false, reason: 'wrong_phase' };
    const res = this.ai.board.shoot(i, j);
    if (!res.ok) return res;

    if (res.gameOver) { this.phase = PHASE.GAME_OVER; this.winner = 'player'; }
    else { this.phase = PHASE.AI_TURN; }

    return res;
  }

  // --- NEU: Smarte KI ---
  // Behalte Signatur von aiShootRandom() für Abwärtskompatibilität (Step 6/7 rufen das auf)
  aiShootRandom() { return this.aiShootSmart(); }

  aiShootSmart() {
    if (this.phase !== PHASE.AI_TURN) return { ok: false, reason: 'wrong_phase' };

    // 1) Zielzelle wählen
    const target = this.chooseAiTargetCell();
    if (!target) {
      // Fallback: irgendeine unbeschossene Zelle (sollte selten vorkommen)
      const any = pickAnyUnshot(this.player.board);
      if (!any) { this.phase = PHASE.GAME_OVER; this.winner = 'ai'; return { ok: false, reason: 'no_targets' }; }
      target = any;
    }

    // 2) Schuss abgeben
    const res = this.player.board.shoot(target.i, target.j);

    // 3) Ergebnis verarbeiten
    this.updateAiMemoryAfterShot(target, res);

    // 4) Phase/Winner
    if (res.gameOver) { this.phase = PHASE.GAME_OVER; this.winner = 'ai'; }
    else { this.phase = PHASE.PLAYER_TURN; }

    return { ok: true, cell: target, ...res };
  }

  chooseAiTargetCell() {
    // Target-Modus: fortsetzen
    if (this.aiMemory.mode === 'target') {
      const c = chooseTargetCell(this.player.board, this.aiMemory);
      if (c) return c;
      // kein valider Kandidat mehr -> zurück in Hunt
      resetToHunt(this.aiMemory);
    }

    // Hunt-Modus: Paritätsfeld wählen
    return chooseHuntCell(this.player.board, this.aiMemory.parity);
  }

  updateAiMemoryAfterShot(cell, res) {
    const mem = this.aiMemory;

    // Treffer-Logik
    if (res.result === 'hit' || res.result === 'sunk') {
      if (mem.mode === 'hunt') {
        // Wechsel in Target-Modus, Nachbarn vormerken
        mem.mode = 'target';
        mem.hits = [cell];
        mem.orientation = null;
        mem.frontier = new Set();
        pushNeighbors(cell, this.player.board, mem.frontier);
      } else {
        // Target-Modus: erweitere Treffer-Cluster
        mem.hits.push(cell);

        // Orientierung ermitteln, sobald mind. 2 Hits in Linie
        if (!mem.orientation && mem.hits.length >= 2) {
          const a = mem.hits[0], b = mem.hits[1];
          if (a.i === b.i) mem.orientation = 'v';
          else if (a.j === b.j) mem.orientation = 'h';
          // falls diagonal (eigentlich nicht möglich), bleibt null
        }

        // Wenn noch keine Orientierung: Nachbarn dieses Treffers ergänzen
        if (!mem.orientation) {
          pushNeighbors(cell, this.player.board, mem.frontier);
        }
      }

      // Versenkt? -> zurück zu Hunt, Parität anpassen
      if (res.sunk && res.ship && res.ship.type && res.ship.type.length) {
        removeOneLength(mem.remainingLengths, res.ship.type.length);
        mem.parity = computeParity(mem.remainingLengths);
        resetToHunt(mem);
      }
    }

    // Wasser: im Target-Modus einfach weitermachen – die Miss-Zelle wird durch grid=MISs ohnehin ausgeschlossen.
    // Wenn Target-Modus aber „festgefahren“ ist (keine gültigen Kandidaten mehr), entscheidet chooseAiTargetCell das beim nächsten Zug.
  }
}

/* ------------------------- Hilfsfunktionen (KI) ------------------------- */

// Erzeuge eine Liste aus Schifflängen (z. B. [4,3,3,2,2,2,1,1,1,1])
function flattenFleetLengths(fleetDef) {
  const out = [];
  for (const t of fleetDef) for (let k = 0; k < t.count; k++) out.push(t.length);
  return out;
}

function computeParity(remainingLengths) {
  const minLen = Math.min(...remainingLengths);
  // klassisch: solange minLen >= 2 nutzen wir Parität 2 (Schachbrett),
  // bei nur noch 1er-Schiffen Parität 1 (alle Zellen erlaubt)
  return minLen >= 2 ? 2 : 1;
}

function removeOneLength(arr, len) {
  const idx = arr.indexOf(len);
  if (idx >= 0) arr.splice(idx, 1);
}

function pickAnyUnshot(board) {
  const candidates = [];
  for (let j = 0; j < board.size; j++) {
    for (let i = 0; i < board.size; i++) {
      const c = board.grid[j][i];
      if (c !== CELL.Hit && c !== CELL.Miss) candidates.push({ i, j });
    }
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/* --- Hunt-Modus --- */
function chooseHuntCell(board, parity) {
  const cand = [];
  for (let j = 0; j < board.size; j++) {
    for (let i = 0; i < board.size; i++) {
      // unbeschossen?
      const g = board.grid[j][i];
      if (g === CELL.Hit || g === CELL.Miss) continue;
      // Paritätstest
      if (parity === 1 || ((i + j) % parity === 0)) {
        cand.push({ i, j });
      }
    }
  }
  if (!cand.length) return pickAnyUnshot(board);
  return cand[Math.floor(Math.random() * cand.length)];
}

/* --- Target-Modus --- */
function chooseTargetCell(board, mem) {
  // Wenn Orientierung unbekannt: aus Frontier (Nachbarn) wählen
  if (!mem.orientation) {
    // Hole das erste valide Frontier-Feld (FIFO/ beliebig)
    for (const key of mem.frontier) {
      const [i, j] = key.split(',').map(n => parseInt(n, 10));
      const c = board.grid[j][i];
      if (c !== CELL.Hit && c !== CELL.Miss) {
        mem.frontier.delete(key);
        return { i, j };
      } else {
        mem.frontier.delete(key); // aufräumen
      }
    }
    return null; // nichts Brauchbares mehr
  }

  // Orientierung bekannt: Endpunkte entlang der Linie erweitern
  const hits = mem.hits.slice().sort((a, b) => (mem.orientation === 'h' ? a.i - b.i : a.j - b.j));
  if (!hits.length) return null;

  if (mem.orientation === 'h') {
    const j = hits[0].j;
    const minI = hits[0].i, maxI = hits[hits.length - 1].i;
    const left = { i: minI - 1, j };
    const right = { i: maxI + 1, j };

    const opts = [];
    if (inBounds(board, left)  && unshot(board, left))  opts.push(left);
    if (inBounds(board, right) && unshot(board, right)) opts.push(right);

    if (!opts.length) return null;
    return opts[Math.floor(Math.random() * opts.length)];
  } else {
    // 'v'
    const i = hits[0].i;
    const minJ = hits[0].j, maxJ = hits[hits.length - 1].j;
    const up = { i, j: minJ - 1 };
    const down = { i, j: maxJ + 1 };

    const opts = [];
    if (inBounds(board, up)   && unshot(board, up))   opts.push(up);
    if (inBounds(board, down) && unshot(board, down)) opts.push(down);

    if (!opts.length) return null;
    return opts[Math.floor(Math.random() * opts.length)];
  }
}

function resetToHunt(mem) {
  mem.mode = 'hunt';
  mem.hits = [];
  mem.orientation = null;
  mem.frontier.clear?.();
}

function inBounds(board, cell) {
  return board.inBounds(cell.i, cell.j);
}
function unshot(board, cell) {
  const v = board.grid[cell.j][cell.i];
  return v !== CELL.Hit && v !== CELL.Miss;
}

function pushNeighbors(cell, board, frontierSet) {
  const neigh = [
    { i: cell.i + 1, j: cell.j },
    { i: cell.i - 1, j: cell.j },
    { i: cell.i,     j: cell.j + 1 },
    { i: cell.i,     j: cell.j - 1 },
  ];
  for (const n of neigh) {
    if (!inBounds(board, n)) continue;
    if (!unshot(board, n)) continue;
    frontierSet.add(`${n.i},${n.j}`);
  }
}

/* ------------------------- Utilities ------------------------- */

function expandFleet(fleetDef) {
  const result = [];
  for (const t of fleetDef) for (let k = 0; k < t.count; k++)
    result.push(new (t.constructor)(t.name, t.length, 1));
  return result;
}
