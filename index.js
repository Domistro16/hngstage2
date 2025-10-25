// index.js
import express from "express";
import axios from "axios";
import sqlite3 from "sqlite3";
import { createCanvas } from "@napi-rs/canvas";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// ---- Config ----
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const REST_COUNTRIES =
  "https://restcountries.com/v2/all?fields=name,capital,region,population,flag,currencies";
const EXCHANGE_API = "https://open.er-api.com/v6/latest/USD";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, "cache");
const IMAGE_PATH = path.join(CACHE_DIR, "summary.png");
const DB_PATH = path.join(__dirname, "data.sqlite3");


const db = new sqlite3.Database(DB_PATH);
// create cache dir if missing
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---- DB init (SQLite) ----

// Create table if not exists. last_refreshed_at stored as ISO string text.
db.exec(`
CREATE TABLE IF NOT EXISTS countries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE,
  capital TEXT,
  region TEXT,
  population INTEGER NOT NULL,
  currency_code TEXT,
  exchange_rate REAL,
  estimated_gdp REAL,
  flag_url TEXT,
  last_refreshed_at TEXT
);
`);

// Prepared statements
const selectByLowerName = db.prepare(
  `SELECT * FROM countries WHERE name = ? COLLATE NOCASE LIMIT 1`
);
const insertStmt = db.prepare(`
  INSERT INTO countries (name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url, last_refreshed_at)
  VALUES (@name, @capital, @region, @population, @currency_code, @exchange_rate, @estimated_gdp, @flag_url, @last_refreshed_at)
`);
const updateStmt = db.prepare(`
  UPDATE countries
  SET capital=@capital, region=@region, population=@population, currency_code=@currency_code,
      exchange_rate=@exchange_rate, estimated_gdp=@estimated_gdp, flag_url=@flag_url, last_refreshed_at=@last_refreshed_at
  WHERE id=@id
`);

// ---- Helpers ----
const randMultiplier = () => Math.floor(1000 + Math.random() * 1001); // 1000..2000 inclusive

function makeValidationError(detail) {
  return { status: 400, body: { error: "Validation failed", details: detail } };
}

async function fetchCountries() {
  // fetch countries data
  try {
    const resp = await axios.get(REST_COUNTRIES, { timeout: 15000 });
    return resp.data;
  } catch (err) {
    throw {
      code: "COUNTRIES_API_FAIL",
      message: `Could not fetch data from RestCountries API (${REST_COUNTRIES})`,
    };
  }
}

async function fetchRates() {
  try {
    const resp = await axios.get(EXCHANGE_API, { timeout: 15000 });
    if (!resp.data || !resp.data.rates)
      throw new Error("Malformed rates response");
    return resp.data.rates; // object currencyCode => rate
  } catch (err) {
    throw {
      code: "RATES_API_FAIL",
      message: `Could not fetch data from Exchange Rates API (${EXCHANGE_API})`,
    };
  }
}

async function createSummaryImage({ filePath, total, top5, timestamp }) {
  // simple canvas image
  const w = 1000;
  const h = 600;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");

  // background
  ctx.fillStyle = "#0b1220"; // dark
  ctx.fillRect(0, 0, w, h);

  // title
  ctx.fillStyle = "#fff";
  ctx.font = "bold 36px Sans";
  ctx.fillText("Countries Summary", 40, 60);

  // total and timestamp
  ctx.font = "20px Sans";
  ctx.fillStyle = "#d1d5db";
  ctx.fillText(`Total countries: ${total}`, 40, 100);
  ctx.fillText(`Last refresh: ${timestamp}`, 40, 130);

  // Top 5 list
  ctx.font = "22px Sans";
  ctx.fillStyle = "#fff";
  ctx.fillText("Top 5 by estimated GDP", 40, 180);

  ctx.font = "18px Sans";
  ctx.fillStyle = "#cbd5e1";
  let y = 220;
  if (!top5 || top5.length === 0) {
    ctx.fillText("No GDP data available", 40, y);
  } else {
    for (let i = 0; i < top5.length; i++) {
      const item = top5[i];
      // format GDP with commas and round to 2 decimals
      const gdpStr =
        item.estimated_gdp === null
          ? "null"
          : Number(item.estimated_gdp).toLocaleString(undefined, {
              maximumFractionDigits: 2,
            });
      ctx.fillText(`${i + 1}. ${item.name} — ${gdpStr}`, 40, y);
      y += 34;
    }
  }

  // Save file
  const buffer = canvas.toBuffer("image/png");
  await fsPromises.writeFile(filePath, buffer);
}

// ---- Express app ----
const app = express();
app.use(express.json());

// POST /countries/refresh
app.post("/countries/refresh", async (req, res) => {
  // 1) fetch both external APIs first
  let countriesData, rates;
  try {
    [countriesData, rates] = await Promise.all([
      fetchCountries(),
      fetchRates(),
    ]);
  } catch (err) {
    // which API failed?
    if (err && err.code === "COUNTRIES_API_FAIL") {
      return res.status(503).json({
        error: "External data source unavailable",
        details: err.message,
      });
    }
    if (err && err.code === "RATES_API_FAIL") {
      return res.status(503).json({
        error: "External data source unavailable",
        details: err.message,
      });
    }
    return res.status(503).json({
      error: "External data source unavailable",
      details: "Could not fetch data from external APIs",
    });
  }

  // Basic validation: all countries must have name and population
  for (const c of countriesData) {
    if (!c.name || c.population === undefined || c.population === null) {
      return res.status(400).json({
        error: "Validation failed",
        details: {
          name: !c.name ? "is required" : undefined,
          population:
            c.population === undefined || c.population === null
              ? "is required"
              : undefined,
        },
      });
    }
  }

  // 2) perform DB transaction: upsert all countries.
  const nowIso = new Date().toISOString();
  const insertOrUpdate = db.transaction((countries, ratesObj) => {
    for (const c of countries) {
      const name = c.name;
      const capital = c.capital || null;
      const region = c.region || null;
      const population = Number(c.population) || 0;
      let currency_code = null;
      let exchange_rate = null;
      let estimated_gdp = null;

      if (Array.isArray(c.currencies) && c.currencies.length > 0) {
        currency_code = c.currencies[0]?.code || null;
        if (
          currency_code &&
          Object.prototype.hasOwnProperty.call(ratesObj, currency_code)
        ) {
          const rate = Number(ratesObj[currency_code]);
          if (!Number.isFinite(rate) || rate === 0) {
            exchange_rate = null;
            estimated_gdp = null;
          } else {
            exchange_rate = rate;
            const mult = randMultiplier();
            estimated_gdp = (population * mult) / exchange_rate;
          }
        } else {
          // currency present but not found in rates
          exchange_rate = null;
          estimated_gdp = null;
        }
      } else {
        // no currencies array / empty
        currency_code = null;
        exchange_rate = null;
        estimated_gdp = 0;
      }

      const flag_url = c.flag || null;

      // check existing by name (case-insensitive due to COLLATE NOCASE)
      const existing = selectByLowerName.get(name);
      if (existing) {
        updateStmt.run({
          id: existing.id,
          capital,
          region,
          population,
          currency_code,
          exchange_rate,
          estimated_gdp,
          flag_url,
          last_refreshed_at: nowIso,
        });
      } else {
        insertStmt.run({
          name,
          capital,
          region,
          population,
          currency_code,
          exchange_rate,
          estimated_gdp,
          flag_url,
          last_refreshed_at: nowIso,
        });
      }
    }
  });

  try {
    insertOrUpdate(countriesData, rates);

    // generate image summary (non-fatal if fails)
    try {
      const totalRow = db
        .prepare("SELECT COUNT(*) as cnt FROM countries")
        .get();
      const total = totalRow ? totalRow.cnt : 0;
      const top5Rows = db
        .prepare(
          "SELECT name, estimated_gdp FROM countries WHERE estimated_gdp IS NOT NULL ORDER BY estimated_gdp DESC LIMIT 5"
        )
        .all();
      const top5 = top5Rows.map((r) => ({
        name: r.name,
        estimated_gdp: r.estimated_gdp,
      }));
      await createSummaryImage({
        filePath: IMAGE_PATH,
        total,
        top5,
        timestamp: nowIso,
      });
    } catch (imgErr) {
      console.error("Failed to generate summary image:", imgErr);
      // per spec image generation failure should not roll back DB; so continue
    }

    return res.json({ success: true, message: "Countries refreshed" });
  } catch (err) {
    console.error("DB transaction failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// GET /countries/image
app.get("/countries/image", (req, res) => {
  if (!fs.existsSync(IMAGE_PATH))
    return res.status(404).json({ error: "Summary image not found" });
  res.sendFile(IMAGE_PATH);
});
// GET /countries (filter region, currency; sort=gdp_desc or gdp_asc)
app.get("/countries", (req, res) => {
  const region = req.query.region;
  const currency = req.query.currency;
  const sort = req.query.sort;

  let sql = "SELECT * FROM countries";
  const conditions = [];
  const params = [];

  if (region) {
    conditions.push("region = ?");
    params.push(region);
  }
  if (currency) {
    conditions.push("currency_code = ?");
    params.push(currency);
  }
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");

  if (sort === "gdp_desc") sql += " ORDER BY estimated_gdp DESC";
  else if (sort === "gdp_asc") sql += " ORDER BY estimated_gdp ASC";
  else sql += " ORDER BY name COLLATE NOCASE ASC";

  const rows = db.prepare(sql).all(...params);
  const out = rows.map((r) => ({
    id: r.id,
    name: r.name,
    capital: r.capital,
    region: r.region,
    population: Number(r.population),
    currency_code: r.currency_code,
    exchange_rate: r.exchange_rate === null ? null : Number(r.exchange_rate),
    estimated_gdp: r.estimated_gdp === null ? null : Number(r.estimated_gdp),
    flag_url: r.flag_url,
    last_refreshed_at: r.last_refreshed_at,
  }));
  res.json(out);
});

// GET /countries/:name (case-insensitive)
app.get("/countries/:name", (req, res) => {
  const name = req.params.name;
  const row = selectByLowerName.get(name);
  if (!row) return res.status(404).json({ error: "Country not found" });
  res.json({
    id: row.id,
    name: row.name,
    capital: row.capital,
    region: row.region,
    population: Number(row.population),
    currency_code: row.currency_code,
    exchange_rate:
      row.exchange_rate === null ? null : Number(row.exchange_rate),
    estimated_gdp:
      row.estimated_gdp === null ? null : Number(row.estimated_gdp),
    flag_url: row.flag_url,
    last_refreshed_at: row.last_refreshed_at,
  });
});

// DELETE /countries/:name
app.delete("/countries/:name", (req, res) => {
  const name = req.params.name;
  const existing = selectByLowerName.get(name);
  if (!existing) return res.status(404).json({ error: "Country not found" });
  db.prepare("DELETE FROM countries WHERE id = ?").run(existing.id);
  res.json({ success: true });
});

// GET /status
app.get("/status", (req, res) => {
  const totalRow = db.prepare("SELECT COUNT(*) as cnt FROM countries").get();
  const total = totalRow ? totalRow.cnt : 0;
  const lastRow = db
    .prepare(
      "SELECT last_refreshed_at FROM countries WHERE last_refreshed_at IS NOT NULL ORDER BY last_refreshed_at DESC LIMIT 1"
    )
    .get();
  const last = lastRow ? lastRow.last_refreshed_at : null;
  res.json({ total_countries: total, last_refreshed_at: last });
});

// 404 json
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// error handler
app.use((err, req, res, next) => {
  console.error(err);
  if (err && err.status && err.body)
    return res.status(err.status).json(err.body);
  res.status(500).json({ error: "Internal server error" });
});

// Start
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(
    "Endpoints: POST /countries/refresh, GET /countries, GET /countries/:name, DELETE /countries/:name, GET /status, GET /countries/image"
  );
});
