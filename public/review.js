/**
 * review.js — admin review of recordings.
 * Two ways in: load everything from the server (contributor names included, audio streams
 * straight from Drive), or drop in a CSV export plus optional local audio files.
 * Admins can correct transcripts, tick items reviewed and export an Excel sheet.
 */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const AV = window.AudioViewer;
  const AUDIO_EXT = /\.(wav|mp3|m4a|ogg|oga|opus|flac|aac|webm)$/i;
  const DRIVE_PAGE = /^https?:\/\/(drive|docs)\.google\.com\//i;

  const done = new Set();
  const edits = {};
  let source = '';           // 'server' or the CSV file name; scopes saved review marks and edits
  let sourceKind = '';       // 'server' | 'csv'
  let csv = null;            // { headers, rows, map, groupCols }
  let items = [];
  const localAudio = new Map(); // lower-cased file name -> [{ file, url, dir }]

  const viewer = AV.create({
    done,
    edits,
    editable: true,
    doneLabel: 'Reviewed',
    waveformRemote: true,
    resolveAudio,
    onDone: () => AV.store.set('done:' + source, [...done]),
    onEdit: () => AV.store.set('edits:' + source, edits),
    onSelect: (it) => AV.store.set('last:' + source, it.key),
  });

  /* ---------- admin gate ---------- */
  const adminToken = () => sessionStorage.getItem('dcs_admin_token') || localStorage.getItem('dcs_admin_token') || '';
  const adminHeaders = () => ({ 'x-admin-token': adminToken() });
  const toLogin = () => window.location.replace('/login');

  async function checkAdmin() {
    if (!adminToken()) return toLogin();
    try {
      const res = await fetch('/api/admin/verify', { headers: adminHeaders() });
      const body = await res.json();
      if (!body.authenticated) return toLogin();
      $('gateHint').textContent = 'Signed in as admin.';
    } catch (_) {
      $('gateHint').textContent = 'Could not verify admin access. Check your connection.';
    }
  }

  /* ---------- CSV parsing and column detection ---------- */
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const nl = text.indexOf('\n');
    const first = text.slice(0, nl > 0 ? nl : text.length);
    const delim = [',', '\t', ';', '|'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = ''; rows.push(row); row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((v) => v.trim() !== ''));
  }

  function detectColumns(headers, rows) {
    const n = headers.length, sample = rows.slice(0, 200);
    const vals = (i) => sample.map((r) => (r[i] || '').trim());
    const looksAudio = (v) => /^(https?:|blob:|data:audio)/i.test(v) || AUDIO_EXT.test(v.split('?')[0]);
    const audioScore = (i) => vals(i).filter(looksAudio).length + (/^https?:/i.test(vals(i)[0] || '') ? 5 : 0);
    const avgLen = (i) => vals(i).reduce((a, v) => a + v.length, 0) / Math.max(1, sample.length);
    const h = headers.map((x) => x.toLowerCase());

    let text = h.findIndex((x) => /transcri|text|sentence|caption|utterance|content|prompt text/.test(x));
    let audioCol = -1, best = 0;
    for (let i = 0; i < n; i++) {
      const s = audioScore(i) + (/(audio|url|path|link)/.test(h[i]) ? 3 : 0);
      if (s > best) { best = s; audioCol = i; }
    }
    if (text < 0 || text === audioCol) {
      let bl = -1;
      for (let i = 0; i < n; i++) if (i !== audioCol && avgLen(i) > bl) { bl = avgLen(i); text = i; }
    }
    let name = -1;
    for (let i = 0; i < n; i++) {
      if (i !== audioCol && i !== text && /(name|file|id)/.test(h[i]) && vals(i).some((v) => AUDIO_EXT.test(v))) { name = i; break; }
    }
    if (name < 0) name = h.findIndex((x, i) => i !== audioCol && i !== text && /(name|file|title|id)/.test(x));
    const user = h.findIndex((x, i) => i !== audioCol && i !== text && i !== name && /^(user|username|contributor)$/.test(x.trim()));

    const groupCols = [];
    for (let i = 0; i < n; i++) {
      if (i === text || i === audioCol || i === name || i === user) continue;
      const distinct = new Set(rows.map((r) => (r[i] || '').trim())).size;
      if (distinct > 1 && distinct <= 200 && distinct < rows.length * 0.8) groupCols.push(i);
    }
    return { map: { text, audio: audioCol, name, user }, groupCols };
  }

  /* ---------- local audio ---------- */
  const baseName = (s) => decodeURIComponent((s || '').split('?')[0].split(/[\\/]/).pop() || '');
  const normDir = (d) => (d || '').toLowerCase().replace(/^user_/, '');

  function addLocalAudio(file) {
    const key = file.name.toLowerCase();
    const dir = file._dir || ((file.webkitRelativePath || '').split('/').slice(-2, -1)[0] || '');
    const list = localAudio.get(key) || [];
    const url = URL.createObjectURL(file);
    list.push({ file, url, dir });
    localAudio.set(key, list);
  }

  // Picks the right local file when several contributors have the same file name.
  // Returns null instead of guessing, so the wrong person's audio is never played.
  function findLocal(it) {
    const m = it.meta || {};
    const cands = localAudio.get((m.name || '').toLowerCase()) || localAudio.get((m.rawBase || '').toLowerCase()) || [];
    const usable = cands.filter((c) => !(m.user && c.dir && normDir(c.dir) !== m.user.toLowerCase()));
    return usable.length === 1 ? usable[0] : null;
  }

  function resolveAudio(it) {
    const local = findLocal(it);
    if (local) return { url: local.url, file: local.file, local: true };
    if (it.audio && DRIVE_PAGE.test(it.audio.url)) return null; // a Drive preview page, not an audio stream
    return it.audio || null;
  }

  async function collectFromDataTransfer(dt) {
    const out = [];
    const entries = [...(dt.items || [])].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return [...dt.files];
    const walk = async (entry, parent) => {
      if (entry.isFile) {
        const f = await new Promise((res) => entry.file(res, () => res(null)));
        if (f) { f._dir = parent; out.push(f); }
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res) => reader.readEntries(res, () => res([])));
          for (const e of batch) await walk(e, entry.name);
        } while (batch.length);
      }
    };
    for (const e of entries) await walk(e, '');
    return out;
  }

  async function ingest(files) {
    const tables = files.filter((f) => /\.(csv|tsv|txt)$/i.test(f.name));
    const audios = files.filter((f) => AUDIO_EXT.test(f.name) || (f.type || '').startsWith('audio/'));
    audios.forEach(addLocalAudio);

    if (tables.length) {
      const f = tables[0];
      const parsed = parseCSV(await f.text());
      if (parsed.length < 2) return AV.toast('That file has no data rows');
      loadCsv(f.name, parsed[0].map((x) => x.trim()), parsed.slice(1));
      if (tables.length > 1) AV.toast(`Loaded ${f.name} (one table at a time)`);
    } else if (audios.length) {
      if (!items.length) {
        loadCsv('Audio files', ['audio file name', 'audio file', 'transcript'], audios.map((f) => [f.name, f.name, '']));
      } else if (sourceKind === 'csv') {
        rebuildFromCsv();
      } else {
        viewer.refresh();
      }
      AV.toast(`${audios.length} local audio file${audios.length > 1 ? 's' : ''} added`);
    } else {
      AV.toast('Drop a CSV or audio files');
    }
  }

  /* ---------- items from a CSV ---------- */
  const cell = (r, i) => (i >= 0 ? r[i] || '' : '').trim();

  function uniqueKeys(list) {
    const seen = new Map();
    list.forEach((it) => {
      const n = (seen.get(it.key) || 0) + 1;
      seen.set(it.key, n);
      if (n > 1) it.key = `${it.key}#${n}`;
    });
    return list;
  }

  function csvItems() {
    const { headers, rows, map, groupCols } = csv;
    const list = rows.map((r, i) => {
      const rawAudio = cell(r, map.audio);
      const name = cell(r, map.name) || baseName(rawAudio) || `Row ${i + 1}`;
      const user = cell(r, map.user);
      const filters = {};
      groupCols.forEach((c) => { if (cell(r, c)) filters['c' + c] = { label: headers[c] || `column ${c + 1}`, value: cell(r, c) }; });
      return {
        key: user ? `${user}/${name}` : name,
        name,
        num: i + 1,
        qnum: questionNumber(r, i),
        user,
        text: cell(r, map.text),
        chips: [...(user ? [{ label: 'Contributor', value: user }] : []),
          ...headers.map((h, c) => ({ h, c })).filter(({ c }) => c !== map.text && c !== map.audio && c !== map.name && c !== map.user)
            .map(({ h, c }) => ({ label: h, value: cell(r, c) }))],
        filters,
        audio: rawAudio ? { url: rawAudio } : null,
        meta: { name, user, rawBase: baseName(rawAudio) },
      };
    });
    return uniqueKeys(list);
  }

  function questionNumber(r, i) {
    const { headers, map } = csv;
    const used = [map.text, map.audio, map.name, map.user];
    const c = headers.map((x) => x.toLowerCase()).findIndex((x, k) => !used.includes(k) && /(question|prompt|q[\s_-]*(no|num|id)|number|\bid\b)/.test(x));
    return c >= 0 ? cell(r, c) : String(i + 1);
  }

  function loadCsv(name, headers, rows) {
    rows = rows.map((r) => { while (r.length < headers.length) r.push(''); return r; });
    const det = detectColumns(headers, rows);
    csv = { headers, rows, map: det.map, groupCols: det.groupCols };
    sourceKind = 'csv';
    useSource(name);
    $('fileChip').textContent = `${name} · ${rows.length} rows`;
    buildMapPanel();
    rebuildFromCsv();

    const names = rows.map((r) => (cell(r, det.map.name) || baseName(cell(r, det.map.audio))).toLowerCase()).filter(Boolean);
    const repeated = names.length - new Set(names).size;
    if (det.map.user < 0 && repeated > 0) {
      AV.toast(`${repeated} file names repeat and this CSV has no contributor column. Use “Load from server” to review per contributor.`);
    } else if (rows.some((r) => DRIVE_PAGE.test(cell(r, det.map.audio))) && !localAudio.size) {
      AV.toast('These audio links are Google Drive pages and can’t play here. Drop the audio files in, or use “Load from server”.');
    }
  }

  function rebuildFromCsv() {
    items = csvItems();
    showApp();
    viewer.setItems(items, restoreLast());
  }

  /* ---------- items from the server ---------- */
  async function loadFromServer() {
    AV.toast('Loading recordings from the server…');
    try {
      const [recRes, akanRes, eweRes, missRes] = await Promise.all([
        fetch('/api/admin/recordings', { headers: adminHeaders() }),
        fetch('/api/questions?lang=akan'),
        fetch('/api/questions?lang=ewe'),
        fetch('/api/admin/missing', { headers: adminHeaders() }),
      ]);
      if (recRes.status === 401) return toLogin();
      if (!recRes.ok) throw new Error('Could not load recordings');
      const { recordings } = await recRes.json();
      const qmaps = {};
      for (const [lang, r] of [['akan', akanRes], ['ewe', eweRes]]) {
        qmaps[lang] = new Map();
        if (r.ok) (await r.json()).questions.forEach((q) => qmaps[lang].set(q.id.toLowerCase(), q));
      }

      // Items a contributor has not recorded yet. If this call fails the recordings still load.
      let missing = [];
      if (missRes.ok) missing = (await missRes.json()).items || [];
      else AV.toast('Loaded the recordings, but couldn’t check for missing items.');

      const rows = [
        ...recordings.map((r) => ({ ...r, status: 'ok' })),
        ...missing.map((m) => ({ ...m, targetType: m.track, missingText: m.text })),
      ];

      const list = rows
        .sort((a, b) => a.user.localeCompare(b.user) || a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map((r, i) => {
          const q = (qmaps[r.lang] || new Map()).get((r.questionId || '').toLowerCase());
          const isOpts = r.targetType === 'options';
          const text = r.missingText != null ? r.missingText : (q ? (isOpts ? (q.options || []).join('\n') || q.text : q.text) : '');
          const track = isOpts ? 'Options' : 'Question';
          const lang = r.lang === 'ewe' ? 'Ewe' : 'Akan';
          return {
            key: `${r.user}/${r.name}`,
            name: r.name,
            num: i + 1,
            qnum: r.questionId,
            user: r.user,
            text: text || '',
            status: r.status,
            chips: [{ label: 'Contributor', value: r.user }, { label: 'Language', value: lang }, { label: 'Track', value: track }],
            filters: {
              user: { label: 'contributors', value: r.user },
              lang: { label: 'languages', value: lang },
              track: { label: 'tracks', value: track },
            },
            audio: r.status === 'ok' && r.streamUrl ? { url: r.streamUrl } : null,
            meta: { name: r.name, user: r.user, rawBase: r.name },
          };
        });

      csv = null;
      sourceKind = 'server';
      useSource('server');
      const nMissing = list.filter((i) => i.status === 'missing').length;
      const nPending = list.filter((i) => i.status === 'pending').length;
      $('fileChip').textContent = `Server · ${list.length - nMissing - nPending} recordings`
        + (nMissing ? ` · ${nMissing} missing` : '') + (nPending ? ` · ${nPending} uploading` : '');
      $('mapBtn').classList.add('hidden');
      items = uniqueKeys(list);
      showApp();
      viewer.setItems(items, restoreLast());
      if (!items.length) AV.toast('No recordings found on the server yet.');
    } catch (err) {
      AV.toast(err.message || 'Could not load from the server');
    }
  }

  /* ---------- shared bits ---------- */
  function useSource(name) {
    source = name;
    done.clear();
    AV.store.get('done:' + name, []).forEach((k) => done.add(k));
    Object.keys(edits).forEach((k) => delete edits[k]);
    Object.assign(edits, AV.store.get('edits:' + name, {}));
  }

  function restoreLast() { return AV.store.get('last:' + source, null); }

  function showApp() {
    $('landing').classList.add('hidden');
    $('app').classList.remove('hidden');
    ['openBtn', 'serverBtn', 'exportBtn'].forEach((id) => $(id).classList.remove('hidden'));
    $('mapBtn').classList.toggle('hidden', sourceKind !== 'csv');
  }

  function buildMapPanel() {
    const opts = (sel) => '<option value="-1">— none —</option>'
      + csv.headers.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${AV.esc(h || 'Column ' + (i + 1))}</option>`).join('');
    $('mapText').innerHTML = opts(csv.map.text);
    $('mapAudio').innerHTML = opts(csv.map.audio);
    $('mapName').innerHTML = opts(csv.map.name);
    $('mapUser').innerHTML = opts(csv.map.user);
  }
  [['Text', 'text'], ['Audio', 'audio'], ['Name', 'name'], ['User', 'user']].forEach(([id, k]) => {
    $('map' + id).addEventListener('change', (e) => {
      csv.map[k] = +e.target.value;
      const keep = viewer.current();
      items = csvItems();
      viewer.setItems(items, keep && keep.key);
    });
  });
  $('mapBtn').onclick = () => $('mapPanel').classList.toggle('hidden');
  document.addEventListener('click', (e) => { if (!e.target.closest('#mapPanel, #mapBtn')) $('mapPanel').classList.add('hidden'); });

  /* ---------- export ---------- */
  let xlsxLib;
  function loadXLSX() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    xlsxLib = xlsxLib || new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = () => res(window.XLSX);
      s.onerror = () => { xlsxLib = null; rej(new Error('xlsx failed to load')); };
      document.head.appendChild(s);
    });
    return xlsxLib;
  }

  async function exportExcel() {
    viewer.flushEdit();
    const hasUser = items.some((i) => i.user);
    const header = ['Question number', 'Audio file', 'Question', 'Status', 'Reviewed', ...(hasUser ? ['Contributor'] : [])];
    const data = items.map((it) => [
      it.qnum, it.name, viewer.textOf(it),
      it.status === 'missing' ? 'Missing' : it.status === 'pending' ? 'Waiting for Drive' : viewer.isEdited(it) ? 'Edited' : 'Retained',
      done.has(it.key) ? 'Yes' : 'No', ...(hasUser ? [it.user] : []),
    ]);
    const base = (source === 'server' ? 'recordings' : source.replace(/\.[^.]+$/, '')) + '_reviewed';
    const edited = data.filter((d) => d[3] === 'Edited').length;
    try {
      const XLSX = await loadXLSX();
      const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
      ws['!cols'] = [{ wch: 16 }, { wch: 30 }, { wch: 90 }, { wch: 12 }, { wch: 10 }, ...(hasUser ? [{ wch: 18 }] : [])];
      ws['!autofilter'] = { ref: `A1:${String.fromCharCode(64 + header.length)}${data.length + 1}` };
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Transcripts');
      XLSX.writeFile(wb, base + '.xlsx');
      AV.toast(`Exported ${data.length} rows · ${edited} edited`);
    } catch (_) {
      // Offline fallback: a CSV that Excel opens directly (the BOM keeps ɛ and ɔ intact)
      const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
      const csvText = '﻿' + [header, ...data].map((r) => r.map(q).join(',')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csvText], { type: 'text/csv;charset=utf-8' }));
      a.download = base + '.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      AV.toast(`Offline: exported as CSV (opens in Excel) · ${edited} edited`);
    }
  }
  $('exportBtn').onclick = exportExcel;

  /* ---------- drag & drop / browse ---------- */
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    ingest(await collectFromDataTransfer(e.dataTransfer));
  });
  $('browseBtn').onclick = $('openBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => { ingest([...e.target.files]); e.target.value = ''; };
  $('serverBtn').onclick = $('serverBtn2').onclick = loadFromServer;

  checkAdmin();
})();
