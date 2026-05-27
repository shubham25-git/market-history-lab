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
const appVersion = "otp-v7-2026-05-27";
const cacheMs = 15 * 60 * 1000;
const cache = new Map();
const sessions = new Map();
const brokerConnections = new Map();
const otpStore = new Map();
let pgPool = null;
let dbReady = false;

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
      sendJson(res, 200, {
        ok: true,
        name: "Market History Lab backend",
        appVersion,
        mode: "csv-real-engine-v1",
        storage: databaseEnabled() ? "postgres" : "file",
        liveProvider: process.env.LIVE_DATA_PROVIDER || (process.env.LIVE_QUOTE_URL ? "custom-http" : "demo-live")
      });
      return;
    }

    if (url.pathname === "/api/version" && req.method === "GET") {
      const rootIndex = await fs.readFile(path.join(appRoot, "index.html"), "utf8").catch(() => "");
      const publishIndex = await fs.readFile(path.join(publicRoot, "index.html"), "utf8").catch(() => "");
      sendJson(res, 200, {
        ok: true,
        appVersion,
        homepageSource: "root-index.html",
        rootHasMobileOtp: rootIndex.includes("Mobile OTP"),
        publishHasMobileOtp: publishIndex.includes("Mobile OTP"),
        otpRoutes: ["/api/auth/otp/request", "/api/auth/otp/verify"]
      });
      return;
    }

    if (url.pathname === "/api/system/status" && req.method === "GET") {
      await sendSystemStatus(res);
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

    if (url.pathname === "/api/auth/otp/request" && req.method === "POST") {
      await requestOtp(req, res);
      return;
    }

    if (url.pathname === "/api/auth/otp/verify" && req.method === "POST") {
      await verifyOtp(req, res);
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
  const login = String(body.email || body.phone || "").trim();
  const email = login.toLowerCase();
  const phone = normalizePhone(login);
  const password = String(body.password || "");
  const store = await readUsers();
  const user = store.users.find((item) => item.email === email || (phone && item.phone === phone));
  if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
    sendJson(res, 401, { error: "Email/mobile ya password galat hai." });
    return;
  }
  const token = createSession(user);
  sendJson(res, 200, { ok: true, token, user: publicUser(user) });
}

async function requestOtp(req, res) {
  const body = await readJson(req);
  const phone = normalizePhone(body.phone);
  if (!phone) {
    sendJson(res, 400, { error: "Valid Indian mobile number enter karo." });
    return;
  }
  const otp = String(crypto.randomInt(100000, 1000000));
  const expiresAt = Date.now() + 5 * 60 * 1000;
  otpStore.set(phone, { otp, expiresAt, attempts: 0 });

  const smsConfigured = Boolean(process.env.SMS_OTP_WEBHOOK_URL);
  if (smsConfigured) {
    try {
      await sendOtpSms(phone, otp);
    } catch (error) {
      otpStore.delete(phone);
      sendJson(res, 502, { error: `SMS provider error: ${error.message}` });
      return;
    }
  }

  sendJson(res, 200, {
    ok: true,
    phone,
    expiresInSeconds: 300,
    smsConfigured,
    demoOtp: smsConfigured ? undefined : otp,
    message: smsConfigured ? "OTP mobile par bhej diya." : `Demo OTP: ${otp}`
  });
}

async function verifyOtp(req, res) {
  const body = await readJson(req);
  const phone = normalizePhone(body.phone);
  const otp = String(body.otp || "").trim();
  if (!phone || !otp) {
    sendJson(res, 400, { error: "Mobile number aur OTP dono required hain." });
    return;
  }
  const record = otpStore.get(phone);
  if (!record || record.expiresAt < Date.now()) {
    otpStore.delete(phone);
    sendJson(res, 400, { error: "OTP expire ho gaya. Naya OTP bhejo." });
    return;
  }
  if (record.otp !== otp) {
    record.attempts += 1;
    if (record.attempts >= 5) otpStore.delete(phone);
    sendJson(res, 401, { error: "OTP galat hai." });
    return;
  }

  const store = await readUsers();
  let user = store.users.find((item) => item.phone === phone);
  const password = String(body.password || "");
  if (!user) {
    const name = String(body.name || "").trim();
    if (!name || name.length < 2) {
      sendJson(res, 400, { error: "New account ke liye name required hai." });
      return;
    }
    if (password.length < 6) {
      sendJson(res, 400, { error: "Password kam se kam 6 characters ka hona chahiye." });
      return;
    }
    const auth = hashPassword(password);
    user = {
      id: crypto.randomUUID(),
      name,
      email: phoneEmail(phone),
      phone,
      salt: auth.salt,
      passwordHash: auth.hash,
      credits: 25,
      plan: "Starter",
      createdAt: new Date().toISOString()
    };
    store.users.push(user);
  } else if (password.length >= 6) {
    const auth = hashPassword(password);
    user.salt = auth.salt;
    user.passwordHash = auth.hash;
  }

  otpStore.delete(phone);
  await writeUsers(store);
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
  if (databaseEnabled()) {
    const db = await getDb();
    const result = await db.query(`
      select id, name, email, phone, salt, password_hash as "passwordHash", credits, plan, created_at as "createdAt"
      from mhl_users
      order by created_at desc
    `);
    return { users: result.rows };
  }
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
  if (databaseEnabled()) {
    const db = await getDb();
    for (const user of store.users) {
      await db.query(
        `insert into mhl_users (id, name, email, phone, salt, password_hash, credits, plan, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (id) do update set
           name = excluded.name,
           email = excluded.email,
           phone = excluded.phone,
           salt = excluded.salt,
           password_hash = excluded.password_hash,
           credits = excluded.credits,
           plan = excluded.plan`,
        [user.id, user.name, user.email, user.phone || null, user.salt, user.passwordHash, Number(user.credits ?? 25), user.plan || "Starter", user.createdAt || new Date().toISOString()]
      );
    }
    return;
  }
  await fs.mkdir(path.dirname(usersPath), { recursive: true });
  await fs.writeFile(usersPath, JSON.stringify(store, null, 2));
}

function databaseEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

async function getDb() {
  if (!databaseEnabled()) return null;
  if (!pgPool) {
    const { Pool } = require("pg");
    const ssl = process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false };
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  }
  if (!dbReady) {
    await pgPool.query(`
      create table if not exists mhl_users (
        id text primary key,
        name text not null,
        email text unique not null,
        salt text not null,
        password_hash text not null,
        credits integer not null default 25,
        plan text not null default 'Starter',
        created_at timestamptz not null default now()
      )
    `);
    await pgPool.query("alter table mhl_users add column if not exists phone text");
    await pgPool.query("create unique index if not exists mhl_users_phone_unique on mhl_users(phone) where phone is not null");
    await pgPool.query(`
      create table if not exists mhl_datasets (
        name text primary key,
        rows_json jsonb not null,
        meta_json jsonb not null,
        imported_at timestamptz not null default now()
      )
    `);
    dbReady = true;
  }
  return pgPool;
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
  const internalPhoneEmail = String(user.email || "").endsWith("@phone.market-history-lab.local");
  return {
    id: user.id,
    name: user.name,
    email: internalPhoneEmail ? "" : user.email,
    phone: user.phone || "",
    credits: Number(user.credits ?? 25),
    plan: user.plan || "Starter"
  };
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return "";
}

function phoneEmail(phone) {
  return `${String(phone).replace(/\D/g, "")}@phone.market-history-lab.local`;
}

async function sendDatasets(res) {
  if (databaseEnabled()) {
    const db = await getDb();
    const result = await db.query("select name, meta_json from mhl_datasets order by imported_at desc");
    const datasets = [await sampleDatasetInfo()];
    for (const row of result.rows) {
      const meta = row.meta_json || {};
      datasets.push({
        name: row.name,
        rows: Number(meta.rowCount || 0),
        firstDate: meta.firstDate,
        lastDate: meta.lastDate,
        underlyings: meta.underlyings || [],
        expiries: meta.expiries || []
      });
    }
    sendJson(res, 200, { datasets, storage: "postgres" });
    return;
  }
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
  sendJson(res, 200, { datasets, storage: "file" });
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

async function sendSystemStatus(res) {
  let database = {
    configured: databaseEnabled(),
    mode: databaseEnabled() ? "postgres" : "file",
    ok: !databaseEnabled()
  };
  if (databaseEnabled()) {
    try {
      const db = await getDb();
      await db.query("select 1");
      database.ok = true;
    } catch (error) {
      database.ok = false;
      database.error = error.message;
    }
  }

  sendJson(res, 200, {
    ok: true,
    database,
    liveData: {
      provider: process.env.LIVE_DATA_PROVIDER || (process.env.LIVE_QUOTE_URL ? "custom-http" : "demo-live"),
      configured: Boolean(process.env.LIVE_QUOTE_URL),
      refreshSeconds: Number(process.env.LIVE_REFRESH_SECONDS || 5)
    },
    broker: {
      upstox: {
        configured: Boolean(process.env.UPSTOX_CLIENT_ID && process.env.UPSTOX_CLIENT_SECRET && process.env.UPSTOX_REDIRECT_URI)
      },
      dhan: {
        configured: Boolean(process.env.DHAN_CLIENT_ID && process.env.DHAN_ACCESS_TOKEN)
      }
    },
    ai: {
      configured: Boolean(process.env.OPENAI_API_KEY),
      mode: process.env.OPENAI_API_KEY ? "ready" : "not-configured"
    },
    otp: {
      configured: Boolean(process.env.SMS_OTP_WEBHOOK_URL),
      demoMode: !process.env.SMS_OTP_WEBHOOK_URL,
      ttlSeconds: 300
    },
    notifications: {
      telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      whatsapp: Boolean(process.env.WHATSAPP_ACCESS_TOKEN),
      email: Boolean(process.env.SMTP_HOST)
    }
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
  await saveDataset(dataset);
  sendJson(res, 200, { ok: true, dataset: dataset.meta, name, storage: databaseEnabled() ? "postgres" : "file" });
}

async function backtest(req, res) {
  const body = await readJson(req);
  const datasetName = normalizeDatasetName(body.datasetName || "sample-options");
  const dataset = await loadDataset(datasetName);
  const result = runOptionsBacktest(dataset.rows, body);
  sendJson(res, 200, { dataset: dataset.name, result });
}

async function loadDataset(name) {
  if (databaseEnabled()) {
    const db = await getDb();
    const result = await db.query("select name, rows_json, meta_json from mhl_datasets where name = $1", [name]);
    if (result.rows[0]) {
      return { name: result.rows[0].name, rows: result.rows[0].rows_json, meta: result.rows[0].meta_json };
    }
  }
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

async function saveDataset(dataset) {
  if (databaseEnabled()) {
    const db = await getDb();
    await db.query(
      `insert into mhl_datasets (name, rows_json, meta_json, imported_at)
       values ($1, $2::jsonb, $3::jsonb, now())
       on conflict (name) do update set
         rows_json = excluded.rows_json,
         meta_json = excluded.meta_json,
         imported_at = now()`,
      [dataset.name, JSON.stringify(dataset.rows), JSON.stringify(dataset.meta)]
    );
    return;
  }
  await fs.mkdir(dataRoot, { recursive: true });
  await fs.writeFile(path.join(dataRoot, `${dataset.name}.json`), JSON.stringify(dataset, null, 2));
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

function sendOtpSms(phone, otp) {
  const url = new URL(process.env.SMS_OTP_WEBHOOK_URL);
  const headers = {
    "Content-Type": "application/json"
  };
  if (process.env.SMS_OTP_AUTH_HEADER) {
    headers.Authorization = process.env.SMS_OTP_AUTH_HEADER;
  }
  return requestHttps({
    method: "POST",
    url,
    headers,
    body: JSON.stringify({
      phone,
      otp,
      app: "Market History Lab",
      message: `Market History Lab OTP: ${otp}. Ye OTP 5 minutes ke liye valid hai.`
    })
  });
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
  const baseRoot = decodedPath === "/index.html" ? appRoot : publicRoot;
  const filePath = path.resolve(baseRoot, `.${decodedPath}`);
  if (!filePath.startsWith(baseRoot)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const cacheHeader = ext === ".html"
      ? "no-store, max-age=0"
      : "public, max-age=60";
    res.writeHead(200, corsHeaders({
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": cacheHeader
    }));
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
