/**
 * user-login.js — Contributor Authentication & Registration Logic
 * Handles contributor selection, passcode verification, and registration.
 * Sets persistent session cookies and redirects to the questionnaire recorder.
 */

'use strict';

const tabBtnLogin = document.getElementById('tab-btn-login');
const tabBtnRegister = document.getElementById('tab-btn-register');

const formLogin = document.getElementById('form-contributor-login');
const formRegister = document.getElementById('form-contributor-register');

const selectLoginUser = document.getElementById('select-login-user');
const groupManualUser = document.getElementById('group-manual-username');
const inputLoginUser = document.getElementById('input-login-username');
const inputLoginPin = document.getElementById('input-login-pin');
const btnLoginSubmit = document.getElementById('btn-login-submit');

const inputRegUser = document.getElementById('input-reg-username');
const inputRegPin = document.getElementById('input-reg-pin');
const inputRegPinConfirm = document.getElementById('input-reg-pin-confirm');
const btnRegisterSubmit = document.getElementById('btn-register-submit');

const authError = document.getElementById('user-auth-error');
const authSuccess = document.getElementById('user-auth-success');

function showError(msg) {
  if (authSuccess) authSuccess.hidden = true;
  if (authError) {
    authError.hidden = false;
    authError.textContent = `❌ ${msg}`;
  }
}

function showSuccess(msg) {
  if (authError) authError.hidden = true;
  if (authSuccess) {
    authSuccess.hidden = false;
    authSuccess.textContent = `✅ ${msg}`;
  }
}

function clearMessages() {
  if (authError) authError.hidden = true;
  if (authSuccess) authSuccess.hidden = true;
}

// ── Tab Switching ──────────────────────────────────────────────────────────
function setTab(tab) {
  clearMessages();
  if (tab === 'login') {
    tabBtnLogin.classList.add('active');
    tabBtnRegister.classList.remove('active');
    formLogin.style.display = 'block';
    formRegister.style.display = 'none';
    if (selectLoginUser.value) {
      inputLoginPin.focus();
    } else {
      selectLoginUser.focus();
    }
  } else {
    tabBtnRegister.classList.add('active');
    tabBtnLogin.classList.remove('active');
    formRegister.style.display = 'block';
    formLogin.style.display = 'none';
    inputRegUser.focus();
  }
}

// ── Check Existing Contributor Session ─────────────────────────────────────
async function checkExistingSession() {
  try {
    const res = await fetch('/api/users/me');
    const data = await res.json();
    if (data && data.authenticated && data.user) {
      localStorage.setItem('dcs_audio_user', data.user.username);
      // Already authenticated, redirect to main collector
      window.location.replace('/');
    }
  } catch (_) {}
}

// ── Populate Registered Contributors List ──────────────────────────────────
async function loadContributorsList() {
  try {
    const res = await fetch('/api/users/list');
    const data = await res.json();
    const users = (data && data.users) || [];

    selectLoginUser.innerHTML = '<option value="">— Select registered contributor —</option>';
    for (const u of users) {
      const opt = document.createElement('option');
      opt.value = u.username;
      opt.textContent = `${u.displayName || u.username} (${u.username})`;
      selectLoginUser.appendChild(opt);
    }

    const optOther = document.createElement('option');
    optOther.value = '__other__';
    optOther.textContent = '✏️ Enter another username…';
    selectLoginUser.appendChild(optOther);

    // Pre-select last used user if available
    const lastUser = localStorage.getItem('dcs_audio_user');
    if (lastUser && users.some((u) => u.username === lastUser)) {
      selectLoginUser.value = lastUser;
      groupManualUser.style.display = 'none';
    } else if (users.length === 0) {
      // If no users registered yet, switch directly to register tab
      setTab('register');
    }
  } catch (err) {
    console.warn('Could not load contributors list:', err);
  }
}

// ── Event Handlers ─────────────────────────────────────────────────────────
function bindEvents() {
  tabBtnLogin.addEventListener('click', () => setTab('login'));
  tabBtnRegister.addEventListener('click', () => setTab('register'));

  selectLoginUser.addEventListener('change', () => {
    if (selectLoginUser.value === '__other__') {
      groupManualUser.style.display = 'block';
      inputLoginUser.focus();
    } else {
      groupManualUser.style.display = 'none';
      if (selectLoginUser.value) {
        inputLoginPin.focus();
      }
    }
  });

  // 1. Handle Contributor Sign In
  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMessages();

    let username = selectLoginUser.value;
    if (username === '__other__' || !username) {
      username = inputLoginUser.value.trim();
    }

    const pin = (inputLoginPin.value || '').trim();

    if (!username) {
      showError('Please choose or enter your contributor username.');
      return;
    }
    if (!pin) {
      showError('Please enter your 4-digit PIN.');
      return;
    }

    btnLoginSubmit.disabled = true;
    btnLoginSubmit.textContent = 'Signing in…';

    try {
      const res = await fetch('/api/users/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, pin }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to sign in.');
      }

      localStorage.setItem('dcs_audio_user', data.user.username);
      if (data.token) {
        sessionStorage.setItem('dcs_contributor_token', data.token);
      }

      showSuccess(`Welcome back, ${data.user.displayName || data.user.username}! Redirecting…`);
      setTimeout(() => {
        window.location.replace('/');
      }, 400);

    } catch (err) {
      showError(err.message);
      inputLoginPin.focus();
      inputLoginPin.select();
    } finally {
      btnLoginSubmit.disabled = false;
      btnLoginSubmit.textContent = 'Sign In 🎙️';
    }
  });

  // 2. Handle Contributor Registration
  formRegister.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMessages();

    const username = (inputRegUser.value || '').trim();
    const pin = (inputRegPin.value || '').trim();
    const pinConfirm = (inputRegPinConfirm.value || '').trim();

    if (!username) {
      showError('Please enter a username or contributor ID.');
      return;
    }
    if (pin.length < 4) {
      showError('Your PIN must be at least 4 digits or characters.');
      return;
    }
    if (pin !== pinConfirm) {
      showError('Passcode / PIN confirmation does not match.');
      inputRegPinConfirm.focus();
      return;
    }

    btnRegisterSubmit.disabled = true;
    btnRegisterSubmit.textContent = 'Creating profile…';

    try {
      const res = await fetch('/api/users/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, displayName: username, pin }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Registration failed.');
      }

      localStorage.setItem('dcs_audio_user', data.user.username);
      if (data.token) {
        sessionStorage.setItem('dcs_contributor_token', data.token);
      }

      showSuccess(`Profile created for ${data.user.displayName}! Launching recorder…`);
      setTimeout(() => {
        window.location.replace('/');
      }, 500);

    } catch (err) {
      showError(err.message);
      inputRegUser.focus();
    } finally {
      btnRegisterSubmit.disabled = false;
      btnRegisterSubmit.textContent = 'Create Contributor Profile 🚀';
    }
  });
}

// ── Init ───────────────────────────────────────────────────────────────────
(async function init() {
  bindEvents();
  await checkExistingSession();
  await loadContributorsList();
})();

