/**
 * practice.js — Mandatory practice round for audio contributors.
 * Contributors must record and save warm-up takes for all practice questions,
 * submit their session, and wait for administrator greenlight before
 * accessing the actual recording studio.
 */

'use strict';

let lang        = localStorage.getItem('dcs_audio_lang') || 'akan';
let assignedLanguage = null;
let questions   = [];
let index       = 0;
let currentUser = localStorage.getItem('dcs_audio_user') || 'default_user';
let userProfile = null;

// Track saved questions for practice
const savedQuestionIds = new Set();
let pollInterval = null;

let wavRecorder   = null;
let micStream     = null;
let audioCtx      = null;
let analyser      = null;
let animFrameId   = null;
let timerInterval = null;
let seconds       = 0;
let takeBlob      = null;

// DOM refs
const card             = document.getElementById('practice-card');
const counter          = document.getElementById('p-counter');
const barFill          = document.getElementById('p-bar-fill');
const badgeSavedTakes  = document.getElementById('badge-saved-takes');
const btnRecord        = document.getElementById('btn-record');
const btnStop          = document.getElementById('btn-stop');
const btnPlay          = document.getElementById('btn-play');
const btnPrev          = document.getElementById('btn-prev');
const btnNext          = document.getElementById('btn-next');
const btnSave          = document.getElementById('btn-save');
const saveStatus       = document.getElementById('save-status');
const btnNew           = document.getElementById('btn-new-set');
const timerEl          = document.getElementById('record-timer');
const canvas           = document.getElementById('waveform');
const audioEl          = document.getElementById('playback-audio');
const langBtns         = document.querySelectorAll('.lang-btn');

const userNameEl       = document.getElementById('practice-user-name');
const btnBackToRec     = document.getElementById('btn-back-to-recorder');
const btnSignout       = document.getElementById('btn-practice-signout');
const noticeBanner     = document.getElementById('practice-notice-banner');
const practiceWork     = document.getElementById('practice-workspace');
const waitingScreen    = document.getElementById('waiting-approval-screen');
const btnManualCheck   = document.getElementById('btn-manual-check');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function updateSavedProgress() {
  if (badgeSavedTakes) {
    const total = questions.length || 3;
    const saved = savedQuestionIds.size;
    badgeSavedTakes.textContent = `💾 ${saved} / ${total} saved`;
    if (saved >= total && total > 0) {
      badgeSavedTakes.style.color = '#15803d';
      badgeSavedTakes.style.background = '#dcfce7';
    } else {
      badgeSavedTakes.style.color = '#1e293b';
      badgeSavedTakes.style.background = '#f1f5f9';
    }
  }
}

// ── Loading Questions ──────────────────────────────────────────────────────
async function load({ keepIds = false } = {}) {
  const ids = keepIds ? questions.map((q) => q.id).join(',') : '';
  const keepIndex = keepIds ? index : 0;
  if (card) {
    card.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading practice questions…</p></div>';
  }
  try {
    const url = `/api/practice?lang=${lang}&count=3` + (ids ? `&ids=${encodeURIComponent(ids)}` : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    questions = data.questions || [];
    index = Math.min(keepIndex, Math.max(questions.length - 1, 0));
    updateSavedProgress();
    show();
  } catch (err) {
    if (card) {
      card.innerHTML = `<p>⚠️ Could not load questions: ${escapeHtml(err.message)}</p>`;
    }
  }
}

function show() {
  resetRecording();
  const q = questions[index];
  if (!q) {
    if (card) card.innerHTML = '<p>No questions available.</p>';
    return;
  }

  const isSaved = savedQuestionIds.has(q.id);
  const statusBadge = isSaved
    ? `<span class="p-saved-badge">✅ Practice take saved</span>`
    : `<span class="p-unsaved-badge">⚠️ Practice take required</span>`;

  const opts = q.options && q.options.length
    ? `<p class="p-opts-title">Options — read them all in sequence:</p>
       <ol>${q.options.map((o) => `<li>${escapeHtml(o)}</li>`).join('')}</ol>`
    : '';

  if (card) {
    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <span class="p-qid">${escapeHtml(q.id)}</span>
        ${statusBadge}
      </div>
      <p class="p-text">${escapeHtml(q.text)}</p>
      ${opts}
    `;
  }

  if (counter) counter.textContent = `${index + 1} / ${questions.length}`;
  if (barFill) barFill.style.width = `${((index + 1) / questions.length) * 100}%`;
  if (btnPrev) btnPrev.disabled = index === 0;

  if (btnNext) {
    if (index === questions.length - 1) {
      const allSaved = questions.length > 0 && questions.every(qItem => savedQuestionIds.has(qItem.id));
      if (allSaved) {
        btnNext.textContent = 'Submit for Approval 🚀';
        btnNext.className = 'btn btn-upload';
      } else {
        const remaining = questions.filter(qItem => !savedQuestionIds.has(qItem.id)).length;
        btnNext.textContent = `Submit (${remaining} left)`;
        btnNext.className = 'btn btn-play';
      }
    } else {
      btnNext.textContent = 'Next →';
      btnNext.className = 'btn btn-play';
    }
  }

  updateSavedProgress();
}

// ── Language ───────────────────────────────────────────────────────────────
function setLang(next) {
  if (assignedLanguage && next !== assignedLanguage) return;
  if (next === lang) return;
  stopRecording();
  lang = next;
  localStorage.setItem('dcs_audio_lang', lang);
  langBtns.forEach((b) => b.classList.toggle('active', b.dataset.lang === lang));
  load({ keepIds: true });
}

langBtns.forEach((b) => {
  b.classList.toggle('active', b.dataset.lang === lang);
  b.addEventListener('click', () => setLang(b.dataset.lang));
});

if (btnNew) {
  btnNew.addEventListener('click', () => {
    stopRecording();
    load();
  });
}

if (btnPrev) {
  btnPrev.addEventListener('click', () => {
    if (index > 0) {
      index--;
      show();
    }
  });
}

if (btnNext) {
  btnNext.addEventListener('click', async () => {
    const currentQ = questions[index];

    // If on intermediate question
    if (index < questions.length - 1) {
      if (currentQ && !savedQuestionIds.has(currentQ.id)) {
        const proceed = confirm(
          `You have not saved a take for ${currentQ.id} yet.\n\nAll 3 practice items must be recorded and saved before you can submit for admin approval. Proceed to the next question anyway?`
        );
        if (!proceed) return;
      }
      index++;
      show();
      return;
    }

    // On last question — attempt to submit practice session
    const unrecorded = questions.filter(qItem => !savedQuestionIds.has(qItem.id));
    if (unrecorded.length > 0) {
      alert(
        `Cannot submit yet:\nYou still have ${unrecorded.length} practice question(s) unrecorded.\n\nPlease go back and record all items to complete your practice requirement.`
      );
      // Navigate to the first unrecorded question
      const firstUnrecordedIdx = questions.findIndex(qItem => !savedQuestionIds.has(qItem.id));
      if (firstUnrecordedIdx !== -1) {
        index = firstUnrecordedIdx;
        show();
      }
      return;
    }

    // All questions saved — submit for approval!
    await submitPracticeSession();
  });
}

// ── Submit Practice Session ────────────────────────────────────────────────
async function submitPracticeSession() {
  if (btnNext) {
    btnNext.disabled = true;
    btnNext.textContent = 'Submitting…';
  }

  try {
    const res = await fetch('/api/practice/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to submit practice');

    showWaitingForApprovalView();
  } catch (err) {
    alert(`Could not submit practice: ${err.message}`);
    if (btnNext) {
      btnNext.disabled = false;
      btnNext.textContent = 'Submit for Approval 🚀';
    }
  }
}

// ── Live Waiting Screen & Polling ──────────────────────────────────────────
function showWaitingForApprovalView() {
  stopRecording();
  if (practiceWork) practiceWork.style.display = 'none';
  if (waitingScreen) waitingScreen.style.display = 'block';
  if (noticeBanner) {
    noticeBanner.style.background = '#fef3c7';
    noticeBanner.style.borderColor = '#fde68a';
    noticeBanner.style.color = '#92400e';
    noticeBanner.innerHTML = '⏳ <strong>Status:</strong> Practice session submitted! Awaiting administrator green light.';
  }

  startApprovalPolling();
}

function startApprovalPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(checkApprovalStatus, 3500);
}

async function checkApprovalStatus(isManual = false) {
  try {
    const res = await fetch('/api/practice/status');
    const data = await res.json();
    if (!data || !data.authenticated) {
      window.location.replace('/user-login.html');
      return;
    }

    if (data.practiceApproved) {
      if (pollInterval) clearInterval(pollInterval);
      showApprovalCelebration();
      return;
    }

    if (isManual) {
      alert('Your administrator has not approved your profile yet. Please wait a moment or notify your supervisor.');
    }
  } catch (err) {
    if (isManual) alert(`Could not check status: ${err.message}`);
  }
}

function showApprovalCelebration() {
  if (waitingScreen) {
    waitingScreen.innerHTML = `
      <div class="waiting-card">
        <div style="font-size:3.5rem; margin-bottom:12px;">🎉</div>
        <h2 style="color:#15803d;">Greenlight Granted!</h2>
        <p class="waiting-sub" style="color:#166534;">
          The administrator has approved your contributor account. Launching the recording studio…
        </p>
        <div class="loading-state" style="margin-top:16px;">
          <div class="spinner"></div>
        </div>
      </div>
    `;
  }

  setTimeout(() => {
    window.location.replace('/');
  }, 1500);
}

// ── Recording (Local & WAV) ────────────────────────────────────────────────
if (btnRecord) btnRecord.addEventListener('click', startRecording);
if (btnStop) btnStop.addEventListener('click', stopRecording);
if (btnPlay) btnPlay.addEventListener('click', () => {
  if (!audioEl || !audioEl.src) return;
  if (audioEl.paused) {
    audioEl.play();
    btnPlay.innerHTML = '<span class="btn-icon">⏸</span> Pause';
  } else {
    audioEl.pause();
    btnPlay.innerHTML = '<span class="btn-icon">▶</span> Play';
  }
});
if (audioEl) audioEl.addEventListener('ended', () => {
  if (btnPlay) btnPlay.innerHTML = '<span class="btn-icon">▶</span> Play';
});

async function startRecording() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert('Microphone access denied: ' + err.message);
    return;
  }

  const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioCtxClass();
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch (_) {}
  }

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  audioCtx.createMediaStreamSource(micStream).connect(analyser);
  drawWaveform();

  takeBlob = null;
  wavRecorder = new window.WavRecorder();
  wavRecorder.start(micStream);

  if (saveStatus) saveStatus.textContent = '';
  seconds = 0;
  if (timerEl) timerEl.textContent = '00:00';
  timerInterval = setInterval(() => {
    seconds++;
    if (timerEl) {
      timerEl.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    }
  }, 1000);

  btnRecord.disabled = true;
  btnRecord.classList.add('recording');
  btnStop.disabled = false;
  btnPlay.disabled = true;
}

function stopRecording() {
  clearInterval(timerInterval);
  cancelAnimationFrame(animFrameId);

  if (wavRecorder) {
    try {
      takeBlob = wavRecorder.stop();
      if (audioEl) audioEl.src = URL.createObjectURL(takeBlob);
      if (btnPlay) btnPlay.disabled = false;
      if (btnSave) btnSave.disabled = false;
    } catch (e) {
      console.error('Practice WAV stop error:', e);
    }
    wavRecorder = null;
  }

  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }

  if (audioCtx) {
    try { audioCtx.close(); } catch (_) {}
    audioCtx = null;
    analyser = null;
  }

  if (btnRecord) {
    btnRecord.disabled = false;
    btnRecord.classList.remove('recording');
  }
  if (btnStop) btnStop.disabled = true;
}

function resetRecording() {
  stopRecording();
  if (audioEl) {
    audioEl.pause();
    audioEl.removeAttribute('src');
  }
  if (btnPlay) {
    btnPlay.disabled = true;
    btnPlay.innerHTML = '<span class="btn-icon">▶</span> Play';
  }
  if (timerEl) timerEl.textContent = '00:00';
  takeBlob = null;
  if (btnSave) btnSave.disabled = true;
  if (saveStatus) saveStatus.textContent = '';
  clearWaveform();
}

if (btnSave) {
  btnSave.addEventListener('click', async () => {
    const q = questions[index];
    if (!takeBlob || !q) return;

    btnSave.disabled = true;
    saveStatus.className = 'upload-status';
    saveStatus.textContent = '⏳ Saving WAV…';

    const form = new FormData();
    form.append('audio', takeBlob, `practice_${q.id}_${lang}.wav`);
    form.append('questionId', q.id);
    form.append('lang', lang);
    form.append('user', currentUser);

    try {
      const res = await fetch('/api/practice-upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

      savedQuestionIds.add(q.id);
      saveStatus.className = 'upload-status success';
      saveStatus.textContent = `✅ Saved! Practice take for ${q.id} recorded.`;

      // Refresh question view to show green check badge
      show();
    } catch (err) {
      saveStatus.className = 'upload-status error';
      saveStatus.textContent = `❌ Save failed: ${err.message}`;
      btnSave.disabled = false;
    }
  });
}

function drawWaveform() {
  if (!canvas || !analyser) return;
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
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f8f9fa';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// ── Contributor Signout & Manual Check Handlers ────────────────────────────
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

if (btnManualCheck) {
  btnManualCheck.addEventListener('click', () => checkApprovalStatus(true));
}

// ── Initialization ─────────────────────────────────────────────────────────
async function initPractice() {
  try {
    const res = await fetch('/api/practice/status');
    const data = await res.json();
    if (!data || !data.authenticated || !data.user) {
      window.location.replace('/user-login.html');
      return;
    }

    userProfile = data.user;
    currentUser = data.user.username;
    localStorage.setItem('dcs_audio_user', currentUser);
    assignedLanguage = data.user.language || null;
    if (assignedLanguage) {
      lang = assignedLanguage;
      localStorage.setItem('dcs_audio_lang', lang);
    }
    langBtns.forEach((button) => {
      button.style.display = !assignedLanguage || button.dataset.lang === assignedLanguage ? '' : 'none';
    });

    if (userNameEl) {
      userNameEl.textContent = data.user.displayName || currentUser;
    }

    // Populate previously saved takes
    if (Array.isArray(data.savedQuestionIds)) {
      data.savedQuestionIds.forEach(id => savedQuestionIds.add(id));
    }

    // If user is already approved:
    if (data.practiceApproved) {
      if (btnBackToRec) btnBackToRec.style.display = 'inline-block';
      if (noticeBanner) {
        noticeBanner.style.background = '#dcfce7';
        noticeBanner.style.borderColor = '#bbf7d0';
        noticeBanner.style.color = '#15803d';
        noticeBanner.innerHTML = '✅ <strong>Approved for Recording:</strong> You have received administrator green light! You can warm up here anytime or return to the main studio.';
      }
      load();
      return;
    }

    // If practice was already completed and is waiting for admin review:
    if (data.practiceCompleted && !data.practiceApproved) {
      showWaitingForApprovalView();
      return;
    }

    // Otherwise, contributor is in active warm-up round:
    load();
  } catch (err) {
    console.error('initPractice error:', err);
    window.location.replace('/user-login.html');
  }
}

initPractice();
