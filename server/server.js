const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns/promises');
const { isIP } = require('node:net');

const PORT = Number(process.env.PORT || 4173);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://meltex2345.github.io';
const IMPORTS = path.join(__dirname, 'imports');
fs.mkdirSync(IMPORTS, { recursive: true });
const requests = new Map();
const MAX_BYTES = 500 * 1024 * 1024;

function privateAddress(ip) {
  if (ip.includes(':')) return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:') || ip === '::';
  const n = ip.split('.').map(Number);
  return n[0] === 10 || n[0] === 127 || n[0] === 0 || n[0] >= 224 || (n[0] === 169 && n[1] === 254) || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && n[1] === 168);
}
async function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Enter a valid video URL.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Only public HTTP or HTTPS links are supported.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some(x => privateAddress(x.address))) throw new Error('That link does not point to a public internet address.');
  return u;
}
async function readBody(req) {
  let data = '';
  for await (const part of req) { data += part; if (data.length > 8192) throw new Error('Request too large.'); }
  return JSON.parse(data);
}
function allowedOrigin(origin) {
  if (!origin) return '';
  if (origin === 'null' || origin === ALLOWED_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return '';
}
function send(res, status, body, origin) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'vary': 'Origin' };
  const allowed = allowedOrigin(origin);
  if (allowed) headers['access-control-allow-origin'] = allowed;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}
function rateLimit(req) {
  const key = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = requests.get(key);
  if (!entry || now - entry.start > 60 * 60 * 1000) entry = { start: now, count: 0 };
  entry.count++;
  requests.set(key, entry);
  return entry.count <= 20;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'OPTIONS') {
      const allowed = allowedOrigin(origin);
      const headers = { 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', 'vary': 'Origin' };
      if (allowed) headers['access-control-allow-origin'] = allowed;
      res.writeHead(204, headers);
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, service: 'Clip Me link importer' }));
    }
    if (req.method === 'POST' && url.pathname === '/api/import') {
      if (!allowedOrigin(origin)) return send(res, 403, { error: 'This website is not allowed to use the import service.' }, origin);
      if (!rateLimit(req)) return send(res, 429, { error: 'Import limit reached for now. Try again later.' }, origin);
      const body = await readBody(req);
      let target = await validateUrl(body.url);
      let response;
      for (let i = 0; i < 6; i++) {
        response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'Clip Me/1.0 video link importer' } });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        if (!location) throw new Error('The video host returned an invalid redirect.');
        target = await validateUrl(new URL(location, target).href);
      }
      if (!response || !response.ok) throw new Error(`Could not fetch that link (${response?.status || 'request failed'}). Use a direct, public video file URL.`);
      const type = (response.headers.get('content-type') || '').split(';')[0].toLowerCase();
      if (!type.startsWith('video/') && !/\.(mp4|webm|mov|m4v|ogv)(?:$|[?#])/i.test(target.href)) throw new Error('This looks like a webpage, not a direct video file. Paste a public MP4, WebM, or MOV link.');
      if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('Videos must be 500 MB or smaller.');
      const ext = ({ 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/ogg': '.ogv' })[type] || path.extname(target.pathname).slice(0, 8) || '.video';
      const name = `import-${Date.now()}${ext}`;
      const dest = path.join(IMPORTS, name);
      let total = 0;
      const file = fs.createWriteStream(dest);
      try {
        for await (const chunk of response.body) {
          total += chunk.length;
          if (total > MAX_BYTES) throw new Error('Videos must be 500 MB or smaller.');
          if (!file.write(chunk)) await new Promise((resolve, reject) => { file.once('drain', resolve); file.once('error', reject); });
        }
        await new Promise((resolve, reject) => file.end(err => err ? reject(err) : resolve()));
      } catch (err) {
        file.destroy();
        fs.rmSync(dest, { force: true });
        throw err;
      }
      const allowed = allowedOrigin(origin);
      const headers = {
        'content-type': type.startsWith('video/') ? type : 'application/octet-stream',
        'content-length': total,
        'content-disposition': `attachment; filename="${name}"`,
        'vary': 'Origin'
      };
      if (allowed) headers['access-control-allow-origin'] = allowed;
      res.writeHead(200, headers);
      const stream = fs.createReadStream(dest);
      const cleanup = () => fs.rm(dest, { force: true }, () => {});
      stream.on('error', () => { cleanup(); res.destroy(); });
      res.on('close', cleanup);
      res.on('finish', cleanup);
      return stream.pipe(res);
    }
    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    if (!res.headersSent) send(res, 400, { error: err.message || 'Import failed.' }, origin);
    else res.destroy(err);
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`Clip Me importer listening on port ${PORT}`));
