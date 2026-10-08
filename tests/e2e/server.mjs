// Local stand-in for Supabase, for end-to-end tests of the CRM:
//   /rest/v1/*  → proxied to a real PostgREST (running against the migrated test database)
//   /auth/v1/*  → minimal fake GoTrue: password login for users in USERS, JWTs signed with JWT_SECRET
//   everything else → static files from the repo root (config.js is replaced to point here)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const PORT = Number(process.env.PORT || 8787);
const PGRST = process.env.PGRST_URL || 'http://127.0.0.1:3300';
const SECRET = process.env.JWT_SECRET;
export const USERS = JSON.parse(process.env.E2E_USERS || '[]'); // [{id,email,password}]
const ANON = sign({ role: 'anon', iss: 'e2e' });

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function sign(payload) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload }));
  return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
}
function userFromAuth(req) {
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
  try { return USERS.find((u) => u.id === JSON.parse(Buffer.from(tok.split('.')[1], 'base64url')).sub); } catch { return null; }
}
const userJson = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email,
  app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });

// Same Content-Security-Policy production gets from netlify.toml, so the tests catch anything it would block.
const CSP = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8').match(/Content-Security-Policy = "([^"]+)"/)[1];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
    return res.end();
  }
  if (url.pathname.startsWith('/auth/v1/')) {
    const route = url.pathname.slice(9);
    if (route === 'token' && url.searchParams.get('grant_type') === 'password') {
      const { email, password } = JSON.parse(await body(req));
      const u = USERS.find((x) => x.email === email && x.password === password);
      if (!u) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 400, msg: 'Invalid login credentials' });
      return send(res, 200, { access_token: sign({ sub: u.id, role: 'authenticated', aud: 'authenticated', email: u.email }),
        token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r-' + u.id, user: userJson(u) });
    }
    if (route === 'user') { const u = userFromAuth(req); return u ? send(res, 200, userJson(u)) : send(res, 401, { msg: 'no user' }); }
    if (route === 'logout') { res.writeHead(204); return res.end(); }
    if (route === 'recover') return send(res, 200, {});
    return send(res, 404, { msg: 'not implemented: ' + route });
  }
  if (url.pathname.startsWith('/rest/v1/')) {
    const headers = { ...req.headers };
    delete headers.host;
    if (!headers.authorization || headers.authorization === `Bearer ${process.env.ANON_KEY_PLACEHOLDER}`) headers.authorization = `Bearer ${ANON}`;
    // Like Supabase's gateway: an apikey in the query string authenticates the request and is not passed on.
    if (url.searchParams.has('apikey')) {
      if (!headers.authorization) headers.authorization = `Bearer ${url.searchParams.get('apikey')}`;
      url.searchParams.delete('apikey');
    }
    const upstream = await fetch(PGRST + url.pathname.slice(8) + url.search, {
      method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : await body(req),
    });
    res.writeHead(upstream.status, { 'access-control-allow-origin': '*', 'content-type': upstream.headers.get('content-type') || 'application/json',
      ...(upstream.headers.get('content-range') ? { 'content-range': upstream.headers.get('content-range') } : {}) });
    return res.end(Buffer.from(await upstream.arrayBuffer()));
  }
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end(`window.CRM_CONFIG = { supabaseUrl: 'http://localhost:${PORT}', supabaseAnonKey: '${process.env.ANON_KEY_PLACEHOLDER}' };`);
  }
  const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-security-policy': CSP });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`e2e server on http://localhost:${PORT}`));
