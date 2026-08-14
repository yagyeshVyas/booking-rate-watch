// watch.js — CLI entry (also used by GitHub Actions). Uses watch-core.
// Usage: node watch.js --config config.json [--desktop] [--test-email]
//        node watch.js --city "Las Vegas" --checkin 2026-09-01 --nights 2
const path = require('path');
const fs = require('fs');
const core = require('./watch-core.js');

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const CONFIG_PATH = arg('--config') || path.join(__dirname, 'config.json');
const MOBILE = !args.includes('--desktop');
const TEST_EMAIL = args.includes('--test-email');

const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const city = arg('--city') || cfg.city;
const nights = parseInt(arg('--nights') || cfg.nights || 1, 10);

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderEmailHtml(c, runs) {
  const mine = c.myProperty;
  const hasComps = (c.competitors || []).length > 0;
  const total = runs.reduce((s, r) => s + r.hotels.length + (r.sources || []).reduce((x, src) => x + (src.hotels ? src.hotels.length : 0), 0), 0);
  const und = runs.filter(r => r.undercut.length);
  let rows = '';
  for (const r of runs) {
    const cheapest = r.competitors[0];
    const deltaTxt = r.mine && cheapest ? (cheapest.delta < 0 ? `<span style="color:#c0392b;font-weight:600">$${-cheapest.delta} under you</span>` : cheapest.delta === 0 ? 'same price' : `<span style="color:#1e8449">+$${cheapest.delta} above you</span>`) : '—';
    rows += `<tr><td style="padding:9px 12px;border-bottom:1px solid #eee;font-weight:600">${r.checkin} → ${r.checkout}</td><td style="padding:9px 12px;border-bottom:1px solid #eee">${r.mine ? '<b>$' + r.mine.priceUSD + '</b>' : '<span style="color:#999">not found</span>'}</td><td style="padding:9px 12px;border-bottom:1px solid #eee">${cheapest ? '<b>$' + cheapest.priceUSD + '</b> · ' + esc(cheapest.name) : '—'}</td><td style="padding:9px 12px;border-bottom:1px solid #eee">${deltaTxt}</td><td style="padding:9px 12px;border-bottom:1px solid #eee">${r.undercut.length ? '<span style="background:#fdecea;color:#c0392b;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">⚠ below you</span>' : '<span style="background:#eafaf1;color:#1e8449;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">✓ ok</span>'}</td></tr>`;
  }
  let listSection = '';
  if (!hasComps && runs[0] && runs[0].hotels && runs[0].hotels.length) {
    const cap = 60;
    const all = runs[0].hotels.slice(0, cap);
    const more = runs[0].hotels.length - all.length;
    const li = all.map((h, i) => `<tr><td style="padding:7px 12px;border-bottom:1px solid #f2f2f2;color:#888">${i + 1}</td><td style="padding:7px 12px;border-bottom:1px solid #f2f2f2">${esc(h.name)}${h.url ? ` <a href="${h.url}" style="color:#2980b9;font-size:11px">view</a>` : ''}</td><td style="padding:7px 12px;border-bottom:1px solid #f2f2f2"><b>$${h.priceUSD}</b></td><td style="padding:7px 12px;border-bottom:1px solid #f2f2f2;color:#888">${esc(h.score || '')}</td></tr>`).join('');
    listSection = `<h2 style="font-size:15px;color:#333;margin:26px 0 10px">All properties in ${esc(c.city)} — cheapest first (${runs[0].hotels.length} found${more > 0 ? ', showing cheapest ' + cap : ''})</h2><table style="border-collapse:collapse;width:100%;font-size:13px"><tr style="color:#888;text-align:left;font-size:11px;text-transform:uppercase"><th style="padding:6px 12px;border-bottom:2px solid #eee">#</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Property</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Price / night</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Score</th></tr>${li}</table>${more > 0 ? `<p style="color:#888;font-size:12px;margin-top:6px">… and ${more} more (full list is in the dashboard).</p>` : ''}<p style="color:#888;font-size:12px;margin-top:6px">Full market scan — every page of ${esc(c.city)} crawled. Prices are the cheapest available rate for 1 room · ${c.adults} adults, as shown on Booking's mobile site for ${runs[0].checkin} → ${runs[0].checkout}.</p>`;
  } else {
    listSection = `<h2 style="font-size:15px;color:#333;margin:26px 0 10px">Tracked competitors — ${esc(c.city)}</h2><p style="color:#888;font-size:13px">${(c.competitors || []).map(esc).join(' · ')}</p><p style="color:#888;font-size:12px;margin-top:10px">Date-by-date rates in the table above.</p>`;
  }
  const undAlert = und.length
    ? `<div style="background:#fdecea;border:1px solid #f5b7b1;border-radius:8px;padding:12px 16px;margin:14px 0;color:#922b21;font-size:13.5px"><b>⚠ Undercut alert:</b> a tracked competitor is cheaper than you on ${und.length} of ${runs.length} checked date(s). See table.</div>`
    : `<div style="background:#eafaf1;border:1px solid #a9dfbf;border-radius:8px;padding:12px 16px;margin:14px 0;color:#145a32;font-size:13.5px"><b>✓ Good news:</b> no tracked competitor is cheaper than you on any checked date.</div>`;
  // Google Hotels — per-date rows for the tracked property (ALL dates)
  let googleRows = '';
  let googleAny = false;
  for (const r of runs) {
    const g = (r.sources || []).find(s => s.source === 'google' && !s.blocked);
    if (!g || !g.mine) continue;
    googleAny = true;
    const ch = g.competitors[0];
    const dTxt = ch ? (ch.delta < 0 ? `<span style="color:#c0392b;font-weight:600">$${-ch.delta} under you</span>` : ch.delta === 0 ? 'same' : `<span style="color:#1e8449">+$${ch.delta}</span>`) : '—';
    googleRows += `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600">${r.checkin} → ${r.checkout}</td><td style="padding:8px 12px;border-bottom:1px solid #eee"><b>$${g.mine.price}</b></td><td style="padding:8px 12px;border-bottom:1px solid #eee">${ch ? '<b>$' + ch.price + '</b> · ' + esc(ch.name) : '—'}</td><td style="padding:8px 12px;border-bottom:1px solid #eee">${dTxt}</td><td style="padding:8px 12px;border-bottom:1px solid #eee">${g.undercut.length ? '<span style="background:#fdecea;color:#c0392b;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">⚠ below you</span>' : '<span style="background:#eafaf1;color:#1e8449;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600">✓ ok</span>'}</td></tr>`;
  }
  const googleSection = googleAny ? `<h2 style="font-size:15px;color:#333;margin:20px 0 10px">Google Hotels — your property, date by date</h2>
  <table style="border-collapse:collapse;width:100%;font-size:13px"><tr style="color:#888;text-align:left;font-size:11px;text-transform:uppercase"><th style="padding:6px 12px;border-bottom:2px solid #eee">Dates</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Your Google rate</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Cheapest competitor</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Vs you</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Status</th></tr>${googleRows}</table>` : '';
  const SRC_LABEL = { google: 'Google Hotels', expedia: 'Expedia', trivago: 'Trivago', agoda: 'Agoda', kayak: 'KAYAK' };
  let sourcesHtml = '';
  for (const s of (runs[0].sources || [])) {
    const label = SRC_LABEL[s.source] || s.source;
    if (s.source === 'googleOta') {
      for (const t of (s.targets || [])) {
        const rows = (t.ota || []).sort((a, b) => a.price - b.price).map((o, i) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #f2f2f2;color:#888">${i + 1}</td><td style="padding:6px 12px;border-bottom:1px solid #f2f2f2">${esc(o.ota)}</td><td style="padding:6px 12px;border-bottom:1px solid #f2f2f2"><b>$${o.price}</b></td></tr>`).join('');
        sourcesHtml += `<h2 style="font-size:15px;color:#333;margin:26px 0 10px">${esc(t.target)} — every booking site (Google comparison) · ${runs[0].checkin} → ${runs[0].checkout}</h2>
        <table style="border-collapse:collapse;width:100%;font-size:13px"><tr style="color:#888;text-align:left;font-size:11px;text-transform:uppercase"><th style="padding:6px 12px;border-bottom:2px solid #eee">#</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Site</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Price / night</th></tr>${rows}</table>
        ${t.error ? `<p style="color:#999;font-size:12px">${esc(t.error)}</p>` : ''}`;
      }
      continue;
    }
    if (s.blocked) continue; // unsupported sources are silent in the email (dashboard shows why)
    const srows = s.hotels.slice(0, 14).map((h, i) => {
      const mine = s.mine && core.norm(h.name) === core.norm(s.mine.name);
      return `<tr><td style="padding:6px 12px;border-bottom:1px solid #f2f2f2;color:#888">${i + 1}</td><td style="padding:6px 12px;border-bottom:1px solid #f2f2f2;${mine ? 'background:#fff8e1;font-weight:700' : ''}">${esc(h.name)}${mine ? ' ← yours' : ''}</td><td style="padding:6px 12px;border-bottom:1px solid #f2f2f2"><b>$${h.price}</b></td></tr>`;
    }).join('');
    sourcesHtml += `<h2 style="font-size:15px;color:#333;margin:26px 0 10px">${label} — ${esc(c.city)} · ${runs[0].checkin} → ${runs[0].checkout}</h2>
      ${s.mine ? `<p style="font-size:13px">Your property: <b>$${s.mine.price}</b>/night on ${label}${s.undercut.length ? ` — <span style="color:#c0392b">⚠ ${s.undercut.length} cheaper option(s) found</span>` : ''}</p>` : ''}
      <table style="border-collapse:collapse;width:100%;font-size:13px"><tr style="color:#888;text-align:left;font-size:11px;text-transform:uppercase"><th style="padding:6px 12px;border-bottom:2px solid #eee">#</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Property</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Price / night</th></tr>${srows}</table>
      ${s.hotels.length > 14 ? `<p style="color:#888;font-size:12px">… and ${s.hotels.length - 14} more in the dashboard.</p>` : ''}`;
  }
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f6f2;font-family:Segoe UI,Arial,sans-serif">
<div style="background:#141414;padding:22px 30px"><div style="font-size:20px;font-weight:700;color:#d4af37">Price Watch</div><div style="font-size:12px;color:#999;margin-top:2px">Booking.com mobile rates · ${esc(c.city)}</div></div>
<div style="padding:24px 30px;background:#fff;max-width:640px;margin:0 auto">
  <h1 style="font-size:17px;color:#222;margin:0 0 4px">Rate report — ${runs[0].checkin} → ${runs[runs.length - 1].checkout}</h1>
  <p style="color:#888;font-size:12.5px;margin:0 0 8px">${runs.length} date(s) checked · ${total} live prices · mobile rates · ${c.adults} adults · ${c.currency}</p>
  ${undAlert}
  <h2 style="font-size:15px;color:#333;margin:20px 0 10px">Date by date${mine ? ' — your property: <span style="color:#b8860b">' + esc(mine) + '</span>' : ''}</h2>
  <table style="border-collapse:collapse;width:100%;font-size:13px"><tr style="color:#888;text-align:left;font-size:11px;text-transform:uppercase"><th style="padding:6px 12px;border-bottom:2px solid #eee">Dates</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Your rate</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Cheapest competitor</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Vs you</th><th style="padding:6px 12px;border-bottom:2px solid #eee">Status</th></tr>${rows}</table>
  ${googleSection}
  ${sourcesHtml}
  ${listSection}
  <p style="color:#aaa;font-size:11px;margin-top:28px;border-top:1px solid #eee;padding-top:12px">Automated rate watch — runs every 5 hours. Prices change frequently; verify on Booking.com before relying on them. This is a personal competitive-research tool.</p>
</div></body></html>`;
}

async function sendEmail(subject, html, csv) {
  // email config comes from env (GitHub secrets) or the dashboard's local secrets file — NEVER from config.json
  let to = process.env.EMAIL_TO || null;
  let user = process.env.GMAIL_USER || null;
  let pass = process.env.GMAIL_APP_PASS || null;
  if (!to || !user || !pass) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(__dirname, 'secrets.local.json'), 'utf8'));
      to = to || s.emailTo || null; user = user || s.gmailUser || null; pass = pass || s.gmailAppPass || null;
    } catch (e) {}
  }
  if (!user || !pass || !to) { console.log('EMAIL_SKIPPED (set GMAIL_USER, GMAIL_APP_PASS, EMAIL_TO or configure email in the dashboard)'); return false; }
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
  await t.sendMail({ from: `"Price Watch" <${user}>`, to, subject, html, attachments: csv ? [{ filename: 'price-watch-rates.csv', content: csv }] : undefined });
  console.log('EMAIL_SENT to', to);
  return true;
}

const inName = (h, t) => core.norm(h).includes(core.norm(t).slice(0, 24));

(async () => {
  if (TEST_EMAIL) { await sendEmail('Price Watch test', '<p>Test email from Booking rate watch.</p>'); return; }

  const runCfg = { ...cfg, city };
  const hasComps = (cfg.competitors || []).length > 0;
  console.error(`SCRAPE city=${city} checkDates=${runCfg.checkDates || 1} mode=${MOBILE ? 'mobile' : 'desktop'} fullScan=${!hasComps}`);
  const r = await core.scrape(runCfg, { mobile: MOBILE, fullScan: !hasComps, sources: cfg.sources });

  const reports = r.dateRuns.map(dr => {
    const found = {}, notFound = [];
    for (const t of [cfg.myProperty, ...(cfg.competitors || [])]) {
      const hit = dr.hotels.find(h => inName(h.name, t));
      if (hit) found[t] = hit; else notFound.push(t);
    }
    const mine = found[cfg.myProperty];
    const comps = Object.entries(found).filter(([k]) => k !== cfg.myProperty)
      .map(([k, h]) => ({ key: k, ...h, delta: mine ? h.priceUSD - mine.priceUSD : null }))
      .sort((a, b) => a.priceUSD - b.priceUSD);
    const sources = (dr.sources || []).map(s => {
      if (s.source === 'googleOta') return s;
      const sf = {}, snf = [];
      for (const t of [cfg.myProperty, ...(cfg.competitors || [])]) {
        const hit = (s.hotels || []).find(h => inName(h.name, t));
        if (hit) sf[t] = hit; else snf.push(t);
      }
      const smine = sf[cfg.myProperty];
      const scomps = Object.entries(sf).filter(([k]) => k !== cfg.myProperty)
        .map(([k, h]) => ({ key: k, ...h, delta: smine ? h.price - smine.price : null }))
        .sort((a, b) => a.price - b.price);
      return { source: s.source, blocked: s.blocked || null, hotels: (s.hotels || []).filter(h => h.price).sort((a, b) => a.price - b.price), mine: smine, competitors: scomps, notFound: snf, undercut: scomps.filter(x => x.delta < 0) };
    });
    return { checkin: dr.checkin, checkout: dr.checkout, hotels: dr.hotels, mine, competitors: comps, notFound, undercut: comps.filter(x => x.delta < 0), sources };
  });

  for (const rep of reports) {
    try {
      fs.appendFileSync(path.join(__dirname, 'rates-history.jsonl'), JSON.stringify({ at: new Date().toISOString(), city, checkin: rep.checkin, checkout: rep.checkout, mode: r.mode, mine: rep.mine ? { name: rep.mine.name, price: rep.mine.priceUSD } : null, competitors: rep.competitors.map(x => ({ name: x.name, price: x.priceUSD })) }) + '\n');
    } catch (e) {}
  }

  console.log(JSON.stringify({
    mode: r.mode, city, checkDates: r.checkDates, fullScanPages: r.fullScanPages || 0, dest_id: r.dest,
    reports: reports.map(x => ({ checkin: x.checkin, checkout: x.checkout, totalHotelsOnPage: x.hotels.length, my: x.mine, competitors: x.competitors, notFound: x.notFound, undercut: x.undercut.map(c => c.name), sources: x.sources.map(s => ({ source: s.source, blocked: s.blocked || null, hotels: s.hotels ? s.hotels.length : 0, mine: s.mine, undercut: (s.undercut || []).map(c => c.name), targets: s.targets })) })),
    fullList: !hasComps,
  }, null, 2));

  const undCount = reports.filter(x => x.undercut.length).length;
  const firstMine = reports[0].mine;
  const subj = `[PriceWatch] ${city} ${reports[0].checkin}→${reports[reports.length - 1].checkout} · you ${firstMine ? '$' + firstMine.priceUSD : 'n/a'}${undCount ? ' ⚠' : ''}`;
  await sendEmail(subj, renderEmailHtml(runCfg, reports), core.buildCsv(runCfg, reports));
})().catch(e => { console.error('FATAL:', e.message); process.exit(/CAPTCHA/.test(e.message) ? 2 : 1); });
