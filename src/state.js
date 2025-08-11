// [BATTLESHIP_AR:STEP 5] State: KI-Platzierung & KI-Schüsse
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

    this.winner = null;
  }

  beginPlacement() {
    this.phase = PHASE.PLACE_PLAYER;
  }

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
    if (this.player.nextShipIndex >= this.player.fleet.length) {
      this.phase = PHASE.PLACE_AI;
    }
    return { ok: true, shipType, placedAll: this.phase === PHASE.PLACE_AI };
  }

  // --- NEU in Step 5: KI zufällig platzieren ---
  aiPlaceFleetRandom() {
    if (this.phase !== PHASE.PLACE_AI) return { ok: false, reason: 'wrong_phase' };
    for (const type of this.ai.fleet) {
      let placed = false;
      let safety = 0;
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

  // --- NEU in Step 5: KI schießt zufällig (keine Wiederholung) ---
  aiShootRandom() {
    if (this.phase !== PHASE.AI_TURN && this.phase !== PHASE.PLAYER_TURN) {
      return { ok: false, reason: 'wrong_phase' };
    }

    // Ziel: eine unbeschossene Zelle auf dem Spieler-Board finden
    const candidates = [];
    for (let j = 0; j < this.player.board.size; j++) {
      for (let i = 0; i < this.player.board.size; i++) {
        const c = this.player.board.grid[j][i];
        if (c !== CELL.Hit && c !== CELL.Miss) candidates.push({ i, j });
      }
    }
    if (candidates.length === 0) {
      this.phase = PHASE.GAME_OVER;
      this.winner = 'ai';
      return { ok: false, reason: 'no_targets' };
    }

    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const res = this.player.board.shoot(pick.i, pick.j); // nutzt Model-Logik

    if (res.gameOver) {
      this.phase = PHASE.GAME_OVER;
      this.winner = 'ai';
    } else {
      // einfache Regel: nach jedem KI-Schuss ist wieder der Spieler dran
      this.phase = PHASE.PLAYER_TURN;
    }
    return { ok: true, cell: pick, ...res };
  }
}

function expandFleet(fleetDef) {
  const result = [];
  for (const t of fleetDef) {
    for (let k = 0; k < t.count; k++) {
      result.push(new (t.constructor)(t.name, t.length, 1));
    }
  }
  return result;
}
