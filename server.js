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
const { Readable } = require('stream');
const { google } = require('googleapis');
const { parseQuestions } = require('./questions-parser');

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

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

  res.json({
    configured: oauthConfigured,
    authenticated: isAuthenticated,
  });
});

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------
app.get('/api/questions', async (req, res) => {
  try {
    const lang = (req.query.lang || 'akan').toLowerCase() === 'ewe' ? 'ewe' : 'akan';
    const questions = await getQuestions(lang);

    let filesMap = new Map();
    try {
      filesMap = await listDriveFiles();
    } catch (driveErr) {
      // Drive might not be connected yet
    }

    let fullyRecordedCount = 0;
    let partialCount = 0;
    let unrecordedCount = 0;

    const enriched = questions.map((q) => {
      const qPrefixes = getAudioPrefixes(q.id, 'question', lang);
      const optsPrefixes = getAudioPrefixes(q.id, 'options', lang);

      const qFile = findDriveFile(filesMap, qPrefixes);
      const optsFile = findDriveFile(filesMap, optsPrefixes);

      const hasOptions = Array.isArray(q.options) && q.options.length > 0;
      const hasQuestionAudio = !!qFile;
      const hasOptionsAudio = !!optsFile;

      // Fully recorded: if has options, both needed; if no options, question needed
      const isComplete = hasOptions ? (hasQuestionAudio && hasOptionsAudio) : hasQuestionAudio;
      // Partial: has at least one recorded track but not complete
      const isPartial = !isComplete && (hasQuestionAudio || hasOptionsAudio);

      if (isComplete) {
        fullyRecordedCount++;
      } else if (isPartial) {
        partialCount++;
      } else {
        unrecordedCount++;
      }

      return {
        ...q,
        lang,
        hasQuestionAudio,
        questionDriveLink: qFile ? qFile.webViewLink : null,
        hasOptionsAudio,
        optionsDriveLink: optsFile ? optsFile.webViewLink : null,
        hasPartial: isPartial,
        hasAudio: isComplete,
      };
    });

    res.json({
      lang,
      questions: enriched,
      stats: {
        total: questions.length,
        recorded: fullyRecordedCount,
        partial: partialCount,
        missing: unrecordedCount,
        totalDriveFiles: filesMap.size,
      },
    });
  } catch (err) {
    console.error('GET /api/questions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Warm-up practice set: a spread of questions across the questionnaire, no Drive involved.
// Pass ?ids=C1,P2,... to get the same questions in another language.
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
      // one random question from each of `count` equal slices, so the set spans the whole form
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

app.post('/api/upload',upload.single('audio'), async (req, res) => {
  try {
    const { questionId, targetType, lang, replace } = req.body;
    // targetType: 'question' | 'options'
    // lang: 'akan' | 'ewe'

    if (!questionId) {
      return res.status(400).json({ error: 'questionId is required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const normLang = (lang || 'akan').toLowerCase() === 'ewe' ? 'ewe' : 'akan';
    const typeSuffix = targetType === 'options' ? '_options' : '_question';

    const mimeToExt = {
      'audio/webm': '.webm',
      'audio/mp4': '.m4a',
      'audio/mpeg': '.mp3',
      'audio/wav': '.wav',
      'audio/ogg': '.ogg',
      'audio/x-m4a': '.m4a',
    };
    const ext = mimeToExt[req.file.mimetype] || '.webm';
    // Audio file qualified with ewe or akan
    const filename = `${questionId}${typeSuffix}_${normLang}${ext}`;

    // 1. Save local backup
    const localPath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(localPath, req.file.buffer);

    // 2. Upload to Google Drive
    const drive = getDriveClient();
    const cleanFolderId = (DRIVE_FOLDER_ID || '').trim();

    if (!cleanFolderId) {
      return res.status(500).json({ error: 'DRIVE_FOLDER_ID is not configured in .env' });
    }

    // If replace=true, delete old file matching this target and language
    if (replace === 'true') {
      try {
        const existingMap = await listDriveFiles();
        const prefixes = getAudioPrefixes(questionId, targetType, normLang);
        const existing = findDriveFile(existingMap, prefixes);
        if (existing) {
          await drive.files.delete({ fileId: existing.fileId });
        }
      } catch (delErr) {
        console.warn('Could not delete old file:', delErr.message);
      }
    }

    const bufferStream = new Readable();
    bufferStream.push(req.file.buffer);
    bufferStream.push(null);

    const driveRes = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [cleanFolderId],
        mimeType: req.file.mimetype,
      },
      media: {
        mimeType: req.file.mimetype,
        body: bufferStream,
      },
      fields: 'id, name, webViewLink',
    });

    res.json({
      success: true,
      fileId: driveRes.data.id,
      filename: driveRes.data.name,
      lang: normLang,
      targetType: targetType || 'question',
      webViewLink: driveRes.data.webViewLink,
    });
  } catch (err) {
    console.error('POST /api/upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Practice takes — kept in a separate "practice" sub-folder (local and Drive) so they
// can never be mistaken for, or overwrite, real recordings.
// ---------------------------------------------------------------------------
const PRACTICE_DIR = path.join(UPLOADS_DIR, 'practice');
let practiceDriveFolderId = null;

async function getPracticeDriveFolder(drive, parentId) {
  if (practiceDriveFolderId) return practiceDriveFolderId;

  const found = await drive.files.list({
    q: `'${parentId}' in parents and name = 'practice' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
  });
  if (found.data.files.length) {
    practiceDriveFolderId = found.data.files[0].id;
  } else {
    const created = await drive.files.create({
      requestBody: { name: 'practice', parents: [parentId], mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id',
    });
    practiceDriveFolderId = created.data.id;
  }
  return practiceDriveFolderId;
}

app.post('/api/practice-upload', upload.single('audio'), async (req, res) => {
  try {
    const { questionId, lang } = req.body;
    if (!questionId || !/^[A-Za-z0-9]+$/.test(questionId)) {
      return res.status(400).json({ error: 'A valid questionId is required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const normLang = (lang || 'akan').toLowerCase() === 'ewe' ? 'ewe' : 'akan';
    const ext = path.extname(req.file.originalname || '') || '.webm';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `practice_${questionId}_${normLang}_${stamp}${ext}`;

    fs.mkdirSync(PRACTICE_DIR, { recursive: true });
    fs.writeFileSync(path.join(PRACTICE_DIR, filename), req.file.buffer);

    const parentId = (DRIVE_FOLDER_ID || '').trim();
    if (!parentId) {
      return res.status(500).json({ error: 'DRIVE_FOLDER_ID is not configured in .env' });
    }

    const drive = getDriveClient();
    const folderId = await getPracticeDriveFolder(drive, parentId);

    const bufferStream = new Readable();
    bufferStream.push(req.file.buffer);
    bufferStream.push(null);

    const driveRes = await drive.files.create({
      requestBody: { name: filename, parents: [folderId], mimeType: req.file.mimetype },
      media: { mimeType: req.file.mimetype, body: bufferStream },
      fields: 'id, name',
    });

    res.json({ success: true, filename: driveRes.data.name });
  } catch (err) {
    console.error('POST /api/practice-upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const lang = (req.query.lang || 'akan').toLowerCase() === 'ewe' ? 'ewe' : 'akan';
    const questions = await getQuestions(lang);
    let filesMap = new Map();
    try {
      filesMap = await listDriveFiles();
    } catch (_) {}

    let fullyRecorded = 0;
    let partial = 0;
    for (const q of questions) {
      const qPrefixes = getAudioPrefixes(q.id, 'question', lang);
      const optsPrefixes = getAudioPrefixes(q.id, 'options', lang);

      const qFile = findDriveFile(filesMap, qPrefixes);
      const optsFile = findDriveFile(filesMap, optsPrefixes);
      const hasOptions = Array.isArray(q.options) && q.options.length > 0;

      const complete = hasOptions ? (!!qFile && !!optsFile) : !!qFile;
      if (complete) {
        fullyRecorded++;
      } else if (qFile || optsFile) {
        partial++;
      }
    }

    res.json({
      lang,
      total: questions.length,
      recorded: fullyRecorded,
      partial,
      missing: questions.length - fullyRecorded - partial,
      totalDriveFiles: filesMap.size,
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
