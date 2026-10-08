/*
 * Find Aircraft: game rules, with no DOM access so they can be tested in Node.
 * Loaded as a classic script in the browser (window.FindAircraft) and as a
 * CommonJS module in tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FindAircraft = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SIZE = 10;
  const AIRCRAFT_COUNT = 2;
  const DIRECTIONS = ['up', 'right', 'down', 'left'];

  /*
   * Each shape is a list of [row, column] offsets from the cockpit, drawn with
   * the nose pointing up. The first offset is always the cockpit itself.
   */
  const SHAPES = [
    {
      id: 'classic',
      name: 'Classic',
      cells: [
        [0, 0],
        [1, -2], [1, -1], [1, 0], [1, 1], [1, 2],
        [2, 0],
        [3, -1], [3, 0], [3, 1],
      ],
    },
    {
      id: 'delta',
      name: 'Delta',
      cells: [
        [0, 0],
        [1, -1], [1, 0], [1, 1],
        [2, -2], [2, -1], [2, 0], [2, 1], [2, 2],
        [3, 0],
      ],
    },
    {
      id: 'airliner',
      name: 'Airliner',
      cells: [
        [0, 0],
        [1, 0],
        [2, -2], [2, -1], [2, 0], [2, 1], [2, 2],
        [3, 0],
        [4, -1], [4, 0], [4, 1],
      ],
    },
  ];

  /* Turn an offset drawn nose-up so the nose points in `direction`. */
  function rotate(offset, direction) {
    const r = offset[0];
    const c = offset[1];
    switch (direction) {
      case 'up': return [r, c];
      case 'right': return [c, -r];
      case 'down': return [-r, -c];
      case 'left': return [-c, r];
      default: throw new Error('Unknown direction: ' + direction);
    }
  }

  function inBounds(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  /* Every way `shape` fits on the board without touching an occupied square. */
  function placements(shape, occupied) {
    const found = [];
    for (const direction of DIRECTIONS) {
      const offsets = shape.cells.map((cell) => rotate(cell, direction));
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          const cells = offsets.map((o) => ({ r: r + o[0], c: c + o[1] }));
          const fits = cells.every(
            (cell) => inBounds(cell.r, cell.c) && !occupied[cell.r][cell.c]
          );
          if (fits) found.push({ direction, cells });
        }
      }
    }
    return found;
  }

  function pick(list, rng) {
    return list[Math.floor(rng() * list.length)];
  }

  function emptyGrid(value) {
    return Array.from({ length: SIZE }, () => Array(SIZE).fill(value));
  }

  /*
   * Start a game. Each aircraft draws its shape independently and uniformly
   * from SHAPES, then a position uniformly from the places that shape fits.
   */
  function createGame(rng) {
    rng = rng || Math.random;
    for (let attempt = 0; attempt < 100; attempt++) {
      const owner = emptyGrid(-1);
      const occupied = emptyGrid(false);
      const aircraft = [];
      while (aircraft.length < AIRCRAFT_COUNT) {
        const shape = pick(SHAPES, rng);
        const options = placements(shape, occupied);
        if (options.length === 0) break;
        const placement = pick(options, rng);
        const index = aircraft.length;
        placement.cells.forEach((cell) => {
          occupied[cell.r][cell.c] = true;
          owner[cell.r][cell.c] = index;
        });
        aircraft.push({
          shape,
          direction: placement.direction,
          cells: placement.cells,
          head: placement.cells[0],
          found: false,
        });
      }
      if (aircraft.length === AIRCRAFT_COUNT) {
        return {
          size: SIZE,
          aircraft,
          owner,
          // Per square: 'hidden', 'miss', 'body' or 'head'.
          state: emptyGrid('hidden'),
          shots: 0,
          remaining: AIRCRAFT_COUNT,
          over: false,
        };
      }
    }
    throw new Error('Could not place the aircraft');
  }

  /*
   * Take a shot at a square. Returns what happened:
   *   { type: 'ignored' }                      already revealed, or game over
   *   { type: 'miss' | 'body' | 'head', ... }  a counted shot
   * A cockpit hit reveals only the cockpit. The rest of that aircraft stays
   * hidden, and shooting its squares still costs shots.
   */
  function shoot(game, r, c) {
    if (game.over || !inBounds(r, c) || game.state[r][c] !== 'hidden') {
      return { type: 'ignored' };
    }
    game.shots += 1;
    const index = game.owner[r][c];
    if (index === -1) {
      game.state[r][c] = 'miss';
      return { type: 'miss' };
    }
    const plane = game.aircraft[index];
    if (plane.head.r !== r || plane.head.c !== c) {
      game.state[r][c] = 'body';
      return { type: 'body', aircraft: plane };
    }
    game.state[r][c] = 'head';
    plane.found = true;
    game.remaining -= 1;
    game.over = game.remaining === 0;
    return { type: 'head', aircraft: plane, won: game.over };
  }

  /*
   * Once the game is over, show where both aircraft were. Returns the squares
   * that were still hidden. Does nothing while the game is in progress.
   */
  function uncoverAircraft(game) {
    const uncovered = [];
    if (!game.over) return uncovered;
    game.aircraft.forEach((plane) => {
      plane.cells.forEach((cell) => {
        if (game.state[cell.r][cell.c] !== 'hidden') return;
        game.state[cell.r][cell.c] = 'body';
        uncovered.push(cell);
      });
    });
    return uncovered;
  }

  return {
    SIZE, AIRCRAFT_COUNT, DIRECTIONS, SHAPES,
    rotate, placements, createGame, shoot, uncoverAircraft,
  };
});
