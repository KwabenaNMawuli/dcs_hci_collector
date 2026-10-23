# dcs_hci_collector
A simple tool for collecting audio data for questionnaires etc.

## Project structure

```
src/
  server.js            Express app, routes, Google Drive integration
  lib/
    users-manager.js   Contributor registry (Postgres, file fallback)
    audits.js          Contributor audit sign-off state
    pending-uploads.js Postgres holding area for recordings not yet on Drive
    questions-parser.js  Parses questionnaire .docx files
public/
  *.html               Pages (URLs unchanged: /, /admin, /login, /audit.html, ...)
  js/                  Page scripts, shared viewer-core and wav-encoder
    vendor/            Third-party bundles
  css/                 Stylesheets
data/                  Questionnaire .docx files and users.json fallback
```

Runtime files stay at the repo root and are git-ignored: `.env`, `tokens.json`, `uploads/`.

Run with `npm start` (or `npm run dev` for watch mode) from the repo root.
