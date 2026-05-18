function runOptionsBacktest(rows, config = {}) {
  const legs = Array.isArray(config.legs) && config.legs.length ? config.legs : defaultLegs(rows, config);
  const filtered = rows.filter((row) => matchesConfig(row, config));
  if (!filtered.length) throw new Error("Selected filters ke liye data nahi mila.");

  const timeline = [...new Set(filtered.map((row) => `${row.date} ${row.time}`))].sort();
  const startKey = pickStartKey(timeline, config);
  const exitKey = pickExitKey(timeline, config);
  if (!startKey || !exitKey || startKey >= exitKey) throw new Error("Entry/exit time valid nahi hai.");

  const charges = {
    brokeragePerOrder: Number(config.charges?.brokeragePerOrder ?? config.brokeragePerOrder ?? 20),
    slippagePct: Number(config.charges?.slippagePct ?? config.slippagePct ?? 0.03)
  };
  const trades = legs.map((leg) => simulateLeg(filtered, leg, startKey, exitKey, charges));
  const netPnl = sum(trades.map((trade) => trade.pnl));
  const grossPnl = sum(trades.map((trade) => trade.grossPnl));
  const totalCharges = sum(trades.map((trade) => trade.charges));
  const wins = trades.filter((trade) => trade.pnl > 0).length;
  const points = equityCurve(trades, timeline, startKey, exitKey);
  const maxDrawdown = drawdown(points.map((point) => point.pnl));

  return {
    summary: {
      netPnl: round(netPnl),
      grossPnl: round(grossPnl),
      totalCharges: round(totalCharges),
      maxProfit: round(Math.max(...points.map((point) => point.pnl), netPnl)),
      maxLoss: round(Math.min(...points.map((point) => point.pnl), netPnl)),
      maxDrawdown: round(maxDrawdown),
      winRate: trades.length ? round((wins / trades.length) * 100, 2) : 0,
      totalLegs: trades.length,
      entry: startKey,
      exit: exitKey
    },
    trades,
    equity: points,
    notes: resultNotes(netPnl, maxDrawdown, trades)
  };
}

function simulateLeg(rows, leg, startKey, fallbackExitKey, charges) {
  const type = normalizeType(leg.type);
  const side = normalizeSide(leg.side);
  const strike = Number(leg.strike);
  const qty = Math.max(1, Number(leg.qty || leg.quantity || 1));
  const legRows = rows.filter((row) => row.strike === strike && row.type === type);
  const entry = findAtOrAfter(legRows, startKey);
  if (!entry) throw new Error(`Entry candle missing for ${strike} ${type}`);

  const entryPrice = applySlippage(entry.close, side === "BUY" ? 1 : -1, charges.slippagePct);
  const slPct = Number(leg.slPct ?? leg.sl ?? 0);
  const targetPct = Number(leg.targetPct ?? leg.target ?? 0);
  let exit = findAtOrAfter(legRows, fallbackExitKey) || legRows.at(-1);
  let exitPrice = exit.close;
  let reason = "Time exit";

  for (const row of legRows.filter((item) => keyOf(item) > startKey && keyOf(item) <= fallbackExitKey)) {
    if (side === "BUY") {
      if (slPct > 0 && row.low <= entryPrice * (1 - slPct / 100)) {
        exit = row;
        exitPrice = entryPrice * (1 - slPct / 100);
        reason = "Leg SL hit";
        break;
      }
      if (targetPct > 0 && row.high >= entryPrice * (1 + targetPct / 100)) {
        exit = row;
        exitPrice = entryPrice * (1 + targetPct / 100);
        reason = "Leg target hit";
        break;
      }
    } else {
      if (slPct > 0 && row.high >= entryPrice * (1 + slPct / 100)) {
        exit = row;
        exitPrice = entryPrice * (1 + slPct / 100);
        reason = "Leg SL hit";
        break;
      }
      if (targetPct > 0 && row.low <= entryPrice * (1 - targetPct / 100)) {
        exit = row;
        exitPrice = entryPrice * (1 - targetPct / 100);
        reason = "Leg target hit";
        break;
      }
    }
  }

  exitPrice = applySlippage(exitPrice, side === "BUY" ? -1 : 1, charges.slippagePct);
  const grossPnl = side === "BUY" ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
  const totalCharges = charges.brokeragePerOrder * 2;
  const pnl = grossPnl - totalCharges;
  return {
    side,
    type,
    strike,
    qty,
    entryAt: keyOf(entry),
    exitAt: keyOf(exit),
    entryPrice: round(entryPrice),
    exitPrice: round(exitPrice),
    grossPnl: round(grossPnl),
    charges: round(totalCharges),
    pnl: round(pnl),
    reason
  };
}

function defaultLegs(rows, config) {
  const first = rows.find((row) => matchesConfig(row, config));
  if (!first) return [];
  return [{ side: "BUY", type: first.type, strike: first.strike, qty: config.qty || 50, slPct: 30, targetPct: 60 }];
}

function matchesConfig(row, config) {
  const underlying = String(config.underlying || row.underlying).toUpperCase();
  const expiry = String(config.expiry || row.expiry);
  if (row.underlying !== underlying) return false;
  if (config.expiry && row.expiry !== expiry) return false;
  if (config.startDate && row.date < config.startDate) return false;
  if (config.endDate && row.date > config.endDate) return false;
  return true;
}

function pickStartKey(timeline, config) {
  const startDate = config.startDate || timeline[0]?.slice(0, 10);
  const entryTime = config.entryTime || "09:20";
  return timeline.find((key) => key >= `${startDate} ${entryTime}`) || timeline[0];
}

function pickExitKey(timeline, config) {
  const endDate = config.endDate || timeline.at(-1)?.slice(0, 10);
  const exitTime = config.exitTime || "15:20";
  return [...timeline].reverse().find((key) => key <= `${endDate} ${exitTime}`) || timeline.at(-1);
}

function equityCurve(trades, timeline, startKey, exitKey) {
  const points = timeline.filter((key) => key >= startKey && key <= exitKey).map((key) => {
    const pnl = sum(trades.map((trade) => {
      if (key < trade.entryAt) return 0;
      if (key >= trade.exitAt) return trade.pnl;
      return trade.pnl * progress(trade.entryAt, trade.exitAt, key);
    }));
    return { time: key, pnl: round(pnl) };
  });
  return points.length ? points : [{ time: exitKey, pnl: sum(trades.map((trade) => trade.pnl)) }];
}

function progress(start, end, current) {
  const s = Date.parse(start.replace(" ", "T"));
  const e = Date.parse(end.replace(" ", "T"));
  const c = Date.parse(current.replace(" ", "T"));
  if (!Number.isFinite(s + e + c) || e <= s) return 1;
  return Math.max(0, Math.min(1, (c - s) / (e - s)));
}

function drawdown(values) {
  let peak = values[0] || 0;
  let maxDd = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    maxDd = Math.min(maxDd, value - peak);
  }
  return maxDd;
}

function findAtOrAfter(rows, key) {
  return rows.find((row) => keyOf(row) >= key) || rows.at(-1);
}

function keyOf(row) {
  return `${row.date} ${row.time}`;
}

function normalizeType(type) {
  const value = String(type || "CE").toUpperCase();
  return value === "CALL" ? "CE" : value === "PUT" ? "PE" : value;
}

function normalizeSide(side) {
  const value = String(side || "BUY").toUpperCase();
  return value === "SELL" || value === "SHORT" ? "SELL" : "BUY";
}

function applySlippage(price, direction, slippagePct) {
  return Number(price) * (1 + direction * (Number(slippagePct) || 0) / 100);
}

function resultNotes(netPnl, maxDrawdown, trades) {
  const notes = [];
  notes.push(netPnl >= 0 ? "Strategy positive close hui." : "Strategy negative close hui, risk settings review karo.");
  if (maxDrawdown < -1000) notes.push("Drawdown high hai, leg-wise SL ya smaller qty test karo.");
  if (trades.some((trade) => trade.reason.includes("SL"))) notes.push("At least ek leg SL hit hua.");
  if (trades.some((trade) => trade.reason.includes("target"))) notes.push("At least ek leg target hit hua.");
  return notes;
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function round(value, decimals = 2) {
  return Number(Number(value || 0).toFixed(decimals));
}

module.exports = { runOptionsBacktest };
