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
    return JSON.parse(raw);
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
  };

  users.push(newUser);
  saveUsers(users);

  return {
    username: newUser.username,
    displayName: newUser.displayName,
    createdAt: newUser.createdAt,
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

module.exports = {
  sanitizeUsername,
  registerUser,
  verifyUser,
  listUsers,
  getUser,
  resetUserPin,
  renameUserInRegistry,
};
