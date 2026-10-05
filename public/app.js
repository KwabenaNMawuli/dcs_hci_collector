/**
 * app.js  —  DCS HCI Audio Collector frontend
 *
 * Features:
 *  - Fetches question list + Drive status from /api/questions
 *  - Renders a searchable, filterable grid of question cards
 *  - Opens a recording modal per question
 *  - Records audio via MediaRecorder API with live waveform visualisation
 *  - Uploads the recorded blob to the server → Google Drive
 *  - Allows re-recording (replaces existing file)
 *  - Card badges update after upload
 */

'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let allQuestions   = [];      // full list from the API
let currentQ       = null;    // question being recorded

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
const statMissing  = document.getElementById('stat-missing');
const statTotal    = document.getElementById('stat-total');
const btnAuthDrive = document.getElementById('btn-auth-drive');
const badgeDriveConnected = document.getElementById('badge-drive-connected');

// ── Init ───────────────────────────────────────────────────────────────────
(async function init() {
  await checkAuthStatus();
  await loadQuestions();
  bindToolbar();
})();

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth-status');
    const data = await res.json();
    if (data.authenticated) {
      if (badgeDriveConnected) badgeDriveConnected.style.display = 'inline-flex';
      if (btnAuthDrive) btnAuthDrive.style.display = 'none';
    } else {
      if (btnAuthDrive) btnAuthDrive.style.display = 'inline-flex';
      if (badgeDriveConnected) badgeDriveConnected.style.display = 'none';
    }
  } catch (err) {
    console.warn('Could not check auth status:', err);
  }
}

// ── Data loading ───────────────────────────────────────────────────────────
async function loadQuestions() {
  try {
    const res = await fetch('/api/questions');
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    allQuestions = data.questions;
    updateStats();
    renderGrid(allQuestions);
  } catch (err) {
    grid.innerHTML = `<div class="empty-state">
      <p>⚠️ Could not load questions: ${err.message}</p>
      <p style="font-size:.8rem;margin-top:8px">Check that the server is running and DOCX_PATH is configured.</p>
    </div>`;
  }
}

function updateStats() {
  const total    = allQuestions.length;
  const recorded = allQuestions.filter(q => q.hasAudio).length;
  const missing  = total - recorded;
  statTotal.textContent    = total;
  statRecorded.textContent = recorded;
  statMissing.textContent  = missing;
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
  card.className = `q-card ${q.hasAudio ? 'recorded' : 'missing'}`;
  card.dataset.id = q.id;

  card.innerHTML = `
    <div class="card-top">
      <span class="q-id">${q.id}</span>
      <span class="q-badge ${q.hasAudio ? 'recorded' : 'missing'}">
        ${q.hasAudio ? '✔ Recorded' : 'No audio'}
      </span>
    </div>
    <p class="q-text">${q.text || '<em>No text available</em>'}</p>
    <div class="card-actions">
      <button class="btn-card btn-card-record" data-id="${q.id}">
        🎙 ${q.hasAudio ? 'Re-record' : 'Record'}
      </button>
      ${q.hasAudio && q.driveLink
        ? `<button class="btn-card btn-card-play" data-link="${q.driveLink}" title="Open in Drive">▶ Play</button>`
        : `<button class="btn-card btn-card-play" disabled title="No audio yet">▶ Play</button>`
      }
    </div>
  `;

  // Record button → open modal
  card.querySelector('.btn-card-record').addEventListener('click', (e) => {
    e.stopPropagation();
    const q = allQuestions.find(x => x.id === card.dataset.id);
    openModal(q);
  });

  // Play button → open Drive link
  const playBtn = card.querySelector('.btn-card-play');
  if (!playBtn.disabled) {
    playBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(playBtn.dataset.link, '_blank');
    });
  }

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
    if (filter === 'missing'  &&  q.hasAudio) return false;
    if (query) {
      return q.id.toLowerCase().includes(query) ||
             (q.text && q.text.toLowerCase().includes(query));
    }
    return true;
  });

  renderGrid(filtered);
}

// ── Modal open / close ─────────────────────────────────────────────────────
function openModal(q) {
  currentQ = q;

  modalQid.textContent   = q.id;
  modalTitle.textContent = q.text || 'No question text';

  // Reset recording state
  resetRecordingUI();
  replaceWarn.hidden = !q.hasAudio;

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

  // Web Audio analyser for waveform
  audioCtx  = new AudioContext();
  analyser  = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  const source = audioCtx.createMediaStreamSource(micStream);
  source.connect(analyser);
  drawWaveform();

  // MediaRecorder
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

  mediaRecorder.start(250); // collect every 250ms

  // Timer
  elapsedSeconds = 0;
  timerEl.textContent = '00:00';
  timerInterval = setInterval(() => {
    elapsedSeconds++;
    const m = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
    const s = String(elapsedSeconds % 60).padStart(2, '0');
    timerEl.textContent = `${m}:${s}`;
  }, 1000);

  // UI state
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
  formData.append('audio', recordedBlob, `${currentQ.id}${ext}`);
  formData.append('questionId', currentQ.id);
  formData.append('replace', currentQ.hasAudio ? 'true' : 'false');

  try {
    const res  = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

    uploadStatus.textContent = `✅ Uploaded as ${data.filename}`;
    uploadStatus.className   = 'upload-status success';

    // Update local state + refresh card
    currentQ.hasAudio   = true;
    currentQ.driveLink  = data.webViewLink;
    replaceWarn.hidden  = false;
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

// ── Helpers ────────────────────────────────────────────────────────────────
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

