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
const btnExportCsv = document.getElementById('btn-export-csv');

// Rename modal
const renameModal = document.getElementById('rename-modal');
const renameModalClose = document.getElementById('rename-modal-close');
const renameCurrentUser = document.getElementById('rename-current-user');
const renameNewUser = document.getElementById('rename-new-user');
const btnCancelRename = document.getElementById('btn-cancel-rename');
const btnConfirmRename = document.getElementById('btn-confirm-rename');

// Create user modal
const btnOpenCreateUser = document.getElementById('btn-open-create-user-modal');
const createUserModal = document.getElementById('create-user-modal');
const createUserModalClose = document.getElementById('create-user-modal-close');
const btnCancelCreateUser = document.getElementById('btn-cancel-create-user');
const formCreateUser = document.getElementById('form-create-user');
const inputCreateUsername = document.getElementById('create-user-username');
const inputCreateDisplayName = document.getElementById('create-user-display-name');
const inputCreatePin = document.getElementById('create-user-pin');
const selectCreateLanguage = document.getElementById('create-user-language');
const checkCreateAutoApprove = document.getElementById('create-user-auto-approve');
const createUserError = document.getElementById('create-user-error');
const btnConfirmCreateUser = document.getElementById('btn-confirm-create-user');

// Drive auth elements
const badgeDrive = document.getElementById('badge-drive-connected');
const btnAuthDrive = document.getElementById('btn-auth-drive');

// ── Init ───────────────────────────────────────────────────────────────────
function initAdmin() {
  bindEvents();
  checkAuthStatus();
  checkAdminSession();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAdmin);
} else {
  initAdmin();
}

function getAdminToken() {
  return sessionStorage.getItem('dcs_admin_token') || localStorage.getItem('dcs_admin_token') || '';
}

function getAdminHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-admin-token': getAdminToken(),
  };
}

function redirectToLogin() {
  sessionStorage.removeItem('dcs_admin_token');
  localStorage.removeItem('dcs_admin_token');
  window.location.replace('/login');
}

async function safeFetchJson(url, options = {}) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (netErr) {
    throw new Error(`Network error: ${netErr.message || 'Could not connect to server'}`);
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  // If response is not JSON (e.g., Express 404 HTML page, 502 Bad Gateway proxy, etc.)
  if (!contentType.includes('application/json')) {
    if (res.status === 404) {
      throw new Error(
        'Server endpoint not found (404). If you just updated the app, please restart the server (or redeploy) so the latest admin routes take effect.'
      );
    }
    if (res.status === 502 || res.status === 503) {
      throw new Error(`Server temporarily unavailable (${res.status}). The service might be starting up.`);
    }
    throw new Error(`Server returned status ${res.status} (non-JSON response). Please verify the server is running.`);
  }

  let data;
  try {
    data = await res.json();
  } catch (parseErr) {
    throw new Error('Failed to parse server response as JSON.');
  }

  return { res, data };
}

async function checkAdminSession() {
  const token = getAdminToken();
  if (!token) {
    redirectToLogin();
    return;
  }

  try {
    const { data } = await safeFetchJson('/api/admin/verify', {
      headers: getAdminHeaders(),
    });
    if (data && data.authenticated) {
      await loadAdminData();
    } else {
      redirectToLogin();
    }
  } catch (err) {
    redirectToLogin();
  }
}

function bindEvents() {
  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      try {
        await fetch('/api/admin/logout', {
          method: 'POST',
          headers: getAdminHeaders(),
        });
      } catch (_) {}
      redirectToLogin();
    });
  }

  if (btnRefresh) {
    btnRefresh.addEventListener('click', loadAdminData);
  }

  if (filterUser) {
    filterUser.addEventListener('change', () => {
      currentFilterUser = filterUser.value;
      filterAndRenderRecordings();
    });
  }

  if (filterLang) {
    filterLang.addEventListener('change', () => {
      currentFilterLang = filterLang.value;
      filterAndRenderRecordings();
    });
  }

  if (filterTrack) {
    filterTrack.addEventListener('change', () => {
      currentFilterTrack = filterTrack.value;
      filterAndRenderRecordings();
    });
  }

  if (checkPractice) {
    checkPractice.addEventListener('change', () => {
      includePractice = checkPractice.checked;
      filterAndRenderRecordings();
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value.trim().toLowerCase();
      filterAndRenderRecordings();
    });
  }

  if (btnExportCsv) {
    btnExportCsv.addEventListener('click', () => {
      downloadSpreadsheet(currentFilterUser, currentFilterLang, includePractice);
    });
  }

  // Modal events
  if (renameModalClose) renameModalClose.addEventListener('click', closeRenameModal);
  if (btnCancelRename) btnCancelRename.addEventListener('click', closeRenameModal);
  if (btnConfirmRename) btnConfirmRename.addEventListener('click', handleRenameSubmit);

  // Create user modal events
  if (btnOpenCreateUser) btnOpenCreateUser.addEventListener('click', openCreateUserModal);
  if (createUserModalClose) createUserModalClose.addEventListener('click', closeCreateUserModal);
  if (btnCancelCreateUser) btnCancelCreateUser.addEventListener('click', closeCreateUserModal);
  if (formCreateUser) formCreateUser.addEventListener('submit', handleCreateUserSubmit);
}

async function checkAuthStatus() {
  try {
    const { data } = await safeFetchJson('/api/auth-status');
    if (data && data.authenticated) {
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

// Warns when recordings are waiting in the database because Drive rejected them
async function loadPendingBanner(retry) {
  const main = document.querySelector('main.admin-main');
  if (!main) return;
  let banner = document.getElementById('pending-banner');
  try {
    const { res, data } = await safeFetchJson(
      retry ? '/api/admin/pending-uploads/retry' : '/api/admin/pending-uploads',
      { method: retry ? 'POST' : 'GET', headers: getAdminHeaders() }
    );
    if (!res.ok || !data || !data.count) {
      if (banner) banner.remove();
      return;
    }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'pending-banner';
      banner.style.cssText = 'margin:0 0 16px;padding:12px 16px;border-radius:8px;background:#fff3cd;color:#664d03;border:1px solid #ffda6a;';
      main.prepend(banner);
    }
    const mb = (data.bytes / 1048576).toFixed(1);
    banner.textContent = '';
    const msg = document.createElement('span');
    msg.textContent = `⚠️ ${data.count} recording(s) (${mb} MB) are safe in the database but not in Google Drive yet.` +
      (data.lastError ? ` Last error: ${data.lastError}` : '') + ' ';
    const btn = document.createElement('button');
    btn.textContent = 'Retry now';
    btn.onclick = () => loadPendingBanner(true);
    banner.append(msg, btn);
  } catch (err) {
    console.warn('Could not load pending uploads:', err);
  }
}

// ── Data Loading ───────────────────────────────────────────────────────────
async function loadAdminData() {
  btnRefresh.disabled = true;
  btnRefresh.textContent = '⏳ Loading…';

  try {
    // 1. Load overview stats
    const { res: overviewRes, data: ovData } = await safeFetchJson('/api/admin/overview', {
      headers: getAdminHeaders(),
    });

    if (overviewRes.status === 401) {
      redirectToLogin();
      return;
    }

    if (!overviewRes.ok) throw new Error((ovData && ovData.error) || 'Failed to load overview data');
    overviewData = ovData;

    renderKPIs(overviewData);
    renderUsersTable(overviewData.users || []);
    populateUserFilter(overviewData.userList || []);

    loadPendingBanner();

    // 2. Load recordings list
    const { res: recordingsRes, data: recData } = await safeFetchJson('/api/admin/recordings?practice=true', {
      headers: getAdminHeaders(),
    });

    if (recordingsRes.status === 401) {
      redirectToLogin();
      return;
    }

    if (!recordingsRes.ok) throw new Error((recData && recData.error) || 'Failed to load recordings list');
    allRecordings = (recData && recData.recordings) || [];

    filterAndRenderRecordings();

  } catch (err) {
    console.error('Error loading admin data:', err);
    alert('Error loading admin data: ' + err.message);
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
    usersTableBody.innerHTML = `<tr><td colspan="7" class="text-center py-4" style="color:#64748b;">No contributor recordings found yet.</td></tr>`;
    return;
  }

  usersTableBody.innerHTML = '';
  for (const u of users) {
    let statusBadge = '';
    let greenlightBtn = '';

    if (u.practiceApproved) {
      statusBadge = '<span class="lang-badge akan" style="background:#dcfce7; color:#15803d; border-color:#86efac; font-weight:600;">🟢 Greenlit</span>';
      greenlightBtn = `
        <button type="button" class="btn-icon-link btn-revoke-user" data-user="${escapeHtml(u.user)}" style="color:#b91c1c;" title="Revoke recording permission and send user back to practice">
          ⛔ Revoke
        </button>
      `;
    } else if (u.practiceCompleted) {
      statusBadge = '<span class="lang-badge ewe" style="background:#fef3c7; color:#92400e; border-color:#fcd34d; font-weight:700;">🟡 Needs Greenlight</span>';
      greenlightBtn = `
        <button type="button" class="btn-icon-link btn-approve-user" data-user="${escapeHtml(u.user)}" style="color:#15803d; font-weight:700;" title="Give greenlight to start real questionnaire recordings">
          ✅ Give Greenlight
        </button>
      `;
    } else {
      statusBadge = '<span class="lang-badge" style="background:#f1f5f9; color:#475569; border-color:#cbd5e1;">⚪ In Practice</span>';
      greenlightBtn = `
        <button type="button" class="btn-icon-link btn-approve-user" data-user="${escapeHtml(u.user)}" style="color:#15803d;" title="Directly approve this user for recording">
          ✅ Approve Early
        </button>
      `;
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <span class="user-badge">👤 ${escapeHtml(u.user)}</span>
        <span class="lang-badge ${u.language === 'ewe' ? 'ewe' : 'akan'}" style="margin-left:6px;">${u.language ? (u.language === 'ewe' ? 'Ewe' : 'Akan') : 'Both'}</span>
        <div style="display:flex;align-items:center;gap:4px;margin-top:6px;">
          <select class="user-language-select" data-user="${escapeHtml(u.user)}" aria-label="Assigned language for ${escapeHtml(u.user)}" style="padding:3px 5px;border:1px solid #cbd5e1;border-radius:4px;">
            ${u.language ? '' : '<option value="" selected disabled>Assign…</option>'}
            <option value="akan" ${u.language === 'akan' ? 'selected' : ''}>Akan</option>
            <option value="ewe" ${u.language === 'ewe' ? 'selected' : ''}>Ewe</option>
          </select>
          <button type="button" class="btn-icon-link btn-assign-language" data-user="${escapeHtml(u.user)}" title="Save language assignment">Save</button>
        </div>
        ${u.auditSignedOffAt ? `<span class="lang-badge" style="background:#dcfce7; color:#15803d; border-color:#86efac; margin-left:6px;" title="Signed off their recording audit on ${escapeHtml(new Date(u.auditSignedOffAt).toLocaleDateString())}">✓ Audit signed off</span>` : ''}
      </td>
      <td>
        ${statusBadge}
      </td>
      <td><strong>${u.totalRecordings}</strong> takes</td>
      <td><span class="lang-badge akan">${u.akanCount}</span></td>
      <td><span class="lang-badge ewe">${u.eweCount}</span></td>
      <td style="font-size:0.82rem;color:#475569;">
        🎙️ ${u.questionTracks} prompt / 📋 ${u.optionsTracks} opts
      </td>
      <td>
        <div class="btn-action-group">
          ${greenlightBtn}
          <button type="button" class="btn-icon-link btn-export-user" data-user="${escapeHtml(u.user)}" title="Export recordings and transcripts as spreadsheet for this contributor">
            📥 Export
          </button>
          <button type="button" class="btn-icon-link btn-filter-user" data-user="${escapeHtml(u.user)}" title="Filter recordings for this user">
            🔍 Filter Takes
          </button>
          <button type="button" class="btn-icon-link btn-rename-user" data-user="${escapeHtml(u.user)}" title="Rename or merge user folder">
            ✏️ Rename
          </button>
          <button type="button" class="btn-icon-link btn-reset-pin" data-user="${escapeHtml(u.user)}" title="Reset contributor passcode / PIN">
            🔑 Reset PIN
          </button>
        </div>
      </td>
    `;
    usersTableBody.appendChild(tr);
  }

  usersTableBody.querySelectorAll('.btn-assign-language').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const username = btn.dataset.user;
      const select = btn.closest('tr').querySelector('.user-language-select');
      if (!select) return;
      if (!['akan', 'ewe'].includes(select.value)) {
        alert('Select Akan or Ewe before saving the assignment.');
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const { res, data } = await safeFetchJson('/api/admin/assign-language', {
          method: 'POST',
          headers: getAdminHeaders(),
          body: JSON.stringify({ username, language: select.value }),
        });
        if (!res.ok) throw new Error((data && data.error) || 'Failed to assign language');
        await loadAdminData();
        alert(`✅ ${username} is now assigned to ${select.value === 'ewe' ? 'Ewe' : 'Akan'}.`);
      } catch (err) {
        alert(`Could not assign language: ${err.message}`);
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    });
  });

  usersTableBody.querySelectorAll('.btn-approve-user').forEach(btn => {
    btn.addEventListener('click', async () => {
      const u = btn.dataset.user;
      if (!confirm(`Give greenlight to contributor "${u}" to start recording actual questionnaire questions?`)) {
        return;
      }
      btn.disabled = true;
      btn.textContent = '⏳ Approving…';
      try {
        const { res, data } = await safeFetchJson('/api/admin/approve-user', {
          method: 'POST',
          headers: getAdminHeaders(),
          body: JSON.stringify({ username: u, approved: true }),
        });
        if (!res.ok) throw new Error((data && data.error) || 'Failed to approve contributor');
        await loadAdminData();
        alert(`✅ Contributor "${u}" has been greenlit! Their recording dashboard will open automatically.`);
      } catch (err) {
        alert('Could not approve user: ' + err.message);
        btn.disabled = false;
        btn.textContent = '✅ Give Greenlight';
      }
    });
  });

  usersTableBody.querySelectorAll('.btn-revoke-user').forEach(btn => {
    btn.addEventListener('click', async () => {
      const u = btn.dataset.user;
      if (!confirm(`Revoke recording permission for "${u}"? They will be required to practice again.`)) {
        return;
      }
      btn.disabled = true;
      try {
        const { res, data } = await safeFetchJson('/api/admin/approve-user', {
          method: 'POST',
          headers: getAdminHeaders(),
          body: JSON.stringify({ username: u, approved: false }),
        });
        if (!res.ok) throw new Error((data && data.error) || 'Failed to revoke permission');
        await loadAdminData();
        alert(`Permission revoked for "${u}".`);
      } catch (err) {
        alert('Could not revoke permission: ' + err.message);
        btn.disabled = false;
      }
    });
  });

  usersTableBody.querySelectorAll('.btn-export-user').forEach(btn => {
    btn.addEventListener('click', () => {
      downloadSpreadsheet(btn.dataset.user, 'all', includePractice, btn);
    });
  });

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

  usersTableBody.querySelectorAll('.btn-reset-pin').forEach(btn => {
    btn.addEventListener('click', async () => {
      const u = btn.dataset.user;
      const newPin = prompt(`Enter a new 4-digit PIN for contributor "${u}":`, '1234');
      if (!newPin || newPin.trim().length < 4) {
        if (newPin !== null) alert('PIN must be at least 4 digits or characters.');
        return;
      }

      btn.disabled = true;
      try {
        const { res, data } = await safeFetchJson('/api/admin/reset-user-pin', {
          method: 'POST',
          headers: getAdminHeaders(),
          body: JSON.stringify({ username: u, newPin: newPin.trim() }),
        });
        if (!res.ok) throw new Error((data && data.error) || 'Failed to reset PIN');
        alert(`✅ PIN for "${u}" has been reset to: ${newPin.trim()}`);
      } catch (err) {
        alert('Could not reset PIN: ' + err.message);
      } finally {
        btn.disabled = false;
      }
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
        const { res: delRes, data: delData } = await safeFetchJson('/api/admin/recording', {
          method: 'DELETE',
          headers: getAdminHeaders(),
          body: JSON.stringify({ user: u, filename: fn, fileId: fid }),
        });
        if (!delRes.ok) throw new Error((delData && delData.error) || 'Delete failed');

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

// ── Spreadsheet Export ─────────────────────────────────────────────────────
async function downloadSpreadsheet(user = 'all', lang = 'all', practice = false, triggerBtn = null) {
  const token = getAdminToken();
  if (!token) {
    redirectToLogin();
    return;
  }

  const btn = triggerBtn || btnExportCsv;
  const originalText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Exporting…';
  }

  try {
    const params = new URLSearchParams({
      user,
      lang,
      practice: practice ? 'true' : 'false',
      admin_token: token,
    });

    const res = await fetch(`/api/admin/export?${params.toString()}`, {
      headers: {
        'x-admin-token': token,
      },
    });

    if (res.status === 401) {
      redirectToLogin();
      return;
    }

    if (!res.ok) {
      let errMsg = 'Failed to download spreadsheet';
      try {
        const j = await res.json();
        if (j.error) errMsg = j.error;
      } catch (_) {}
      throw new Error(errMsg);
    }

    const blob = await res.blob();
    let downloadFilename = (user && user !== 'all')
      ? `recordings_${user}_${new Date().toISOString().slice(0, 10)}.csv`
      : `recordings_all_${new Date().toISOString().slice(0, 10)}.csv`;

    const disposition = res.headers.get('content-disposition');
    if (disposition && disposition.includes('filename=')) {
      const match = disposition.match(/filename="?([^";]+)"?/);
      if (match && match[1]) {
        downloadFilename = match[1];
      }
    }

    const blobUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = downloadFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(blobUrl);
  } catch (err) {
    alert('Spreadsheet export failed: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
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
    const { res, data } = await safeFetchJson('/api/admin/rename-user', {
      method: 'POST',
      headers: getAdminHeaders(),
      body: JSON.stringify({ oldUser, newUser }),
    });
    if (!res.ok) throw new Error((data && data.error) || 'Rename failed');

    closeRenameModal();
    await loadAdminData();
  } catch (err) {
    alert('Could not rename user: ' + err.message);
  } finally {
    btnConfirmRename.disabled = false;
    btnConfirmRename.textContent = 'Apply Rename';
  }
}

// ── Create Contributor Modal ───────────────────────────────────────────────
function openCreateUserModal() {
  if (createUserModal) {
    if (formCreateUser) formCreateUser.reset();
    if (inputCreatePin) inputCreatePin.value = '1234';
    if (checkCreateAutoApprove) checkCreateAutoApprove.checked = true;
    if (createUserError) createUserError.hidden = true;
    createUserModal.hidden = false;
    if (inputCreateUsername) inputCreateUsername.focus();
  }
}

function closeCreateUserModal() {
  if (createUserModal) createUserModal.hidden = true;
}

async function handleCreateUserSubmit(e) {
  e.preventDefault();
  if (createUserError) createUserError.hidden = true;

  const username = (inputCreateUsername ? inputCreateUsername.value : '').trim();
  const displayName = (inputCreateDisplayName ? inputCreateDisplayName.value : '').trim();
  const pin = (inputCreatePin ? inputCreatePin.value : '').trim();
  const language = selectCreateLanguage ? selectCreateLanguage.value : '';
  const autoApprove = checkCreateAutoApprove ? checkCreateAutoApprove.checked : true;

  if (!username) {
    if (createUserError) {
      createUserError.hidden = false;
      createUserError.textContent = 'Please enter a username or contributor ID.';
    }
    return;
  }
  if (!pin || pin.length < 4) {
    if (createUserError) {
      createUserError.hidden = false;
      createUserError.textContent = 'Passcode / PIN must be at least 4 digits or characters.';
    }
    return;
  }
  if (!['akan', 'ewe'].includes(language)) {
    if (createUserError) {
      createUserError.hidden = false;
      createUserError.textContent = 'Please select an assigned language.';
    }
    return;
  }

  btnConfirmCreateUser.disabled = true;
  btnConfirmCreateUser.textContent = '⏳ Creating…';

  try {
    const { res, data } = await safeFetchJson('/api/admin/create-user', {
      method: 'POST',
      headers: getAdminHeaders(),
      body: JSON.stringify({ username, displayName, pin, language, autoApprove }),
    });

    if (!res.ok) {
      throw new Error((data && data.error) || 'Failed to create user account');
    }

    closeCreateUserModal();
    await loadAdminData();
    const statusText = data.user && data.user.practiceApproved ? 'Greenlit (Ready to record immediately)' : 'In Practice';
    const languageLabel = language === 'ewe' ? 'Ewe' : 'Akan';
    alert(`✅ Contributor "${data.user.displayName || data.user.username}" created successfully!\nLanguage: ${languageLabel}\nPIN: ${pin}\nStatus: ${statusText}`);
  } catch (err) {
    if (createUserError) {
      createUserError.hidden = false;
      createUserError.textContent = `❌ ${err.message}`;
    }
  } finally {
    btnConfirmCreateUser.disabled = false;
    btnConfirmCreateUser.textContent = 'Create Account 🚀';
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
