/* Find Aircraft: board rendering, input and the winning fly-past. */
(function () {
  'use strict';

  const { SIZE, SHAPES, createGame, shoot } = window.FindAircraft;
  const COLUMN_NAMES = 'ABCDEFGHIJ';
  const BEST_KEY = 'find-aircraft.best';
  const STATE_WORDS = {
    hidden: 'cloud',
    miss: 'clear sky',
    body: 'aircraft body',
    head: 'cockpit',
  };

  const sky = document.getElementById('sky');
  const statusEl = document.getElementById('status');
  const shotsEl = document.getElementById('shots');
  const leftEl = document.getElementById('left');
  const bestEl = document.getElementById('best');
  const shapesEl = document.getElementById('shapes');
  const newGameButton = document.getElementById('new-game');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let game;
  let cells = []; // cells[r][c] is the button for that square
  let foundTags = {}; // shape id -> the "Found" tag on the recognition chart
  let timers = [];
  let focus = { r: 0, c: 0 };

  function squareName(r, c) {
    return COLUMN_NAMES[c] + (r + 1);
  }

  /* Best score lives in this browser only; the game works without storage. */
  function readBest() {
    try {
      const value = Number(window.localStorage.getItem(BEST_KEY));
      return Number.isInteger(value) && value > 0 ? value : null;
    } catch (error) {
      return null;
    }
  }

  function writeBest(value) {
    try {
      window.localStorage.setItem(BEST_KEY, String(value));
    } catch (error) {
      /* Private windows can refuse storage; the score just isn't kept. */
    }
  }

  function showBest(value) {
    bestEl.textContent = value === null ? 'none yet' : String(value);
    bestEl.classList.toggle('is-empty', value === null);
  }

  function later(fn, ms) {
    timers.push(window.setTimeout(fn, ms));
  }

  function buildLabels() {
    const cols = document.getElementById('cols');
    const rows = document.getElementById('rows');
    for (let i = 0; i < SIZE; i++) {
      const col = document.createElement('span');
      col.textContent = COLUMN_NAMES[i];
      cols.appendChild(col);
      const row = document.createElement('span');
      row.textContent = String(i + 1);
      rows.appendChild(row);
    }
  }

  function buildBoard() {
    for (let r = 0; r < SIZE; r++) {
      const row = [];
      for (let c = 0; c < SIZE; c++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cell';
        cell.dataset.r = String(r);
        cell.dataset.c = String(c);
        sky.appendChild(cell);
        row.push(cell);
      }
      cells.push(row);
    }
    sky.addEventListener('click', (event) => {
      const cell = event.target.closest('.cell');
      if (cell) takeShot(Number(cell.dataset.r), Number(cell.dataset.c));
    });
    sky.addEventListener('keydown', onBoardKey);
    sky.addEventListener('focusin', (event) => {
      const cell = event.target.closest('.cell');
      if (cell) setFocusSquare(Number(cell.dataset.r), Number(cell.dataset.c), false);
    });
  }

  /* The recognition chart draws each silhouette from the same data the game uses. */
  function buildChart() {
    SHAPES.forEach((shape) => {
      const item = document.createElement('li');
      const grid = document.createElement('div');
      grid.className = 'shape-grid';
      grid.setAttribute('role', 'img');
      grid.setAttribute('aria-label', shape.name + ' silhouette');
      shape.cells.forEach((offset, index) => {
        const square = document.createElement('i');
        square.style.gridRow = String(offset[0] + 1);
        square.style.gridColumn = String(offset[1] + 3);
        if (index === 0) square.className = 'is-head';
        grid.appendChild(square);
      });

      const name = document.createElement('span');
      name.className = 'shape-name';
      name.textContent = shape.name;
      const meta = document.createElement('span');
      meta.className = 'shape-meta';
      meta.textContent = shape.cells.length + ' squares';
      const tag = document.createElement('span');
      tag.className = 'shape-found';
      tag.hidden = true;
      foundTags[shape.id] = tag;

      item.append(grid, name, meta, tag);
      shapesEl.appendChild(item);
    });
  }

  /* Arrow keys walk the board; only one square sits in the tab order. */
  function setFocusSquare(r, c, moveFocus) {
    cells[focus.r][focus.c].tabIndex = -1;
    focus = { r, c };
    cells[r][c].tabIndex = 0;
    if (moveFocus) cells[r][c].focus();
  }

  function onBoardKey(event) {
    const moves = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    const r = Math.min(SIZE - 1, Math.max(0, focus.r + move[0]));
    const c = Math.min(SIZE - 1, Math.max(0, focus.c + move[1]));
    setFocusSquare(r, c, true);
  }

  function paint(r, c, delay) {
    const cell = cells[r][c];
    const state = game.state[r][c];
    cell.dataset.state = state;
    cell.setAttribute('aria-label', squareName(r, c) + ', ' + STATE_WORDS[state]);
    if (state === 'hidden') {
      cell.removeAttribute('aria-disabled');
    } else {
      cell.setAttribute('aria-disabled', 'true');
    }
    cell.classList.remove('is-revealed', 'is-celebrating', 'is-clearing');
    if (delay !== undefined) {
      cell.style.setProperty('--delay', delay + 'ms');
      void cell.offsetWidth; // restart the animation if this square just played one
      cell.classList.add('is-revealed');
    }
  }

  function showCounts() {
    shotsEl.textContent = String(game.shots);
    leftEl.textContent = String(game.remaining);
  }

  function showFoundTags() {
    SHAPES.forEach((shape) => {
      const count = game.aircraft.filter((p) => p.found && p.shape.id === shape.id).length;
      const tag = foundTags[shape.id];
      tag.hidden = count === 0;
      tag.textContent = count > 1 ? 'Found, twice' : 'Found';
    });
  }

  function takeShot(r, c) {
    const result = shoot(game, r, c);
    if (result.type === 'ignored') return;
    const name = squareName(r, c);
    paint(r, c, 0);
    showCounts();

    if (result.type === 'miss') {
      statusEl.textContent = name + ': clear sky.';
      return;
    }
    if (result.type === 'body') {
      statusEl.textContent = name + ': hit. That is part of an aircraft, now find its cockpit.';
      return;
    }

    // Cockpit: uncover the rest of the aircraft, spreading outward from the hit.
    result.uncovered.forEach((cell) => {
      const distance = Math.abs(cell.r - r) + Math.abs(cell.c - c);
      paint(cell.r, cell.c, distance * 45);
    });
    showFoundTags();

    if (!result.won) {
      statusEl.textContent =
        name + ': cockpit. ' + result.aircraft.shape.name + ' found, one aircraft left.';
      return;
    }
    finish();
  }

  function finish() {
    const previousBest = readBest();
    const isBest = previousBest === null || game.shots < previousBest;
    if (isBest) {
      writeBest(game.shots);
      showBest(game.shots);
    }
    statusEl.textContent =
      'Both aircraft found in ' + game.shots + ' shots.' +
      (isBest ? ' That is your best so far.' : ' Your best is ' + previousBest + '.');
    newGameButton.classList.add('is-ready');
    later(celebrate, reducedMotion.matches ? 0 : 380);
  }

  /*
   * The winning moment: the remaining cloud parts column by column, both
   * aircraft pulse from nose to tail, and one aircraft flies across the board.
   */
  function celebrate() {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const cell = cells[r][c];
        if (game.state[r][c] !== 'hidden') continue;
        cell.dataset.state = 'miss';
        cell.setAttribute('aria-disabled', 'true');
        cell.setAttribute('aria-label', squareName(r, c) + ', clear sky');
        cell.classList.remove('is-revealed');
        cell.style.setProperty('--delay', c * 35 + 'ms');
        cell.classList.add('is-clearing');
      }
    }

    game.aircraft.forEach((plane) => {
      plane.cells.forEach((square) => {
        const cell = cells[square.r][square.c];
        const distance =
          Math.abs(square.r - plane.head.r) + Math.abs(square.c - plane.head.c);
        cell.classList.remove('is-revealed');
        cell.style.setProperty('--delay', 250 + distance * 70 + 'ms');
        void cell.offsetWidth;
        cell.classList.add('is-celebrating');
      });
    });

    if (reducedMotion.matches) return;
    const flypast = document.createElement('div');
    flypast.className = 'flypast';
    flypast.setAttribute('aria-hidden', 'true');
    flypast.innerHTML =
      '<div class="flypast-plane"><svg viewBox="0 0 48 48">' +
      '<path d="M4 22h30q10 0 10 2t-10 2H4z"/>' +
      '<path d="M22 22 14 5h5l11 17zM22 26 14 43h5l11-17z"/>' +
      '<path d="M8 22 4 13h3l6 9zM8 26 4 35h3l6-9z"/>' +
      '</svg></div>';
    flypast.addEventListener('animationend', () => flypast.remove());
    sky.appendChild(flypast);
  }

  function newGame() {
    timers.forEach((id) => window.clearTimeout(id));
    timers = [];
    const flypast = sky.querySelector('.flypast');
    if (flypast) flypast.remove();

    game = createGame();
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        cells[r][c].tabIndex = -1;
        paint(r, c);
      }
    }
    cells[focus.r][focus.c].tabIndex = 0;
    showCounts();
    showFoundTags();
    showBest(readBest());
    newGameButton.classList.remove('is-ready');
    statusEl.textContent = 'Pick a square to take your first shot.';
  }

  buildLabels();
  buildBoard();
  buildChart();
  newGameButton.addEventListener('click', newGame);
  newGame();

  // Lets a test or a curious player inspect the current game from the console.
  window.FindAircraft.current = () => game;
})();
