const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const { parseOptionCsv, normalizeDatasetName } = require("./src/csv-store");
const { runOptionsBacktest } = require("./src/options-engine");

const port = Number(process.env.PORT || 5177);
const host = process.env.HOST || "0.0.0.0";
const appRoot = __dirname;
const publicRoot = path.join(appRoot, "publish");
const mutableDataRoot = process.env.DATA_DIR || path.join(appRoot, "data");
const dataRoot = path.join(mutableDataRoot, "imports");
const usersPath = path.join(mutableDataRoot, "users.json");
const bundledDataRoot = path.join(appRoot, "data");
const cacheMs = 15 * 60 * 1000;
const cache = new Map();
const sessions = new Map();
const brokerConnections = new Map();

const assets = {
  nifty50: { label: "Nifty 50", symbol: "^NSEI", currency: "INR", decimals: 2 },
  banknifty: { label: "Nifty Bank", symbol: "^NSEBANK", currency: "INR", decimals: 2 },
  niftyit: { label: "Nifty IT", symbol: "^CNXIT", currency: "INR", decimals: 2 },
  sensex: { label: "BSE Sensex", symbol: "^BSESN", currency: "INR", decimals: 2 },
  gold: { label: "Gold Futures", symbol: "GC=F", currency: "USD", decimals: 2 },
  silver: { label: "Silver Futures", symbol: "SI=F", currency: "USD", decimals: 3 },
  bitcoin: { label: "Bitcoin", symbol: "BTC-USD", currency: "USD", decimals: 2 },
  ethereum: { label: "Ethereum", symbol: "ETH-USD", currency: "USD", decimals: 2 }
};

const liveAssets = {
  NIFTY: { label: "Nifty 50", base: 22450, step: 50 },
  BANKNIFTY: { label: "Bank Nifty", base: 53710, step: 100 },
  FINNIFTY: { label: "FinNifty", base: 21400, step: 50 },
  SENSEX: { label: "Sensex", base: 74200, step: 100 }
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }

    if (url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, name: "Market History Lab backend", mode: "csv-real-engine-v1" });
      return;
    }

    if (url.pathname === "/api/auth/register" && req.method === "POST") {
      await registerUser(req, res);
      return;
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      await loginUser(req, res);
      return;
    }

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      await sendCurrentUser(req, res);
      return;
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      logoutUser(req, res);
      return;
    }

    if (url.pathname === "/api/history" && req.method === "GET") {
      await sendHistory(url, res);
      return;
    }

    if (url.pathname === "/api/datasets" && req.method === "GET") {
      await sendDatasets(res);
      return;
    }

    if (url.pathname === "/api/live/status" && req.method === "GET") {
      sendLiveStatus(res);
      return;
    }

    if (url.pathname === "/api/live/quote" && req.method === "GET") {
      await sendLiveQuote(url, res);
      return;
    }

    if (url.pathname === "/api/live/chain" && req.method === "GET") {
      await sendLiveChain(url, res);
      return;
    }

    if (url.pathname === "/api/broker/status" && req.method === "GET") {
      sendBrokerStatus(req, res);
      return;
    }

    if (url.pathname === "/api/broker/upstox/login-url" && req.method === "GET") {
      sendUpstoxLoginUrl(req, res);
      return;
    }

    if (url.pathname === "/api/broker/upstox/callback" && req.method === "GET") {
      await handleUpstoxCallback(url, res);
      return;
    }

    if (url.pathname === "/api/broker/dhan/connect" && req.method === "POST") {
      await connectDhan(req, res);
      return;
    }

    if (url.pathname === "/api/broker/disconnect" && req.method === "POST") {
      disconnectBroker(req, res);
      return;
    }

    if (url.pathname === "/api/sample-csv" && req.method === "GET") {
      const csv = await fs.readFile(path.join(bundledDataRoot, "sample-options.csv"), "utf8");
      res.writeHead(200, corsHeaders({ "Content-Type": "text/csv; charset=utf-8" }));
      res.end(csv);
      return;
    }

    if (url.pathname === "/api/import-csv" && req.method === "POST") {
      await importCsv(req, res);
      return;
    }

    if (url.pathname === "/api/backtest" && req.method === "POST") {
      await backtest(req, res);
      return;
    }

    await sendStatic(url.pathname, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(port, host, () => {
  console.log(`Market History Lab running at http://127.0.0.1:${port}`);
  console.log("Backend APIs: /api/health, /api/import-csv, /api/backtest");
});

async function registerUser(req, res) {
  const body = await readJson(req);
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!name || name.length < 2) {
    sendJson(res, 400, { error: "Name kam se kam 2 letters ka hona chahiye." });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    sendJson(res, 400, { error: "Valid email enter karo." });
    return;
  }
  if (password.length < 6) {
    sendJson(res, 400, { error: "Password kam se kam 6 characters ka hona chahiye." });
    return;
  }

  const store = await readUsers();
  if (store.users.some((user) => user.email === email)) {
    sendJson(res, 409, { error: "Ye email already registered hai. Login karo." });
    return;
  }
  const auth = hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    salt: auth.salt,
    passwordHash: auth.hash,
    credits: 25,
    plan: "Starter",
    createdAt: new Date().toISOString()
  };
  store.users.push(user);
  await writeUsers(store);
  const token = createSession(user);
  sendJson(res, 200, { ok: true, token, user: publicUser(user) });
}

async function loginUser(req, res) {
  const body = await readJson(req);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const store = await readUsers();
  const user = store.users.find((item) => item.email === email);
  if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
    sendJson(res, 401, { error: "Email ya password galat hai." });
    return;
  }
  const token = createSession(user);
  sendJson(res, 200, { ok: true, token, user: publicUser(user) });
}

async function sendCurrentUser(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: "Login required." });
    return;
  }
  const store = await readUsers();
  const user = store.users.find((item) => item.id === session.userId);
  if (!user) {
    sendJson(res, 401, { error: "Session expired." });
    return;
  }
  sendJson(res, 200, { ok: true, user: publicUser(user) });
}

function logoutUser(req, res) {
  const token = getBearerToken(req);
  if (token) sessions.delete(token);
  sendJson(res, 200, { ok: true });
}

async function readUsers() {
  try {
    const raw = await fs.readFile(usersPath, "utf8");
    const parsed = JSON.parse(raw);
    return { users: Array.isArray(parsed.users) ? parsed.users : [] };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { users: [] };
  }
}

async function writeUsers(store) {
  await fs.mkdir(path.dirname(usersPath), { recursive: true });
  await fs.writeFile(usersPath, JSON.stringify(store, null, 2));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 32, "sha256").toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const actual = hashPassword(password, salt).hash;
  const expected = Buffer.from(String(expectedHash || ""), "hex");
  const candidate = Buffer.from(actual, "hex");
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { userId: user.id, createdAt: Date.now() });
  return token;
}

function getSession(req) {
  const token = getBearerToken(req);
  return token ? sessions.get(token) : null;
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    credits: Number(user.credits ?? 25),
    plan: user.plan || "Starter"
  };
}

async function sendDatasets(res) {
  await fs.mkdir(dataRoot, { recursive: true });
  const files = await fs.readdir(dataRoot);
  const datasets = [await sampleDatasetInfo()];
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const fullPath = path.join(dataRoot, file);
    const raw = await fs.readFile(fullPath, "utf8");
    const dataset = JSON.parse(raw);
    datasets.push({
      name: dataset.name,
      rows: dataset.rows.length,
      firstDate: dataset.meta.firstDate,
      lastDate: dataset.meta.lastDate,
      underlyings: dataset.meta.underlyings,
      expiries: dataset.meta.expiries
    });
  }
  sendJson(res, 200, { datasets });
}

function sendLiveStatus(res) {
  const provider = process.env.LIVE_DATA_PROVIDER || (process.env.LIVE_QUOTE_URL ? "custom-http" : "demo-live");
  sendJson(res, 200, {
    ok: true,
    provider,
    mode: provider === "demo-live" ? "simulated-live-paper" : "external-live-feed",
    hasExternalUrl: Boolean(process.env.LIVE_QUOTE_URL),
    refreshSeconds: Number(process.env.LIVE_REFRESH_SECONDS || 5),
    note: provider === "demo-live"
      ? "Demo live feed. Real market ke liye LIVE_QUOTE_URL/API credentials configure karo."
      : "External live quote feed configured."
  });
}

function sendBrokerStatus(req, res) {
  const sessionKey = brokerSessionKey(req);
  const active = sessionKey ? brokerConnections.get(sessionKey) : null;
  sendJson(res, 200, {
    ok: true,
    active: active ? publicBroker(active) : null,
    providers: {
      upstox: {
        name: "Upstox",
        configured: Boolean(process.env.UPSTOX_CLIENT_ID && process.env.UPSTOX_REDIRECT_URI),
        mode: "oauth"
      },
      dhan: {
        name: "Dhan",
        configured: Boolean(process.env.DHAN_CLIENT_ID && process.env.DHAN_ACCESS_TOKEN),
        mode: "access-token"
      }
    },
    note: "Broker connect yahan paper/live-data mode ke liye hai. Real order placement disabled hai."
  });
}

function sendUpstoxLoginUrl(req, res) {
  const clientId = process.env.UPSTOX_CLIENT_ID;
  const redirectUri = process.env.UPSTOX_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    sendJson(res, 400, {
      error: "Upstox env missing.",
      required: ["UPSTOX_CLIENT_ID", "UPSTOX_REDIRECT_URI", "UPSTOX_CLIENT_SECRET"]
    });
    return;
  }
  const state = crypto.randomBytes(12).toString("hex");
  const authUrl = new URL("https://api.upstox.com/v2/login/authorization/dialog");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  sendJson(res, 200, { ok: true, authUrl: authUrl.toString(), state });
}

async function handleUpstoxCallback(url, res) {
  const code = url.searchParams.get("code");
  if (!code) {
    sendJson(res, 400, { error: "Upstox code missing." });
    return;
  }
  if (!process.env.UPSTOX_CLIENT_ID || !process.env.UPSTOX_CLIENT_SECRET || !process.env.UPSTOX_REDIRECT_URI) {
    sendJson(res, 400, { error: "Upstox credentials server par configured nahi hain." });
    return;
  }
  try {
    const tokenPayload = new URLSearchParams({
      code,
      client_id: process.env.UPSTOX_CLIENT_ID,
      client_secret: process.env.UPSTOX_CLIENT_SECRET,
      redirect_uri: process.env.UPSTOX_REDIRECT_URI,
      grant_type: "authorization_code"
    }).toString();
    const tokenRaw = await requestHttps({
      method: "POST",
      url: new URL("https://api.upstox.com/v2/login/authorization/token"),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json"
      },
      body: tokenPayload
    });
    const tokenJson = JSON.parse(tokenRaw);
    const token = tokenJson.access_token;
    if (!token) throw new Error("Upstox token response me access_token nahi mila.");
    brokerConnections.set(`upstox:${crypto.randomUUID()}`, {
      provider: "upstox",
      connectedAt: new Date().toISOString(),
      accessToken: token,
      profile: {
        name: tokenJson.user_name || "Upstox user",
        broker: "Upstox"
      }
    });
    res.writeHead(200, corsHeaders({ "Content-Type": "text/html; charset=utf-8" }));
    res.end("<h1>Upstox connected</h1><p>You can close this tab and return to Market History Lab.</p>");
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function connectDhan(req, res) {
  const body = await readJson(req);
  const clientId = String(body.clientId || process.env.DHAN_CLIENT_ID || "").trim();
  const accessToken = String(body.accessToken || process.env.DHAN_ACCESS_TOKEN || "").trim();
  if (!clientId || !accessToken) {
    sendJson(res, 400, { error: "Dhan client id aur access token required hain." });
    return;
  }
  const sessionKey = brokerSessionKey(req) || `guest:${crypto.randomUUID()}`;
  const connection = {
    provider: "dhan",
    connectedAt: new Date().toISOString(),
    clientId,
    accessToken,
    profile: { name: `Dhan ${clientId}`, broker: "Dhan" }
  };
  brokerConnections.set(sessionKey, connection);
  sendJson(res, 200, { ok: true, connection: publicBroker(connection), sessionKey });
}

function disconnectBroker(req, res) {
  const sessionKey = brokerSessionKey(req);
  if (sessionKey) brokerConnections.delete(sessionKey);
  sendJson(res, 200, { ok: true });
}

function publicBroker(connection) {
  return {
    provider: connection.provider,
    connectedAt: connection.connectedAt,
    profile: connection.profile
  };
}

function brokerSessionKey(req) {
  const session = getSession(req);
  if (session) return `user:${session.userId}`;
  const headerKey = req.headers["x-broker-session"];
  return headerKey ? `guest:${String(headerKey)}` : "";
}

async function sendLiveQuote(url, res) {
  const underlying = String(url.searchParams.get("underlying") || "NIFTY").toUpperCase();
  if (!liveAssets[underlying]) {
    sendJson(res, 404, { error: "Unknown live underlying." });
    return;
  }
  const external = await fetchExternalLiveQuote(underlying);
  const quote = external || demoLiveQuote(underlying);
  sendJson(res, 200, quote);
}

async function sendLiveChain(url, res) {
  const underlying = String(url.searchParams.get("underlying") || "NIFTY").toUpperCase();
  if (!liveAssets[underlying]) {
    sendJson(res, 404, { error: "Unknown live underlying." });
    return;
  }
  const quote = await fetchExternalLiveQuote(underlying) || demoLiveQuote(underlying);
  const meta = liveAssets[underlying];
  const atm = Math.round(quote.ltp / meta.step) * meta.step;
  const rows = [];
  for (let i = -7; i <= 7; i++) {
    const strike = atm + i * meta.step;
    rows.push({
      strike,
      call: liveOptionPremium("CE", strike, quote.ltp, meta.step),
      put: liveOptionPremium("PE", strike, quote.ltp, meta.step)
    });
  }
  sendJson(res, 200, { underlying, quote, atm, rows, updatedAt: quote.updatedAt });
}

async function fetchExternalLiveQuote(underlying) {
  const template = process.env.LIVE_QUOTE_URL;
  if (!template) return null;
  const meta = liveAssets[underlying];
  const requestUrl = template
    .replaceAll("{underlying}", encodeURIComponent(underlying))
    .replaceAll("{symbol}", encodeURIComponent(underlying))
    .replaceAll("{label}", encodeURIComponent(meta.label));
  const headers = { "User-Agent": "Mozilla/5.0 MarketHistoryLab/1.0" };
  if (process.env.LIVE_QUOTE_AUTH_HEADER) {
    const [name, ...parts] = process.env.LIVE_QUOTE_AUTH_HEADER.split(":");
    if (name && parts.length) headers[name.trim()] = parts.join(":").trim();
  }
  try {
    const raw = await requestText(new URL(requestUrl), headers);
    const json = JSON.parse(raw);
    const ltp = Number(json.ltp ?? json.last_price ?? json.lastPrice ?? json.price ?? json.close);
    if (!Number.isFinite(ltp)) return null;
    return {
      source: "external-live-feed",
      underlying,
      label: meta.label,
      ltp,
      change: Number(json.change ?? 0),
      changePct: Number(json.changePct ?? json.change_percent ?? 0),
      updatedAt: new Date().toISOString()
    };
  } catch (error) {
    return null;
  }
}

function demoLiveQuote(underlying) {
  const meta = liveAssets[underlying];
  const seconds = Math.floor(Date.now() / 1000);
  const wave = Math.sin(seconds / 11) * meta.step * 1.8 + Math.cos(seconds / 23) * meta.step * 0.9;
  const ltp = round(meta.base + wave, 2);
  const change = round(ltp - meta.base, 2);
  return {
    source: "demo-live-paper",
    underlying,
    label: meta.label,
    ltp,
    change,
    changePct: round((change / meta.base) * 100, 2),
    updatedAt: new Date().toISOString()
  };
}

function liveOptionPremium(type, strike, spot, step) {
  const intrinsic = type === "CE" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  const distance = Math.abs(strike - spot) / step;
  const timeValue = step * 7.4 * Math.exp(-distance * 0.22);
  const pulse = 1 + Math.sin(Date.now() / 7000 + strike / 100) * 0.015;
  return round(Math.max(3, (intrinsic + timeValue) * pulse), 2);
}

async function sampleDatasetInfo() {
  const csv = await fs.readFile(path.join(bundledDataRoot, "sample-options.csv"), "utf8");
  const parsed = parseOptionCsv(csv);
  return {
    name: "sample-options",
    rows: parsed.rows.length,
    firstDate: parsed.rows[0]?.date,
    lastDate: parsed.rows.at(-1)?.date,
    underlyings: [...new Set(parsed.rows.map((row) => row.underlying))],
    expiries: [...new Set(parsed.rows.map((row) => row.expiry))],
    sample: true
  };
}

async function importCsv(req, res) {
  const body = await readJson(req);
  const name = normalizeDatasetName(body.name || "market-options");
  const parsed = parseOptionCsv(body.csv || "");
  const dataset = {
    name,
    rows: parsed.rows,
    meta: {
      importedAt: new Date().toISOString(),
      firstDate: parsed.rows[0]?.date,
      lastDate: parsed.rows.at(-1)?.date,
      underlyings: [...new Set(parsed.rows.map((row) => row.underlying))],
      expiries: [...new Set(parsed.rows.map((row) => row.expiry))],
      rowCount: parsed.rows.length,
      warnings: parsed.warnings
    }
  };
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.writeFile(path.join(dataRoot, `${name}.json`), JSON.stringify(dataset, null, 2));
  sendJson(res, 200, { ok: true, dataset: dataset.meta, name });
}

async function backtest(req, res) {
  const body = await readJson(req);
  const datasetName = normalizeDatasetName(body.datasetName || "sample-options");
  const dataset = await loadDataset(datasetName);
  const result = runOptionsBacktest(dataset.rows, body);
  sendJson(res, 200, { dataset: dataset.name, result });
}

async function loadDataset(name) {
  const importPath = path.join(dataRoot, `${name}.json`);
  try {
    return JSON.parse(await fs.readFile(importPath, "utf8"));
  } catch (error) {
    if (name !== "sample-options") throw new Error(`Dataset not found: ${name}`);
    const csv = await fs.readFile(path.join(bundledDataRoot, "sample-options.csv"), "utf8");
    const parsed = parseOptionCsv(csv);
    return { name: "sample-options", rows: parsed.rows, meta: {} };
  }
}

async function sendHistory(url, res) {
  const assetId = url.searchParams.get("asset") || "nifty50";
  const asset = assets[assetId];
  if (!asset) {
    sendJson(res, 404, { error: "Unknown asset." });
    return;
  }
  const key = `${assetId}:all`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.createdAt < cacheMs) {
    sendJson(res, 200, cached.payload);
    return;
  }
  const payload = await fetchYahooHistory(asset);
  cache.set(key, { createdAt: Date.now(), payload });
  sendJson(res, 200, payload);
}

async function fetchYahooHistory(asset) {
  const period2 = Math.floor(Date.now() / 1000);
  const yahooUrl = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(asset.symbol)}`);
  yahooUrl.searchParams.set("period1", "0");
  yahooUrl.searchParams.set("period2", String(period2));
  yahooUrl.searchParams.set("interval", "1d");
  yahooUrl.searchParams.set("events", "history");
  yahooUrl.searchParams.set("includeAdjustedClose", "true");

  const body = await requestText(yahooUrl);
  const json = JSON.parse(body);
  const result = json.chart?.result?.[0];
  const error = json.chart?.error;
  if (error) throw new Error(error.description || "Yahoo Finance returned an error.");
  if (!result?.timestamp?.length) throw new Error("Historical data nahi mila. Symbol available nahi ho sakta.");

  const quote = result.indicators?.quote?.[0] || {};
  const rows = result.timestamp.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    open: quote.open?.[index],
    high: quote.high?.[index],
    low: quote.low?.[index],
    close: quote.close?.[index],
    volume: quote.volume?.[index] || 0
  })).filter((row) => (
    row.date &&
    [row.open, row.high, row.low, row.close].every((value) => Number.isFinite(value))
  ));
  if (!rows.length) throw new Error("Historical candles empty aaye.");
  return {
    asset,
    rows,
    meta: {
      provider: "Yahoo Finance chart",
      symbol: asset.symbol,
      firstDate: rows[0].date,
      lastDate: rows[rows.length - 1].date,
      rows: rows.length,
      cachedForMinutes: cacheMs / 60000
    }
  };
}

function requestText(url, headers = {}) {
  return requestHttps({ method: "GET", url, headers });
}

function requestHttps(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options.url, {
      method: options.method || "GET",
      headers: { "User-Agent": "Mozilla/5.0 MarketHistoryLab/1.0", ...(options.headers || {}) }
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP request failed: ${res.statusCode}`));
          return;
        }
        resolve(body);
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error("Yahoo request timeout.")));
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function sendStatic(pathname, res) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const decodedPath = decodeURIComponent(requestedPath);
  const filePath = path.resolve(publicRoot, `.${decodedPath}`);
  if (!filePath.startsWith(publicRoot)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, corsHeaders({ "Content-Type": mimeTypes[ext] || "application/octet-stream" }));
    res.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    throw error;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 12 * 1024 * 1024) {
        reject(new Error("Request too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extra
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, corsHeaders({ "Content-Type": "application/json; charset=utf-8" }));
  res.end(status === 204 ? "" : JSON.stringify(payload));
}

function round(value, decimals = 2) {
  return Number(Number(value || 0).toFixed(decimals));
}
