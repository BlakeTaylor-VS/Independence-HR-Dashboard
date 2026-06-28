require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

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
const SKIP_KEYWORDS = ['old employee', 'archive', 'template', 'test', 'contract', 'adp', 'competenc'];

// ── PERSISTENT CACHE ───────────────────────────────────────────
// Render has a /data disk — use it if available, otherwise use local
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, '.cache');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const CACHE_FILE = path.join(DATA_DIR, 'scan_cache.json');

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch(e) { console.error('Cache load error:', e.message); }
  return {};
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
  } catch(e) { console.error('Cache save error:', e.message); }
}

let scanCache = loadCache();
console.log('Loaded cache with', Object.keys(scanCache).length, 'entries');

// ── LIST ALL CLINICIAN FOLDERS ─────────────────────────────────
app.get('/api/clinicians', async (req, res) => {
  try {
    const drive = getDriveClient();
    let allFolders = [];
    let pageToken = null;
    do {
      const response = await drive.files.list({
        q: `mimeType = 'application/vnd.google-apps.folder' and '${MASTER_FOLDER_ID}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name)',
        pageSize: 100,
        pageToken: pageToken || undefined,
      });
      allFolders = allFolders.concat(response.data.files || []);
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    const clinicians = allFolders
      .filter(f => !SKIP_KEYWORDS.some(kw => f.name.toLowerCase().includes(kw)))
      .map(f => ({
        id: f.id,
        name: f.name,
        // Include cached data if available so frontend shows results immediately
        cachedData: scanCache[f.id] ? scanCache[f.id].data : null,
        lastScanned: scanCache[f.id] ? scanCache[f.id].scannedAt : null,
      }));

    res.json({ clinicians });
  } catch (err) {
    console.error('Clinicians error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── CHECK IF FOLDER HAS NEW FILES SINCE LAST SCAN ─────────────
app.get('/api/check/:folderId', async (req, res) => {
  try {
    const drive = getDriveClient();
    const { folderId } = req.params;

    const subRes = await drive.files.list({
      q: `mimeType = 'application/vnd.google-apps.folder' and '${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 10,
    });
    const hrFolder = (subRes.data.files || []).find(f => f.name.toLowerCase().includes('hr doc'));
    if (!hrFolder) return res.json({ hasChanges: false, reason: 'no_hr_folder' });

    const fileRes = await drive.files.list({
      q: `'${hrFolder.id}' in parents and trashed = false`,
      fields: 'files(id, modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 1,
    });
    const latestFile = (fileRes.data.files || [])[0];
    const latestModified = latestFile ? new Date(latestFile.modifiedTime).getTime() : 0;

    const cache = scanCache[folderId];
    if (!cache) return res.json({ hasChanges: true, reason: 'never_scanned', latestModified });

    const hasChanges = latestModified > cache.driveModifiedAt;
    res.json({ hasChanges, reason: hasChanges ? 'new_files' : 'up_to_date', latestModified, lastScanned: cache.scannedAt });
  } catch (err) {
    console.error('Check error:', err.message);
    res.status(500).json({ error: err.message, hasChanges: true });
  }
});

// ── SCAN A SINGLE CLINICIAN ────────────────────────────────────
app.get('/api/scan/:folderId', async (req, res) => {
  try {
    const drive = getDriveClient();
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { folderId } = req.params;

    const subRes = await drive.files.list({
      q: `mimeType = 'application/vnd.google-apps.folder' and '${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 10,
    });
    const hrFolder = (subRes.data.files || []).find(f => f.name.toLowerCase().includes('hr doc'));
    if (!hrFolder) {
      const result = { scanned: true, credentials: {}, note: 'No HR Docs folder found' };
      scanCache[folderId] = { scannedAt: Date.now(), driveModifiedAt: 0, data: result };
      saveCache(scanCache);
      return res.json(result);
    }

    let allFiles = [];
    let pageToken = null;
    do {
      const fileRes = await drive.files.list({
        q: `'${hrFolder.id}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
        pageSize: 30,
        pageToken: pageToken || undefined,
      });
      allFiles = allFiles.concat(fileRes.data.files || []);
      pageToken = fileRes.data.nextPageToken;
    } while (pageToken);

    if (!allFiles.length) {
      const result = { scanned: true, credentials: {}, note: 'Empty folder' };
      scanCache[folderId] = { scannedAt: Date.now(), driveModifiedAt: 0, data: result };
      saveCache(scanCache);
      return res.json(result);
    }

    const latestModified = Math.max(...allFiles.map(f => new Date(f.modifiedTime).getTime()));

    const fileContents = [];
    for (const file of allFiles) {
      if (file.mimeType === 'image/heic' || file.name.toLowerCase().endsWith('.heic')) {
        fileContents.push('FILE: ' + file.name + ' - HEIC unreadable');
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
          fileContents.push({ name: file.name, b64, mediaType });
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
    if (textFiles) msgContent.push({ type: 'text', text: 'Files:\n' + textFiles + '\n\n' });

    for (const bf of fileContents.filter(f => typeof f === 'object').slice(0, 8)) {
      msgContent.push({
        type: bf.mediaType === 'application/pdf' ? 'document' : 'image',
        source: { type: 'base64', media_type: bf.mediaType, data: bf.b64 }
      });
      msgContent.push({ type: 'text', text: '(File: ' + bf.name + ')\n' });
    }

    msgContent.push({
      type: 'text',
      text: 'Today: ' + today + '. Find expiration dates for these 9 credentials: Prof License, Driver License, Car Reg, Car Insurance, CPR, Liability Ins, Physical Exam, TB Clearance, Flu Vaccine. Rules: Physical Exam expires 1yr from exam date. TB expires 1yr from test date. Flu expires Oct 1 next year. W2 employees: Liability Ins is N/A. Return ONLY this JSON structure with no markdown:\n{"employmentType":"W2","credentials":{"Prof License":{"e":"2027-01-01","m":false,"na":false,"nt":""},"Driver License":{"e":null,"m":false,"na":false,"nt":""},"Car Reg":{"e":null,"m":false,"na":false,"nt":""},"Car Insurance":{"e":null,"m":false,"na":false,"nt":""},"CPR":{"e":null,"m":false,"na":false,"nt":""},"Liability Ins":{"e":null,"m":false,"na":false,"nt":""},"Physical Exam":{"e":null,"m":false,"na":false,"nt":""},"TB Clearance":{"e":null,"m":false,"na":false,"nt":""},"Flu Vaccine":{"e":null,"m":false,"na":false,"nt":""}}}'
    });

    const aiRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{ role: 'user', content: msgContent }],
    });

    const raw = (aiRes.content.find(b => b.type === 'text') || {}).text || '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    parsed.scanned = true;

    // Save to persistent cache
    scanCache[folderId] = { scannedAt: Date.now(), driveModifiedAt: latestModified, data: parsed };
    saveCache(scanCache);

    res.json(parsed);
  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: err.message, scanned: true });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('IHRD running on port ' + PORT));
