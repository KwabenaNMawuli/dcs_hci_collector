/**
 * server.js
 * DCS HCI Audio Collector — Express backend with Google OAuth 2.0
 * Supports Akan and Ewe languages, with separate audio tracks for Question Prompts and Question Options.
 */

'use strict';

const path = require('path');

// Repo root (src/ lives one level below it). Data, uploads, tokens and .env stay at the root.
const ROOT_DIR = path.join(__dirname, '..');

require('dotenv').config({ path: path.join(ROOT_DIR, '.env') });

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const { google } = require('googleapis');
const { parseQuestions } = require('./lib/questions-parser');
const userManager = require('./lib/users-manager');
const pendingUploads = require('./lib/pending-uploads');
const audits = require('./lib/audits');

const PORT = process.env.PORT || 3000;

// Docx questionnaire paths for Akan and Ewe
const DOCX_PATH_AKAN =
  process.env.DOCX_PATH_AKAN ||
  process.env.DOCX_PATH ||
  path.join(ROOT_DIR, 'data', 'questionnaire.docx');

const DOCX_PATH_EWE =
  process.env.DOCX_PATH_EWE ||
  (fs.existsSync(path.join(ROOT_DIR, 'data', 'questionnaire-ewe.docx'))
    ? path.join(ROOT_DIR, 'data', 'questionnaire-ewe.docx')
    : path.join(ROOT_DIR, 'GH-MoMo-questionnaire-Ewe-draft (1).docx'));

const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

// OAuth 2.0 Credentials
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth2callback`;

const TOKEN_PATH = path.join(ROOT_DIR, 'tokens.json');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Cookie parser middleware (zero external dependency)
// ---------------------------------------------------------------------------
function cookieParserMiddleware(req, res, next) {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach((c) => {
      const parts = c.trim().split('=');
      const key = parts[0];
      const val = parts.slice(1).join('=');
      if (key) {
        try {
          req.cookies[key.trim()] = decodeURIComponent(val);
        } catch (_) {
          req.cookies[key.trim()] = val;
        }
      }
    });
  }
  next();
}

const app = express();
app.use(express.json());
app.use(cookieParserMiddleware);
app.use(express.static(path.join(ROOT_DIR, 'public')));

// Serve admin dashboard at /admin and /admin.html
app.get(['/admin', '/admin.html'], (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'admin.html'));
});

// Serve admin login page at /login and /login.html
app.get(['/login', '/login.html'], (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'login.html'));
});

// Serve contributor sign-in page at /user-login and /user-login.html
app.get(['/user-login', '/user-login.html'], (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'user-login.html'));
});

// ---------------------------------------------------------------------------
// Contributor Authentication & Session Tracking
// ---------------------------------------------------------------------------
const activeContributorSessions = new Map(); // token -> username

function getAuthenticatedContributor(req) {
  const token = req.cookies['dcs_contributor_token'] || req.headers['x-contributor-token'];
  const userCookie = req.cookies['dcs_contributor_user'] || req.headers['x-contributor-user'];

  if (token && activeContributorSessions.has(token)) {
    return activeContributorSessions.get(token);
  }
  if (userCookie) {
    const verified = userManager.getUser(userCookie);
    if (verified) return verified.username;
  }
  return null;
}

// Protected Admin API to list contributors (prevents public scraping of user accounts)
app.get('/api/users/list', requireAdminAuth, (_req, res) => {
  res.json({ users: userManager.listUsers() });
});

app.post('/api/users/register', (req, res) => {
  try {
    const { username, displayName, pin } = req.body;
    const user = userManager.registerUser(username, displayName, pin);
    const token = crypto.randomBytes(32).toString('hex');
    activeContributorSessions.set(token, user.username);

    // Set persistent 90-day cookies
    res.cookie('dcs_contributor_token', token, { maxAge: 90 * 24 * 3600 * 1000, httpOnly: false, sameSite: 'lax', path: '/' });
    res.cookie('dcs_contributor_user', user.username, { maxAge: 90 * 24 * 3600 * 1000, httpOnly: false, sameSite: 'lax', path: '/' });

    // Sync user registry to Google Drive in background
    persistUsersToDrive().catch((e) => console.warn('Background Drive user sync error:', e.message));

    res.json({ success: true, user, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/users/login', (req, res) => {
  try {
    const { username, pin } = req.body;
    const user = userManager.verifyUser(username, pin);
    const token = crypto.randomBytes(32).toString('hex');
    activeContributorSessions.set(token, user.username);

    // Set persistent 90-day cookies
    res.cookie('dcs_contributor_token', token, { maxAge: 90 * 24 * 3600 * 1000, httpOnly: false, sameSite: 'lax', path: '/' });
    res.cookie('dcs_contributor_user', user.username, { maxAge: 90 * 24 * 3600 * 1000, httpOnly: false, sameSite: 'lax', path: '/' });

    res.json({ success: true, user, token });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.get('/api/users/me', (req, res) => {
  const username = getAuthenticatedContributor(req);
  if (username) {
    const user = userManager.getUser(username);
    if (user) {
      return res.json({ authenticated: true, user });
    }
  }
  return res.json({ authenticated: false });
});

app.post('/api/users/logout', (req, res) => {
  const token = req.cookies['dcs_contributor_token'] || req.headers['x-contributor-token'];
  if (token) {
    activeContributorSessions.delete(token);
  }
  res.clearCookie('dcs_contributor_token', { path: '/' });
  res.clearCookie('dcs_contributor_user', { path: '/' });
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// Multer setup
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase();
    const name = (file.originalname || '').toLowerCase();
    if (
      mime.startsWith('audio/') ||
      mime === 'video/mp4' ||
      mime === 'video/webm' ||
      mime === 'application/octet-stream' ||
      name.endsWith('.wav') ||
      name.endsWith('.mp3') ||
      name.endsWith('.webm') ||
      name.endsWith('.m4a') ||
      name.endsWith('.ogg')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only audio recordings are accepted'), false);
    }
  },
});

// ---------------------------------------------------------------------------
// Google OAuth 2.0 Client & Token Persistence
// ---------------------------------------------------------------------------
let cachedOAuth2Client = null;

function persistRefreshTokenToEnv(refreshToken) {
  try {
    const envPath = path.join(ROOT_DIR, '.env');
    if (!fs.existsSync(envPath)) return;

    let envContent = fs.readFileSync(envPath, 'utf8');
    if (envContent.includes('GOOGLE_REFRESH_TOKEN=')) {
      envContent = envContent.replace(
        /GOOGLE_REFRESH_TOKEN=.*/g,
        `GOOGLE_REFRESH_TOKEN=${refreshToken}`
      );
    } else {
      envContent += `\n# Google OAuth Persistent Refresh Token\nGOOGLE_REFRESH_TOKEN=${refreshToken}\n`;
    }
    fs.writeFileSync(envPath, envContent, 'utf8');
    process.env.GOOGLE_REFRESH_TOKEN = refreshToken;
  } catch (err) {
    console.warn('Could not persist refresh token to .env:', err.message);
  }
}

function saveTokens(newTokens) {
  let existing = {};
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    } catch (_) {}
  }

  // Ensure refresh_token is never wiped out when receiving refreshed access tokens.
  // tokens.json is lost on every Heroku restart, so the in-memory credentials must rank
  // above the env var, or a stale env token would overwrite the good one in PostgreSQL.
  const inMemory = cachedOAuth2Client && cachedOAuth2Client.credentials;
  const merged = {
    ...existing,
    ...newTokens,
    refresh_token:
      newTokens.refresh_token ||
      (inMemory && inMemory.refresh_token) ||
      existing.refresh_token ||
      process.env.GOOGLE_REFRESH_TOKEN,
  };

  try {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write tokens.json:', err.message);
  }

  if (merged.refresh_token) {
    persistRefreshTokenToEnv(merged.refresh_token);
  }

  // Persist tokens in PostgreSQL app_settings table (survives all Heroku redeployments)
  try {
    userManager.setDbSetting('google_tokens', JSON.stringify(merged)).catch(() => {});
  } catch (_) {}

  return merged;
}

async function loadTokensFromDb(oauth2Client) {
  try {
    const raw = await userManager.getDbSetting('google_tokens');
    if (raw) {
      const tokens = JSON.parse(raw);
      if (tokens && (tokens.refresh_token || tokens.access_token)) {
        oauth2Client.setCredentials(tokens);
        console.log('🐘 Loaded persistent Google OAuth credentials from PostgreSQL.');
        return true;
      }
    }
  } catch (err) {
    console.warn('Could not load tokens from PostgreSQL:', err.message);
  }
  return false;
}

function loadSavedTokens(oauth2Client) {
  let tokens = null;
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    } catch (e) {
      console.warn('Error reading tokens.json:', e.message);
    }
  }

  if (!tokens || (!tokens.refresh_token && !tokens.access_token)) {
    if (process.env.GOOGLE_REFRESH_TOKEN) {
      tokens = { refresh_token: process.env.GOOGLE_REFRESH_TOKEN.trim() };
    } else if (process.env.GOOGLE_TOKENS_JSON) {
      try {
        tokens = JSON.parse(process.env.GOOGLE_TOKENS_JSON);
      } catch (_) {}
    }
  }

  if (tokens) {
    // If tokens on disk lack refresh_token but env has it, preserve it
    if (!tokens.refresh_token && process.env.GOOGLE_REFRESH_TOKEN) {
      tokens.refresh_token = process.env.GOOGLE_REFRESH_TOKEN.trim();
    }

    if (tokens.refresh_token || tokens.access_token) {
      oauth2Client.setCredentials(tokens);
      return true;
    }
  }

  return false;
}

function getOAuth2Client() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return null;
  }

  if (!cachedOAuth2Client) {
    cachedOAuth2Client = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI
    );

    loadSavedTokens(cachedOAuth2Client);

    cachedOAuth2Client.on('tokens', (tokens) => {
      try {
        const merged = saveTokens(tokens);
        cachedOAuth2Client.setCredentials({
          ...cachedOAuth2Client.credentials,
          ...merged,
        });
        console.log('🔄 Google OAuth access token refreshed and saved successfully.');
      } catch (err) {
        console.error('Failed to update tokens on refresh:', err.message);
      }
    });
  }

  return cachedOAuth2Client;
}

function getDriveClient() {
  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) {
    throw new Error('Google OAuth Client ID & Secret are not configured in .env');
  }

  const hasCredentials =
    oauth2Client.credentials &&
    (oauth2Client.credentials.refresh_token || oauth2Client.credentials.access_token);

  if (!hasCredentials) {
    const loaded = loadSavedTokens(oauth2Client);
    if (!loaded) {
      throw new Error('Google account not connected. Please click "Connect Google Drive".');
    }
  }

  return google.drive({ version: 'v3', auth: oauth2Client });
}

// ---------------------------------------------------------------------------
// Questions Cache per language
// ---------------------------------------------------------------------------
const questionsCache = {
  akan: null,
  ewe: null,
};

async function getQuestions(lang = 'akan') {
  const normLang = (lang || 'akan').toLowerCase() === 'ewe' ? 'ewe' : 'akan';
  if (questionsCache[normLang]) return questionsCache[normLang];

  const docPath = normLang === 'ewe' ? DOCX_PATH_EWE : DOCX_PATH_AKAN;
  if (!docPath || !fs.existsSync(docPath)) {
    throw new Error(`Questionnaire file not found for ${normLang}: ${docPath}`);
  }
  questionsCache[normLang] = await parseQuestions(docPath);
  return questionsCache[normLang];
}

// ---------------------------------------------------------------------------
// List Drive files in target folder
// ---------------------------------------------------------------------------
const EXTS = ['.wav', '.mp3', '.webm', '.ogg', '.m4a'];

async function listDriveFiles() {
  const drive = getDriveClient();
  if (!DRIVE_FOLDER_ID) {
    throw new Error('DRIVE_FOLDER_ID is not set in .env');
  }

  const cleanFolderId = DRIVE_FOLDER_ID.trim();
  const filesMap = new Map();
  let pageToken = null;

  try {
    do {
      const res = await drive.files.list({
        q: `'${cleanFolderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, webViewLink, webContentLink)',
        pageSize: 1000,
        pageToken: pageToken || undefined,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      if (res.data.files) {
        for (const file of res.data.files) {
          if (!file.name) continue;
          const normKey = file.name.trim().toLowerCase();
          filesMap.set(normKey, {
            fileId: file.id,
            name: file.name,
            webViewLink: file.webViewLink,
            webContentLink: file.webContentLink,
            isLocal: false,
          });
        }
      }

      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    console.warn('listDriveFiles error:', err.message);
  }

  // Also include local files in uploads folder as local fallback
  if (fs.existsSync(UPLOADS_DIR)) {
    try {
      const localEntries = fs.readdirSync(UPLOADS_DIR);
      for (const lf of localEntries) {
        const normKey = lf.trim().toLowerCase();
        if (!filesMap.has(normKey) && EXTS.some((e) => normKey.endsWith(e))) {
          filesMap.set(normKey, {
            fileId: `local-${lf}`,
            name: lf,
            webViewLink: null,
            webContentLink: null,
            isLocal: true,
          });
        }
      }
    } catch (_) {}
  }

  return filesMap;
}

// ---------------------------------------------------------------------------
// Audio File Lookup Helpers
// ---------------------------------------------------------------------------
function findDriveFile(filesMap, prefixes) {
  for (const prefix of prefixes) {
    const normPrefix = prefix.trim().toLowerCase();
    for (const ext of EXTS) {
      const key = `${normPrefix}${ext}`;
      if (filesMap.has(key)) {
        return filesMap.get(key);
      }
    }
  }
  return null;
}

function getAudioPrefixes(qid, targetType, lang) {
  const normLang = (lang || 'akan').toLowerCase() === 'ewe' ? 'ewe' : 'akan';
  const otherLang = normLang === 'ewe' ? 'akan' : 'ewe';
  const isOptions = targetType === 'options';

  if (isOptions) {
    return [
      // Language-specific options formats
      `${qid}_options_${normLang}`,
      `${qid}_opts_${normLang}`,
      `${qid}_${normLang}_options`,
      `${qid}_${normLang}_opts`,
      `${qid}_options.${normLang}`,
      `${qid}.${normLang}_options`,
      // Backward-compatible un-suffixed formats from previous deploys
      `${qid}_options`,
      `${qid}_opts`,
      `${qid}_opt`,
    ];
  } else {
    return [
      // Language-specific question formats
      `${qid}_question_${normLang}`,
      `${qid}_${normLang}_question`,
      `${qid}_question.${normLang}`,
      `${qid}.${normLang}_question`,
      `${qid}_${normLang}`,
      `${qid}.${normLang}`,
      `${qid}_prompt_${normLang}`,
      // Backward-compatible un-suffixed formats from previous deploys
      `${qid}_question`,
      `${qid}_prompt`,
      `${qid}`,
      `${qid}_q`,
    ];
  }
}

// ---------------------------------------------------------------------------
// OAuth Routes
// ---------------------------------------------------------------------------
app.get('/auth/google', (req, res) => {
  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) {
    return res.status(500).send('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in .env');
  }

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/drive',
    ],
  });

  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('No authorization code provided');
  }

  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    const merged = saveTokens(tokens);
    oauth2Client.setCredentials(merged);
    console.log('✅ Google Drive connected. Persistent tokens saved.');

    // Restore and sync contributor accounts with Google Drive
    restoreUsersFromDrive().catch((e) => console.warn('Drive restore users error:', e.message));
    processPendingUploads();

    res.redirect('/?auth=success');
  } catch (err) {
    console.error('Error exchanging OAuth code:', err);
    res.status(500).send(`Authentication error: ${err.message}`);
  }
});

app.get('/api/auth-status', (req, res) => {
  const oauthConfigured = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
  const oauth2Client = getOAuth2Client();
  const isAuthenticated = Boolean(
    (oauth2Client && oauth2Client.credentials && (oauth2Client.credentials.refresh_token || oauth2Client.credentials.access_token)) ||
    fs.existsSync(TOKEN_PATH) ||
    process.env.GOOGLE_REFRESH_TOKEN
  );

  let currentScope = (oauth2Client && oauth2Client.credentials && oauth2Client.credentials.scope) || '';
  if (!currentScope && fs.existsSync(TOKEN_PATH)) {
    try {
      const t = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      currentScope = t.scope || '';
    } catch (_) {}
  }

  // Check if token has full Drive scope (not just restricted drive.file)
  const hasFullDriveScope = currentScope.split(' ').some((s) => s === 'https://www.googleapis.com/auth/drive');

  res.json({
    configured: oauthConfigured,
    authenticated: isAuthenticated,
    hasFullDriveScope,
    scope: currentScope,
  });
});

// ---------------------------------------------------------------------------
// User Drive Folder & Audio Helpers
// ---------------------------------------------------------------------------
const userDriveFolderCache = new Map();

function sanitizeUsername(rawUser) {
  if (!rawUser || typeof rawUser !== 'string') return 'default_user';
  const clean = rawUser.trim().replace(/[^a-zA-Z0-9_\-]/g, '_');
  return clean || 'default_user';
}

async function getUserDriveFolder(drive, parentId, user) {
  const normUser = sanitizeUsername(user);
  const folderName = `User_${normUser}`;
  const cacheKey = `${parentId}_${normUser.toLowerCase()}`;
  if (userDriveFolderCache.has(cacheKey)) {
    return userDriveFolderCache.get(cacheKey);
  }

  // Check for existing folder matching either User_<username> or exact <username>
  const res = await drive.files.list({
    q: `'${parentId}' in parents and (name = '${folderName}' or name = '${normUser}') and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (res.data.files && res.data.files.length > 0) {
    // Prefer exact contributor folder if present, otherwise User_contributor
    const exact = res.data.files.find((f) => f.name.toLowerCase() === normUser.toLowerCase());
    const id = exact ? exact.id : res.data.files[0].id;
    userDriveFolderCache.set(cacheKey, id);
    return id;
  }

  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      parents: [parentId],
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id, name',
    supportsAllDrives: true,
  });

  const newId = created.data.id;
  userDriveFolderCache.set(cacheKey, newId);
  return newId;
}

async function getUserPracticeDriveFolder(drive, userFolderId) {
  const cacheKey = `practice_${userFolderId}`;
  if (userDriveFolderCache.has(cacheKey)) {
    return userDriveFolderCache.get(cacheKey);
  }

  const res = await drive.files.list({
    q: `'${userFolderId}' in parents and name = 'practice' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (res.data.files && res.data.files.length > 0) {
    const id = res.data.files[0].id;
    userDriveFolderCache.set(cacheKey, id);
    return id;
  }

  const created = await drive.files.create({
    requestBody: {
      name: 'practice',
      parents: [userFolderId],
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id, name',
    supportsAllDrives: true,
  });

  const newId = created.data.id;
  userDriveFolderCache.set(cacheKey, newId);
  return newId;
}

// ---------------------------------------------------------------------------
// Cloud User Registry Sync with Google Drive
// Ensures accounts survive restarts and redeployments across ephemeral cloud hosts.
// ---------------------------------------------------------------------------
async function restoreUsersFromDrive() {
  try {
    const drive = getDriveClient();
    const cleanFolderId = (DRIVE_FOLDER_ID || '').trim();
    if (!drive || !cleanFolderId) return;

    // A. Check for dcs_users_registry.json
    try {
      const res = await drive.files.list({
        q: `'${cleanFolderId}' in parents and name = 'dcs_users_registry.json' and trashed = false`,
        fields: 'files(id, name, modifiedTime)',
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      if (res.data.files && res.data.files.length > 0) {
        const fileId = res.data.files[0].id;
        const downloadRes = await drive.files.get(
          { fileId, alt: 'media', supportsAllDrives: true },
          { responseType: 'text' }
        );

        const content = downloadRes.data;
        if (content) {
          const cloudUsers = typeof content === 'string' ? JSON.parse(content) : content;
          if (Array.isArray(cloudUsers) && cloudUsers.length > 0) {
            userManager.mergeUsers(cloudUsers);
            console.log(`✅ Restored ${cloudUsers.length} contributor account(s) from Google Drive registry.`);
          }
        }
      }
    } catch (regErr) {
      console.warn('Could not read dcs_users_registry.json:', regErr.message);
    }

    // B. Reconcile existing User_* folders in Drive (auto-recovers all contributors who recorded)
    try {
      const folderRes = await drive.files.list({
        q: `'${cleanFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and name contains 'User_' and trashed = false`,
        fields: 'files(id, name, createdTime)',
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const folders = folderRes.data.files || [];
      const recoveredUsers = [];
      const currentUsers = userManager.getRawUsers();
      const existingMap = new Map(currentUsers.map(u => [u.username.toLowerCase(), u]));

      for (const f of folders) {
        const uName = f.name.replace(/^User_/, '').trim();
        if (uName && !existingMap.has(uName.toLowerCase())) {
          const salt = crypto.randomBytes(16).toString('hex');
          const defaultPin = '1234';
          const pinHash = crypto.createHash('sha256').update(`${salt}:${defaultPin}`).digest('hex');
          recoveredUsers.push({
            username: uName,
            displayName: uName,
            salt,
            pinHash,
            createdAt: f.createdTime || new Date().toISOString(),
            lastActive: f.createdTime || new Date().toISOString(),
            practiceCompleted: true,
            practiceApproved: true,
            practiceApprovedAt: new Date().toISOString(),
            practiceApprovedBy: 'auto_recovered_from_drive_folder',
          });
        }
      }

      if (recoveredUsers.length > 0) {
        userManager.mergeUsers(recoveredUsers);
        console.log(`✅ Auto-recovered ${recoveredUsers.length} contributor account(s) directly from Google Drive folders!`);
      }
    } catch (fErr) {
      console.warn('Drive folder scan error:', fErr.message);
    }
  } catch (err) {
    // Non-fatal if drive not connected yet
    console.log('ℹ️ Google Drive user registry restore skipped:', err.message);
  }
}

async function persistUsersToDrive() {
  try {
    const drive = getDriveClient();
    const cleanFolderId = (DRIVE_FOLDER_ID || '').trim();
    if (!drive || !cleanFolderId) return;

    const users = userManager.getRawUsers();
    if (!users || users.length === 0) {
      console.log('ℹ️ Skipping persistUsersToDrive: local users registry is empty.');
      return;
    }

    const content = JSON.stringify(users, null, 2);

    const res = await drive.files.list({
      q: `'${cleanFolderId}' in parents and name = 'dcs_users_registry.json' and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const bufferStream = new Readable();
    bufferStream.push(content);
    bufferStream.push(null);

    if (res.data.files && res.data.files.length > 0) {
      const fileId = res.data.files[0].id;
      await drive.files.update({
        fileId,
        media: {
          mimeType: 'application/json',
          body: bufferStream,
        },
        supportsAllDrives: true,
      });
      console.log('☁️ Synced dcs_users_registry.json to Google Drive.');
    } else {
      await drive.files.create({
        requestBody: {
          name: 'dcs_users_registry.json',
          parents: [cleanFolderId],
          mimeType: 'application/json',
        },
        media: {
          mimeType: 'application/json',
          body: bufferStream,
        },
        supportsAllDrives: true,
      });
      console.log('☁️ Created dcs_users_registry.json in Google Drive.');
    }
  } catch (err) {
    console.warn('Could not persist users registry to Google Drive:', err.message);
  }
}

function parseAudioFilename(filename, defaultUser) {
  const isOptions = filename.includes('_options') || filename.includes('_opts');
  const isPractice = filename.startsWith('practice_');
  let lang = 'akan';
  if (filename.toLowerCase().includes('_ewe')) lang = 'ewe';
  else if (filename.toLowerCase().includes('_akan')) lang = 'akan';

  let questionId = 'Unknown';
  if (isPractice) {
    const parts = filename.split('_');
    if (parts.length >= 2) questionId = parts[1];
  } else {
    const m = filename.match(/^([A-Za-z0-9]+)/);
    if (m) questionId = m[1];
  }

  return {
    questionId,
    targetType: isPractice ? 'practice' : (isOptions ? 'options' : 'question'),
    lang,
    isPractice,
  };
}

async function listAllRecordings() {
  const recordings = [];
  const usersSet = new Set();

  // 0. Include all registered contributors
  for (const regUser of userManager.listUsers()) {
    usersSet.add(regUser.username);
  }

  const drive = (() => {
    try { return getDriveClient(); } catch (_) { return null; }
  })();
  const cleanFolderId = (DRIVE_FOLDER_ID || '').trim();

  // 1. Scan Google Drive if connected
  if (drive && cleanFolderId) {
    try {
      const rootRes = await drive.files.list({
        q: `'${cleanFolderId}' in parents and trashed = false`,
        fields: 'files(id, name, mimeType, size, createdTime, webViewLink)',
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const rootItems = rootRes.data.files || [];
      const userFolders = rootItems.filter(f => f.mimeType === 'application/vnd.google-apps.folder' && f.name.startsWith('User_'));
      const legacyFiles = rootItems.filter(f => f.mimeType !== 'application/vnd.google-apps.folder' && EXTS.some(ext => f.name.toLowerCase().endsWith(ext)));

      for (const lf of legacyFiles) {
        const meta = parseAudioFilename(lf.name, 'default_user');
        usersSet.add('default_user');
        recordings.push({
          fileId: lf.id,
          name: lf.name,
          user: 'default_user',
          questionId: meta.questionId,
          targetType: meta.targetType,
          lang: meta.lang,
          size: lf.size ? parseInt(lf.size, 10) : 0,
          createdTime: lf.createdTime || null,
          webViewLink: lf.webViewLink,
          isLocal: false,
          isPractice: meta.isPractice,
        });
      }

      for (const uf of userFolders) {
        const username = uf.name.replace(/^User_/, '');
        usersSet.add(username);

        const uRes = await drive.files.list({
          q: `'${uf.id}' in parents and trashed = false`,
          fields: 'files(id, name, mimeType, size, createdTime, webViewLink)',
          pageSize: 1000,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });

        const userFiles = (uRes.data.files || []).filter(f => f.mimeType !== 'application/vnd.google-apps.folder');
        for (const file of userFiles) {
          const meta = parseAudioFilename(file.name, username);
          recordings.push({
            fileId: file.id,
            name: file.name,
            user: username,
            userFolderId: uf.id,
            questionId: meta.questionId,
            targetType: meta.targetType,
            lang: meta.lang,
            size: file.size ? parseInt(file.size, 10) : 0,
            createdTime: file.createdTime || null,
            webViewLink: file.webViewLink,
            isLocal: false,
            isPractice: meta.isPractice,
          });
        }
      }
    } catch (err) {
      console.warn('Error listing Drive recordings for admin:', err.message);
    }
  }

  // 2. Scan local uploads directory
  if (fs.existsSync(UPLOADS_DIR)) {
    try {
      const entries = fs.readdirSync(UPLOADS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (entry.name === 'practice') continue;
          const username = entry.name;
          usersSet.add(username);
          const userDir = path.join(UPLOADS_DIR, username);
          const uFiles = fs.readdirSync(userDir, { withFileTypes: true });
          for (const uf of uFiles) {
            if (uf.isFile() && EXTS.some(ext => uf.name.toLowerCase().endsWith(ext))) {
              const fullPath = path.join(userDir, uf.name);
              const stat = fs.statSync(fullPath);
              const meta = parseAudioFilename(uf.name, username);

              const already = recordings.find(r => r.name.toLowerCase() === uf.name.toLowerCase() && r.user === username);
              if (already) {
                already.isLocal = true;
                already.localPath = fullPath;
              } else {
                recordings.push({
                  fileId: `local-${username}-${uf.name}`,
                  name: uf.name,
                  user: username,
                  questionId: meta.questionId,
                  targetType: meta.targetType,
                  lang: meta.lang,
                  size: stat.size,
                  createdTime: stat.mtime.toISOString(),
                  webViewLink: null,
                  isLocal: true,
                  localPath: fullPath,
                  isPractice: meta.isPractice,
                });
              }
            }
          }
        } else if (entry.isFile() && EXTS.some(ext => entry.name.toLowerCase().endsWith(ext))) {
          const fullPath = path.join(UPLOADS_DIR, entry.name);
          const stat = fs.statSync(fullPath);
          const meta = parseAudioFilename(entry.name, 'default_user');
          usersSet.add('default_user');
          const already = recordings.find(r => r.name.toLowerCase() === entry.name.toLowerCase() && r.user === 'default_user');
          if (already) {
            already.isLocal = true;
            already.localPath = fullPath;
          } else {
            recordings.push({
              fileId: `local-${entry.name}`,
              name: entry.name,
              user: 'default_user',
              questionId: meta.questionId,
              targetType: meta.targetType,
              lang: meta.lang,
              size: stat.size,
              createdTime: stat.mtime.toISOString(),
              webViewLink: null,
              isLocal: true,
              localPath: fullPath,
              isPractice: meta.isPractice,
            });
          }
        }
      }
    } catch (localErr) {
      console.warn('Error reading local uploads for admin:', localErr.message);
    }
  }

  for (const r of recordings) {
    r.streamUrl = `/api/audio/${encodeURIComponent(r.user)}/${encodeURIComponent(r.name)}${r.fileId && !r.fileId.startsWith('local-') ? `?fileId=${encodeURIComponent(r.fileId)}` : ''}`;
  }

  return { recordings, users: Array.from(usersSet).sort() };
}

// ---------------------------------------------------------------------------
// Standard API Routes
// ---------------------------------------------------------------------------

// Public questions list for collectors (clean, fast, no biased markers)
app.get('/api/questions', async (req, res) => {
  try {
    const lang = (req.query.lang || 'akan').toLowerCase() === 'ewe' ? 'ewe' : 'akan';
    const questions = await getQuestions(lang);

    res.json({
      lang,
      questions,
      total: questions.length,
    });
  } catch (err) {
    console.error('GET /api/questions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Warm-up practice set: a spread of questions across the questionnaire
app.get('/api/practice', async (req, res) => {
  try {
    const lang = (req.query.lang || 'akan').toLowerCase() === 'ewe' ? 'ewe' : 'akan';
    const count = Math.min(Math.max(parseInt(req.query.count, 10) || 3, 1), 30);
    const all = (await getQuestions(lang)).filter((q) => q.text);

    let picked;
    if (req.query.ids) {
      const wanted = String(req.query.ids).split(',');
      picked = wanted.map((id) => all.find((q) => q.id === id)).filter(Boolean);
    } else {
      picked = [];
      const size = all.length / Math.min(count, all.length);
      for (let i = 0; i < Math.min(count, all.length); i++) {
        const start = Math.floor(i * size);
        const end = Math.max(start + 1, Math.floor((i + 1) * size));
        picked.push(all[start + Math.floor(Math.random() * (end - start))]);
      }
    }

    res.json({ lang, questions: picked });
  } catch (err) {
    console.error('GET /api/practice error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Contributor Practice Status & Saved Questions
app.get('/api/practice/status', async (req, res) => {
  try {
    const authUser = getAuthenticatedContributor(req);
    if (!authUser) {
      return res.json({ authenticated: false, practiceCompleted: false, practiceApproved: false, savedQuestionIds: [] });
    }
    const user = userManager.getUser(authUser);
    if (!user) {
      return res.json({ authenticated: false, practiceCompleted: false, practiceApproved: false, savedQuestionIds: [] });
    }

    const savedQuestionIds = new Set();
    const userPracticeDir = path.join(UPLOADS_DIR, authUser, 'practice');
    if (fs.existsSync(userPracticeDir)) {
      try {
        const files = fs.readdirSync(userPracticeDir);
        for (const f of files) {
          const meta = parseAudioFilename(f, authUser);
          if (meta.isPractice && meta.questionId && (!user.language || meta.lang === user.language)) {
            savedQuestionIds.add(meta.questionId);
          }
        }
      } catch (_) {}
    }

    // Also check Google Drive practice folder if available
    try {
      const drive = getDriveClient();
      const parentId = (DRIVE_FOLDER_ID || '').trim();
      if (drive && parentId) {
        const userFolderId = await getUserDriveFolder(drive, parentId, authUser);
        const practiceFolderId = await getUserPracticeDriveFolder(drive, userFolderId);
        const driveFiles = await drive.files.list({
          q: `'${practiceFolderId}' in parents and trashed = false`,
          fields: 'files(id, name)',
          pageSize: 200,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        if (driveFiles.data.files) {
          for (const df of driveFiles.data.files) {
            const meta = parseAudioFilename(df.name, authUser);
            if (meta.isPractice && meta.questionId && (!user.language || meta.lang === user.language)) {
              savedQuestionIds.add(meta.questionId);
            }
          }
        }
      }
    } catch (_) {}

    res.json({
      authenticated: true,
      user,
      practiceCompleted: Boolean(user.practiceCompleted),
      practiceApproved: Boolean(user.practiceApproved),
      savedQuestionIds: Array.from(savedQuestionIds),
    });
  } catch (err) {
    console.error('GET /api/practice/status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Mark Practice Completed & Request Admin Approval
app.post('/api/practice/complete', (req, res) => {
  try {
    const authUser = getAuthenticatedContributor(req);
    if (!authUser) {
      return res.status(401).json({ error: 'Please sign in to submit your practice session.' });
    }
    const success = userManager.setPracticeCompleted(authUser);
    if (!success) {
      return res.status(404).json({ error: 'User not found in registry.' });
    }
    persistUsersToDrive().catch((e) => console.warn('Drive persist practice complete error:', e.message));
    const user = userManager.getUser(authUser);
    res.json({ success: true, user });
  } catch (err) {
    console.error('POST /api/practice/complete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Uploads one recording to the contributor's Drive folder. Throws if Drive is unreachable.
async function sendToDrive(item) {
  const cleanFolderId = (DRIVE_FOLDER_ID || '').trim();
  if (!cleanFolderId) {
    throw new Error('DRIVE_FOLDER_ID is not configured');
  }

  const drive = getDriveClient();
  let folderId = await getUserDriveFolder(drive, cleanFolderId, item.username);
  if (item.practice) {
    folderId = await getUserPracticeDriveFolder(drive, folderId);
  }

  if (item.retry) {
    // The earlier attempt may have reached Drive before the pending row was cleared
    const dup = await drive.files.list({
      q: `'${folderId}' in parents and name = '${item.filename}' and trashed = false`,
      fields: 'files(id, name, webViewLink)',
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    if (dup.data.files && dup.data.files.length > 0) {
      return dup.data.files[0];
    }
  }

  // If replace=true, delete old file matching this question/track in this user's folder
  if (item.replace && !item.practice) {
    try {
      const prefixes = getAudioPrefixes(item.questionId, item.targetType, item.lang);
      const existing = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, name)',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of existing.data.files || []) {
        // Exact name match only. A "starts with" test would also hit C10..C19 and C1's options track.
        const fn = f.name.toLowerCase();
        if (prefixes.some((p) => EXTS.some((ext) => fn === `${p.toLowerCase()}${ext}`))) {
          await drive.files.delete({ fileId: f.id, supportsAllDrives: true });
        }
      }
    } catch (delErr) {
      console.warn('Could not delete old file in user folder:', delErr.message);
    }
  }

  const bufferStream = new Readable();
  bufferStream.push(item.buffer);
  bufferStream.push(null);

  const driveRes = await drive.files.create({
    requestBody: {
      name: item.filename,
      parents: [folderId],
      mimeType: item.mime,
    },
    media: {
      mimeType: item.mime,
      body: bufferStream,
    },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });
  return driveRes.data;
}

// Retries recordings held in Postgres. Safe to call repeatedly.
let pendingRunning = false;
async function processPendingUploads() {
  if (pendingRunning || !pendingUploads.isEnabled()) return;
  pendingRunning = true;
  try {
    const items = await pendingUploads.listAll();
    if (items.length === 0) return;
    console.log(`⏳ Retrying ${items.length} recording(s) held in Postgres...`);
    let done = 0;
    for (const item of items) {
      try {
        await sendToDrive({ ...item, pendingId: item.id, retry: true });
        await pendingUploads.remove(item.id);
        done++;
      } catch (err) {
        await pendingUploads.markFailed(item.id, err.message);
        console.warn(`Retry failed for ${item.filename}: ${err.message}`);
        // Auth/quota failures affect every file; stop and try again on the next tick
        if (/invalid_grant|not connected|unauthorized|quota/i.test(err.message)) break;
      }
    }
    console.log(`✅ Drive retry finished: ${done}/${items.length} delivered.`);
  } catch (err) {
    console.warn('Pending upload retry error:', err.message);
  } finally {
    pendingRunning = false;
  }
}

// Main upload route — saves in per-user folder as MP3
app.post('/api/upload', upload.single('audio'), async (req, res) => {
  try {
    const { questionId, targetType, lang, replace, user } = req.body;
    const authUser = getAuthenticatedContributor(req);
    const normUser = userManager.sanitizeUsername(authUser || user);

    if (!normUser || normUser === 'default_user') {
      return res.status(401).json({ error: 'Please sign in with your contributor account before uploading.' });
    }

    // Enforce admin greenlight requirement before real questionnaire takes can be saved
    const userRecord = userManager.getUser(normUser);
    if (!userRecord || !userRecord.practiceApproved) {
      return res.status(403).json({
        error: 'Practice approval required. Please complete practice and obtain admin greenlight before recording actual questionnaire items.',
      });
    }

    const normLang = (lang || 'akan').toLowerCase() === 'ewe' ? 'ewe' : 'akan';
    if (userRecord.language && normLang !== userRecord.language) {
      return res.status(403).json({ error: `This contributor is assigned to ${userRecord.language === 'ewe' ? 'Ewe' : 'Akan'} only.` });
    }

    if (!questionId) {
      return res.status(400).json({ error: 'questionId is required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const typeSuffix = targetType === 'options' ? '_options' : '_question';

    // Use uploaded file extension (prioritizing .wav)
    const originalExt = path.extname(req.file.originalname || '').toLowerCase();
    const ext = originalExt && EXTS.includes(originalExt) ? originalExt : '.wav';

    const filename = `${questionId}${typeSuffix}_${normLang}${ext}`;

    // 1. Save local backup in user folder
    const userDir = path.join(UPLOADS_DIR, normUser);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    const localPath = path.join(userDir, filename);
    fs.writeFileSync(localPath, req.file.buffer);

    // 2. Hold the audio in Postgres until Drive confirms it (local disk is wiped on Heroku restarts)
    const uploadMime = (req.file.mimetype && req.file.mimetype.startsWith('audio/'))
      ? req.file.mimetype
      : (ext === '.wav' ? 'audio/wav' : 'audio/mpeg');

    const item = {
      username: normUser,
      filename,
      practice: false,
      replace: replace === 'true',
      questionId,
      targetType,
      lang: normLang,
      mime: uploadMime,
      buffer: req.file.buffer,
    };
    item.pendingId = await pendingUploads.enqueue(item);

    // 3. Upload to Google Drive inside user's designated folder
    let driveFile;
    try {
      driveFile = await sendToDrive(item);
      await pendingUploads.remove(item.pendingId);
    } catch (driveErr) {
      if (!item.pendingId) throw driveErr;
      console.error(`Drive upload failed, ${filename} kept in Postgres for retry:`, driveErr.message);
      await pendingUploads.markFailed(item.pendingId, driveErr.message);
      return res.json({ success: true, queued: true, filename, user: normUser, lang: normLang, targetType: targetType || 'question' });
    }

    res.json({
      success: true,
      fileId: driveFile.id,
      filename: driveFile.name,
      user: normUser,
      lang: normLang,
      targetType: targetType || 'question',
      webViewLink: driveFile.webViewLink,
    });
  } catch (err) {
    console.error('POST /api/upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Practice upload route — saved in user's practice subfolder
app.post('/api/practice-upload', upload.single('audio'), async (req, res) => {
  try {
    const { questionId, lang, user } = req.body;
    const authUser = getAuthenticatedContributor(req);
    const normUser = userManager.sanitizeUsername(authUser || user);

    if (!normUser || normUser === 'default_user') {
      return res.status(401).json({ error: 'Please sign in with your contributor account before uploading.' });
    }
    const userRecord = userManager.getUser(normUser);
    if (!userRecord) {
      return res.status(404).json({ error: 'Contributor account not found.' });
    }
    const normLang = (lang || 'akan').toLowerCase() === 'ewe' ? 'ewe' : 'akan';
    if (userRecord.language && normLang !== userRecord.language) {
      return res.status(403).json({ error: `This contributor is assigned to ${userRecord.language === 'ewe' ? 'Ewe' : 'Akan'} only.` });
    }

    if (!questionId || !/^[A-Za-z0-9]+$/.test(questionId)) {
      return res.status(400).json({ error: 'A valid questionId is required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const originalExt = path.extname(req.file.originalname || '').toLowerCase();
    const ext = originalExt && EXTS.includes(originalExt) ? originalExt : '.wav';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `practice_${questionId}_${normLang}_${stamp}${ext}`;

    // 1. Save local backup in user's practice folder
    const userPracticeDir = path.join(UPLOADS_DIR, normUser, 'practice');
    fs.mkdirSync(userPracticeDir, { recursive: true });
    fs.writeFileSync(path.join(userPracticeDir, filename), req.file.buffer);

    // 2. Hold the audio in Postgres until Drive confirms it
    const uploadMime = (req.file.mimetype && req.file.mimetype.startsWith('audio/'))
      ? req.file.mimetype
      : (ext === '.wav' ? 'audio/wav' : 'audio/mpeg');

    const item = {
      username: normUser,
      filename,
      practice: true,
      questionId,
      lang: normLang,
      mime: uploadMime,
      buffer: req.file.buffer,
    };
    item.pendingId = await pendingUploads.enqueue(item);

    // 3. Upload to Drive inside user's practice folder
    try {
      const driveFile = await sendToDrive(item);
      await pendingUploads.remove(item.pendingId);
      return res.json({ success: true, filename: driveFile.name, user: normUser });
    } catch (driveErr) {
      if (!item.pendingId) throw driveErr;
      console.error(`Drive upload failed, ${filename} kept in Postgres for retry:`, driveErr.message);
      await pendingUploads.markFailed(item.pendingId, driveErr.message);
      return res.json({ success: true, queued: true, filename, user: normUser });
    }
  } catch (err) {
    console.error('POST /api/practice-upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Audio Streaming & Admin Routes
// ---------------------------------------------------------------------------

// Admin Authentication Middleware & Routes
function getExpectedAdminPassword() {
  let pw = null;
  // Read fresh from .env so password edits work immediately without requiring server restart
  try {
    const envPath = path.join(ROOT_DIR, '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const m = content.match(/^\s*ADMIN_PASSWORD\s*=\s*(.*)$/m);
      if (m && m[1] !== undefined) {
        pw = m[1].trim();
      }
    }
  } catch (_) {}

  if (!pw) {
    pw = process.env.ADMIN_PASSWORD || 'admin123';
  }

  // Strip any accidental surrounding quotes (e.g. "admin123" or 'admin123')
  return String(pw).trim().replace(/^["']|["']$/g, '');
}

const activeAdminTokens = new Set();

function requireAdminAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const customToken = req.headers['x-admin-token'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim() || customToken.trim() || ((req.query && req.query.admin_token) ? String(req.query.admin_token).trim() : '');

  if (token && activeAdminTokens.has(token)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized: Admin authentication required' });
}

app.post('/api/admin/login', (req, res) => {
  const submitted = String(req.body && req.body.password !== undefined ? req.body.password : '').trim();
  const expected = getExpectedAdminPassword();

  if (submitted && submitted === expected) {
    const token = crypto.randomBytes(32).toString('hex');
    activeAdminTokens.add(token);
    return res.json({ success: true, token });
  }
  return res.status(401).json({ error: 'Incorrect admin password' });
});

app.get('/api/admin/verify', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const customToken = req.headers['x-admin-token'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim() || customToken.trim() || ((req.query && req.query.admin_token) ? String(req.query.admin_token).trim() : '');
  if (token && activeAdminTokens.has(token)) {
    return res.json({ authenticated: true });
  }
  return res.json({ authenticated: false });
});

app.post('/api/admin/logout', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const customToken = req.headers['x-admin-token'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim() || customToken.trim() || ((req.query && req.query.admin_token) ? String(req.query.admin_token).trim() : '');
  if (token) {
    activeAdminTokens.delete(token);
  }
  return res.json({ success: true });
});

// Direct audio streaming for browser playback (local or Drive)
app.get('/api/audio/:user/:filename', async (req, res) => {
  try {
    const { user, filename } = req.params;
    const normUser = sanitizeUsername(user);
    const fileId = req.query.fileId;

    const userPath = path.join(UPLOADS_DIR, normUser, filename);
    const rootPath = path.join(UPLOADS_DIR, filename);

    const mime = filename.endsWith('.wav')
      ? 'audio/wav'
      : (filename.endsWith('.mp3') ? 'audio/mpeg' : 'audio/webm');

    if (fs.existsSync(userPath)) {
      res.setHeader('Content-Type', mime);
      return res.sendFile(userPath);
    }
    if (fs.existsSync(rootPath)) {
      res.setHeader('Content-Type', mime);
      return res.sendFile(rootPath);
    }

    if (fileId && !fileId.startsWith('local-')) {
      const drive = getDriveClient();
      res.setHeader('Content-Type', mime);
      const streamRes = await drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );
      return streamRes.data.pipe(res);
    }

    res.status(404).send('Audio file not found');
  } catch (err) {
    console.error('Audio stream error:', err.message);
    res.status(500).send(`Audio playback error: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// Contributor audit: every questionnaire item for this contributor, showing
// what is and is not in Drive, plus per-item review marks and a final sign-off
// ---------------------------------------------------------------------------
function requireContributor(req, res, next) {
  const user = getAuthenticatedContributor(req);
  if (!user) {
    return res.status(401).json({ error: 'Please sign in with your contributor account.' });
  }
  req.contributor = sanitizeUsername(user);
  next();
}

// Read-only lookup: unlike getUserDriveFolder this never creates the folder
async function findUserDriveFolderId(drive, parentId, user) {
  const normUser = sanitizeUsername(user);
  const res = await drive.files.list({
    q: `'${parentId}' in parents and (name = 'User_${normUser}' or name = '${normUser}') and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const folders = res.data.files || [];
  if (folders.length === 0) return null;
  const exact = folders.find((f) => f.name.toLowerCase() === normUser.toLowerCase());
  return (exact || folders[0]).id;
}

// Lower-cased filename -> Drive file, for the contributor's main folder (practice subfolder excluded)
async function listUserDriveAudio(user) {
  const parentId = (DRIVE_FOLDER_ID || '').trim();
  if (!parentId) throw new Error('DRIVE_FOLDER_ID is not configured');
  const drive = getDriveClient();
  const folderId = await findUserDriveFolderId(drive, parentId, user);
  const files = new Map();
  if (!folderId) return files;

  let pageToken;
  do {
    const r = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken, files(id, name, size, createdTime)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of r.data.files || []) {
      if (!f.name) continue;
      files.set(f.name.trim().toLowerCase(), {
        fileId: f.id,
        name: f.name,
        size: f.size ? parseInt(f.size, 10) : 0,
        createdTime: f.createdTime || null,
      });
    }
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return files;
}

function matchesPendingName(pendingNames, prefixes) {
  return prefixes.some((p) => EXTS.some((ext) => pendingNames.has(`${p.trim().toLowerCase()}${ext}`)));
}

async function buildAuditItems(user, lang, driveFiles, pendingNames) {
  const questions = await getQuestions(lang);
  const items = [];
  for (const q of questions) {
    const tracks = [['question', q.text || '']];
    if (Array.isArray(q.options) && q.options.length > 0) tracks.push(['options', q.options.join('\n')]);

    for (const [track, text] of tracks) {
      const prefixes = getAudioPrefixes(q.id, track, lang);
      const file = findDriveFile(driveFiles, prefixes);
      let status = 'missing';
      if (file) status = 'ok';
      else if (matchesPendingName(pendingNames, prefixes)) status = 'pending';

      items.push({
        key: `${q.id}:${track}:${lang}`,
        questionId: q.id,
        track,
        lang,
        text,
        status,
        name: file ? file.name : null,
        size: file ? file.size : 0,
        createdTime: file ? file.createdTime : null,
        streamUrl: file
          ? `/api/audio/${encodeURIComponent(user)}/${encodeURIComponent(file.name)}?fileId=${encodeURIComponent(file.fileId)}`
          : null,
      });
    }
  }
  return items;
}

function summarizeAudit(items) {
  const s = { total: items.length, recorded: 0, pending: 0, missing: 0 };
  for (const it of items) {
    if (it.status === 'ok') s.recorded++;
    else if (it.status === 'pending') s.pending++;
    else s.missing++;
  }
  return s;
}

// Languages the contributor has recorded in (defaults to Akan when they have recorded nothing yet)
function recordedLangs(driveFiles, pendingNames) {
  const langs = new Set();
  for (const name of [...driveFiles.keys(), ...pendingNames]) {
    if (name.startsWith('practice_')) continue;
    langs.add(parseAudioFilename(name, '').lang);
  }
  return langs.size > 0 ? [...langs].sort() : ['akan'];
}

async function loadAuditSources(user) {
  const driveFiles = await listUserDriveAudio(user);
  const pending = await pendingUploads.listForUser(user);
  const pendingNames = new Set(pending.filter((p) => !p.practice).map((p) => p.filename.toLowerCase()));
  return { driveFiles, pendingNames };
}

app.get('/api/my-audit', requireContributor, async (req, res) => {
  try {
    const user = req.contributor;
    let sources;
    try {
      sources = await loadAuditSources(user);
    } catch (driveErr) {
      console.error('GET /api/my-audit Drive error:', driveErr.message);
      return res.status(502).json({
        error: 'Could not reach Google Drive right now, so your recordings cannot be checked. Please try again later.',
      });
    }

    const assigned = (userManager.getUser(user) || {}).language || null;
    const langs = assigned ? [assigned] : recordedLangs(sources.driveFiles, sources.pendingNames);
    const wanted = (req.query.lang || '').toLowerCase();
    const lang = assigned || (wanted === 'ewe' || wanted === 'akan' ? wanted : langs[0]);
    if (!langs.includes(lang)) langs.push(lang);

    const items = await buildAuditItems(user, lang, sources.driveFiles, sources.pendingNames);
    const audit = await audits.get(user);
    const known = new Set(items.map((i) => i.key));

    res.json({
      user,
      lang,
      langs: langs.sort(),
      items,
      summary: summarizeAudit(items),
      reviewed: (audit.reviewed || []).filter((k) => known.has(k)),
      adminReviewed: (audit.adminReviewed || []).filter((k) => known.has(k)),
      edits: Object.fromEntries(Object.entries(audit.edits || {}).filter(([k]) => known.has(k))),
      signedOffAt: audit.signedOffAt || null,
    });
  } catch (err) {
    console.error('GET /api/my-audit error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/my-audit/reviewed', requireContributor, async (req, res) => {
  try {
    const { key, reviewed } = req.body || {};
    if (typeof key !== 'string' || !/^[A-Za-z0-9]+:(question|options):(akan|ewe)$/.test(key)) {
      return res.status(400).json({ error: 'Invalid item key' });
    }
    await audits.setReviewed(req.contributor, key, Boolean(reviewed));
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/my-audit/reviewed error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Transcript corrections. `text: null` restores the original wording.
const ITEM_KEY_RE = /^[A-Za-z0-9]+:(question|options):(akan|ewe)$/;
const MAX_EDIT_LENGTH = 5000;

function validEdit(key, text) {
  if (typeof key !== 'string' || !ITEM_KEY_RE.test(key)) return 'Invalid item key';
  if (text !== null && typeof text !== 'string') return 'Invalid text';
  if (text && text.length > MAX_EDIT_LENGTH) return 'That text is too long';
  return null;
}

app.post('/api/my-audit/edit', requireContributor, async (req, res) => {
  try {
    const { key, text } = req.body || {};
    const problem = validEdit(key, text);
    if (problem) return res.status(400).json({ error: problem });
    await audits.setEdit(req.contributor, key, text);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/my-audit/edit error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/my-audit/signoff', requireContributor, async (req, res) => {
  try {
    const user = req.contributor;
    let sources;
    try {
      sources = await loadAuditSources(user);
    } catch (driveErr) {
      return res.status(502).json({ error: 'Could not reach Google Drive right now, so the sign-off cannot be checked. Please try again later.' });
    }

    const summary = { total: 0, recorded: 0, pending: 0, missing: 0, byLang: {} };
    const assignedLang = (userManager.getUser(user) || {}).language || null;
    const signoffLangs = assignedLang ? [assignedLang] : recordedLangs(sources.driveFiles, sources.pendingNames);
    for (const lang of signoffLangs) {
      const items = await buildAuditItems(user, lang, sources.driveFiles, sources.pendingNames);
      const s = summarizeAudit(items);
      summary.byLang[lang] = s;
      summary.total += s.total;
      summary.recorded += s.recorded;
      summary.pending += s.pending;
      summary.missing += s.missing;
    }

    if (summary.missing > 0 && !(req.body && req.body.acknowledgeMissing)) {
      return res.status(409).json({
        error: `${summary.missing} item(s) have no recording yet.`,
        summary,
      });
    }

    const saved = await audits.signOff(user, summary);
    res.json({ success: true, signedOffAt: saved.signedOffAt, summary });
  } catch (err) {
    console.error('POST /api/my-audit/signoff error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/my-audit/reopen', requireContributor, async (req, res) => {
  try {
    await audits.reopen(req.contributor);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin review marks, saved on the server and shown to contributors (Protected)
app.get('/api/admin/reviews', requireAdminAuth, async (_req, res) => {
  try {
    res.json({ reviews: await audits.listAdminReviewed() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reviews', requireAdminAuth, async (req, res) => {
  try {
    const { user, key, reviewed } = req.body || {};
    if (typeof user !== 'string' || !user.trim()) return res.status(400).json({ error: 'Invalid user' });
    if (typeof key !== 'string' || !/^[A-Za-z0-9]+:(question|options):(akan|ewe)$/.test(key)) {
      return res.status(400).json({ error: 'Invalid item key' });
    }
    await audits.setAdminReviewed(user, key, Boolean(reviewed));
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/admin/reviews error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Transcript corrections made by contributors (and admins), keyed by contributor (Protected)
app.get('/api/admin/edits', requireAdminAuth, async (_req, res) => {
  try {
    res.json({ edits: await audits.listEdits() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/edits', requireAdminAuth, async (req, res) => {
  try {
    const { user, key, text } = req.body || {};
    if (typeof user !== 'string' || !user.trim()) return res.status(400).json({ error: 'Invalid user' });
    const problem = validEdit(key, text);
    if (problem) return res.status(400).json({ error: problem });
    await audits.setEdit(user, key, text);
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/admin/edits error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Which contributors have signed off their audit (Protected)
app.get('/api/admin/audits', requireAdminAuth, async (_req, res) => {
  try {
    res.json(await audits.listAll());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Questionnaire items with no recording yet, for every contributor who has started (Protected).
// Covers each language the contributor has recorded in; contributors with no recordings are left out.
app.get('/api/admin/missing', requireAdminAuth, async (_req, res) => {
  try {
    const { recordings } = await listAllRecordings();
    const pending = await pendingUploads.listNames();

    const byUser = new Map();
    const entry = (user) => {
      const k = user.toLowerCase();
      if (!byUser.has(k)) byUser.set(k, { user, files: new Map(), pending: new Set(), langs: new Set() });
      return byUser.get(k);
    };

    for (const r of recordings) {
      if (r.isPractice || r.user === 'default_user') continue;
      const e = entry(r.user);
      e.files.set(r.name.trim().toLowerCase(), r);
      e.langs.add(r.lang);
    }
    for (const p of pending) {
      if (p.practice) continue;
      const e = entry(p.username);
      e.pending.add(p.filename.toLowerCase());
      e.langs.add(parseAudioFilename(p.filename, p.username).lang);
    }

    const items = [];
    for (const e of byUser.values()) {
      for (const lang of [...e.langs].sort()) {
        let questions;
        try { questions = await getQuestions(lang); } catch (_) { continue; }
        for (const q of questions) {
          const tracks = [['question', q.text || '']];
          if (Array.isArray(q.options) && q.options.length > 0) tracks.push(['options', q.options.join('\n')]);
          for (const [track, text] of tracks) {
            const prefixes = getAudioPrefixes(q.id, track, lang);
            if (findDriveFile(e.files, prefixes)) continue;
            items.push({
              user: e.user,
              lang,
              questionId: q.id,
              track,
              status: matchesPendingName(e.pending, prefixes) ? 'pending' : 'missing',
              name: `${q.id}_${track}_${lang}.wav`,
              text,
            });
          }
        }
      }
    }
    res.json({ total: items.length, items });
  } catch (err) {
    console.error('GET /api/admin/missing error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Recordings waiting in Postgres because Drive was unavailable (Protected)
app.get('/api/admin/pending-uploads', requireAdminAuth, async (_req, res) => {
  try {
    res.json(await pendingUploads.summary());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/pending-uploads/retry', requireAdminAuth, async (_req, res) => {
  try {
    await processPendingUploads();
    res.json(await pendingUploads.summary());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin Overview: Statistics moved here, breakdown by user and language (Protected)
app.get('/api/admin/overview', requireAdminAuth, async (req, res) => {
  try {
    let akanQuestions = [];
    let eweQuestions = [];
    try { akanQuestions = await getQuestions('akan'); } catch (_) {}
    try { eweQuestions = await getQuestions('ewe'); } catch (_) {}

    const { recordings, users } = await listAllRecordings();

    // Calculate per-user stats
    let auditMap = {};
    try { auditMap = await audits.listAll(); } catch (_) {}

    const userStats = users.map((u) => {
      const uRecs = recordings.filter((r) => r.user === u && !r.isPractice);
      const uAkan = uRecs.filter((r) => r.lang === 'akan');
      const uEwe = uRecs.filter((r) => r.lang === 'ewe');
      const qTracks = uRecs.filter((r) => r.targetType === 'question').length;
      const optTracks = uRecs.filter((r) => r.targetType === 'options').length;

      const regUser = userManager.getUser(u);
      return {
        user: u,
        totalRecordings: uRecs.length,
        akanCount: uAkan.length,
        eweCount: uEwe.length,
        questionTracks: qTracks,
        optionsTracks: optTracks,
        practiceCompleted: regUser ? Boolean(regUser.practiceCompleted) : true,
        practiceApproved: regUser ? Boolean(regUser.practiceApproved) : true,
        practiceApprovedAt: regUser ? regUser.practiceApprovedAt : null,
        language: regUser ? regUser.language : null,
        auditSignedOffAt: (auditMap[u.toLowerCase()] || {}).signedOffAt || null,
        lastActive: uRecs.length > 0 ? uRecs[uRecs.length - 1].createdTime : (regUser ? regUser.lastActive : null),
      };
    });

    const nonPracticeRecs = recordings.filter(r => !r.isPractice);

    res.json({
      questionnaire: {
        akanTotal: akanQuestions.length,
        eweTotal: eweQuestions.length,
      },
      totalRecordings: nonPracticeRecs.length,
      totalPracticeRecordings: recordings.length - nonPracticeRecs.length,
      users: userStats,
      userList: users,
    });
  } catch (err) {
    console.error('GET /api/admin/overview error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin Recordings List: Filterable by user, language, track, and search (Protected)
app.get('/api/admin/recordings', requireAdminAuth, async (req, res) => {
  try {
    const { user, lang, track, search, practice } = req.query;
    const { recordings } = await listAllRecordings();

    let filtered = recordings;

    if (user && user !== 'all') {
      filtered = filtered.filter(r => r.user.toLowerCase() === user.toLowerCase());
    }
    if (lang && lang !== 'all') {
      filtered = filtered.filter(r => r.lang.toLowerCase() === lang.toLowerCase());
    }
    if (track && track !== 'all') {
      filtered = filtered.filter(r => r.targetType.toLowerCase() === track.toLowerCase());
    }
    if (practice !== 'true') {
      // By default hide practice takes unless explicitly asked
      filtered = filtered.filter(r => !r.isPractice);
    }
    if (search) {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter(r =>
        r.name.toLowerCase().includes(q) ||
        r.questionId.toLowerCase().includes(q) ||
        r.user.toLowerCase().includes(q)
      );
    }

    res.json({
      total: filtered.length,
      recordings: filtered,
    });
  } catch (err) {
    console.error('GET /api/admin/recordings error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Admin Export Spreadsheet (CSV) (Protected)
// Exports audio recordings and question transcripts for user(s) as a spreadsheet.
// Five required columns: audio file name, prompt id, language, audio file, transcript
// ---------------------------------------------------------------------------
app.get('/api/admin/export', requireAdminAuth, async (req, res) => {
  try {
    const { user, lang, practice } = req.query;

    // 1. Preload question mappings for Akan and Ewe
    let akanQuestions = [];
    let eweQuestions = [];
    try { akanQuestions = await getQuestions('akan'); } catch (e) {
      console.warn('Export: Could not load Akan questions:', e.message);
    }
    try { eweQuestions = await getQuestions('ewe'); } catch (e) {
      console.warn('Export: Could not load Ewe questions:', e.message);
    }

    const akanMap = new Map();
    akanQuestions.forEach((q) => {
      if (q && q.id) {
        akanMap.set(q.id.trim().toLowerCase(), q);
      }
    });

    const eweMap = new Map();
    eweQuestions.forEach((q) => {
      if (q && q.id) {
        eweMap.set(q.id.trim().toLowerCase(), q);
      }
    });

    // 2. Fetch all recordings
    const { recordings } = await listAllRecordings();

    let filtered = recordings;

    // Filter by user if specified
    if (user && user !== 'all') {
      filtered = filtered.filter((r) => r.user.toLowerCase() === user.toLowerCase());
    }

    // Filter by language if specified
    if (lang && lang !== 'all') {
      filtered = filtered.filter((r) => r.lang.toLowerCase() === lang.toLowerCase());
    }

    // Practice filter: default exclude unless practice=true
    if (practice !== 'true') {
      filtered = filtered.filter((r) => !r.isPractice);
    }

    // Sort cleanly by contributor, then by recording filename
    filtered.sort((a, b) => {
      if (a.user.toLowerCase() !== b.user.toLowerCase()) {
        return a.user.localeCompare(b.user);
      }
      return a.name.localeCompare(b.name);
    });

    // 3. Helper to escape CSV cell according to RFC 4180
    function escapeCsvCell(cell) {
      if (cell === null || cell === undefined) return '';
      const str = String(cell);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }

    // Determine host for stream URL fallback
    const protocol = req.protocol || 'http';
    const host = req.get('host') || `localhost:${PORT}`;
    const baseUrl = `${protocol}://${host}`;

    // 4. Construct CSV header with exact five columns requested:
    // audio file name, prompt id, language, audio file, transcript
    const headerRow = [
      'audio file name',
      'prompt id',
      'language',
      'audio file',
      'transcript',
    ].map(escapeCsvCell).join(',');

    const dataRows = filtered.map((r) => {
      const audioFileName = r.name || '';
      const promptId = r.questionId || '';
      const languageDisplay = (r.lang || '').toLowerCase() === 'ewe' ? 'Ewe' : 'Akan';

      // Audio file link: prefer Drive webViewLink if available, or direct server streaming URL
      let audioFileLink = '';
      if (r.webViewLink) {
        audioFileLink = r.webViewLink;
      } else if (r.streamUrl) {
        audioFileLink = `${baseUrl}${r.streamUrl}`;
      }

      // Transcript lookup
      const isEwe = (r.lang || '').toLowerCase() === 'ewe';
      const qMap = isEwe ? eweMap : akanMap;
      const q = qMap.get((r.questionId || '').trim().toLowerCase());

      let transcript = '';
      if (r.targetType === 'options') {
        if (q && q.options && q.options.length > 0) {
          transcript = q.options.join('\n');
        } else if (q && q.text) {
          transcript = q.text;
        }
      } else if (r.targetType === 'practice') {
        transcript = q ? (q.text || (q.options ? q.options.join('\n') : '')) : 'Practice take';
      } else {
        // targetType === 'question' or default
        transcript = q ? q.text : '';
      }

      return [
        audioFileName,
        promptId,
        languageDisplay,
        audioFileLink,
        transcript,
      ].map(escapeCsvCell).join(',');
    });

    const csvContent = '\uFEFF' + [headerRow, ...dataRows].join('\r\n');

    const dateStr = new Date().toISOString().slice(0, 10);
    const downloadFilename = (user && user !== 'all')
      ? `recordings_${sanitizeUsername(user)}_${dateStr}.csv`
      : `recordings_all_${dateStr}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    return res.send(csvContent);
  } catch (err) {
    console.error('GET /api/admin/export error:', err);
    res.status(500).json({ error: 'Failed to generate export: ' + err.message });
  }
});

// Admin Delete Recording (Protected)
app.delete('/api/admin/recording', requireAdminAuth, async (req, res) => {
  try {
    const { user, filename, fileId } = req.body;
    const normUser = sanitizeUsername(user);

    let deletedFromDrive = false;
    let deletedFromDisk = false;

    if (fileId && !fileId.startsWith('local-')) {
      try {
        const drive = getDriveClient();
        await drive.files.delete({ fileId, supportsAllDrives: true });
        deletedFromDrive = true;
      } catch (dErr) {
        console.warn('Drive delete warning:', dErr.message);
      }
    }

    if (filename) {
      const userPath = path.join(UPLOADS_DIR, normUser, filename);
      const rootPath = path.join(UPLOADS_DIR, filename);
      if (fs.existsSync(userPath)) {
        fs.unlinkSync(userPath);
        deletedFromDisk = true;
      } else if (fs.existsSync(rootPath)) {
        fs.unlinkSync(rootPath);
        deletedFromDisk = true;
      }
    }

    res.json({ success: true, deletedFromDrive, deletedFromDisk, filename });
  } catch (err) {
    console.error('DELETE /api/admin/recording error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin Rename User (Protected)
app.post('/api/admin/rename-user', requireAdminAuth, async (req, res) => {
  try {
    const { oldUser, newUser } = req.body;
    const normOld = sanitizeUsername(oldUser);
    const normNew = sanitizeUsername(newUser);

    if (normOld === normNew) {
      return res.status(400).json({ error: 'New username must be different' });
    }

    try {
      userManager.renameUserInRegistry(normOld, normNew);
    } catch (_) {}

    // Rename local directory
    const oldDir = path.join(UPLOADS_DIR, normOld);
    const newDir = path.join(UPLOADS_DIR, normNew);
    if (fs.existsSync(oldDir)) {
      if (!fs.existsSync(newDir)) {
        fs.renameSync(oldDir, newDir);
      } else {
        const files = fs.readdirSync(oldDir);
        for (const f of files) {
          fs.renameSync(path.join(oldDir, f), path.join(newDir, f));
        }
        try { fs.rmdirSync(oldDir); } catch (_) {}
      }
    }

    // Rename Google Drive folder
    try {
      const drive = getDriveClient();
      const parentId = (DRIVE_FOLDER_ID || '').trim();
      const oldFolderName = `User_${normOld}`;
      const newFolderName = `User_${normNew}`;

      const resList = await drive.files.list({
        q: `'${parentId}' in parents and name = '${oldFolderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      if (resList.data.files && resList.data.files.length > 0) {
        await drive.files.update({
          fileId: resList.data.files[0].id,
          requestBody: { name: newFolderName },
          supportsAllDrives: true,
        });
        userDriveFolderCache.clear();
      }
    } catch (dErr) {
      console.warn('Drive rename warning:', dErr.message);
    }

    // Persist registry changes to cloud backup
    persistUsersToDrive().catch((e) => console.warn('Drive persist rename error:', e.message));

    res.json({ success: true, oldUser: normOld, newUser: normNew });
  } catch (err) {
    console.error('POST /api/admin/rename-user error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin Reset User PIN (Protected)
app.post('/api/admin/reset-user-pin', requireAdminAuth, (req, res) => {
  try {
    const { username, newPin } = req.body;
    userManager.resetUserPin(username, newPin);
    persistUsersToDrive().catch((e) => console.warn('Drive persist pin reset error:', e.message));
    res.json({ success: true, username });
  } catch (err) {
    console.error('POST /api/admin/reset-user-pin error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/assign-language', requireAdminAuth, (req, res) => {
  try {
    const { username, language } = req.body;
    if (!username) {
      return res.status(400).json({ error: 'Username is required.' });
    }
    if (language !== 'akan' && language !== 'ewe') {
      return res.status(400).json({ error: 'Assigned language must be Akan or Ewe.' });
    }
    const success = userManager.setUserLanguage(username, language);
    if (!success) {
      return res.status(404).json({ error: `User "${username}" not found in registry.` });
    }
    persistUsersToDrive().catch((e) => console.warn('Drive persist language assignment error:', e.message));
    res.json({ success: true, user: userManager.getUser(username) });
  } catch (err) {
    console.error('POST /api/admin/assign-language error:', err);
    res.status(400).json({ error: err.message });
  }
});

// Admin Create Contributor Account (Protected)
app.post('/api/admin/create-user', requireAdminAuth, (req, res) => {
  try {
    const { username, displayName, pin, language, autoApprove } = req.body;
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (!pin || String(pin).trim().length < 4) {
      return res.status(400).json({ error: 'PIN must be at least 4 digits or characters' });
    }
    if (language !== 'akan' && language !== 'ewe') {
      return res.status(400).json({ error: 'Assigned language must be Akan or Ewe.' });
    }

    const user = userManager.registerUser(username, displayName || username, pin, language);

    if (autoApprove) {
      userManager.setPracticeApproval(user.username, true, 'admin');
    }

    // Persist to Drive cloud registry in background
    persistUsersToDrive().catch((e) => console.warn('Drive persist create user error:', e.message));

    const fullUser = userManager.getUser(user.username);
    res.json({ success: true, user: fullUser });
  } catch (err) {
    console.error('POST /api/admin/create-user error:', err);
    res.status(400).json({ error: err.message });
  }
});

// Admin Approve / Greenlight Contributor for Recording (Protected)
app.post('/api/admin/approve-user', requireAdminAuth, (req, res) => {
  try {
    const { username, approved } = req.body;
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }
    const isApproved = approved !== false;
    const success = userManager.setPracticeApproval(username, isApproved, 'admin');
    if (!success) {
      return res.status(404).json({ error: `User "${username}" not found in registry.` });
    }
    persistUsersToDrive().catch((e) => console.warn('Drive persist approval error:', e.message));
    const user = userManager.getUser(username);
    res.json({ success: true, user });
  } catch (err) {
    console.error('POST /api/admin/approve-user error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Legacy status endpoint redirecting to overview summary
app.get('/api/status', async (req, res) => {
  try {
    const lang = (req.query.lang || 'akan').toLowerCase() === 'ewe' ? 'ewe' : 'akan';
    const questions = await getQuestions(lang);
    res.json({
      lang,
      total: questions.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`\n🎙️  DCS HCI Audio Collector running at http://localhost:${PORT}\n`);

  // 1. Initialize PostgreSQL persistence (Heroku Postgres)
  try {
    await userManager.initDatabase();
  } catch (dbErr) {
    console.warn(`⚠️  PostgreSQL initialization warning: ${dbErr.message}`);
  }

  // 2. Load Google OAuth credentials from database. The DB copy is the most recently
  // authorised one, so it overrides a possibly stale GOOGLE_REFRESH_TOKEN config var.
  try {
    const oauth2Client = getOAuth2Client();
    if (oauth2Client) {
      await loadTokensFromDb(oauth2Client);
    }
  } catch (_) {}

  // 3. Restore/reconcile contributor accounts from Google Drive on startup
  try {
    await restoreUsersFromDrive();
  } catch (err) {
    console.warn(`⚠️  Drive user restore warning: ${err.message}`);
  }

  // 4. Deliver any recordings that were held in Postgres while Drive was unavailable
  try {
    await pendingUploads.init();
    processPendingUploads();
    setInterval(processPendingUploads, 2 * 60 * 1000);
  } catch (err) {
    console.warn(`⚠️  Pending uploads init warning: ${err.message}`);
  }

  try {
    const akanQs = await getQuestions('akan');
    console.log(`✅ Loaded ${akanQs.length} questions for Akan`);
  } catch (err) {
    console.warn(`⚠️  Could not parse Akan questionnaire: ${err.message}`);
  }
  try {
    const eweQs = await getQuestions('ewe');
    console.log(`✅ Loaded ${eweQs.length} questions for Ewe`);
  } catch (err) {
    console.warn(`⚠️  Could not parse Ewe questionnaire: ${err.message}`);
  }
});
