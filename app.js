
/* SPACE TRADER V2.2 — MARKET INTELLIGENCE ENGINE
   Public reference feed: biquote.io
   No API key. No broker login. No order execution.
   Public quotes are NOT Space Markets execution prices.
   Rule-based analysis only. NOT AI-generated trading advice.
*/
"use strict";

const API = "https://biquote.io/api";
const STORE = "spaceTraderV2";

const SYMBOLS = ["XAUUSD", "NAS100", "US30", "GER30"];

const FRAMES = [
  { name: "H4", interval: "4h", ms: 14400000 },
  { name: "H1", interval: "1h", ms: 3600000 },
  { name: "M30", interval: "30m", ms: 1800000 },
  { name: "M15", interval: "15m", ms: 900000 }
];

const state = {
  quotes: {},
  candles: {},
  symbols: {},
  trades: [],
  signals: [],
  settings: {},
  manualQuotes: {}
};

const $ = id => document.getElementById(id);

function zar(value) {
  return "R" + Number(value || 0).toFixed(2);
}

function price(value) {
  const n = Number(value);
  return Number.isFinite(n)
    ? n.toLocaleString("en-ZA", { maximumFractionDigits: 5 })
    : "—";
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function toast(message) {
  const el = $("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2500);
}

/* STORAGE — V2.1 DATA FORMAT PRESERVED */

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "{}");
    state.trades = Array.isArray(saved.trades) ? saved.trades : [];
    state.signals = Array.isArray(saved.signals) ? saved.signals : [];
    state.settings = saved.settings || {};
    state.manualQuotes = saved.manualQuotes || {};
  } catch (error) {
    state.trades = [];
    state.signals = [];
    state.settings = {};
    state.manualQuotes = {};
  }
}

function save() {
  localStorage.setItem(STORE, JSON.stringify({
    trades: state.trades,
    signals: state.signals,
    settings: state.settings,
    manualQuotes: state.manualQuotes
  }));
}

/* PUBLIC MARKET DATA */

async function getJSON(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("Market data HTTP " + response.status);
  return response.json();
}

async function discoverSymbols() {
  state.symbols = {
    XAUUSD: "XAUUSD",
    NAS100: "USTEC",
    US30: "US30",
    GER30: "DE30"
  };
}

function quality(quote) {
  if (!quote) return ["DATA UNAVAILABLE", "red"];
  if (quote.marketState === "closed") return ["PREVIOUS CLOSE", "amber"];
  if (quote.stale === true) return ["STALE — NO TRADE", "red"];

  const age = Number(quote.quoteAgeSeconds);
  if (!Number.isFinite(age)) return ["AGE UNKNOWN — NO TRADE", "red"];
  if (age <= 60) return ["LIVE PUBLIC REFERENCE", "green"];
  if (age <= 300) return ["DELAYED PUBLIC REFERENCE", "amber"];
  return ["STALE — NO TRADE", "red"];
}

async function getQuote(symbol) {
  return getJSON(API + "/" + encodeURIComponent(symbol) + "?allowStale=true");
}

async function getCandles(symbol, frame) {
  const data = await getJSON(
    API + "/" + encodeURIComponent(symbol) +
    "/ohlc?interval=" + frame.interval + "&limit=150"
  );

  if (!data || !Array.isArray(data.bars)) {
    throw new Error("Candle data unavailable");
  }

  return data.bars
    .filter(bar =>
      bar &&
      bar.isOpen !== true &&
      [bar.open, bar.high, bar.low, bar.close].every(
        value => Number.isFinite(Number(value))
      )
    )
    .map(bar => ({
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      time: Date.parse(bar.openTime)
    }))
    .filter(bar =>
      Number.isFinite(bar.time) &&
      bar.high >= bar.low &&
      bar.high >= Math.max(bar.open, bar.close) &&
      bar.low <= Math.min(bar.open, bar.close)
    )
    .sort((a, b) => a.time - b.time);
}

/* DATA FRESHNESS */

function candleFreshness(bars, frame) {
  if (!bars || bars.length < 30) {
    return { fresh: false, age: null, label: "INSUFFICIENT DATA" };
  }

  const last = bars[bars.length - 1];
  const age = Date.now() - last.time;

  // Allow a limited delay for provider publication and market sessions.
  const limit = frame.ms * 2.5;
  const fresh = age >= -60000 && age <= limit;

  return {
    fresh,
    age,
    label: fresh
      ? "FRESH"
      : age < 0
        ? "FUTURE TIMESTAMP"
        : "STALE CANDLES"
  };
}

/* MARKET STRUCTURE ENGINE */

function analyse(bars) {
  if (!bars || bars.length < 30) {
    return {
      bias: "UNAVAILABLE",
      event: "INSUFFICIENT CANDLES",
      support: null,
      resistance: null,
      lastClose: null
    };
  }

  const highs = [];
  const lows = [];

  for (let i = 2; i < bars.length - 2; i++) {
    const bar = bars[i];

    if (
      bar.high > bars[i - 1].high &&
      bar.high > bars[i - 2].high &&
      bar.high >= bars[i + 1].high &&
      bar.high >= bars[i + 2].high
    ) {
      highs.push({ i, value: bar.high });
    }

    if (
      bar.low < bars[i - 1].low &&
      bar.low < bars[i - 2].low &&
      bar.low <= bars[i + 1].low &&
      bar.low <= bars[i + 2].low
    ) {
      lows.push({ i, value: bar.low });
    }
  }

  if (highs.length < 2 || lows.length < 2) {
    return {
      bias: "UNAVAILABLE",
      event: "SWING DATA INSUFFICIENT",
      support: null,
      resistance: null,
      lastClose: null
    };
  }

  const h1 = highs[highs.length - 1].value;
  const h0 = highs[highs.length - 2].value;
  const l1 = lows[lows.length - 1].value;
  const l0 = lows[lows.length - 2].value;

  let bias = "RANGE";
  if (h1 > h0 && l1 > l0) bias = "BULLISH";
  if (h1 < h0 && l1 < l0) bias = "BEARISH";

  const last = bars[bars.length - 1];
  const previous = bars[bars.length - 2];

  const oldHigh = highs.filter(item => item.i < bars.length - 1).slice(-1)[0];
  const oldLow = lows.filter(item => item.i < bars.length - 1).slice(-1)[0];

  let event = "NO CONFIRMED BREAK";

  const bullishBreak = oldHigh &&
    last.close > oldHigh.value &&
    previous.close <= oldHigh.value;

  const bearishBreak = oldLow &&
    last.close < oldLow.value &&
    previous.close >= oldLow.value;

  if (bullishBreak) {
    event = bias === "BEARISH" ? "BULLISH CHoCH" : "BULLISH BOS";
  } else if (bearishBreak) {
    event = bias === "BULLISH" ? "BEARISH CHoCH" : "BEARISH BOS";
  }

  // Recent swing levels are reference zones, not guaranteed reversals.
  const recentHighs = highs.filter(item => item.i >= bars.length - 45);
  const recentLows = lows.filter(item => item.i >= bars.length - 45);

  const resistance = recentHighs.length
    ? Math.max(...recentHighs.map(item => item.value))
    : h1;

  const support = recentLows.length
    ? Math.min(...recentLows.map(item => item.value))
    : l1;

  return {
    bias,
    event,
    support,
    resistance,
    lastClose: last.close,
    swingHigh: h1,
    swingLow: l1
  };
}

/* M15 PULLBACK AND CONTINUATION */

function m15Confirmation(bars, side, analysis) {
  if (!bars || bars.length < 30 || !analysis) {
    return { confirmed: false, reason: "M15 data unavailable" };
  }

  const last = bars[bars.length - 1];
  const previous = bars[bars.length - 2];

  const range = last.high - last.low;
  if (range <= 0) {
    return { confirmed: false, reason: "Invalid M15 candle range" };
  }

  const body = Math.abs(last.close - last.open);
  const bodyStrength = body / range;

  const tolerance = Math.abs(last.close) * 0.0015;

  if (side === "BUY") {
    const touchedSupport =
      last.low <= analysis.support + tolerance ||
      previous.low <= analysis.support + tolerance;

    const bullishClose =
      last.close > last.open &&
      last.close > previous.close &&
      bodyStrength >= 0.35;

    return {
      confirmed: touchedSupport && bullishClose,
      reason: touchedSupport && bullishClose
        ? "Support test and bullish continuation candle"
        : "No confirmed support pullback and bullish continuation"
    };
  }

  const touchedResistance =
    last.high >= analysis.resistance - tolerance ||
    previous.high >= analysis.resistance - tolerance;

  const bearishClose =
    last.close < last.open &&
    last.close < previous.close &&
    bodyStrength >= 0.35;

  return {
    confirmed: touchedResistance && bearishClose,
    reason: touchedResistance && bearishClose
      ? "Resistance test and bearish continuation candle"
      : "No confirmed resistance pullback and bearish continuation"
  };
}

/* SIGNAL SCORING — RULE-BASED, NOT AI */

function scoreSetup(results, freshness, quoteIsFresh, side, pullback) {
  let score = 0;
  const reasons = [];

  const expected = side === "BUY" ? "BULLISH" : "BEARISH";

  if (results.H4?.bias === expected) {
    score += 20;
    reasons.push("H4 trend aligned (+20)");
  } else {
    reasons.push("H4 trend not aligned (+0)");
  }

  if (results.H1?.bias === expected) {
    score += 20;
    reasons.push("H1 trend aligned (+20)");
  } else {
    reasons.push("H1 trend not aligned (+0)");
  }

  if (results.M30?.bias === expected) {
    score += 15;
    reasons.push("M30 structure aligned (+15)");
  } else {
    reasons.push("M30 structure not aligned (+0)");
  }

  const m15Event = results.M15?.event || "";
  const correctEvent = side === "BUY"
    ? ["BULLISH BOS", "BULLISH CHoCH"].includes(m15Event)
    : ["BEARISH BOS", "BEARISH CHoCH"].includes(m15Event);

  if (correctEvent) {
    score += 15;
    reasons.push("M15 structure break (+15)");
  } else {
    reasons.push("No matching M15 structure break (+0)");
  }

  if (pullback?.confirmed) {
    score += 20;
    reasons.push("M15 pullback and continuation confirmed (+20)");
  } else {
    reasons.push("M15 pullback confirmation missing (+0)");
  }

  const allFresh = Object.values(freshness).length === 4 &&
    Object.values(freshness).every(item => item.fresh);

  if (allFresh && quoteIsFresh) {
    score += 10;
    reasons.push("Quote and all candle data fresh (+10)");
  } else {
    reasons.push("Quote or candle freshness failed (+0)");
  }

  return {
    score,
    reasons,
    allFresh
  };
}

/* MARKET DISPLAY */

function renderMarkets() {
  const cards = $("marketCards");
  const rows = $("watchRows");

  const html = SYMBOLS.map(symbol => {
    const quote = state.quotes[symbol];
    const supported = !!state.symbols[symbol];
    const status = quality(quote);
    const mid = quote ? Number(quote.mid) : NaN;
    const manual = state.manualQuotes[symbol];

    return `
      <article class="market-card">
        <div class="market-top">
          <strong>${symbol}</strong>
          <span class="tag ${supported ? status[1] : "red"}">
            ${supported ? status[0] : "UNSUPPORTED"}
          </span>
        </div>
        <div class="market-price">
          ${Number.isFinite(mid) ? price(mid) : "—"}
        </div>
        <div class="quote-status">${status[0]}</div>
        <div class="feed-meta">
          Source: ${quote ? esc(quote.source || "biquote") : "Unavailable"}<br>
          ${quote ? "Timestamp: " + esc(quote.timestamp || "Unknown") : ""}
          ${quote ? "<br>Quote age: " + esc(quote.quoteAgeSeconds) + " seconds" : ""}
          ${manual
            ? "<br>Manual record: " + price(manual.price) +
              " · " + esc(manual.source)
            : ""}
        </div>
      </article>`;
  }).join("");

  if (cards) cards.innerHTML = html;
  if (rows) rows.innerHTML = html;
}

/* MARKET INTELLIGENCE SCANNER */

function renderSignals() {
  const list = $("signalList");
  if (!list) return;

  const analysisCards = SYMBOLS.map(symbol => {
    const quote = state.quotes[symbol];
    const quoteStatus = quality(quote);
    const frames = state.candles[symbol] || {};

    const results = {};
    const freshness = {};

    FRAMES.forEach(frame => {
      const bars = frames[frame.name];
      results[frame.name] = bars ? analyse(bars) : null;
      freshness[frame.name] = candleFreshness(bars, frame);
    });

    const missing = FRAMES.some(frame =>
      !results[frame.name] ||
      results[frame.name].bias === "UNAVAILABLE"
    );

    const quoteAge = Number(quote?.quoteAgeSeconds);
    const quoteIsFresh =
      !!quote &&
      quote.stale !== true &&
      quote.marketState !== "closed" &&
      Number.isFinite(quoteAge) &&
      quoteAge <= 60;

    const buyPullback = m15Confirmation(
      frames.M15,
      "BUY",
      results.M15
    );

    const sellPullback = m15Confirmation(
      frames.M15,
      "SELL",
      results.M15
    );

    const buyScore = scoreSetup(
      results, freshness, quoteIsFresh, "BUY", buyPullback
    );

    const sellScore = scoreSetup(
      results, freshness, quoteIsFresh, "SELL", sellPullback
    );

    const buyAligned =
      results.H4?.bias === "BULLISH" &&
      results.H1?.bias === "BULLISH" &&
      results.M30?.bias === "BULLISH" &&
      results.M15?.bias === "BULLISH";

    const sellAligned =
      results.H4?.bias === "BEARISH" &&
      results.H1?.bias === "BEARISH" &&
      results.M30?.bias === "BEARISH" &&
      results.M15?.bias === "BEARISH";

    const buyEvent = ["BULLISH BOS", "BULLISH CHoCH"]
      .includes(results.M15?.event);

    const sellEvent = ["BEARISH BOS", "BEARISH CHoCH"]
      .includes(results.M15?.event);

    const allFresh = !missing &&
      Object.values(freshness).every(item => item.fresh);

    const buyReady =
      buyAligned &&
      buyEvent &&
      buyPullback.confirmed &&
      allFresh &&
      quoteIsFresh;

    const sellReady =
      sellAligned &&
      sellEvent &&
      sellPullback.confirmed &&
      allFresh &&
      quoteIsFresh;

    let outcome = "NO TRADE";
    let chosen = null;
    let side = null;

    if (buyReady && buyScore.score >= 75) {
      outcome = "BUY WATCH — MANUAL REVIEW";
      chosen = buyScore;
      side = "BUY";
    } else if (sellReady && sellScore.score >= 75) {
      outcome = "SELL WATCH — MANUAL REVIEW";
      chosen = sellScore;
      side = "SELL";
    }

    const frameLines = FRAMES.map(frame => {
      const result = results[frame.name];
      const fresh = freshness[frame.name];

      return `
        <p>
          <strong>${frame.name}:</strong>
          ${result ? result.bias + " / " + result.event : "UNAVAILABLE"}
          · ${fresh.label}
        </p>`;
    }).join("");

    const levelText = results.H1
      ? "H1 support: " + price(results.H1.support) +
        " · H1 resistance: " + price(results.H1.resistance)
      : "H1 levels unavailable";

    const scoreText = chosen
      ? chosen.score + "/100"
      : "BUY " + buyScore.score + "/100 · SELL " + sellScore.score + "/100";

    const reasonText = chosen
      ? chosen.reasons.join(" · ")
      : "Mandatory conditions not satisfied. Score cannot override missing confirmation.";

    return `
      <article class="list-card">
        <strong>${symbol} — ${outcome}</strong>
        <p>Quote: ${quote ? price(quote.mid) : "Unavailable"}</p>
        <p>Quote quality: ${quoteStatus[0]}</p>
        ${frameLines}
        <p>${esc(levelText)}</p>
        <p><strong>Setup score:</strong> ${scoreText}</p>
        <p>${esc(reasonText)}</p>
        <p><strong>M15 BUY check:</strong> ${esc(buyPullback.reason)}</p>
        <p><strong>M15 SELL check:</strong> ${esc(sellPullback.reason)}</p>
        <small>
          ${side
            ? "Conditions detected. This is a watchlist result, not an entry instruction."
            : "Evidence incomplete, stale, unaligned or lacking confirmation. Stand aside."}
        </small>
      </article>`;
  });

  const saved = state.signals.map(signal => {
    const hasCash =
      signal.riskCash !== undefined &&
      signal.potentialReward !== undefined;

    const cashDetails = hasCash
      ? `<p>Planned risk: ${zar(signal.riskCash)}
          (${Number(signal.riskPercent).toFixed(1)}% of ${zar(signal.capital)})
          · Potential reward: ${zar(signal.potentialReward)} before costs</p>`
      : "<p>Cash assessment unavailable for this older saved setup.</p>";

    return `
      <article class="list-card">
        <strong>${esc(signal.symbol)} ${esc(signal.side)}
          · 1:${Number(signal.rr).toFixed(2)}</strong>
        <p>Entry ${price(signal.entry)}
          · SL ${price(signal.sl)}
          · TP1 ${price(signal.tp)}</p>
        ${cashDetails}
        <p>Timeframe assessment:
          ${esc(signal.alignment || "Not recorded")}</p>
        <p>${esc(signal.timeframe)}
          · ${esc(signal.reason || "No notes")}</p>
        <small>Manual setup — not a verified feed signal.</small>
      </article>`;
  });

  list.innerHTML = [...analysisCards, ...saved].join("");

  if ($("signalCount")) {
    $("signalCount").textContent =
      state.signals.length + " saved setups";
  }
}

/* COMPLETE MARKET SCAN */

async function scan() {
  const badge = $("feedBadge");

  if (badge) {
    badge.textContent = "SCANNING";
    badge.className = "tag amber";
  }

  try {
    await discoverSymbols();

    for (const symbol of SYMBOLS) {
      const exactSymbol = state.symbols[symbol];

      if (!exactSymbol) {
        state.quotes[symbol] = null;
        state.candles[symbol] = {};
        continue;
      }

      try {
        state.quotes[symbol] = await getQuote(exactSymbol);
      } catch (error) {
        state.quotes[symbol] = null;
      }

      state.candles[symbol] = {};

      const results = await Promise.allSettled(
        FRAMES.map(frame => getCandles(exactSymbol, frame))
      );

      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          state.candles[symbol][FRAMES[index].name] = result.value;
        }
      });
    }

    renderMarkets();
    renderSignals();

    const now = new Date().toLocaleString("en-ZA");

    if ($("feedTitle")) {
      $("feedTitle").textContent = "Public reference feed";
    }

    if ($("feedMessage")) {
      $("feedMessage").textContent =
        "biquote reference data. Not your Space Markets execution feed.";
    }

    if ($("feedMeta")) $("feedMeta").textContent = "Last scan: " + now;
    if ($("settingsFeedMeta")) {
      $("settingsFeedMeta").textContent = "Last scan: " + now;
    }

    if ($("settingsFeedBadge")) {
      $("settingsFeedBadge").textContent = "PUBLIC DATA";
      $("settingsFeedBadge").className = "tag green";
    }

    if (badge) {
      badge.textContent = "SCAN COMPLETE";
      badge.className = "tag green";
    }
  } catch (error) {
    if (badge) {
      badge.textContent = "FEED ERROR";
      badge.className = "tag red";
    }

    if ($("feedMessage")) {
      $("feedMessage").textContent =
        "DATA UNAVAILABLE. No trade signals generated. " + error.message;
    }

    if ($("settingsFeedBadge")) {
      $("settingsFeedBadge").textContent = "FEED ERROR";
      $("settingsFeedBadge").className = "tag red";
    }

    toast("Market data unavailable. No trade.");
  }
}

/* NAVIGATION */

function setupNavigation() {
  document.querySelectorAll("[data-page]").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".page").forEach(page => {
        page.classList.remove("active");
      });

      document.querySelectorAll(".nav-item").forEach(item => {
        item.classList.remove("active");
      });

      const page = $("page-" + button.dataset.page);
      if (page) page.classList.add("active");
      button.classList.add("active");
    });
  });

  document.querySelectorAll("[data-go]").forEach(button => {
    button.addEventListener("click", () => {
      const target = document.querySelector(
        '[data-page="' + button.dataset.go + '"]'
      );
      if (target) target.click();
    });
  });
}

/* RISK CALCULATOR */

function setupRisk() {
  const update = () => {
    const capital = Number($("capitalInput")?.value) || 500;
    const percent = Number($("riskPct")?.value) || 1;
    const risk = capital * percent / 100;

    if ($("capitalDisplay")) $("capitalDisplay").textContent = zar(capital);
    if ($("riskCash")) $("riskCash").textContent = zar(risk);
    if ($("riskSummary")) $("riskSummary").textContent = zar(risk);

    if ($("riskPctLabel")) {
      $("riskPctLabel").textContent = percent.toFixed(1) + "%";
    }

    if ($("riskPctCaption")) {
      $("riskPctCaption").textContent =
        percent.toFixed(1) + "% of " + zar(capital);
    }

    const stop = Number($("stopPoints")?.value) || 0;
    const pointValue = Number($("pointValue")?.value) || 0;
    const costs =
      (Number($("spreadCost")?.value) || 0) +
      (Number($("commission")?.value) || 0);

    const minLot = Number($("minLot")?.value) || 0;
    const step = Number($("lotStep")?.value) || 0;

    if (stop > 0 && pointValue > 0 && step > 0) {
      const denominator = stop * pointValue + costs;
      const rawLot = denominator > 0 ? risk / denominator : 0;
      const lot = Math.floor((rawLot + 1e-10) / step) * step;

      if ($("lotResult")) {
        $("lotResult").textContent =
          lot >= minLot ? lot.toFixed(4) : "NO TRADE";
      }

      if ($("lotExplain")) {
        $("lotExplain").textContent =
          lot >= minLot
            ? "Estimate only. Verify broker specifications."
            : "Minimum lot may exceed planned risk.";
      }
    } else {
      if ($("lotResult")) $("lotResult").textContent = "Not calculated";
      if ($("lotExplain")) {
        $("lotExplain").textContent =
          "Enter verified point value and costs.";
      }
    }

    const dailyPercent = Number($("dailyPct")?.value) || 2;
    const daily = capital * dailyPercent / 100;

    if ($("dailyRiskText")) {
      $("dailyRiskText").textContent =
        "Daily loss limit: " + zar(daily);
    }

    if ($("dailyLimitSummary")) {
      $("dailyLimitSummary").textContent = zar(daily);
    }
  };

  [
    "capitalInput", "riskPct", "dailyPct", "stopPoints",
    "pointValue", "spreadCost", "commission", "minLot", "lotStep"
  ].forEach(id => $(id)?.addEventListener("input", update));

  update();
}

/* TIMEFRAME ASSESSMENT FOR MANUAL SETUPS */

function signalTimeframeAssessment(symbol, side) {
  const frames = state.candles[symbol] || {};

  const results = FRAMES.map(frame => {
    const bars = frames[frame.name];
    const result = bars ? analyse(bars) : null;
    return {
      name: frame.name,
      bias: result ? result.bias : "UNAVAILABLE"
    };
  });

  const missing = results.filter(item => item.bias === "UNAVAILABLE");

  if (missing.length) {
    return "INCOMPLETE — Missing: " +
      missing.map(item => item.name).join(", ");
  }

  const expected = side === "BUY" ? "BULLISH" : "BEARISH";
  const opposite = side === "BUY" ? "BEARISH" : "BULLISH";

  if (results.every(item => item.bias === expected)) {
    return "ALIGNED — All four timeframes are " + expected;
  }

  if (results.some(item => item.bias === opposite)) {
    return "CONFLICT — One or more timeframes oppose this setup";
  }

  return "NOT ALIGNED — Range or mixed structure detected";
}

/* CASH RISK AND REWARD ESTIMATE */

function signalCashAssessment(rr) {
  const capital = Number($("capitalInput")?.value) || 500;
  const riskPercent = Number($("riskPct")?.value) || 1;
  const riskCash = capital * riskPercent / 100;

  return {
    capital,
    riskPercent,
    riskCash,
    potentialReward: riskCash * rr
  };
}

/* MANUAL SIGNAL BUILDER */

function setupSignals() {
  const form = $("signalForm");
  if (!form) return;

  form.addEventListener("submit", event => {
    event.preventDefault();

    const symbol = $("sigSymbol").value;
    const side = $("sigSide").value;
    const entry = Number($("sigEntry").value);
    const sl = Number($("sigSL").value);
    const tp = Number($("sigTP1").value);

    const validNumbers =
      Number.isFinite(entry) &&
      Number.isFinite(sl) &&
      Number.isFinite(tp) &&
      entry > 0 && sl > 0 && tp > 0;

    const validDirection = side === "BUY"
      ? sl < entry && tp > entry
      : sl > entry && tp < entry;

    if (!validNumbers || !validDirection) {
      toast("Check entry, stop loss and target direction.");
      return;
    }

    const riskDistance = Math.abs(entry - sl);
    const rewardDistance = Math.abs(tp - entry);

    if (riskDistance <= 0) {
      toast("Entry and stop loss cannot be the same.");
      return;
    }

    const rr = rewardDistance / riskDistance;
    const cash = signalCashAssessment(rr);
    const alignment = signalTimeframeAssessment(symbol, side);

    const record = {
      symbol,
      side,
      entry,
      sl,
      tp,
      timeframe: $("sigTF").value,
      reason: $("sigReason").value,
      rr,
      capital: cash.capital,
      riskPercent: cash.riskPercent,
      riskCash: cash.riskCash,
      potentialReward: cash.potentialReward,
      alignment,
      date: new Date().toISOString()
    };

    state.signals.unshift(record);
    save();

    if ($("signalResult")) {
      $("signalResult").classList.remove("hidden");
      $("signalResult").textContent =
        "Setup saved · RR 1:" + rr.toFixed(2) +
        " · Planned risk " + zar(cash.riskCash) +
        " (" + cash.riskPercent.toFixed(1) + "% of " +
        zar(cash.capital) + ")" +
        " · Potential reward " + zar(cash.potentialReward) +
        " before costs · " + alignment +
        ". Manual idea only — not a generated trading signal.";
    }

    renderSignals();
    form.reset();
    toast("Setup saved.");
  });

  renderSignals();
}

/* TRADE JOURNAL */

function setupJournal() {
  const form = $("tradeForm");

  if (form) {
    form.addEventListener("submit", event => {
      event.preventDefault();

      const entry = Number($("tradeEntry").value);
      const exit = Number($("tradeExit").value);
      const pl = Number($("tradePL").value);

      if (
        !Number.isFinite(entry) ||
        !Number.isFinite(exit) ||
        !Number.isFinite(pl)
      ) {
        toast("Enter valid trade numbers.");
        return;
      }

      state.trades.unshift({
        symbol: $("tradeSymbol").value,
        side: $("tradeSide").value,
        entry,
        exit,
        pl,
        date: $("tradeDate").value,
        notes: $("tradeNotes").value
      });

      save();
      renderJournal();
      form.reset();
      toast("Trade saved on this device.");
    });
  }

  $("csvBtn")?.addEventListener("click", () => {
    const rows = [
      ["symbol", "side", "entry", "exit", "net_pl_zar", "date", "notes"],
      ...state.trades.map(trade => [
        trade.symbol, trade.side, trade.entry, trade.exit,
        trade.pl, trade.date, trade.notes
      ])
    ];

    const csv = rows.map(row =>
      row.map(value =>
        '"' + String(value ?? "").replace(/"/g, '""') + '"'
      ).join(",")
    ).join("\n");

    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([csv], { type: "text/csv" })
    );
    link.download = "space-trader-journal.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  renderJournal();
}

function renderJournal() {
  const list = $("tradeList");

  if (list) {
    list.innerHTML = state.trades.length
      ? state.trades.slice(0, 30).map(trade => `
          <article class="list-card">
            <strong>
              ${esc(trade.symbol)} ${esc(trade.side)} · ${zar(trade.pl)}
            </strong>
            <p>
              ${esc(trade.date)}
              · Entry ${price(trade.entry)}
              · Exit ${price(trade.exit)}
            </p>
            <p>${esc(trade.notes || "")}</p>
          </article>
        `).join("")
      : '<div class="empty-state">No trades recorded yet.</div>';
  }

  const wins = state.trades.filter(trade => Number(trade.pl) > 0);
  const losses = state.trades.filter(trade => Number(trade.pl) < 0);

  const net = state.trades.reduce(
    (sum, trade) => sum + Number(trade.pl || 0), 0
  );

  const grossWins = wins.reduce(
    (sum, trade) => sum + Number(trade.pl), 0
  );

  const grossLosses = -losses.reduce(
    (sum, trade) => sum + Number(trade.pl), 0
  );

  if ($("jCount")) $("jCount").textContent = state.trades.length;
  if ($("jNet")) $("jNet").textContent = zar(net);

  if ($("jWin")) {
    $("jWin").textContent = state.trades.length
      ? (wins.length / state.trades.length * 100).toFixed(1) + "%"
      : "0%";
  }

  if ($("jPF")) {
    $("jPF").textContent = grossLosses
      ? (grossWins / grossLosses).toFixed(2)
      : "—";
  }
}

/* SETTINGS AND BACKUP */

function createBackup() {
  const backup = {
    trades: state.trades,
    signals: state.signals,
    settings: state.settings,
    manualQuotes: state.manualQuotes
  };

  const blob = new Blob(
    [JSON.stringify(backup, null, 2)],
    { type: "application/json" }
  );

  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);

  link.href = url;
  link.download = "space-trader-backup.json";
  link.click();

  URL.revokeObjectURL(url);
}

function setupSettings() {
  $("saveSettings")?.addEventListener("click", () => {
    state.settings = {
      accountType: $("accountType").value,
      serverName: $("serverName").value,
      symbolMap: $("symbolMap").value
    };

    save();
    toast("Settings saved on this device.");
  });

  $("backupBtn")?.addEventListener("click", createBackup);

  $("clearData")?.addEventListener("click", () => {
    $("confirmDialog")?.showModal();
  });

  $("confirmClear")?.addEventListener("click", () => {
    localStorage.removeItem(STORE);

    state.trades = [];
    state.signals = [];
    state.settings = {};
    state.manualQuotes = {};

    renderJournal();
    renderSignals();
    renderMarkets();

    toast("Local app data cleared.");
  });
}

/* MANUAL QUOTE RECORD */

function setupManualQuote() {
  $("editQuoteBtn")?.addEventListener("click", () => {
    const selected = $("quoteSymbol")?.value || "XAUUSD";
    $("qSymbol").value = selected;

    const now = new Date();
    $("qTime").value = new Date(
      now.getTime() - now.getTimezoneOffset() * 60000
    ).toISOString().slice(0, 16);

    $("quoteDialog")?.showModal();
  });

  $("quoteForm")?.addEventListener("submit", event => {
    event.preventDefault();

    const symbol = $("qSymbol").value;
    const value = Number($("qPrice").value);

    if (!Number.isFinite(value) || value <= 0) {
      toast("Enter a valid quote price.");
      return;
    }

    state.manualQuotes[symbol] = {
      price: value,
      source: $("qSource").value,
      status: $("qStatus").value,
      time: $("qTime").value
    };

    save();
    renderMarkets();

    $("quoteDialog")?.close();
    toast("Manual quote record saved.");
  });
}

/* APP START */

function boot() {
  loadSaved();

  setupNavigation();
  setupRisk();
  setupJournal();
  setupSignals();
  setupSettings();
  setupManualQuote();

  if ($("todayLabel")) {
    $("todayLabel").textContent =
      new Date().toLocaleDateString("en-ZA", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric"
      }).toUpperCase();
  }

  $("feedReconnect")?.addEventListener("click", scan);
  $("settingsReconnect")?.addEventListener("click", scan);

  renderJournal();
  renderSignals();
  renderMarkets();

  scan();

  // Refresh hourly while the app is open.
  setInterval(() => {
    if (!document.hidden) scan();
  }, 60 * 60 * 1000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scan();
  });
}

document.addEventListener("DOMContentLoaded", boot);

