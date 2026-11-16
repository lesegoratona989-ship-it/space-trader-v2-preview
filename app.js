
/* SPACE TRADER V2.0
   Public reference feed: biquote.io
   No API key. No broker login. No order execution.
   Public quotes are NOT Space Markets execution prices.
*/
"use strict";

const API = "https://biquote.io/api";
const SYMBOLS = ["XAUUSD", "NAS100", "US30", "GER30"];
const FRAMES = [
  { name: "H4", interval: "4h" },
  { name: "H1", interval: "1h" },
  { name: "M30", interval: "30m" },
  { name: "M15", interval: "15m" }
];
const STORE = "spaceTraderV2";
const state = {
  quotes: {},
  candles: {},
  symbols: {},
  trades: [],
  signals: [],
  settings: {}
};

const $ = id => document.getElementById(id);
const zar = n => "R" + Number(n || 0).toFixed(2);
const price = n => Number(n).toLocaleString("en-ZA", {
  maximumFractionDigits: 5
});
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&":"&amp;", "<":"&lt;", ">":"&gt;",
  '"':"&quot;", "'":"&#39;"
}[c]));

function toast(message) {
  const el = $("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2500);
}

function loadSaved() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "{}");
    state.trades = saved.trades || [];
    state.signals = saved.signals || [];
    state.settings = saved.settings || {};
  } catch (_) {}
}

function save() {
  localStorage.setItem(STORE, JSON.stringify({
    trades: state.trades,
    signals: state.signals,
    settings: state.settings
  }));
}

async function getJSON(url) {
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error("Market data request failed: HTTP " + response.status);
  }

  return response.json();
}
async function discoverSymbols() {
  state.symbols.XAUUSD = "XAUUSD";
  state.symbols.NAS100 = "USTEC";
  state.symbols.US30 = "US30";
  state.symbols.GER30 = "DE30";
}

function quality(q) {
  if (!q) return ["DATA UNAVAILABLE", "red"];
  if (q.marketState === "closed") return ["PREVIOUS CLOSE", "amber"];
  if (q.stale === true) return ["STALE — NO TRADE", "red"];

  const age = Number(q.quoteAgeSeconds);
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
    .filter(b =>
      b &&
      b.isOpen !== true &&
      [b.open, b.high, b.low, b.close].every(
        v => Number.isFinite(Number(v))
      )
    )
    .map(b => ({
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
      time: Date.parse(b.openTime)
    }))
    .filter(b => Number.isFinite(b.time))
    .sort((a, b) => a.time - b.time);
}

function analyse(bars) {
  if (!bars || bars.length < 30) {
    return { bias: "UNAVAILABLE", event: "INSUFFICIENT CANDLES" };
  }

  const highs = [];
  const lows = [];

  for (let i = 2; i < bars.length - 2; i++) {
    const b = bars[i];

    if (
      b.high > bars[i-1].high &&
      b.high > bars[i-2].high &&
      b.high >= bars[i+1].high &&
      b.high >= bars[i+2].high
    ) highs.push({ i, value: b.high });

    if (
      b.low < bars[i-1].low &&
      b.low < bars[i-2].low &&
      b.low <= bars[i+1].low &&
      b.low <= bars[i+2].low
    ) lows.push({ i, value: b.low });
  }

  if (highs.length < 2 || lows.length < 2) {
    return { bias: "UNAVAILABLE", event: "SWING DATA INSUFFICIENT" };
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
  const oldHigh = highs.filter(x => x.i < bars.length - 1).at(-1);
  const oldLow = lows.filter(x => x.i < bars.length - 1).at(-1);

  let event = "NO CONFIRMED BREAK";

  if (oldHigh && last.close > oldHigh.value &&
      previous.close <= oldHigh.value) {
    event = "BULLISH BOS";
  } else if (oldLow && last.close < oldLow.value &&
             previous.close >= oldLow.value) {
    event = "BEARISH BOS";
  }

  return { bias, event };
}

function renderMarkets() {
  const cards = $("marketCards");
  const rows = $("watchRows");

  const html = SYMBOLS.map(symbol => {
    const q = state.quotes[symbol];
    const supported = !!state.symbols[symbol];
    const status = quality(q);
    const mid = q ? Number(q.mid) : NaN;

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
        <div class="quote-status">
          ${supported
            ? status[0]
            : "Exact symbol not found. No proxy substituted."}
        </div>
        <div class="feed-meta">
          Source: ${q ? esc(q.source || "biquote") : "Unavailable"}<br>
          ${q ? "Timestamp: " + esc(q.timestamp || "Unknown") : ""}
          ${q ? "<br>Quote age: " +
            esc(q.quoteAgeSeconds) + " seconds" : ""}
        </div>
      </article>`;
  }).join("");

  if (cards) cards.innerHTML = html;
  if (rows) rows.innerHTML = html;
}

function renderAnalysis() {
  const host = $("signalList");
  if (!host) return;

  const analysis = SYMBOLS.map(symbol => {
    const quote = state.quotes[symbol];
    const status = quality(quote);
    const frames = state.candles[symbol] || {};
    const results = FRAMES.map(f => ({
      name: f.name,
      result: frames[f.name] ? analyse(frames[f.name]) : null
    }));

    const missing = results.filter(
      x => !x.result || x.result.bias === "UNAVAILABLE"
    );

    const biases = results
      .filter(x => x.result && x.result.bias !== "UNAVAILABLE")
      .map(x => x.result.bias);

    const aligned =
      biases.length === 4 &&
      biases.every(x => x === biases[0] && x !== "RANGE");

    const hasBreak = results.some(x =>
      x.result &&
      ["BULLISH BOS", "BEARISH BOS"].includes(x.result.event)
    );

    const canReview =
      quote &&
      status[1] !== "red" &&
      status[0] !== "PREVIOUS CLOSE" &&
      missing.length === 0 &&
      aligned &&
      hasBreak;

    return `
      <article class="list-card">
        <strong>${symbol} — ${canReview
          ? "STRUCTURE WATCH — REVIEW ONLY"
          : "NO TRADE"}</strong>
        <p>Quote: ${quote ? price(quote.mid) : "Unavailable"}</p>
        <p>Quote quality: ${status[0]}</p>
        <p>${results.map(x =>
          x.name + ": " +
          (x.result
            ? x.result.bias + " / " + x.result.event
            : "DATA UNAVAILABLE")
        ).join("<br>")}</p>
        <p>${canReview
          ? "All four timeframe structures align and a break was detected. Manual review required."
          : "Evidence is incomplete, stale, unaligned or lacks a confirmed break. Stand aside."}</p>
      </article>`;
  });

  host.innerHTML = analysis.join("");
}

async function scan() {
  const badge = $("feedBadge");
  if (badge) {
    badge.textContent = "SCANNING";
    badge.className = "tag amber";
  }

  try {
    await discoverSymbols();

    for (const symbol of SYMBOLS) {
      const exact = state.symbols[symbol];
      if (!exact) continue;

      try {
        state.quotes[symbol] = await getQuote(exact);
      } catch (_) {
        state.quotes[symbol] = null;
      }

      state.candles[symbol] = {};

      const results = await Promise.allSettled(
        FRAMES.map(f => getCandles(exact, f))
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
    if ($("feedTitle")) $("feedTitle").textContent = "Public reference feed";
    if ($("feedMessage")) {
      $("feedMessage").textContent =
        "biquote reference data. Not your Space Markets execution feed.";
    }
    if ($("feedMeta")) $("feedMeta").textContent = "Last scan: " + now;
    if ($("settingsFeedMeta")) $("settingsFeedMeta").textContent = "Last scan: " + now;
    if ($("settingsFeedBadge")) $("settingsFeedBadge").textContent = "PUBLIC DATA";
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
    toast("Market data unavailable. No trade.");
  }
}

function setupNavigation() {
  document.querySelectorAll("[data-page]").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".page").forEach(p =>
        p.classList.remove("active")
      );
      document.querySelectorAll(".nav-item").forEach(n =>
        n.classList.remove("active")
      );

      const page = $("page-" + button.dataset.page);
      if (page) page.classList.add("active");
      button.classList.add("active");
    });
  });

  document.querySelectorAll("[data-go]").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelector(
        '[data-page="' + button.dataset.go + '"]'
      )?.click();
    });
  });
}

function setupRisk() {
  const update = () => {
    const capital = Number($("capitalInput")?.value) || 500;
    const percent = Number($("riskPct")?.value) || 1;
    const risk = capital * percent / 100;

    if ($("capitalDisplay")) $("capitalDisplay").textContent = zar(capital);
    if ($("riskCash")) $("riskCash").textContent = zar(risk);
    if ($("riskSummary")) $("riskSummary").textContent = zar(risk);
    if ($("riskPctLabel")) $("riskPctLabel").textContent = percent.toFixed(1) + "%";
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
      const raw = risk / (stop * pointValue + costs);
      const lot = Math.floor(raw / step) * step;
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
          "Enter verified broker point value and costs.";
      }
    }

    const daily = capital *
      (Number($("dailyPct")?.value) || 2) / 100;

    if ($("dailyRiskText")) {
      $("dailyRiskText").textContent = "Daily loss limit: " + zar(daily);
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

function setupJournal() {
  const form = $("tradeForm");

  if (form) form.addEventListener("submit", event => {
    event.preventDefault();

    state.trades.unshift({
      symbol: $("tradeSymbol").value,
      side: $("tradeSide").value,
      entry: Number($("tradeEntry").value),
      exit: Number($("tradeExit").value),
      pl: Number($("tradePL").value),
      date: $("tradeDate").value,
      notes: $("tradeNotes").value
    });

    save();
    renderJournal();
    form.reset();
    toast("Trade saved on this device.");
  });

  $("csvBtn")?.addEventListener("click", () => {
    const rows = [
      ["symbol", "side", "entry", "exit", "net_pl_zar", "date", "notes"],
      ...state.trades.map(t => [
        t.symbol, t.side, t.entry, t.exit, t.pl, t.date, t.notes
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
      ? state.trades.slice(0, 30).map(t => `
        <article class="list-card">
          <strong>${esc(t.symbol)} ${esc(t.side)} · ${zar(t.pl)}</strong>
          <p>${esc(t.date)} · Entry ${price(t.entry)} · Exit ${price(t.exit)}</p>
          <p>${esc(t.notes || "")}</p>
        </article>`).join("")
      : '<div class="empty-state">No trades recorded yet.</div>';
  }

  const wins = state.trades.filter(t => t.pl > 0);
  const losses = state.trades.filter(t => t.pl < 0);
  const net = state.trades.reduce((sum, t) => sum + Number(t.pl || 0), 0);
  const grossWins = wins.reduce((sum, t) => sum + t.pl, 0);
  const grossLosses = -losses.reduce((sum, t) => sum + t.pl, 0);

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

function setupSignals() {
  const form = $("signalForm");
  if (!form) return;

  form.addEventListener("submit", event => {
    event.preventDefault();

    const entry = Number($("sigEntry").value);
    const sl = Number($("sigSL").value);
    const tp = Number($("sigTP1").value);
    const side = $("sigSide").value;

    const valid = side === "BUY"
      ? sl < entry && tp > entry
      : sl > entry && tp < entry;

    if (!valid) {
      toast("Check entry, stop loss and target direction.");
      return;
    }

    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    const record = {
      symbol: $("sigSymbol").value,
      side,
      entry,
      sl,
      tp,
      timeframe: $("sigTF").value,
      reason: $("sigReason").value,
      rr: reward / risk,
      date: new Date().toISOString()
    };

    state.signals.unshift(record);
    save();

    if ($("signalResult")) {
      $("signalResult").classList.remove("hidden");
      $("signalResult").textContent =
        "Setup saved · Risk/reward: 1:" + record.rr.toFixed(2) +
        ". Manual idea only — not a generated trading signal.";
    }

    renderSignals();
    form.reset();
    toast("Setup saved.");
  });

  renderSignals();
}

function renderSignals() {
  const list = $("signalList");
  if (!list) return;

  const saved = state.signals;
  const manual = saved.map(s => `
    <article class="list-card">
      <strong>${esc(s.symbol)} ${esc(s.side)} · 1:${Number(s.rr).toFixed(2)}</strong>
      <p>Entry ${price(s.entry)} · SL ${price(s.sl)} · TP1 ${price(s.tp)}</p>
      <p>${esc(s.timeframe)} · ${esc(s.reason || "No notes")}</p>
      <small>Manual setup — not a verified feed signal.</small>
    </article>`);

  const analysis = SYMBOLS.map(symbol => {
    const q = state.quotes[symbol];
    const status = quality(q);
    const frames = state.candles[symbol] || {};
    const result = FRAMES.map(f => {
      const a = frames[f.name] ? analyse(frames[f.name]) : null;
      return f.name + ": " + (a ? a.bias + " / " + a.event : "UNAVAILABLE");
    });

    return `
      <article class="list-card">
        <strong>${symbol} — MARKET SCAN</strong>
        <p>${q ? price(q.mid) : "No quote"} · ${status[0]}</p>
        <p>${result.join("<br>")}</p>
        <small>Analysis is informational. Verify manually before any trade.</small>
      </article>`;
  });

  list.innerHTML = [...analysis, ...manual].join("");
  if ($("signalCount")) {
    $("signalCount").textContent = saved.length + " saved setups";
  }
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

  $("backupBtn")?.addEventListener("click", () => {
    const blob = new Blob([
      JSON.stringify({
        trades: state.trades,
        signals: state.signals,
        settings: state.settings
      }, null, 2)
    ], { type: "application/json" });

    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "space-trader-backup.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  $("clearData")?.addEventListener("click", () =>
    $("confirmDialog")?.showModal()
  );

  $("confirmClear")?.addEventListener("click", () => {
    localStorage.removeItem(STORE);
    state.trades = [];
    state.signals = [];
    state.settings = {};
    renderJournal();
    renderSignals();
    toast("Local app data cleared.");
  });
}

function setupManualQuote() {
  $("editQuoteBtn")?.addEventListener("click", () => {
    const now = new Date();
    $("qTime").value = new Date(
      now.getTime() - now.getTimezoneOffset() * 60000
    ).toISOString().slice(0, 16);
    $("quoteDialog")?.showModal();
  });

  $("quoteForm")?.addEventListener("submit", event => {
    event.preventDefault();
    toast("Manual quote is not used by the public scanner.");
    $("quoteDialog")?.close();
  });
}

function boot() {
  loadSaved();
  setupNavigation();
  setupRisk();
  setupJournal();
  setupSignals();
  setupSettings();
  setupManualQuote();

  $("feedReconnect")?.addEventListener("click", scan);
  $("settingsReconnect")?.addEventListener("click", scan);

  scan();

  // Refresh hourly only while the app is open.
  setInterval(() => {
    if (!document.hidden) scan();
  }, 60 * 60 * 1000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scan();
  });
}

document.addEventListener("DOMContentLoaded", boot);
