/**
 * admin.js — Admin Dashboard Logic
 * Protected by admin passcode authentication wall.
 * Fetches overview statistics, user lists, and audio takes.
 * Provides in-line audio playback, deletion, user filtering, and renaming.
 */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let overviewData = null;
let allRecordings = [];
let currentFilterUser = 'all';
let currentFilterLang = 'all';
let currentFilterTrack = 'all';
let includePractice = false;
let searchQuery = '';

// ── DOM References ─────────────────────────────────────────────────────────
const authWall = document.getElementById('admin-auth-wall');
const loginForm = document.getElementById('admin-login-form');
const inputPassword = document.getElementById('admin-password-input');
const btnLogin = document.getElementById('btn-admin-login');
const loginError = document.getElementById('admin-login-error');
const btnLogout = document.getElementById('btn-logout-admin');

const kpiAkanQs = document.getElementById('kpi-akan-questions');
const kpiEweQs = document.getElementById('kpi-ewe-questions');
const kpiTotalUsers = document.getElementById('kpi-total-users');
const kpiTotalRecordings = document.getElementById('kpi-total-recordings');

const usersTableBody = document.getElementById('users-table-body');
const recordingsTableBody = document.getElementById('recordings-table-body');
const recordingsCountBadge = document.getElementById('recordings-count-badge');

const filterUser = document.getElementById('filter-user');
const filterLang = document.getElementById('filter-lang');
const filterTrack = document.getElementById('filter-track');
const checkPractice = document.getElementById('check-practice');
const searchInput = document.getElementById('admin-search');
const btnRefresh = document.getElementById('btn-refresh-admin');

// Rename modal
const renameModal = document.getElementById('rename-modal');
const renameModalClose = document.getElementById('rename-modal-close');
const renameCurrentUser = document.getElementById('rename-current-user');
const renameNewUser = document.getElementById('rename-new-user');
const btnCancelRename = document.getElementById('btn-cancel-rename');
const btnConfirmRename = document.getElementById('btn-confirm-rename');

// Drive auth elements
const badgeDrive = document.getElementById('badge-drive-connected');
const btnAuthDrive = document.getElementById('btn-auth-drive');

// ── Init ───────────────────────────────────────────────────────────────────
(async function initAdmin() {
  bindEvents();
  await checkAuthStatus();
  await checkAdminSession();
})();

function getAdminToken() {
  return sessionStorage.getItem('dcs_admin_token') || '';
}

function getAdminHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-admin-token': getAdminToken(),
  };
}

function showAuthWall() {
  authWall.hidden = false;
  loginError.hidden = true;
  loginError.textContent = '';
  inputPassword.value = '';
  inputPassword.focus();
}

function hideAuthWall() {
  authWall.hidden = true;
}

async function checkAdminSession() {
  const token = getAdminToken();
  if (!token) {
    showAuthWall();
    return;
  }

  try {
    const res = await fetch('/api/admin/verify', {
      headers: getAdminHeaders(),
    });
    const data = await res.json();
    if (data.authenticated) {
      hideAuthWall();
      await loadAdminData();
    } else {
      sessionStorage.removeItem('dcs_admin_token');
      showAuthWall();
    }
  } catch (err) {
    showAuthWall();
  }
}

function bindEvents() {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = (inputPassword.value || '').trim();
    if (!password) return;

    btnLogin.disabled = true;
    btnLogin.textContent = 'Verifying…';
    loginError.hidden = true;

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Incorrect password');
      }

      sessionStorage.setItem('dcs_admin_token', data.token);
      hideAuthWall();
      await loadAdminData();
    } catch (err) {
      loginError.hidden = false;
      loginError.textContent = `❌ ${err.message}`;
      inputPassword.focus();
      inputPassword.select();
    } finally {
      btnLogin.disabled = false;
      btnLogin.textContent = 'Unlock 🔓';
    }
  });

  btnLogout.addEventListener('click', async () => {
    try {
      await fetch('/api/admin/logout', {
        method: 'POST',
        headers: getAdminHeaders(),
      });
    } catch (_) {}
    sessionStorage.removeItem('dcs_admin_token');
    showAuthWall();
  });

  btnRefresh.addEventListener('click', loadAdminData);

  filterUser.addEventListener('change', () => {
    currentFilterUser = filterUser.value;
    filterAndRenderRecordings();
  });

  filterLang.addEventListener('change', () => {
    currentFilterLang = filterLang.value;
    filterAndRenderRecordings();
  });

  filterTrack.addEventListener('change', () => {
    currentFilterTrack = filterTrack.value;
    filterAndRenderRecordings();
  });

  checkPractice.addEventListener('change', () => {
    includePractice = checkPractice.checked;
    filterAndRenderRecordings();
  });

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim().toLowerCase();
    filterAndRenderRecordings();
  });

  // Modal events
  renameModalClose.addEventListener('click', closeRenameModal);
  btnCancelRename.addEventListener('click', closeRenameModal);
  btnConfirmRename.addEventListener('click', handleRenameSubmit);
}

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth-status');
    const data = await res.json();
    if (data.authenticated) {
      if (badgeDrive) badgeDrive.style.display = 'inline-flex';
      if (btnAuthDrive) btnAuthDrive.style.display = 'none';
    } else {
      if (btnAuthDrive) btnAuthDrive.style.display = 'inline-flex';
      if (badgeDrive) badgeDrive.style.display = 'none';
    }
  } catch (err) {
    console.warn('Could not check auth status:', err);
  }
}

// ── Data Loading ───────────────────────────────────────────────────────────
async function loadAdminData() {
  btnRefresh.disabled = true;
  btnRefresh.textContent = '⏳ Loading…';

  try {
    // 1. Load overview stats
    const overviewRes = await fetch('/api/admin/overview', {
      headers: getAdminHeaders(),
    });

    if (overviewRes.status === 401) {
      showAuthWall();
      return;
    }

    if (!overviewRes.ok) throw new Error('Failed to load overview data');
    overviewData = await overviewRes.json();

    renderKPIs(overviewData);
    renderUsersTable(overviewData.users || []);
    populateUserFilter(overviewData.userList || []);

    // 2. Load recordings list
    const recordingsRes = await fetch('/api/admin/recordings?practice=true', {
      headers: getAdminHeaders(),
    });

    if (recordingsRes.status === 401) {
      showAuthWall();
      return;
    }

    if (!recordingsRes.ok) throw new Error('Failed to load recordings list');
    const recData = await recordingsRes.json();
    allRecordings = recData.recordings || [];

    filterAndRenderRecordings();

  } catch (err) {
    console.error('Error loading admin data:', err);
  } finally {
    btnRefresh.disabled = false;
    btnRefresh.textContent = '🔄 Refresh Data';
  }
}

// ── KPI Rendering ──────────────────────────────────────────────────────────
function renderKPIs(data) {
  if (kpiAkanQs) kpiAkanQs.textContent = data.questionnaire.akanTotal || 0;
  if (kpiEweQs) kpiEweQs.textContent = data.questionnaire.eweTotal || 0;
  if (kpiTotalUsers) kpiTotalUsers.textContent = (data.users && data.users.length) || 0;
  if (kpiTotalRecordings) kpiTotalRecordings.textContent = data.totalRecordings || 0;
}

// ── Users Table Rendering ──────────────────────────────────────────────────
function renderUsersTable(users) {
  if (!users || users.length === 0) {
    usersTableBody.innerHTML = `<tr><td colspan="6" class="text-center py-4" style="color:#64748b;">No contributor recordings found yet.</td></tr>`;
    return;
  }

  usersTableBody.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <span class="user-badge">👤 ${escapeHtml(u.user)}</span>
      </td>
      <td><strong>${u.totalRecordings}</strong> takes</td>
      <td><span class="lang-badge akan">${u.akanCount}</span></td>
      <td><span class="lang-badge ewe">${u.eweCount}</span></td>
      <td style="font-size:0.82rem;color:#475569;">
        🎙️ ${u.questionTracks} prompt / 📋 ${u.optionsTracks} opts
      </td>
      <td>
        <div class="btn-action-group">
          <button type="button" class="btn-icon-link btn-filter-user" data-user="${escapeHtml(u.user)}" title="Filter recordings for this user">
            🔍 Filter Takes
          </button>
          <button type="button" class="btn-icon-link btn-rename-user" data-user="${escapeHtml(u.user)}" title="Rename or merge user folder">
            ✏️ Rename
          </button>
        </div>
      </td>
    `;
    usersTableBody.appendChild(tr);
  }

  usersTableBody.querySelectorAll('.btn-filter-user').forEach(btn => {
    btn.addEventListener('click', () => {
      const u = btn.dataset.user;
      filterUser.value = u;
      currentFilterUser = u;
      filterAndRenderRecordings();
      document.getElementById('recordings-table').scrollIntoView({ behavior: 'smooth' });
    });
  });

  usersTableBody.querySelectorAll('.btn-rename-user').forEach(btn => {
    btn.addEventListener('click', () => {
      openRenameModal(btn.dataset.user);
    });
  });
}

function populateUserFilter(users) {
  const currentVal = filterUser.value;
  filterUser.innerHTML = '<option value="all">All Contributors</option>';
  for (const u of users) {
    const opt = document.createElement('option');
    opt.value = u;
    opt.textContent = u;
    filterUser.appendChild(opt);
  }
  if (users.includes(currentVal)) {
    filterUser.value = currentVal;
  }
}

// ── Filter & Render Recordings ─────────────────────────────────────────────
function filterAndRenderRecordings() {
  let list = allRecordings;

  if (!includePractice) {
    list = list.filter(r => !r.isPractice);
  }

  if (currentFilterUser !== 'all') {
    list = list.filter(r => r.user.toLowerCase() === currentFilterUser.toLowerCase());
  }

  if (currentFilterLang !== 'all') {
    list = list.filter(r => r.lang.toLowerCase() === currentFilterLang.toLowerCase());
  }

  if (currentFilterTrack !== 'all') {
    list = list.filter(r => r.targetType.toLowerCase() === currentFilterTrack.toLowerCase());
  }

  if (searchQuery) {
    list = list.filter(r =>
      r.name.toLowerCase().includes(searchQuery) ||
      r.questionId.toLowerCase().includes(searchQuery) ||
      r.user.toLowerCase().includes(searchQuery)
    );
  }

  recordingsCountBadge.textContent = `Showing ${list.length} recording${list.length === 1 ? '' : 's'}`;

  if (list.length === 0) {
    recordingsTableBody.innerHTML = `<tr><td colspan="7" class="text-center py-4" style="color:#64748b;">No recordings match the active filters.</td></tr>`;
    return;
  }

  recordingsTableBody.innerHTML = '';
  for (const r of list) {
    const tr = document.createElement('tr');
    const sizeKB = r.size ? Math.round(r.size / 1024) + ' KB' : '—';
    const trackBadge = r.isPractice ? 'practice' : r.targetType;
    const trackLabel = r.isPractice ? 'Practice' : (r.targetType === 'options' ? 'Options' : 'Prompt');

    tr.innerHTML = `
      <td><span class="user-badge">${escapeHtml(r.user)}</span></td>
      <td><strong>${escapeHtml(r.questionId)}</strong></td>
      <td><span class="lang-badge ${r.lang}">${escapeHtml(r.lang)}</span></td>
      <td><span class="track-badge-tag ${trackBadge}">${trackLabel}</span></td>
      <td style="font-size:0.8rem;color:#475569;">
        <span style="display:block;font-weight:500;">${escapeHtml(r.name)}</span>
        <span style="font-size:0.75rem;color:#94a3b8;">${sizeKB}</span>
      </td>
      <td class="audio-cell">
        <audio controls preload="none" src="${r.streamUrl}"></audio>
      </td>
      <td>
        <div class="btn-action-group">
          ${r.webViewLink ? `<a href="${r.webViewLink}" target="_blank" class="btn-icon-link btn-drive" title="Open in Google Drive">☁️ Drive</a>` : ''}
          <button type="button" class="btn-icon-link btn-delete" data-user="${escapeHtml(r.user)}" data-filename="${escapeHtml(r.name)}" data-fileid="${escapeHtml(r.fileId || '')}" title="Delete this recording">
            🗑️ Delete
          </button>
        </div>
      </td>
    `;
    recordingsTableBody.appendChild(tr);
  }

  recordingsTableBody.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const u = btn.dataset.user;
      const fn = btn.dataset.filename;
      const fid = btn.dataset.fileid;

      if (!confirm(`Are you sure you want to delete "${fn}" for contributor "${u}"?\nThis deletes it from both Google Drive and local storage.`)) {
        return;
      }

      btn.disabled = true;
      btn.textContent = '⏳ Deleting…';

      try {
        const delRes = await fetch('/api/admin/recording', {
          method: 'DELETE',
          headers: getAdminHeaders(),
          body: JSON.stringify({ user: u, filename: fn, fileId: fid }),
        });
        const delData = await delRes.json();
        if (!delRes.ok) throw new Error(delData.error || 'Delete failed');

        allRecordings = allRecordings.filter(x => !(x.name === fn && x.user === u));
        filterAndRenderRecordings();
      } catch (err) {
        alert('Could not delete recording: ' + err.message);
        btn.disabled = false;
        btn.textContent = '🗑️ Delete';
      }
    });
  });
}

// ── Rename User Modal ──────────────────────────────────────────────────────
function openRenameModal(username) {
  renameCurrentUser.value = username;
  renameNewUser.value = '';
  renameModal.hidden = false;
  renameNewUser.focus();
}

function closeRenameModal() {
  renameModal.hidden = true;
}

async function handleRenameSubmit() {
  const oldUser = renameCurrentUser.value.trim();
  const newUser = renameNewUser.value.trim().replace(/[^a-zA-Z0-9_\-\s]/g, '').replace(/\s+/g, '_');

  if (!newUser || newUser === oldUser) {
    alert('Please enter a valid, different contributor name.');
    return;
  }

  btnConfirmRename.disabled = true;
  btnConfirmRename.textContent = '⏳ Renaming…';

  try {
    const res = await fetch('/api/admin/rename-user', {
      method: 'POST',
      headers: getAdminHeaders(),
      body: JSON.stringify({ oldUser, newUser }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Rename failed');

    closeRenameModal();
    await loadAdminData();
  } catch (err) {
    alert('Could not rename user: ' + err.message);
  } finally {
    btnConfirmRename.disabled = false;
    btnConfirmRename.textContent = 'Apply Rename';
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}
