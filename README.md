# Price Watch — free mobile-rate competitor tracker + dashboard

Scrapes **Booking.com mobile rates** for your property + competitors and **emails you every 5 hours**.
100% free: Playwright (scraper) + Gmail SMTP app password (email) + GitHub Actions cron (runs online, 24/7).
Includes a **local management dashboard** where you control everything visually.

## 🖥 The dashboard (manage everything visually)

Double-click **`start.bat`** → opens `http://127.0.0.1:5180`

| Tab | What you manage |
|---|---|
| **Overview** | Stats, last run, quick actions |
| **Settings** | 📧 email (from / app password / to) · 📍 city + country + currency · dates (days ahead + nights + adults) · 🛡 mobile-only toggle + stealth toggle |
| **Properties** | Your property + competitors with **live autocomplete** — type a letter and matching Booking property names appear instantly (index built from Booking's own pages for your city) |
| **Run & Results** | One-click live scrape → table: your price, each competitor, delta vs you, ⚠ undercut alerts |
| **History** | Price trend chart (you vs each competitor) + every run logged to `rates-history.jsonl` |

Email credentials are stored in `secrets.local.json` (gitignored — never committed).

## How the 5-hour email works

1. GitHub Actions runs `watch.js` every 5 hours on a free Ubuntu runner.
2. The script opens Booking with a **mobile (Android) browser profile** → mobile-only rates.
3. Finds your property + each competitor on the results page (auto paginates if needed).
4. Emails you: your price, every competitor's price sorted cheapest-first, deltas vs you, and ⚠ ALERTS when a competitor undercuts you.
5. Appends every run to `rates-history.jsonl` in the repo (price trends over time).

## Setup (5 minutes, $0)

### 1. Edit `config.json`
```json
{
  "city": "Manteo",
  "country": "us",
  "startDaysFromToday": 10,
  "endDaysFromToday": 19,
  "nights": 1,
  "adults": 2,
  "myProperty": "Your Hotel Name",
  "competitors": ["Competitor A", "Competitor B"]
}
```
- `startDaysFromToday` / `endDaysFromToday` = rolling window (auto-updates with today).
- **Your email NEVER lives in config.json** — set it in the dashboard (Settings tab); it's stored in `secrets.local.json` (gitignored, never pushed) or as GitHub secrets.

### 2. Create a Gmail app password (free)
1. Go to https://myaccount.google.com/apppasswords (must have 2-Step Verification on)
2. App name: `pricewatch` → Generate → copy the 16-char password

### 3. Add repo secrets
GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:
| Secret | Value |
|---|---|
| `GMAIL_USER` | your full gmail address (e.g. `you@gmail.com`) |
| `GMAIL_APP_PASS` | the 16-char app password |
| `EMAIL_TO` | destination address (can be same or different) |

### 4. Test it
- **Actions tab → Price Watch → Run workflow** → watch it run (~3 min).
- Check your inbox for the first email.
- Schedule is `0,5,10,15,19` UTC hours + 23 min (`cron: '23 0,5,10,15,19 * * *'`) = every 5 hours.
- Want a different cadence? Edit `.github/workflows/watch.yml` (e.g. `'23 */3 * * *'` = every 3h).

## Local run (optional, same code)
```bash
npm install
npx playwright install chromium
GMAIL_USER=you@gmail.com GMAIL_APP_PASS=xxxx EMAIL_TO=you@gmail.com node watch.js --config config.json
node watch.js --config config.json --desktop   # desktop rates instead
node watch.js --city "Las Vegas" --checkin 2026-09-01 --nights 2   # one-off
node watch.js --test-email                       # verify SMTP only
```

## Cost & limits (all free)
- **GitHub Actions**: public repo = unlimited minutes (this repo is public). Private would still fit in 2,000 free min/mo (this uses ~480).
- **Gmail SMTP**: free, ~500 sends/day.
- **Booking anti-bot reality**: rates are scraped politely (2 runs-city per 5h window, retries, CAPTCHA detection → exit 2 → next run retries). Runner IPs are datacenter IPs; if a run gets CAPTCHA'd, the next scheduled run usually succeeds. Prices are per-night standard rates for the configured adults, as shown on Booking mobile — mobile-app-exclusive promo deals may differ.

## Files
- `watch.js` — scraper + compare + email (single file)
- `config.json` — your property, competitors, city, dates
- `rates-history.jsonl` — append-only history (auto-committed each run)
- `.github/workflows/watch.yml` — the 5-hour schedule
