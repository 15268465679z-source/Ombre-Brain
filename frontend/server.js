const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const LOGS_DIR = path.join(__dirname, 'public', 'logs');
const RELAYS_FILE = path.join(__dirname, 'relays.json');
const NETEASE_COOKIE_FILE = path.join(__dirname, 'netease_cookie.json');

// Max total upload storage: 512 MB
const MAX_STORAGE_BYTES = 512 * 1024 * 1024;
// Images older than 30 days get cleaned
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

[UPLOADS_DIR, LOGS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(UPLOADS_DIR));

/* ── image upload ── */
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, Date.now() + '_' + crypto.randomBytes(4).toString('hex') + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  }
});

app.post('/api/upload', upload.array('images', 10), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'no files' });
  const urls = req.files.map(f => `/uploads/${f.filename}`);
  res.json({ urls });
  runCleanup();
});

/* ── chat log save ── */
app.post('/api/save-log', (req, res) => {
  const { history, label } = req.body;
  if (!history?.length) return res.status(400).json({ error: 'empty' });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${ts}${label ? '_' + label.slice(0, 20).replace(/[^\w一-龥]/g, '') : ''}.json`;
  fs.writeFileSync(path.join(LOGS_DIR, name), JSON.stringify({ ts, history }, null, 2));
  res.json({ ok: true, name });
});

app.get('/api/logs', (req, res) => {
  const files = fs.readdirSync(LOGS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort().reverse()
    .map(f => {
      const stat = fs.statSync(path.join(LOGS_DIR, f));
      return { name: f, size: stat.size, mtime: stat.mtime };
    });
  res.json(files);
});

app.get('/api/logs/:name', (req, res) => {
  const fp = path.join(LOGS_DIR, path.basename(req.params.name));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'not found' });
  res.sendFile(fp);
});

/* ── relay stations (persistent) ── */
app.get('/api/relays', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(RELAYS_FILE, 'utf8'))); }
  catch { res.json([]); }
});

app.post('/api/relays', (req, res) => {
  const list = req.body;
  if (!Array.isArray(list)) return res.status(400).json({ error: 'expect array' });
  fs.writeFileSync(RELAYS_FILE, JSON.stringify(list, null, 2));
  res.json({ ok: true });
});

/* ── NetEase Music (proxy to NeteaseCloudMusicApi) ── */
// Expects NETEASE_API env var pointing to a running NeteaseCloudMusicApi instance
const NETEASE = (process.env.NETEASE_API || 'http://localhost:3001').replace(/\/$/, '');

function loadCookie() {
  try { return JSON.parse(fs.readFileSync(NETEASE_COOKIE_FILE, 'utf8')).cookie || ''; }
  catch { return ''; }
}
function saveCookie(cookie) {
  fs.writeFileSync(NETEASE_COOKIE_FILE, JSON.stringify({ cookie }));
}

app.get('/api/netease/qr/key', async (req, res) => {
  try {
    const r = await axios.get(`${NETEASE}/login/qr/key?timestamp=${Date.now()}`);
    res.json(r.data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/netease/qr/create', async (req, res) => {
  try {
    const { key } = req.query;
    const r = await axios.get(`${NETEASE}/login/qr/create?key=${key}&qrimg=true&timestamp=${Date.now()}`);
    res.json(r.data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/netease/qr/check', async (req, res) => {
  try {
    const { key } = req.query;
    const r = await axios.get(`${NETEASE}/login/qr/check?key=${key}&timestamp=${Date.now()}`);
    if (r.data.code === 803 && r.data.cookie) saveCookie(r.data.cookie);
    res.json(r.data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/netease/stream/:id', async (req, res) => {
  try {
    const cookie = loadCookie();
    const r = await axios.get(
      `${NETEASE}/song/url/v1?id=${req.params.id}&level=exhigh&cookie=${encodeURIComponent(cookie)}&timestamp=${Date.now()}`
    );
    const url = r.data?.data?.[0]?.url;
    if (!url) return res.status(404).json({ error: 'no url' });
    res.json({ url });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/netease/search', async (req, res) => {
  try {
    const cookie = loadCookie();
    const r = await axios.get(
      `${NETEASE}/search?keywords=${encodeURIComponent(req.query.q || '')}&limit=20&cookie=${encodeURIComponent(cookie)}`
    );
    res.json(r.data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/netease/loginstatus', async (req, res) => {
  const cookie = loadCookie();
  if (!cookie) return res.json({ loggedIn: false });
  try {
    const r = await axios.get(`${NETEASE}/login/status?cookie=${encodeURIComponent(cookie)}&timestamp=${Date.now()}`);
    const profile = r.data?.data?.profile;
    res.json({ loggedIn: !!profile, nickname: profile?.nickname, avatar: profile?.avatarUrl });
  } catch { res.json({ loggedIn: false }); }
});

/* ── cleanup ── */
function runCleanup() {
  const now = Date.now();
  let total = 0;
  const files = fs.readdirSync(UPLOADS_DIR)
    .map(f => {
      const fp = path.join(UPLOADS_DIR, f);
      const stat = fs.statSync(fp);
      return { fp, mtime: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => a.mtime - b.mtime);

  for (const f of files) {
    if (now - f.mtime > MAX_AGE_MS) { fs.unlinkSync(f.fp); continue; }
    total += f.size;
  }
  // If still over limit, delete oldest
  const remaining = files.filter(f => fs.existsSync(f.fp));
  let acc = remaining.reduce((s, f) => s + f.size, 0);
  for (const f of remaining) {
    if (acc <= MAX_STORAGE_BYTES) break;
    fs.unlinkSync(f.fp);
    acc -= f.size;
  }
}

runCleanup();
// Daily cleanup
setInterval(runCleanup, 24 * 60 * 60 * 1000);

app.listen(PORT, () => console.log(`月下前端服务 running on :${PORT}`));
