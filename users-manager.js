/**
 * users-manager.js
 * Persistent user management and authentication for contributors.
 * Supports Heroku PostgreSQL for bulletproof persistence across dyno restarts and deployments,
 * with seamless local JSON file fallback for offline/local development.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory cache for fast, zero-latency synchronous access
let usersCache = null;
let pgPool = null;

function sanitizeUsername(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
}

function hashPin(pin, salt) {
  return crypto.createHash('sha256').update(`${salt}:${String(pin).trim()}`).digest('hex');
}

// ---------------------------------------------------------------------------
// PostgreSQL Connection & Schema Setup
// ---------------------------------------------------------------------------
function getPgPool() {
  if (pgPool) return pgPool;
  const dbUrl = (process.env.DATABASE_URL || '').trim();
  if (!dbUrl) return null;

  try {
    const isLocal = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');
    pgPool = new Pool({
      connectionString: dbUrl.replace(/^postgres:\/\//, 'postgresql://'),
      ssl: isLocal ? false : { rejectUnauthorized: false },
    });

    pgPool.on('error', (err) => {
      console.warn('PostgreSQL pool idle error (will reconnect):', err.message);
    });

    return pgPool;
  } catch (err) {
    console.warn('Could not initialize PostgreSQL pool:', err.message);
    return null;
  }
}

async function initDatabase() {
  const pool = getPgPool();
  if (!pool) {
    console.log('ℹ️  PostgreSQL not configured (DATABASE_URL not set). Using file-based registry.');
    loadUsers();
    return;
  }

  try {
    // 1. Create tables if not exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contributors (
        username VARCHAR(100) PRIMARY KEY,
        display_name VARCHAR(150) NOT NULL,
        salt VARCHAR(64) NOT NULL,
        pin_hash VARCHAR(128) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_active TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        practice_completed BOOLEAN NOT NULL DEFAULT FALSE,
        practice_approved BOOLEAN NOT NULL DEFAULT FALSE,
        practice_approved_at TIMESTAMPTZ,
        practice_approved_by VARCHAR(100)
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('🐘 PostgreSQL connected. contributors & app_settings tables verified.');

    // 2. Load all contributors from PostgreSQL into cache and mirror to disk
    const { rows } = await pool.query(`
      SELECT 
        username,
        display_name as "displayName",
        salt,
        pin_hash as "pinHash",
        created_at as "createdAt",
        last_active as "lastActive",
        practice_completed as "practiceCompleted",
        practice_approved as "practiceApproved",
        practice_approved_at as "practiceApprovedAt",
        practice_approved_by as "practiceApprovedBy"
      FROM contributors
      ORDER BY created_at ASC
    `);

    if (rows && rows.length > 0) {
      usersCache = rows.map((r) => ({
        username: r.username,
        displayName: r.displayName || r.username,
        salt: r.salt,
        pinHash: r.pinHash,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
        lastActive: r.lastActive ? new Date(r.lastActive).toISOString() : new Date().toISOString(),
        practiceCompleted: Boolean(r.practiceCompleted),
        practiceApproved: Boolean(r.practiceApproved),
        practiceApprovedAt: r.practiceApprovedAt ? new Date(r.practiceApprovedAt).toISOString() : null,
        practiceApprovedBy: r.practiceApprovedBy || null,
      }));
      saveUsers(usersCache);
      console.log(`🐘 Loaded ${usersCache.length} contributor account(s) permanently from PostgreSQL.`);
    } else {
      // Postgres table is empty; check if we have local users to migrate into Postgres
      const localUsers = loadUsers();
      if (localUsers.length > 0) {
        console.log(`🐘 Migrating ${localUsers.length} local user(s) into PostgreSQL...`);
        for (const u of localUsers) {
          if (!u || !u.username) continue;
          await saveUserToDb(u);
        }
        console.log('🐘 Local users successfully migrated to PostgreSQL.');
      }
    }
  } catch (err) {
    console.error('⚠️  PostgreSQL initialization warning:', err.message);
    loadUsers();
  }
}

async function saveUserToDb(u) {
  const pool = getPgPool();
  if (!pool || !u || !u.username) return;
  try {
    await pool.query(`
      INSERT INTO contributors (
        username, display_name, salt, pin_hash, created_at, last_active,
        practice_completed, practice_approved, practice_approved_at, practice_approved_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (username) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        salt = EXCLUDED.salt,
        pin_hash = EXCLUDED.pin_hash,
        last_active = EXCLUDED.last_active,
        practice_completed = EXCLUDED.practice_completed,
        practice_approved = EXCLUDED.practice_approved,
        practice_approved_at = EXCLUDED.practice_approved_at,
        practice_approved_by = EXCLUDED.practice_approved_by
    `, [
      u.username,
      u.displayName || u.username,
      u.salt,
      u.pinHash,
      u.createdAt || new Date().toISOString(),
      u.lastActive || new Date().toISOString(),
      Boolean(u.practiceCompleted),
      Boolean(u.practiceApproved),
      u.practiceApprovedAt || null,
      u.practiceApprovedBy || null,
    ]);
  } catch (err) {
    console.error(`Error saving user ${u.username} to PostgreSQL:`, err.message);
  }
}

async function deleteUserFromDb(username) {
  const pool = getPgPool();
  if (!pool || !username) return;
  try {
    await pool.query(`DELETE FROM contributors WHERE LOWER(username) = LOWER($1)`, [username]);
  } catch (err) {
    console.error(`Error deleting user ${username} from PostgreSQL:`, err.message);
  }
}

async function getDbSetting(key) {
  const pool = getPgPool();
  if (!pool || !key) return null;
  try {
    const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
    return rows && rows.length > 0 ? rows[0].value : null;
  } catch (err) {
    return null;
  }
}

async function setDbSetting(key, value) {
  const pool = getPgPool();
  if (!pool || !key) return;
  try {
    await pool.query(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [key, String(value)]);
  } catch (err) {
    console.error(`Error saving setting ${key} to PostgreSQL:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Local Mirror & Memory Cache Helpers
// ---------------------------------------------------------------------------
function loadUsers() {
  if (usersCache !== null) {
    return usersCache;
  }
  if (!fs.existsSync(USERS_FILE)) {
    usersCache = [];
    return usersCache;
  }
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      usersCache = [];
      return usersCache;
    }

    // Grandfather existing accounts if practice approval was not tracked
    let modified = false;
    for (const u of parsed) {
      if (u && typeof u.practiceApproved === 'undefined') {
        u.practiceCompleted = true;
        u.practiceApproved = true;
        u.practiceApprovedAt = u.createdAt || new Date().toISOString();
        u.practiceApprovedBy = 'system_grandfathered';
        modified = true;
      }
    }
    usersCache = parsed;
    if (modified) {
      saveUsers(usersCache);
    }
    return usersCache;
  } catch (err) {
    console.warn('Could not read users.json, initializing empty list:', err.message);
    usersCache = [];
    return usersCache;
  }
}

function saveUsers(users) {
  usersCache = users;
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving users.json:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Contributor Authentication & Registration APIs
// ---------------------------------------------------------------------------
function registerUser(rawUsername, displayName, pin) {
  const username = sanitizeUsername(rawUsername);
  if (!username || username.length < 2) {
    throw new Error('Username must be at least 2 alphanumeric characters.');
  }
  if (!pin || String(pin).trim().length < 4) {
    throw new Error('PIN / Passcode must be at least 4 digits or characters.');
  }

  const users = loadUsers();
  const existing = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (existing) {
    throw new Error(`Username "${username}" is already taken. Please choose another name or sign in.`);
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const pinHash = hashPin(pin, salt);
  const now = new Date().toISOString();

  const newUser = {
    username,
    displayName: (displayName && displayName.trim()) || username,
    salt,
    pinHash,
    createdAt: now,
    lastActive: now,
    practiceCompleted: false,
    practiceApproved: false,
    practiceApprovedAt: null,
    practiceApprovedBy: null,
  };

  users.push(newUser);
  saveUsers(users);
  saveUserToDb(newUser).catch(() => {});

  return {
    username: newUser.username,
    displayName: newUser.displayName,
    createdAt: newUser.createdAt,
    practiceCompleted: false,
    practiceApproved: false,
  };
}

function verifyUser(rawUsername, pin) {
  const username = sanitizeUsername(rawUsername);
  if (!username) {
    throw new Error('Please enter your username.');
  }
  if (!pin) {
    throw new Error('Please enter your PIN / passcode.');
  }

  const users = loadUsers();
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user) {
    throw new Error(`Contributor "${username}" not found. Please register as a new contributor.`);
  }

  const computedHash = hashPin(pin, user.salt);
  if (computedHash !== user.pinHash) {
    throw new Error('Incorrect PIN / passcode.');
  }

  user.lastActive = new Date().toISOString();
  saveUsers(users);
  saveUserToDb(user).catch(() => {});

  return {
    username: user.username,
    displayName: user.displayName,
    lastActive: user.lastActive,
    practiceCompleted: Boolean(user.practiceCompleted),
    practiceApproved: Boolean(user.practiceApproved),
  };
}

function listUsers() {
  const users = loadUsers();
  return users.map((u) => ({
    username: u.username,
    displayName: u.displayName,
    createdAt: u.createdAt,
    lastActive: u.lastActive,
    practiceCompleted: Boolean(u.practiceCompleted),
    practiceApproved: Boolean(u.practiceApproved),
    practiceApprovedAt: u.practiceApprovedAt || null,
  }));
}

function getUser(rawUsername) {
  const username = sanitizeUsername(rawUsername);
  if (!username) return null;
  const users = loadUsers();
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return null;
  return {
    username: user.username,
    displayName: user.displayName,
    createdAt: user.createdAt,
    lastActive: user.lastActive,
    practiceCompleted: Boolean(user.practiceCompleted),
    practiceApproved: Boolean(user.practiceApproved),
    practiceApprovedAt: user.practiceApprovedAt || null,
  };
}

function resetUserPin(rawUsername, newPin) {
  const username = sanitizeUsername(rawUsername);
  if (!newPin || String(newPin).trim().length < 4) {
    throw new Error('New PIN must be at least 4 characters.');
  }
  const users = loadUsers();
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user) {
    throw new Error(`User "${username}" not found.`);
  }

  const salt = crypto.randomBytes(16).toString('hex');
  user.salt = salt;
  user.pinHash = hashPin(newPin, salt);
  saveUsers(users);
  saveUserToDb(user).catch(() => {});
  return true;
}

function renameUserInRegistry(oldRaw, newRaw) {
  const oldUser = sanitizeUsername(oldRaw);
  const newUser = sanitizeUsername(newRaw);
  if (!oldUser || !newUser) {
    throw new Error('Invalid usernames for rename.');
  }

  const users = loadUsers();
  const user = users.find((u) => u.username.toLowerCase() === oldUser.toLowerCase());
  if (!user) {
    throw new Error(`User "${oldUser}" not found in registry.`);
  }

  const conflict = users.find((u) => u.username.toLowerCase() === newUser.toLowerCase() && u !== user);
  if (conflict) {
    throw new Error(`User "${newUser}" already exists.`);
  }

  deleteUserFromDb(oldUser).catch(() => {});

  user.username = newUser;
  user.displayName = newUser;
  saveUsers(users);
  saveUserToDb(user).catch(() => {});
  return true;
}

function getRawUsers() {
  return loadUsers();
}

function mergeUsers(cloudUsers) {
  if (!Array.isArray(cloudUsers)) return loadUsers();
  const local = loadUsers();
  const map = new Map();
  local.forEach((u) => {
    if (u && u.username) map.set(u.username.toLowerCase(), u);
  });

  cloudUsers.forEach((u) => {
    if (u && u.username) {
      const key = u.username.toLowerCase();
      if (!map.has(key)) {
        map.set(key, u);
        saveUserToDb(u).catch(() => {});
      } else {
        const existing = map.get(key);
        const cloudTime = new Date(u.lastActive || u.createdAt || 0).getTime();
        const localTime = new Date(existing.lastActive || existing.createdAt || 0).getTime();
        if (cloudTime > localTime) {
          const mergedItem = { ...existing, ...u };
          map.set(key, mergedItem);
          saveUserToDb(mergedItem).catch(() => {});
        }
      }
    }
  });

  const merged = Array.from(map.values());
  saveUsers(merged);
  return merged;
}

function setPracticeCompleted(rawUsername) {
  const username = sanitizeUsername(rawUsername);
  if (!username) return false;
  const users = loadUsers();
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return false;
  user.practiceCompleted = true;
  user.lastActive = new Date().toISOString();
  saveUsers(users);
  saveUserToDb(user).catch(() => {});
  return true;
}

function setPracticeApproval(rawUsername, approved, approvedBy = 'admin') {
  const username = sanitizeUsername(rawUsername);
  if (!username) return false;
  const users = loadUsers();
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return false;
  user.practiceApproved = Boolean(approved);
  if (user.practiceApproved) {
    user.practiceCompleted = true;
    user.practiceApprovedAt = new Date().toISOString();
    user.practiceApprovedBy = approvedBy;
  } else {
    user.practiceApprovedAt = null;
    user.practiceApprovedBy = null;
  }
  user.lastActive = new Date().toISOString();
  saveUsers(users);
  saveUserToDb(user).catch(() => {});
  return true;
}

module.exports = {
  sanitizeUsername,
  registerUser,
  verifyUser,
  listUsers,
  getUser,
  resetUserPin,
  renameUserInRegistry,
  getRawUsers,
  mergeUsers,
  setPracticeCompleted,
  setPracticeApproval,
  initDatabase,
  getDbSetting,
  setDbSetting,
  getPgPool,
};
