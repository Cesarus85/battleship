import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardModel, ShipType } from '../src/model.js';

test('cannot place ships adjacent horizontally', () => {
  const board = new BoardModel();
  const ship = new ShipType('Destroyer', 2);
  assert.strictEqual(board.placeShip(ship, 0, 0, 'h'), true);
  assert.strictEqual(board.canPlaceShip(2, 0, ship.length, 'h'), false);
  assert.strictEqual(board.placeShip(ship, 2, 0, 'h'), false);
});

test('cannot place ships adjacent vertically', () => {
  const board = new BoardModel();
  const ship = new ShipType('Destroyer', 2);
  assert.strictEqual(board.placeShip(ship, 0, 0, 'h'), true);
  assert.strictEqual(board.canPlaceShip(0, 1, ship.length, 'v'), false);
  assert.strictEqual(board.placeShip(ship, 0, 1, 'v'), false);
});

test('cannot place ships adjacent diagonally', () => {
  const board = new BoardModel();
  const ship = new ShipType('Destroyer', 2);
  assert.strictEqual(board.placeShip(ship, 0, 0, 'h'), true);
  assert.strictEqual(board.canPlaceShip(1, 1, ship.length, 'h'), false);
  assert.strictEqual(board.placeShip(ship, 1, 1, 'h'), false);
});
