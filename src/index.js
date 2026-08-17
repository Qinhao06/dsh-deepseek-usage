/**
 * dsh-deepseek-usage — host half.
 *
 * Registers three loopback-only HTTP routes on the dsh web server and
 * maintains a per-day log-based cost accumulator:
 *
 *   GET /api/dsh-deepseek-usage/balance
 *       Upstream `GET https://api.deepseek.com/user/balance` (official public
 *       API), API key resolved through ctx.credentials (or the environment),
 *       cached 60s. Answers the "how much money is left" question.
 *
 *   GET /api/dsh-deepseek-usage/today
 *       Today's consumption, two sources in order:
 *         1. platform  — the official dashboard data the web console shows,
 *            via `platform.deepseek.com/api/v0/usage/cost?month=&year=`,
 *            authenticated with the optional DEEPSEEK_PLATFORM_TOKEN
 *            credential (a platform session token; see README for how to get
 *            one). Reported as source "platform".
 *         2. log       — local pricing of every `assistant/message` usage
 *            sample that flowed through live sessions today, at the official
 *            policy table (incl. peak/off-peak). Reported as source "log".
 *
 *   GET /api/dsh-deepseek-usage/session-cost?sessionId=<id>
 *       Exact cost of one conversation: replays the session's persisted log
 *       (live in-memory state or cold storage) and prices every
 *       `assistant/message` that carried provider usage, including history
 *       from before this plugin was installed.
 *
 * The plugin intentionally imports no @deepseek-ai packages: it only needs
 * node builtins plus the local pricing engine, so it resolves from any
 * location (workspace checkout, profile node_modules, or a symlink farm).
 * `credentialRef` is a runtime no-op string brand, so plain ref strings can
 * be passed to ctx.credentials.resolve directly.
 *
 * Mount (hot, no restart): add to ~/.dsh/profiles/web/cordis.patch.yml
 *   - insert:
 *       - id: deepseek-usage
 *         name: dsh-deepseek-usage
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { costOf, priceAt } from "./pricing.js";

export const name = "dsh-deepseek-usage";
/** Services required before the routes and accumulator can mount. */
export const inject = ["webServer", "credentials", "sessions", "sessionPersistence"];

/** Route paths (exact; they win over the connection plugin's /api prefix). */
export const BALANCE_ROUTE = "/api/dsh-deepseek-usage/balance";
export const TODAY_ROUTE = "/api/dsh-deepseek-usage/today";
export const SESSION_ROUTE = "/api/dsh-deepseek-usage/session-cost";

/** Balance cache TTL and upstream timeouts. */
const BALANCE_CACHE_MS = 60e3;
const UPSTREAM_TIMEOUT_MS = 15e3;

/** Day-state file lives under $DSH_HOME/storages (via the dshHomePath service). */
const DAY_STATE_FILE = "dsh-deepseek-usage-day.json";

// ---- helpers ---------------------------------------------------------------

/** Resolve a credential through the credentials service, then the environment. */
async function resolveSecret(ctx, ref, envName) {
  try {
    const credentials = ctx.get("credentials");
    if (credentials && typeof credentials.resolve === "function") {
      const hit = await credentials.resolve(ref);
      if (hit && typeof hit.value === "string" && hit.value !== "") return hit.value;
    }
  } catch {
    /* service absent or failing — fall through to the environment */
  }
  return process.env[envName] || void 0;
}

/** Loopback-only fence: these are money figures, keep them on the machine. */
function isLoopbackRequest(req) {
  const address = req.socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  return true;
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer"
  });
  res.end(payload);
}

/** Local date string in the account timezone (Asia/Shanghai), YYYY-MM-DD. */
function localDate(timeMs = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(timeMs));
}

/** Read a usage sample into normalized billing buckets (defensive shapes). */
function bucketsOf(usage) {
  return {
    uncachedInputTokens: usage?.uncachedInputTokens ?? usage?.inputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0
  };
}

/** Extract the model that produced an assistant message, with fallbacks. */
function modelOf(event) {
  return event?.data?.message?.source?.model
    ?? event?.data?.message?.model
    ?? event?.data?.model
    ?? void 0;
}

/** Cost in CNY of one assistant/message sample (rounded to 4 decimals). */
function cnyCostOf(event) {
  const usage = event?.data?.usage;
  if (usage === void 0) return void 0;
  const price = priceAt(modelOf(event), event.time ?? Date.now());
  return Math.round(costOf(bucketsOf(usage), price.cny) * 1e4) / 1e4;
}

/** Absolute path of the day-state file. */
function dayStatePath(ctx) {
  let storages;
  const homeFn = typeof ctx.get === "function" ? ctx.get("dshHomePath") : void 0;
  if (typeof homeFn === "function") storages = homeFn("storages");
  else if (process.env.DSH_HOME) storages = join(process.env.DSH_HOME, "storages");
  else storages = join(homedir(), ".dsh", "storages");
  return join(storages, DAY_STATE_FILE);
}

/** Atomic JSON write (temp file + rename), failures are logged, never fatal. */
function persistJson(path, value) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  } catch {
    /* best-effort persistence */
  }
}

// ---- day accumulator (log fallback) ----------------------------------------

const zeroTokens = () => ({ input: 0, cacheRead: 0, output: 0 });

function createDayAccumulator(ctx) {
  const state = {
    date: "",
    cost: 0,
    tokens: zeroTokens(),
    byModel: {}
  };
  const file = dayStatePath(ctx);

  /** Restore today's bucket from the persisted state file, if any. */
  function seed() {
    const today = localDate();
    try {
      if (existsSync(file)) {
        const stored = JSON.parse(readFileSync(file, "utf8"));
        if (stored && stored.date === today) {
          state.date = today;
          state.cost = Number(stored.cost) || 0;
          state.tokens = { ...zeroTokens(), ...(stored.tokens ?? {}) };
          state.byModel = stored.byModel && typeof stored.byModel === "object" ? stored.byModel : {};
        }
      }
    } catch {
      /* corrupt or unreadable state — start fresh */
    }
    if (state.date !== today) {
      state.date = today;
      state.cost = 0;
      state.tokens = zeroTokens();
      state.byModel = {};
    }
  }

  /** Add one priced sample to today's bucket and persist. */
  function add(event) {
    const today = localDate(event.time ?? Date.now());
    if (state.date !== today) {
      state.date = today;
      state.cost = 0;
      state.tokens = zeroTokens();
      state.byModel = {};
    }
    const usage = event.data.usage;
    const buckets = bucketsOf(usage);
    const cost = cnyCostOf(event);
    state.tokens.input += buckets.uncachedInputTokens;
    state.tokens.cacheRead += buckets.cacheReadTokens;
    state.tokens.output += buckets.outputTokens;
    if (cost !== void 0) state.cost += cost;
    const model = modelOf(event) ?? "unknown";
    const row = state.byModel[model] ?? { cost: 0, tokens: zeroTokens() };
    row.tokens.input += buckets.uncachedInputTokens;
    row.tokens.cacheRead += buckets.cacheReadTokens;
    row.tokens.output += buckets.outputTokens;
    if (cost !== void 0) row.cost += cost;
    state.byModel[model] = row;
    state.cost = Math.round(state.cost * 1e4) / 1e4;
    persistJson(file, state);
  }

  /** Immutable snapshot of today's bucket for the route. */
  function snapshot() {
    return {
      date: state.date,
      cost: Math.round(state.cost * 1e4) / 1e4,
      tokens: { ...state.tokens },
      byModel: Object.fromEntries(
        Object.entries(state.byModel).map(([model, row]) => [
          model,
          { cost: row.cost, tokens: { ...row.tokens } }
        ])
      )
    };
  }

  return { seed, add, snapshot };
}

// ---- balance ---------------------------------------------------------------

let balanceCache; // { atMs, payload }

async function handleBalance(ctx, req, res) {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: "forbidden" });
    return;
  }
  const now = Date.now();
  if (balanceCache !== void 0 && now - balanceCache.atMs < BALANCE_CACHE_MS) {
    writeJson(res, 200, { ok: true, cached: true, ...balanceCache.payload });
    return;
  }
  const key = await resolveSecret(ctx, "DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY");
  if (key === void 0) {
    writeJson(res, 200, { ok: false, error: "no-key" });
    return;
  }
  try {
    const upstream = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    if (!upstream.ok) {
      writeJson(res, 200, { ok: false, error: "upstream", status: upstream.status });
      return;
    }
    const payload = await upstream.json();
    balanceCache = { payload, atMs: now };
    writeJson(res, 200, { ok: true, cached: false, ...payload });
  } catch (error) {
    writeJson(res, 200, { ok: false, error: "network", detail: String(error) });
  }
}

// ---- today's consumption ---------------------------------------------------

/** Numeric coercion that tolerates strings, returns NaN for junk. */
function toFinite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * Fetch today's official cost from the platform dashboard API using the
 * platform session token. Response envelope:
 *   { code: 0, data: { biz_code: 0, biz_data: { days: [
 *       { date: "YYYY-MM-DD", data: [ { usage: [ { cost|amount, ... } ] } ] }
 *   ] } } }
 * Parsing is defensive against renamed fields; returns null when the shape
 * differs or today's row is absent (the caller falls back to log pricing).
 * @throws on transport errors, non-zero envelope codes, and HTTP failures.
 */
async function fetchPlatformTodayCost(token) {
  const now = new Date();
  const url = `https://platform.deepseek.com/api/v0/usage/cost?month=${now.getMonth() + 1}&year=${now.getFullYear()}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "x-app-version": "1.0.0",
      Origin: "https://platform.deepseek.com",
      Referer: "https://platform.deepseek.com/usage"
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`DeepSeek platform usage endpoint returned HTTP ${response.status}`);
  const body = await response.json();
  const biz = body && typeof body === "object" ? body.data : void 0;
  if (body?.code !== 0 || biz === void 0 || biz.biz_code !== 0) {
    const code = body?.code ?? biz?.biz_code;
    if (code === 40002 || code === 40003) {
      throw new Error("DEEPSEEK_PLATFORM_TOKEN expired: log in to platform.deepseek.com and refresh the userToken");
    }
    throw new Error(`DeepSeek platform usage endpoint error (code ${code ?? "unknown"})`);
  }
  const bizData = biz.biz_data;
  const container = Array.isArray(bizData) ? bizData[0] : bizData;
  const days = container && typeof container === "object" ? container.days : void 0;
  if (!Array.isArray(days)) return null;
  const today = localDate();
  const entry = days.find((d) => d && d.date === today);
  if (!entry || !Array.isArray(entry.data)) return null;
  let total = 0;
  for (const modelEntry of entry.data) {
    if (!modelEntry || typeof modelEntry !== "object" || !Array.isArray(modelEntry.usage)) continue;
    for (const u of modelEntry.usage) {
      if (!u || typeof u !== "object") continue;
      const value = toFinite(u.cost ?? u.amount);
      if (Number.isFinite(value)) total += value;
    }
  }
  return Math.round(total * 100) / 100;
}

async function handleToday(ctx, day, req, res) {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: "forbidden" });
    return;
  }
  // 1. Preferred: official platform figures via the session token.
  const platformToken = await resolveSecret(ctx, "DEEPSEEK_PLATFORM_TOKEN", "DEEPSEEK_PLATFORM_TOKEN");
  if (platformToken !== void 0) {
    try {
      const cost = await fetchPlatformTodayCost(platformToken);
      if (cost !== null) {
        writeJson(res, 200, {
          ok: true,
          source: "platform",
          date: localDate(),
          cost,
          currency: "CNY",
          note: "official platform dashboard figures"
        });
        return;
      }
    } catch {
      /* token invalid / network — fall through to log pricing */
    }
  }
  // 2. Fallback: local log pricing accumulator.
  const snapshot = day.snapshot();
  writeJson(res, 200, {
    ok: true,
    source: "log",
    date: snapshot.date,
    cost: snapshot.cost,
    currency: "CNY",
    tokens: snapshot.tokens,
    byModel: snapshot.byModel,
    note: platformToken === void 0
      ? "estimated from local session logs (set DEEPSEEK_PLATFORM_TOKEN for official figures)"
      : "platform source unavailable; estimated from local session logs"
  });
}

// ---- session cost ----------------------------------------------------------

/**
 * Price one conversation: collect its events (live memory or cold storage),
 * price every `assistant/message` that carried provider usage, and build a
 * per-bucket formula breakdown (label / tokens / effective rate / subtotal).
 */
async function computeSessionCost(ctx, sessionId) {
  let events = null;
  const live = ctx.get("sessions")?.get(sessionId);
  if (live !== void 0) {
    events = live.events ?? [];
  } else {
    const persistence = ctx.get("sessionPersistence");
    if (persistence !== void 0 && typeof persistence.inspect === "function") {
      try {
        const inspected = await persistence.inspect(sessionId);
        events = inspected?.events ?? null;
      } catch {
        events = null;
      }
    }
  }
  if (events === null) return { refused: "session-not-found" };

  const total = { input: 0, cacheRead: 0, output: 0 };
  const perModel = new Map();
  let cost = 0;
  for (const event of events) {
    if (event?.type !== "assistant/message") continue;
    const usage = event.data?.usage;
    if (usage === void 0) continue;
    const buckets = bucketsOf(usage);
    const model = modelOf(event) ?? "unknown";
    const price = priceAt(model, event.time ?? Date.now());
    const sampleCost = costOf(buckets, price.cny);
    total.input += buckets.uncachedInputTokens;
    total.cacheRead += buckets.cacheReadTokens;
    total.output += buckets.outputTokens;
    cost += sampleCost;
    const row = perModel.get(model) ?? { cost: 0, input: 0, cacheRead: 0, output: 0 };
    row.cost += sampleCost;
    row.input += buckets.uncachedInputTokens;
    row.cacheRead += buckets.cacheReadTokens;
    row.output += buckets.outputTokens;
    perModel.set(model, row);
  }
  cost = Math.round(cost * 1e4) / 1e4;
  const breakdown = [
    { label: "输入", tokens: total.input, rate: 0, subtotal: 0 },
    { label: "缓存命中", tokens: total.cacheRead, rate: 0, subtotal: 0 },
    { label: "输出", tokens: total.output, rate: 0, subtotal: 0 }
  ];
  // Effective blended rates per bucket across the whole conversation:
  // per-model costs are broken down by bucket weight so the displayed
  // formula (tokens × rate = subtotal) holds for each bucket.
  const bucketCosts = { input: 0, cacheRead: 0, output: 0 };
  for (const [model, row] of perModel) {
    const price = priceAt(model, Date.now());
    bucketCosts.input += row.input / 1e6 * price.cny.input;
    bucketCosts.cacheRead += row.cacheRead / 1e6 * price.cny.cacheRead;
    bucketCosts.output += row.output / 1e6 * price.cny.output;
  }
  const names = ["input", "cacheRead", "output"];
  for (let index = 0; index < breakdown.length; index++) {
    const key = names[index];
    const tokens = breakdown[index].tokens;
    breakdown[index].subtotal = Math.round(bucketCosts[key] * 1e4) / 1e4;
    breakdown[index].rate = tokens > 0
      ? Math.round((bucketCosts[key] / tokens) * 1e6 * 1e3) / 1e3
      : 0;
  }
  return {
    value: {
      ok: true,
      sessionId,
      cost,
      currency: "CNY",
      tokens: { ...total },
      byModel: Object.fromEntries(
        [...perModel].map(([model, row]) => [
          model,
          { cost: Math.round(row.cost * 1e4) / 1e4, tokens: { input: row.input, cacheRead: row.cacheRead, output: row.output } }
        ])
      ),
      breakdown
    }
  };
}

async function handleSessionCost(ctx, req, res, url) {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, { ok: false, error: "forbidden" });
    return;
  }
  const sessionId = url.searchParams.get("sessionId");
  if (sessionId === null || sessionId === "") {
    writeJson(res, 400, { ok: false, error: "missing-session-id" });
    return;
  }
  const result = await computeSessionCost(ctx, sessionId);
  if ("refused" in result) {
    writeJson(res, 200, { ok: false, error: result.refused });
    return;
  }
  writeJson(res, 200, result.value);
}

// ---- plugin body -----------------------------------------------------------

/** Replay today's usage from sessions already alive in memory (cheap, no IO). */
function replayLiveSessions(ctx, day) {
  const sessions = ctx.get("sessions");
  if (sessions === void 0 || typeof sessions.list !== "function") return;
  const today = localDate();
  try {
    for (const session of sessions.list()) {
      const events = session.events ?? [];
      for (const event of events) {
        if (event?.type !== "assistant/message") continue;
        if (event.data?.usage === void 0) continue;
        if (localDate(event.time ?? 0) !== today) continue;
        day.add(event);
      }
    }
  } catch {
    /* best-effort replay */
  }
}

function apply(ctx) {
  const day = createDayAccumulator(ctx);
  day.seed();
  replayLiveSessions(ctx, day);

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: BALANCE_ROUTE,
    handler: (req, res) => handleBalance(ctx, req, res)
  }), "dsh-deepseek-usage: balance route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: TODAY_ROUTE,
    handler: (req, res) => handleToday(ctx, day, req, res)
  }), "dsh-deepseek-usage: today route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: SESSION_ROUTE,
    handler: (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      void handleSessionCost(ctx, req, res, url);
    }
  }), "dsh-deepseek-usage: session-cost route");

  // Price every assistant/message that reports provider usage, per day.
  ctx.on("session/event", (session, event) => {
    if (event?.type !== "assistant/message") return;
    if (event.data?.usage === void 0) return;
    day.add(event);
  });
}

export { apply };
