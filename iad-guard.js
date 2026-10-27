// iad-guard.js — makes an Express app reachable ONLY through IAD.
// Drop this file into the app, then add near the top of server.js, BEFORE any routes or express.static:
//
//   app.set('trust proxy', 1);
//   app.use(require('./iad-guard')());
//
// Required env vars on the app (Render → Environment):
//   IAD_APP_KEY        e.g. IIT / IHRD / IID  (must match the short name in IAD → Links)
//   IAD_URL            e.g. https://admin.independencehealthc.com
//   IAD_PUBLIC_KEY     copy from IAD → Links → "Protected access setup"
//   IAD_COOKIE_SECRET  any random 32+ character string (unique per app)
// Optional:
//   IAD_PUBLIC_PATHS   comma-separated paths that must stay open for machine traffic,
//                      e.g. /healthz,/api/webhook   (never put pages with staff data here)
//   IAD_SESSION_HOURS  how long a pass lasts in this app before re-checking with IAD (default 4)
//
// Inside routes, the signed-in staff member is available as req.iadUser = { sub, name, username, role }.
// No dependencies beyond Node's built-in crypto (Node 16+).
const crypto = require('crypto');

module.exports = function iadGuard(opts = {}) {
  const appKey = String(opts.appKey || process.env.IAD_APP_KEY || '').toUpperCase();
  const iadUrl = String(opts.iadUrl || process.env.IAD_URL || '').replace(/\/+$/, '');
  const pubB64 = opts.publicKey || process.env.IAD_PUBLIC_KEY || '';
  const secret = opts.cookieSecret || process.env.IAD_COOKIE_SECRET || '';
  const hours = Number(opts.sessionHours || process.env.IAD_SESSION_HOURS || 4);
  const publicPaths = (opts.publicPaths || String(process.env.IAD_PUBLIC_PATHS || '').split(','))
    .map((s) => s.trim()).filter(Boolean);

  if (!appKey || !iadUrl || !pubB64 || secret.length < 32) {
    // Fail CLOSED: if misconfigured, nobody gets in rather than everybody.
    console.error('[iad-guard] Missing IAD_APP_KEY, IAD_URL, IAD_PUBLIC_KEY or IAD_COOKIE_SECRET (32+ chars). All requests will be blocked.');
    return (req, res) => res.status(503).send('This dashboard is locked: access configuration is incomplete.');
  }

  const pub = crypto.createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' });
  const COOKIE = 'iad_' + appKey.toLowerCase();
  const used = new Map(); // single-use passes: jti -> exp
  setInterval(() => { const n = Date.now() / 1000; for (const [k, e] of used) if (e < n) used.delete(k); }, 60000).unref();

  const hmac = (s) => crypto.createHmac('sha256', secret).update(s).digest('base64url');
  const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : '/');
  const isHttps = (req) => req.secure || req.headers['x-forwarded-proto'] === 'https';

  function verifyPass(token) {
    try {
      const [p, s] = String(token || '').split('.');
      if (!p || !s || !crypto.verify(null, Buffer.from(p), pub, Buffer.from(s, 'base64url'))) return null;
      const c = JSON.parse(Buffer.from(p, 'base64url').toString());
      const now = Date.now() / 1000;
      if (c.iss !== 'IAD' || c.aud !== appKey || !c.exp || c.exp < now || !c.jti || used.has(c.jti)) return null;
      used.set(c.jti, c.exp);
      return c;
    } catch { return null; }
  }

  function readCookie(req) {
    const m = String(req.headers.cookie || '').split(/;\s*/).find((x) => x.startsWith(COOKIE + '='));
    if (!m) return null;
    const [p, s] = m.slice(COOKIE.length + 1).split('.');
    if (!p || !s || !safeEq(s, hmac(p))) return null;
    try { const u = JSON.parse(Buffer.from(p, 'base64url').toString()); return u.exp > Date.now() / 1000 ? u : null; } catch { return null; }
  }

  function setCookie(req, res, value, maxAge) {
    const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (isHttps(req)) parts.push('Secure');
    const prev = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [].concat(prev || [], parts.join('; ')));
  }

  const loginUrl = (next) => `${iadUrl}/go/${encodeURIComponent(appKey)}${next && next !== '/' ? '?next=' + encodeURIComponent(next) : ''}`;

  return function guard(req, res, next) {
    const url = new URL(req.originalUrl || req.url, 'http://local');
    const p = url.pathname;

    if (publicPaths.some((x) => p === x || p.startsWith(x.replace(/\/?$/, '/')))) return next();

    if (p === '/iad-sso') {
      const c = verifyPass(url.searchParams.get('token'));
      if (!c) return res.status(401).send(`Access link expired or invalid. <a href="${loginUrl('/')}">Open through IAD</a>`);
      const body = Buffer.from(JSON.stringify({ sub: c.sub, name: c.name, username: c.username, role: c.role, exp: Math.floor(Date.now() / 1000) + hours * 3600 })).toString('base64url');
      setCookie(req, res, body + '.' + hmac(body), hours * 3600);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return res.redirect(303, safeNext(url.searchParams.get('next')));
    }

    if (p === '/iad-logout') { setCookie(req, res, '', 0); return res.redirect(303, iadUrl); }

    const user = readCookie(req);
    if (user) { req.iadUser = user; res.setHeader('X-Robots-Tag', 'noindex'); return next(); }

    const wantsHtml = req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
    if (wantsHtml) return res.redirect(302, loginUrl(req.originalUrl));
    res.status(401).json({ error: 'Sign in through IAD', login: loginUrl('/') });
  };
};
