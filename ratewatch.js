// ratewatch.js — Booking.com mobile-rate watcher: my property vs competitors, email every run.
// Free stack: Playwright (scraper) + Gmail SMTP app password (email) + GitHub Actions cron (schedule).
// Usage:
//   node ratewatch.js --config config.json [--desktop] [--test-email]
//   node ratewatch.js --city "Miami Beach" --checkin 2026-08-14 --nights 1   (quick one-off)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const CONFIG_PATH = arg('--config') || path.join(__dirname, 'config.json');
const MOBILE = !args.includes('--desktop');
const TEST_EMAIL = args.includes('--test-email');

// ---------------- config ----------------
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const CITY = arg('--city') || cfg.city;
const CHECKIN = arg('--checkin') || (() => { const d = new Date(Date.now() + (cfg.offsetDays ?? 1) * 86400000); return d.toISOString().slice(0, 10); })();
const NIGHTS = parseInt(arg('--nights') || cfg.nights || 1, 10);
const ADULTS = cfg.adults || 2;
const COUNTRY = cfg.country || 'us';
const SLUG = CITY.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const nextDay = (d) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
const CHECKOUT = nextDay(CHECKIN);

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
const inName = (hotelName, target) => norm(hotelName).includes(norm(target).slice(0, 24));

// ---------------- extractor ----------------
async function extractPage() {
  const cards = document.querySelectorAll('[data-testid="property-card"]');
  const out = [];
  for (const c of cards) {
    const nameEl = c.querySelector('[data-testid="title"]');
    const priceEl = c.querySelector('[data-testid="price-and-discounted-price"], [data-testid="genius-price"], .bui-price-display__value, span[aria-label*="price" i]');
    const scoreEl = c.querySelector('[data-testid="review-score"]');
    const linkEl = c.querySelector('a[href*="/hotel/"]');
    let price = null;
    if (priceEl) {
      const t = priceEl.textContent || '';
      let m = t.match(/US\$?\s?(\d{1,5}(?:,\d{3})*(?:\.\d{2})?)/);
      if (m) price = parseInt(m[1].replace(/,/g, ''), 10);
      else { m = t.match(/(\d{1,5}(?:,\d{3})*(?:\.\d{2})?)/); if (m) price = parseInt(m[1].replace(/,/g, ''), 10); }
    }
    if (nameEl && nameEl.textContent.trim()) {
      out.push({
        name: nameEl.textContent.trim().slice(0, 90),
        priceUSD: price,
        score: scoreEl ? scoreEl.textContent.trim().slice(0, 12) : null,
        url: linkEl ? linkEl.href.split('?')[0] : null,
      });
    }
  }
  const byName = {};
  for (const h of out) { if (!byName[h.name] || (h.priceUSD && h.priceUSD < byName[h.name].priceUSD)) byName[h.name] = h; }
  return Object.values(byName).filter(h => h.priceUSD).sort((a, b) => a.priceUSD - b.priceUSD);
}

// ---------------- scraper ----------------
async function scrape() {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'] });
  const context = await browser.newContext(MOBILE ? {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 3,
    isMobile: true, hasTouch: true, locale: 'en-GB', timezoneId: 'America/New_York',
    extraHTTPHeaders: { 'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"', 'sec-ch-ua-mobile': '?1', 'sec-ch-ua-platform': '"Android"' },
  } : {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 }, locale: 'en-US', timezoneId: 'America/Chicago',
    extraHTTPHeaders: { 'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"' },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    if (!window.chrome) window.chrome = { runtime: {} };
  });
  const page = await context.newPage();
  const errs = [];
  try {
    // session
    await page.goto('https://www.booking.com/index.en-gb.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    const sess = await page.evaluate(() => { const u = new URL(location.href); return { aid: u.searchParams.get('aid'), label: u.searchParams.get('label'), sid: u.searchParams.get('sid') }; });

    // dest_id (retry)
    let dest = null;
    for (let i = 0; i < 4 && !dest; i++) {
      dest = await page.evaluate(async ({ SLUG }) => {
        try {
          const r = await fetch(`https://www.booking.com/city/${'us'}/${SLUG}.en-gb.html`, { credentials: 'include' });
          if (!r.ok) return null;
          const html = await r.text();
          const m = html.match(/dest_id=(-?\d+)/) || html.match(/"dest_id":(-?\d+)/);
          return m ? m[1] : null;
        } catch (e) { return null; }
      }, { SLUG });
      if (!dest) await page.waitForTimeout(2500);
    }
    if (!dest) throw new Error('dest_id lookup failed');

    // results
    const q = new URLSearchParams({
      ss: CITY, efdco: '1', lang: 'en-us', sb: '1', src_elem: 'sb', src: 'index',
      dest_id: dest, dest_type: 'city',
      checkin: CHECKIN, checkout: CHECKOUT, group_adults: String(ADULTS), no_rooms: '1', group_children: '0',
      selected_currency: 'USD',
    });
    if (sess.aid) q.set('aid', sess.aid);
    if (sess.label) q.set('label', sess.label);
    if (sess.sid) q.set('sid', sess.sid);
    await page.goto(`https://www.booking.com/searchresults.html?${q.toString()}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try { await page.locator('#onetrust-accept-btn-handler').first().click({ timeout: 5000, force: true }); } catch (e) {}

    // wait for REAL cards (avoid data-hotelid placeholders)
    try { await page.waitForSelector('[data-testid="property-card"]', { timeout: 25000 }); }
    catch (e) {
      const body = await page.evaluate(() => document.body.innerText.slice(0, 300));
      if (/captcha|are you human|unusual traffic/i.test(body)) throw new Error('CAPTCHA_BLOCKED');
      throw new Error('NO_CARDS: ' + body.slice(0, 120));
    }

    // poll until prices settle (async render)
    let hotels = [];
    for (let i = 0; i < 6 && hotels.length === 0; i++) {
      await page.waitForTimeout(2000);
      hotels = await page.evaluate(extractPage);
    }

    // page 2 if some targets still missing
    const stillMissing = [cfg.myProperty, ...(cfg.competitors || [])].filter(t => !hotels.some(h => inName(h.name, t)));
    if (stillMissing.length > 0) {
      const url2 = `https://www.booking.com/searchresults.html?${q.toString()}&offset=25`;
      await page.goto(url2, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);
      const page2 = await page.evaluate(extractPage);
      const merged = [...hotels];
      for (const h of page2) { if (!merged.some(m => norm(m.name) === norm(h.name))) merged.push(h); }
      hotels = merged;
      console.error('PAGE2_FETCHED:', stillMissing.length, 'targets missing, got', page2.length, 'more hotels');
    }
    return { hotels, dest, resultsUrl: page.url().split('?')[0] };
  } finally {
    await browser.close();
  }
}

// ---------------- report ----------------
function buildReport(hotels) {
  const targets = [cfg.myProperty, ...(cfg.competitors || [])];
  const found = {}, notFound = [];
  for (const t of targets) {
    const hit = hotels.find(h => inName(h.name, t));
    if (hit) found[t] = hit; else notFound.push(t);
  }
  const mine = found[cfg.myProperty];
  const comps = Object.entries(found).filter(([k]) => k !== cfg.myProperty)
    .map(([k, h]) => ({ name: k, hotel: h, delta: mine ? h.priceUSD - mine.priceUSD : null }))
    .sort((a, b) => a.hotel.priceUSD - b.hotel.priceUSD);
  const undercut = comps.filter(c => c.delta < 0);
  return {
    my: mine || null, competitors: comps, notFound,
    undercutBy: undercut,
    cheapest: comps[0] || null,
  };
}

function renderEmail(r, city, dates) {
  const L = [];
  L.push(`Booking.com MOBILE rates — ${city}, ${dates}`);
  L.push(`Scraped ${new Date().toISOString()} (UTC)`);
  L.push('');
  if (r.my) L.push(`YOUR PROPERTY: ${r.my.name} — $${r.my.priceUSD}${r.my.score ? ' · ' + r.my.score : ''}`);
  else L.push(`YOUR PROPERTY: NOT FOUND on page 1 (check config name: "${cfg.myProperty}")`);
  L.push('');
  L.push('COMPETITORS (mobile rates, cheapest first):');
  for (const c of r.competitors) {
    const d = c.delta === null ? 'n/a' : (c.delta === 0 ? '= same' : (c.delta < 0 ? `$${-c.delta} CHEAPER than you` : `$${c.delta} pricier`));
    L.push(`  $${c.hotel.priceUSD}  ${c.hotel.name}  (${d})`);
  }
  if (r.notFound.length) L.push(''); L.push(`NOT FOUND on page 1: ${r.notFound.join(', ')}`);
  if (r.undercutBy.length) {
    L.push(''); L.push('⚠️ ALERT: competitors UNDER you right now:');
    for (const c of r.undercutBy) L.push(`  ${c.name} — $${c.hotel.priceUSD} vs your $${r.my.priceUSD} (${c.delta < 0 ? '$' + (-c.delta) : ''} below)`);
  } else if (r.my) { L.push(''); L.push('✅ You are the cheapest or tied among tracked hotels.'); }
  L.push(''); L.push('Powered by free Booking rate-watch (Playwright + GitHub Actions). Prices are per night for ' + cfg.adults + ' adults, standard rate, as shown on Booking mobile.');
  return L.join('\n');
}

// ---------------- email ----------------
async function sendEmail(subject, text) {
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASS, to = process.env.EMAIL_TO || cfg.email?.to;
  if (!user || !pass || !to) { console.log('EMAIL_SKIPPED (set GMAIL_USER, GMAIL_APP_PASS, EMAIL_TO)'); return false; }
  const nodemailer = require('nodemailer');
  const t = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } });
  await t.sendMail({ from: `"Rate Watch" <${user}>`, to, subject, text });
  console.log('EMAIL_SENT to', to);
  return true;
}

// ---------------- history (best-effort, for trend) ----------------
function appendHistory(report, hotels) {
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), city: CITY, checkin: CHECKIN, checkout: CHECKOUT, mode: MOBILE ? 'mobile' : 'desktop', mine: report.my ? { name: report.my.name, price: report.my.priceUSD } : null, competitors: report.competitors.map(c => ({ name: c.hotel.name, price: c.hotel.priceUSD })) });
    fs.appendFileSync(path.join(__dirname, 'rates-history.jsonl'), line + '\n');
  } catch (e) { console.error('HISTORY_WARN:', e.message); }
}

// ---------------- main ----------------
(async () => {
  if (TEST_EMAIL) {
    await sendEmail('Rate Watch test', 'Test email from Booking rate watch. If you see this, Gmail SMTP works.');
    return;
  }
  console.error(`SCRAPE city=${CITY} checkin=${CHECKIN} nights=${NIGHTS} mode=${MOBILE ? 'mobile' : 'desktop'}`);
  const { hotels, dest } = await scrape();
  const r = buildReport(hotels);
  appendHistory(r, hotels);
  const dates = `${CHECKIN} → ${CHECKOUT} (${NIGHTS} night${NIGHTS > 1 ? 's' : ''})`;
  const summary = {
    mode: MOBILE ? 'mobile' : 'desktop',
    city: CITY, dates, dest_id: dest,
    totalHotelsOnPage: hotels.length,
    my: r.my, competitors: r.competitors, notFound: r.notFound,
    undercut: r.undercutBy.map(c => c.name),
    cheapestCompetitor: r.cheapest ? r.cheapest.hotel : null,
  };
  console.log(JSON.stringify(summary, null, 2));
  const subject = `[RateWatch] ${CITY} ${dates} — ${r.my ? '$' + r.my.priceUSD : 'no data'} vs comps ${r.cheapest ? '$' + r.cheapest.hotel.priceUSD : 'n/a'}${r.undercutBy.length ? ' ⚠UNDERCUT' : ''}`;
  await sendEmail(subject, renderEmail(r, CITY, dates));
})().catch(e => { console.error('FATAL:', e.message); process.exit(e.message.includes('CAPTCHA') ? 2 : 1); });
