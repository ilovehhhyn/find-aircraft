'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../js/store.js');

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

function localStore(storage) {
  return createStore({ storage: storage || memoryStorage(), crypto: globalThis.crypto, config: {} });
}

const code = (expected) => (error) => error.code === expected;

test('sign up, sign out and sign in again', async () => {
  const store = localStore();
  assert.equal(store.backend, 'local');
  assert.equal(store.session(), null);

  const created = await store.signUp('  Ada  ', 'test-pass-1');
  assert.equal(created.name, 'Ada');
  assert.equal(store.session().name, 'Ada');

  store.signOut();
  assert.equal(store.session(), null);
  await assert.rejects(store.signIn('Ada', 'wrong-pass'), code('bad_credentials'));
  await assert.rejects(store.signIn('Nobody', 'test-pass-1'), code('bad_credentials'));
  const back = await store.signIn('ada', 'test-pass-1');
  assert.equal(back.name, 'Ada');
});

test('names and passwords are validated, and names are unique ignoring case', async () => {
  const store = localStore();
  await assert.rejects(store.signUp('A', 'test-pass-1'), code('invalid_name'));
  await assert.rejects(store.signUp('bad<name>', 'test-pass-1'), code('invalid_name'));
  await assert.rejects(store.signUp('Grace', '123'), code('invalid_password'));
  await store.signUp('Grace', 'test-pass-1');
  await assert.rejects(store.signUp('GRACE', 'test-pass-2'), code('name_taken'));
});

test('passwords are not stored in the clear', async () => {
  const storage = memoryStorage();
  await localStore(storage).signUp('Linus', 'test-pass-plain');
  assert.ok(!storage.getItem('find-aircraft.players').includes('test-pass-plain'));
  assert.ok(!storage.getItem('find-aircraft.session').includes('test-pass-plain'));
});

test('a guest best is kept locally and moves into the account on sign up', async () => {
  const store = localStore();
  let result = await store.recordWin(31);
  assert.deepEqual(result, { best: 31, isBest: true, saved: true });
  result = await store.recordWin(40);
  assert.equal(result.isBest, false);
  assert.equal(store.best(), 31);

  const session = await store.signUp('Margaret', 'test-pass-1');
  assert.equal(session.best, 31);
  assert.equal(store.guestBest(), null);
  assert.deepEqual(await store.leaderboard(), [{ name: 'Margaret', best: 31 }]);
});

test('signing in keeps whichever best is lower', async () => {
  const store = localStore();
  await store.signUp('Barbara', 'test-pass-1');
  await store.recordWin(25);
  store.signOut();

  await store.recordWin(30); // as a guest, worse than the account's best
  assert.equal((await store.signIn('Barbara', 'test-pass-1')).best, 25);
  store.signOut();

  await store.recordWin(18); // as a guest, better
  assert.equal((await store.signIn('Barbara', 'test-pass-1')).best, 18);
});

test('the leaderboard lists the lowest scores first', async () => {
  const store = localStore();
  for (const [name, shots] of [['Katherine', 28], ['Dorothy', 19], ['Mary', 23]]) {
    await store.signUp(name, 'test-pass-1');
    await store.recordWin(shots);
    await store.recordWin(shots + 5);
    store.signOut();
  }
  await store.signUp('Annie', 'test-pass-1'); // never won: not listed
  assert.deepEqual(await store.leaderboard(), [
    { name: 'Dorothy', best: 19 },
    { name: 'Mary', best: 23 },
    { name: 'Katherine', best: 28 },
  ]);
  await assert.rejects(store.recordWin(1), code('invalid_score'));
});

test('the Supabase backend calls the database functions and maps errors', async () => {
  const calls = [];
  const replies = {
    fa_sign_up: { status: 200, body: { name: 'Ada', token: 'tok-1', best: null } },
    fa_submit_score: { status: 200, body: { name: 'Ada', best: 22 } },
    fa_leaderboard: { status: 200, body: [{ name: 'Ada', best: 22 }] },
    fa_sign_in: { status: 400, body: { code: 'P0001', message: 'bad_credentials' } },
  };
  const fetch = async (url, init) => {
    const name = url.split('/').pop();
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const reply = replies[name];
    return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
  };
  const store = createStore({
    storage: memoryStorage(),
    crypto: globalThis.crypto,
    fetch,
    config: { supabaseUrl: 'https://example.test/', supabaseAnonKey: 'public-key' },
  });
  assert.equal(store.backend, 'supabase');

  await store.signUp('Ada', 'test-pass-1');
  assert.equal(calls[0].url, 'https://example.test/rest/v1/rpc/fa_sign_up');
  assert.equal(calls[0].headers.apikey, 'public-key');
  assert.deepEqual(calls[0].body, { p_name: 'Ada', p_password: 'test-pass-1' });

  const win = await store.recordWin(22);
  assert.deepEqual(calls[1].body, { p_token: 'tok-1', p_shots: 22 });
  assert.deepEqual(win, { best: 22, isBest: true, saved: true });
  assert.deepEqual(await store.leaderboard(), [{ name: 'Ada', best: 22 }]);

  await assert.rejects(store.signIn('Ada', 'wrong-pass'), code('bad_credentials'));
});

test('a win is kept locally when the leaderboard cannot be reached', async () => {
  let online = true;
  const fetch = async (url) => {
    if (!online) throw new TypeError('offline');
    const name = url.split('/').pop();
    const body = name === 'fa_sign_up' ? { name: 'Ada', token: 'tok-1', best: null } : {};
    return { ok: true, status: 200, json: async () => body };
  };
  const store = createStore({
    storage: memoryStorage(),
    crypto: globalThis.crypto,
    fetch,
    config: { supabaseUrl: 'https://example.test', supabaseAnonKey: 'public-key' },
  });
  await store.signUp('Ada', 'test-pass-1');
  online = false;
  const win = await store.recordWin(20);
  assert.equal(win.saved, false);
  assert.equal(win.error, 'network');
  assert.equal(store.guestBest(), 20);
  await assert.rejects(store.leaderboard(), code('network'));
});

test('a best score from a browser-only account survives the switch to Supabase', async () => {
  const storage = memoryStorage();
  const before = localStore(storage);
  await before.signUp('Helen', 'test-pass-1');
  await before.recordWin(15);

  const calls = [];
  const fetch = async (url, init) => {
    const name = url.split('/').pop();
    calls.push({ name, body: JSON.parse(init.body) });
    const body = name === 'fa_sign_up' ? { name: 'Helen', token: 'tok-9', best: null } : { name: 'Helen', best: 15 };
    return { ok: true, status: 200, json: async () => body };
  };
  const after = createStore({
    storage,
    crypto: globalThis.crypto,
    fetch,
    config: { supabaseUrl: 'https://example.test', supabaseAnonKey: 'public-key' },
  });
  assert.equal(after.session(), null);
  assert.equal(after.best(), 15);

  const session = await after.signUp('Helen', 'test-pass-2');
  assert.equal(session.best, 15);
  assert.deepEqual(calls[1], { name: 'fa_submit_score', body: { p_token: 'tok-9', p_shots: 15 } });
  assert.equal(after.guestBest(), null);
});
