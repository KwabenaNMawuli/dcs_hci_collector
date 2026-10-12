/**
 * server.js
 * DCS HCI Audio Collector — Express backend with Google OAuth 2.0
 * Supports Akan and Ewe languages, with separate audio tracks for Question Prompts and Question Options.
 */

'use strict';

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const { google } = require('googleapis');
const { parseQuestions } = require('./questions-parser');
const userManager = require('./users-manager');

const PORT = process.env.PORT || 3000;

// Docx questionnaire paths for Akan and Ewe
const DOCX_PATH_AKAN =
  process.env.DOCX_PATH_AKAN ||
  process.env.DOCX_PATH ||
  path.join(__dirname, 'data', 'questionnaire.docx');

const DOCX_PATH_EWE =
  process.env.DOCX_PATH_EWE ||
  (fs.existsSync(path.join(__dirname, 'data', 'questionnaire-ewe.docx'))
    ? path.join(__dirname, 'data', 'questionnaire-ewe.docx')
    : path.join(__dirname, 'GH-MoMo-questionnaire-Ewe-draft (1).docx'));

const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

// OAuth 2.0 Credentials
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth2callback`;

const TOKEN_PATH = path.join(__dirname, 'tokens.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

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
app.use(express.static(path.join(__dirname, 'public')));

// Serve admin dashboard at /admin and /admin.html
app.get(['/admin', '/admin.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve admin login page at /login and /login.html
app.get(['/login', '/login.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve contributor sign-in page at /user-login and /user-login.html
app.get(['/user-login', '/user-login.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user-login.html'));
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
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are accepted'), false);
    }
  },
});

// ---------------------------------------------------------------------------
// Google OAuth 2.0 Client & Token Persistence
// ---------------------------------------------------------------------------
let cachedOAuth2Client = null;

function persistRefreshTokenToEnv(refreshToken) {
  try {
    const envPath = path.join(__dirname, '.env');
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

  // Ensure refresh_token is never wiped out when receiving refreshed access tokens
  const merged = {
    ...existing,
    ...newTokens,
    refresh_token: newTokens.refresh_token || existing.refresh_token || process.env.GOOGLE_REFRESH_TOKEN,
  };

  try {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write tokens.json:', err.message);
  }

  if (merged.refresh_token) {
    persistRefreshTokenToEnv(merged.refresh_token);
  }

  return merged;
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
const EXTS = ['.webm', '.mp3', '.wav', '.ogg', '.m4a'];

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
      'https://www.googleapis.com/auth/drive.file',
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

  const res = await drive.files.list({
    q: `'${parentId}' in parents and name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
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
    const count = Math.min(Math.max(parseInt(req.query.count, 10) || 15, 1), 30);
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

// Main upload route — saves in per-user folder as MP3
app.post('/api/upload', upload.single('audio'), async (req, res) => {
  try {
    const { questionId, targetType, lang, replace, user } = req.body;
    const authUser = getAuthenticatedContributor(req);
    const normUser = userManager.sanitizeUsername(authUser || user);

    if (!normUser || normUser === 'default_user') {
      return res.status(401).json({ error: 'Please sign in with your contributor account before uploading.' });
    }

    if (!questionId) {
      return res.status(400).json({ error: 'questionId is required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const normLang = (lang || 'akan').toLowerCase() === 'ewe' ? 'ewe' : 'akan';
    const typeSuffix = targetType === 'options' ? '_options' : '_question';

    // MP3 is standard format; fallback to original extension if needed
    const ext = (req.file.mimetype.includes('mpeg') || req.file.mimetype.includes('mp3'))
      ? '.mp3'
      : (path.extname(req.file.originalname || '') || '.mp3');

    const filename = `${questionId}${typeSuffix}_${normLang}${ext}`;

    // 1. Save local backup in user folder
    const userDir = path.join(UPLOADS_DIR, normUser);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    const localPath = path.join(userDir, filename);
    fs.writeFileSync(localPath, req.file.buffer);

    // 2. Upload to Google Drive inside user's designated folder
    const drive = getDriveClient();
    const cleanFolderId = (DRIVE_FOLDER_ID || '').trim();

    if (!cleanFolderId) {
      return res.status(500).json({ error: 'DRIVE_FOLDER_ID is not configured in .env' });
    }

    const userFolderId = await getUserDriveFolder(drive, cleanFolderId, normUser);

    // If replace=true, delete old file matching this question/track in this user's folder
    if (replace === 'true') {
      try {
        const prefixes = getAudioPrefixes(questionId, targetType, normLang);
        const existingInUserFolder = await drive.files.list({
          q: `'${userFolderId}' in parents and trashed = false`,
          fields: 'files(id, name)',
          pageSize: 100,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });

        if (existingInUserFolder.data.files) {
          for (const f of existingInUserFolder.data.files) {
            const fn = f.name.toLowerCase();
            if (prefixes.some(p => fn.startsWith(p.toLowerCase()))) {
              await drive.files.delete({ fileId: f.id, supportsAllDrives: true });
            }
          }
        }
      } catch (delErr) {
        console.warn('Could not delete old file in user folder:', delErr.message);
      }
    }

    const bufferStream = new Readable();
    bufferStream.push(req.file.buffer);
    bufferStream.push(null);

    const driveRes = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [userFolderId],
        mimeType: req.file.mimetype || 'audio/mpeg',
      },
      media: {
        mimeType: req.file.mimetype || 'audio/mpeg',
        body: bufferStream,
      },
      fields: 'id, name, webViewLink',
      supportsAllDrives: true,
    });

    res.json({
      success: true,
      fileId: driveRes.data.id,
      filename: driveRes.data.name,
      user: normUser,
      lang: normLang,
      targetType: targetType || 'question',
      webViewLink: driveRes.data.webViewLink,
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

    if (!questionId || !/^[A-Za-z0-9]+$/.test(questionId)) {
      return res.status(400).json({ error: 'A valid questionId is required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const normLang = (lang || 'akan').toLowerCase() === 'ewe' ? 'ewe' : 'akan';
    const ext = (req.file.mimetype.includes('mpeg') || req.file.mimetype.includes('mp3'))
      ? '.mp3'
      : (path.extname(req.file.originalname || '') || '.mp3');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `practice_${questionId}_${normLang}_${stamp}${ext}`;

    // 1. Save local backup in user's practice folder
    const userPracticeDir = path.join(UPLOADS_DIR, normUser, 'practice');
    fs.mkdirSync(userPracticeDir, { recursive: true });
    fs.writeFileSync(path.join(userPracticeDir, filename), req.file.buffer);

    // 2. Upload to Drive inside user's practice folder
    const parentId = (DRIVE_FOLDER_ID || '').trim();
    if (!parentId) {
      return res.status(500).json({ error: 'DRIVE_FOLDER_ID is not configured in .env' });
    }

    const drive = getDriveClient();
    const userFolderId = await getUserDriveFolder(drive, parentId, normUser);
    const practiceFolderId = await getUserPracticeDriveFolder(drive, userFolderId);

    const bufferStream = new Readable();
    bufferStream.push(req.file.buffer);
    bufferStream.push(null);

    const driveRes = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [practiceFolderId],
        mimeType: req.file.mimetype || 'audio/mpeg',
      },
      media: {
        mimeType: req.file.mimetype || 'audio/mpeg',
        body: bufferStream,
      },
      fields: 'id, name',
      supportsAllDrives: true,
    });

    res.json({ success: true, filename: driveRes.data.name, user: normUser });
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
    const envPath = path.join(__dirname, '.env');
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

    const mime = filename.endsWith('.mp3') ? 'audio/mpeg' : 'audio/webm';

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

// Admin Overview: Statistics moved here, breakdown by user and language (Protected)
app.get('/api/admin/overview', requireAdminAuth, async (req, res) => {
  try {
    let akanQuestions = [];
    let eweQuestions = [];
    try { akanQuestions = await getQuestions('akan'); } catch (_) {}
    try { eweQuestions = await getQuestions('ewe'); } catch (_) {}

    const { recordings, users } = await listAllRecordings();

    // Calculate per-user stats
    const userStats = users.map((u) => {
      const uRecs = recordings.filter((r) => r.user === u && !r.isPractice);
      const uAkan = uRecs.filter((r) => r.lang === 'akan');
      const uEwe = uRecs.filter((r) => r.lang === 'ewe');
      const qTracks = uRecs.filter((r) => r.targetType === 'question').length;
      const optTracks = uRecs.filter((r) => r.targetType === 'options').length;

      return {
        user: u,
        totalRecordings: uRecs.length,
        akanCount: uAkan.length,
        eweCount: uEwe.length,
        questionTracks: qTracks,
        optionsTracks: optTracks,
        lastActive: uRecs.length > 0 ? uRecs[uRecs.length - 1].createdTime : null,
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
    res.json({ success: true, username });
  } catch (err) {
    console.error('POST /api/admin/reset-user-pin error:', err);
    res.status(400).json({ error: err.message });
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

