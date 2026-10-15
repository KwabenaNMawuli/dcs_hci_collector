/**
 * viewer-core.js — shared list + transcript + audio player used by
 * audit.html (contributors, read-only) and review.html (admins, editable).
 *
 * The pages own where items come from and where review marks / edits are saved;
 * the core only renders them and reports changes through callbacks.
 *
 * item: {
 *   key      unique and stable (used for review marks and edits)
 *   name     title shown in the list and header
 *   num      label in the list gutter
 *   text     transcript (options tracks are one option per line)
 *   status   'ok' | 'pending' | 'missing'   (omit for 'ok')
 *   chips    [{ label, value }] extra facts shown above the text
 *   filters  { id: { label, value } } adds a dropdown filter per id
 *   audio    { url, file?, local? } | null  (or supply opts.resolveAudio)
 * }
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (t) => {
    if (!isFinite(t)) return '0:00';
    t = Math.max(0, t);
    return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  };

  const store = {
    get(k, d) { try { const v = localStorage.getItem('av:' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('av:' + k, JSON.stringify(v)); } catch (_) {} },
  };

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  function create(opts) {
    opts = opts || {};
    const audio = $('audio');
    const done = opts.done || new Set();
    const edits = opts.edits || {};
    const editable = Boolean(opts.editable && $('editor'));
    const doneLabel = opts.doneLabel || 'Reviewed';

    const S = {
      items: [], view: [], cur: -1, filters: {}, query: '',
      auto: store.get('auto', false), loop: false, fs: store.get('fs', 22),
      peaks: null, loadToken: 0, editing: false,
    };

    /* ---------- item helpers ---------- */
    const status = (it) => it.status || 'ok';
    const isEdited = (it) => Object.prototype.hasOwnProperty.call(edits, it.key);
    const textOf = (it) => (isEdited(it) ? edits[it.key] : it.text || '');
    const audioFor = (it) => (opts.resolveAudio ? opts.resolveAudio(it) : it.audio) || null;
    const cur = () => (S.cur >= 0 ? S.items[S.view[S.cur]] : null);

    /* ---------- filters ---------- */
    function buildFilters() {
      const defs = new Map();
      for (const it of S.items) {
        for (const [id, f] of Object.entries(it.filters || {})) {
          if (!defs.has(id)) defs.set(id, { label: f.label, values: new Set() });
          defs.get(id).values.add(f.value);
        }
      }
      let html = '';
      for (const [id, d] of defs) {
        const vals = [...d.values].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
        html += `<select data-f="${esc(id)}"><option value="">All ${esc(d.label)}</option>${vals.map((v) => `<option>${esc(v)}</option>`).join('')}</select>`;
      }
      const hasMissing = S.items.some((i) => status(i) === 'missing');
      const hasPending = S.items.some((i) => status(i) === 'pending');
      html += `<select data-f="__status"><option value="">All items</option><option value="todo">Not ${esc(doneLabel.toLowerCase())}</option><option value="done">${esc(doneLabel)}</option>`
        + (editable ? '<option value="edited">Edited</option>' : '')
        + (hasMissing ? '<option value="missing">Missing recording</option>' : '')
        + (hasPending ? '<option value="pending">Waiting for Drive</option>' : '')
        + '</select>';
      $('filters').innerHTML = html;
      $('filters').querySelectorAll('select').forEach((s) => {
        if (S.filters[s.dataset.f]) s.value = S.filters[s.dataset.f];
        s.addEventListener('change', () => {
          S.filters[s.dataset.f] = s.value;
          const keep = cur();
          render();
          reselect(keep);
        });
      });
    }

    function passesStatus(it, v) {
      if (!v) return true;
      if (v === 'done') return done.has(it.key);
      if (v === 'todo') return !done.has(it.key) && status(it) !== 'missing';
      if (v === 'edited') return isEdited(it);
      return status(it) === v;
    }

    /* ---------- list ---------- */
    function render() {
      const q = S.query.toLowerCase();
      S.view = [];
      S.items.forEach((it, i) => {
        for (const [id, v] of Object.entries(S.filters)) {
          if (!v) continue;
          if (id === '__status') { if (!passesStatus(it, v)) return; }
          else if (!it.filters || !it.filters[id] || String(it.filters[id].value) !== v) return;
        }
        if (q && !(String(it.name).toLowerCase().includes(q) || textOf(it).toLowerCase().includes(q) || String(it.num || '').toLowerCase().includes(q))) return;
        S.view.push(i);
      });

      $('list').innerHTML = S.view.map((ii, vi) => {
        const it = S.items[ii];
        const src = status(it) === 'ok' ? audioFor(it) : null;
        const tags = (src && src.local ? '<span class="tag local">LOCAL</span>' : '')
          + (isEdited(it) ? '<span class="tag edited">EDITED</span>' : '')
          + (status(it) === 'missing' ? '<span class="tag missing">MISSING</span>' : '')
          + (status(it) === 'pending' ? '<span class="tag pending">UPLOADING</span>' : '');
        const snip = textOf(it).replace(/\s+/g, ' ').slice(0, 90);
        return `<div class="item" data-v="${vi}"><span class="num">${esc(it.num == null ? ii + 1 : it.num)}</span><div class="body"><div class="name"><span class="nm">${esc(it.name)}</span>${tags}</div><div class="snip">${snip ? esc(snip) : '<i>no text</i>'}</div></div><span class="check ${done.has(it.key) && status(it) !== 'missing' ? 'done' : ''}"></span></div>`;
      }).join('') || '<div class="hint" style="padding:20px;text-align:center">No matches</div>';

      $('countLbl').textContent = `${S.view.length} of ${S.items.length}`;
      updateDone();
    }

    function updateDone() {
      const reviewable = S.items.filter((i) => status(i) !== 'missing');
      const n = reviewable.filter((i) => done.has(i.key)).length;
      $('doneLbl').textContent = `${n} ${doneLabel.toLowerCase()}`;
      $('doneBar').style.width = (reviewable.length ? (n / reviewable.length) * 100 : 0) + '%';
      if (opts.onProgress) opts.onProgress({ done: n, reviewable: reviewable.length, total: S.items.length });
    }

    $('list').addEventListener('click', (e) => {
      const el = e.target.closest('.item');
      if (!el) return;
      select(+el.dataset.v, true);
      document.body.classList.remove('side-open');
    });

    /* ---------- transcript ---------- */
    function renderText(t) {
      if (!t) return '<span class="empty">No transcript for this item.</span>';
      const lines = t.split(/\r?\n/);
      const optRe = /^(.*?)\s*\[(\w+)\]\s*$/;
      const nonEmpty = lines.filter((l) => l.trim());
      if (nonEmpty.length > 1 && nonEmpty.every((l) => optRe.test(l.trim()))) {
        return nonEmpty.map((l) => { const m = l.trim().match(optRe); return `<div class="opt"><b>${esc(m[2])}</b><span>${esc(m[1])}</span></div>`; }).join('');
      }
      return esc(t);
    }

    function select(vi, play) {
      if (!S.view.length) {
        S.cur = -1;
        $('title').textContent = '';
        $('chips').innerHTML = '';
        $('text').innerHTML = '<span class="empty">Nothing to show.</span>';
        stopAudio('');
        return;
      }
      vi = Math.max(0, Math.min(vi, S.view.length - 1));
      if (S.editing && vi !== S.cur) { saveEdit(); render(); }
      S.cur = vi;

      const it = S.items[S.view[vi]];
      if (opts.onSelect) opts.onSelect(it);
      document.querySelectorAll('.item.active').forEach((x) => x.classList.remove('active'));
      const el = $('list').querySelector(`.item[data-v="${vi}"]`);
      if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'nearest' }); }

      $('title').textContent = it.name;
      const chips = (it.chips || []).filter((c) => c.value).map((c) => `<span class="chip">${esc(c.label)}: ${esc(c.value)}</span>`);
      chips.push(`<span class="chip">#${esc(it.num == null ? S.view[vi] + 1 : it.num)}</span>`);
      if (status(it) === 'missing') chips.push('<span class="chip missing">No recording</span>');
      if (status(it) === 'pending') chips.push('<span class="chip pending">Waiting for Drive</span>');
      if (isEdited(it)) chips.push('<span class="chip edited">Edited</span>');
      $('chips').innerHTML = chips.join('');

      const notice = status(it) === 'missing'
        ? '<div class="notice missing">No recording found for this item yet.</div>'
        : status(it) === 'pending'
          ? '<div class="notice pending">This recording was received and is waiting to be saved to Google Drive. It will be playable here shortly.</div>'
          : '';
      $('text').innerHTML = notice + renderText(textOf(it));
      $('text').scrollTop = 0;
      $('doneBtn').classList.toggle('on', done.has(it.key));
      $('doneBtn').disabled = status(it) === 'missing';

      S.peaks = null;
      drawWave();
      const src = status(it) === 'ok' ? audioFor(it) : null;
      if (!src) {
        stopAudio(status(it) === 'missing' ? 'No recording for this item' : status(it) === 'pending' ? 'Not playable yet' : 'No audio for this row');
        return;
      }
      $('waveMsg').textContent = 'Loading…';
      audio.src = src.url;
      audio.playbackRate = +$('speed').value;
      audio.loop = S.loop;
      if (play) audio.play().catch(() => {});
      loadPeaks(src);
    }

    function stopAudio(msg) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      S.loadToken++;
      $('waveMsg').textContent = msg;
      updateTime();
      drawWave();
    }

    function reselect(keepItem) {
      const i = keepItem ? S.view.indexOf(S.items.indexOf(keepItem)) : -1;
      select(i >= 0 ? i : 0, false);
    }

    /* ---------- waveform ---------- */
    let actx;
    async function loadPeaks(src) {
      const token = ++S.loadToken;
      try {
        let buf;
        if (src.file) buf = await src.file.arrayBuffer();
        else if (opts.waveformRemote) buf = await (await fetch(src.url)).arrayBuffer();
        else { $('waveMsg').textContent = ''; return; } // avoid downloading the clip twice on slow connections

        actx = actx || new (window.AudioContext || window.webkitAudioContext)();
        const decoded = await actx.decodeAudioData(buf);
        if (token !== S.loadToken) return;
        const ch = decoded.getChannelData(0);
        const N = 400;
        const step = Math.floor(ch.length / N) || 1;
        const peaks = [];
        for (let i = 0; i < N; i++) {
          let m = 0;
          for (let j = i * step, e = Math.min(ch.length, j + step); j < e; j += 4) m = Math.max(m, Math.abs(ch[j]));
          peaks.push(m);
        }
        const max = Math.max(...peaks) || 1;
        S.peaks = peaks.map((p) => p / max);
        $('waveMsg').textContent = '';
      } catch (_) {
        if (token !== S.loadToken) return;
        S.peaks = null;
        $('waveMsg').textContent = '';
      }
      drawWave();
    }

    const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    function drawWave() {
      const c = $('canvas'), dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
      if (!w) return;
      if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
      const g = c.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const p = audio.duration ? audio.currentTime / audio.duration : 0;
      const acc = cssVar('--clr-primary'), wav = cssVar('--wave');
      const rr = (x, y, ww, hh, r) => { g.beginPath(); g.roundRect ? g.roundRect(x, y, ww, hh, r) : g.rect(x, y, ww, hh); g.fill(); };
      if (S.peaks) {
        const bw = 3, gap = 2, n = Math.floor(w / (bw + gap));
        for (let i = 0; i < n; i++) {
          const v = S.peaks[Math.floor((i / n) * S.peaks.length)];
          const bh = Math.max(3, v * (h - 16)), x = i * (bw + gap);
          g.fillStyle = x / w < p ? acc : wav;
          rr(x, (h - bh) / 2, bw, bh, 1.5);
        }
        g.fillStyle = acc;
        g.fillRect(p * w - 1, 0, 2, h);
      } else {
        g.fillStyle = wav; rr(12, h / 2 - 3, w - 24, 6, 3);
        g.fillStyle = acc; rr(12, h / 2 - 3, (w - 24) * p, 6, 3);
        g.beginPath(); g.arc(12 + (w - 24) * p, h / 2, 8, 0, Math.PI * 2); g.fill();
      }
    }
    let raf;
    function loop() { drawWave(); updateTime(); raf = audio.paused ? null : requestAnimationFrame(loop); }
    function updateTime() { $('time').textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`; }
    new ResizeObserver(drawWave).observe($('wave'));

    const seekTo = (e) => {
      const b = $('wave').getBoundingClientRect();
      if (audio.duration) {
        audio.currentTime = Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)) * audio.duration;
        drawWave(); updateTime();
      }
    };
    $('wave').addEventListener('pointerdown', (e) => {
      $('wave').setPointerCapture(e.pointerId);
      seekTo(e);
      const mv = (ev) => seekTo(ev);
      $('wave').addEventListener('pointermove', mv);
      $('wave').addEventListener('pointerup', () => $('wave').removeEventListener('pointermove', mv), { once: true });
    });

    /* ---------- audio events ---------- */
    const setIcon = (playing) => { $('playIco').innerHTML = playing ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4.5v15l13-7.5z"/>'; };
    audio.addEventListener('play', () => { setIcon(true); if (!raf) loop(); });
    audio.addEventListener('pause', () => setIcon(false));
    audio.addEventListener('loadedmetadata', () => { updateTime(); drawWave(); });
    audio.addEventListener('canplay', () => { if (!S.peaks && $('waveMsg').textContent === 'Loading…') $('waveMsg').textContent = ''; });
    audio.addEventListener('error', () => {
      if (audio.getAttribute('src')) $('waveMsg').textContent = 'Couldn’t load this audio. Check your connection and try again.';
    });
    audio.addEventListener('ended', () => {
      setIcon(false);
      if (S.auto && S.cur < S.view.length - 1) select(S.cur + 1, true);
    });

    const togglePlay = () => {
      if (!audio.getAttribute('src')) return;
      audio.paused ? audio.play().catch(() => toast('Couldn’t play this audio')) : audio.pause();
    };
    const skip = (s) => {
      if (audio.duration) audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + s));
      drawWave(); updateTime();
    };

    function toggleDone() {
      const it = cur();
      if (!it || status(it) === 'missing') return;
      const now = !done.has(it.key);
      now ? done.add(it.key) : done.delete(it.key);
      $('doneBtn').classList.toggle('on', now);
      const chk = $('list').querySelector(`.item[data-v="${S.cur}"] .check`);
      if (chk) chk.classList.toggle('done', now);
      updateDone();
      if (opts.onDone) opts.onDone(it.key, now);
    }

    $('playBtn').onclick = togglePlay;
    $('prevBtn').onclick = () => select(S.cur - 1, !audio.paused);
    $('nextBtn').onclick = () => select(S.cur + 1, !audio.paused);
    $('backBtn').onclick = () => skip(-5);
    $('fwdBtn').onclick = () => skip(5);
    $('speed').onchange = (e) => { audio.playbackRate = +e.target.value; };
    $('loopBtn').onclick = () => { S.loop = !S.loop; audio.loop = S.loop; $('loopBtn').classList.toggle('on', S.loop); };
    $('autoBtn').onclick = () => { S.auto = !S.auto; store.set('auto', S.auto); $('autoBtn').classList.toggle('on', S.auto); };
    $('autoBtn').classList.toggle('on', S.auto);
    $('doneBtn').onclick = toggleDone;
    $('copyBtn').onclick = () => {
      const it = cur();
      if (!it) return;
      navigator.clipboard.writeText(textOf(it)).then(() => toast('Text copied'), () => toast('Copy failed'));
    };

    /* ---------- editing (admin only) ---------- */
    function setEditMode(on) {
      S.editing = on;
      $('text').classList.toggle('hidden', on);
      $('editor').classList.toggle('hidden', !on);
      document.querySelector('.edit-off').classList.toggle('hidden', on);
      document.querySelector('.edit-on').classList.toggle('hidden', !on);
    }
    function startEdit() {
      const it = cur();
      if (!editable || !it) return;
      $('editor').value = textOf(it);
      $('revertBtn').classList.toggle('hidden', !isEdited(it));
      setEditMode(true);
      $('editor').focus();
    }
    function commitText(it, val) {
      if (val === (it.text || '')) delete edits[it.key]; else edits[it.key] = val;
      if (opts.onEdit) opts.onEdit(it.key, isEdited(it) ? edits[it.key] : null);
    }
    function saveEdit() {
      const it = cur();
      if (!S.editing || !it) return;
      const was = isEdited(it);
      commitText(it, $('editor').value);
      setEditMode(false);
      if (isEdited(it) || was) toast(isEdited(it) ? 'Saved · marked as Edited' : 'Matches the original · marked as Retained');
    }
    function refreshCurrent() {
      const keep = cur();
      render();
      S.editing = false;
      reselect(keep);
    }
    if (editable) {
      $('editBtn').onclick = startEdit;
      $('saveBtn').onclick = () => { saveEdit(); refreshCurrent(); };
      $('cancelBtn').onclick = () => setEditMode(false);
      $('revertBtn').onclick = () => {
        const it = cur();
        if (!it) return;
        commitText(it, it.text || '');
        setEditMode(false);
        refreshCurrent();
        toast('Restored the original text');
      };
      $('editor').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('saveBtn').click(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditMode(false); }
      });
      window.addEventListener('beforeunload', () => { if (S.editing) saveEdit(); });
    }

    /* ---------- chrome ---------- */
    const header = document.querySelector('.app-header');
    const fitHeader = () => document.documentElement.style.setProperty('--hdr-h', (header ? header.offsetHeight : 0) + 'px');
    fitHeader();
    if (header) new ResizeObserver(fitHeader).observe(header);

    const setFs = (v) => {
      S.fs = Math.max(14, Math.min(56, v));
      document.documentElement.style.setProperty('--fs', S.fs + 'px');
      store.set('fs', S.fs);
    };
    setFs(S.fs);
    $('fontUp').onclick = () => setFs(S.fs + 2);
    $('fontDown').onclick = () => setFs(S.fs - 2);
    $('search').addEventListener('input', (e) => { S.query = e.target.value; render(); select(0, false); });
    $('menuBtn').onclick = () => document.body.classList.toggle('side-open');

    document.addEventListener('keydown', (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      // A focused button or link handles its own Space/Enter
      if ((tag === 'BUTTON' || tag === 'A') && (e.key === ' ' || e.key === 'Enter')) return;
      if (!S.items.length) return;
      const k = e.key;
      if (k === ' ') { e.preventDefault(); togglePlay(); }
      else if (k === 'ArrowRight' || k === 'ArrowDown') { e.preventDefault(); select(S.cur + 1, !audio.paused); }
      else if (k === 'ArrowLeft' || k === 'ArrowUp') { e.preventDefault(); select(S.cur - 1, !audio.paused); }
      else if (k === 'j' || k === 'J') skip(-5);
      else if (k === 'l' || k === 'L') skip(5);
      else if (k === 'm' || k === 'M') toggleDone();
      else if ((k === 'e' || k === 'E') && editable) { e.preventDefault(); startEdit(); }
      else if (k === '/') { e.preventDefault(); $('search').focus(); }
    });

    /* ---------- public api ---------- */
    function setItems(items, keepKey) {
      S.items = items;
      S.filters = {};
      S.query = '';
      $('search').value = '';
      if (editable) setEditMode(false);
      buildFilters();
      render();
      const idx = keepKey ? S.view.findIndex((ii) => S.items[ii].key === keepKey) : -1;
      select(idx >= 0 ? idx : 0, false);
    }

    return {
      setItems,
      select,
      current: cur,
      state: S,
      isDone: (k) => done.has(k),
      isEdited,
      textOf,
      refresh: () => { const keep = cur(); render(); reselect(keep); },
      setStatusFilter: (v) => {
        S.filters.__status = v;
        const sel = $('filters').querySelector('[data-f="__status"]');
        if (sel) sel.value = v;
        const keep = cur();
        render();
        reselect(keep);
      },
      flushEdit: () => { if (S.editing) { saveEdit(); refreshCurrent(); } },
    };
  }

  window.AudioViewer = { create, toast, esc, store };
})();
