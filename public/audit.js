/**
 * audit.js — contributor self-audit.
 * Shows every questionnaire item for the signed-in contributor, whether a recording
 * reached Google Drive, lets them listen back and tick items off, and sign off at the end.
 * Read-only: transcripts cannot be edited here.
 */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const AV = window.AudioViewer;

  const done = new Set();
  let data = null;

  const viewer = AV.create({
    done,
    doneLabel: 'Checked',
    editable: false,
    onDone: saveMark,
    onProgress: (p) => { $('stChecked').textContent = `${p.done} of ${p.reviewable}`; },
    onSelect: (it) => $('recordLink').classList.toggle('hidden', it.status !== 'missing'),
  });

  /* ---------- api ---------- */
  async function api(url, options) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    let body = null;
    try { body = await res.json(); } catch (_) { /* non-JSON error page */ }
    if (res.status === 401) {
      location.replace('/user-login.html');
      throw new Error('Signed out');
    }
    return { res, body };
  }

  /* ---------- screens ---------- */
  function showMessage(icon, title, text, canRetry) {
    $('msgIcon').textContent = icon;
    $('msgTitle').textContent = title;
    $('msgBody').textContent = text;
    $('msgActions').classList.toggle('hidden', !canRetry);
    $('landing').classList.remove('hidden');
    $('bar').classList.add('hidden');
    $('app').classList.add('hidden');
  }

  function fitBar() {
    document.documentElement.style.setProperty('--bar-h', $('bar').offsetHeight + 'px');
  }
  window.addEventListener('resize', () => { if (!$('bar').classList.contains('hidden')) fitBar(); });

  function updateBar() {
    const s = data.summary;
    $('stRecorded').textContent = s.recorded;
    $('stTotal').textContent = s.total;
    $('stMissing').textContent = s.missing;
    $('stPending').textContent = s.pending;
    $('stMissingWrap').classList.toggle('hidden', s.missing === 0);
    $('stPendingWrap').classList.toggle('hidden', s.pending === 0);
    $('showMissingBtn').classList.toggle('hidden', s.missing === 0);

    const signed = Boolean(data.signedOffAt);
    $('signedLbl').classList.toggle('hidden', !signed);
    $('reopenBtn').classList.toggle('hidden', !signed);
    $('signoffBtn').classList.toggle('hidden', signed);
    if (signed) {
      $('signedLbl').textContent = `✓ Signed off on ${new Date(data.signedOffAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    fitBar();
  }

  function renderLangTabs() {
    const tabs = $('langTabs');
    tabs.classList.toggle('hidden', data.langs.length < 2);
    tabs.innerHTML = data.langs
      .map((l) => `<button type="button" data-lang="${AV.esc(l)}" class="${l === data.lang ? 'on' : ''}">${l === 'ewe' ? 'Ewe' : 'Akan'}</button>`)
      .join('');
    tabs.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => load(b.dataset.lang)));
  }

  function toItems(list) {
    return list.map((it) => {
      const trackLabel = it.track === 'options' ? 'Answer options' : 'Question';
      return {
        key: it.key,
        name: `${it.questionId} · ${trackLabel}`,
        num: it.questionId,
        text: it.text,
        status: it.status,
        chips: [
          { label: 'Track', value: trackLabel },
          { label: 'Language', value: it.lang === 'ewe' ? 'Ewe' : 'Akan' },
          { label: 'File', value: it.name },
        ],
        filters: { track: { label: 'tracks', value: trackLabel } },
        audio: it.streamUrl ? { url: it.streamUrl } : null,
      };
    });
  }

  /* ---------- load ---------- */
  async function load(lang) {
    showMessage('⏳', 'Loading your recordings…', 'Checking Google Drive for everything you have recorded.', false);
    try {
      const { res, body } = await api('/api/my-audit' + (lang ? `?lang=${encodeURIComponent(lang)}` : ''));
      if (!res.ok) {
        showMessage('⚠️', 'Couldn’t check your recordings', (body && body.error) || `Server error ${res.status}`, true);
        return;
      }
      data = body;
      done.clear();
      body.reviewed.forEach((k) => done.add(k));
      $('whoChip').textContent = body.user;

      $('landing').classList.add('hidden');
      $('bar').classList.remove('hidden');
      $('app').classList.remove('hidden');
      $('app').classList.add('has-bar');

      renderLangTabs();
      updateBar();
      viewer.setItems(toItems(body.items));
    } catch (err) {
      if (err.message !== 'Signed out') {
        showMessage('⚠️', 'Couldn’t reach the server', 'Check your internet connection and try again.', true);
      }
    }
  }

  /* ---------- check marks ---------- */
  async function saveMark(key, isDone) {
    try {
      const { res } = await api('/api/my-audit/reviewed', { method: 'POST', body: JSON.stringify({ key, reviewed: isDone }) });
      if (!res.ok) throw new Error('save failed');
    } catch (_) {
      isDone ? done.delete(key) : done.add(key);
      viewer.refresh();
      AV.toast('Couldn’t save that tick. Check your connection and try again.');
    }
  }

  /* ---------- sign-off ---------- */
  async function signOff(acknowledgeMissing) {
    const { res, body } = await api('/api/my-audit/signoff', { method: 'POST', body: JSON.stringify({ acknowledgeMissing }) });
    if (res.status === 409 && !acknowledgeMissing) {
      const s = body.summary;
      if (confirm(`${s.missing} of ${s.total} items still have no recording.\n\nSign off anyway? You can reopen your audit later and record them.`)) {
        return signOff(true);
      }
      return;
    }
    if (!res.ok) {
      AV.toast((body && body.error) || 'Couldn’t sign off. Please try again.');
      return;
    }
    data.signedOffAt = body.signedOffAt;
    updateBar();
    AV.toast('Signed off. Thank you!');
  }

  $('signoffBtn').onclick = () => {
    const p = viewer.state.items.filter((i) => i.status !== 'missing');
    const unchecked = p.filter((i) => !done.has(i.key)).length;
    const note = unchecked > 0 ? `\n\n${unchecked} recording(s) in this language are not ticked as checked yet.` : '';
    if (confirm(`Sign off your audit? This tells the team you have listened to your recordings and everything is in place.${note}`)) {
      signOff(false);
    }
  };

  $('reopenBtn').onclick = async () => {
    const { res } = await api('/api/my-audit/reopen', { method: 'POST' });
    if (!res.ok) return AV.toast('Couldn’t reopen your audit. Please try again.');
    data.signedOffAt = null;
    updateBar();
  };

  $('showMissingBtn').onclick = () => viewer.setStatusFilter('missing');
  $('retryBtn').onclick = () => load(data ? data.lang : new URLSearchParams(location.search).get('lang'));

  load(new URLSearchParams(location.search).get('lang'));
})();
