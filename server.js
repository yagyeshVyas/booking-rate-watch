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

// ---- professional HTML email ----
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtPrice(p) { return p === null || p === undefined ? '—' : '$' + p; }

function renderEmailHtml(c, runs) {
  const mine = c.myProperty;
  const hasComps = (c.competitors || []).length > 0;
  const total = runs.reduce((s, r) => s + r.hotels.length, 0);
  const und = runs.filter(r => r.undercut.length > 0);

  let rows = '';
  for (const r of runs) {
    const cheapest = r.competitors[0];
    const deltaTxt = r.mine && cheapest ? (cheapest.delta < 0 ? `<span style="color:#c0392b;font-weight:600">$${-cheapest.delta} under you</span>` : cheapest.delta === 0 ? 'same price' : `<span style="color:#1e8449">+$${cheapest.delta} above you</span>`) : '—';
    rows += `<tr>
      <td style="padding:9px 12px;border-bottom:1px solid #eee;font-weight:600">${r.checkin} → ${r.checkout}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #eee">${r.mine ? '<b>$' + r.mine.priceUSD + '</b>' : '<span style="color:#999">not found</span>'}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #eee">${cheapest ? '<b>$' + cheapest.priceUSD + '</b> · ' + esc(cheapest.name) : '—'}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #eee">${deltaTxt}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #eee">${r.undercut.length ? '<span style="background:#fdecea;color:#c0392b;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">⚠ ' + r.undercut.length + ' below you</span>' : '<span style="background:#eafaf1;color:#1e8449;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">✓ ok</span>'}</td>
    </tr>`;
  }

  let listSection = '';
  if (!hasComps) {
    const all = runs[0].hotels.slice(0, 25);
    const li = all.map((h, i) => `<tr>
      <td style="padding:7px 12px;border-bottom:1px solid #f2f2f2;color:#888">${i + 1}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f2f2f2">${esc(h.name)}${h.url ? ` <a href="${h.url}" style="color:#2980b9;font-size:11px">view</a>` : ''}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f2f2f2"><b>$${h.priceUSD}</b></td>
      <td style="padding:7px 12px;border-bottom:1px solid #f2f2f2;color:#888">${esc(h.score || '')}</td>
    </tr>`).join('');
    listSection = `<h2 style="font-size:15px;color:#333;margin:26px 0 10px">All properties in ${esc(c.city)} — cheapest first (${runs[0].hotels.length} found${all.length < runs[0].hotels.length ? ', showing top ' + all.length : ''})</h2>
    <table style="border-collapse:collapse;width:100%;font-size:13px"><tr style="color:#888;text-align:left;font-size:11px;text-transform:uppercase"><th style="padding:6px 12px;border-bottom:2px solid #eee">#</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Property</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Price / night</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Score</th></tr>${li}</table>
    <p style="color:#888;font-size:12px;margin-top:6px">Prices are the cheapest available rate for 1 room · ${c.adults} adults, as shown on Booking's mobile site for ${runs[0].checkin} → ${runs[0].checkout}.</p>`;
  } else {
    listSection = `<h2 style="font-size:15px;color:#333;margin:26px 0 10px">Tracked competitors — ${esc(c.city)}</h2>
    <p style="color:#888;font-size:13px">${(c.competitors || []).map(esc).join(' · ')}</p>
    <p style="color:#888;font-size:12px;margin-top:10px">Prices are the cheapest available rate for 1 room · ${c.adults} adults, mobile site, ${runs[0].checkin} → ${runs[0].checkout}. Date-by-date rates in the table above; full per-date detail is in your dashboard history.</p>`;
  }

  const undAlert = und.length
    ? `<div style="background:#fdecea;border:1px solid #f5b7b1;border-radius:8px;padding:12px 16px;margin:14px 0;color:#922b21;font-size:13.5px"><b>⚠ Undercut alert:</b> a tracked competitor is cheaper than you on ${und.length} of ${runs.length} checked date(s). See table.</div>`
    : `<div style="background:#eafaf1;border:1px solid #a9dfbf;border-radius:8px;padding:12px 16px;margin:14px 0;color:#145a32;font-size:13.5px"><b>✓ Good news:</b> no tracked competitor is cheaper than you on any checked date.</div>`;

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f6f2;font-family:Segoe UI,Arial,sans-serif">
<div style="background:#141414;padding:22px 30px">
  <div style="font-size:20px;font-weight:700;color:#d4af37">Rate Watch</div>
  <div style="font-size:12px;color:#999;margin-top:2px">Booking.com mobile rates · ${esc(c.city)}</div>
</div>
<div style="padding:24px 30px;background:#fff;max-width:640px;margin:0 auto">
  <h1 style="font-size:17px;color:#222;margin:0 0 4px">Rate report — ${runs[0].checkin} → ${runs[runs.length - 1].checkout}</h1>
  <p style="color:#888;font-size:12.5px;margin:0 0 8px">${runs.length} date(s) checked · ${total} live prices · mobile rates · ${c.adults} adults · ${c.currency}</p>
  ${undAlert}
  <h2 style="font-size:15px;color:#333;margin:20px 0 10px">Date by date${mine ? ' — your property: <span style="color:#b8860b">' + esc(mine) + '</span>' : ''}</h2>
  <table style="border-collapse:collapse;width:100%;font-size:13px">
    <tr style="color:#888;text-align:left;font-size:11px;text-transform:uppercase">
      <th style="padding:6px 12px;border-bottom:2px solid #eee">Dates</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Your rate</th>
      <th style="padding:6px 12px;border-bottom:2px solid #eee">Cheapest competitor</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Vs you</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Status</th>
    </tr>${rows}</table>
  ${listSection}
  <p style="color:#aaa;font-size:11px;margin-top:28px;border-top:1px solid #eee;padding-top:12px">Automated rate watch — runs every 5 hours. Prices change frequently; verify on Booking.com before relying on them. This is a personal competitive-research tool.</p>
</div></body></html>`;
}

// ---- run scrape ----
let running = false;
app.post('/api/run', async (req, res) => {
  if (running) return res.status(409).json({ ok: false, error: 'already running' });
  running = true;
  try {
    const c = cfg();
    const r = await core.scrape(c, { mobile: c.mobile !== false, stealth: c.stealth !== false, checkDates: c.checkDates });
    const hasComps = (c.competitors || []).length > 0;

    const reports = r.dateRuns.map(dr => {
      const found = {}, notFound = [];
      for (const t of [c.myProperty, ...(c.competitors || [])]) {
        const hit = dr.hotels.find(h => core.inName(h.name, t));
        if (hit) found[t] = hit; else notFound.push(t);
      }
      const mine = found[c.myProperty];
      const comps = Object.entries(found).filter(([k]) => k !== c.myProperty)
        .map(([k, h]) => ({ key: k, ...h, delta: mine ? h.priceUSD - mine.priceUSD : null }))
        .sort((a, b) => a.priceUSD - b.priceUSD);
      const undercut = comps.filter(x => x.delta < 0);
      const full = dr.hotels.filter(h => h.priceUSD).sort((a, b) => a.priceUSD - b.priceUSD);
      return { checkin: dr.checkin, checkout: dr.checkout, hotels: dr.hotels, mine, competitors: comps, notFound, undercut, full };
    });

    // history: one entry per date
    for (const rep of reports) {
      try {
        fs.appendFileSync(HISTORY_FILE, JSON.stringify({ at: new Date().toISOString(), city: c.city, checkin: rep.checkin, checkout: rep.checkout, mode: r.mode, mine: rep.mine ? { name: rep.mine.name, price: rep.mine.priceUSD } : null, competitors: rep.competitors.map(x => ({ name: x.name, price: x.priceUSD })) }) + '\n');
      } catch (e) {}
    }

    // email
    let emailed = false;
    const s = secrets();
    if (s.gmailUser && s.gmailAppPass && s.emailTo) {
      try {
        const nodemailer = require('nodemailer');
        const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: s.gmailUser, pass: s.gmailAppPass } });
        const undCount = reports.filter(x => x.undercut.length).length;
        const firstMine = reports[0].mine;
        const subj = `[RateWatch] ${c.city} ${reports[0].checkin}→${reports[reports.length - 1].checkout} · you ${firstMine ? '$' + firstMine.priceUSD : 'n/a'}${undCount ? ' ⚠' : ''}`;
        await t.sendMail({ from: `"Rate Watch" <${s.gmailUser}>`, to: s.emailTo, subject: subj, html: renderEmailHtml(c, reports) });
        emailed = true;
      } catch (e) { console.error('EMAIL_FAIL:', e.message); }
    }

    res.json({ ok: true, run: r, reports, emailed, fullList: !hasComps });
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
