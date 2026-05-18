function normalizeDatasetName(value) {
  return String(value || "dataset")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "dataset";
}

function parseOptionCsv(csv) {
  const lines = String(csv || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error("CSV me header aur at least 1 data row chahiye.");
  const headers = splitCsvLine(lines[0]).map((item) => item.trim().toLowerCase());
  if (isNseBhavcopy(headers)) return parseNseBhavcopy(lines, headers);

  const required = ["date", "time", "underlying", "expiry", "strike", "type", "open", "high", "low", "close"];
  const missing = required.filter((key) => !headers.includes(key));
  if (missing.length) throw new Error(`CSV headers missing: ${missing.join(", ")}`);

  const rows = [];
  const warnings = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i]);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    const parsed = {
      date: clean(row.date),
      time: clean(row.time || "09:15"),
      symbol: clean(row.symbol || `${row.underlying}${row.expiry}${row.strike}${row.type}`),
      underlying: clean(row.underlying).toUpperCase(),
      expiry: clean(row.expiry),
      strike: Number(row.strike),
      type: clean(row.type).toUpperCase(),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume || 0)
    };
    const valid = parsed.date && parsed.expiry && ["CE", "PE", "CALL", "PUT"].includes(parsed.type) &&
      [parsed.strike, parsed.open, parsed.high, parsed.low, parsed.close].every(Number.isFinite);
    if (!valid) {
      warnings.push(`Line ${i + 1} skipped`);
      continue;
    }
    parsed.type = parsed.type === "CALL" ? "CE" : parsed.type === "PUT" ? "PE" : parsed.type;
    rows.push(parsed);
  }
  rows.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`) || a.strike - b.strike);
  if (!rows.length) throw new Error("CSV parse hua, lekin valid option candles nahi mile.");
  return { rows, warnings };
}

function isNseBhavcopy(headers) {
  const modern = ["trad_dt", "tckrsymb", "xprydt", "strkpric", "opntp", "opnpric", "hghpric", "lwpric", "clspric"];
  const modernAlt = ["traddt", "tckrsymb", "xprydt", "strkpric", "optntp", "opnpric", "hghpric", "lwpric", "clspric"];
  const old = ["instrument", "symbol", "expiry_dt", "strike_pr", "option_typ", "open", "high", "low", "close", "timestamp"];
  return modern.every((key) => headers.includes(key)) ||
    modernAlt.every((key) => headers.includes(key)) ||
    old.every((key) => headers.includes(key));
}

function parseNseBhavcopy(lines, headers) {
  const rows = [];
  const warnings = [];
  for (let i = 1; i < lines.length; i++) {
    const values = splitCsvLine(lines[i]);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
    const modern = row.tckrsymb || row.tckr_symb;
    const symbol = clean(modern || row.symbol).toUpperCase();
    const optionType = clean(row.opntp || row.optntp || row.optn_tp || row.option_typ).toUpperCase();
    const instrument = clean(row.instrument || row.fininstrmtp || row.fin_instrm_tp).toUpperCase();
    const isOption = ["CE", "PE", "CALL", "PUT"].includes(optionType) &&
      (!instrument || instrument.includes("OPT") || instrument.includes("STO") || instrument.includes("IDO"));
    if (!isOption) continue;

    const parsed = {
      date: parseDate(row.trad_dt || row.traddt || row.timestamp || row.bizdt),
      time: "15:30",
      symbol: clean(row.fininstrmnm || row.fin_instrm_nm || `${symbol}${row.xprydt || row.expiry_dt}${row.strkpric || row.strike_pr}${optionType}`),
      underlying: symbol,
      expiry: parseDate(row.xprydt || row.expiry_dt || row.fininstrmactlxprydt),
      strike: Number(row.strkpric || row.strike_pr),
      type: optionType === "CALL" ? "CE" : optionType === "PUT" ? "PE" : optionType,
      open: Number(row.opnpric || row.open),
      high: Number(row.hghpric || row.high),
      low: Number(row.lwpric || row.low),
      close: Number(row.clspric || row.close),
      volume: Number(row.ttltrdvol || row.ttltradgvol || row.contracts || row.volume || 0)
    };
    const valid = parsed.date && parsed.expiry &&
      [parsed.strike, parsed.open, parsed.high, parsed.low, parsed.close].every(Number.isFinite);
    if (!valid) {
      warnings.push(`NSE line ${i + 1} skipped`);
      continue;
    }
    rows.push(parsed);
  }
  rows.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`) || a.strike - b.strike);
  if (!rows.length) throw new Error("NSE bhavcopy parse hua, lekin valid CE/PE option rows nahi mile.");
  return { rows, warnings };
}

function splitCsvLine(line) {
  const out = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];
    if (char === "\"" && quoted && next === "\"") {
      current += "\"";
      i++;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      out.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  out.push(current);
  return out;
}

function clean(value) {
  return String(value ?? "").trim();
}

function parseDate(value) {
  const raw = clean(value);
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const slash = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (slash) return `${slash[3]}-${slash[2].padStart(2, "0")}-${slash[1].padStart(2, "0")}`;
  const monthMap = {
    JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
    JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12"
  };
  const named = raw.toUpperCase().match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/);
  if (named && monthMap[named[2]]) return `${named[3]}-${monthMap[named[2]]}-${named[1].padStart(2, "0")}`;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

module.exports = { normalizeDatasetName, parseOptionCsv };
