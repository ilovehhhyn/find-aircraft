/*
 * Find Aircraft: play against a friend.
 *
 * The lobby dialog gives you a room code to share or takes a friend's code.
 * In a room, each round has three phases, all driven by the server
 * (supabase/rooms.sql):
 *   placing   60 s to drag two different aircraft onto your own grid
 *   playing   5 min to search your friend's grid; every shot is judged by
 *             the server, so neither side ever sees the other's layout
 *   finished  fewer shots to find both cockpits wins; both layouts revealed
 */
(function () {
  'use strict';

  const G = window.FindAircraft;
  const store = window.FindAircraftStore.store;
  const config = window.FIND_AIRCRAFT_CONFIG || {};
  const ONLINE = Boolean(config.supabaseUrl && config.supabaseAnonKey);
  const SIZE = G.SIZE;
  const COLUMN_NAMES = 'ABCDEFGHIJ';
  const ROOM_KEY = 'find-aircraft.room';
  const NAME_KEY = 'find-aircraft.player-name';
  const DIRS = G.DIRECTIONS; // up, right, down, left: clockwise order
  const SERVER_BUFFER_MS = 2000; // deadlines carry two spare seconds
  const MESSAGES = {
    room_not_found: 'No open room has that code. Check the letters, or ask your friend for a new code.',
    room_full: 'That room already has two players.',
    invalid_name: 'Names are up to 20 letters, numbers, spaces, hyphens or underscores.',
    invalid_layout: 'Those aircraft overlap or leave the grid. Move them and try again.',
    already_placed: 'Your aircraft are already locked in.',
    not_placing: 'Hiding time is over.',
    not_playing: 'This round is over.',
    network: 'Could not reach the game server. Check your connection.',
    server: 'Something went wrong on the game server. Try again.',
  };

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;

  // Lobby
  const openButton = $('open-room');
  const lobby = $('room-dialog');
  const nameRow = $('room-name-row');
  const nameInput = $('room-name');
  const signedInAs = $('room-signed-in-as');
  const hostBox = $('room-host');
  const tiles = $('code-tiles');
  const copyCode = $('copy-code');
  const copyLink = $('copy-link');
  const roomWait = $('room-wait');
  const makeOwn = $('make-own-room');
  const joinForm = $('join-form');
  const codeInputs = Array.from(document.querySelectorAll('.code-inputs input'));
  const joinError = $('join-error');
  const joinSubmit = $('join-submit');
  const offlineNote = $('room-offline');

  // Match
  const matchEl = $('match');
  const matchCode = $('match-code');
  const matchVs = $('match-vs');
  const clock = $('match-clock');
  const phaseTitle = $('match-title');
  const boardTitle = $('match-board-title');
  const board = $('match-board');
  const statusEl = $('match-status');
  const placePanel = $('place-panel');
  const hangar = $('hangar');
  const placeConfirm = $('place-confirm');
  const placeOpp = $('place-opp');
  const playPanel = $('play-panel');
  const mini = $('mini-board');
  const resultPanel = $('result-panel');
  const resultTitle = $('result-title');
  const resultDetail = $('result-detail');
  const resultSaved = $('result-saved');
  const rematchButton = $('rematch');

  let room = readRoom(); // { code, secret, role } for the room you are in
  let state = null; // last state from the server
  let clockOffset = 0; // server time minus local time, in ms
  let pollTimer = null;
  let tickTimer = null;
  let polling = false;
  let inMatch = false;
  let placed = []; // your aircraft while placing: [{ shape, dir, r, c }]
  let placedRound = 0;
  let submitting = false;
  let shooting = false;
  let drag = null;
  let recordedRound = null;
  let cells = []; // big board buttons
  let miniCells = [];
  let boardMode = null; // 'place' or 'shoot'

  /* ---------- storage and server ---------- */

  function readRoom() {
    try {
      const value = JSON.parse(window.localStorage.getItem(ROOM_KEY));
      return value && /^[A-Z]{4}$/.test(value.code) && value.secret ? value : null;
    } catch (error) {
      return null;
    }
  }

  function saveRoom(value) {
    room = value;
    try {
      if (value) window.localStorage.setItem(ROOM_KEY, JSON.stringify(value));
      else window.localStorage.removeItem(ROOM_KEY);
    } catch (error) {
      /* The room is just not resumed after a reload. */
    }
  }

  function savedName() {
    try {
      return window.localStorage.getItem(NAME_KEY) || '';
    } catch (error) {
      return '';
    }
  }

  function playerName() {
    const session = store.session();
    return session ? session.name : nameInput.value.trim() || savedName();
  }

  function fail(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  async function rpc(name, args) {
    if (!ONLINE) throw fail('network');
    let response;
    try {
      response = await window.fetch(config.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/rpc/' + name, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: config.supabaseAnonKey,
          Authorization: 'Bearer ' + config.supabaseAnonKey,
        },
        body: JSON.stringify(args),
      });
    } catch (error) {
      throw fail('network');
    }
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      /* Handled below. */
    }
    if (!response.ok) {
      throw fail(data && MESSAGES[data.message] ? data.message : 'server');
    }
    return data;
  }

  const now = () => Date.now() + clockOffset;

  function remaining(deadline) {
    return Math.max(0, new Date(deadline).getTime() - SERVER_BUFFER_MS - now());
  }

  function formatClock(ms, hours) {
    const total = Math.ceil(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return hours ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  function squareName(r, c) {
    return COLUMN_NAMES[c] + (r + 1);
  }

  function cellsOf(plane) {
    const shape = G.SHAPES.find((s) => s.id === plane.shape);
    return shape.cells.map((offset, i) => {
      const [dr, dc] = G.rotate(offset, plane.dir);
      return { r: plane.r + dr, c: plane.c + dc, h: i === 0 };
    });
  }

  function fits(plane, others) {
    const taken = new Set();
    others.forEach((p) => cellsOf(p).forEach((cell) => taken.add(cell.r * SIZE + cell.c)));
    return cellsOf(plane).every(
      (cell) => cell.r >= 0 && cell.r < SIZE && cell.c >= 0 && cell.c < SIZE && !taken.has(cell.r * SIZE + cell.c)
    );
  }

  /* Somewhere random for `shape` that does not touch `others`. */
  function randomSpot(shapeId, others) {
    const occupied = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
    others.forEach((p) => cellsOf(p).forEach((cell) => (occupied[cell.r][cell.c] = true)));
    const shape = G.SHAPES.find((s) => s.id === shapeId);
    const options = G.placements(shape, occupied);
    if (!options.length) return null;
    const pick = options[Math.floor(Math.random() * options.length)];
    return { shape: shapeId, dir: pick.direction, r: pick.cells[0].r, c: pick.cells[0].c };
  }

  /* Fill up to two different aircraft, keeping any already placed. */
  function completeRandomly(current) {
    const result = current.slice(0, 2);
    const unused = G.SHAPES.map((s) => s.id).filter((id) => !result.some((p) => p.shape === id));
    while (result.length < 2 && unused.length) {
      const id = unused.splice(Math.floor(Math.random() * unused.length), 1)[0];
      const spot = randomSpot(id, result);
      if (spot) result.push(spot);
    }
    return result;
  }

  /* ---------- lobby ---------- */

  function setTiles(code) {
    tiles.replaceChildren(
      ...Array.from({ length: 4 }, (_, i) => {
        const tile = document.createElement('span');
        tile.className = 'code-tile' + (code ? '' : ' is-empty');
        tile.textContent = code ? code[i] : '';
        return tile;
      })
    );
    tiles.setAttribute('aria-label', code ? 'Your code: ' + code.split('').join(' ') : 'Making your code');
  }

  function renderName() {
    const session = store.session();
    nameRow.hidden = Boolean(session);
    signedInAs.hidden = !session;
    if (session) signedInAs.textContent = 'Playing as ' + session.name + '. Your wins count on the leaderboard.';
    else if (!nameInput.value) nameInput.value = savedName();
  }

  function inviteLink(code) {
    return window.location.origin + window.location.pathname + '?room=' + code;
  }

  function flash(button, text) {
    const original = button.dataset.label || button.textContent;
    button.dataset.label = original;
    button.textContent = text;
    window.setTimeout(() => (button.textContent = original), 1600);
  }

  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      flash(button, 'Copied');
    } catch (error) {
      flash(button, text);
    }
  }

  async function hostRoom() {
    makeOwn.hidden = true;
    hostBox.classList.remove('is-collapsed');
    setTiles(null);
    roomWait.textContent = 'Making your code.';
    copyCode.disabled = copyLink.disabled = true;
    try {
      if (!room || room.role !== 'host') {
        const created = await rpc('fa_room_create', { p_name: playerName() });
        saveRoom({ code: created.code, secret: created.secret, role: 'host' });
      }
      await refresh();
      if (!room) return hostRoom(); // the saved room had closed; make a new one
    } catch (error) {
      roomWait.textContent = MESSAGES[error.code] || MESSAGES.server;
      return;
    }
    setTiles(room.code);
    copyCode.disabled = copyLink.disabled = false;
    startPolling(2000);
  }

  function renderLobbyWait() {
    if (!state || state.phase !== 'waiting' || !lobby.open) return;
    roomWait.replaceChildren();
    const dot = document.createElement('span');
    dot.className = 'wait-dot';
    dot.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent =
      'Waiting for a friend to join. Code expires in ' + formatClock(remaining(state.expires_at) + SERVER_BUFFER_MS, true) + '.';
    roomWait.append(dot, text);
  }

  function openLobby(inviteCode) {
    joinError.hidden = true;
    renderName();
    offlineNote.hidden = ONLINE;
    joinSubmit.disabled = !ONLINE;
    if (!lobby.open) lobby.showModal();
    if (!ONLINE) {
      hostBox.classList.add('is-collapsed');
      return;
    }
    if (inviteCode) {
      fillCode(inviteCode);
      hostBox.classList.add('is-collapsed');
      makeOwn.hidden = false;
      joinSubmit.focus();
    } else {
      hostRoom();
      codeInputs[0].focus();
    }
  }

  function fillCode(code) {
    const letters = code.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4).split('');
    codeInputs.forEach((input, i) => (input.value = letters[i] || ''));
  }

  function enteredCode() {
    return codeInputs.map((input) => input.value).join('').toUpperCase();
  }

  async function onJoin(event) {
    event.preventDefault();
    joinError.hidden = true;
    const code = enteredCode();
    const showError = (text) => {
      joinError.textContent = text;
      joinError.hidden = false;
    };
    if (!/^[A-Z]{4}$/.test(code)) return showError('Enter all four letters of the code.');
    if (room && room.role === 'host' && room.code === code) {
      return showError('That is your own code. Send it to a friend, and enter theirs here.');
    }
    joinSubmit.disabled = true;
    try {
      const joined = await rpc('fa_room_join', { p_code: code, p_name: playerName() });
      if (room) rpc('fa_room_leave', { p_code: room.code, p_secret: room.secret }).catch(() => {});
      saveRoom({ code: joined.code, secret: joined.secret, role: 'guest' });
      lobby.close();
      await refresh();
    } catch (error) {
      showError(MESSAGES[error.code] || MESSAGES.server);
    } finally {
      joinSubmit.disabled = false;
    }
  }

  function wireCodeInputs() {
    codeInputs.forEach((input, i) => {
      input.addEventListener('input', () => {
        const letters = input.value.toUpperCase().replace(/[^A-Z]/g, '');
        if (letters.length > 1) {
          fillCode(letters);
          codeInputs[Math.min(3, letters.length - 1 + i)].focus();
          return;
        }
        input.value = letters;
        joinError.hidden = true;
        if (letters && i < 3) codeInputs[i + 1].focus();
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Backspace' && !input.value && i > 0) {
          codeInputs[i - 1].value = '';
          codeInputs[i - 1].focus();
          event.preventDefault();
        } else if (event.key === 'ArrowLeft' && i > 0) {
          codeInputs[i - 1].focus();
        } else if (event.key === 'ArrowRight' && i < 3) {
          codeInputs[i + 1].focus();
        }
      });
      input.addEventListener('paste', (event) => {
        const text = (event.clipboardData || window.clipboardData).getData('text');
        event.preventDefault();
        fillCode(text);
        codeInputs[Math.min(3, text.replace(/[^A-Za-z]/g, '').length)].focus();
      });
      input.addEventListener('focus', () => input.select());
    });
  }

  /* ---------- polling ---------- */

  function startPolling(interval) {
    stopPolling();
    pollTimer = window.setInterval(refresh, interval);
  }

  function stopPolling() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
  }

  async function refresh() {
    if (!room || polling) return;
    polling = true;
    try {
      const sentAt = Date.now();
      const next = await rpc('fa_room_state', { p_code: room.code, p_secret: room.secret });
      const arrivedAt = Date.now();
      clockOffset = new Date(next.now).getTime() - (sentAt + arrivedAt) / 2;
      apply(next);
    } catch (error) {
      if (error.code === 'room_not_found') closeRoom('That room has closed.');
      // Network blips: the next poll tries again.
    } finally {
      polling = false;
    }
  }

  function apply(next) {
    const previous = state;
    state = next;
    if (next.phase === 'closed') {
      closeRoom(previous && previous.phase !== 'waiting' ? 'The room has closed.' : null);
      return;
    }
    if (next.phase === 'waiting') {
      renderLobbyWait();
      return;
    }
    if (!inMatch) enterMatch();
    if (placedRound !== next.round) {
      placedRound = next.round;
      placed = [];
      submitting = false;
    }
    render();
  }

  function closeRoom(message) {
    saveRoom(null);
    state = null;
    stopPolling();
    if (inMatch) leaveMatchView();
    if (message) {
      const solo = $('status');
      if (solo) solo.textContent = message;
    }
  }

  /* ---------- match view ---------- */

  function enterMatch() {
    inMatch = true;
    if (lobby.open) lobby.close();
    document.body.classList.add('in-match');
    matchEl.hidden = false;
    startPolling(1000);
    if (!tickTimer) tickTimer = window.setInterval(tick, 250);
    window.scrollTo({ top: 0 });
  }

  function leaveMatchView() {
    inMatch = false;
    document.body.classList.remove('in-match');
    matchEl.hidden = true;
    if (tickTimer) window.clearInterval(tickTimer);
    tickTimer = null;
    boardMode = null;
  }

  async function leaveRoom() {
    const current = room;
    closeRoom(null);
    if (current) rpc('fa_room_leave', { p_code: current.code, p_secret: current.secret }).catch(() => {});
  }

  function buildBoard() {
    const cols = $('match-cols');
    const rows = $('match-rows');
    for (let i = 0; i < SIZE; i++) {
      const col = document.createElement('span');
      col.textContent = COLUMN_NAMES[i];
      cols.appendChild(col);
      const row = document.createElement('span');
      row.textContent = String(i + 1);
      rows.appendChild(row);
    }
    for (let r = 0; r < SIZE; r++) {
      const row = [];
      const miniRow = [];
      for (let c = 0; c < SIZE; c++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cell';
        cell.dataset.r = String(r);
        cell.dataset.c = String(c);
        cell.tabIndex = r === 0 && c === 0 ? 0 : -1;
        board.appendChild(cell);
        row.push(cell);
        const small = document.createElement('span');
        small.className = 'mini-cell';
        mini.appendChild(small);
        miniRow.push(small);
      }
      cells.push(row);
      miniCells.push(miniRow);
    }
    board.addEventListener('click', (event) => {
      const cell = event.target.closest('.cell');
      if (cell && boardMode === 'shoot') shoot(Number(cell.dataset.r), Number(cell.dataset.c));
    });
    board.addEventListener('keydown', onBoardKey);
    board.addEventListener('pointerdown', onBoardPointerDown);
  }

  function onBoardKey(event) {
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const move = moves[event.key];
    const cell = event.target.closest('.cell');
    if (!move || !cell) return;
    event.preventDefault();
    const r = Math.min(SIZE - 1, Math.max(0, Number(cell.dataset.r) + move[0]));
    const c = Math.min(SIZE - 1, Math.max(0, Number(cell.dataset.c) + move[1]));
    cell.tabIndex = -1;
    cells[r][c].tabIndex = 0;
    cells[r][c].focus();
  }

  function setCell(cell, stateName, extra, label) {
    if (cell.dataset.state !== stateName) cell.dataset.state = stateName;
    const classes = ['cell'].concat(extra || []).join(' ');
    if (cell.className !== classes) cell.className = classes;
    if (label && cell.getAttribute('aria-label') !== label) cell.setAttribute('aria-label', label);
  }

  function render() {
    const s = state;
    const opp = s.opp.name || 'Your friend';
    matchCode.textContent = s.code;
    matchVs.textContent = (s.me.name || 'You') + ' vs ' + opp;
    placePanel.hidden = s.phase !== 'placing';
    playPanel.hidden = s.phase !== 'playing';
    resultPanel.hidden = s.phase !== 'finished';
    matchEl.dataset.phase = s.phase;

    if (s.phase === 'placing') renderPlacing(opp);
    else if (s.phase === 'playing') renderPlaying(opp);
    else if (s.phase === 'finished') renderFinished(opp);
    tick();
  }

  function tick() {
    if (!state) return;
    let ms = null;
    if (state.phase === 'placing') ms = remaining(state.place_deadline);
    if (state.phase === 'playing') ms = remaining(state.play_deadline);
    clock.hidden = ms === null;
    if (ms === null) return;
    clock.textContent = formatClock(ms);
    clock.classList.toggle('is-low', ms <= (state.phase === 'placing' ? 10000 : 30000));
    if (state.phase === 'placing' && ms === 0 && !state.me.placed && !submitting) confirmPlacement(true);
  }

  /* ---------- placing ---------- */

  function buildHangar() {
    G.SHAPES.forEach((shape) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'hangar-item';
      button.dataset.shape = shape.id;
      const grid = document.createElement('span');
      grid.className = 'hangar-shape';
      grid.setAttribute('aria-hidden', 'true');
      shape.cells.forEach((offset, i) => {
        const square = document.createElement('i');
        square.style.gridRow = String(offset[0] + 1);
        square.style.gridColumn = String(offset[1] + 3);
        square.dataset.dr = String(offset[0]);
        square.dataset.dc = String(offset[1]);
        if (i === 0) square.className = 'is-head';
        grid.appendChild(square);
      });
      const name = document.createElement('span');
      name.className = 'hangar-name';
      name.textContent = shape.name;
      const tag = document.createElement('span');
      tag.className = 'hangar-tag';
      button.append(grid, name, tag);
      button.addEventListener('pointerdown', (event) => startDrag(event, { shape: shape.id, from: null }));
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          tapHangar(shape.id);
        }
      });
      item.appendChild(button);
      hangar.appendChild(item);
    });
  }

  function myPlanes() {
    return state && state.me.placed ? state.me.planes || [] : placed;
  }

  function renderPlacing(opp) {
    boardMode = 'place';
    const locked = state.me.placed;
    phaseTitle.textContent = locked ? 'Waiting for ' + opp : 'Hide your aircraft';
    boardTitle.textContent = 'Your grid';
    board.classList.toggle('is-locked', locked);
    if (!drag) paintPlacement();

    hangar.querySelectorAll('.hangar-item').forEach((button) => {
      const used = myPlanes().some((p) => p.shape === button.dataset.shape);
      const full = myPlanes().length >= 2;
      button.classList.toggle('is-used', used);
      button.classList.toggle('is-unavailable', !used && full);
      button.disabled = locked;
      button.querySelector('.hangar-tag').textContent = used ? 'On your grid' : full ? 'Two already placed' : '';
      button.setAttribute(
        'aria-label',
        button.querySelector('.hangar-name').textContent + (used ? ', on your grid' : ', place at random')
      );
    });
    placeConfirm.disabled = locked || submitting || placed.length < 2;
    placeConfirm.textContent = locked ? 'Locked in' : submitting ? 'Locking in' : 'Confirm';
    $('place-random').disabled = locked;
    $('place-clear').disabled = locked;
    placeOpp.textContent = state.opp.placed ? opp + ' is ready.' : opp + ' is hiding aircraft.';
    placeOpp.classList.toggle('is-ready', state.opp.placed);
    if (locked) statusEl.textContent = 'Locked in. The search starts as soon as ' + opp + ' is ready.';
    else if (placed.length < 2) statusEl.textContent = 'Drag two of the three aircraft onto your grid.';
    else statusEl.textContent = 'Tap an aircraft to turn it, or drag it to move it. Confirm when you are happy.';
  }

  function paintPlacement(preview) {
    const owner = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
    const planes = myPlanes();
    planes.forEach((plane, index) => {
      if (drag && drag.from === index && drag.moved) return;
      cellsOf(plane).forEach((cell) => (owner[cell.r][cell.c] = { index, h: cell.h }));
    });
    const marks = new Map();
    if (preview) {
      cellsOf(preview.plane).forEach((cell) => {
        if (cell.r >= 0 && cell.r < SIZE && cell.c >= 0 && cell.c < SIZE) {
          marks.set(cell.r * SIZE + cell.c, preview.ok ? 'is-drop-ok' : 'is-drop-bad');
        }
      });
    }
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const own = owner[r][c];
        const extra = [];
        if (marks.has(r * SIZE + c)) extra.push(marks.get(r * SIZE + c));
        if (own) extra.push('is-mine');
        setCell(
          cells[r][c],
          own ? (own.h ? 'head' : 'body') : 'hidden',
          extra,
          squareName(r, c) + (own ? (own.h ? ', your cockpit' : ', your aircraft') : ', empty')
        );
        cells[r][c].dataset.plane = own ? String(own.index) : '';
      }
    }
  }

  function tapHangar(shapeId) {
    if (state.me.placed) return;
    if (placed.some((p) => p.shape === shapeId)) return;
    if (placed.length >= 2) {
      statusEl.textContent = 'You already have two aircraft. Drag one off the grid to swap it.';
      return;
    }
    const spot = randomSpot(shapeId, placed);
    if (spot) placed.push(spot);
    renderPlacing(state.opp.name || 'Your friend');
  }

  function onBoardPointerDown(event) {
    if (boardMode !== 'place' || state.me.placed) return;
    const cell = event.target.closest('.cell');
    if (!cell || cell.dataset.plane === '' || cell.dataset.plane === undefined) return;
    const index = Number(cell.dataset.plane);
    const plane = placed[index];
    startDrag(event, {
      shape: plane.shape,
      dir: plane.dir,
      from: index,
      grab: [Number(cell.dataset.r) - plane.r, Number(cell.dataset.c) - plane.c],
    });
  }

  function startDrag(event, source) {
    if (!state || state.phase !== 'placing' || state.me.placed || event.button > 0) return;
    if (source.from === null && placed.some((p) => p.shape === source.shape)) return;
    if (source.from === null && placed.length >= 2) {
      statusEl.textContent = 'You already have two aircraft. Drag one off the grid to swap it.';
      return;
    }
    event.preventDefault();
    let grab = source.grab;
    if (!grab) {
      const square = event.target.closest('i[data-dr]');
      grab = square ? [Number(square.dataset.dr), Number(square.dataset.dc)] : [1, 0];
    }
    drag = {
      shape: source.shape,
      dir: source.dir || 'up',
      from: source.from,
      grab,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      candidate: null,
      ghost: null,
    };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragCancel);
  }

  function makeGhost() {
    const size = cells[0][0].getBoundingClientRect().width;
    const gap = cells[0][1].getBoundingClientRect().left - cells[0][0].getBoundingClientRect().right;
    const shape = G.SHAPES.find((s) => s.id === drag.shape);
    const offsets = shape.cells.map((o) => G.rotate(o, drag.dir));
    const minR = Math.min(...offsets.map((o) => o[0]));
    const minC = Math.min(...offsets.map((o) => o[1]));
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    offsets.forEach((o, i) => {
      const square = document.createElement('i');
      square.style.left = (o[1] - minC) * (size + gap) + 'px';
      square.style.top = (o[0] - minR) * (size + gap) + 'px';
      square.style.width = square.style.height = size + 'px';
      if (i === 0) square.className = 'is-head';
      ghost.appendChild(square);
    });
    // Keep the grabbed square under the pointer.
    drag.ghostShift = [(drag.grab[1] - minC) * (size + gap) + size / 2, (drag.grab[0] - minR) * (size + gap) + size / 2];
    document.body.appendChild(ghost);
    drag.ghost = ghost;
  }

  function onDragMove(event) {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
      drag.moved = true;
      makeGhost();
    }
    drag.ghost.style.transform =
      'translate(' + (event.clientX - drag.ghostShift[0]) + 'px,' + (event.clientY - drag.ghostShift[1]) + 'px)';
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const cell = target && target.closest('#match-board .cell');
    if (!cell) {
      drag.candidate = null;
      paintPlacement();
      return;
    }
    const plane = {
      shape: drag.shape,
      dir: drag.dir,
      r: Number(cell.dataset.r) - drag.grab[0],
      c: Number(cell.dataset.c) - drag.grab[1],
    };
    const others = placed.filter((_, i) => i !== drag.from);
    drag.candidate = { plane, ok: fits(plane, others) };
    paintPlacement(drag.candidate);
  }

  /* A tap on a placed aircraft turns it clockwise to the next way it fits. */
  function rotatePlane(index) {
    const plane = placed[index];
    const others = placed.filter((_, i) => i !== index);
    const start = DIRS.indexOf(plane.dir);
    for (let step = 1; step < 4; step++) {
      const turned = Object.assign({}, plane, { dir: DIRS[(start + step) % 4] });
      if (fits(turned, others)) {
        placed[index] = turned;
        return;
      }
    }
    statusEl.textContent = 'No room to turn that aircraft here. Move it first.';
  }

  function onDragEnd() {
    const current = drag;
    endDrag();
    if (!current) return;
    if (!current.moved) {
      if (current.from !== null) rotatePlane(current.from);
      else tapHangar(current.shape);
    } else if (current.candidate && current.candidate.ok) {
      if (current.from !== null) placed[current.from] = current.candidate.plane;
      else placed.push(current.candidate.plane);
    } else if (current.from !== null && !current.candidate) {
      placed.splice(current.from, 1); // dragged off the grid: back to the hangar
    }
    renderPlacing(state.opp.name || 'Your friend');
  }

  function onDragCancel() {
    endDrag();
    paintPlacement();
  }

  function endDrag() {
    if (drag && drag.ghost) drag.ghost.remove();
    drag = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragCancel);
  }

  async function confirmPlacement(automatic) {
    if (!state || state.me.placed || submitting) return;
    if (automatic) {
      endDrag();
      placed = completeRandomly(placed);
    }
    if (placed.length < 2) return;
    submitting = true;
    renderPlacing(state.opp.name || 'Your friend');
    try {
      apply(await rpc('fa_room_place', { p_code: room.code, p_secret: room.secret, p_planes: placed }));
      if (automatic) statusEl.textContent = 'Time is up, so your aircraft were locked in where they were. Empty spots were filled at random.';
    } catch (error) {
      statusEl.textContent = MESSAGES[error.code] || MESSAGES.server;
    } finally {
      submitting = false;
      if (state && state.phase === 'placing') renderPlacing(state.opp.name || 'Your friend');
    }
  }

  /* ---------- playing ---------- */

  function shotsByCell(shots) {
    const map = new Map();
    (shots || []).forEach((shot) => map.set(shot.r * SIZE + shot.c, shot.t));
    return map;
  }

  const heads = (shots) => (shots || []).filter((s) => s.t === 'head').length;

  function paintSearch(revealPlanes) {
    const mine = shotsByCell(state.me.shots);
    const reveal = new Map();
    (revealPlanes || []).forEach((plane) =>
      cellsOf(plane).forEach((cell) => reveal.set(cell.r * SIZE + cell.c, cell.h ? 'head' : 'body'))
    );
    const open = state.phase === 'playing' && state.me.done === null;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const key = r * SIZE + c;
        const shot = mine.get(key);
        const extra = [];
        let stateName = shot || 'hidden';
        if (!shot && reveal.has(key)) {
          stateName = reveal.get(key);
          extra.push('is-unfound');
        }
        if (cells[r][c].classList.contains('is-revealed') && shot) extra.push('is-revealed');
        setCell(cells[r][c], stateName, extra, squareName(r, c) + ', ' + (shot || (reveal.has(key) ? 'not found' : 'not shot yet')));
        cells[r][c].dataset.plane = '';
      }
    }
    board.classList.toggle('is-locked', !open);
  }

  function paintMini() {
    const owner = new Map();
    (state.me.planes || []).forEach((plane) =>
      cellsOf(plane).forEach((cell) => owner.set(cell.r * SIZE + cell.c, cell.h ? 'head' : 'body'))
    );
    const hits = shotsByCell(state.opp.shots);
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const key = r * SIZE + c;
        const part = owner.get(key);
        const shot = hits.get(key);
        const small = miniCells[r][c];
        small.dataset.state = part || (shot ? 'miss' : 'hidden');
        small.classList.toggle('is-hit', Boolean(shot && part));
      }
    }
  }

  function renderPlaying(opp) {
    boardMode = 'shoot';
    const me = state.me;
    phaseTitle.textContent = me.done === null ? 'Find ' + opp + "'s aircraft" : 'Waiting for ' + opp;
    boardTitle.textContent = opp + "'s grid";
    paintSearch();
    paintMini();
    $('duel-me-shots').textContent = String(me.shots.length);
    $('duel-me-heads').textContent = heads(me.shots) + ' of 2';
    $('duel-opp-name').textContent = opp;
    $('duel-opp-shots').textContent = String(state.opp.shots.length);
    $('duel-opp-heads').textContent = heads(state.opp.shots) + ' of 2';
    $('duel-me').classList.toggle('is-done', me.done !== null);
    $('duel-opp').classList.toggle('is-done', state.opp.done !== null);
    $('mini-title').textContent = 'Your grid, with ' + opp + "'s shots";
    if (me.done !== null) {
      statusEl.textContent =
        'You found both cockpits in ' + me.done + ' shots. Waiting for ' + opp + ' to finish: they need fewer than ' + me.done + ' to win.';
      recordScore(me.done);
    } else if (!shooting && !/^[A-J]\d+: /.test(statusEl.textContent)) {
      statusEl.textContent = 'Pick a square on ' + opp + "'s grid. Fewest shots to find both cockpits wins.";
    }
  }

  async function shoot(r, c) {
    if (shooting || !state || state.phase !== 'playing' || state.me.done !== null) return;
    if (state.me.shots.some((s) => s.r === r && s.c === c)) return;
    shooting = true;
    cells[r][c].classList.add('is-pending');
    try {
      const result = await rpc('fa_room_shoot', { p_code: room.code, p_secret: room.secret, p_r: r, p_c: c });
      if (result.type !== 'ignored') {
        state.me.shots = state.me.shots.concat([{ r, c, t: result.type }]);
        state.me.done = result.done === undefined ? state.me.done : result.done;
        cells[r][c].classList.add('is-revealed');
        statusEl.textContent =
          squareName(r, c) + ': ' + result.type + '.' + (result.type === 'head' && heads(state.me.shots) === 1 ? ' One cockpit to go.' : '');
        renderPlaying(state.opp.name || 'Your friend');
      }
    } catch (error) {
      statusEl.textContent = MESSAGES[error.code] || MESSAGES.server;
    } finally {
      cells[r][c].classList.remove('is-pending');
      shooting = false;
    }
    refresh();
  }

  async function recordScore(shots) {
    const key = state.code + ':' + state.round;
    if (recordedRound === key) return;
    recordedRound = key;
    try {
      const result = await store.recordWin(shots);
      resultSaved.textContent = store.session()
        ? result.isBest
          ? 'New best: ' + shots + ' shots, saved to the leaderboard.'
          : 'Score saved. Your best is still ' + result.best + ' shots.'
        : result.isBest
          ? 'New best: ' + shots + ' shots. Sign up to put it on the leaderboard.'
          : '';
      document.dispatchEvent(new CustomEvent('find-aircraft:score'));
      document.dispatchEvent(new CustomEvent('find-aircraft:account'));
    } catch (error) {
      resultSaved.textContent = '';
    }
  }

  /* ---------- finished ---------- */

  function renderFinished(opp) {
    boardMode = 'shoot';
    const s = state;
    const result = s.result || {};
    const won = result.winner === s.role;
    const draw = !result.winner;
    phaseTitle.textContent = 'Round ' + s.round + ' is over';
    boardTitle.textContent = opp + "'s grid";
    paintSearch(s.opp.planes);
    paintMini();
    resultPanel.dataset.outcome = draw ? 'draw' : won ? 'won' : 'lost';
    resultTitle.textContent = draw ? 'Draw' : won ? 'You win' : opp + ' wins';

    const mine = s.me.done !== null ? s.me.done + ' shots' : 'not finished, ' + heads(s.me.shots) + ' of 2 cockpits';
    const theirs = s.opp.done !== null ? s.opp.done + ' shots' : 'not finished, ' + heads(s.opp.shots) + ' of 2 cockpits';
    const lines = {
      both_found: 'Both found both cockpits.',
      found_first: (won ? 'You' : opp) + ' found both cockpits first.',
      time: 'Five minutes ran out before both of you finished.',
      not_placed: draw
        ? 'Neither of you hid your aircraft in time.'
        : (won ? opp : 'You') + ' did not hide aircraft in time.',
    };
    resultDetail.replaceChildren();
    const why = document.createElement('p');
    why.textContent = lines[result.reason] || '';
    resultDetail.appendChild(why);
    if (result.reason !== 'not_placed') {
      const list = document.createElement('dl');
      list.className = 'result-scores';
      [['You', mine], [opp, theirs]].forEach(([who, what]) => {
        const row = document.createElement('div');
        const dt = document.createElement('dt');
        dt.textContent = who;
        const dd = document.createElement('dd');
        dd.textContent = what;
        row.append(dt, dd);
        list.appendChild(row);
      });
      resultDetail.appendChild(list);
    }
    statusEl.textContent = 'Outlined squares show the parts of the aircraft you did not find.';
    if (s.me.done !== null) recordScore(s.me.done);
    else if (recordedRound !== s.code + ':' + s.round) resultSaved.textContent = '';
  }

  async function rematch() {
    rematchButton.disabled = true;
    try {
      apply(await rpc('fa_room_rematch', { p_code: room.code, p_secret: room.secret }));
    } catch (error) {
      statusEl.textContent = MESSAGES[error.code] || MESSAGES.server;
    } finally {
      rematchButton.disabled = false;
    }
  }

  /* ---------- wiring ---------- */

  /* A reminder of the three shapes while searching. */
  function buildShapeReminder() {
    const list = $('match-shapes');
    G.SHAPES.forEach((shape) => {
      const item = document.createElement('li');
      const grid = document.createElement('div');
      grid.className = 'shape-grid';
      grid.setAttribute('role', 'img');
      grid.setAttribute('aria-label', shape.name);
      shape.cells.forEach((offset, i) => {
        const square = document.createElement('i');
        square.style.gridRow = String(offset[0] + 1);
        square.style.gridColumn = String(offset[1] + 3);
        if (i === 0) square.className = 'is-head';
        grid.appendChild(square);
      });
      const name = document.createElement('span');
      name.className = 'shape-name';
      name.textContent = shape.name;
      item.append(grid, name);
      list.appendChild(item);
    });
  }

  buildBoard();
  buildHangar();
  buildShapeReminder();
  wireCodeInputs();
  setTiles(null);

  openButton.addEventListener('click', () => openLobby(null));
  joinForm.addEventListener('submit', onJoin);
  makeOwn.addEventListener('click', hostRoom);
  copyCode.addEventListener('click', () => room && copy(room.code, copyCode));
  if (navigator.share) copyLink.textContent = 'Share invite';
  copyLink.addEventListener('click', async () => {
    if (!room) return;
    const link = inviteLink(room.code);
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Find Aircraft', text: 'Play Find Aircraft with me. Room code: ' + room.code, url: link });
        return;
      } catch (error) {
        if (error && error.name === 'AbortError') return;
      }
    }
    copy(link, copyLink);
  });
  nameInput.addEventListener('change', () => {
    const value = nameInput.value.trim();
    try {
      window.localStorage.setItem(NAME_KEY, value);
    } catch (error) {
      /* Not remembered. */
    }
    if (room && room.role === 'host') {
      rpc('fa_room_rename', { p_code: room.code, p_secret: room.secret, p_name: value }).catch((error) => {
        roomWait.textContent = MESSAGES[error.code] || MESSAGES.server;
      });
    }
  });
  lobby.addEventListener('close', () => {
    // A waiting room keeps checking in the background, so the match starts
    // even if you closed this dialog.
    if (room && (!state || state.phase === 'waiting') && !inMatch) startPolling(3000);
  });
  $('place-random').addEventListener('click', () => {
    placed = completeRandomly([]);
    renderPlacing(state.opp.name || 'Your friend');
  });
  $('place-clear').addEventListener('click', () => {
    placed = [];
    renderPlacing(state.opp.name || 'Your friend');
  });
  placeConfirm.addEventListener('click', () => confirmPlacement(false));
  rematchButton.addEventListener('click', rematch);
  document.querySelectorAll('[data-leave-room]').forEach((button) => button.addEventListener('click', leaveRoom));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });

  // Resume a room after a reload, or open an invite link.
  const invite = new URLSearchParams(window.location.search).get('room');
  if (invite) {
    window.history.replaceState(null, '', window.location.pathname);
    if (room && room.code === invite.toUpperCase()) refresh();
    else openLobby(invite);
  } else if (room) {
    refresh();
    if (room.role === 'host') startPolling(3000);
  }

  // For tests and the curious.
  window.FindAircraftMatch = { state: () => state, placed: () => placed };
})();
