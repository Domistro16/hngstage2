# Country Exchange API — Draft

Single-file ESM Node app (`index.js`) that fetches country data + USD exchange rates, caches them in SQLite, and exposes REST endpoints. Generates a summary image at `cache/summary.png` after a successful refresh.

---

## Features

- `POST /countries/refresh` — fetch countries & exchange rates, upsert into SQLite, generate `cache/summary.png`
- `GET /countries` — list countries (filters: `?region=`, `?currency=`, sort: `?sort=gdp_desc` or `gdp_asc`)
- `GET /countries/:name` — get a country by name (case-insensitive)
- `DELETE /countries/:name` — delete a country
- `GET /status` — `{ total_countries, last_refreshed_at }`
- `GET /countries/image` — serves `cache/summary.png` (404 JSON if missing)

---

## Behavior & Rules (per spec)

- Country source: `https://restcountries.com/v2/all?fields=name,capital,region,population,flag,currencies`
- Exchange rates: `https://open.er-api.com/v6/latest/USD`
- If a country has multiple currencies: use the **first** currency code.
- If `currencies` array is empty: set `currency_code=null`, `exchange_rate=null`, `estimated_gdp=0` and still store the country.
- If currency not found in exchange rates: set `exchange_rate=null`, `estimated_gdp=null` and still store the country.
- `estimated_gdp` is computed per-refresh as: `population * random(1000–2000) / exchange_rate` (random multiplier re-generated for each country on each refresh).
- Names are matched case-insensitively for update vs insert behavior.
- Validation during refresh: every country must have `name` and `population` — the endpoint returns `400` with details when this fails.
- If either external API fails or times out: `POST /countries/refresh` returns `503` and **does not modify** the DB.

---

## API examples (curl)

- Refresh & cache

```bash
curl -X POST http://localhost:3000/countries/refresh
```

- List (Africa)

```bash
curl "http://localhost:3000/countries?region=Africa"
```

- Get single country

```bash
curl http://localhost:3000/countries/Nigeria
```

- Delete

```bash
curl -X DELETE http://localhost:3000/countries/Nigeria
```

- Status

```bash
curl http://localhost:3000/status
```

- Get image (open in browser)

```
http://localhost:3000/countries/image
```

---

## Local setup

Requirements: Node 18+, npm, optional system libs for `canvas` if you want image generation.

1. Clone the repo or create a new folder.
2. Put `index.js` and `package.json` (type: "module") in the root.
3. Install dependencies:

```bash
npm install
```

4. Start the server:

```bash
node index.js
# or for dev
npm run dev
```

Server defaults to `http://localhost:3000`.

---

## Files (single-file setup)

- `index.js` — main ESM app (contains DB init, endpoints, image generation)
- `package.json` — `type: "module"` and dependencies
- `data.sqlite3` — created at runtime (SQLite DB file)
- `cache/summary.png` — generated summary image after refresh

---

## Canvas of common errors & troubleshooting

- **canvas install fails**: If you cannot install native deps, either install system libs (macOS/Linux) or comment out image-generation parts in `index.js`. Image gen is non-fatal.
- **404 on GitHub repo**: ensure repo exists, is public, and you pushed the branch. If private, make public or invite the reviewer.
- **External APIs timeout**: server returns `503`. Re-run refresh when network is stable.

---

## Submission checklist (HNG stage-2)

- [ ] App is reachable from the internet (public URL)
- [ ] Github repo contains `index.js`, `package.json`, and `README.md`
- [ ] README contains instructions to run locally and sample requests
- [ ] Use Slack `/stage-two-backend` command in `stage-2-backend` channel and submit:

  - API base URL
  - GitHub repo link
  - Full name
  - Email
  - Stack used

---
