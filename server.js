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

// ── GOOGLE DRIVE AUTH ─────────────────────────────────────────
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

// ── CREDENTIAL RULES ──────────────────────────────────────────
const CREDENTIALS = [
  'Prof License', 'Driver License', 'Car Reg', 'Car Insurance',
  'CPR', 'Liability Ins', 'Physical Exam', 'TB Clearance', 'Flu Vaccine'
];

// ── LIST ALL CLINICIAN FOLDERS ────────────────────────────────
app.get('/api/clinicians', async (req, res) => {
  try {
    const drive = getDriveClient();
    const response = await drive.files.list({
      q: `mimeType = 'application/vnd.google-apps.folder' and parentId = '${MASTER_FOLDER_ID}' and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 100,
    });
    const clinicians = (response.data.files || []).map(f => ({
      id: f.id,
      name: f.name,
    }));
    res.json({ clinicians });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── SCAN A SINGLE CLINICIAN ───────────────────────────────────
app.get('/api/scan/:folderId', async (req, res) => {
  try {
    const drive = getDriveClient();
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { folderId } = req.params;

    // Step 1: find HR Docs subfolder
    const subRes = await drive.files.list({
      q: `mimeType = 'application/vnd.google-apps.folder' and parentId = '${folderId}' and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 5,
    });
    const hrFolder = (subRes.data.files || []).find(f =>
      f.name.toLowerCase().includes('hr doc')
    );
    if (!hrFolder) return res.json({ credentials: {}, note: 'No HR Docs folder found' });

    // Step 2: list all files in HR Docs (paginate)
    let allFiles = [];
    let pageToken = null;
    do {
      const fileRes = await drive.files.list({
        q: `parentId = '${hrFolder.id}' and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageSize: 30,
        pageToken: pageToken || undefined,
      });
      allFiles = allFiles.concat(fileRes.data.files || []);
      pageToken = fileRes.data.nextPageToken;
    } while (pageToken);

    if (!allFiles.length) return res.json({ credentials: {}, note: 'Empty folder' });

    // Step 3: download readable files and build content for AI
    const fileContents = [];
    for (const file of allFiles) {
      if (file.mimeType === 'image/heic' || file.name.toLowerCase().endsWith('.heic')) {
        fileContents.push(`FILE: ${file.name} — HEIC format, unreadable`);
        continue;
      }
      if (file.mimeType.startsWith('image/') || file.mimeType === 'application/pdf') {
        try {
          const dlRes = await drive.files.get(
            { fileId: file.id, alt: 'media' },
            { responseType: 'arraybuffer' }
          );
          const b64 = Buffer.from(dlRes.data).toString('base64');
          const mediaType = file.mimeType === 'application/pdf' ? 'application/pdf' : file.mimeType;
          fileContents.push({ type: 'file', name: file.name, b64, mediaType });
        } catch {
          fileContents.push(`FILE: ${file.name} — download failed`);
        }
      } else {
        fileContents.push(`FILE: ${file.name} (${file.mimeType})`);
      }
    }

    // Step 4: ask Claude to extract all credential dates
    const today = TODAY();
    const textFiles = fileContents.filter(f => typeof f === 'string').join('\n');
    const binaryFiles = fileContents.filter(f => typeof f === 'object');

    const msgContent = [];

    // Add text file list
    if (textFiles) msgContent.push({ type: 'text', text: `File listing:\n${textFiles}\n\n` });

    // Add readable images/PDFs (up to 8 to stay within limits)
    for (const bf of binaryFiles.slice(0, 8)) {
      msgContent.push({
        type: bf.mediaType === 'application/pdf' ? 'document' : 'image',
        source: { type: 'base64', media_type: bf.mediaType, data: bf.b64 }
      });
      msgContent.push({ type: 'text', text: `(Above file: ${bf.name})\n` });
    }

    msgContent.push({
      type: 'text',
      text: `Today is ${today}. Extract expiration dates for these credentials: Prof License, Driver License, Car Reg, Car Insurance, CPR, Liability Ins, Physical Exam, TB Clearance, Flu Vaccine.

Rules:
- Physical Exam: expires exactly 1 year from exam date
- TB Clearance: expires 1 year from collection date (if TB positive + chest X-ray, use X-ray date)
- Flu Vaccine: expires Oct 1 of the following year
- Liability Ins: mark na:true if clinician is W2
- HEIC files: mark as unreadable

Return ONLY valid JSON, no markdown, no explanation:
{
  "employmentType": "W2" or "1099" or "unknown",
  "credentials": {
    "Prof License": {"e": "YYYY-MM-DD" or null, "m": true if missing, "na": true if N/A, "nt": "note if any"},
    "Driver License": {...},
    "Car Reg": {...},
    "Car Insurance": {...},
    "CPR": {...},
    "Liability Ins": {...},
    "Physical Exam": {...},
    "TB Clearance": {...},
    "Flu Vaccine": {...}
  }
}`
    });

    const aiRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: msgContent }],
    });

    const raw = aiRes.content.find(b => b.type === 'text')?.text || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    res.json(parsed);
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── SEND EMAIL REMINDER ───────────────────────────────────────
app.post('/api/remind/email', async (req, res) => {
  // Placeholder — wire up SendGrid or similar when ready
  const { clinicianName, email, issues } = req.body;
  res.json({ sent: false, message: 'Email integration not yet configured. Add SENDGRID_API_KEY to env vars.' });
});

// ── SERVE DASHBOARD ───────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`IHRD running on port ${PORT}`));
