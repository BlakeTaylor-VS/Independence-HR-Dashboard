# Independence HR Dashboard (IHRD) 

Live credential tracking for Independence Health Contractors clinician roster.

## Stack
- **Frontend:** Vanilla HTML/JS (no build step)
- **Backend:** Node.js + Express
- **Drive:** Google Drive API (service account)
- **AI:** Anthropic Claude (credential extraction from documents)
- **Hosting:** Render (Web Service)

---

## Setup

### 1. Create GitHub Repo
Create `BlakeTaylor-VS/Independence-HR-Dashboard` (Private recommended).
Push this entire folder to `main`.

### 2. Create Google Service Account
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. APIs & Services → Enable **Google Drive API**
3. Credentials → Create Service Account
4. Download JSON key
5. Share your master HR folder with the service account email (Viewer access)

### 3. Deploy on Render
1. New → **Web Service** (NOT Static Site — needs Node backend)
2. Connect `BlakeTaylor-VS/Independence-HR-Dashboard`
3. **Build Command:** `npm install`
4. **Start Command:** `node server.js`
5. **Runtime:** Node

### 4. Add Environment Variables in Render
| Key | Value |
|---|---|
| `GOOGLE_CLIENT_EMAIL` | Service account email from JSON key |
| `GOOGLE_PRIVATE_KEY` | Private key from JSON key (full string with `\n`) |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |

### 5. Deploy
Push to `main` → Render auto-deploys. Done.

---

## How It Works

1. **Load roster** — on page open, fetches all clinician folders from Google Drive
2. **Scan** — per-clinician or full roster; downloads docs, sends to Claude AI, extracts expiration dates
3. **Dashboard** — live status, filter by expired/expiring/missing/compliant
4. **Signal** — "Copy Signal Message" generates a pre-written reminder for each clinician

## Refresh Workflow
- **Monday AM:** Open dashboard → Refresh All → message expired/expiring clinicians
- **New credential uploaded:** Click ⚡ Scan on that clinician row
- **New clinician added to Drive:** Refresh All picks them up automatically

---

## Master HR Folder ID
`1IWKAcsV53-zm7MQvVWJaqQBAiSeM_be1`
