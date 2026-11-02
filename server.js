'use strict';
// Golf Swing Coach — single-service Express app.
// NOTE: never log process.env.GEMINI_API_KEY.
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

const PORT = parseInt(process.env.PORT || '8787', 10);
const MAX_MB = parseInt(process.env.MAX_UPLOAD_MB || '100', 10);
const MODEL_CHAIN = (process.env.GEMINI_MODEL
  ? [process.env.GEMINI_MODEL]
  : ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash']);
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PROBLEMS = {
  slice: 'Slice (ball curves strongly left-to-right for a right-hander)',
  hook: 'Hook (ball curves strongly right-to-left for a right-hander)',
  topping: 'Topping / thinning the ball',
  fat: 'Fat shots (hitting the ground before the ball)',
  distance: 'Lack of distance',
  other: 'Not sure / other',
};
const ALLOWED_EXT = ['.mp4', '.mov', '.webm', '.m4v'];
const MIME_BY_EXT = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

const hasKey = () => !!(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

app.get('/api/status', (req, res) => {
  res.json({ configured: hasKey(), maxUploadMb: MAX_MB, model: MODEL_CHAIN[0] });
});
app.get('/healthz', (req, res) => res.send('ok'));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.mp4';
      cb(null, crypto.randomUUID() + ext);
    },
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 2, fields: 10 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const okMime = /^video\/(mp4|quicktime|webm|x-m4v)$/.test(file.mimetype || '');
    if (okMime || ALLOWED_EXT.includes(ext)) return cb(null, true);
    const err = new Error(`"${file.originalname}" isn't a supported video. Please use MP4, MOV or WebM.`);
    err.code = 'BAD_TYPE';
    cb(err);
  },
}).fields([{ name: 'faceOn', maxCount: 1 }, { name: 'downTheLine', maxCount: 1 }]);

// ---- jobs (polling avoids proxy/tunnel timeouts on long analyses) ----
const jobs = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, j] of jobs) if (j.created < cutoff) jobs.delete(id);
}, 10 * 60 * 1000).unref();

function safeUnlink(p) { if (p) fs.promises.unlink(p).catch(() => {}); }

app.post('/api/analyze', (req, res) => {
  if (!hasKey()) {
    return res.status(503).json({ error: 'not_configured', message: "The swing coach isn't configured yet — the server has no Gemini API key. Please ask the site owner to set GEMINI_API_KEY." });
  }
  upload(req, res, (err) => {
    const files = req.files || {};
    const cleanupLocal = () => Object.values(files).flat().forEach(f => safeUnlink(f.path));
    if (err) {
      cleanupLocal();
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'too_large', message: `One of the videos is larger than ${MAX_MB} MB. Try trimming it to just the swing (5–10 seconds) or recording at a lower resolution.` });
      if (err.code === 'BAD_TYPE') return res.status(415).json({ error: 'bad_type', message: err.message });
      return res.status(400).json({ error: 'upload_failed', message: 'Upload failed: ' + err.message });
    }
    const faceOn = files.faceOn && files.faceOn[0];
    const dtl = files.downTheLine && files.downTheLine[0];
    const problemKey = String(req.body.problem || '');
    const otherText = String(req.body.otherText || '').slice(0, 500).trim();
    if (!faceOn || !dtl) {
      cleanupLocal();
      return res.status(400).json({ error: 'missing_video', message: 'Please add both videos: face-on and down-the-line.' });
    }
    if (!PROBLEMS[problemKey]) {
      cleanupLocal();
      return res.status(400).json({ error: 'missing_problem', message: "Please choose what your main problem is." });
    }
    if (faceOn.size < 1000 || dtl.size < 1000) {
      cleanupLocal();
      return res.status(400).json({ error: 'unreadable', message: 'One of the videos looks empty or corrupted. Please record it again.' });
    }
    const id = crypto.randomUUID();
    const job = { id, created: Date.now(), status: 'running', stage: 'Uploading videos to the coach…', html: null, error: null };
    jobs.set(id, job);
    runAnalysis(job, { faceOn, dtl, problemKey, otherText })
      .catch(e => { job.status = 'error'; job.error = friendlyError(e); console.error(`[job ${id.slice(0, 8)}] failed:`, scrub(e && e.message)); })
      .finally(cleanupLocal);
    res.status(202).json({ jobId: id });
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ status: 'error', error: 'That analysis has expired. Please submit again.' });
  res.json({ status: j.status, stage: j.stage, html: j.html, error: j.error, model: j.model });
});

function scrub(s) {
  s = String(s || '');
  const k = process.env.GEMINI_API_KEY;
  if (k) s = s.split(k).join('[redacted]');
  return s.replace(/key=[A-Za-z0-9_\-]+/g, 'key=[redacted]');
}

function friendlyError(e) {
  const msg = scrub(e && e.message);
  if (e && e.friendly) return e.friendly;
  if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED|401|403/i.test(msg)) return "The coach's Gemini API key was rejected. Please ask the site owner to check GEMINI_API_KEY.";
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) return 'The coach is busy right now (rate limit reached). Please try again in a minute.';
  if (/FAILED|unsupported|could not process|invalid.*video|INVALID_ARGUMENT/i.test(msg)) return "We couldn't read one of the videos. Please re-record (MP4/MOV, 5–15 seconds, whole body in frame) and try again.";
  return 'Something went wrong analysing your swing. Please try again in a moment.';
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runAnalysis(job, { faceOn, dtl, problemKey, otherText }) {
  const { GoogleGenAI, createUserContent, createPartFromUri } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const uploaded = [];
  try {
    const mimeOf = (f) => {
      const ext = path.extname(f.originalname || f.filename).toLowerCase();
      if (/^video\/(mp4|quicktime|webm)$/.test(f.mimetype)) return f.mimetype;
      return MIME_BY_EXT[ext] || 'video/mp4';
    };
    for (const [label, f] of [['face-on', faceOn], ['down-the-line', dtl]]) {
      job.stage = `Uploading ${label} video…`;
      const up = await ai.files.upload({ file: f.path, config: { mimeType: mimeOf(f), displayName: `swing-${label}` } });
      uploaded.push(up);
    }
    job.stage = 'Processing videos…';
    const deadline = Date.now() + 5 * 60 * 1000;
    for (let i = 0; i < uploaded.length; i++) {
      let f = uploaded[i];
      while (f.state === 'PROCESSING' || f.state === 'STATE_UNSPECIFIED' || !f.state) {
        if (Date.now() > deadline) { const e = new Error('timeout'); e.friendly = 'Processing the videos took too long. Try shorter clips (5–10 seconds).'; throw e; }
        await sleep(2500);
        f = await ai.files.get({ name: f.name });
      }
      if (f.state !== 'ACTIVE') {
        const e = new Error('file state ' + f.state);
        e.friendly = `We couldn't read the ${i === 0 ? 'face-on' : 'down-the-line'} video. Please re-record it (MP4/MOV, whole body in frame) and try again.`;
        throw e;
      }
      uploaded[i] = f;
    }
    job.stage = 'Coach is watching your swing…';
    const problem = PROBLEMS[problemKey] + (otherText ? ` — golfer's description: "${otherText}"` : '');
    const contents = createUserContent([
      'VIDEO 1 — ANGLE 1: FACE-ON (camera facing the golfer, perpendicular to the target line):',
      createPartFromUri(uploaded[0].uri, uploaded[0].mimeType),
      'VIDEO 2 — ANGLE 2: DOWN-THE-LINE (camera behind the golfer looking along the target line):',
      createPartFromUri(uploaded[1].uri, uploaded[1].mimeType),
      buildPrompt(problem),
    ]);
    let lastErr;
    for (const model of MODEL_CHAIN) {
      try {
        const resp = await ai.models.generateContent({ model, contents, config: { systemInstruction: SYSTEM_PROMPT } });
        const text = (resp && resp.text) || '';
        if (!text.trim()) throw Object.assign(new Error('empty response'), { friendly: "The coach couldn't produce a report for these videos. Please make sure the whole swing is visible and try again." });
        job.html = renderMarkdown(text);
        job.model = model;
        job.status = 'done';
        job.stage = 'Done';
        console.log(`[job ${job.id.slice(0, 8)}] done with ${model}`);
        return;
      } catch (e) {
        lastErr = e;
        const m = String(e && e.message);
        if (/404|NOT_FOUND|not found|not supported for generateContent|limiting access/i.test(m) && MODEL_CHAIN.length > 1) {
          console.warn(`[job ${job.id.slice(0, 8)}] model ${model} unavailable, trying next`);
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  } finally {
    for (const f of uploaded) {
      try { await ai.files.delete({ name: f.name }); } catch (_) { /* expires in 48h anyway */ }
    }
  }
}

function renderMarkdown(md) {
  md = md.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/m, '$1');
  const html = marked.parse(md, { gfm: true, breaks: false });
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'h3', 'h4', 'hr']),
    allowedAttributes: { a: ['href', 'title'], th: ['align'], td: ['align'] },
  });
}

const SYSTEM_PROMPT = `You are an experienced PGA-qualified golf teaching professional and swing analyst. You coach amateurs of all levels with a warm, encouraging, plain-English style, and you are precise about cause and effect: ball-flight laws (club path vs. face angle, low point control, strike location, speed leaks). You only describe what you can actually see in the videos; if something is not visible (e.g. grip hidden, camera angle wrong, clip cut off), say so honestly instead of guessing. You never invent facts about the golfer.`;

function buildPrompt(problem) {
  return `The golfer's stated main problem: **${problem}**.

Watch BOTH videos carefully, frame by frame where needed (Video 1 = face-on, Video 2 = down-the-line). First determine whether the golfer is right- or left-handed and adapt all directions accordingly. If a video does not actually show a golf swing, or the angle seems swapped, mention it briefly and analyse what you can.

Write the report in Markdown using EXACTLY these sections and headings:

## 🏌️ Summary
2–4 sentences: what is happening in the swing and how it produces the stated miss (or, if "not sure", the most likely miss based on what you see).

## 🎥 Angle 1 — Face-on
A bullet for each phase: **Setup**, **Grip**, **Alignment/Ball position**, **Takeaway**, **Top of backswing**, **Transition**, **Impact**, **Follow-through**. For each: what you see (✅ good / ⚠️ fault), and how it links to the stated miss. Keep each bullet to 1–2 sentences. If a phase isn't visible from this angle, say "Not clearly visible from this angle."

## 🎥 Angle 2 — Down-the-line
Same phase bullets as above, from this angle (posture, spine angle, club plane, path, early extension, etc.).

## 🎯 Root cause
One short paragraph naming the single underlying cause that best explains the miss, and the chain of cause → effect (e.g. "open face at the top → ... → slice").

## 🛠️ Drills
2–3 drills targeting the root cause. For each: a ### heading with the drill name, one line on **Why it helps**, then numbered **How to do it** steps (3–6 steps), and a **Reps:** line.

## ⭐ Fix this first
One clear priority, one sentence on what to feel, and one checkpoint the golfer can video to confirm progress.

Be specific, friendly and concise (about 500–900 words total). Avoid jargon unless you explain it. Do not wrap the answer in a code block.`;
}

// generic error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', scrub(err && err.message));
  res.status(500).json({ error: 'server', message: 'Unexpected server error.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Golf Swing Coach listening on http://localhost:${PORT} — Gemini key ${hasKey() ? 'present' : 'NOT set (app will show "not configured")'}; models: ${MODEL_CHAIN.join(' → ')}`);
});
