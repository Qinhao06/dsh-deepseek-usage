# dsh-deepseek-usage

A usage widget for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) **web GUI**: a floating card pinned to the **bottom-right corner** showing your **remaining DeepSeek API balance**, **today's consumption**, and the **current conversation's cost**.

给 DSH web 界面的 DeepSeek API 用量插件：右下角悬浮卡，显示**余额**、**今日消费**、**当前对话费用**。

## Features

- Bottom-right floating card (registered into the frame-wide `shell.overlay` slot — additive, never blocks the app).
- **Balance** (余额): official `GET /user/balance` data — total / granted / topped-up, availability status.
- **Today's consumption** (今日消费), two sources, platform first:
  1. **platform (preferred, official)** — with a `DEEPSEEK_PLATFORM_TOKEN` credential, queries `platform.deepseek.com/api/v0/usage/cost` (the same date-filterable data the platform console shows).
  2. **log (fallback, local)** — prices every `assistant/message` usage sample that flowed through live sessions today at the official price table (incl. peak/off-peak since 2026-08-17). Reported with an `≈` label so it is never mistaken for an official figure.
- **Current conversation cost** (当前对话费用): the host replays the session's persisted log and prices every `assistant/message`, so the figure includes history from before the plugin was installed. Hover the ⓘ for the live formula (`输入/缓存命中/输出 tokens × 单价 = 小计`).
- Auto-refresh (balance/today: 60s, conversation cost: 5s) plus a manual refresh button.
- Follows the app's light/dark theme (`--dsw-*` tokens). Explicit error states (missing key, network, provider errors).
- **Credentials never leave your machine**: the browser only talks to loopback routes the host half registers.

## Install

Requires the DSH CLI (the profile patch layer is HMR-watched, so the host half loads live — **no restart needed**; just refresh the browser page for the card).

```sh
# 1. make the package resolvable from the profile (Node parent-dir lookup)
ln -sfn /absolute/path/to/dsh-deepseek-usage ~/.dsh/profiles/node_modules/dsh-deepseek-usage

# 2. add one row to ~/.dsh/profiles/web/cordis.patch.yml:
#    - insert:
#        - id: deepseek-usage
#          name: dsh-deepseek-usage

# 3. refresh the browser page — the card appears bottom-right
```

Cold-start alternative (bundle layer, requires a `dsh web` restart):

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-deepseek-usage
```

The package declares `dsh.client`, so the client half is discovered automatically by `dsh-client-modules` and served at `/plugins/dsh-deepseek-usage/client.js`.

## Configuration (credentials)

| Credential | Purpose | How to get it |
|---|---|---|
| `DEEPSEEK_API_KEY` | Balance (`/user/balance`) | Already set via Settings → Models or the environment |
| `DEEPSEEK_PLATFORM_TOKEN` | Official today's consumption (optional, recommended) | Log in to https://platform.deepseek.com → DevTools Console → `JSON.parse(localStorage.getItem('userToken')).value` → store in `~/.dsh/.credentials.yaml` as `DEEPSEEK_PLATFORM_TOKEN: <token>` |

Credentials are resolved through `ctx.credentials` (`~/.dsh/.credentials.yaml` + environment) on the host side — never sent to the browser.

## Layout

```
dsh-deepseek-usage/
├── package.json          # dsh.client declaration + exports
├── cordis.patch.yml      # bundle patch (for `dsh plugin` installs)
├── src/
│   ├── index.js          # host half: 3 loopback routes + per-day log accumulator (zero @deepseek-ai imports, location-independent)
│   ├── pricing.js        # official pricing engine: policy timeline + peak/off-peak (ported from bpc-oss/dsh-web-billing, MIT)
│   └── client.js         # browser half: shell.overlay floating card (hand-written __ModuleLoader__.load bundle, no build step)
└── LICENSE               # MIT
```

## Routes (all loopback-only)

- `GET /api/dsh-deepseek-usage/balance` — balance (upstream cached 60s)
- `GET /api/dsh-deepseek-usage/today` — today's consumption; `source: "platform" | "log"`, log source also carries tokens + per-model breakdown
- `GET /api/dsh-deepseek-usage/session-cost?sessionId=<id>` — exact conversation cost (replayed from the persisted log, incl. pre-install history), with a formula breakdown

## Notes

- The log fallback is a **live accumulator**: everything after plugin load is counted (day rollover automatic, state persisted to `$DSH_HOME/storages/dsh-deepseek-usage-day.json`); usage from finished sessions before installation is not backfilled.
- Local pricing is an estimate, not an official bill — configure the platform token for official figures.
- **npm name notice**: `dsh-deepseek-usage` is already taken on npm (0.1.0 by another author). Publishing to GitHub is unaffected; rename the package if you plan to publish to npm.

## License

MIT. Pricing engine ported from [dsh-web-billing](https://github.com/bpc-oss/dsh-web-billing) (MIT).
