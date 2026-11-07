'use strict';
/*
 * Local preview with JARVIS working, no Vercel CLI needed.
 *
 *   1. Put your key in .env.local (never committed):   GEMINI_API_KEY=your-key
 *   2. node scripts/dev-server.js
 *   3. Open http://localhost:3000
 *
 * Serves the static site and routes /api/chat to api/chat.js, the same file
 * Vercel runs in production.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);

// Minimal .env.local loader: KEY=value lines, # comments.
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env.local: JARVIS will report it isn't configured */ }

const chat = require(path.join(ROOT, 'api', 'chat.js'));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.xml': 'application/xml', '.txt': 'text/plain', '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/chat') {
    return Promise.resolve(chat(req, res)).catch((err) => {
      console.error(err);
      if (!res.headersSent) { res.statusCode = 500; res.end('{"error":"server"}'); }
    });
  }
  let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT) || /[\\/]\.|[\\/](api|scripts)[\\/]/.test(file.slice(ROOT.length))) {
    res.statusCode = 404; return res.end('Not found');
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(fs.readFileSync(path.join(ROOT, '404.html')));
    }
    res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.end(data);
  });
}).listen(PORT, () => {
  console.log('Portfolio: http://localhost:' + PORT);
  console.log(process.env.GEMINI_API_KEY ? 'JARVIS: key loaded' : 'JARVIS: no GEMINI_API_KEY in .env.local, so it will say it is not configured');
});
