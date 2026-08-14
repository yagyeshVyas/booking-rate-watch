// watch-core.js — shared engine: stealth browser, session persistence, scraping,
// dest_id lookup, property-name index. No deps beyond playwright. Used by server.js (dashboard)
// and watch.js (CLI / GitHub Actions).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const STEALTH_SCRIPT = () => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  if (!window.chrome) window.chrome = { runtime: {} };
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  const origQ = window.navigator.permissions && window.navigator.permissions.query;
  if (origQ) {
    window.navigator.permissions.query = (p) => p.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission }) : origQ(p);
  }
};

function mobileContextOpts() {
  return {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    viewport: { width: 412, height: 915 }, deviceScaleFactor: 3,
    isMobile: true, hasTouch: true, locale: 'en-GB', timezoneId: 'America/New_York',
    extraHTTPHeaders: { 'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"', 'sec-ch-ua-mobile': '?1', 'sec-ch-ua-platform': '"Android"' },
  };
}
function desktopContextOpts() {
  return {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 }, locale: 'en-US', timezoneId: 'America/Chicago',
    extraHTTPHeaders: { 'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"', 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"' },
  };
}

const STATE_FILE = path.join(__dirname, 'session-state.json');
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const humanizeSlug = (s) => s.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const decodeHtml = (s) => s.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');

// ---------- geo index (countries + all Booking cities) — pure Node, no browser ----------
const GEO_FILE = path.join(__dirname, 'geo-index.json');

async function buildGeoIndex() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  const H = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml,*/*', 'Accept-Language': 'en-GB,en;q=0.9', 'Accept-Encoding': 'gzip, deflate' };
  const get = async (url) => { const r = await fetch(url, { headers: H }); if (!r.ok) throw new Error('HTTP ' + r.status); return r; };

  const countries = [];
  try {
    const html = await (await get('https://www.booking.com/country.en-gb.html')).text();
    const re = /href="\/country\/([a-z]{2})(?:\.en-gb)?\.html[^"]*"[^>]*>\s*([^<]{2,60}?)\s*<\/a>/g;
    const seen = new Set(); let m;
    while ((m = re.exec(html))) {
      const code = m[1], name = decodeHtml(m[2].trim());
      if (!seen.has(code)) { seen.add(code); countries.push({ code, name }); }
    }
  } catch (e) { console.error('GEO countries failed:', e.message); }

  const cities = [];
  try {
    const zlib = require('zlib');
    const idx = await (await get('https://www.booking.com/sitembk-city-index.xml')).text();
    const files = [...idx.matchAll(/<loc>(https:\/\/www\.booking\.com\/sitembk-city-sl\.[0-9]+\.xml\.gz)<\/loc>/g)].map(m => m[1]);
    for (const f of files) {
      const buf = Buffer.from(await (await get(f)).arrayBuffer());
      const xml = zlib.gunzipSync(buf).toString('utf8');
      const re = /city\/([a-z]{2})\/([a-z0-9-]+)\.sl\.html/g;
      let m;
      while ((m = re.exec(xml))) cities.push({ cc: m[1], slug: m[2] });
      await sleep(400);
    }
  } catch (e) { console.error('GEO cities failed:', e.message); }

  // dedupe
  const seen = new Set(); const uniqCities = [];
  for (const c of cities) { const k = c.cc + '/' + c.slug; if (!seen.has(k)) { seen.add(k); uniqCities.push(c); } }
  return { countries, cities: uniqCities };
}

// ---------- multi-source adapters (Booking is the primary; extras attach per date) ----------
const SOURCES = {
  booking: { label: 'Booking.com', live: true, note: 'mobile rates, full market scan' },
  google: { label: 'Google Hotels', live: true, note: 'free web prices, no login' },
  expedia: { label: 'Expedia', live: false, note: 'Akamai "Bot or Not?" wall — automation blocked without paid bypass' },
  trivago: { label: 'Trivago', live: false, note: 'consent shell only, no prices exposed to automation' },
  agoda: { label: 'Agoda', live: false, note: 'needs per-city id resolution — not wired yet' },
  kayak: { label: 'KAYAK', live: false, note: 'destination codes blocked from automation' },
};

// Google Hotels: prices sit in aria-labels ("$137 for dates Aug 17 – 18"); hotel names
// are the first title-case text block in the card's ancestor chain.
async function scrapeGoogle(page, { city, checkin, checkout, adults, currency }) {
  const q = new URLSearchParams({ q: city, check_in: checkin, check_out: checkout, adults: String(adults || 2), hl: 'en', gl: 'us', currency: currency || 'USD' });
  await page.goto('https://www.google.com/travel/hotels?' + q.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(r => setTimeout(r, 5000));
  try { await page.locator('button:has-text("Accept all")').first().click({ timeout: 4000, force: true }); await new Promise(r => setTimeout(r, 2500)); } catch (e) {}
  try { await page.waitForSelector('[aria-label*="$"]', { timeout: 25000 }); } catch (e) {
    throw new Error('GOOGLE_NO_PRICES: ' + (await page.evaluate(() => document.body.innerText.slice(0, 120))));
  }
  let hotels = [];
  for (let i = 0; i < 6 && hotels.length < 5; i++) {
    await sleep(2000);
    hotels = await page.evaluate(() => {
      const HEAD = 'h1,h2,h3,h4,div[role="heading"]';
      const out = []; const seen = new Set();
      for (const head of document.querySelectorAll(HEAD)) {
        const name = (head.innerText || '').trim();
        if (name.length < 3 || name.length > 60) continue;
        if (/^(Hotels|Results|Explore|Flights|Vacation|View|See|More|All|Price|Filter|Sort|Nearby|Top)/i.test(name) || /^\d+/.test(name)) continue;
        let price = null, url = null, el = head;
        // entity URL: heading's own anchor, else search ancestors for an entity link
        let a = head.closest('a');
        if (!a || !/entity/i.test(a.href || '')) {
          let el2 = head.parentElement;
          for (let i = 0; i < 5 && el2 && !url; i++) {
            const found = el2.querySelector ? el2.querySelector('a[href*="entity"]') : null;
            if (found) url = found.href;
            el2 = el2.parentElement;
          }
        } else {
          url = a.href;
        }
        for (let d2 = 0; d2 < 5 && el; d2++) {
          el = el.parentElement; if (!el) continue;
          const m = (el.innerText || '').match(/\$(\d{2,4})/);
          if (m) { price = +m[1]; break; }
        }
        if (price === null) continue;
        const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (seen.has(key)) continue; seen.add(key);
        out.push({ name, price, url });
      }
      return out;
    });
  }
  return { source: 'google', hotels };
}

async function scrapeSource(source, page, cfg, { checkin, checkout, adults }) {
  switch (source) {
    case 'google':
      return await scrapeGoogle(page, { city: cfg.city, checkin, checkout, adults, currency: cfg.currency || 'USD' });
    case 'expedia': return { source, blocked: SOURCES.expedia.note, hotels: [] };
    case 'trivago': return { source, blocked: SOURCES.trivago.note, hotels: [] };
    case 'agoda': return { source, blocked: SOURCES.agoda.note, hotels: [] };
    case 'kayak': return { source, blocked: SOURCES.kayak.note, hotels: [] };
    default: return { source, blocked: 'unknown source', hotels: [] };
  }
}

// Google Hotels per-OTA price comparison (the "All options" list inside the property modal).
// Path: search page → click the property card's price chip → modal opens with the OTA list
// ("<Site>\n$price" lines after the "All options" header). The search URL is derived from
// the entity URL (same q/check_in/check_out params, path replaced).
async function scrapeGoogleOta(page, entityHref, adults, targets) {
  // rebuild a CLEAN search URL from the entity URL (extra params change the page variant)
  const src = new URL(entityHref);
  const clean = new URL('https://www.google.com/travel/hotels');
  for (const k of ['q', 'check_in', 'check_out', 'adults', 'hl', 'gl', 'currency']) {
    const v = src.searchParams.get(k);
    if (v) clean.searchParams.set(k, v);
  }
  if (!clean.searchParams.get('adults')) clean.searchParams.set('adults', String(adults || 2));
  await page.goto(clean.toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(r => setTimeout(r, 6000));
  try { await page.locator('button:has-text("Accept all")').first().click({ timeout: 4000, force: true }); await new Promise(r => setTimeout(r, 2000)); } catch (e) {}
  // open the property modal by clicking its price chip
  const opened = await page.evaluate((targetName) => {
    const HEAD = 'h1,h2,h3,h4,div[role="heading"]';
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const want = norm(targetName).slice(0, 20);
    for (const head of document.querySelectorAll(HEAD)) {
      const name = String(head.innerText || '').trim();
      if (!name || name.length > 60) continue;
      if (!norm(name).includes(want) && !want.includes(norm(name).slice(0, 12))) continue;
      let card = head;
      for (let i = 0; i < 5 && card; i++) {
        card = card.parentElement; if (!card) break;
        const priceEl = [...card.querySelectorAll('[aria-label*="$"], [role="button"]')].find(e => /\$\d{2,4}/.test((e.getAttribute('aria-label') || '') + ' ' + (e.innerText || '')));
        if (priceEl) { priceEl.click(); return true; }
      }
    }
    return false;
  }, targets);
  await new Promise(r => setTimeout(r, 4500));
  if (!opened) {
    // fallback: direct entity page → click Prices tab
    await page.goto(entityHref, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));
    await page.evaluate(() => {
      const els = [...document.querySelectorAll('[role="tab"],button,[jsaction]')];
      const el = els.find(e => (e.innerText || '').trim() === 'Prices');
      if (el) el.click();
    });
    await new Promise(r => setTimeout(r, 3000));
  }
  const pairs = await page.evaluate(() => {
    const txt = document.body.innerText;
    const re = /^([^\n]{2,44})\n[^\n]{0,34}\$(\d{2,4})/gm;
    const out = []; let m;
    while ((m = re.exec(txt))) out.push([m[1].trim(), +m[2]]);
    return out;
  });
  // pairs: [property, $X] then OTAs (site-ish names); skip the property, keep OTA names,
  // stop at hotel-word names (similar-hotels section)
  const OTA_RE = /\.com$|\.net$|^official site$|priceline|orbitz|travelocity|cheaptickets|hotwire|agoda|kayak|snaptravel|getaroom|goseek|dealbase|hotels\s+in\s+america|^trip\.com/i;
  const out = [];
  const seen = new Set();
  for (let i = 1; i < pairs.length; i++) {
    const [name, price] = pairs[i];
    if (OTA_RE.test(name)) {
      const k = name.toLowerCase();
      if (!seen.has(k)) { seen.add(k); out.push({ ota: name, price }); }
    } else if (/hotel|inn|resort|lodge|suites|motel|place/i.test(name)) break;
  }
  return out;
}
async function launchBrowser(stealth = true) {
  const opts = { args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'] };
  if (!stealth) opts.headless = false; // headful fallback for stubborn challenges (local runs)
  try {
    return await chromium.launch({ ...opts, channel: 'chromium' }); // full chromium, new headless
  } catch (e) {
    return await chromium.launch(opts); // fallback to bundled headless shell
  }
}

async function newContext(browser, mobile, storageState) {
  const opts = mobile ? mobileContextOpts() : desktopContextOpts();
  if (storageState) opts.storageState = storageState;
  const context = await browser.newContext(opts);
  await context.addInitScript(STEALTH_SCRIPT);
  return context;
}

async function saveState(context) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(await context.storageState())); } catch (e) {}
}

// ---------- session + dest_id (same proven recipe, retries) ----------
async function getSession(page, country) {
  let sess = null;
  for (let i = 0; i < 3; i++) {
    await page.goto('https://www.booking.com/index.en-gb.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    sess = await page.evaluate(() => {
      const u = new URL(location.href);
      return { aid: u.searchParams.get('aid'), label: u.searchParams.get('label'), sid: u.searchParams.get('sid') };
    });
    if (sess.label || sess.aid || sess.sid) break; // session params issued (fresh sessions need the redirect)
    await sleep(2000);
  }
  return sess;
}

async function getDestId(page, slug, country) {
  for (let i = 0; i < 4; i++) {
    try {
      const id = await page.evaluate(async ({ slug, country }) => {
        const r = await fetch(`https://www.booking.com/city/${country}/${slug}.en-gb.html`, { credentials: 'include' });
        if (!r.ok) return null;
        const html = await r.text();
        const m = html.match(/dest_id=(-?\d+)/) || html.match(/"dest_id":(-?\d+)/);
        return m ? m[1] : null;
      }, { slug, country });
      if (id) return id;
    } catch (e) {}
    await sleep(2500);
  }
  return null;
}

// resolve a destination to {dest_id, dest_type}: tries CITY page then REGION page.
// Uses the PAIRED "dest_id":N,"dest_type":"X" JSON (the page's own identity) — pages embed
// many other destinations' ids (promos), so a bare first-match regex grabs wrong ids.
// Rejects garbage ids (Booking's not-found template embeds dest_id=224 etc.)
async function resolveDest(page, city, country) {
  const slug = slugify(city);
  const candidates = [
    { type: 'city', url: `https://www.booking.com/city/${country}/${slug}.en-gb.html` },
    { type: 'region', url: `https://www.booking.com/region/${country}/${slug}.en-gb.html` },
  ];
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const cand of candidates) {
      try {
        const found = await page.evaluate(async ({ url }) => {
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) return null;
          const html = await res.text();
          const pairs = [...html.matchAll(/"dest_id":(-?\d+),"dest_type":"(city|region)"/g)];
          if (pairs.length) return { id: pairs[0][1], type: pairs[0][2] };
          const m = html.match(/dest_id=(-?\d+)/);
          return m ? { id: m[1], type: null } : null;
        }, { url: cand.url });
        if (found && found.id && /^\d{4,}$/.test(found.id)) {
          return { dest_id: found.id, dest_type: found.type || cand.type };
        }
      } catch (e) {}
    }
    await sleep(2000);
  }
  return null;
}

// ---------- property name index (city page alts + optional deeper crawl) ----------
async function buildNameIndex(page, slug, country, deep = false) {
  const names = new Map(); // name -> slug
  try {
    await page.evaluate(async ({ slug, country }) => {
      await fetch(`https://www.booking.com/city/${country}/${slug}.en-gb.html`, { credentials: 'include' });
    }, { slug, country });
  } catch (e) {}
  // city page: names live in img alt="<Name>, hotel in <City>" and nearby anchors
  const fromCity = await page.evaluate(async ({ slug, country }) => {
    const r = await fetch(`https://www.booking.com/city/${country}/${slug}.en-gb.html`, { credentials: 'include' });
    if (!r.ok) return { alts: [], anchors: [] };
    const html = await r.text();
    const alts = [...html.matchAll(/alt="([^"]{3,100}?)(?:, (?:hotel|apartments?|hostel|resort|villa)[^"]*)?"/gi)]
      .map(m => m[1].trim()).filter(n => n.length > 3 && !/^\d+$/.test(n));
    const anchors = [...html.matchAll(/href="https:\/\/www\.booking\.com\/hotel\/[a-z]{2}\/([a-z0-9-]+)\.html/g)]
      .map(m => m[1]);
    return { alts, anchors: [...new Set(anchors)] };
  }, { slug, country });
  for (const n of fromCity.alts) {
    if (n.length > 3 && !names.has(n)) names.set(decodeHtml(n), humanizeSlug(n));
  }
  for (const a of fromCity.anchors) {
    if (![...names.keys()].some(n => norm(n) === norm(humanizeSlug(a)))) {
      names.set(humanizeSlug(a), a);
    }
  }
  // deep mode: paginate searchresults to enrich the index
  if (deep) {
    const sess = await page.evaluate(() => { const u = new URL(location.href); return { aid: u.searchParams.get('aid'), label: u.searchParams.get('label'), sid: u.searchParams.get('sid') }; }).catch(() => ({}));
    const dest = await getDestId(page, slug, country);
    if (dest) {
      for (const offset of [0, 25, 50, 75]) {
        try {
          const q = new URLSearchParams({ ss: slug, efdco: '1', lang: 'en-us', sb: '1', src_elem: 'sb', src: 'index', dest_id: dest, dest_type: 'city', checkin: '2099-01-01', checkout: '2099-01-02', group_adults: '2', no_rooms: '1', group_children: '0', selected_currency: 'USD' });
          if (sess.aid) q.set('aid', sess.aid);
          if (sess.label) q.set('label', sess.label);
          if (sess.sid) q.set('sid', sess.sid);
          if (offset) q.set('offset', String(offset));
          await page.goto(`https://www.booking.com/searchresults.html?${q.toString()}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForSelector('[data-testid="property-card"]', { timeout: 20000 }).catch(() => {});
          await sleep(2000);
          const cards = await page.evaluate(() => [...document.querySelectorAll('[data-testid="property-card"]')].map(c => {
            const n = c.querySelector('[data-testid="title"]');
            const a = c.querySelector('a[href*="/hotel/"]');
            return { n: n ? n.textContent.trim() : null, h: a ? a.href.split('?')[0] : null };
          }));
          for (const c of cards) {
            if (c.n && !names.has(c.n)) names.set(decodeHtml(c.n), (c.h || '').split('/').pop().replace('.html', ''));
          }
        } catch (e) {}
        await sleep(1500);
      }
    }
  }
  return [...names.entries()].map(([name, slug]) => ({ name, slug }));
}

// ---------- CSV export (multi-date × multi-source, attached to every email) ----------
function csvCell(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function buildCsv(cfg, reports) {
  const lines = ['date,source,site,property,price,score,url'];
  for (const r of reports || []) {
    for (const h of r.hotels || []) {
      lines.push([r.checkin, 'booking', '', h.name, h.priceUSD ?? '', h.score || '', h.url || ''].map(csvCell).join(','));
    }
    for (const s of r.sources || []) {
      if (s.source === 'googleOta') {
        for (const t of s.targets || []) {
          for (const o of t.ota || []) {
            lines.push([r.checkin, 'google-ota', o.ota, t.target, o.price, '', ''].map(csvCell).join(','));
          }
        }
      } else if (!s.blocked && s.hotels && s.hotels.length) {
        for (const h of s.hotels) {
          lines.push([r.checkin, s.source, '', h.name, h.price ?? '', '', h.url || ''].map(csvCell).join(','));
        }
      }
    }
  }
  return lines.join('\n');
}

// ---------- scrape (proven recipe + retry ladder) ----------
const inName = (hotelName, target) => norm(hotelName).includes(norm(target).slice(0, 24));

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

async function scrape(cfg, opts = {}) {
  const mobile = opts.mobile !== false;
  const stealth = opts.stealth !== false;
  const country = cfg.country || 'us';
  const slug = slugify(cfg.city);
  const nights = cfg.nights || 1;
  const adults = cfg.adults || 2;
  // rolling date window: startDaysFromToday → endDaysFromToday (auto-updates with today)
  const startDays = Math.max(0, parseInt(cfg.startDaysFromToday ?? cfg.offsetDays ?? 1, 10));
  let endDays = parseInt(cfg.endDaysFromToday, 10);
  if (isNaN(endDays)) endDays = startDays + Math.max(1, Math.min(30, parseInt(cfg.checkDates || 1, 10))) - 1;
  endDays = Math.max(endDays, startDays);
  const checkDates = Math.min(30, endDays - startDays + 1);
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const base = opts.checkin || (() => { const d = new Date(Date.now() + startDays * 86400000); return d.toISOString().slice(0, 10); })();
  // date pairs to check: from base, checkDates consecutive stays
  const pairs = [];
  for (let i = 0; i < checkDates; i++) {
    const ci = addDays(base, i);
    pairs.push({ checkin: ci, checkout: addDays(ci, nights) });
  }

  const attempts = stealth ? [true, true, false] : [true]; // ladder: stealth → headful local
  let lastErr = null;
  for (let attempt = 0; attempt < attempts.length; attempt++) {
    const headful = attempts[attempt] === false;
    let browser = null, context = null;
    try {
      browser = await launchBrowser(stealth && !headful);
      const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : undefined;
      context = await newContext(browser, mobile, state);
      const page = await context.newPage();
      const sess = await getSession(page, country);
      const destInfo = await resolveDest(page, cfg.city, country);
      if (!destInfo) throw new Error(`DEST_NOT_FOUND for "${cfg.city}" — Booking couldn't find it. Check the exact spelling (e.g. "Outer Banks" instead of "outerbanks") or pick it from the city list in the dashboard.`);
      const dest = destInfo.dest_id;

      const dateRuns = [];
      const targets = [cfg.myProperty, ...(cfg.competitors || [])];
      const fullScan = opts.fullScan === true; // no competitors → crawl the whole place
      const maxScanPages = Math.max(2, Math.min(25, parseInt(cfg.maxScanPages || 12, 10)));
      let fullScanPages = 0;
      let destActive = true; // set false → ss-only URL (Booking geocodes the name itself)
      let bookingFailed = null;
      for (let di = 0; di < pairs.length; di++) {
        const p = pairs[di];
        const q = new URLSearchParams({
          ss: cfg.city, efdco: '1', lang: 'en-us', sb: '1', src_elem: 'sb', src: 'index',
          checkin: p.checkin, checkout: p.checkout, group_adults: String(adults), no_rooms: '1', group_children: '0',
          selected_currency: cfg.currency || 'USD',
        });
        if (destActive) { q.set('dest_id', dest); q.set('dest_type', destInfo.dest_type); }
        if (fullScan && di === 0) q.set('order', 'bayesian_review_score'); // default stable sort — mobile paginates reliably on it
        if (sess.aid) q.set('aid', sess.aid);
        if (sess.label) q.set('label', sess.label);
        if (sess.sid) q.set('sid', sess.sid);

        const loadPage = async (offset) => {
          const u = `https://www.booking.com/searchresults.html?${q.toString()}${offset ? '&offset=' + offset : ''}`;
          await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 60000 });
          try { await page.locator('#onetrust-accept-btn-handler').first().click({ timeout: 5000, force: true }); } catch (e) {}
          try {
            await page.waitForSelector('[data-testid="property-card"]', { timeout: 25000 });
          } catch (e) {
            const body = await page.evaluate(() => document.body.innerText.slice(0, 300));
            if (/captcha|are you human|unusual traffic/i.test(body)) throw new Error('CAPTCHA_BLOCKED');
            throw new Error('NO_CARDS: ' + body.slice(0, 120));
          }
          let hotels = [];
          for (let i = 0; i < 6 && hotels.length === 0; i++) { await sleep(2000); hotels = await page.evaluate(extractPage); }
          if (hotels.length === 0 && offset === 0) throw new Error('PRICES_NOT_RENDERED');
          return hotels;
        };

        const loadFirstDate = async () => {
          if (fullScan) {
            // FULL MARKET CRAWL: every page of results for the first date
            const seen = new Set();
            let hotels = [];
            for (let pg = 0; pg < maxScanPages; pg++) {
              const batch = await loadPage(pg * 25);
              const fresh = batch.filter(h => !seen.has(norm(h.name)));
              for (const h of fresh) seen.add(norm(h.name));
              hotels.push(...fresh);
              fullScanPages = pg + 1;
              if (batch.length < 25 || fresh.length === 0) break; // last page
              await sleep(2000); // polite gap between pages
            }
            return hotels;
          }
          let hotels = await loadPage(0);
          const stillMissing = targets.filter(t => !hotels.some(h => inName(h.name, t)));
          if (stillMissing.length > 0) {
            try {
              const page2 = await loadPage(25);
              for (const h of page2) { if (!hotels.some(m => norm(m.name) === norm(h.name))) hotels.push(h); }
            } catch (e) {}
          }
          return hotels;
        };

        let hotels = [];
        let dateBookingError = null;
        try {
          if (di === 0) {
            hotels = await loadFirstDate();
            if (hotels.length === 0 && destActive) {
              destActive = false;
              q.delete('dest_id'); q.delete('dest_type');
              console.error('DEST_RETRY_SS_ONLY for "' + cfg.city + '"');
              hotels = await loadFirstDate();
            }
          } else {
            hotels = await loadPage(0);
          }
        } catch (e) {
          // load error (NO_CARDS / CAPTCHA / PRICES_NOT_RENDERED) — retry ONCE without dest_id
          if (destActive && di === 0) {
            destActive = false;
            q.delete('dest_id'); q.delete('dest_type');
            console.error('BOOKING_RETRY_SS_ONLY after ' + e.message.slice(0, 60));
            try { hotels = await loadFirstDate(); } catch (e2) { dateBookingError = e2.message; }
          } else {
            dateBookingError = e.message;
          }
          if (!bookingFailed) bookingFailed = dateBookingError || e.message;
          if (dateBookingError) console.error('BOOKING_FAILED date ' + p.checkin + ': ' + dateBookingError);
        }
        // extra sources (Google Hotels etc.) — one lightweight load per date
        const extra = [];
        for (const src of opts.sources || cfg.sources || []) {
          if (src === 'booking') continue;
          try {
            const r = await scrapeSource(src, page, cfg, { checkin: p.checkin, checkout: p.checkout, adults });
            extra.push(r);
          } catch (e) { extra.push({ source: src, blocked: e.message.slice(0, 120), hotels: [] }); }
          await sleep(1500);
        }
        // per-OTA price comparison for tracked properties (Google "All options" panel) — first date only
        if (di === 0 && (cfg.otaCompare !== false)) {
          const g = extra.find(s => s.source === 'google' && s.hotels);
          const otaCompare = [];
          for (const t of targets) {
            const h = g && g.hotels.find(h => inName(h.name, t));
            if (h && h.url) {
              try {
                const ota = await scrapeGoogleOta(page, h.url, adults, t);
                otaCompare.push({ target: t, ota });
              } catch (e) { otaCompare.push({ target: t, ota: [], error: e.message.slice(0, 80) }); }
            } else {
              console.error('OTA_SKIP target=' + t + (h ? ' (no entity url)' : ' (not in google results)'));
            }
          }
          if (otaCompare.length) extra.push({ source: 'googleOta', targets: otaCompare, hotels: [] });
        }
        dateRuns.push({ checkin: p.checkin, checkout: p.checkout, hotels, sources: extra, bookingError: dateBookingError });
        await sleep(1500); // polite gap between dates
      }

      await saveState(context); // refresh session cookies
      await browser.close();
      if (!dateRuns.length) throw lastErr || new Error('scrape failed');
      return { dateRuns, dest, mode: mobile ? 'mobile' : 'desktop', nights, adults, checkDates, fullScanPages, bookingError: bookingFailed };
    } catch (e) {
      lastErr = e;
      if (browser) await browser.close().catch(() => {});
      if (/CAPTCHA/.test(e.message)) await sleep(5000 * (attempt + 1)); // backoff before next ladder rung
    }
  }
  throw lastErr || new Error('scrape failed');
}

module.exports = { scrape, scrapeSource, scrapeGoogleOta, buildCsv, SOURCES, buildNameIndex, buildGeoIndex, GEO_FILE, STATE_FILE, resolveDest, getDestId, launchBrowser, newContext, getSession, slugify, norm, inName, humanizeSlug };
