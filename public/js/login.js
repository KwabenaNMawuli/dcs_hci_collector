/**
 * login.js — Administrator Login Page Logic
 * Handles administrator passcode verification and routes to /admin on success.
 */

'use strict';

const loginForm = document.getElementById('admin-login-form');
const inputPassword = document.getElementById('admin-password-input');
const btnLogin = document.getElementById('btn-admin-login');
const loginError = document.getElementById('admin-login-error');

function getExistingToken() {
  return sessionStorage.getItem('dcs_admin_token') || localStorage.getItem('dcs_admin_token') || '';
}

async function safeFetchJson(url, options = {}) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (netErr) {
    throw new Error(`Network error: ${netErr.message || 'Could not connect to server'}`);
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  if (!contentType.includes('application/json')) {
    if (res.status === 404) {
      throw new Error('Server endpoint not found (404). Please ensure the backend is running with latest routes.');
    }
    if (res.status === 502 || res.status === 503) {
      throw new Error(`Server temporarily unavailable (${res.status}). The service might be starting up.`);
    }
    throw new Error(`Server returned status ${res.status} (non-JSON response).`);
  }

  let data;
  try {
    data = await res.json();
  } catch (parseErr) {
    throw new Error('Failed to parse server response as JSON.');
  }

  return { res, data };
}

// Check if user is already authenticated; if so, route directly to /admin
async function checkExistingAuth() {
  const token = getExistingToken();
  if (!token) return;

  try {
    const { data } = await safeFetchJson('/api/admin/verify', {
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': token,
      },
    });

    if (data && data.authenticated) {
      window.location.replace('/admin');
    }
  } catch (_) {
    // If invalid or server restarted, clear old token
    sessionStorage.removeItem('dcs_admin_token');
    localStorage.removeItem('dcs_admin_token');
  }
}

function bindLoginEvents() {
  if (!loginForm) return;

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = (inputPassword ? inputPassword.value : '').trim();
    if (!password) return;

    if (btnLogin) {
      btnLogin.disabled = true;
      btnLogin.textContent = 'Verifying…';
    }
    if (loginError) loginError.hidden = true;

    try {
      const { res, data } = await safeFetchJson('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        throw new Error((data && data.error) || 'Incorrect password');
      }

      // Store token across session and local storage
      sessionStorage.setItem('dcs_admin_token', data.token);
      localStorage.setItem('dcs_admin_token', data.token);

      // Route immediately to the admin portal
      window.location.href = '/admin';
    } catch (err) {
      if (loginError) {
        loginError.hidden = false;
        loginError.textContent = `❌ ${err.message}`;
      }
      if (inputPassword) {
        inputPassword.focus();
        inputPassword.select();
      }
    } finally {
      if (btnLogin) {
        btnLogin.disabled = false;
        btnLogin.textContent = 'Login 🔓';
      }
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    bindLoginEvents();
    checkExistingAuth();
  });
} else {
  bindLoginEvents();
  checkExistingAuth();
}
