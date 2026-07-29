<div align="center">

# Claude Meter

**Know exactly what your Claude Code usage costs.**

Track tokens, estimate costs, and monitor usage — all from your terminal.

[![npm version](https://img.shields.io/npm/v/cob-claude-meter)](https://www.npmjs.com/package/cob-claude-meter)
[![license](https://img.shields.io/badge/license-MIT-green)](https://github.com/callobuzz/cob-claude-meter/blob/main/LICENSE)
![platform](https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-blue)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

[**Showcase & Demo**](https://callobuzz.github.io/cob-claude-meter/showcase/)

</div>

<div align="center">
<img src="https://raw.githubusercontent.com/callobuzz/cob-claude-meter/main/docs/showcase/cob-claude-meter-this-month.png" alt="Claude Meter monthly report" width="700">
<br><br>
<img src="https://raw.githubusercontent.com/callobuzz/cob-claude-meter/main/docs/showcase/cob-claude-statusline.png" alt="Claude Meter statusline" width="700">
<br>
<em>Statusline showing live token usage and cost in Claude Code</em>
</div>

---

## Quick Start

```bash
npm install -g cob-claude-meter

claude-meter today

# Enable statusline in Claude Code
claude-meter install-statusline

# Work-hours dashboard in the browser
claude-meter serve
```

---

## Why Claude Meter?

- **No visibility** into historical Claude Code token usage
- **No cost tracking** — you don't know what you're spending
- **No per-model breakdown** — which model burns most tokens?
- **Built-in `/stats` is limited** — no history, no export, no detail

Claude Meter reads your local Claude Code logs and gives you **instant answers**.

---

## Features

| Feature | Description |
|---|---|
| **Token Tracking** | Input, output, cache read, cache creation (5m + 1h) |
| **Per-Model Breakdown** | See usage split across Opus, Sonnet, Haiku |
| **Exact Cost Estimates** | Uses real cache breakdowns — no guessing |
| **Time Ranges** | Today, this week, this month, custom ranges |
| **Work-Hours Tracking** | Active time per project and per day, idle time excluded |
| **Web Dashboard** | Filterable, searchable UI — run it in Docker, open a URL |
| **Client Tagging** | Tag projects with a client, then filter and roll up by client |
| **Live Watch Mode** | Real-time dashboard with auto-refresh |
| **Claude Code Statusline** | See costs right in your terminal |
| **Rate Limit Bars** | 5-hour and 7-day usage with time remaining |
| **JSON Output** | Pipe to jq, scripts, dashboards |
| **Cross-Platform** | Windows, macOS, Linux |
| **Zero Config** | Auto-discovers your Claude Code logs |
| **Offline & Private** | 100% local — no network calls, no telemetry |

---

## Commands

### Usage Reports

```bash
claude-meter                    # This month (default)
claude-meter today              # Today
claude-meter yesterday          # Yesterday
claude-meter this-week          # This week (Mon–now)
claude-meter last-week          # Last week (Mon–Sun)
claude-meter this-month         # This month
claude-meter last-month         # Last month
claude-meter this-year          # This year
claude-meter last30             # Last 30 days
claude-meter all                # All time
claude-meter range 2026-02-01 2026-02-28  # Custom range
```

### Output Flags

```bash
claude-meter today --json       # Machine-readable JSON
claude-meter today --compact    # Single-section compact view
claude-meter today --fresh      # Input + output only (no cache)
claude-meter today --no-color   # Disable colors
claude-meter today --verbose    # Show scan stats
```

### Management

```bash
claude-meter config                           # View config
claude-meter config --set defaultCommand=today  # Set default
claude-meter config --reset                   # Reset to defaults
claude-meter paths                            # Show log paths
claude-meter doctor                           # Full diagnostics
claude-meter setup                            # Interactive path setup
```

### Statusline

```bash
claude-meter install-statusline    # Install into Claude Code
claude-meter uninstall-statusline  # Remove from Claude Code
```

### Live Monitor (terminal)

```bash
claude-meter watch                 # Live dashboard (30s refresh)
claude-meter watch --interval 10   # Custom refresh interval
claude-meter watch --compact       # Minimal live view
```

### Work-Hours Dashboard

```bash
claude-meter serve                 # http://127.0.0.1:4317
claude-meter serve --port 8080     # Custom port
claude-meter serve --host 0.0.0.0  # Bind all interfaces (containers)
```

---

## Work-Hours Tracking

Alongside tokens, Claude Meter measures **how long you actually worked**, derived
from timestamps already present in your session logs. Nothing new is recorded and
no daemon runs — it works retroactively across your entire log history.

### How active time is measured

Every log entry carries a timestamp. Active time is the sum of gaps between
consecutive entries, **discarding any gap longer than the idle cutoff** (5 minutes
by default). An idle terminal writes nothing, so it excludes itself. A four-minute
build sits under the cutoff and counts as work, which is the intent — time the
pipeline is live is time spent.

Two totals are reported, and they answer different questions:

| Metric | Meaning | Use it for |
|---|---|---|
| **Summed** | Each session counted separately. Two terminals for an hour each = 2 h. | Per-project effort, billing |
| **Wall-clock** | All sessions merged onto one timeline. The same hour counts once. | "How long was I at the desk?" |

If you run several terminals at once the two diverge permanently — that gap is
real concurrency, not an error. Summed is the headline number; wall-clock sits
beside it so a 23-hour day is recognisable as double counting rather than a record.

### Project identity

A project is a **log directory**, not a `cwd`. `cwd` follows your shell, so one
session reports many values as you move between subfolders — and occasionally a
stale path that no longer exists. The display name is the shallowest path the
majority of entries sit beneath, so subdirectory excursions and outliers do not
split one project into several. Directories that resolve to the same path (after
a folder rename) merge back together.

Subagent transcripts under `<session-id>/subagents/` are deliberately ignored — a
subagent runs *inside* its parent session, so counting them would multiply the
same terminal.

### Clients and tags

Assign a client and free-form tags to any project from the dashboard, then filter
and roll up by client. Tags live in `tags.json` inside the data directory,
separate from the log-derived numbers, so they survive rescans and rebuilds.

---

## Docker

```bash
docker compose up -d       # then open http://localhost:4317
```

`docker-compose.yml` mounts your session logs **read-only** and keeps tags plus
the scan cache in a named volume:

```yaml
volumes:
  - "${CLAUDE_LOGS_DIR:-$HOME/.claude/projects}:/logs:ro"
  - claude-meter-data:/data
```

Set `TZ` to your own timezone — day boundaries are computed in local time, so a
container left on UTC will split your evenings across the wrong dates:

```bash
TZ=Asia/Kolkata CLAUDE_METER_PORT=4317 docker compose up -d
```

| Variable | Purpose | Default |
|---|---|---|
| `CLAUDE_METER_LOG_PATHS` | Log directories (`;` or `:` separated) | `/logs` |
| `CLAUDE_METER_DATA_DIR` | Tags + cache location | `/data` |
| `HOST` / `PORT` | Bind address and port | `0.0.0.0` / `4317` |
| `TZ` | Timezone for day boundaries | `UTC` |

Scans are cached per file on mtime + size, so only changed sessions are re-read —
a cold scan of ~500 MB of logs takes a few seconds, warm reloads are near-instant.

---

## Output Examples

### Full Report

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

  Pricing: bundled defaults (2026-03-22)
```

### Compact Report

```
Claude Meter — Today (Mar 22, 2026)

  Entries: 3,241 | Sessions: 28

  Tokens:   Input 245.3K | Output 892.1K | Fresh 1.1M
  Cache:    Read 312.5M | 5m 8.2M | 1h 14.7M | Full 335.4M

  Models:   opus-4-6 94% | haiku-4-5 6%

  Cost:     $142.38 (opus $134.10 | haiku $8.28)

  Pricing:  bundled defaults
```

### Statusline

```
Opus [===========         ] 45% 120k/200k git:main | my-project
Today: 1.2M ~$85 | Month: 47.5M ~$1.2K
Usage ██░░░░░░ 5% (4h 35m / 5h) | █░░░░░░░ 3% (1d 23h / 7d)
```

The third line shows your Claude.ai rate limit usage with block-style progress bars and time remaining. Automatically hidden for API users or when rate limit data isn't available.

---

## Configuration

Config is stored at `~/.claude-meter/config.json`.

| Key | Default | Description |
|---|---|---|
| `logPaths` | `[]` (auto-detected) | Paths to Claude Code log directories |
| `defaultCommand` | `this-month` | Default time range |
| `statusline.format` | `cost` | Statusline format: `cost`, `tokens+cost`, `model-split`, `full` |
| `statusline.refreshCache` | `300` | Cache TTL in seconds |
| `pricing.overrides` | `{}` | Custom per-model pricing |
| `formatting.numberFormat` | `short` | Token display: `short` (1.2M) or `full` (1,234,567) |

---

## Pricing

Bundled with official Anthropic pricing (March 2026). Updated with each npm release.

| Model | Input | Output | Cache Write 5m | Cache Write 1h | Cache Read |
|---|---|---|---|---|---|
| Opus 4.6 | $5/M | $25/M | $6.25/M | $10/M | $0.50/M |
| Opus 4.5 | $5/M | $25/M | $6.25/M | $10/M | $0.50/M |
| Sonnet 4.6 | $3/M | $15/M | $3.75/M | $6/M | $0.30/M |
| Sonnet 4.5 | $3/M | $15/M | $3.75/M | $6/M | $0.30/M |
| Haiku 4.5 | $1/M | $5/M | $1.25/M | $2/M | $0.10/M |

Override pricing per-model:
```bash
claude-meter config --set 'pricing.overrides.claude-opus-4-6.input=6.00'
```

---

## Setup & Path Discovery

Claude Meter auto-discovers your logs on first run. No setup needed for standard installs.

**Default search paths:**

| Platform | Path |
|---|---|
| Windows | `C:\Users\<you>\.claude\projects\` |
| macOS | `~/.claude/projects/` |
| Linux | `~/.claude/projects/`, `~/.config/claude/projects/` |

**Custom paths (Docker, WSL, etc.):**
```bash
claude-meter setup                    # Interactive wizard
claude-meter config --set 'logPaths=["/custom/path"]'  # Direct
```

**Diagnostics:**
```bash
claude-meter doctor    # Full health check
claude-meter paths     # Show detected paths
```

---

## FAQ

**Q: Does this send my data anywhere?**
No. Claude Meter is 100% local. No network calls, no telemetry, no analytics.

**Q: How accurate are the cost estimates?**
Very accurate. Unlike other tools, Claude Meter uses the exact 5-minute and 1-hour cache creation token breakdowns from your logs — not estimates or ranges.

**Q: Which models does it support?**
All Claude models found in your logs are automatically detected and priced. Unknown models fall back to Opus pricing with a warning.

**Q: How fast is it?**
Typical runs complete in < 2 seconds, even with 100k+ log entries across 2,500+ files.

**Q: Does the statusline slow down Claude Code?**
No. The statusline reads from a local cache file (< 10ms). Log scanning happens in the background with a 5-minute refresh interval.

---

## Contributing

```bash
git clone https://github.com/callobuzz/cob-claude-meter
cd claude-meter
npm install
npm run build
npm test
```

---

## About

Built by [Call O Buzz Services](https://callobuzz.com) — AI-driven software development, SaaS solutions, and open source tools.

## License

MIT
