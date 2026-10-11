/**
 * app.js  —  DCS HCI Audio Collector frontend
 * Supports Akan and Ewe languages, with separate audio tracks for Question Prompt and Question Options.
 */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let currentLang    = localStorage.getItem('dcs_audio_lang') || 'akan';
let allQuestions   = [];
let currentQ       = null;
let currentTrack   = 'question'; // 'question' | 'options'

// MediaRecorder state
let mediaRecorder  = null;
let audioChunks    = [];
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
const filterSelect = document.getElementById('filter-select');
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
const statRecorded = document.getElementById('stat-recorded');
const statPartial  = document.getElementById('stat-partial');
const chipPartial  = document.getElementById('chip-partial');
const statMissing  = document.getElementById('stat-missing');
const statTotal    = document.getElementById('stat-total');
const statDriveFiles = document.getElementById('stat-drive-files');
const chipTotalAudios = document.getElementById('chip-total-audios');
const btnAuthDrive = document.getElementById('btn-auth-drive');
const badgeDriveConnected = document.getElementById('badge-drive-connected');

// ── Init ───────────────────────────────────────────────────────────────────
(async function init() {
  await checkAuthStatus();
  bindLangButtons();
  setLanguageUI(currentLang);
  await loadQuestions(currentLang);
  bindToolbar();
  bindTrackTabs();
})();

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
        if (!data.hasFullDriveScope) {
          btnReauth.textContent = '⚠️ Reconnect to see prior files';
          btnReauth.style.background = '#fef08a';
          btnReauth.style.color = '#854d0e';
          btnReauth.title = 'Current token has restricted permissions and cannot see files from prior deploys. Click to grant full Drive access.';
        } else {
          btnReauth.textContent = '🔄 Reconnect';
          btnReauth.style.background = '';
          btnReauth.style.color = '';
        }
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

  // If modal was open, refresh with the question in the newly selected language
  if (openQId && !modal.hidden) {
    const updatedQ = allQuestions.find(x => x.id === openQId);
    if (updatedQ) {
      openModal(updatedQ, preferredTrack);
    } else {
      closeModal();
    }
  }
}

let totalDriveAudios = 0;

// ── Data loading ───────────────────────────────────────────────────────────
async function loadQuestions(lang = currentLang) {
  try {
    const res = await fetch(`/api/questions?lang=${encodeURIComponent(lang)}`);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    allQuestions = data.questions;
    totalDriveAudios = (data.stats && data.stats.totalDriveFiles) || 0;
    updateStats();
    applyFilters();
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">
      <p>⚠️ Could not load questions: ${err.message}</p>
      <p style="font-size:.8rem;margin-top:8px">Check that the server is running and questionnaire file is available.</p>
    </div>`;
  }
}

function updateStats() {
  const total = allQuestions.length;
  const fullyRecorded = allQuestions.filter(q => q.hasAudio).length;
  const partial = allQuestions.filter(q => q.hasPartial).length;
  const missing = total - fullyRecorded - partial;

  if (statTotal) statTotal.textContent = total;
  if (statRecorded) statRecorded.textContent = fullyRecorded;
  if (statMissing) statMissing.textContent = missing;

  if (statPartial && chipPartial) {
    statPartial.textContent = partial;
    chipPartial.style.display = partial > 0 ? 'inline-flex' : 'none';
  }

  if (statDriveFiles && chipTotalAudios) {
    statDriveFiles.textContent = totalDriveAudios;
    chipTotalAudios.style.display = totalDriveAudios > 0 ? 'inline-flex' : 'none';
  }
}

// ── Grid rendering ─────────────────────────────────────────────────────────
function renderGrid(questions) {
  if (questions.length === 0) {
    grid.innerHTML = '<div class="empty-state"><p>No questions match your filter.</p></div>';
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

  const cardStatus = q.hasAudio ? 'recorded' : (q.hasPartial ? 'partial' : 'missing');
  card.className = `q-card ${cardStatus}`;
  card.dataset.id = q.id;

  let badgeLabel = 'No audio';
  let badgeClass = 'missing';

  if (q.hasAudio) {
    badgeLabel = '✔ Fully Recorded';
    badgeClass = 'recorded';
  } else if (q.hasPartial) {
    if (q.hasQuestionAudio) {
      badgeLabel = '⏳ Partial (Prompt)';
    } else {
      badgeLabel = '⏳ Partial (Options)';
    }
    badgeClass = 'partial';
  }

  const langLabel = currentLang.toUpperCase();

  card.innerHTML = `
    <div class="card-top">
      <div style="display:flex;align-items:center;gap:6px;">
        <span class="q-id">${q.id}</span>
        <span class="card-lang-tag">${langLabel}</span>
      </div>
      <span class="q-badge ${badgeClass}">
        ${badgeLabel}
      </span>
    </div>
    <p class="q-text">${q.text || '<em>No text available</em>'}</p>
    ${hasOpts ? `<div class="card-options-summary">📋 ${q.options.length} options available</div>` : ''}

    <div class="card-tracks">
      <div class="card-track-row">
        <span class="track-title">🎙️ Question</span>
        <div class="track-actions">
          <button class="btn-mini btn-mini-record" data-id="${q.id}" data-track="question">
            ${q.hasQuestionAudio ? 'Re-record' : 'Record'}
          </button>
          <button class="btn-mini btn-mini-play" ${q.hasQuestionAudio ? `data-link="${q.questionDriveLink}"` : 'disabled'}>
            ▶ Play
          </button>
        </div>
      </div>

      ${hasOpts ? `
      <div class="card-track-row">
        <span class="track-title">📋 Options</span>
        <div class="track-actions">
          <button class="btn-mini btn-mini-record" data-id="${q.id}" data-track="options">
            ${q.hasOptionsAudio ? 'Re-record' : 'Record'}
          </button>
          <button class="btn-mini btn-mini-play" ${q.hasOptionsAudio ? `data-link="${q.optionsDriveLink}"` : 'disabled'}>
            ▶ Play
          </button>
        </div>
      </div>
      ` : ''}
    </div>
  `;

  // Attach record triggers
  card.querySelectorAll('.btn-mini-record').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const track = btn.dataset.track;
      const question = allQuestions.find(x => x.id === card.dataset.id);
      openModal(question, track);
    });
  });

  // Attach play triggers
  card.querySelectorAll('.btn-mini-play').forEach(btn => {
    if (!btn.disabled && btn.dataset.link) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.open(btn.dataset.link, '_blank');
      });
    }
  });

  return card;
}

// ── Toolbar bindings ───────────────────────────────────────────────────────
function bindToolbar() {
  searchInput.addEventListener('input', applyFilters);
  filterSelect.addEventListener('change', applyFilters);
}

function applyFilters() {
  const query  = searchInput.value.trim().toLowerCase();
  const filter = filterSelect.value;

  const filtered = allQuestions.filter(q => {
    if (filter === 'recorded' && !q.hasAudio) return false;
    if (filter === 'partial'  && !q.hasPartial) return false;
    if (filter === 'missing'  && (q.hasAudio || q.hasPartial)) return false;
    if (query) {
      return q.id.toLowerCase().includes(query) ||
             (q.text && q.text.toLowerCase().includes(query));
    }
    return true;
  });

  renderGrid(filtered);
}

// ── Track Tabs Bindings ────────────────────────────────────────────────────
function bindTrackTabs() {
  tabTrackQ.addEventListener('click', () => switchTrack('question'));
  tabTrackOpts.addEventListener('click', () => switchTrack('options'));
}

function switchTrack(track) {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    if (!confirm('Switching tracks will discard the current recording. Continue?')) {
      return;
    }
    stopRecording(false);
  }

  currentTrack = track;
  resetRecordingUI();

  if (track === 'question') {
    tabTrackQ.classList.add('active');
    tabTrackOpts.classList.remove('active');
    modalQView.style.display = 'block';
    modalOptsView.style.display = 'none';
  } else {
    tabTrackOpts.classList.add('active');
    tabTrackQ.classList.remove('active');
    modalOptsView.style.display = 'block';
    modalQView.style.display = 'none';
  }

  updateTrackBadges();
}

function updateTrackBadges() {
  if (!currentQ) return;
  const hasOpts = Array.isArray(currentQ.options) && currentQ.options.length > 0;

  badgeQStatus.textContent = currentQ.hasQuestionAudio ? '✔' : 'Empty';
  badgeQStatus.className = `track-badge ${currentQ.hasQuestionAudio ? 'done' : 'empty'}`;

  if (hasOpts) {
    badgeOptsStatus.textContent = currentQ.hasOptionsAudio ? '✔' : 'Empty';
    badgeOptsStatus.className = `track-badge ${currentQ.hasOptionsAudio ? 'done' : 'empty'}`;
  }

  // Update replace warning for current track
  const isReplacing = currentTrack === 'question' ? currentQ.hasQuestionAudio : currentQ.hasOptionsAudio;
  replaceWarn.hidden = !isReplacing;
}

// ── Modal open / close ─────────────────────────────────────────────────────
function openModal(q, preferredTrack = 'question') {
  currentQ = q;
  modalQid.textContent = q.id;
  modalTitle.textContent = q.text || 'No question text';
  modalPromptText.textContent = q.text || 'No prompt available';

  setLanguageUI(currentLang);

  const hasOpts = Array.isArray(q.options) && q.options.length > 0;

  // Populate options list
  modalOptionsList.innerHTML = '';
  if (hasOpts) {
    trackSwitcher.style.display = 'flex';
    tabTrackOpts.style.display = 'flex';
    q.options.forEach((opt) => {
      const li = document.createElement('li');
      li.textContent = opt;
      modalOptionsList.appendChild(li);
    });
  } else {
    trackSwitcher.style.display = 'none';
  }

  // Set track and switch view
  switchTrack(hasOpts && preferredTrack === 'options' ? 'options' : 'question');

  modal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  stopRecording(false);
  clearWaveform();
  modal.hidden = true;
  document.body.style.overflow = '';
  currentQ = null;
}

modalClose.addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// ── Recording logic ────────────────────────────────────────────────────────
btnRecord.addEventListener('click', startRecording);
btnStop.addEventListener('click',   () => stopRecording(true));
btnPlay.addEventListener('click',   playBack);
btnUpload.addEventListener('click', uploadAudio);

async function startRecording() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert('Microphone access denied: ' + err.message);
    return;
  }

  audioCtx  = new AudioContext();
  analyser  = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  const source = audioCtx.createMediaStreamSource(micStream);
  source.connect(analyser);
  drawWaveform();

  audioChunks  = [];
  recordedBlob = null;
  const mimeType = getSupportedMimeType();
  mediaRecorder = new MediaRecorder(micStream, mimeType ? { mimeType } : {});

  mediaRecorder.addEventListener('dataavailable', (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  });

  mediaRecorder.addEventListener('stop', () => {
    recordedBlob = new Blob(audioChunks, { type: mimeType || 'audio/webm' });
    playbackAudio.src = URL.createObjectURL(recordedBlob);
    btnPlay.disabled   = false;
    btnUpload.disabled = false;
    uploadStatus.textContent = '';
    uploadStatus.className   = 'upload-status';
  });

  mediaRecorder.start(250);

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

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }

  if (audioCtx) {
    audioCtx.close();
    audioCtx = null;
    analyser = null;
  }

  if (!keepAudio) {
    recordedBlob = null;
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
  uploadStatus.textContent = '⏳ Uploading…';
  uploadStatus.className   = 'upload-status';

  const formData = new FormData();
  const ext      = blobExtension(recordedBlob.type);
  const suffix   = currentTrack === 'options' ? '_options' : '_question';

  // Audio file qualified with ewe or akan extension
  const audioFileName = `${currentQ.id}${suffix}_${currentLang}${ext}`;

  formData.append('audio', recordedBlob, audioFileName);
  formData.append('questionId', currentQ.id);
  formData.append('targetType', currentTrack);
  formData.append('lang', currentLang);
  formData.append('replace', 'true');

  try {
    const res  = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

    uploadStatus.textContent = `✅ Uploaded as ${data.filename}`;
    uploadStatus.className   = 'upload-status success';

    if (currentTrack === 'question') {
      currentQ.hasQuestionAudio = true;
      currentQ.questionDriveLink = data.webViewLink;
    } else {
      currentQ.hasOptionsAudio = true;
      currentQ.optionsDriveLink = data.webViewLink;
    }

    const hasOpts = Array.isArray(currentQ.options) && currentQ.options.length > 0;
    currentQ.hasAudio = hasOpts ? (currentQ.hasQuestionAudio && currentQ.hasOptionsAudio) : currentQ.hasQuestionAudio;
    currentQ.hasPartial = !currentQ.hasAudio && (currentQ.hasQuestionAudio || currentQ.hasOptionsAudio);
    totalDriveAudios++;

    updateTrackBadges();
    updateCardInGrid(currentQ);
    updateStats();

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
  audioChunks  = [];
  elapsedSeconds = 0;
  timerEl.textContent    = '00:00';
  btnRecord.disabled     = false;
  btnRecord.classList.remove('recording');
  btnStop.disabled       = true;
  btnPlay.disabled       = true;
  btnUpload.disabled     = true;
  btnPlay.innerHTML      = '<span class="btn-icon">▶</span> Play';
  uploadStatus.textContent = '';
  uploadStatus.className = 'upload-status';
  playbackAudio.src      = '';
  clearWaveform();
}

function getSupportedMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

function blobExtension(mimeType) {
  if (mimeType.includes('webm')) return '.webm';
  if (mimeType.includes('ogg'))  return '.ogg';
  if (mimeType.includes('mp4'))  return '.m4a';
  if (mimeType.includes('wav'))  return '.wav';
  return '.webm';
}

function updateCardInGrid(q) {
  const card = grid.querySelector(`[data-id="${q.id}"]`);
  if (!card) return;
  const newCard = buildCard(q);
  card.replaceWith(newCard);
}
