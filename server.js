// server.js — Price Watch dashboard backend (local, 127.0.0.1)
const express = require('express');
const fs = require('fs');
const path = require('path');
const core = require('./watch-core.js');

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
  // computed rolling dates for the UI
  const sDays = Math.max(0, parseInt(c.startDaysFromToday ?? c.offsetDays ?? 1, 10));
  let eDays = parseInt(c.endDaysFromToday, 10);
  if (isNaN(eDays)) eDays = sDays + Math.max(1, parseInt(c.checkDates || 1, 10)) - 1;
  eDays = Math.max(eDays, sDays);
  const iso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  // merge non-secret email state; never echo the real app password
  res.json({
    config: { ...c, startDaysFromToday: sDays, endDaysFromToday: eDays, startDate: iso(sDays), endDate: iso(eDays), gmailUser: s.gmailUser, gmailAppPass: s.gmailAppPass ? 'set' : '', emailTo: s.emailTo },
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
  next.nights = Math.max(1, Math.min(14, parseInt(next.nights, 10) || 1));
  next.adults = Math.max(1, Math.min(10, parseInt(next.adults, 10) || 2));
  next.currency = String(next.currency || 'USD').toUpperCase();
  next.mobile = next.mobile !== false;
  next.stealth = next.stealth !== false;
  // rolling date window: accept startDate/endDate (ISO) or startDaysFromToday/endDaysFromToday
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const toDays = (iso) => { const d = new Date(iso + 'T00:00:00Z'); return Math.round((d - today0) / 86400000); };
  let s = parseInt(next.startDaysFromToday ?? next.offsetDays ?? 1, 10);
  let e = parseInt(next.endDaysFromToday, 10);
  if (isNaN(e)) e = s + Math.max(1, Math.min(30, parseInt(next.checkDates || 1, 10))) - 1;
  if (req.body.startDate) { const ds = toDays(String(req.body.startDate)); if (!isNaN(ds)) s = Math.max(0, ds); }
  if (req.body.endDate) { const de = toDays(String(req.body.endDate)); if (!isNaN(de)) e = Math.max(s, de); }
  s = Math.max(0, Math.min(365, s));
  e = Math.max(s, Math.min(s + 29, e)); // cap at 30 dates
  next.startDaysFromToday = s;
  next.endDaysFromToday = e;
  next.offsetDays = s;
  next.checkDates = e - s + 1;
  // privacy: never persist personal email or derived date fields into config.json
  delete next.email;
  delete next.startDate;
  delete next.endDate;
  writeJson(CONFIG_FILE, next);
  res.json({ ok: true, config: next });
});

app.post('/api/secrets', (req, res) => {
  const cur = secrets();
  const next = { ...cur };
  // Key ABSENT → keep existing. Key '' (empty) → clear. Placeholder values → keep existing.
  for (const k of ['gmailUser', 'gmailAppPass', 'emailTo']) {
    const v = String(req.body[k] ?? '__KEEP__').trim();
    if (v !== '__KEEP__' && v !== '••••••••' && v !== 'set' && v !== 'SET') next[k] = v;
  }
  writeJson(SECRETS_FILE, next);
  res.json({ ok: true, emailConfigured: !!(next.gmailUser && next.gmailAppPass && next.emailTo), fields: { gmailUser: !!next.gmailUser, gmailAppPass: !!next.gmailAppPass, emailTo: !!next.emailTo } });
});

// ---- test email ----
app.post('/api/test-email', async (req, res) => {
  try {
    const s = secrets();
    const c = cfg();
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: s.gmailUser, pass: s.gmailAppPass } });
    await t.sendMail({ from: `"Price Watch" <${s.gmailUser}>`, to: s.emailTo, subject: 'Price Watch — test email', text: `Test OK. Dashboard configured for ${c.city}, ${c.nights} night(s), ${c.adults} adults, mobile=${c.mobile}.` });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---- professional HTML email ----
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtPrice(p) { return p === null || p === undefined ? '—' : '$' + p; }

function renderEmailHtml(c, runs) {
  const mine = c.myProperty;
  const hasComps = (c.competitors || []).length > 0;
  const total = runs.reduce((s, r) => s + r.hotels.length + (r.sources || []).reduce((x, src) => x + (src.hotels ? src.hotels.length : 0), 0), 0);
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
  if (!hasComps && runs[0] && runs[0].hotels && runs[0].hotels.length) {
    const cap = 60;
    const all = runs[0].hotels.slice(0, cap);
    const more = runs[0].hotels.length - all.length;
    const li = all.map((h, i) => `<tr>
      <td style="padding:7px 12px;border-bottom:1px solid #f2f2f2;color:#888">${i + 1}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f2f2f2">${esc(h.name)}${h.url ? ` <a href="${h.url}" style="color:#2980b9;font-size:11px">view</a>` : ''}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #f2f2f2"><b>$${h.priceUSD}</b></td>
      <td style="padding:7px 12px;border-bottom:1px solid #f2f2f2;color:#888">${esc(h.score || '')}</td>
    </tr>`).join('');
    listSection = `<h2 style="font-size:15px;color:#333;margin:26px 0 10px">All properties in ${esc(c.city)} — cheapest first (${runs[0].hotels.length} found${more > 0 ? ', showing cheapest ' + cap : ''})</h2>
    <table style="border-collapse:collapse;width:100%;font-size:13px"><tr style="color:#888;text-align:left;font-size:11px;text-transform:uppercase"><th style="padding:6px 12px;border-bottom:2px solid #eee">#</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Property</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Price / night</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Score</th></tr>${li}</table>
    ${more > 0 ? `<p style="color:#888;font-size:12px;margin-top:6px">… and ${more} more (full list is in the dashboard).</p>` : ''}
    <p style="color:#888;font-size:12px;margin-top:6px">Full market scan — every page of ${esc(c.city)} crawled. Prices are the cheapest available rate for 1 room · ${c.adults} adults, as shown on Booking's mobile site for ${runs[0].checkin} → ${runs[0].checkout}.</p>`;
  } else {
    listSection = `<h2 style="font-size:15px;color:#333;margin:26px 0 10px">Tracked competitors — ${esc(c.city)}</h2>
    <p style="color:#888;font-size:13px">${(c.competitors || []).map(esc).join(' · ')}</p>
    <p style="color:#888;font-size:12px;margin-top:10px">Prices are the cheapest available rate for 1 room · ${c.adults} adults, mobile site, ${runs[0].checkin} → ${runs[0].checkout}. Date-by-date rates in the table above; full per-date detail is in your dashboard history.</p>`;
  }

  const undAlert = und.length
    ? `<div style="background:#fdecea;border:1px solid #f5b7b1;border-radius:8px;padding:12px 16px;margin:14px 0;color:#922b21;font-size:13.5px"><b>⚠ Undercut alert:</b> a tracked competitor is cheaper than you on ${und.length} of ${runs.length} checked date(s). See table.</div>`
    : `<div style="background:#eafaf1;border:1px solid #a9dfbf;border-radius:8px;padding:12px 16px;margin:14px 0;color:#145a32;font-size:13.5px"><b>✓ Good news:</b> no tracked competitor is cheaper than you on any checked date.</div>`;
  const bkErr = runs[0] && runs[0].bookingError;
  const bkWarning = bkErr ? `<div style="margin:12px 0;padding:10px 14px;background:#fdf6ec;border:1px solid #f0d9b5;border-radius:8px;color:#7d6608;font-size:12.5px"><b>Booking.com</b> was throttled/blocked this run (${esc(bkErr.slice(0, 60))}) — other sources below are still live. Booking usually recovers by the next run.</div>` : '';

  // Google Hotels — per-date rows for the tracked property (ALL dates)
  let googleRows = '';
  let googleAny = false;
  for (const r of runs) {
    const g = (r.sources || []).find(s => s.source === 'google' && !s.blocked);
    if (!g || !g.mine) continue;
    googleAny = true;
    const ch = g.competitors[0];
    const dTxt = ch ? (ch.delta < 0 ? `<span style="color:#c0392b;font-weight:600">$${-ch.delta} under you</span>` : ch.delta === 0 ? 'same' : `<span style="color:#1e8449">+$${ch.delta}</span>`) : '—';
    googleRows += `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600">${r.checkin} → ${r.checkout}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee"><b>$${g.mine.price}</b></td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee">${ch ? '<b>$' + ch.price + '</b> · ' + esc(ch.name) : '—'}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee">${dTxt}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee">${g.undercut.length ? '<span style="background:#fdecea;color:#c0392b;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">⚠ ' + g.undercut.length + ' below you</span>' : '<span style="background:#eafaf1;color:#1e8449;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">✓ ok</span>'}</td>
    </tr>`;
  }
  const googleSection = googleAny ? `<h2 style="font-size:15px;color:#333;margin:20px 0 10px">Google Hotels — your property, date by date</h2>
  <table style="border-collapse:collapse;width:100%;font-size:13px"><tr style="color:#888;text-align:left;font-size:11px;text-transform:uppercase"><th style="padding:6px 12px;border-bottom:2px solid #eee">Dates</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Your Google rate</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Cheapest competitor</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Vs you</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Status</th></tr>${googleRows}</table>` : '';

  // extra sources (Google Hotels etc.) — first date, top list
  const SRC_LABEL = { google: 'Google Hotels', expedia: 'Expedia', trivago: 'Trivago', agoda: 'Agoda', kayak: 'KAYAK' };
  let sourcesHtml = '';
  for (const s of (runs[0].sources || [])) {
    const label = SRC_LABEL[s.source] || s.source;
    if (s.source === 'googleOta') {
      for (const t of (s.targets || [])) {
        const rows = (t.ota || []).sort((a, b) => a.price - b.price).map((o, i) => `<tr>
          <td style="padding:6px 12px;border-bottom:1px solid #f2f2f2;color:#888">${i + 1}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f2f2f2">${esc(o.ota)}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f2f2f2"><b>$${o.price}</b></td>
        </tr>`).join('');
        sourcesHtml += `<h2 style="font-size:15px;color:#333;margin:26px 0 10px">${esc(t.target)} — every booking site (Google comparison) · ${runs[0].checkin} → ${runs[0].checkout}</h2>
        <table style="border-collapse:collapse;width:100%;font-size:13px"><tr style="color:#888;text-align:left;font-size:11px;text-transform:uppercase"><th style="padding:6px 12px;border-bottom:2px solid #eee">#</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Site</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Price / night</th></tr>${rows}</table>
        ${t.error ? `<p style="color:#999;font-size:12px">${esc(t.error)}</p>` : ''}`;
      }
      continue;
    }
    if (s.blocked) continue; // unsupported sources are silent in the email (dashboard shows why)
    const sr = s.hotels.slice(0, 14);
    const srows = sr.map((h, i) => {
      const mine = s.mine && core.norm(h.name) === core.norm(s.mine.name);
      return `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #f2f2f2;color:#888">${i + 1}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f2f2f2;${mine ? 'background:#fff8e1;font-weight:700' : ''}">${esc(h.name)}${mine ? ' ← yours' : ''}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #f2f2f2"><b>$${h.price}</b></td>
      </tr>`;
    }).join('');
    sourcesHtml += `<h2 style="font-size:15px;color:#333;margin:26px 0 10px">${label} — ${esc(c.city)} · ${runs[0].checkin} → ${runs[0].checkout}</h2>
      ${s.mine ? `<p style="font-size:13px">Your property: <b>$${s.mine.price}</b>/night on Google Hotels${s.undercut.length ? ` — <span style="color:#c0392b">⚠ ${s.undercut.length} cheaper option(s) found</span>` : ''}</p>` : ''}
      <table style="border-collapse:collapse;width:100%;font-size:13px"><tr style="color:#888;text-align:left;font-size:11px;text-transform:uppercase"><th style="padding:6px 12px;border-bottom:2px solid #eee">#</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Property</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Price / night</th></tr>${srows}</table>
      ${s.hotels.length > 14 ? `<p style="color:#888;font-size:12px">… and ${s.hotels.length - 14} more in the dashboard.</p>` : ''}`;
  }

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f6f2;font-family:Segoe UI,Arial,sans-serif">
<div style="background:#141414;padding:22px 30px">
  <div style="font-size:20px;font-weight:700;color:#d4af37">Price Watch</div>
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
  ${googleSection}
  ${bkWarning}
  ${sourcesHtml}
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
    const hasComps = (c.competitors || []).length > 0;
    const r = await core.scrape(c, { mobile: c.mobile !== false, stealth: c.stealth !== false, checkDates: c.checkDates, fullScan: !hasComps });

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
      // per-source comparisons (google, …) — same target-matching logic
      const sources = (dr.sources || []).map(s => {
        if (s.source === 'googleOta') return s; // already structured: {targets: [{target, ota: [{ota, price}]}]}
        const sf = {}, snf = [];
        for (const t of [c.myProperty, ...(c.competitors || [])]) {
          const hit = (s.hotels || []).find(h => core.inName(h.name, t));
          if (hit) sf[t] = hit; else snf.push(t);
        }
        const smine = sf[c.myProperty];
        const scomps = Object.entries(sf).filter(([k]) => k !== c.myProperty)
          .map(([k, h]) => ({ key: k, ...h, delta: smine ? h.price - smine.price : null }))
          .sort((a, b) => a.price - b.price);
        return {
          source: s.source, blocked: s.blocked || null,
          hotels: (s.hotels || []).filter(h => h.price).sort((a, b) => a.price - b.price),
          mine: smine, competitors: scomps, notFound: snf, undercut: scomps.filter(x => x.delta < 0),
        };
      });
      return { checkin: dr.checkin, checkout: dr.checkout, hotels: dr.hotels, mine, competitors: comps, notFound, undercut, full, sources, bookingError: dr.bookingError || null };
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
        const subj = `[PriceWatch] ${c.city} ${reports[0].checkin}→${reports[reports.length - 1].checkout} · you ${firstMine ? '$' + firstMine.priceUSD : 'n/a'}${undCount ? ' ⚠' : ''}`;
        const csv = core.buildCsv(c, reports);
        await t.sendMail({ from: `"Price Watch" <${s.gmailUser}>`, to: s.emailTo, subject: subj, html: renderEmailHtml(c, reports), attachments: csv ? [{ filename: `price-watch-${c.city.replace(/[^a-z0-9]+/gi, '-')}-${reports[0].checkin}-to-${reports[reports.length - 1].checkout}.csv`, content: csv }] : undefined });
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
    // allow unsaved city/country from the UI to build the right index immediately
    const city = String(req.body.city || '').trim() || c.city;
    const country = String(req.body.country || '').trim() || c.country;
    const deep = !!req.body.deep;
    const browser = await getBrowser();
    const context = await core.newContext(browser, false, fs.existsSync(core.STATE_FILE) ? JSON.parse(fs.readFileSync(core.STATE_FILE, 'utf8')) : undefined);
    const page = await context.newPage();
    await core.getSession(page, country);
    const names = await core.buildNameIndex(page, core.slugify(city), country, deep);
    nameIndex = names;
    await context.close().catch(() => {});
    res.json({ ok: true, count: names.length, sample: names.slice(0, 8).map(x => x.name), deep, city });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---- sync config + history to GitHub (so the 5h job uses dashboard settings) ----
app.post('/api/sync-gh', async (req, res) => {
  const { execFile } = require('child_process');
  const run = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { cwd: ROOT, timeout: 60000 }, (err, stdout, stderr) => resolve({ err, out: (stdout || '') + (stderr || '') }));
  });
  try {
    let r = await run('git', ['add', 'config.json', 'rates-history.jsonl']);
    if (r.err) return res.status(500).json({ ok: false, error: r.out.slice(0, 300) });
    r = await run('git', ['diff', '--cached', '--quiet']);
    const hasChanges = r.err !== null && r.err.code === 1; // exit 1 = changes staged
    if (!hasChanges) return res.json({ ok: true, pushed: false, msg: 'config already in sync with GitHub' });
    r = await run('git', ['-c', 'user.name=auto', '-c', 'user.email=auto@users.noreply.github.com', 'commit', '-m', 'dashboard config sync ' + new Date().toISOString()]);
    if (r.err) return res.status(500).json({ ok: false, error: r.out.slice(0, 300) });
    r = await run('git', ['pull', '--rebase', '--autostash', 'origin', 'main']);
    r = await run('git', ['push', 'origin', 'main']);
    if (r.err) return res.status(500).json({ ok: false, error: r.out.slice(0, 300) });
    res.json({ ok: true, pushed: true, msg: 'config synced to GitHub — the 5-hour email job will use these settings' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---- geo index (countries + cities autocomplete) ----
let geoIndex = null;
let geoBuilding = false;
const loadGeo = () => { try { geoIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'geo-index.json'), 'utf8')); } catch (e) {} };
loadGeo();
async function rebuildGeo() {
  if (geoBuilding) return null;
  geoBuilding = true;
  try {
    const g = await core.buildGeoIndex();
    geoIndex = g;
    fs.writeFileSync(path.join(ROOT, 'geo-index.json'), JSON.stringify(g));
    return g;
  } finally { geoBuilding = false; }
}
app.post('/api/refresh-geo', async (req, res) => {
  try {
    const g = await rebuildGeo();
    if (!g) return res.status(409).json({ ok: false, error: 'already building' });
    res.json({ ok: true, countries: g.countries.length, cities: g.cities.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get('/api/geo-suggest', (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (!geoIndex || !geoIndex.cities) return res.json({ ready: false, countries: [], cities: [] });
  if (!q) return res.json({ ready: true, countries: [], cities: [] });
  const myCC = (cfg().country || 'us').toLowerCase();
  const cname = (cc) => { const c = geoIndex.countries.find(x => x.code === cc); return c ? c.name : cc.toUpperCase(); };
  // curated popular destinations rank above everything (real Booking slugs)
  const TOP = new Set(['las-vegas', 'los-angeles', 'new-york', 'miami', 'miami-beach', 'orlando', 'chicago', 'san-francisco', 'san-diego', 'seattle', 'boston', 'washington-dc', 'philadelphia', 'atlanta', 'houston', 'dallas', 'austin', 'denver', 'phoenix', 'nashville', 'new-orleans', 'charleston', 'savannah', 'key-west', 'fort-lauderdale', 'tampa', 'honolulu', 'anchorage', 'portland', 'salt-lake-city', 'london', 'paris', 'rome', 'venice', 'florence', 'milan', 'barcelona', 'madrid', 'amsterdam', 'berlin', 'munich', 'vienna', 'prague', 'budapest', 'lisbon', 'dublin', 'edinburgh', 'brussels', 'zurich', 'geneva', 'copenhagen', 'stockholm', 'oslo', 'helsinki', 'warsaw', 'athens', 'istanbul', 'dubai', 'abu-dhabi', 'doha', 'riyadh', 'tel-aviv', 'jerusalem', 'cairo', 'marrakech', 'casablanca', 'cape-town', 'johannesburg', 'nairobi', 'tokyo', 'osaka', 'kyoto', 'seoul', 'bangkok', 'phuket', 'singapore', 'kuala-lumpur', 'bali', 'jakarta', 'manila', 'hong-kong', 'macau', 'taipei', 'shanghai', 'beijing', 'sydney', 'melbourne', 'brisbane', 'perth', 'auckland', 'queenstown', 'fiji', 'maui', 'mexico-city', 'cancun', 'tulum', 'puerto-vallarta', 'havana', 'bogota', 'lima', 'cusco', 'rio-de-janeiro', 'sao-paulo', 'buenos-aires', 'santiago', 'quito', 'panama-city', 'san-jose', 'san-juan', 'punta-cana', 'santo-domingo', 'montego-bay', 'nassau', 'barbados', 'aruba', 'grand-cayman', 'toronto', 'vancouver', 'montreal', 'quebec-city', 'calgary', 'banff', 'whistler', 'niagara-falls', 'myrtle-beach', 'nags-head', 'kill-devil-hills', 'obx', 'gatlinburg', 'asheville', 'santa-fe', 'sedona', 'jackson-hole', 'aspen', 'vail', 'lake-tahoe', 'palm-springs', 'santa-barbara', 'monterey', 'carmel-by-the-sea', 'santa-monica', 'malibu', 'laguna-beach', 'newport-beach', 'long-beach', 'anaheim', 'san-jose-costa-rica']);
  // countries: exact code → prefix → substring
  const c1 = [], c2 = [], c3 = [];
  for (const c of geoIndex.countries) {
    const n = c.name.toLowerCase();
    if (c.code === q) c1.push(c);
    else if (n.startsWith(q)) c2.push(c);
    else if (n.includes(q)) c3.push(c);
  }
  const countries = [...c1, ...c2, ...c3].slice(0, 8);
  // cities: curated top → exact slug → user's country → rest, then substring matches
  const t1 = [], t2 = [];
  for (const c of geoIndex.cities) {
    const name = core.humanizeSlug(c.slug);
    const low = name.toLowerCase();
    if (low.startsWith(q)) t1.push({ name, cc: c.cc, country: cname(c.cc), slug: c.slug, rank: TOP.has(c.slug) ? 0 : c.slug === q ? 0.1 : c.cc === myCC ? 1 : 2 });
    else if (low.includes(q)) t2.push({ name, cc: c.cc, country: cname(c.cc), slug: c.slug, rank: TOP.has(c.slug) ? 2.5 : 3 });
  }
  const cities = [...t1, ...t2].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)).slice(0, 10);
  res.json({ ready: true, countries, cities });
});

// ---- status ----
app.get('/api/status', (req, res) => {
  res.json({
    browserWarm: !!(sharedBrowser && sharedBrowser.isConnected()),
    indexedNames: nameIndex ? nameIndex.length : 0,
    historyEntries: history(100000).length,
    lastHistory: history(1)[0] || null,
    geoReady: !!(geoIndex && geoIndex.cities && geoIndex.cities.length),
    geoCities: geoIndex && geoIndex.cities ? geoIndex.cities.length : 0,
    geoCountries: geoIndex && geoIndex.countries ? geoIndex.countries.length : 0,
    config: cfg(),
    emailConfigured: (() => { const s = secrets(); return !!(s.gmailUser && s.gmailAppPass && s.emailTo); })(),
  });
});

const PORT = process.env.PORT || 5180;
app.listen(PORT, '127.0.0.1', () => console.log(`Price Watch dashboard: http://127.0.0.1:${PORT}`));
