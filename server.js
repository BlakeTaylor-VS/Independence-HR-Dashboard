require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  return google.drive({ version: 'v3', auth });
}

const MASTER_FOLDER_ID = '1IWKAcsV53-zm7MQvVWJaqQBAiSeM_be1';
const TODAY = () => new Date().toISOString().split('T')[0];

app.get('/api/clinicians', async (req, res) => {
  try {
    const drive = getDriveClient();
    const response = await drive.files.list({
      q: `mimeType = 'application/vnd.google-apps.folder' and '${MASTER_FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 100,
    });
    res.json({ clinicians: (response.data.files || []).map(f => ({ id: f.id, name: f.name })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scan/:folderId', async (req, res) => {
  try {
    const drive = getDriveClient();
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { folderId } = req.params;

    const subRes = await drive.files.list({
      q: `mimeType = 'application/vnd.google-apps.folder' and '${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 5,
    });
    const hrFolder = (subRes.data.files || []).find(f => f.name.toLowerCase().includes('hr doc'));
    if (!hrFolder) return res.json({ credentials: {}, note: 'No HR Docs folder found' });

    let allFiles = [], pageToken = null;
    do {
      const fileRes = await drive.files.list({
        q: `'${hrFolder.id}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageSize: 30,
        pageToken: pageToken || undefined,
      });
      allFiles = allFiles.concat(fileRes.data.files || []);
      pageToken = fileRes.data.nextPageToken;
    } while (pageToken);

    if (!allFiles.length) return res.json({ credentials: {}, note: 'Empty folder' });

    const fileContents = [];
    for (const file of allFiles) {
      if (file.mimeType === 'image/heic' || file.name.toLowerCase().endsWith('.heic')) {
        fileContents.push(`FILE: ${file.name} — HEIC format, unreadable`);
        continue;
      }
      if (file.mimeType.startsWith('image/') || file.mimeType === 'application/pdf') {
        try {
          const dlRes = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' });
          const b64 = Buffer.from(dlRes.data).toString('base64');
          fileContents.push({ type: 'file', name: file.name, b64, mediaType: file.mimeType === 'application/pdf' ? 'application/pdf' : file.mimeType });
        } catch { fileContents.push(`FILE: ${file.name} — download failed`); }
      } else {
        fileContents.push(`FILE: ${file.name} (${file.mimeType})`);
      }
    }

    const today = TODAY();
    const msgContent = [];