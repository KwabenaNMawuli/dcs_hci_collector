/**
 * users-manager.js
 * Persistent user management and authentication for contributors.
 * Stores contributors in data/users.json with secure PIN hashing.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

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

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

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
    if (modified) {
      saveUsers(parsed);
    }
    return parsed;
  } catch (err) {
    console.warn('Could not read users.json, initializing empty list:', err.message);
    return [];
  }
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error saving users.json:', err.message);
    return false;
  }
}

/**
 * Register a new contributor.
 * @param {string} rawUsername
 * @param {string} displayName
 * @param {string} pin
 */
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

  return {
    username: newUser.username,
    displayName: newUser.displayName,
    createdAt: newUser.createdAt,
    practiceCompleted: false,
    practiceApproved: false,
  };
}

/**
 * Authenticate contributor credentials.
 * @param {string} rawUsername
 * @param {string} pin
 */
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

  return {
    username: user.username,
    displayName: user.displayName,
    lastActive: user.lastActive,
    practiceCompleted: Boolean(user.practiceCompleted),
    practiceApproved: Boolean(user.practiceApproved),
  };
}

/**
 * Get public list of contributors (without salts/hashes).
 */
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

/**
 * Look up a contributor by username.
 */
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

/**
 * Reset a user's PIN (Admin helper).
 */
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
  return true;
}

/**
 * Rename a user in the registry.
 */
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

  user.username = newUser;
  user.displayName = newUser;
  saveUsers(users);
  return true;
}

/**
 * Return raw users including PIN hashes for secure cloud sync/backup.
 */
function getRawUsers() {
  return loadUsers();
}

/**
 * Merge cloud-synced users into local registry without losing updates.
 * @param {Array} cloudUsers
 */
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
      } else {
        const existing = map.get(key);
        const cloudTime = new Date(u.lastActive || u.createdAt || 0).getTime();
        const localTime = new Date(existing.lastActive || existing.createdAt || 0).getTime();
        if (cloudTime > localTime) {
          map.set(key, { ...existing, ...u });
        }
      }
    }
  });

  const merged = Array.from(map.values());
  saveUsers(merged);
  return merged;
}

/**
 * Mark practice as completed for a contributor.
 * @param {string} rawUsername
 */
function setPracticeCompleted(rawUsername) {
  const username = sanitizeUsername(rawUsername);
  if (!username) return false;
  const users = loadUsers();
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return false;
  user.practiceCompleted = true;
  user.lastActive = new Date().toISOString();
  saveUsers(users);
  return true;
}

/**
 * Set approval / greenlight status for a contributor (Admin action).
 * @param {string} rawUsername
 * @param {boolean} approved
 * @param {string} approvedBy
 */
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
};
