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

    let allFiles = [];
    let pageToken = null;
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
        fileContents.push('FILE: ' + file.name + ' - HEIC format, unreadable');
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
        } catch (e) {
          fileContents.push('FILE: ' + file.name + ' - download failed');
        }
      } else {
        fileContents.push('FILE: ' + file.name + ' (' + file.mimeType + ')');
      }
    }

    const today = new Date().toISOString().split('T')[0];
    const msgContent = [];
    const textFiles = fileContents.filter(f => typeof f === 'string').join('\n');
    if (textFiles) msgContent.push({ type: 'text', text: 'File listing:\n' + textFiles + '\n\n' });

    const binaryFiles = fileContents.filter(f => typeof f === 'object');
    for (const bf of binaryFiles.slice(0, 8)) {
      msgContent.push({
        type: bf.mediaType === 'application/pdf' ? 'document' : 'image',
        source: { type: 'base64', media_type: bf.mediaType, data: bf.b64 }
      });
      msgContent.push({ type: 'text', text: '(Above file: ' + bf.name + ')\n' });
    }

    msgContent.push({
      type: 'text',
      text: 'Today is ' + today + '. Extract expiration dates for: Prof License, Driver License, Car Reg, Car Insurance, CPR, Liability Ins, Physical Exam, TB Clearance, Flu Vaccine. Physical Exam expires 1 year from exam date. TB expires 1 year from collection date. Flu expires Oct 1 following year. Liability Ins: na:true if W2. HEIC: unreadable. Return ONLY valid JSON with no markdown: {"employmentType":"W2 or 1099 or unknown","credentials":{"Prof License":{"e":"YYYY-MM-DD or null","m":true,"na":true,"nt":"note"},"Driver License":{"e":null},"Car Reg":{"e":null},"Car Insurance":{"e":null},"CPR":{"e":null},"Liability Ins":{"e":null},"Physical Exam":{"e":null},"TB Clearance":{"e":null},"Flu Vaccine":{"e":null}}}'
    });

    const aiRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: msgContent }],
    });

    const raw = aiRes.content.find(b => b.type === 'text') ? aiRes.content.find(b => b.type === 'text').text : '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.json(parsed);
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('IHRD running on port ' + PORT));