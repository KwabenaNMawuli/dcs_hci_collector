/**
 * user-login.js — Contributor Authentication & Registration Logic
 * Handles private contributor login (no other users exposed) and registration.
 * Remembers the current user's identity on their device and sets persistent session cookies.
 */

'use strict';

const tabBtnLogin = document.getElementById('tab-btn-login');
const tabBtnRegister = document.getElementById('tab-btn-register');

const formLogin = document.getElementById('form-contributor-login');
const formRegister = document.getElementById('form-contributor-register');

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
    if (inputLoginUser && inputLoginUser.value.trim()) {
      inputLoginPin.focus();
    } else if (inputLoginUser) {
      inputLoginUser.focus();
    }
  } else {
    tabBtnRegister.classList.add('active');
    tabBtnLogin.classList.remove('active');
    formRegister.style.display = 'block';
    formLogin.style.display = 'none';
    if (inputRegUser) inputRegUser.focus();
  }
}

// ── Check Existing Contributor Session ─────────────────────────────────────
async function checkExistingSession() {
  try {
    const res = await fetch('/api/users/me');
    const data = await res.json();
    if (data && data.authenticated && data.user) {
      localStorage.setItem('dcs_audio_user', data.user.username);
      if (data.user.practiceApproved) {
        window.location.replace('/');
      } else {
        window.location.replace('/practice.html');
      }
    }
  } catch (_) {}
}

// ── Restore Remembered Username on This Device ──────────────────────────────
function restoreRememberedUser() {
  const remembered = localStorage.getItem('dcs_audio_user');
  if (remembered && remembered !== 'default_user' && inputLoginUser) {
    inputLoginUser.value = remembered;
    if (inputLoginPin) inputLoginPin.focus();
  } else if (inputLoginUser) {
    inputLoginUser.focus();
  }
}

// ── Event Handlers ─────────────────────────────────────────────────────────
function bindEvents() {
  tabBtnLogin.addEventListener('click', () => setTab('login'));
  tabBtnRegister.addEventListener('click', () => setTab('register'));

  // 1. Handle Contributor Sign In
  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMessages();

    const username = (inputLoginUser ? inputLoginUser.value : '').trim();
    const pin = (inputLoginPin ? inputLoginPin.value : '').trim();

    if (!username) {
      showError('Please enter your contributor username.');
      if (inputLoginUser) inputLoginUser.focus();
      return;
    }
    if (!pin) {
      showError('Please enter your 4-digit PIN.');
      if (inputLoginPin) inputLoginPin.focus();
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

      // Persist this contributor's username on their device
      localStorage.setItem('dcs_audio_user', data.user.username);
      if (data.token) {
        sessionStorage.setItem('dcs_contributor_token', data.token);
      }

      const isApproved = Boolean(data.user && data.user.practiceApproved);
      const targetUrl = isApproved ? '/' : '/practice.html';
      const welcomeMsg = isApproved
        ? `Welcome back, ${data.user.displayName || data.user.username}! Redirecting to recorder…`
        : `Welcome back, ${data.user.displayName || data.user.username}! Loading practice round…`;

      showSuccess(welcomeMsg);
      setTimeout(() => {
        window.location.replace(targetUrl);
      }, 400);

    } catch (err) {
      showError(err.message);
      if (inputLoginPin) {
        inputLoginPin.focus();
        inputLoginPin.select();
      }
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
      inputRegUser.focus();
      return;
    }
    if (pin.length < 4) {
      showError('Your PIN must be at least 4 digits or characters.');
      inputRegPin.focus();
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

      // Persist this contributor's username on their device
      localStorage.setItem('dcs_audio_user', data.user.username);
      if (data.token) {
        sessionStorage.setItem('dcs_contributor_token', data.token);
      }

      showSuccess(`Profile created for ${data.user.displayName}! Directing to practice round…`);
      setTimeout(() => {
        window.location.replace('/practice.html');
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
  restoreRememberedUser();
})();
