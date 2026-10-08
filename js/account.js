/* Find Aircraft: the sign up / sign in dialog, the account button and the leaderboard. */
(function () {
  'use strict';

  const store = window.FindAircraftStore.store;
  const WELCOMED_KEY = 'find-aircraft.welcomed';
  const MESSAGES = {
    invalid_name: 'Names are 2 to 20 characters: letters, numbers, spaces, hyphens or underscores.',
    invalid_password: 'Passwords need at least 6 characters.',
    name_taken: 'That name is taken. Pick another, or sign in if it is yours.',
    bad_credentials: 'That name and password do not match an account.',
    network: 'The leaderboard could not be reached. Check your connection and try again.',
    server: 'Something went wrong on the leaderboard server. Try again in a moment.',
  };

  const accountDialog = document.getElementById('account-dialog');
  const accountButton = document.getElementById('open-account');
  const accountLabel = document.getElementById('account-label');
  const signedOut = document.getElementById('account-signed-out');
  const signedIn = document.getElementById('account-signed-in');
  const tabSignUp = document.getElementById('tab-sign-up');
  const tabSignIn = document.getElementById('tab-sign-in');
  const form = document.getElementById('account-form');
  const nameInput = document.getElementById('account-name');
  const passwordInput = document.getElementById('account-password');
  const passwordLabel = document.getElementById('account-password-label');
  const hint = document.getElementById('account-hint');
  const errorEl = document.getElementById('account-error');
  const submitButton = document.getElementById('account-submit');
  const nameHeading = document.getElementById('account-name-heading');
  const bestLine = document.getElementById('account-best');
  const signOutButton = document.getElementById('sign-out');

  const boardDialog = document.getElementById('leaderboard-dialog');
  const boardButton = document.getElementById('open-leaderboard');
  const boardMessage = document.getElementById('leaderboard-message');
  const boardList = document.getElementById('leaderboard-list');
  const boardNote = document.getElementById('leaderboard-note');

  let tab = 'sign-up';

  function announceChange() {
    document.dispatchEvent(new CustomEvent('find-aircraft:account'));
  }

  function showError(code) {
    errorEl.textContent = MESSAGES[code] || MESSAGES.server;
    errorEl.hidden = false;
  }

  function selectTab(next) {
    tab = next;
    const signingUp = tab === 'sign-up';
    tabSignUp.setAttribute('aria-selected', String(signingUp));
    tabSignIn.setAttribute('aria-selected', String(!signingUp));
    tabSignUp.tabIndex = signingUp ? 0 : -1;
    tabSignIn.tabIndex = signingUp ? -1 : 0;
    form.setAttribute('aria-labelledby', signingUp ? 'tab-sign-up' : 'tab-sign-in');
    passwordLabel.textContent = signingUp ? 'Set password' : 'Password';
    passwordInput.autocomplete = signingUp ? 'new-password' : 'current-password';
    hint.hidden = !signingUp;
    submitButton.textContent = signingUp ? 'Sign up' : 'Sign in';
    errorEl.hidden = true;
  }

  /* The toolbar button names the player once they are signed in. */
  function render() {
    const session = store.session();
    accountLabel.textContent = session ? session.name : 'Sign in';
    accountButton.setAttribute('aria-label', session ? 'Account: ' + session.name : 'Sign up or sign in');
    signedOut.hidden = Boolean(session);
    signedIn.hidden = !session;
    accountDialog.setAttribute('aria-labelledby', session ? 'account-name-heading' : 'account-title');
    if (session) {
      nameHeading.textContent = session.name;
      bestLine.textContent =
        session.best === null
          ? 'No wins yet. Find both aircraft in light mode to set a score.'
          : 'Best game: ' + session.best + ' shots.';
    }
  }

  function openAccount() {
    render();
    errorEl.hidden = true;
    passwordInput.value = '';
    if (!accountDialog.open) accountDialog.showModal();
  }

  async function onSubmit(event) {
    event.preventDefault();
    errorEl.hidden = true;
    submitButton.disabled = true;
    try {
      if (tab === 'sign-up') await store.signUp(nameInput.value, passwordInput.value);
      else await store.signIn(nameInput.value, passwordInput.value);
      form.reset();
      render();
      announceChange();
      accountDialog.close();
    } catch (error) {
      showError(error.code);
    } finally {
      submitButton.disabled = false;
    }
  }

  function row(rank, entry, isYou) {
    const item = document.createElement('li');
    if (isYou) item.className = 'is-you';
    const place = document.createElement('span');
    place.className = 'rank';
    place.textContent = String(rank);
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = entry.name + (isYou ? ' (you)' : '');
    const score = document.createElement('span');
    score.textContent = entry.best + ' shots';
    item.append(place, who, score);
    return item;
  }

  async function openLeaderboard() {
    boardList.replaceChildren();
    boardMessage.textContent = 'Loading scores.';
    boardNote.hidden = store.backend !== 'local';
    boardNote.textContent =
      'The shared leaderboard is not connected yet, so this lists accounts made in this browser only.';
    if (!boardDialog.open) boardDialog.showModal();

    let entries;
    try {
      entries = await store.leaderboard();
    } catch (error) {
      boardMessage.textContent = MESSAGES[error.code] || MESSAGES.server;
      return;
    }
    if (entries.length === 0) {
      boardMessage.textContent = 'No scores yet. Sign up and find both aircraft in light mode to be first.';
      return;
    }
    const session = store.session();
    const mine = session ? session.name.toLowerCase() : null;
    boardMessage.textContent = '';
    boardList.replaceChildren(
      ...entries.map((entry, index) => row(index + 1, entry, entry.name.toLowerCase() === mine))
    );
  }

  /* A visit starts with the sign up dialog unless the player already chose. */
  function welcome() {
    let welcomed = false;
    try {
      welcomed = window.sessionStorage.getItem(WELCOMED_KEY) === '1';
    } catch (error) {
      /* Without session storage the dialog simply shows on each load. */
    }
    if (!store.session() && !welcomed) openAccount();
  }

  accountDialog.addEventListener('close', () => {
    try {
      window.sessionStorage.setItem(WELCOMED_KEY, '1');
    } catch (error) {
      /* See welcome(). */
    }
  });

  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => button.closest('dialog').close());
  });
  // Clicking the dimmed area outside a dialog closes it.
  [accountDialog, boardDialog].forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

  tabSignUp.addEventListener('click', () => selectTab('sign-up'));
  tabSignIn.addEventListener('click', () => selectTab('sign-in'));
  [tabSignUp, tabSignIn].forEach((button) => {
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const other = button === tabSignUp ? tabSignIn : tabSignUp;
      selectTab(other === tabSignUp ? 'sign-up' : 'sign-in');
      other.focus();
    });
  });
  form.addEventListener('submit', onSubmit);
  signOutButton.addEventListener('click', () => {
    store.signOut();
    render();
    announceChange();
    accountDialog.close();
  });
  accountButton.addEventListener('click', openAccount);
  boardButton.addEventListener('click', openLeaderboard);
  // A new score may change the signed-in player's best.
  document.addEventListener('find-aircraft:score', render);

  selectTab('sign-up');
  render();
  welcome();
})();
