'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../js/game.js');

/* Small deterministic generator so failures can be reproduced. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('there are three shapes, each with one cockpit and no repeated squares', () => {
  assert.equal(G.SHAPES.length, 3);
  for (const shape of G.SHAPES) {
    assert.deepEqual(shape.cells[0], [0, 0]);
    const keys = new Set(shape.cells.map((c) => c.join(',')));
    assert.equal(keys.size, shape.cells.length);
  }
});

test('the three shapes stay distinct however they are turned', () => {
  const signature = (shape, dir) =>
    shape.cells.map((c) => G.rotate(c, dir).join(',')).sort().join(' ');
  const seen = new Set();
  for (const shape of G.SHAPES) {
    for (const dir of G.DIRECTIONS) seen.add(signature(shape, dir));
  }
  assert.equal(seen.size, G.SHAPES.length * G.DIRECTIONS.length);
});

test('generated boards hold two aircraft, in bounds and not overlapping', () => {
  const shapeCounts = {};
  const directionCounts = {};
  for (let seed = 1; seed <= 2000; seed++) {
    const game = G.createGame(seeded(seed));
    assert.equal(game.aircraft.length, 2);
    const taken = new Set();
    game.aircraft.forEach((plane, index) => {
      shapeCounts[plane.shape.id] = (shapeCounts[plane.shape.id] || 0) + 1;
      directionCounts[plane.direction] = (directionCounts[plane.direction] || 0) + 1;
      assert.equal(plane.cells.length, plane.shape.cells.length);
      for (const cell of plane.cells) {
        assert.ok(cell.r >= 0 && cell.r < G.SIZE && cell.c >= 0 && cell.c < G.SIZE);
        const key = cell.r + ',' + cell.c;
        assert.ok(!taken.has(key), 'overlap at ' + key + ' (seed ' + seed + ')');
        taken.add(key);
        assert.equal(game.owner[cell.r][cell.c], index);
      }
    });
  }
  // 4000 aircraft over 3 shapes and 4 directions: every option should be common.
  for (const shape of G.SHAPES) assert.ok(shapeCounts[shape.id] > 1100, JSON.stringify(shapeCounts));
  for (const dir of G.DIRECTIONS) assert.ok(directionCounts[dir] > 800, JSON.stringify(directionCounts));
});

test('a miss, a body hit and a repeat shot are scored correctly', () => {
  const game = G.createGame(seeded(7));
  let miss;
  for (let r = 0; r < G.SIZE && !miss; r++) {
    for (let c = 0; c < G.SIZE && !miss; c++) {
      if (game.owner[r][c] === -1) miss = { r, c };
    }
  }
  assert.equal(G.shoot(game, miss.r, miss.c).type, 'miss');
  assert.equal(game.shots, 1);
  assert.equal(G.shoot(game, miss.r, miss.c).type, 'ignored');
  assert.equal(game.shots, 1);

  const body = game.aircraft[0].cells[1];
  assert.equal(G.shoot(game, body.r, body.c).type, 'body');
  assert.equal(game.shots, 2);
  assert.equal(game.remaining, 2);
});

test('a cockpit hit reveals only the cockpit, and two end the game', () => {
  const game = G.createGame(seeded(11));
  const [first, second] = game.aircraft;

  const hit = G.shoot(game, first.head.r, first.head.c);
  assert.equal(hit.type, 'head');
  assert.equal(hit.won, false);
  assert.equal(game.remaining, 1);
  assert.equal(game.state[first.head.r][first.head.c], 'head');

  // The rest of the found aircraft is still hidden and still costs a shot.
  for (const cell of first.cells.slice(1)) {
    assert.equal(game.state[cell.r][cell.c], 'hidden');
  }
  assert.deepEqual(G.uncoverAircraft(game), []);
  const body = first.cells[2];
  assert.equal(G.shoot(game, body.r, body.c).type, 'body');
  assert.equal(game.shots, 2);

  const last = G.shoot(game, second.head.r, second.head.c);
  assert.equal(last.won, true);
  assert.equal(game.over, true);
  assert.equal(game.shots, 3);
  assert.equal(G.shoot(game, 0, 0).type, 'ignored');
});

test('after a win, the rest of both aircraft can be uncovered', () => {
  const game = G.createGame(seeded(23));
  const [first, second] = game.aircraft;
  G.shoot(game, first.head.r, first.head.c);
  G.shoot(game, second.head.r, second.head.c);

  const uncovered = G.uncoverAircraft(game);
  assert.equal(uncovered.length, first.cells.length + second.cells.length - 2);
  for (const plane of game.aircraft) {
    for (const cell of plane.cells.slice(1)) assert.equal(game.state[cell.r][cell.c], 'body');
  }
  assert.equal(game.shots, 2);
});
