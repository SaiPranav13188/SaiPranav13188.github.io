'use strict';
/*
 * POST /api/chat  ->  streams JARVIS's answer back as plain text.
 *
 * Runs as a Vercel serverless function. The Gemini key lives only in the
 * GEMINI_API_KEY environment variable on Vercel, never in the page.
 *
 * Request:  { message, history: [{ role: 'user'|'assistant', text }], lang: 'en'|'hi'|'te', sessionId }
 * Response: text/plain stream of the answer, or JSON { error } with a status:
 *   503 not_configured  no key on the server
 *   429 rate_limited    this visitor asked too much this hour
 *   429 quota           every key/model is out of free quota
 *   502 upstream        Gemini failed for another reason
 */

const { SYSTEM } = require('./_knowledge');

const API_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
// Tried in order; when one is out of quota the next is used.
// gemini-2.5-* is closed to new API users (Nov 2026), so default to the 3.x line.
const MODELS = (process.env.GEMINI_MODEL || 'gemini-3.8-flash,gemini-3.5-flash-lite')
  .split(',').map((s) => s.trim()).filter(Boolean);

const ALLOWED_ORIGINS = [
  'https://saipranav13188.github.io',
  'https://saipranav-portfolio-ochre.vercel.app',
];

const MAX_MESSAGE = 800;
const MAX_HISTORY = 12;
const MAX_TURN_TEXT = 2000;
const PER_SESSION_PER_HOUR = Number(process.env.MAX_TURNS_PER_SESSION || 25);
const PER_IP_PER_HOUR = Number(process.env.MAX_TURNS_PER_IP_PER_HOUR || 60);
const HOUR = 60 * 60 * 1000;
const QUOTA_COOLDOWN = 15 * 60 * 1000;

const LANGUAGE = {
  en: 'Answer in English, whatever language the question is in.',
  hi: 'Answer in Hindi (Devanagari script), whatever language the question is in. Keep technical terms in English, e.g. "उसने एक multi-agent system बनाया".',
  te: 'Answer in Telugu (Telugu script), whatever language the question is in. Keep technical terms in English, e.g. "అతను ఒక multi-agent system build చేశాడు".',
};

/* ---------- Abuse / spend control ----------
   In-memory, so on serverless it is per instance and leaky: a speed bump,
   not a wall. Good enough for a portfolio; the real ceiling is the API
   key's own quota. */
const buckets = new Map();
function hit(key, limit) {
  const now = Date.now();
  if (buckets.size > 5000) for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
  const b = buckets.get(key);
  if (!b || now > b.reset) { buckets.set(key, { n: 1, reset: now + HOUR }); return true; }
  if (b.n >= limit) return false;
  b.n += 1;
  return true;
}

/* ---------- Keys ----------
   GEMINI_API_KEY may be a comma-separated list. A key+model pair that reports
   it is out of quota is skipped for 15 minutes. Note: Google charges quota per
   Cloud PROJECT, so spare keys only help if they come from different projects. */
const exhausted = new Map();
function keys() {
  return (process.env.GEMINI_API_KEY || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function thinkingFor(model) {
  if (/^gemini-(3|[4-9])/.test(model)) return { thinkingLevel: 'low' };
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 }; // fastest first token
  return undefined;
}

function cors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new Error('too large');
  }
  return JSON.parse(raw || '{}');
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'method' });
  if (keys().length === 0) return json(res, 503, { error: 'not_configured' });

  let body;
  try { body = await readBody(req); } catch { return json(res, 400, { error: 'bad_request' }); }

  const message = String(body.message || '').trim().slice(0, MAX_MESSAGE);
  const sessionId = String(body.sessionId || '').slice(0, 64);
  const lang = LANGUAGE[body.lang] ? body.lang : 'en';
  if (!message) return json(res, 400, { error: 'empty' });

  if (!hit('ip:' + clientIp(req), PER_IP_PER_HOUR) || (sessionId && !hit('s:' + sessionId, PER_SESSION_PER_HOUR))) {
    return json(res, 429, { error: 'rate_limited' });
  }

  const history = (Array.isArray(body.history) ? body.history : [])
    .slice(-MAX_HISTORY)
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && t.text)
    .map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(t.text).slice(0, MAX_TURN_TEXT) }] }));

  // The language instruction is repeated at the end of the visitor's own
  // message: a system prompt alone loses to the language the question is
  // typed in. Never shown, never stored.
  const contents = history.concat([{ role: 'user', parts: [{ text: message + '\n\n[' + LANGUAGE[lang] + ']' }] }]);

  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  let upstream = null;
  let sawQuota = false;
  for (const model of MODELS) {
    for (const key of keys()) {
      const id = key + '|' + model;
      if ((exhausted.get(id) || 0) > Date.now()) { sawQuota = true; continue; }
      const generationConfig = { maxOutputTokens: 900, temperature: 0.6 };
      const thinking = thinkingFor(model);
      if (thinking) generationConfig.thinkingConfig = thinking;
      const call = () => fetch(API_BASE + '/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM + '\n\n# Language for this turn\n' + LANGUAGE[lang] }] },
          contents,
          generationConfig,
        }),
        signal: controller.signal,
      });
      try {
        let r = await call();
        let detail = '';
        // A model that rejects the thinking setting is a hard 400, not
        // something ignored. Retry once without it rather than fail.
        if (r.status === 400 && generationConfig.thinkingConfig) {
          detail = await r.text().catch(() => '');
          if (/thinking/i.test(detail)) {
            delete generationConfig.thinkingConfig;
            r = await call();
            detail = '';
          }
        }
        if (r.ok && r.body) { upstream = r; break; }
        detail = detail || await r.text().catch(() => '');
        if (r.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(detail)) {
          exhausted.set(id, Date.now() + QUOTA_COOLDOWN);
          sawQuota = true;
        }
        console.warn('[jarvis] ' + model + ' -> ' + r.status + ' ' + detail.slice(0, 200));
      } catch (err) {
        if (controller.signal.aborted) return;
        console.warn('[jarvis] ' + model + ' failed: ' + err.message);
      }
    }
    if (upstream) break;
  }

  if (!upstream) return json(res, sawQuota ? 429 : 502, { error: sawQuota ? 'quota' : 'upstream' });

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  // Gemini streams Server-Sent Events: lines of "data: {json}". Forward only
  // the answer text; thought summaries (part.thought) are never shown.
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let wrote = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        let evt;
        try { evt = JSON.parse(line.slice(5)); } catch { continue; }
        const parts = (evt.candidates && evt.candidates[0] && evt.candidates[0].content && evt.candidates[0].content.parts) || [];
        for (const p of parts) {
          if (p.text && !p.thought) { res.write(p.text); wrote = true; }
        }
      }
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    console.warn('[jarvis] stream broke: ' + err.message);
  }
  if (!wrote) res.write("Sorry, I lost my train of thought there. Could you ask that again?");
  res.end();
};
