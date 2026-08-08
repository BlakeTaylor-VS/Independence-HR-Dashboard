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
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4MB per file max
const MAX_FILES_TO_SEND = 6; // max files sent to Claude

// ── PERSISTENT CACHE ───────────────────────────────────────────
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, '.cache');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const CACHE_FILE = path.join(DATA_DIR, 'scan_cache.json');

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch(e) { console.error('Cache load error:', e.message); }
  return {};
}

function saveCache(cache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8'); }
  catch(e) { console.error('Cache save error:', e.message); }
}

let scanCache = loadCache();
console.log('Loaded cache with', Object.keys(scanCache).length, 'entries');
console.log('ENV CHECK - GOOGLE_CLIENT_EMAIL present:', !!process.env.GOOGLE_CLIENT_EMAIL);
console.log('ENV CHECK - GOOGLE_PRIVATE_KEY present:', !!process.env.GOOGLE_PRIVATE_KEY);
console.log('ENV CHECK - ANTHROPIC_API_KEY present:', !!process.env.ANTHROPIC_API_KEY);

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
  const { folderId } = req.params;
  console.log('=== SCAN START:', folderId);

  try {
    const drive = getDriveClient();
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Find HR Docs subfolder
    const subRes = await drive.files.list({
      q: `mimeType = 'application/vnd.google-apps.folder' and '${folderId}' in parents and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 10,
    });
    const hrFolder = (subRes.data.files || []).find(f => f.name.toLowerCase().includes('hr doc'));
    if (!hrFolder) {
      console.log('No HR Docs folder found');
      const result = { scanned: true, credentials: {}, note: 'No HR Docs folder found' };
      scanCache[folderId] = { scannedAt: Date.now(), driveModifiedAt: 0, data: result };
      saveCache(scanCache);
      return res.json(result);
    }

    // List files — include size so we can skip oversized ones
    let allFiles = [];
    let pageToken = null;
    do {
      const fileRes = await drive.files.list({
        q: `'${hrFolder.id}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, size)',
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

    // Filter to readable file types
    const candidates = allFiles.filter(f =>
      !f.name.toLowerCase().endsWith('.heic') &&
      f.mimeType !== 'image/heic' &&
      (f.mimeType.startsWith('image/') || f.mimeType === 'application/pdf')
    );

    const skippedHeic = allFiles.filter(f =>
      f.name.toLowerCase().endsWith('.heic') || f.mimeType === 'image/heic'
    ).map(f => f.name);

    const skippedLarge = candidates.filter(f => parseInt(f.size || 0) > MAX_FILE_BYTES).map(f => f.name);
    const readableFiles = candidates
      .filter(f => parseInt(f.size || 0) <= MAX_FILE_BYTES)
      .slice(0, MAX_FILES_TO_SEND);

    console.log('Files:', allFiles.length, '| Readable:', readableFiles.length, '| Skipped large:', skippedLarge.length, '| HEIC:', skippedHeic.length);

    const msgContent = [];

    // Note skipped files as text so Claude knows what's missing
    const skippedNotes = [
      ...skippedHeic.map(n => 'HEIC (unreadable): ' + n),
      ...skippedLarge.map(n => 'TOO LARGE to read: ' + n),
    ];
    if (skippedNotes.length) {
      msgContent.push({ type: 'text', text: 'Note — these files could not be read:\n' + skippedNotes.join('\n') + '\n\n' });
    }

    // Download each readable file one at a time, free memory immediately
    for (const file of readableFiles) {
      try {
        console.log('Downloading:', file.name, '(', Math.round(parseInt(file.size||0)/1024), 'KB)');
        const dlRes = await drive.files.get(
          { fileId: file.id, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        const b64 = Buffer.from(dlRes.data).toString('base64');
        dlRes.data = null; // free immediately

        msgContent.push({
          type: file.mimeType === 'application/pdf' ? 'document' : 'image',
          source: {
            type: 'base64',
            media_type: file.mimeType === 'application/pdf' ? 'application/pdf' : file.mimeType,
            data: b64
          }
        });
        msgContent.push({ type: 'text', text: '(File: ' + file.name + ')\n' });
        console.log('Added:', file.name);
      } catch (e) {
        console.error('Download failed:', file.name, e.message);
        msgContent.push({ type: 'text', text: 'FILE: ' + file.name + ' - download failed\n' });
      }
    }

    // If nothing readable at all, still return a scanned result
    if (msgContent.length === 0) {
      console.log('No readable files — returning empty scan');
      const result = { scanned: true, credentials: {}, note: 'No readable files found' };
      scanCache[folderId] = { scannedAt: Date.now(), driveModifiedAt: latestModified, data: result };
      saveCache(scanCache);
      return res.json(result);
    }

    const today = new Date().toISOString().split('T')[0];
    msgContent.push({
      type: 'text',
      text: 'Today: ' + today + '. You are reviewing HR documents for a home health therapy clinician. Extract expiration dates for these 9 credentials: Prof License, Driver License, Car Reg, Car Insurance, CPR, Liability Ins, Physical Exam, TB Clearance, Flu Vaccine.\n\nIMPORTANT RULES:\n- Documents may be photos of physical cards/papers — read them carefully regardless of image quality\n- Use the FILENAME as a strong hint for which credential each file contains\n- Prof License: look for license expiration on state therapy license (PT, PTA, OT, COTA, SLP)\n- Driver License: expiration date printed on the ID card\n- Car Reg: registration valid through date (DMV card)\n- Car Insurance: policy expiration date\n- CPR: card expiration or course completion date (expires 2 years from issue)\n- Liability Ins: malpractice/professional liability policy expiration (N/A for W2 employees)\n- Physical Exam: use exam/visit date + 1 year as expiration\n- TB Clearance: use test date + 1 year, or read clearance expiration directly\n- Flu Vaccine: expires Oct 1 of the following flu season year\n- W2 employees: set Liability Ins to na:true\n- If a document EXISTS but date is unclear: set e:null, m:false, explain briefly in nt\n- Only set m:true if NO document exists for that credential\n\nReturn ONLY this JSON, no other text:\n{"employmentType":"W2","credentials":{"Prof License":{"e":"2027-01-01","m":false,"na":false,"nt":""},"Driver License":{"e":null,"m":false,"na":false,"nt":""},"Car Reg":{"e":null,"m":false,"na":false,"nt":""},"Car Insurance":{"e":null,"m":false,"na":false,"nt":""},"CPR":{"e":null,"m":false,"na":false,"nt":""},"Liability Ins":{"e":null,"m":false,"na":false,"nt":""},"Physical Exam":{"e":null,"m":false,"na":false,"nt":""},"TB Clearance":{"e":null,"m":false,"na":false,"nt":""},"Flu Vaccine":{"e":null,"m":false,"na":false,"nt":""}}}'
    });

    console.log('Calling Claude with', readableFiles.length, 'files...');
    const aiRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: 'You are a JSON-only credential extraction API for a healthcare staffing company. Your job is to read HR documents — which may be photos, scanned images, or PDFs — and extract expiration dates. RULES: (1) Always respond with ONLY a valid JSON object, nothing else — no explanations, no markdown, no preamble. Start with { end with }. (2) Make your BEST GUESS from whatever is visible. If a document is a photo of a license, read the expiration date from the card even if the image quality is imperfect. (3) Only set m:true if there is truly NO document present for that credential at all. If a document exists but you cannot read the date clearly, set e:null and put a brief note in nt — do NOT set m:true. (4) For image files, look carefully at all text including small print, watermarks, and corners where expiration dates typically appear. (5) Use the filename as a strong hint — a file named "DriverLicense" contains the driver license credential. (6) If you can see a date anywhere on the document, use it. Partial dates are better than nothing.',
      messages: [{ role: 'user', content: msgContent }],
    });

    const raw = (aiRes.content.find(b => b.type === 'text') || {}).text || '{}';
    console.log('Raw AI response (first 300 chars):', raw.substring(0, 300));

    // Extract JSON object even if surrounded by commentary
    let clean = raw.replace(/```json|```/g, '').trim();
    const firstBrace = clean.indexOf('{');
    const lastBrace = clean.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      throw new Error('No JSON object found in AI response: ' + raw.substring(0, 200));
    }
    clean = clean.substring(firstBrace, lastBrace + 1);

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      console.error('JSON parse failed on extracted text:', clean.substring(0, 300));
      throw new Error('AI response was not valid JSON even after extraction: ' + parseErr.message);
    }
    parsed.scanned = true;

    scanCache[folderId] = { scannedAt: Date.now(), driveModifiedAt: latestModified, data: parsed };
    saveCache(scanCache);

    console.log('=== SCAN COMPLETE:', folderId);
    res.json(parsed);

  } catch (err) {
    console.error('=== SCAN FAILED:', folderId, err.message);
    res.status(500).json({ error: err.message, scanned: true });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('IHRD running on port ' + PORT));
