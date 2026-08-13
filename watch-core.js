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

// ---------- browser lifecycle (persistent session = returning user = fewer challenges) ----------
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
  await page.goto('https://www.booking.com/index.en-gb.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);
  return page.evaluate(() => {
    const u = new URL(location.href);
    return { aid: u.searchParams.get('aid'), label: u.searchParams.get('label'), sid: u.searchParams.get('sid') };
  });
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
      const dest = await getDestId(page, slug, country);
      if (!dest) throw new Error('dest_id lookup failed');

      const dateRuns = [];
      const targets = [cfg.myProperty, ...(cfg.competitors || [])];
      const fullScan = opts.fullScan === true; // no competitors → crawl the whole place
      const maxScanPages = Math.max(2, Math.min(25, parseInt(cfg.maxScanPages || 12, 10)));
      let fullScanPages = 0;
      for (let di = 0; di < pairs.length; di++) {
        const p = pairs[di];
        const q = new URLSearchParams({
          ss: cfg.city, efdco: '1', lang: 'en-us', sb: '1', src_elem: 'sb', src: 'index',
          dest_id: dest, dest_type: 'city',
          checkin: p.checkin, checkout: p.checkout, group_adults: String(adults), no_rooms: '1', group_children: '0',
          selected_currency: cfg.currency || 'USD',
        });
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

        let hotels = [];
        if (fullScan && di === 0) {
          // FULL MARKET CRAWL: every page of results for the first date
          const seen = new Set();
          for (let pg = 0; pg < maxScanPages; pg++) {
            const batch = await loadPage(pg * 25);
            const fresh = batch.filter(h => !seen.has(norm(h.name)));
            for (const h of fresh) seen.add(norm(h.name));
            hotels.push(...fresh);
            fullScanPages = pg + 1;
            if (batch.length < 25 || fresh.length === 0) break; // last page
            await sleep(2000); // polite gap between pages
          }
        } else {
          hotels = await loadPage(0);
          if (di === 0) {
            const stillMissing = targets.filter(t => !hotels.some(h => inName(h.name, t)));
            if (stillMissing.length > 0) {
              try {
                const page2 = await loadPage(25);
                for (const h of page2) { if (!hotels.some(m => norm(m.name) === norm(h.name))) hotels.push(h); }
              } catch (e) {}
            }
          }
        }
        dateRuns.push({ checkin: p.checkin, checkout: p.checkout, hotels });
        await sleep(1500); // polite gap between dates
      }

      await saveState(context); // refresh session cookies
      await browser.close();
      return { dateRuns, dest, mode: mobile ? 'mobile' : 'desktop', nights, adults, checkDates, fullScanPages };
    } catch (e) {
      lastErr = e;
      if (browser) await browser.close().catch(() => {});
      if (/CAPTCHA/.test(e.message)) await sleep(5000 * (attempt + 1)); // backoff before next ladder rung
    }
  }
  throw lastErr || new Error('scrape failed');
}

module.exports = { scrape, buildNameIndex, launchBrowser, newContext, getDestId, getSession, slugify, norm, inName };
