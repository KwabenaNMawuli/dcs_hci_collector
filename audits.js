// ---------------------------------------------------------------------------
// Contributor audit state: which recordings they have listened to and whether
// they have signed off. Postgres when DATABASE_URL is set (survives Heroku
// deploys), otherwise a local JSON file for development.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const userManager = require('./users-manager');

const FILE = path.join(__dirname, 'audits.json');
let tableReady = false;

function pool() {
  return userManager.getPgPool();
}

async function init() {
  const p = pool();
  if (!p || tableReady) return;
  await p.query(`
    CREATE TABLE IF NOT EXISTS contributor_audits (
      username VARCHAR(100) PRIMARY KEY,
      reviewed JSONB NOT NULL DEFAULT '[]',
      signed_off_at TIMESTAMPTZ,
      summary JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await p.query(`ALTER TABLE contributor_audits ADD COLUMN IF NOT EXISTS admin_reviewed JSONB NOT NULL DEFAULT '[]'`);
  tableReady = true;
}

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeFile(all) {
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2), 'utf8');
}

const key = (username) => String(username || '').toLowerCase();

async function get(username) {
  const empty = { reviewed: [], adminReviewed: [], signedOffAt: null, summary: null };
  const p = pool();
  if (!p) {
    const rec = readFile()[key(username)];
    return rec ? { ...empty, ...rec } : empty;
  }
  await init();
  const { rows } = await p.query(
    `SELECT reviewed, admin_reviewed AS "adminReviewed", signed_off_at AS "signedOffAt", summary FROM contributor_audits WHERE username = $1`,
    [key(username)]
  );
  return rows[0] || empty;
}

async function save(username, patch) {
  const current = await get(username);
  const next = { ...current, ...patch };
  const p = pool();
  if (!p) {
    const all = readFile();
    all[key(username)] = next;
    writeFile(all);
    return next;
  }
  await init();
  await p.query(
    `INSERT INTO contributor_audits (username, reviewed, admin_reviewed, signed_off_at, summary, updated_at)
     VALUES ($1, $2::jsonb, $5::jsonb, $3, $4::jsonb, NOW())
     ON CONFLICT (username) DO UPDATE
       SET reviewed = EXCLUDED.reviewed, admin_reviewed = EXCLUDED.admin_reviewed,
           signed_off_at = EXCLUDED.signed_off_at, summary = EXCLUDED.summary, updated_at = NOW()`,
    [key(username), JSON.stringify(next.reviewed || []), next.signedOffAt || null,
      next.summary ? JSON.stringify(next.summary) : null, JSON.stringify(next.adminReviewed || [])]
  );
  return next;
}

async function setReviewed(username, itemKey, isReviewed) {
  const cur = await get(username);
  const set = new Set(cur.reviewed || []);
  if (isReviewed) set.add(itemKey); else set.delete(itemKey);
  return save(username, { reviewed: [...set] });
}

// Admin approval of a specific recording; shown to the contributor on their audit page
async function setAdminReviewed(username, itemKey, isReviewed) {
  const cur = await get(username);
  const set = new Set(cur.adminReviewed || []);
  if (isReviewed) set.add(itemKey); else set.delete(itemKey);
  return save(username, { adminReviewed: [...set] });
}

async function listAdminReviewed() {
  const out = {};
  const p = pool();
  if (!p) {
    const all = readFile();
    Object.keys(all).forEach((u) => { out[u] = all[u].adminReviewed || []; });
    return out;
  }
  await init();
  const { rows } = await p.query(`SELECT username, admin_reviewed FROM contributor_audits`);
  rows.forEach((r) => { out[r.username] = r.admin_reviewed || []; });
  return out;
}

async function signOff(username, summary) {
  return save(username, { signedOffAt: new Date().toISOString(), summary });
}

async function reopen(username) {
  return save(username, { signedOffAt: null });
}

async function listAll() {
  const p = pool();
  if (!p) return readFile();
  await init();
  const { rows } = await p.query(
    `SELECT username, jsonb_array_length(reviewed) AS "reviewedCount", signed_off_at AS "signedOffAt", summary
     FROM contributor_audits`
  );
  const out = {};
  rows.forEach((r) => { out[r.username] = r; });
  return out;
}

module.exports = { init, get, setReviewed, setAdminReviewed, listAdminReviewed, signOff, reopen, listAll };
