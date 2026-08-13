// server.js — Booking Rate Watch dashboard backend (local, 127.0.0.1)
const express = require('express');
const fs = require('fs');
const path = require('path');
const core = require('./ratewatch-core.js');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');
const SECRETS_FILE = path.join(ROOT, 'secrets.local.json');
const HISTORY_FILE = path.join(ROOT, 'rates-history.jsonl');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(ROOT, { index: 'dashboard.html' }));

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; } };
const writeJson = (f, obj) => { fs.writeFileSync(f, JSON.stringify(obj, null, 2)); };
const cfg = () => readJson(CONFIG_FILE, { city: 'Miami Beach', country: 'us', offsetDays: 1, nights: 1, adults: 2, myProperty: '', competitors: [] });
const secrets = () => readJson(SECRETS_FILE, { gmailUser: '', gmailAppPass: '', emailTo: '' });
const history = (n = 100) => {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).slice(-n).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
};

// single shared browser for suggest/run (warm session = faster + fewer challenges)
let sharedBrowser = null;
async function getBrowser() {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    sharedBrowser = await core.launchBrowser(true);
  }
  return sharedBrowser;
}

// ---- config API ----
app.get('/api/config', (req, res) => {
  const c = cfg(); const s = secrets();
  // merge non-secret email state; never echo the real app password
  res.json({
    config: { ...c, gmailUser: s.gmailUser, gmailAppPass: s.gmailAppPass ? 'set' : '', emailTo: s.emailTo },
    emailConfigured: !!(s.gmailUser && s.gmailAppPass && s.emailTo),
    hasSecretsFile: fs.existsSync(SECRETS_FILE),
  });
});

app.post('/api/config', (req, res) => {
  const cur = cfg();
  const next = { ...cur, ...req.body };
  // normalize lists
  next.competitors = (next.competitors || []).map(s => String(s).trim()).filter(Boolean);
  next.myProperty = String(next.myProperty || '').trim();
  next.city = String(next.city || '').trim();
  next.country = String(next.country || 'us').trim().toLowerCase();
  next.offsetDays = Math.max(0, parseInt(next.offsetDays, 10) || 0);
  next.nights = Math.max(1, Math.min(14, parseInt(next.nights, 10) || 1));
  next.adults = Math.max(1, Math.min(10, parseInt(next.adults, 10) || 2));
  next.currency = String(next.currency || 'USD').toUpperCase();
  next.mobile = next.mobile !== false;
  next.stealth = next.stealth !== false;
  writeJson(CONFIG_FILE, next);
  res.json({ ok: true, config: next });
});

app.post('/api/secrets', (req, res) => {
  const cur = secrets();
  const next = { ...cur, ...req.body };
  for (const k of ['gmailUser', 'gmailAppPass', 'emailTo']) next[k] = String(next[k] || '').trim();
  writeJson(SECRETS_FILE, next);
  res.json({ ok: true, emailConfigured: !!(next.gmailUser && next.gmailAppPass && next.emailTo) });
});

// ---- test email ----
app.post('/api/test-email', async (req, res) => {
  try {
    const s = secrets();
    const c = cfg();
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: s.gmailUser, pass: s.gmailAppPass } });
    await t.sendMail({ from: `"Rate Watch" <${s.gmailUser}>`, to: s.emailTo, subject: 'Rate Watch — test email', text: `Test OK. Dashboard configured for ${c.city}, ${c.nights} night(s), ${c.adults} adults, mobile=${c.mobile}.` });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---- run scrape ----
let running = false;
app.post('/api/run', async (req, res) => {
  if (running) return res.status(409).json({ ok: false, error: 'already running' });
  running = true;
  try {
    const c = cfg();
    const r = await core.scrape(c, { mobile: c.mobile !== false, stealth: c.stealth !== false });
    // build report
    const found = {}, notFound = [];
    for (const t of [c.myProperty, ...(c.competitors || [])]) {
      const hit = r.hotels.find(h => core.inName(h.name, t));
      if (hit) found[t] = hit; else notFound.push(t);
    }
    const mine = found[c.myProperty];
    const comps = Object.entries(found).filter(([k]) => k !== c.myProperty)
      .map(([k, h]) => ({ key: k, ...h, delta: mine ? h.priceUSD - mine.priceUSD : null }))
      .sort((a, b) => a.priceUSD - b.priceUSD);
    const undercut = comps.filter(x => x.delta < 0);
    // history
    try {
      fs.appendFileSync(HISTORY_FILE, JSON.stringify({ at: new Date().toISOString(), city: c.city, checkin: r.checkin, checkout: r.checkout, mode: r.mode, mine: mine ? { name: mine.name, price: mine.priceUSD } : null, competitors: comps.map(x => ({ name: x.name, price: x.priceUSD })) }) + '\n');
    } catch (e) {}
    // email
    let emailed = false;
    const s = secrets();
    if (s.gmailUser && s.gmailAppPass && s.emailTo) {
      try {
        const lines = [`Booking.com ${r.mode.toUpperCase()} rates — ${c.city}, ${r.checkin} → ${r.checkout}`];
        lines.push(mine ? `YOUR PROPERTY: ${mine.name} — $${mine.priceUSD}` : `YOUR PROPERTY: NOT FOUND (check name "${c.myProperty}")`);
        lines.push(''); lines.push('COMPETITORS (cheapest first):');
        for (const x of comps) lines.push(`  $${x.priceUSD}  ${x.name}  (${x.delta === null ? 'n/a' : x.delta < 0 ? `$${-x.delta} CHEAPER` : x.delta === 0 ? 'same' : `$${x.delta} pricier`})`);
        if (notFound.length) lines.push(''); lines.push(`NOT FOUND: ${notFound.join(', ')}`);
        if (undercut.length) { lines.push(''); lines.push('⚠ ALERT — competitors under you:'); for (const x of undercut) lines.push(`  ${x.name} $${x.priceUSD} vs your $${mine.priceUSD}`); }
        const nodemailer = require('nodemailer');
        const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: s.gmailUser, pass: s.gmailAppPass } });
        await t.sendMail({ from: `"Rate Watch" <${s.gmailUser}>`, to: s.emailTo, subject: `[RateWatch] ${c.city} ${r.checkin} — ${mine ? '$' + mine.priceUSD : 'n/a'} vs ${comps[0] ? '$' + comps[0].priceUSD : 'n/a'}${undercut.length ? ' ⚠' : ''}`, text: lines.join('\n') });
        emailed = true;
      } catch (e) { console.error('EMAIL_FAIL:', e.message); }
    }
    res.json({ ok: true, run: r, report: { mine, competitors: comps, notFound, undercut: undercut.map(x => x.name) }, emailed });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally { running = false; }
});

// ---- history ----
app.get('/api/history', (req, res) => {
  res.json({ history: history(200) });
});

// ---- property name suggestions (instant, from warmed index) ----
let nameIndex = null;
app.get('/api/suggest', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  if (!q) return res.json({ names: [] });
  const c = cfg();
  const pool = nameIndex || [];
  const hits = pool
    .filter(x => x.name.toLowerCase().includes(q))
    .slice(0, 10)
    .map(x => x.name);
  res.json({ names: hits, indexed: pool.length });
});

app.post('/api/refresh-names', async (req, res) => {
  try {
    const c = cfg();
    const deep = !!req.body.deep;
    const browser = await getBrowser();
    const context = await core.newContext(browser, false, fs.existsSync(core.STATE_FILE) ? JSON.parse(fs.readFileSync(core.STATE_FILE, 'utf8')) : undefined);
    const page = await context.newPage();
    const sess = await core.getSession(page, c.country);
    const names = await core.buildNameIndex(page, core.slugify(c.city), c.country, deep);
    nameIndex = names;
    await context.close().catch(() => {});
    res.json({ ok: true, count: names.length, sample: names.slice(0, 8).map(x => x.name), deep });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---- status ----
app.get('/api/status', (req, res) => {
  res.json({
    browserWarm: !!(sharedBrowser && sharedBrowser.isConnected()),
    indexedNames: nameIndex ? nameIndex.length : 0,
    historyEntries: history(100000).length,
    lastHistory: history(1)[0] || null,
    config: cfg(),
    emailConfigured: (() => { const s = secrets(); return !!(s.gmailUser && s.gmailAppPass && s.emailTo); })(),
  });
});

const PORT = process.env.PORT || 5180;
app.listen(PORT, '127.0.0.1', () => console.log(`Rate Watch dashboard: http://127.0.0.1:${PORT}`));
