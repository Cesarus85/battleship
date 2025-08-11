// [BATTLESHIP_AR:STEP 3] State Machine & GameState
import { BoardModel, DEFAULT_FLEET } from './model.js';

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
      // geplante Schiffsliste für Platzierung
      fleet: expandFleet(DEFAULT_FLEET),
      nextShipIndex: 0,
      orientation: 'h', // 'h' oder 'v'
    };

    this.ai = {
      board: new BoardModel(10),
      fleet: expandFleet(DEFAULT_FLEET),
    };

    this.winner = null; // 'player' | 'ai'
  }

  // Aufruf, nachdem das physische AR-Board platziert wurde
  beginPlacement() {
    this.phase = PHASE.PLACE_PLAYER;
  }

  // Wechselt die Orientierung für das nächste zu platzierende Schiff
  toggleOrientation() {
    this.player.orientation = this.player.orientation === 'h' ? 'v' : 'h';
    return this.player.orientation;
  }

  // Noch keine visuelle Platzierung – reine Logik (Schritt 4 nutzt das)
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

  // KI-Platzierung (kommt in Schritt 5 „richtig“ – hier nur Stub/Platzhalter)
  aiPlaceFleetRandomStub() {
    // Wir schieben das auf Schritt 5 – hier nur Phase weiterschalten.
    this.phase = PHASE.PLAYER_TURN;
  }

  // Spieler schießt auf KI-Board (Logik vorhanden – UI ab Schritt 6)
  playerShoot(i, j) {
    if (this.phase !== PHASE.PLAYER_TURN) return { ok: false, reason: 'wrong_phase' };
    const res = this.ai.board.shoot(i, j);
    if (!res.ok) return res;

    if (res.gameOver) {
      this.phase = PHASE.GAME_OVER;
      this.winner = 'player';
      return res;
    }
    // Wechsel der Runde nur bei miss oder versenkt? (variiert je nach Regel)
    if (res.result === 'miss' || res.result === 'sunk') {
      this.phase = PHASE.AI_TURN;
    }
    return res;
  }

  // KI-Schuss (kommt in Schritt 5)
  aiShootRandomStub() {
    // Placeholder: direkt zurück zum Spieler
    this.phase = PHASE.PLAYER_TURN;
  }
}

// Hilfsfunktion: Flottenliste auf einzelne Einträge expandieren
function expandFleet(fleetDef) {
  const result = [];
  for (const t of fleetDef) {
    for (let k = 0; k < t.count; k++) {
      result.push(new (t.constructor)(t.name, t.length, 1));
    }
  }
  return result;
}
