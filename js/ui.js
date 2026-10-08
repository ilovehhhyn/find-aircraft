/* Find Aircraft: board rendering, input, the two modes and their endings. */
(function () {
  'use strict';

  const { SIZE, AIRCRAFT_COUNT, SHAPES, createGame, shoot, uncoverAircraft } = window.FindAircraft;
  const store = window.FindAircraftStore.store;
  const COLUMN_NAMES = 'ABCDEFGHIJ';
  const MODE_KEY = 'find-aircraft.mode';
  const STATE_WORDS = {
    hidden: 'not shot yet',
    miss: 'miss',
    body: 'aircraft body',
    head: 'cockpit',
  };

  /* Each visual mode carries its own rules and wording. */
  const MODES = {
    light: {
      rules: 'find',
      brief: 'Two aircraft are hidden on the grid. Find both cockpits in as few shots as you can.',
      start: 'Pick a square to take your first shot.',
      toggleLabel: 'Dark mode',
      toggleHelp: 'Switch to dark mode: avoid the cockpits',
    },
    dark: {
      rules: 'avoid',
      brief:
        'Two aircraft are hidden in the dark. Uncover every body square, but leave the cockpits alone. Hit both and you lose.',
      start: 'Pick a square. Mind the cockpits.',
      toggleLabel: 'Light mode',
      toggleHelp: 'Switch to light mode: find the cockpits',
    },
  };

  const root = document.documentElement;
  const page = document.getElementById('page');
  const board = document.getElementById('board');
  const briefEl = document.getElementById('brief');
  const statusEl = document.getElementById('status');
  const shotsEl = document.getElementById('shots');
  const countTwoLabel = document.getElementById('count-two-label');
  const countTwo = document.getElementById('count-two');
  const countThreeLabel = document.getElementById('count-three-label');
  const countThree = document.getElementById('count-three');
  const shapesEl = document.getElementById('shapes');
  const newGameButton = document.getElementById('new-game');
  const modeToggle = document.getElementById('mode-toggle');
  const modeToggleLabel = document.getElementById('mode-toggle-label');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  let mode = root.dataset.mode === 'dark' ? 'dark' : 'light';
  let game;
  let cells = []; // cells[r][c] is the button for that square
  let timers = [];
  let focus = { r: 0, c: 0 };

  function squareName(r, c) {
    return COLUMN_NAMES[c] + (r + 1);
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
        board.appendChild(cell);
        row.push(cell);
      }
      cells.push(row);
    }
    board.addEventListener('click', (event) => {
      const cell = event.target.closest('.cell');
      if (cell) takeShot(Number(cell.dataset.r), Number(cell.dataset.c));
    });
    board.addEventListener('keydown', onBoardKey);
    board.addEventListener('focusin', (event) => {
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

      item.append(grid, name, meta);
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
    cell.classList.remove('is-revealed', 'is-celebrating');
    cell.style.removeProperty('--delay');
    if (delay !== undefined) {
      cell.style.setProperty('--delay', delay + 'ms');
      void cell.offsetWidth; // restart the animation if this square just played one
      cell.classList.add('is-revealed');
    }
  }

  /*
   * The second and third counters depend on the mode. Dark mode counts body
   * squares up rather than down, because the total would give away which
   * shapes are hidden.
   */
  function showCounts() {
    shotsEl.textContent = String(game.shots);
    if (mode === 'dark') {
      countTwoLabel.textContent = 'Cockpits hit';
      countTwo.textContent = game.cockpitsHit + ' of ' + AIRCRAFT_COUNT;
      countThreeLabel.textContent = 'Body squares found';
      countThree.textContent = String(game.bodiesFound);
      countThree.classList.remove('is-empty');
      return;
    }
    countTwoLabel.textContent = 'Aircraft left';
    countTwo.textContent = String(game.remaining);
    countThreeLabel.textContent = 'Best';
    const best = store.best();
    countThree.textContent = best === null ? 'none yet' : String(best);
    countThree.classList.toggle('is-empty', best === null);
  }

  function takeShot(r, c) {
    const result = shoot(game, r, c);
    if (result.type === 'ignored') return;
    const name = squareName(r, c);
    paint(r, c, 0);
    showCounts();

    // The status line reports the result and nothing else: no advice, and
    // no word on which shape was hit.
    if (mode === 'dark') {
      if (result.type === 'head') jolt();
      if (result.lost) {
        endGame();
        root.dataset.outcome = 'lost';
        statusEl.textContent = name + ': cockpit. You hit both cockpits. You lose.';
      } else if (result.won) {
        endGame();
        later(flypast, reducedMotion.matches ? 0 : 520);
        statusEl.textContent =
          'Every body square uncovered. You made it out ' +
          (game.cockpitsHit === 0 ? 'without touching a cockpit.' : 'with one cockpit hit.');
      } else if (result.type === 'head') {
        statusEl.textContent = name + ': cockpit. One more and you lose.';
      } else {
        statusEl.textContent = name + ': ' + result.type + '.';
      }
      return;
    }

    if (result.won) {
      endGame();
      later(celebrate, reducedMotion.matches ? 0 : 520);
      announceWin(game);
    } else if (result.type === 'head') {
      statusEl.textContent = name + ': cockpit. One aircraft left.';
    } else {
      statusEl.textContent = name + ': ' + result.type + '.';
    }
  }

  /* The game is over, so show where both aircraft were, nose to tail. */
  function endGame() {
    newGameButton.classList.add('is-ready');
    const heads = game.aircraft.map((plane) => plane.head);
    uncoverAircraft(game).forEach((cell) => {
      const head = heads[game.owner[cell.r][cell.c]];
      const distance = Math.abs(cell.r - head.r) + Math.abs(cell.c - head.c);
      paint(cell.r, cell.c, distance * 60);
    });
  }

  /* Light mode only: save the score, then say how it compares. */
  async function announceWin(finished) {
    const shots = finished.shots;
    statusEl.textContent = 'Both aircraft found in ' + shots + ' shots.';
    const previous = store.best();
    const result = await store.recordWin(shots);
    if (game !== finished) return; // a new game started while the score was saving

    let text = 'Both aircraft found in ' + shots + ' shots.';
    text += result.isBest ? ' That is your best so far.' : ' Your best is ' + previous + '.';
    if (!result.saved) {
      text += ' The leaderboard could not be reached, so this score is kept on this device.';
    } else if (!store.session() && result.isBest) {
      text += ' Sign up to put it on the leaderboard.';
    }
    statusEl.textContent = text;
    showCounts();
    document.dispatchEvent(new CustomEvent('find-aircraft:score'));
  }

  /* Both aircraft pulse from nose to tail, then one flies across the board. */
  function celebrate() {
    game.aircraft.forEach((plane) => {
      plane.cells.forEach((square) => {
        const cell = cells[square.r][square.c];
        const distance =
          Math.abs(square.r - plane.head.r) + Math.abs(square.c - plane.head.c);
        cell.classList.remove('is-revealed');
        cell.style.setProperty('--delay', distance * 70 + 'ms');
        void cell.offsetWidth;
        cell.classList.add('is-celebrating');
      });
    });
    flypast();
  }

  function flypast() {
    if (reducedMotion.matches) return;
    const layer = document.createElement('div');
    layer.className = 'flypast';
    layer.setAttribute('aria-hidden', 'true');
    layer.innerHTML =
      '<div class="flypast-plane"><svg viewBox="0 0 48 48">' +
      '<path d="M4 22h30q10 0 10 2t-10 2H4z"/>' +
      '<path d="M22 22 14 5h5l11 17zM22 26 14 43h5l11-17z"/>' +
      '<path d="M8 22 4 13h3l6 9zM8 26 4 35h3l6-9z"/>' +
      '</svg></div>';
    layer.addEventListener('animationend', () => layer.remove());
    board.appendChild(layer);
  }

  /* Dark mode: a cockpit hit shakes the page and flashes it red. */
  function jolt() {
    if (reducedMotion.matches) return;
    page.classList.remove('is-jolted');
    void page.offsetWidth;
    page.classList.add('is-jolted');
    const flash = document.createElement('div');
    flash.className = 'blood-flash';
    flash.setAttribute('aria-hidden', 'true');
    flash.addEventListener('animationend', () => flash.remove());
    document.body.appendChild(flash);
  }

  function newGame() {
    timers.forEach((id) => window.clearTimeout(id));
    timers = [];
    board.querySelectorAll('.flypast').forEach((layer) => layer.remove());
    delete root.dataset.outcome;
    page.classList.remove('is-jolted');

    game = createGame(Math.random, MODES[mode].rules);
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        cells[r][c].tabIndex = -1;
        paint(r, c);
      }
    }
    cells[focus.r][focus.c].tabIndex = 0;
    showCounts();
    newGameButton.classList.remove('is-ready');
    statusEl.textContent = MODES[mode].start;
  }

  /* Changing mode changes the rules, so it always deals a new game. */
  function applyMode(next) {
    mode = next;
    root.dataset.mode = mode;
    try {
      window.localStorage.setItem(MODE_KEY, mode);
    } catch (error) {
      /* The mode just isn't remembered next time. */
    }
    briefEl.textContent = MODES[mode].brief;
    modeToggleLabel.textContent = MODES[mode].toggleLabel;
    modeToggle.setAttribute('aria-label', MODES[mode].toggleHelp);
    modeToggle.title = MODES[mode].toggleHelp;
    newGame();
  }

  buildLabels();
  buildBoard();
  buildChart();
  newGameButton.addEventListener('click', newGame);
  modeToggle.addEventListener('click', () => applyMode(mode === 'dark' ? 'light' : 'dark'));
  // Signing in or out changes whose best score is shown.
  document.addEventListener('find-aircraft:account', showCounts);
  applyMode(mode);

  // Lets a test or a curious player inspect the current game from the console.
  window.FindAircraft.current = () => game;
})();
