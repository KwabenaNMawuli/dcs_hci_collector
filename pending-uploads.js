// ---------------------------------------------------------------------------
// Durable holding area for recordings that have not reached Google Drive yet.
// Heroku's disk is wiped on every restart/deploy, so audio is written to
// Postgres first and only removed once Drive confirms the upload.
// ---------------------------------------------------------------------------
const userManager = require('./users-manager');

let tableReady = false;

function pool() {
  return userManager.getPgPool();
}

function isEnabled() {
  return Boolean(pool());
}

async function init() {
  const p = pool();
  if (!p || tableReady) return;
  await p.query(`
    CREATE TABLE IF NOT EXISTS pending_uploads (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) NOT NULL,
      filename VARCHAR(255) NOT NULL,
      practice BOOLEAN NOT NULL DEFAULT FALSE,
      replace_existing BOOLEAN NOT NULL DEFAULT FALSE,
      question_id VARCHAR(50),
      target_type VARCHAR(20),
      lang VARCHAR(10),
      mime VARCHAR(100) NOT NULL,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
  `);
  tableReady = true;
}

async function enqueue(item) {
  const p = pool();
  if (!p) return null;
  await init();
  const { rows } = await p.query(
    `INSERT INTO pending_uploads
       (username, filename, practice, replace_existing, question_id, target_type, lang, mime, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      item.username, item.filename, Boolean(item.practice), Boolean(item.replace),
      item.questionId || null, item.targetType || null, item.lang || null,
      item.mime, item.buffer,
    ]
  );
  return rows[0].id;
}

async function remove(id) {
  const p = pool();
  if (!p || !id) return;
  await p.query('DELETE FROM pending_uploads WHERE id = $1', [id]);
}

async function markFailed(id, message) {
  const p = pool();
  if (!p || !id) return;
  await p.query(
    'UPDATE pending_uploads SET attempts = attempts + 1, last_error = $2 WHERE id = $1',
    [id, String(message || '').slice(0, 500)]
  );
}

// Oldest first. Includes the audio bytes, so only call when about to upload.
async function listAll() {
  const p = pool();
  if (!p) return [];
  await init();
  const { rows } = await p.query(
    `SELECT id, username, filename, practice, replace_existing AS replace,
            question_id AS "questionId", target_type AS "targetType", lang, mime, data AS buffer
     FROM pending_uploads ORDER BY id`
  );
  return rows;
}

// Filenames still waiting for Drive, for one contributor (no audio bytes)
async function listForUser(username) {
  const p = pool();
  if (!p) return [];
  await init();
  const { rows } = await p.query(
    `SELECT id, filename, practice FROM pending_uploads WHERE LOWER(username) = LOWER($1) ORDER BY id`,
    [username]
  );
  return rows;
}

async function summary() {
  const p = pool();
  if (!p) return { enabled: false, count: 0, bytes: 0, oldest: null, lastError: null };
  await init();
  const { rows } = await p.query(
    `SELECT COUNT(*)::int AS count,
            COALESCE(SUM(octet_length(data)), 0)::bigint AS bytes,
            MIN(created_at) AS oldest,
            (SELECT last_error FROM pending_uploads WHERE last_error IS NOT NULL ORDER BY id DESC LIMIT 1) AS "lastError"
     FROM pending_uploads`
  );
  const r = rows[0];
  return { enabled: true, count: r.count, bytes: Number(r.bytes), oldest: r.oldest, lastError: r.lastError };
}

module.exports = { isEnabled, init, enqueue, remove, markFailed, listAll, listForUser, summary };
