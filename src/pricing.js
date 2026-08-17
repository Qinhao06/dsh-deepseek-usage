/**
 * dsh-deepseek-usage — pricing engine.
 *
 * Pure-function pricing module: resolves the official DeepSeek policy
 * timeline + peak/off-peak windows to the unit prices one message should be
 * billed at for a given moment. Dual currency (CNY / USD), matching the
 * official announcements. Unit prices are per 1M tokens; USD prices are
 * published independently by DeepSeek, not a currency conversion.
 *
 * Ported from bpc-oss/dsh-web-billing (MIT):
 * https://github.com/bpc-oss/dsh-web-billing — official policy timeline and
 * peak/off-peak semantics kept; user override tables dropped (this widget
 * only needs the official figures).
 *
 * Bucket semantics (consistent with the harness adapters):
 *   input      cache-miss input tokens
 *   cacheRead  cache-hit input tokens
 *   output     output tokens
 *   cacheWrite is NOT billed directly (its input is already inside input).
 */

/** Peak-window hours in the account timezone, [start, end) half-open. */
export const PEAK_WINDOWS = [
  [9, 12],
  [14, 18]
];

/** Zero unit price. */
const ZERO_UNIT = Object.freeze({ input: 0, cacheRead: 0, output: 0 });

/**
 * Official policy timeline (curated from DeepSeek announcements; `since` is
 * the effective instant with timezone offset). Each entry is either a flat
 * `prices` table or a peak/offPeak pair. Newer policies win for messages at
 * or after their `since`; models dropped from a newer policy keep the older
 * named price so historical bills match the platform.
 */
export const OFFICIAL_POLICIES = [
  {
    since: "2025-02-09T00:00:00+08:00",
    label: "deepseek-chat / deepseek-reasoner standard prices",
    prices: {
      "deepseek-chat": {
        cny: { input: 2, cacheRead: 0.5, output: 8 },
        usd: { input: 0.28, cacheRead: 0.028, output: 0.42 }
      },
      "deepseek-reasoner": {
        cny: { input: 4, cacheRead: 1, output: 16 },
        usd: { input: 0.55, cacheRead: 0.055, output: 1.68 }
      },
      "*": {
        cny: { input: 2, cacheRead: 0.5, output: 8 },
        usd: { input: 0.28, cacheRead: 0.028, output: 0.42 }
      }
    }
  },
  {
    since: "2026-05-22T00:00:00+08:00",
    label: "V4 series permanent 75% discount (deepseek-v4-flash / deepseek-v4-pro)",
    prices: {
      "deepseek-v4-flash": {
        cny: { input: 1, cacheRead: 0.02, output: 2 },
        usd: { input: 0.14, cacheRead: 0.0028, output: 0.28 }
      },
      "deepseek-v4-pro": {
        cny: { input: 3, cacheRead: 0.025, output: 6 },
        usd: { input: 0.435, cacheRead: 0.003625, output: 0.87 }
      },
      "*": {
        cny: { input: 1, cacheRead: 0.02, output: 2 },
        usd: { input: 0.14, cacheRead: 0.0028, output: 0.28 }
      }
    }
  },
  {
    since: "2026-08-17T00:00:00+08:00",
    label: "Peak/off-peak pricing: peak 09:00-12:00 / 14:00-18:00 (Beijing), off-peak half price",
    peak: {
      "deepseek-v4-flash": {
        cny: { input: 3, cacheRead: 0.1, output: 9 },
        usd: { input: 0.44, cacheRead: 0.014, output: 1.32 }
      },
      "deepseek-v4-pro": {
        cny: { input: 9, cacheRead: 0.3, output: 27 },
        usd: { input: 1.32, cacheRead: 0.044, output: 3.96 }
      },
      "*": {
        cny: { input: 3, cacheRead: 0.1, output: 9 },
        usd: { input: 0.44, cacheRead: 0.014, output: 1.32 }
      }
    },
    offPeak: {
      "deepseek-v4-flash": {
        cny: { input: 1.5, cacheRead: 0.05, output: 4.5 },
        usd: { input: 0.22, cacheRead: 0.007, output: 0.66 }
      },
      "deepseek-v4-pro": {
        cny: { input: 4.5, cacheRead: 0.15, output: 13.5 },
        usd: { input: 0.66, cacheRead: 0.022, output: 1.98 }
      },
      "*": {
        cny: { input: 1.5, cacheRead: 0.05, output: 4.5 },
        usd: { input: 0.22, cacheRead: 0.007, output: 0.66 }
      }
    }
  }
];

/** Whether `timeMs` (epoch ms) falls inside a peak window in the given timezone. */
export function isPeak(timeMs, timezone = "Asia/Shanghai", windows = PEAK_WINDOWS) {
  let hour;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      hour: "numeric",
      minute: "numeric"
    }).formatToParts(new Date(timeMs));
    hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
  } catch {
    hour = -1;
  }
  return windows.some(([start, end]) => hour >= start && hour < end);
}

/** Pick a model's unit price inside one price table, with the `*` fallback. */
function priceFor(model, table) {
  return table[model] ?? table["*"] ?? { cny: ZERO_UNIT, usd: ZERO_UNIT };
}

/**
 * Map an arbitrary model id to the closest official family key:
 * exact key first, then substring heuristics (flash before pro, so a
 * "deepseek-v4-flash-0731" never matches the pro row).
 */
export function modelFamily(model) {
  const m = String(model ?? "").toLowerCase();
  if (m === "") return "*";
  for (const key of ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash", "deepseek-v4-pro"]) {
    if (m === key) return key;
  }
  if (m.includes("flash")) return "deepseek-v4-flash";
  if (m.includes("pro")) return "deepseek-v4-pro";
  if (m.includes("reasoner")) return "deepseek-reasoner";
  if (m.includes("chat")) return "deepseek-chat";
  return "*";
}

/**
 * Resolve the unit price (CNY + USD) for a model at a moment.
 * Follows the official policy chain: newest policy not later than the moment
 * that NAMES the model wins; otherwise the newest applicable policy's `*`.
 * @returns { cny: {input,cacheRead,output}, usd: {input,cacheRead,output}, mode }
 */
export function priceAt(model, timeMs, timezone = "Asia/Shanghai") {
  const family = modelFamily(model);
  const peak = isPeak(timeMs, timezone);
  const applicable = OFFICIAL_POLICIES.filter((policy) => timeMs >= Date.parse(policy.since));
  const scope = applicable.length > 0 ? applicable : [OFFICIAL_POLICIES[0]];
  let winner;
  let table;
  for (let index = scope.length - 1; index >= 0; index--) {
    const policy = scope[index];
    const candidate = policy.peak !== void 0 && policy.offPeak !== void 0
      ? (peak ? policy.peak : policy.offPeak)
      : policy.prices;
    if (candidate[family] !== void 0) {
      winner = policy;
      table = candidate;
      break;
    }
  }
  if (winner === void 0) {
    winner = scope[scope.length - 1];
    table = winner.peak !== void 0 && winner.offPeak !== void 0
      ? (peak ? winner.peak : winner.offPeak)
      : winner.prices;
  }
  const unit = priceFor(family, table);
  return {
    cny: unit.cny,
    usd: unit.usd,
    mode: winner.peak !== void 0 && winner.offPeak !== void 0 ? (peak ? "peak" : "offPeak") : "flat"
  };
}

/**
 * Cost (in the given currency) of one usage sample.
 * @param buckets - { uncachedInputTokens?, inputTokens?, cacheReadTokens?, cacheWriteTokens?, outputTokens? }
 * @param unit - { input, cacheRead, output } price per 1M tokens.
 */
export function costOf(buckets, unit) {
  const input = (buckets.uncachedInputTokens ?? buckets.inputTokens ?? 0) / 1e6 * unit.input;
  const cacheRead = (buckets.cacheReadTokens ?? 0) / 1e6 * unit.cacheRead;
  const output = (buckets.outputTokens ?? 0) / 1e6 * unit.output;
  return input + cacheRead + output;
}
