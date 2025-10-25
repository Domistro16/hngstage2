// index.js (ESM)
import express from "express";
import axios from "axios";
import sqlite3 from "sqlite3";
import { createCanvas } from "@napi-rs/canvas";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";

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

// create cache dir if missing
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---- DB init (sqlite3) ----
sqlite3.verbose();
const rawDb = new sqlite3.Database(DB_PATH);

// promisify helpful methods
const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) =>
    rawDb.run(sql, params, function (err) {
      if (err) return reject(err);
      // resolve with lastID & changes (if needed)
      resolve({ lastID: this.lastID, changes: this.changes });
    })
  );
const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) =>
    rawDb.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
  );
const allAsync = (sql, params = []) =>
  new Promise((resolve, reject) =>
    rawDb.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
  );
const execAsync = (sql) =>
  new Promise((resolve, reject) =>
    rawDb.exec(sql, (err) => (err ? reject(err) : resolve()))
  );

// Create table if not exists
await execAsync(`
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

// ---- Helpers ----
const randMultiplier = () => Math.floor(1000 + Math.random() * 1001); // 1000..2000 inclusive

function makeValidationResponse(detail) {
  return { status: 400, body: { error: "Validation failed", details: detail } };
}

async function fetchCountries() {
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
    return resp.data.rates;
  } catch (err) {
    throw {
      code: "RATES_API_FAIL",
      message: `Could not fetch data from Exchange Rates API (${EXCHANGE_API})`,
    };
  }
}

async function createSummaryImage({ filePath, total, top5, timestamp }) {
  const w = 1000;
  const h = 600;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#0b1220";
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = "#fff";
  ctx.font = "bold 36px Sans";
  ctx.fillText("Countries Summary", 40, 60);

  ctx.font = "20px Sans";
  ctx.fillStyle = "#d1d5db";
  ctx.fillText(`Total countries: ${total}`, 40, 100);
  ctx.fillText(`Last refresh: ${timestamp}`, 40, 130);

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

  const buffer = canvas.toBuffer("image/png");
  await fsPromises.writeFile(filePath, buffer);
}

// ---- Express app ----
const app = express();
app.use(express.json());

// POST /countries/refresh
app.post("/countries/refresh", async (req, res) => {
  // fetch both external APIs first
  let countriesData, rates;
  try {
    [countriesData, rates] = await Promise.all([
      fetchCountries(),
      fetchRates(),
    ]);
  } catch (err) {
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

  // Basic validation
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

  const nowIso = new Date().toISOString();

  // Wrap the upsert process in a transaction (BEGIN/COMMIT/ROLLBACK)
  try {
    await runAsync("BEGIN TRANSACTION");

    // loop sequentially to avoid too many parallel db ops
    for (const c of countriesData) {
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
          Object.prototype.hasOwnProperty.call(rates, currency_code)
        ) {
          const rate = Number(rates[currency_code]);
          if (!Number.isFinite(rate) || rate === 0) {
            exchange_rate = null;
            estimated_gdp = null;
          } else {
            exchange_rate = rate;
            const mult = randMultiplier();
            estimated_gdp = (population * mult) / exchange_rate;
          }
        } else {
          exchange_rate = null;
          estimated_gdp = null;
        }
      } else {
        currency_code = null;
        exchange_rate = null;
        estimated_gdp = 0;
      }

      const flag_url = c.flag || null;

      // check existing by name (case-insensitive via COLLATE NOCASE)
      const existing = await getAsync(
        "SELECT * FROM countries WHERE name = ? COLLATE NOCASE LIMIT 1",
        [name]
      );
      if (existing) {
        await runAsync(
          `UPDATE countries SET capital = ?, region = ?, population = ?, currency_code = ?, exchange_rate = ?, estimated_gdp = ?, flag_url = ?, last_refreshed_at = ? WHERE id = ?`,
          [
            capital,
            region,
            population,
            currency_code,
            exchange_rate,
            estimated_gdp,
            flag_url,
            nowIso,
            existing.id,
          ]
        );
      } else {
        await runAsync(
          `INSERT INTO countries (name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url, last_refreshed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            name,
            capital,
            region,
            population,
            currency_code,
            exchange_rate,
            estimated_gdp,
            flag_url,
            nowIso,
          ]
        );
      }
    }

    // commit
    await runAsync("COMMIT");
  } catch (err) {
    console.error("Error during DB transaction, rolling back:", err);
    try {
      await runAsync("ROLLBACK");
    } catch (rerr) {
      console.error("Rollback failed:", rerr);
    }
    return res.status(500).json({ error: "Internal server error" });
  }

  // After a successful commit, generate summary image (non-fatal)
  try {
    const totalRow = await getAsync("SELECT COUNT(*) as cnt FROM countries");
    const total = totalRow ? totalRow.cnt : 0;
    const top5Rows = await allAsync(
      "SELECT name, estimated_gdp FROM countries WHERE estimated_gdp IS NOT NULL ORDER BY estimated_gdp DESC LIMIT 5"
    );
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
    // continue — image gen failure shouldn't break refresh
  }

  return res.json({ success: true, message: "Countries refreshed" });
});

// GET /countries/image
app.get("/countries/image", (req, res) => {
  if (!fs.existsSync(IMAGE_PATH))
    return res.status(404).json({ error: "Summary image not found" });
  res.sendFile(IMAGE_PATH);
});

// GET /countries (filter region, currency; sort=gdp_desc or gdp_asc)
app.get("/countries", async (req, res) => {
  try {
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

    const rows = await allAsync(sql, params);
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /countries/:name (case-insensitive)
app.get("/countries/:name", async (req, res) => {
  try {
    const name = req.params.name;
    const row = await getAsync(
      "SELECT * FROM countries WHERE name = ? COLLATE NOCASE LIMIT 1",
      [name]
    );
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /countries/:name
app.delete("/countries/:name", async (req, res) => {
  try {
    const name = req.params.name;
    const existing = await getAsync(
      "SELECT * FROM countries WHERE name = ? COLLATE NOCASE LIMIT 1",
      [name]
    );
    if (!existing) return res.status(404).json({ error: "Country not found" });
    await runAsync("DELETE FROM countries WHERE id = ?", [existing.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /status
app.get("/status", async (req, res) => {
  try {
    const totalRow = await getAsync("SELECT COUNT(*) as cnt FROM countries");
    const total = totalRow ? totalRow.cnt : 0;
    const lastRow = await getAsync(
      "SELECT last_refreshed_at FROM countries WHERE last_refreshed_at IS NOT NULL ORDER BY last_refreshed_at DESC LIMIT 1"
    );
    const last = lastRow ? lastRow.last_refreshed_at : null;
    res.json({ total_countries: total, last_refreshed_at: last });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 404 json
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

// Start
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(
    "Endpoints: POST /countries/refresh, GET /countries, GET /countries/:name, DELETE /countries/:name, GET /status, GET /countries/image"
  );
});
