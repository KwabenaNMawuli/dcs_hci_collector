/**
 * app.js  —  DCS HCI Audio Collector frontend
 * Supports Akan and Ewe languages, per-user folder recording, MP3 encoding,
 * and clean questionnaire layout without biased status markers.
 */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let currentLang    = localStorage.getItem('dcs_audio_lang') || 'akan';
let currentUser    = localStorage.getItem('dcs_audio_user') || 'default_user';
let allQuestions   = [];
let currentQ       = null;
let currentTrack   = 'question'; // 'question' | 'options'

// Session takes: keeps track of questions recorded in current session
const sessionRecorded = new Set();

// WAV Recorder state
let wavRecorder    = null;
let recordedBlob   = null;
let timerInterval  = null;
let elapsedSeconds = 0;

// Web Audio for waveform
let audioCtx       = null;
let analyser       = null;
let micStream      = null;
let animFrameId    = null;

// ── DOM refs ───────────────────────────────────────────────────────────────
const grid         = document.getElementById('question-grid');
const searchInput  = document.getElementById('search-input');
const modal        = document.getElementById('record-modal');
const modalQid     = document.getElementById('modal-qid');
const modalTitle   = document.getElementById('modal-title');
const modalClose   = document.getElementById('modal-close-btn');

// Language switchers
const btnLangAkan      = document.getElementById('lang-btn-akan');
const btnLangEwe       = document.getElementById('lang-btn-ewe');
const btnModalLangAkan = document.getElementById('modal-lang-akan');
const btnModalLangEwe  = document.getElementById('modal-lang-ewe');

// Track tabs
const trackSwitcher    = document.getElementById('track-switcher');
const tabTrackQ        = document.getElementById('tab-track-q');
const tabTrackOpts     = document.getElementById('tab-track-opts');
const modalQView       = document.getElementById('modal-q-view');
const modalOptsView    = document.getElementById('modal-opts-view');
const modalPromptText  = document.getElementById('modal-prompt-text');
const modalOptionsList = document.getElementById('modal-options-list');
const badgeQStatus     = document.getElementById('badge-q-status');
const badgeOptsStatus  = document.getElementById('badge-opts-status');

// Controls
const btnRecord    = document.getElementById('btn-record');
const btnStop      = document.getElementById('btn-stop');
const btnPlay      = document.getElementById('btn-play');
const btnUpload    = document.getElementById('btn-upload');
const uploadStatus = document.getElementById('upload-status');
const replaceWarn  = document.getElementById('replace-warning');
const timerEl      = document.getElementById('record-timer');
const canvas       = document.getElementById('waveform');
const playbackAudio= document.getElementById('playback-audio');
const btnAuthDrive = document.getElementById('btn-auth-drive');
const badgeDriveConnected = document.getElementById('badge-drive-connected');

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  const authenticated = await initUser();
  if (!authenticated) return;
  await checkAuthStatus();
  bindLangButtons();
  setLanguageUI(currentLang);
  await loadQuestions(currentLang);
  bindToolbar();
  bindTrackTabs();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// ── User Identity ──────────────────────────────────────────────────────────
async function initUser() {
  const nameEl = document.getElementById('current-user-name');
  const btnSignout = document.getElementById('btn-user-signout');

  // Verify contributor authentication with server
  try {
    const res = await fetch('/api/users/me');
    const data = await res.json();
    if (!data || !data.authenticated || !data.user) {
      window.location.replace('/user-login.html');
      return false;
    }
    if (!data.user.practiceApproved) {
      // Practice completion and admin greenlight required before actual recording
      window.location.replace('/practice.html');
      return false;
    }
    currentUser = data.user.username;
    localStorage.setItem('dcs_audio_user', currentUser);
    if (nameEl) nameEl.textContent = data.user.displayName || currentUser;
  } catch (err) {
    window.location.replace('/practice.html');
    return false;
  }

  if (btnSignout) {
    btnSignout.addEventListener('click', async () => {
      try {
        await fetch('/api/users/logout', { method: 'POST' });
      } catch (_) {}
      localStorage.removeItem('dcs_audio_user');
      sessionStorage.removeItem('dcs_contributor_token');
      window.location.replace('/user-login.html');
    });
  }

  return true;
}

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth-status');
    const data = await res.json();
    const btnReauth = document.getElementById('btn-reauth-drive');

    if (data.authenticated) {
      if (badgeDriveConnected) badgeDriveConnected.style.display = 'inline-flex';
      if (btnAuthDrive) btnAuthDrive.style.display = 'none';

      if (btnReauth) {
        btnReauth.style.display = 'inline-flex';
        btnReauth.textContent = '🔄 Reconnect';
      }
    } else {
      if (btnAuthDrive) btnAuthDrive.style.display = 'inline-flex';
      if (badgeDriveConnected) badgeDriveConnected.style.display = 'none';
      if (btnReauth) btnReauth.style.display = 'none';
    }
  } catch (err) {
    console.warn('Could not check auth status:', err);
  }
}

// ── Language handling ──────────────────────────────────────────────────────
function bindLangButtons() {
  if (btnLangAkan) btnLangAkan.addEventListener('click', () => switchLanguage('akan'));
  if (btnLangEwe)  btnLangEwe.addEventListener('click', () => switchLanguage('ewe'));

  if (btnModalLangAkan) btnModalLangAkan.addEventListener('click', () => switchLanguage('akan'));
  if (btnModalLangEwe)  btnModalLangEwe.addEventListener('click', () => switchLanguage('ewe'));
}

function setLanguageUI(lang) {
  if (btnLangAkan) btnLangAkan.classList.toggle('active', lang === 'akan');
  if (btnLangEwe)  btnLangEwe.classList.toggle('active', lang === 'ewe');

  if (btnModalLangAkan) btnModalLangAkan.classList.toggle('active', lang === 'akan');
  if (btnModalLangEwe)  btnModalLangEwe.classList.toggle('active', lang === 'ewe');
}

async function switchLanguage(lang) {
  if (lang === currentLang) return;

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    if (!confirm('Switching language will discard the current recording. Continue?')) {
      return;
    }
    stopRecording(false);
  }

  currentLang = lang;
  localStorage.setItem('dcs_audio_lang', currentLang);
  setLanguageUI(currentLang);

  const openQId = currentQ ? currentQ.id : null;
  const preferredTrack = currentTrack;

  grid.innerHTML = `<div class="loading-state">
    <div class="spinner"></div>
    <p>Loading ${currentLang === 'ewe' ? 'Ewe' : 'Akan'} questions…</p>
  </div>`;

  await loadQuestions(currentLang);

  if (openQId && !modal.hidden) {
    const updatedQ = allQuestions.find(x => x.id === openQId);
    if (updatedQ) {
      openModal(updatedQ, preferredTrack);
    } else {
      closeModal();
    }
  }
}

// ── Data loading ───────────────────────────────────────────────────────────
async function loadQuestions(lang = currentLang) {
  try {
    const res = await fetch(`/api/questions?lang=${encodeURIComponent(lang)}`);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    allQuestions = data.questions || [];
    applyFilters();
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">
      <p>⚠️ Could not load questions: ${err.message}</p>
      <p style="font-size:.8rem;margin-top:8px">Check that the server is running and questionnaire file is available.</p>
    </div>`;
  }
}

// ── Grid rendering (No biased markers shown to users) ──────────────────────
function renderGrid(questions) {
  if (questions.length === 0) {
    grid.innerHTML = '<div class="empty-state"><p>No questions match your search.</p></div>';
    return;
  }

  grid.innerHTML = '';
  for (const q of questions) {
    grid.appendChild(buildCard(q));
  }
}

function buildCard(q) {
  const card = document.createElement('div');
  const hasOpts = Array.isArray(q.options) && q.options.length > 0;
  const langLabel = currentLang.toUpperCase();

  const sessionKeyQ = `${currentUser}_${q.id}_question_${currentLang}`;
  const sessionKeyOpts = `${currentUser}_${q.id}_options_${currentLang}`;
  const recordedQSession = sessionRecorded.has(sessionKeyQ);
  const recordedOptsSession = sessionRecorded.has(sessionKeyOpts);

  card.className = 'q-card';
  card.dataset.id = q.id;

  card.innerHTML = `
    <div class="card-top">
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="q-id">${q.id}</span>
        <span class="card-lang-tag">${langLabel}</span>
      </div>
      ${(recordedQSession || recordedOptsSession) ? '<span class="q-badge" style="background:#dcfce7;color:#166534;">✔ Recorded in session</span>' : ''}
    </div>
    <p class="q-text">${q.text || '<em>No text available</em>'}</p>
    ${hasOpts ? `<div class="card-options-summary">📋 ${q.options.length} options available</div>` : ''}

    <div class="card-tracks">
      <div class="card-track-row">
        <span class="track-title">🎙️ Prompt</span>
        <div class="track-actions">
          <button class="btn-mini btn-mini-record" data-id="${q.id}" data-track="question">
            ${recordedQSession ? '🔄 Re-record' : '🎙️ Record'}
          </button>
        </div>
      </div>

      ${hasOpts ? `
      <div class="card-track-row">
        <span class="track-title">📋 Options</span>
        <div class="track-actions">
          <button class="btn-mini btn-mini-record" data-id="${q.id}" data-track="options">
            ${recordedOptsSession ? '🔄 Re-record' : '🎙️ Record'}
          </button>
        </div>
      </div>
      ` : ''}
    </div>
  `;

  card.querySelectorAll('.btn-mini-record').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const track = btn.dataset.track;
      const question = allQuestions.find(x => x.id === card.dataset.id);
      openModal(question, track);
    });
  });

  return card;
}

// ── Toolbar bindings ───────────────────────────────────────────────────────
function bindToolbar() {
  if (searchInput) searchInput.addEventListener('input', applyFilters);
}

function applyFilters() {
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

  const filtered = allQuestions.filter(q => {
    if (!query) return true;
    return q.id.toLowerCase().includes(query) ||
           (q.text && q.text.toLowerCase().includes(query));
  });

  renderGrid(filtered);
}

// ── Track Tabs Bindings ────────────────────────────────────────────────────
function bindTrackTabs() {
  if (tabTrackQ) tabTrackQ.addEventListener('click', () => switchTrack('question'));
  if (tabTrackOpts) tabTrackOpts.addEventListener('click', () => switchTrack('options'));
}

function switchTrack(track) {
  if (wavRecorder && wavRecorder.isRecording) {
    if (!confirm('Switching tracks will discard the current recording. Continue?')) {
      return;
    }
    stopRecording(false);
  }

  currentTrack = track;
  resetRecordingUI();

  if (track === 'question') {
    if (tabTrackQ) tabTrackQ.classList.add('active');
    if (tabTrackOpts) tabTrackOpts.classList.remove('active');
    if (modalQView) modalQView.style.display = 'block';
    if (modalOptsView) modalOptsView.style.display = 'none';
  } else {
    if (tabTrackOpts) tabTrackOpts.classList.add('active');
    if (tabTrackQ) tabTrackQ.classList.remove('active');
    if (modalOptsView) modalOptsView.style.display = 'block';
    if (modalQView) modalQView.style.display = 'none';
  }

  updateTrackBadges();
}

function updateTrackBadges() {
  if (!currentQ) return;
  const sessionKey = `${currentUser}_${currentQ.id}_${currentTrack}_${currentLang}`;
  const isRecorded = sessionRecorded.has(sessionKey);

  if (replaceWarn) replaceWarn.hidden = !isRecorded;
  if (badgeQStatus) badgeQStatus.textContent = '';
  if (badgeOptsStatus) badgeOptsStatus.textContent = '';
}

// ── Modal open / close ─────────────────────────────────────────────────────
function openModal(q, preferredTrack = 'question') {
  currentQ = q;
  if (modalQid) modalQid.textContent = q.id;
  if (modalTitle) modalTitle.textContent = q.text || 'No question text';
  if (modalPromptText) modalPromptText.textContent = q.text || 'No prompt available';

  setLanguageUI(currentLang);

  const hasOpts = Array.isArray(q.options) && q.options.length > 0;

  if (modalOptionsList) {
    modalOptionsList.innerHTML = '';
    if (hasOpts) {
      if (trackSwitcher) trackSwitcher.style.display = 'flex';
      if (tabTrackOpts) tabTrackOpts.style.display = 'flex';
      q.options.forEach((opt) => {
        const li = document.createElement('li');
        li.textContent = opt;
        modalOptionsList.appendChild(li);
      });
    } else {
      if (trackSwitcher) trackSwitcher.style.display = 'none';
    }
  }

  switchTrack(hasOpts && preferredTrack === 'options' ? 'options' : 'question');

  if (modal) modal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  stopRecording(false);
  clearWaveform();
  if (modal) modal.hidden = true;
  document.body.style.overflow = '';
  currentQ = null;
}

if (modalClose) modalClose.addEventListener('click', closeModal);
if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ── Recording logic ────────────────────────────────────────────────────────
if (btnRecord) btnRecord.addEventListener('click', startRecording);
if (btnStop) btnStop.addEventListener('click',   () => stopRecording(true));
if (btnPlay) btnPlay.addEventListener('click',   playBack);
if (btnUpload) btnUpload.addEventListener('click', uploadAudio);

async function startRecording() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert('Microphone access denied: ' + err.message);
    return;
  }

  const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
  audioCtx  = new AudioCtxClass();
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch (_) {}
  }

  analyser  = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  const source = audioCtx.createMediaStreamSource(micStream);
  source.connect(analyser);
  drawWaveform();

  recordedBlob = null;
  wavRecorder = new window.WavRecorder();
  wavRecorder.start(micStream);

  uploadStatus.textContent = '🎙️ Recording…';
  uploadStatus.className   = 'upload-status';

  elapsedSeconds = 0;
  timerEl.textContent = '00:00';
  timerInterval = setInterval(() => {
    elapsedSeconds++;
    const m = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
    const s = String(elapsedSeconds % 60).padStart(2, '0');
    timerEl.textContent = `${m}:${s}`;
  }, 1000);

  btnRecord.disabled   = true;
  btnRecord.classList.add('recording');
  btnStop.disabled     = false;
  btnPlay.disabled     = true;
  btnUpload.disabled   = true;
}

function stopRecording(keepAudio = true) {
  clearInterval(timerInterval);
  cancelAnimationFrame(animFrameId);

  if (wavRecorder) {
    try {
      const wav = wavRecorder.stop();
      if (keepAudio) {
        recordedBlob = wav;
        playbackAudio.src = URL.createObjectURL(recordedBlob);
        btnPlay.disabled   = false;
        btnUpload.disabled = false;
        uploadStatus.textContent = '🎵 Ready to upload (WAV)';
        uploadStatus.className   = 'upload-status';
      }
    } catch (e) {
      console.error('WAV stop error:', e);
    }
    wavRecorder = null;
  }

  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }

  if (audioCtx) {
    try { audioCtx.close(); } catch (_) {}
    audioCtx = null;
    analyser = null;
  }

  if (!keepAudio) {
    recordedBlob = null;
    playbackAudio.src = '';
  }

  btnRecord.disabled = false;
  btnRecord.classList.remove('recording');
  btnStop.disabled   = true;
}

function playBack() {
  if (!playbackAudio.src) return;
  if (playbackAudio.paused) {
    playbackAudio.play();
    btnPlay.innerHTML = '<span class="btn-icon">⏸</span> Pause';
  } else {
    playbackAudio.pause();
    btnPlay.innerHTML = '<span class="btn-icon">▶</span> Play';
  }
}

playbackAudio.addEventListener('ended', () => {
  btnPlay.innerHTML = '<span class="btn-icon">▶</span> Play';
});

// ── Upload ─────────────────────────────────────────────────────────────────
async function uploadAudio() {
  if (!recordedBlob || !currentQ) return;

  btnUpload.disabled = true;
  uploadStatus.textContent = '⏳ Uploading WAV to folder…';
  uploadStatus.className   = 'upload-status';

  const formData = new FormData();
  const suffix   = currentTrack === 'options' ? '_options' : '_question';
  const audioFileName = `${currentQ.id}${suffix}_${currentLang}.wav`;

  formData.append('audio', recordedBlob, audioFileName);
  formData.append('questionId', currentQ.id);
  formData.append('targetType', currentTrack);
  formData.append('lang', currentLang);
  formData.append('user', currentUser);
  formData.append('replace', 'true');

  try {
    const res  = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

    uploadStatus.textContent = `✅ Saved to ${currentUser}'s folder as ${data.filename}`;
    uploadStatus.className   = 'upload-status success';

    const sessionKey = `${currentUser}_${currentQ.id}_${currentTrack}_${currentLang}`;
    sessionRecorded.add(sessionKey);

    updateTrackBadges();
    updateCardInGrid(currentQ);

  } catch (err) {
    uploadStatus.textContent = `❌ Upload failed: ${err.message}`;
    uploadStatus.className   = 'upload-status error';
    btnUpload.disabled = false;
  }
}

// ── Waveform ───────────────────────────────────────────────────────────────
function drawWaveform() {
  if (!analyser) return;
  const ctx  = canvas.getContext('2d');
  const W    = canvas.width;
  const H    = canvas.height;
  const data = new Uint8Array(analyser.frequencyBinCount);

  function frame() {
    animFrameId = requestAnimationFrame(frame);
    analyser.getByteTimeDomainData(data);

    ctx.fillStyle = '#f8f9fa';
    ctx.fillRect(0, 0, W, H);

    ctx.lineWidth   = 2;
    ctx.strokeStyle = '#1a73e8';
    ctx.beginPath();

    const sliceW = W / data.length;
    let x = 0;

    for (let i = 0; i < data.length; i++) {
      const v = data[i] / 128;
      const y = (v * H) / 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      x += sliceW;
    }

    ctx.lineTo(W, H / 2);
    ctx.stroke();
  }

  frame();
}

function clearWaveform() {
  cancelAnimationFrame(animFrameId);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f8f9fa';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function resetRecordingUI() {
  recordedBlob = null;
  elapsedSeconds = 0;
  timerEl.textContent      = '00:00';
  btnRecord.disabled       = false;
  btnRecord.classList.remove('recording');
  btnStop.disabled         = true;
  btnPlay.disabled         = true;
  btnUpload.disabled       = true;
  btnPlay.innerHTML        = '<span class="btn-icon">▶</span> Play';
  uploadStatus.textContent = '';
  uploadStatus.className   = 'upload-status';
  playbackAudio.src        = '';
  clearWaveform();
}

function updateCardInGrid(q) {
  const card = grid.querySelector(`[data-id="${q.id}"]`);
  if (!card) return;
  const newCard = buildCard(q);
  card.replaceWith(newCard);
}
