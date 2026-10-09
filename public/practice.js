/**
 * practice.js — warm-up round for recorders.
 * Recordings stay in the browser; nothing is uploaded.
 */

'use strict';

let lang      = localStorage.getItem('dcs_audio_lang') || 'akan';
let questions = [];
let index     = 0;

let mediaRecorder = null;
let chunks        = [];
let micStream     = null;
let audioCtx      = null;
let analyser      = null;
let animFrameId   = null;
let timerInterval = null;
let seconds       = 0;

const card      = document.getElementById('practice-card');
const counter   = document.getElementById('p-counter');
const barFill   = document.getElementById('p-bar-fill');
const btnRecord = document.getElementById('btn-record');
const btnStop   = document.getElementById('btn-stop');
const btnPlay   = document.getElementById('btn-play');
const btnPrev   = document.getElementById('btn-prev');
const btnNext   = document.getElementById('btn-next');
const btnNew    = document.getElementById('btn-new-set');
const timerEl   = document.getElementById('record-timer');
const canvas    = document.getElementById('waveform');
const audioEl   = document.getElementById('playback-audio');
const langBtns  = document.querySelectorAll('.lang-btn');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Loading ────────────────────────────────────────────────────────────────
async function load({ keepIds = false } = {}) {
  const ids = keepIds ? questions.map((q) => q.id).join(',') : '';
  const keepIndex = keepIds ? index : 0;
  card.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading questions…</p></div>';
  try {
    const url = `/api/practice?lang=${lang}&count=15` + (ids ? `&ids=${encodeURIComponent(ids)}` : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    questions = (await res.json()).questions;
    index = Math.min(keepIndex, Math.max(questions.length - 1, 0));
    show();
  } catch (err) {
    card.innerHTML = `<p>⚠️ Could not load questions: ${escapeHtml(err.message)}</p>`;
  }
}

function show() {
  resetRecording();
  const q = questions[index];
  if (!q) {
    card.innerHTML = '<p>No questions available.</p>';
    return;
  }

  const opts = q.options && q.options.length
    ? `<p class="p-opts-title">Options — read them all in sequence:</p>
       <ol>${q.options.map((o) => `<li>${escapeHtml(o)}</li>`).join('')}</ol>`
    : '';
  card.innerHTML = `<span class="p-qid">${escapeHtml(q.id)}</span>
    <p class="p-text">${escapeHtml(q.text)}</p>${opts}`;

  counter.textContent = `${index + 1} / ${questions.length}`;
  barFill.style.width = `${((index + 1) / questions.length) * 100}%`;
  btnPrev.disabled = index === 0;
  btnNext.textContent = index === questions.length - 1 ? 'Finish ✔' : 'Next →';
}

function showDone() {
  resetRecording();
  card.innerHTML = `<div class="practice-done">
    <h2>🎉 Warm-up complete</h2>
    <p>You read ${questions.length} questions. You're ready to record for real.</p>
    <a href="/" class="btn btn-upload">Go to recorder</a>
  </div>`;
  btnNext.disabled = true;
}

// ── Language ───────────────────────────────────────────────────────────────
function setLang(next) {
  if (next === lang) return;
  stopRecording();
  lang = next;
  localStorage.setItem('dcs_audio_lang', lang);
  langBtns.forEach((b) => b.classList.toggle('active', b.dataset.lang === lang));
  load({ keepIds: true });   // same questions, other language
}

langBtns.forEach((b) => {
  b.classList.toggle('active', b.dataset.lang === lang);
  b.addEventListener('click', () => setLang(b.dataset.lang));
});

btnNew.addEventListener('click', () => { stopRecording(); btnNext.disabled = false; load(); });
btnPrev.addEventListener('click', () => { if (index > 0) { index--; show(); } });
btnNext.addEventListener('click', () => {
  if (index < questions.length - 1) { index++; show(); } else { showDone(); }
});

// ── Recording (local only) ─────────────────────────────────────────────────
btnRecord.addEventListener('click', startRecording);
btnStop.addEventListener('click', stopRecording);
btnPlay.addEventListener('click', () => {
  if (!audioEl.src) return;
  if (audioEl.paused) { audioEl.play(); btnPlay.innerHTML = '<span class="btn-icon">⏸</span> Pause'; }
  else { audioEl.pause(); btnPlay.innerHTML = '<span class="btn-icon">▶</span> Play'; }
});
audioEl.addEventListener('ended', () => { btnPlay.innerHTML = '<span class="btn-icon">▶</span> Play'; });

function getMimeType() {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
    .find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function startRecording() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert('Microphone access denied: ' + err.message);
    return;
  }

  audioCtx = new AudioContext();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  audioCtx.createMediaStreamSource(micStream).connect(analyser);
  drawWaveform();

  chunks = [];
  const mimeType = getMimeType();
  mediaRecorder = new MediaRecorder(micStream, mimeType ? { mimeType } : {});
  mediaRecorder.addEventListener('dataavailable', (e) => { if (e.data.size > 0) chunks.push(e.data); });
  mediaRecorder.addEventListener('stop', () => {
    audioEl.src = URL.createObjectURL(new Blob(chunks, { type: mimeType || 'audio/webm' }));
    btnPlay.disabled = false;
  });
  mediaRecorder.start(250);

  seconds = 0;
  timerEl.textContent = '00:00';
  timerInterval = setInterval(() => {
    seconds++;
    timerEl.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }, 1000);

  btnRecord.disabled = true;
  btnRecord.classList.add('recording');
  btnStop.disabled = false;
  btnPlay.disabled = true;
}

function stopRecording() {
  clearInterval(timerInterval);
  cancelAnimationFrame(animFrameId);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; analyser = null; }
  btnRecord.disabled = false;
  btnRecord.classList.remove('recording');
  btnStop.disabled = true;
}

function resetRecording() {
  stopRecording();
  chunks = [];
  audioEl.pause();
  audioEl.removeAttribute('src');
  btnPlay.disabled = true;
  btnPlay.innerHTML = '<span class="btn-icon">▶</span> Play';
  timerEl.textContent = '00:00';
  clearWaveform();
}

function drawWaveform() {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const data = new Uint8Array(analyser.frequencyBinCount);
  (function frame() {
    animFrameId = requestAnimationFrame(frame);
    analyser.getByteTimeDomainData(data);
    ctx.fillStyle = '#f8f9fa';
    ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#1a73e8';
    ctx.beginPath();
    const slice = W / data.length;
    data.forEach((d, i) => {
      const y = (d / 128) * H / 2;
      i === 0 ? ctx.moveTo(0, y) : ctx.lineTo(i * slice, y);
    });
    ctx.lineTo(W, H / 2);
    ctx.stroke();
  })();
}

function clearWaveform() {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f8f9fa';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

load();
