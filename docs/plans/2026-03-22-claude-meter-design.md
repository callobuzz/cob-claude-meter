# Claude Meter — Design Document

**Date:** March 22, 2026
**Status:** Approved
**Author:** SV

---

## 1. Overview

Claude Meter is a lightweight, cross-platform CLI tool (Node.js) that analyzes local Claude Code `.jsonl` logs and provides clear, actionable insights into token usage and estimated cost. It also integrates as a Claude Code statusline for real-time visibility.

### Key Decisions

- **Pure Node.js** — `readline` + `createReadStream` for streaming. No Go binary.
- **Single npm package** — `@callobuzz/claude-meter`, globally installable
- **Per-model breakdown** — reads `message.model` from logs, not assumed Opus
- **Exact cache costs** — uses `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` from logs
- **Human-readable numbers** — K, M, B formatting for tokens
- **Statusline integration** — built-in Claude Code statusline with replace/add/skip options
- **Local-first** — no cloud, no auth, no dashboards, no network calls
- **No fetch for pricing** — bundled defaults only + user config overrides. Updated via npm releases.

---

## 2. Architecture

```
@callobuzz/claude-meter (single npm package)

src/
├── cli.ts                    # Entry point, commander setup
├── commands/
│   ├── default.ts            # claude-meter (this-month)
│   ├── today.ts              # claude-meter today
│   ├── week.ts               # this-week, last-week
│   ├── month.ts              # this-month, last-month
│   ├── year.ts               # this-year
│   ├── range.ts              # range <start> <end>
│   ├── last30.ts             # last 30 days
│   ├── all.ts                # all time
│   ├── watch.ts              # live mode
│   ├── doctor.ts             # diagnostics
│   ├── paths.ts              # show detected paths
│   ├── setup.ts              # interactive path setup
│   ├── config.ts             # config management
│   ├── install-statusline.ts # statusline installer
│   ├── uninstall-statusline.ts
│   └── statusline.ts         # statusline output command
├── core/
│   ├── scanner.ts            # log file discovery + streaming
│   ├── aggregator.ts         # token aggregation, per-model grouping
│   ├── pricing.ts            # bundled defaults + config + fetch merge
│   ├── formatter.ts          # human-readable (K/M/B), JSON, colors
│   ├── config-manager.ts     # ~/.claude-meter/config.json CRUD
│   ├── cache-manager.ts      # statusline scan cache (~5min TTL)
│   └── path-resolver.ts      # cross-platform log path discovery
├── data/
│   └── pricing.json          # bundled default prices per model
└── index.ts                  # programmatic API export

Config directory: ~/.claude-meter/
├── config.json               # user preferences, paths, statusline format
├── cache.json                # statusline scan cache
└── settings-backup.json      # backup of Claude Code settings
```

---

## 3. Data Processing

### Log Entry Filtering

Entries matching:
- `type === "assistant"`
- `message.usage` exists
- `timestamp` exists and is valid

### Fields Extracted Per Entry

| Field | Source | Purpose |
|---|---|---|
| `input_tokens` | `message.usage.input_tokens` | Fresh input cost |
| `output_tokens` | `message.usage.output_tokens` | Output cost |
| `cache_read_input_tokens` | `message.usage.cache_read_input_tokens` | Cache read cost |
| `cache_creation_input_tokens` | `message.usage.cache_creation_input_tokens` | Total cache creation |
| `ephemeral_5m_input_tokens` | `message.usage.cache_creation.ephemeral_5m_input_tokens` | Exact 5m cache cost |
| `ephemeral_1h_input_tokens` | `message.usage.cache_creation.ephemeral_1h_input_tokens` | Exact 1h cache cost |
| `model` | `message.model` | Per-model grouping |
| `web_search_requests` | `message.usage.server_tool_use.web_search_requests` | Tool usage tracking |
| `web_fetch_requests` | `message.usage.server_tool_use.web_fetch_requests` | Tool usage tracking |
| `timestamp` | top-level `timestamp` | Time filtering |
| `sessionId` | top-level `sessionId` | Session grouping |

### Aggregation Output Structure

```typescript
{
  period: { label, start, end },

  totals: {
    entries_matched: number,
    files_scanned: number,
    sessions: number,
    input_tokens: number,
    output_tokens: number,
    cache_read_input_tokens: number,
    cache_creation_input_tokens: number,
    cache_5m_input_tokens: number,
    cache_1h_input_tokens: number,
    fresh_total: number,
    full_total: number,
    web_searches: number,
    web_fetches: number,
  },

  by_model: {
    "claude-opus-4-6": { /* same token fields */ },
    "claude-haiku-4-5-20251001": { /* same token fields */ },
  },

  cost_estimate_usd: {
    input: number,
    output: number,
    cache_read: number,
    cache_creation_5m: number,
    cache_creation_1h: number,
    total: number,
    by_model: { ... }
  },

  pricing_used: {
    source: "bundled" | "fetched" | "user-config",
    rates: { ... }
  }
}
```

### Number Formatting

```
1,234             → 1.2K
1,234,567         → 1.2M
1,234,567,890     → 1.2B
```

Applied to CLI and statusline. Raw numbers in `--json` output.

---

## 4. Commands & Flags

### Time Commands

| Command | Period |
|---|---|
| `claude-meter` | This month (default, configurable) |
| `claude-meter today` | Today (midnight to now) |
| `claude-meter yesterday` | Yesterday (full day) |
| `claude-meter this-week` | Monday to now |
| `claude-meter last-week` | Last Mon–Sun |
| `claude-meter this-month` | 1st to now |
| `claude-meter last-month` | Full previous month |
| `claude-meter this-year` | Jan 1 to now |
| `claude-meter last30` | Rolling 30 days |
| `claude-meter range <start> <end>` | Custom (YYYY-MM-DD) |
| `claude-meter all` | All time |

### Output Flags

| Flag | Effect |
|---|---|
| `--json` | Machine-readable JSON output |
| `--fresh` | Only show input + output (no cache) |
| `--compact` | Single-section compact format |
| `--no-color` | Disable ANSI colors |
| `--verbose` | Show scan stats, skipped lines, debug info |

### Management Commands

| Command | Purpose |
|---|---|
| `claude-meter setup` | Interactive path discovery (never forced) |
| `claude-meter config` | View current config |
| `claude-meter config --set <key>=<value>` | Set config value |
| `claude-meter config --reset` | Reset to defaults |
| `claude-meter paths` | Show detected log paths + file counts |
| `claude-meter doctor` | Full diagnostics |
| `claude-meter install-statusline` | Install/merge into Claude Code statusline |
| `claude-meter uninstall-statusline` | Restore original statusline |
| `claude-meter watch` | Live updating dashboard |
| `claude-meter watch --interval <sec>` | Custom refresh interval |
| `claude-meter watch --compact` | Minimal live view |

### Config Keys

```json
{
  "logPaths": ["~/.claude/projects/"],
  "defaultCommand": "this-month",
  "statusline": {
    "format": "cost",
    "refreshCache": 300
  },
  "pricing": {
    "source": "bundled",
    "overrides": {}
  },
  "formatting": {
    "currency": "USD",
    "numberFormat": "short"
  }
}
```

---

## 5. Pricing

### Bundled Defaults (March 22, 2026 — official Anthropic pricing)

All prices USD per million tokens.

| Model | Input | Output | Cache Write 5m | Cache Write 1h | Cache Read |
|---|---|---|---|---|---|
| claude-opus-4-6 | $5.00 | $25.00 | $6.25 | $10.00 | $0.50 |
| claude-opus-4-5 | $5.00 | $25.00 | $6.25 | $10.00 | $0.50 |
| claude-opus-4-1 | $15.00 | $75.00 | $18.75 | $30.00 | $1.50 |
| claude-opus-4 | $15.00 | $75.00 | $18.75 | $30.00 | $1.50 |
| claude-sonnet-4-6 | $3.00 | $15.00 | $3.75 | $6.00 | $0.30 |
| claude-sonnet-4-5 | $3.00 | $15.00 | $3.75 | $6.00 | $0.30 |
| claude-sonnet-4 | $3.00 | $15.00 | $3.75 | $6.00 | $0.30 |
| claude-haiku-4-5 | $1.00 | $5.00 | $1.25 | $2.00 | $0.10 |
| claude-haiku-3-5 | $0.80 | $4.00 | $1.00 | $1.60 | $0.08 |
| claude-haiku-3 | $0.25 | $1.25 | $0.30 | $0.50 | $0.03 |

Source: https://platform.claude.com/docs/en/about-claude/pricing

### Model ID Matching

Log IDs include version suffixes (e.g. `claude-opus-4-5-20251101`). Match by prefix stripping the date suffix.

### Unknown Model Fallback

Flag in output: `⚠ Unknown model: <id> — using opus-4-6 rates as fallback`. User can override via config.

### Pricing Priority Chain

1. User config overrides (`config --set pricing.overrides...`)
2. Bundled defaults (`data/pricing.json` in npm package)

Pricing updates are delivered via npm package updates. No network fetch.

---

## 6. Path Discovery

### Auto-scan (every run, silent)

1. Check `~/.claude-meter/config.json` for saved `logPaths`
2. If no config, scan defaults:
   - **Windows:** `C:\Users\<user>\.claude\projects\`, `%APPDATA%\claude\projects\`
   - **macOS:** `~/.claude/projects/`, `~/Library/Application Support/claude/projects/`
   - **Linux:** `~/.claude/projects/`, `~/.config/claude/projects/`
   - **WSL (from Windows):** `\\wsl$\<distro>\home\<user>\.claude\projects\`
3. If found → save to config silently, proceed
4. If not found → error with suggestion to run `claude-meter setup`

### `claude-meter setup` (user-initiated, never forced)

Interactive flow: scan defaults, show results, option to add more paths (Docker, WSL, custom), validate by reading sample entries, save config.

### `claude-meter doctor`

Full diagnostic: config status, pricing source, cache age, path accessibility, file counts, sample parse, model detection, statusline status.

---

## 7. Statusline

### How It Works

Claude Code runs the configured command, pipes JSON session data via stdin, displays stdout. Updates after every assistant message (300ms debounce).

### `claude-meter install-statusline`

Detects existing statusline in Claude Code `settings.json`:

- **No existing statusline:** Sets command to `claude-meter statusline`
- **Existing statusline detected:** Prompts with 3 options:
  1. **Replace** — full statusline by claude-meter (model, context bar, git, project + meter data)
  2. **Add** — wrapper that runs existing script on line 1, meter data on line 2
  3. **Skip** — manual integration docs

Always backs up existing settings. Reversible via `claude-meter uninstall-statusline`.

### Replace Mode Output (2 lines)

```
Opus [===========         ] 45% 120k/200k git:main | my-project
📊 Today: 1.2M ~$85 | Month: 47.5M ~$1.2K | Opus 92% Haiku 8%
```

### Add Mode Output

```
<user's existing statusline>
📊 Today: 1.2M ~$85 | Month: 47.5M ~$1.2K | Opus 92% Haiku 8%
```

### Configurable Formats

| Format | Output |
|---|---|
| `cost` (default) | `$85 today \| $1.2K month` |
| `tokens+cost` | `1.2M ~$85 today \| 47.5M ~$1.2K month` |
| `model-split` | `Opus: $78 \| Haiku: $7 today` |
| `full` | `📊 Today: 1.2M ~$85 \| Month: 47.5M ~$1.2K \| Opus 92% Haiku 8%` |

### Cache Strategy

Statusline reads from `~/.claude-meter/cache.json` (<10ms). Background refresh when cache age exceeds `refreshCache` config (default 300s). Atomic writes (temp file → rename).

### Progress Bar Color Thresholds

- 0–50%: Green
- 50–80%: Yellow
- 80–100%: Red

---

## 8. Watch Mode

### `claude-meter watch`

Live updating dashboard with:
- Today / This Week / This Month summary rows
- Last hour activity detail
- Model usage breakdown with bars
- Configurable refresh interval (default 30s)
- `--compact` mode for minimal output
- `--json` mode for streaming JSON objects

---

## 9. CLI Output Examples

### Default: `claude-meter` (this month)

```
╔══════════════════════════════════════════════════════════════╗
║                   Claude Meter — March 2026                  ║
╚══════════════════════════════════════════════════════════════╝

  Period:          Mar 1 – Mar 22, 2026
  Files Scanned:   2,568
  Entries:         106,461
  Sessions:        847

┌─ Token Usage ────────────────────────────────────────────────┐
│  Input Tokens:          5.9M                                 │
│  Output Tokens:         11.6M                                │
│  Fresh Total:           17.5M                                │
│                                                              │
│  Cache Read:            8.3B                                 │
│  Cache Created (5m):    201.4M                               │
│  Cache Created (1h):    282.0M                               │
│  Full Total:            8.8B                                 │
└──────────────────────────────────────────────────────────────┘

┌─ By Model ───────────────────────────────────────────────────┐
│  claude-opus-4-6             92.3%    ██████████████████░░    │
│  claude-haiku-4-5-20251001    7.7%    ██░░░░░░░░░░░░░░░░░░    │
└──────────────────────────────────────────────────────────────┘

┌─ Estimated Cost (USD) ───────────────────────────────────────┐
│  Input:              $29.48                                  │
│  Output:             $289.97                                 │
│  Cache Read:         $4,133.48                               │
│  Cache Create (5m):  $1,258.75                               │
│  Cache Create (1h):  $2,820.00                               │
│                                                ──────────    │
│  Total:              $8,531.68                               │
│                                                              │
│  By Model:                                                   │
│    opus-4-6:         $7,882.23                               │
│    haiku-4-5:        $649.45                                 │
└──────────────────────────────────────────────────────────────┘

  Pricing: Claude Opus 4.6 / Haiku 4.5 (bundled defaults)
  Source:  ~/.claude/projects/ (auto-detected)
```

### Compact: `claude-meter today`

```
Claude Meter — Today (Mar 22, 2026)

  Entries: 3,241 | Sessions: 28

  Tokens:   Input 245.3K | Output 892.1K | Fresh 1.1M
  Cache:    Read 312.5M | 5m 8.2M | 1h 14.7M | Full 335.4M

  Models:   opus-4-6 94% | haiku-4-5 6%

  Cost:     $142.38 (opus $134.10 | haiku $8.28)

  Pricing:  bundled defaults
```

### Date Range: `claude-meter range 2026-02-01 2026-02-28`

Full box format with period header showing "Feb 1 – Feb 28, 2026".

### JSON: `claude-meter <any-command> --json`

Returns raw aggregation object, all numbers unformatted, machine-readable.

---

## 10. Error Handling

| Scenario | Behavior |
|---|---|
| Invalid JSON line | Skip silently, count in `--verbose` |
| Missing usage/timestamp | Skip entry |
| Missing model field | Bucket under `"unknown"` |
| Corrupt file | Skip file, warn in `doctor` |
| Empty log directory | Helpful error suggesting `setup` |
| Permission denied | Skip file, log in `--verbose` |
| Corrupt config | Warn, fallback to defaults |
| Unknown model | Use opus-4-6 fallback, flag with `⚠` |
| Statusline timeout | Must complete <500ms via cache |
| Concurrent cache writes | Atomic write (temp → rename) |
| Timezone | Parse UTC from logs, display in local tz |
| Duplicates | v1: accept raw totals |

---

## 11. Package & Distribution

```
Name:       @callobuzz/claude-meter
Binary:     claude-meter
Engine:     Node.js >= 18
Size:       ~50-80KB
License:    MIT
```

### Dependencies

| Package | Purpose |
|---|---|
| `commander` | CLI argument parsing |
| `chalk` | Terminal colors (cross-platform) |
| `inquirer` | Interactive prompts (setup, install-statusline) |

Everything else uses Node.js built-ins.

### Deliverables

- npm package with global CLI
- GitHub repo with comprehensive README
- Showcase HTML page (linked from README) with great UI demonstrating use cases
- Star/popularity-focused README format (badges, GIFs, feature highlights)
- `pricing.json` bundled in package, updated with each npm release

---

## 12. README Requirements

- Comprehensive usage documentation with all commands and flags
- Star-optimized format: hero banner, badges, animated GIF/screenshot, feature grid
- Quick start (3 lines), then deep-dive sections
- Showcase landing page (HTML) linked from README
- FAQ and troubleshooting section
- Contributing guide

---

## 13. Success Criteria

- CLI execution < 2 seconds typical
- Accurate per-model aggregation
- Exact cache cost (no ranges)
- Clean cross-platform install via npm
- Statusline integration in < 1 minute
- Comprehensive README that drives GitHub stars
