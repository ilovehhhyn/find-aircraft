/*
 * Find Aircraft: accounts, sessions and the leaderboard.
 *
 * Two backends expose the same async interface:
 *   supabase  shared between everyone, through the functions in
 *             supabase/schema.sql
 *   local     this browser only, kept in localStorage; used until
 *             js/config.js is filled in
 *
 * Failures are thrown as Error objects with a `code`:
 *   invalid_name, invalid_password, name_taken, bad_credentials,
 *   bad_session, invalid_score, network, server
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FindAircraftStore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SESSION_KEY = 'find-aircraft.session';
  const PLAYERS_KEY = 'find-aircraft.players';
  const GUEST_BEST_KEY = 'find-aircraft.best';
  const NAME_PATTERN = /^[A-Za-z0-9 _-]{2,20}$/;
  const KNOWN_CODES = [
    'invalid_name', 'invalid_password', 'name_taken', 'bad_credentials',
    'bad_session', 'invalid_score',
  ];

  function fail(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function checkName(name) {
    const trimmed = String(name || '').trim();
    if (!NAME_PATTERN.test(trimmed)) throw fail('invalid_name');
    return trimmed;
  }

  function checkPassword(password) {
    const value = String(password || '');
    if (value.length < 6 || value.length > 72) throw fail('invalid_password');
    return value;
  }

  function checkShots(shots) {
    if (!Number.isInteger(shots) || shots < 2 || shots > 100) throw fail('invalid_score');
    return shots;
  }

  /* localStorage can be missing or refuse writes; treat that as empty. */
  function safeStorage(storage) {
    return {
      get(key) {
        try {
          const raw = storage.getItem(key);
          return raw === null || raw === undefined ? null : JSON.parse(raw);
        } catch (error) {
          return null;
        }
      },
      set(key, value) {
        try {
          storage.setItem(key, JSON.stringify(value));
        } catch (error) {
          /* Not saved; the game carries on without it. */
        }
      },
      remove(key) {
        try {
          storage.removeItem(key);
        } catch (error) {
          /* Nothing to do. */
        }
      },
    };
  }

  function randomId(cryptoApi) {
    if (cryptoApi && cryptoApi.randomUUID) return cryptoApi.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  async function digest(cryptoApi, text) {
    if (cryptoApi && cryptoApi.subtle) {
      const bytes = new TextEncoder().encode(text);
      const hash = await cryptoApi.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    // Pages not served over HTTPS have no SubtleCrypto. This fallback only
    // ever guards scores kept in the same browser.
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return 'fnv-' + (h >>> 0).toString(16);
  }

  /* Accounts kept in this browser only. */
  function localBackend(store, cryptoApi) {
    const players = () => store.get(PLAYERS_KEY) || {};
    const save = (all) => store.set(PLAYERS_KEY, all);
    const publicView = (p) => ({ name: p.name, token: p.token, best: p.best });

    return {
      kind: 'local',
      async signUp(name, password) {
        const all = players();
        const key = name.toLowerCase();
        if (all[key]) throw fail('name_taken');
        const salt = randomId(cryptoApi);
        all[key] = {
          name,
          salt,
          hash: await digest(cryptoApi, salt + password),
          token: randomId(cryptoApi),
          best: null,
          created: Date.now(),
        };
        save(all);
        return publicView(all[key]);
      },
      async signIn(name, password) {
        const player = players()[name.toLowerCase()];
        if (!player || player.hash !== (await digest(cryptoApi, player.salt + password))) {
          throw fail('bad_credentials');
        }
        return publicView(player);
      },
      async submit(token, shots) {
        const all = players();
        const player = Object.values(all).find((p) => p.token === token);
        if (!player) throw fail('bad_session');
        player.best = player.best === null ? shots : Math.min(player.best, shots);
        save(all);
        return { name: player.name, best: player.best };
      },
      async leaderboard() {
        return Object.values(players())
          .filter((p) => p.best !== null)
          .sort((a, b) => a.best - b.best || a.created - b.created)
          .slice(0, 50)
          .map((p) => ({ name: p.name, best: p.best }));
      },
    };
  }

  /* Accounts shared between everyone, through Supabase's REST interface. */
  function supabaseBackend(url, key, fetchFn) {
    async function rpc(name, args) {
      let response;
      try {
        response = await fetchFn(url.replace(/\/+$/, '') + '/rest/v1/rpc/' + name, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: key,
            Authorization: 'Bearer ' + key,
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
        /* An empty or non-JSON body is handled below. */
      }
      if (!response.ok) {
        const code = data && KNOWN_CODES.includes(data.message) ? data.message : 'server';
        throw fail(code);
      }
      return data;
    }

    return {
      kind: 'supabase',
      signUp: (name, password) => rpc('fa_sign_up', { p_name: name, p_password: password }),
      signIn: (name, password) => rpc('fa_sign_in', { p_name: name, p_password: password }),
      submit: (token, shots) => rpc('fa_submit_score', { p_token: token, p_shots: shots }),
      leaderboard: async () => (await rpc('fa_leaderboard', {})) || [],
    };
  }

  /*
   * Build a store. Everything it touches is passed in, so tests can run it
   * in Node with a fake storage and fetch.
   */
  function createStore(options) {
    const config = options.config || {};
    const store = safeStorage(options.storage);
    const remote = Boolean(config.supabaseUrl && config.supabaseAnonKey);
    const backend = remote
      ? supabaseBackend(config.supabaseUrl, config.supabaseAnonKey, options.fetch)
      : localBackend(store, options.crypto);

    /*
     * A session left over from the other backend cannot be used here. Keep
     * its best score as a guest best, so it follows the player into the
     * account they make next, then drop it.
     */
    (function retireForeignSession() {
      const saved = store.get(SESSION_KEY);
      if (!saved || saved.backend === backend.kind) return;
      const kept = store.get(GUEST_BEST_KEY);
      if (Number.isInteger(saved.best) && saved.best > 0 && !(Number.isInteger(kept) && kept <= saved.best)) {
        store.set(GUEST_BEST_KEY, saved.best);
      }
      store.remove(SESSION_KEY);
    })();

    function session() {
      const saved = store.get(SESSION_KEY);
      return saved && saved.backend === backend.kind && saved.name && saved.token ? saved : null;
    }

    function remember(player) {
      const next = {
        backend: backend.kind,
        name: player.name,
        token: player.token,
        best: player.best === undefined ? null : player.best,
      };
      store.set(SESSION_KEY, next);
      return next;
    }

    function guestBest() {
      const value = store.get(GUEST_BEST_KEY);
      return Number.isInteger(value) && value > 0 ? value : null;
    }

    /* A best score earned before signing in moves into the account. */
    async function adoptGuestBest(current) {
      const earned = guestBest();
      if (earned === null) return current;
      if (current.best === null || earned < current.best) {
        const result = await backend.submit(current.token, earned);
        current = remember({ name: current.name, token: current.token, best: result.best });
      }
      store.remove(GUEST_BEST_KEY);
      return current;
    }

    return {
      /* 'supabase' when the leaderboard is shared, 'local' for this browser only. */
      backend: backend.kind,
      session,
      guestBest,

      /* The best score to show: the account's when signed in, else the guest's. */
      best() {
        const current = session();
        return current ? current.best : guestBest();
      },

      async signUp(name, password) {
        const player = await backend.signUp(checkName(name), checkPassword(password));
        return adoptGuestBest(remember(player));
      },

      async signIn(name, password) {
        const cleanName = String(name || '').trim();
        if (!cleanName || !password) throw fail('bad_credentials');
        const player = await backend.signIn(cleanName, String(password));
        return adoptGuestBest(remember(player));
      },

      signOut() {
        store.remove(SESSION_KEY);
      },

      /*
       * Record a won light-mode game. Returns { best, isBest, saved }.
       * `saved` is false when the account could not be reached; the score is
       * then kept as a guest best so it is not lost.
       */
      async recordWin(shots) {
        checkShots(shots);
        const current = session();
        const previous = current ? current.best : guestBest();
        const isBest = previous === null || shots < previous;
        if (!current) {
          if (isBest) store.set(GUEST_BEST_KEY, shots);
          return { best: isBest ? shots : previous, isBest, saved: true };
        }
        try {
          const result = await backend.submit(current.token, shots);
          remember({ name: current.name, token: current.token, best: result.best });
          return { best: result.best, isBest, saved: true };
        } catch (error) {
          if (error.code === 'bad_session') store.remove(SESSION_KEY);
          const kept = guestBest();
          if (kept === null || shots < kept) store.set(GUEST_BEST_KEY, shots);
          return { best: isBest ? shots : previous, isBest, saved: false, error: error.code };
        }
      },

      leaderboard: () => backend.leaderboard(),
    };
  }

  const api = { createStore, NAME_PATTERN };
  if (typeof window !== 'undefined' && window.document) {
    api.store = createStore({
      config: window.FIND_AIRCRAFT_CONFIG,
      storage: (function () {
        try {
          return window.localStorage;
        } catch (error) {
          return { getItem: () => null, setItem() {}, removeItem() {} };
        }
      })(),
      fetch: (input, init) => window.fetch(input, init),
      crypto: window.crypto,
    });
  }
  return api;
});
