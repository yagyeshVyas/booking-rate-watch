// ratewatch.js — CLI entry (also used by GitHub Actions). Uses ratewatch-core.
// Usage: node ratewatch.js --config config.json [--desktop] [--test-email]
//        node ratewatch.js --city "Las Vegas" --checkin 2026-09-01 --nights 2
const path = require('path');
const fs = require('fs');
const core = require('./ratewatch-core.js');

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const CONFIG_PATH = arg('--config') || path.join(__dirname, 'config.json');
const MOBILE = !args.includes('--desktop');
const TEST_EMAIL = args.includes('--test-email');

const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const city = arg('--city') || cfg.city;
const nights = parseInt(arg('--nights') || cfg.nights || 1, 10);
const checkin = arg('--checkin') || (() => { const d = new Date(Date.now() + (cfg.offsetDays ?? 1) * 86400000); return d.toISOString().slice(0, 10); })();

async function sendEmail(subject, text) {
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASS, to = process.env.EMAIL_TO || cfg.email?.to;
  if (!user || !pass || !to) { console.log('EMAIL_SKIPPED (set GMAIL_USER, GMAIL_APP_PASS, EMAIL_TO)'); return false; }
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
  await t.sendMail({ from: `"Rate Watch" <${user}>`, to, subject, text });
  console.log('EMAIL_SENT to', to);
  return true;
}

const inName = (h, t) => core.norm(h).includes(core.norm(t).slice(0, 24));

(async () => {
  if (TEST_EMAIL) { await sendEmail('Rate Watch test', 'Test email from Booking rate watch.'); return; }

  const runCfg = { ...cfg, city };
  console.error(`SCRAPE city=${city} checkin=${checkin} nights=${nights} mode=${MOBILE ? 'mobile' : 'desktop'}`);
  const r = await core.scrape(runCfg, { mobile: MOBILE, checkin });

  const found = {}, notFound = [];
  for (const t of [cfg.myProperty, ...(cfg.competitors || [])]) {
    const hit = r.hotels.find(h => inName(h.name, t));
    if (hit) found[t] = hit; else notFound.push(t);
  }
  const mine = found[cfg.myProperty];
  const comps = Object.entries(found).filter(([k]) => k !== cfg.myProperty)
    .map(([k, h]) => ({ name: k, ...h, delta: mine ? h.priceUSD - mine.priceUSD : null }))
    .sort((a, b) => a.priceUSD - b.priceUSD);
  const undercut = comps.filter(c => c.delta < 0);

  try {
    fs.appendFileSync(path.join(__dirname, 'rates-history.jsonl'), JSON.stringify({ at: new Date().toISOString(), city, checkin: r.checkin, checkout: r.checkout, mode: r.mode, mine: mine ? { name: mine.name, price: mine.priceUSD } : null, competitors: comps.map(c => ({ name: c.name, price: c.priceUSD })) }) + '\n');
  } catch (e) {}

  const dates = `${r.checkin} → ${r.checkout} (${nights} night${nights > 1 ? 's' : ''})`;
  console.log(JSON.stringify({
    mode: r.mode, city, dates, dest_id: r.dest, totalHotelsOnPage: r.hotels.length,
    my: mine, competitors: comps, notFound, undercut: undercut.map(c => c.name),
    cheapestCompetitor: comps[0] || null,
  }, null, 2));

  const lines = [`Booking.com ${r.mode.toUpperCase()} rates — ${city}, ${dates}`];
  lines.push(mine ? `YOUR PROPERTY: ${mine.name} — $${mine.priceUSD}` : `YOUR PROPERTY: NOT FOUND (check name "${cfg.myProperty}")`);
  lines.push(''); lines.push('COMPETITORS (cheapest first):');
  for (const c of comps) lines.push(`  $${c.priceUSD}  ${c.name}  (${c.delta === null ? 'n/a' : c.delta < 0 ? `$${-c.delta} CHEAPER` : c.delta === 0 ? 'same' : `$${c.delta} pricier`})`);
  if (notFound.length) lines.push(''); lines.push(`NOT FOUND: ${notFound.join(', ')}`);
  if (undercut.length) { lines.push(''); lines.push('⚠ ALERT — competitors under you:'); for (const c of undercut) lines.push(`  ${c.name} $${c.priceUSD} vs your $${mine.priceUSD}`); }
  else if (mine) { lines.push(''); lines.push('✅ You are the cheapest or tied among tracked hotels.'); }

  const subject = `[RateWatch] ${city} ${r.checkin} — ${mine ? '$' + mine.priceUSD : 'n/a'} vs comps ${comps[0] ? '$' + comps[0].priceUSD : 'n/a'}${undercut.length ? ' ⚠UNDERCUT' : ''}`;
  await sendEmail(subject, lines.join('\n'));
})().catch(e => { console.error('FATAL:', e.message); process.exit(/CAPTCHA/.test(e.message) ? 2 : 1); });
