/**
 * server.js
 * DCS HCI Audio Collector — Express backend with Google OAuth 2.0
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
const DOCX_PATH = process.env.DOCX_PATH;
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

// OAuth 2.0 Credentials
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth2callback`;

const TOKEN_PATH = path.join(__dirname, 'tokens.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure local backup folder exists
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
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are accepted'), false);
    }
  },
});

// ---------------------------------------------------------------------------
// Google OAuth 2.0 Client
// ---------------------------------------------------------------------------
function getOAuth2Client() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return null;
  }
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

function loadSavedTokens(oauth2Client) {
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      oauth2Client.setCredentials(tokens);
      return true;
    } catch (e) {
      console.warn('Error reading tokens.json:', e.message);
    }
  }
  return false;
}

function getDriveClient() {
  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) {
    throw new Error('Google OAuth Client ID & Secret are not configured in .env');
  }

  const hasTokens = loadSavedTokens(oauth2Client);
  if (!hasTokens) {
    throw new Error('Google account not connected. Please click "Connect Google Drive".');
  }

  // Handle auto-refresh token event
  oauth2Client.on('tokens', (tokens) => {
    try {
      const current = fs.existsSync(TOKEN_PATH) ? JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')) : {};
      const updated = { ...current, ...tokens };
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(updated, null, 2));
    } catch (err) {
      console.error('Failed to update tokens.json:', err.message);
    }
  });

  return google.drive({ version: 'v3', auth: oauth2Client });
}

// ---------------------------------------------------------------------------
// Questions Cache
// ---------------------------------------------------------------------------
let questionsCache = null;

async function getQuestions() {
  if (questionsCache) return questionsCache;
  if (!DOCX_PATH) {
    throw new Error('DOCX_PATH is not set in .env');
  }
  questionsCache = await parseQuestions(DOCX_PATH);
  return questionsCache;
}

// ---------------------------------------------------------------------------
// List Drive files in target folder
// ---------------------------------------------------------------------------
async function listDriveFiles() {
  const drive = getDriveClient();
  if (!DRIVE_FOLDER_ID) {
    throw new Error('DRIVE_FOLDER_ID is not set in .env');
  }

  const cleanFolderId = DRIVE_FOLDER_ID.trim();
  const filesMap = new Map();
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: `'${cleanFolderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, webViewLink, webContentLink)',
      pageSize: 1000,
      pageToken: pageToken || undefined,
    });

    for (const file of res.data.files) {
      filesMap.set(file.name, {
        fileId: file.id,
        webViewLink: file.webViewLink,
        webContentLink: file.webContentLink,
      });
    }

    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return filesMap;
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
    scope: ['https://www.googleapis.com/auth/drive.file'],
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
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    res.redirect('/?auth=success');
  } catch (err) {
    console.error('Error exchanging OAuth code:', err);
    res.status(500).send(`Authentication error: ${err.message}`);
  }
});

app.get('/api/auth-status', (req, res) => {
  const oauthConfigured = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
  const isAuthenticated = fs.existsSync(TOKEN_PATH);
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
    const questions = await getQuestions();

    let filesMap = new Map();
    try {
      filesMap = await listDriveFiles();
    } catch (driveErr) {
      // Drive might not be connected yet
    }

    const EXTS = ['.webm', '.mp3', '.wav', '.ogg', '.m4a'];
    const enriched = questions.map((q) => {
      let uploaded = null;
      for (const ext of EXTS) {
        const key = `${q.id}${ext}`;
        if (filesMap.has(key)) {
          uploaded = filesMap.get(key);
          break;
        }
      }

      return {
        ...q,
        hasAudio: !!uploaded,
        driveLink: uploaded ? uploaded.webViewLink : null,
      };
    });

    res.json({ questions: enriched });
  } catch (err) {
    console.error('GET /api/questions error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload', upload.single('audio'), async (req, res) => {
  try {
    const { questionId, replace } = req.body;

    if (!questionId) {
      return res.status(400).json({ error: 'questionId is required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const mimeToExt = {
      'audio/webm': '.webm',
      'audio/mp4': '.m4a',
      'audio/mpeg': '.mp3',
      'audio/wav': '.wav',
      'audio/ogg': '.ogg',
      'audio/x-m4a': '.m4a',
    };
    const ext = mimeToExt[req.file.mimetype] || '.webm';
    const filename = `${questionId}${ext}`;

    // 1. Always save a local copy in uploads/ as backup
    const localPath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(localPath, req.file.buffer);

    // 2. Upload to Google Drive via OAuth 2.0
    const drive = getDriveClient();
    const cleanFolderId = (DRIVE_FOLDER_ID || '').trim();

    if (!cleanFolderId) {
      return res.status(500).json({ error: 'DRIVE_FOLDER_ID is not configured in .env' });
    }

    // If replace=true, delete old file
    if (replace === 'true') {
      try {
        const existingMap = await listDriveFiles();
        const EXTS = ['.webm', '.mp3', '.wav', '.ogg', '.m4a'];
        for (const oldExt of EXTS) {
          const oldKey = `${questionId}${oldExt}`;
          if (existingMap.has(oldKey)) {
            await drive.files.delete({ fileId: existingMap.get(oldKey).fileId });
            break;
          }
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
      webViewLink: driveRes.data.webViewLink,
    });
  } catch (err) {
    console.error('POST /api/upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const questions = await getQuestions();
    let filesMap = new Map();
    try {
      filesMap = await listDriveFiles();
    } catch (_) {}

    const EXTS = ['.webm', '.mp3', '.wav', '.ogg', '.m4a'];
    let recorded = 0;
    for (const q of questions) {
      for (const ext of EXTS) {
        if (filesMap.has(`${q.id}${ext}`)) {
          recorded++;
          break;
        }
      }
    }

    res.json({ total: questions.length, recorded, missing: questions.length - recorded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`\n🎙️  DCS HCI Audio Collector running at http://localhost:${PORT}\n`);
  try {
    const qs = await getQuestions();
    console.log(`✅ Loaded ${qs.length} questions from questionnaire`);
  } catch (err) {
    console.warn(`⚠️  Could not parse questionnaire: ${err.message}`);
  }
});
