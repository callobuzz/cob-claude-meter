<div align="center">

# Claude Meter

**Know exactly what your Claude Code usage costs — and how long it took.**

Track tokens, estimate costs, and measure real working hours — from your terminal
or a filterable web dashboard.

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
- **No time tracking** — how many hours did that project actually take?
- **Built-in `/stats` is limited** — no history, no export, no detail

Claude Meter reads your local Claude Code logs and gives you **instant answers** —
for today and for every session you have already run.

---

## Features

| Feature | Description |
|---|---|
| **Token Tracking** | Input, output, cache read, cache creation (5m + 1h) |
| **Per-Model Breakdown** | See usage split across Opus, Sonnet, Haiku |
| **Exact Cost Estimates** | Uses real cache breakdowns — no guessing |
| **Time Ranges** | Today, this week, this month, custom ranges |
| **Work-Hours Tracking** | Active time per project and per day, idle time excluded |
| **Multi-Client Billing** | Tag projects by client, filter and roll up hours per client |
| **Web Dashboard** | Filterable, searchable UI — run it with or without Docker |
| **Retroactive** | Works on logs you already have — no timer, nothing to start |
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
claude-meter retention                        # Check / extend how long logs are kept
```

### Log retention

```bash
claude-meter retention             # explain, then ask before changing anything
claude-meter retention --dry-run   # the explanation and the numbers only
claude-meter retention --days 365  # a different window
claude-meter retention --yes       # skip the prompt (scripts)
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

Both stay exact under filters. Narrow to one client and the wall-clock figure is
recomputed as the union of just that client's sessions, not an approximation —
so "how many real hours did this client take?" is answerable directly.

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

### Who this is for

Developers juggling **several clients or projects at once** — especially anyone
billing by the hour or trying to understand where their time actually goes.

You already generate the data by working. This turns it into a defensible picture
of how much time went into each client, without a timer to start, stop or forget.

| Use case | How |
|---|---|
| **Bill a client by the hour** | Tag projects with a client, filter by client, read the month's hours |
| **Multi-client time split** | Clients tab — hours and share of total per client |
| **Freelance timesheets** | Per-day hours per project, reconstructed from work you already did |
| **Productivity check** | Timeline grouped by day or week — where the hours went |
| **Plan and quote** | "That feature took 31 hours" from real data instead of memory |
| **Spot overwork** | Wall-clock hours per day; a 14-hour day is visible immediately |

Because it reads logs you already have, all of this works for **past** work from
the day you install it — there is nothing to start recording. Install it today and
last month is already there.

### How accurate is it?

**Treat it as a fair, defensible estimate — not a stopwatch.** It measures when
your Claude Code sessions were actively producing output, which is a good proxy
for time worked, but it is a proxy:

- **Not counted:** thinking away from the terminal, meetings, reading docs,
  reviewing code in your editor, anything longer than the idle cutoff
- **Counted:** time Claude spends working while you wait, including long tool
  runs and builds under the cutoff
- **Sensitive to one setting:** the idle cutoff. At 2 minutes a month reads much
  lower than at 10 — pick one and stay on it so periods stay comparable

For hourly billing, the honest use is as a **floor and a sanity check** — evidence
that a project consumed roughly N hours — rather than an invoice generated
automatically. It is far closer to reality than reconstructing a month from
memory, which is the usual alternative.

### Limitations

This tool reads Claude Code's session transcripts. It writes nothing to them and
creates no data of its own, which makes it fully retroactive — and also means
**Claude Code's own settings decide what it can ever see.** Know these before you
rely on the numbers.

#### Claude Code deletes your logs — this is the big one

Claude Code deletes `~/.claude/projects/<project>/<session>.jsonl` on startup
once the file is older than **`cleanupPeriodDays`, which defaults to 30 days**.
Consequences, stated plainly:

- **History has a hard ceiling.** On the default, "All time" means the last 30
  days. No setting in this tool changes that.
- **The loss is silent.** A pruned project keeps its folder (and its
  `memory/`, `sessions-index.json`), so it stops appearing in reports rather
  than showing zero. Nothing warns you.
- **It is irreversible.** The per-message timestamps that active-time is derived
  from existed only inside the deleted transcript. Nothing reconstructs them.
- **Extending it is not retroactive.** Raising `cleanupPeriodDays` stops the next
  sweep; it recovers nothing.

Run `claude-meter retention` to see your current window, which projects have
already been pruned, and what a longer window costs in disk and privacy. See
[Your logs expire](#your-logs-expire--that-limits-how-far-back-this-can-look).

#### Other Claude Code settings that zero out the data

| Setting | Effect here |
|---|---|
| `CLAUDE_CODE_SKIP_PROMPT_HISTORY` env var | No transcripts written at all — **no hours, ever**, for any session run with it set |
| `--no-session-persistence` (with `-p`) | That non-interactive run leaves no transcript |
| `persistSession: false` (Agent SDK) | Same, for SDK-driven sessions |
| A `settings.json` Claude Code can't parse | Claude Code pauses its cleanup sweep; your retention is not what you think it is |

#### Scope limits

- **Claude Code only.** Work in your editor, terminal, browser or another AI tool
  is invisible. This measures Claude Code sessions, not your working day.
- **This machine only.** It reads local log directories. Two laptops means two
  separate sets of numbers; there is no aggregation across machines.
- **Subagent transcripts are excluded on purpose.** They run *inside* a parent
  session, so counting them would multiply the same wall-clock time.
- **Idle cutoff changes every number.** A month at a 2-minute cutoff reads much
  lower than at 10. Pick one and stay on it, or periods stop being comparable.
- **Day boundaries follow `TZ`.** Change the timezone and evening work moves
  between days. In Docker, set `TZ` explicitly — the container is UTC otherwise.
- **Project identity comes from the session's working directory.** Move a project
  to a different path and it becomes a separate row from that point on.
- **Tags do not sync.** The Docker store (`./meter-data/`) and the CLI store
  (`~/.claude-meter/`) are independent until you copy `tags.json` across.

---

## Running the Dashboard

Two ways to run it. They are independent and don't know about each other, so you
can use either — or both, on different ports.

| | Without Docker | With Docker |
|---|---|---|
| Command | `claude-meter serve` | `docker compose up -d` |
| Needs Docker Desktop | no | yes |
| Data location | `~/.claude-meter/` | `./meter-data/` on your machine |
| Timezone | your OS timezone, automatic | set `TZ` yourself |
| Survives reboot | start it again | auto-starts with Docker |
| Best for | quick local use | always-on, set and forget |

### Option A — Without Docker

```bash
npm install -g cob-claude-meter
claude-meter serve
```

Open **http://127.0.0.1:4317**. That's the whole setup — logs are auto-discovered,
and the timezone comes from your OS.

```bash
claude-meter serve --port 8080          # different port
claude-meter serve --host 0.0.0.0       # reachable from your LAN
claude-meter serve --data-dir ./meter   # keep tags/cache somewhere else
```

Stop it with `Ctrl+C`. Nothing runs in the background; start it again when you
want it. Your tags persist in `~/.claude-meter/tags.json`.

To keep it running permanently without Docker, use your OS service manager
(`pm2 start "claude-meter serve"`, a systemd unit, or a Windows Task Scheduler
entry set to run at logon).

### Option B — With Docker

```bash
cp .env.example .env      # then edit it — see below
docker compose up -d
```

Open **http://localhost:4317**. The container is set to `restart: unless-stopped`,
so it comes back automatically whenever Docker Desktop starts.

Edit `.env` before the first run:

```bash
CLAUDE_LOGS_DIR=C:/Users/YOU/.claude/projects   # forward slashes on Windows
CLAUDE_METER_PORT=4317
TZ=Asia/Kolkata                                 # your timezone — see warning below
```

> **Set `TZ` to your real timezone.** Day boundaries are computed in local time.
> Leaving the container on UTC pushes evening work onto the previous day and
> quietly corrupts every daily total. The image ships `tzdata` so any standard
> zone name works.

`docker-compose.yml` mounts your session logs **read-only** and keeps tags plus
the scan cache in a folder on your machine:

```yaml
volumes:
  - "${CLAUDE_LOGS_DIR:-$HOME/.claude/projects}:/logs:ro"
  - "${CLAUDE_METER_DATA_HOST_DIR:-./meter-data}:/data"
```

A host folder rather than a named Docker volume, on purpose. Assigning clients
to twenty projects is slow manual work, and `docker compose down -v` deletes
named volumes without prompting. On the host it survives every compose command
and you can back it up by copying one file.

`meter-data/` is git-ignored: it holds your client names and absolute project
paths, which do not belong in a public repository.

| Variable | Purpose | Default |
|---|---|---|
| `CLAUDE_LOGS_DIR` | Host path to your Claude Code logs | `$HOME/.claude/projects` |
| `CLAUDE_METER_PORT` | Host port to publish | `4317` |
| `CLAUDE_METER_DATA_HOST_DIR` | Host folder holding `tags.json` + cache | `./meter-data` |
| `CLAUDE_METER_LOG_PATHS` | Log directories inside the container (`;` or `:` separated) | `/logs` |
| `CLAUDE_METER_DATA_DIR` | Tags + cache location inside the container | `/data` |
| `HOST` / `PORT` | Bind address and port inside the container | `0.0.0.0` / `4317` |
| `TZ` | Timezone for day boundaries | `UTC` |

> `CLAUDE_METER_DATA_HOST_DIR` and `CLAUDE_METER_DATA_DIR` are deliberately
> different names. The first is the host folder, the second is the path inside
> the container — exporting the latter for the CLI must not move the mount.

### Managing the container

```bash
docker compose stop            # pause — page goes offline, data untouched
docker compose start           # resume

docker compose down            # DELETE the container — data still safe
docker compose up -d           # recreate it, tags and cache intact

docker compose up -d --build   # rebuild after changing the code
docker compose logs -f         # follow the logs
docker compose ps              # check status

docker compose down -v         # DELETE container and named volumes
```

None of these touch your tags, because `meter-data/` is a folder on your machine
rather than a Docker volume — including `down -v`, which is the command that used
to destroy them.

### What your data is worth

| Data | Where | Risk |
|---|---|---|
| Session logs | your machine, mounted **read-only** | untouched — no Docker action can harm them |
| `tags.json` | `./meter-data/` or `~/.claude-meter/` | the only irreplaceable file — back it up |
| `timeline-cache.json` | `./meter-data/` or `~/.claude-meter/` | disposable, rebuilds itself on the next scan |

Back it up by copying one file:

```bash
cp meter-data/tags.json ~/backups/claude-meter-tags.json
```

The keys in `tags.json` are the project paths recorded inside your logs, not the
mount paths, so the same file works under Docker and under `claude-meter serve`.
Copy it into `~/.claude-meter/` to share tags between the two.

> **Docker and the CLI keep separate stores.** Tagging in the container writes to
> `./meter-data/`; tagging via `claude-meter serve` writes to `~/.claude-meter/`.
> Neither sees the other until you copy the file across.

The read-only log mount guarantees your actual Claude Code history is never
written to.

### Your logs expire — that limits how far back this can look

Claude Code deletes session files older than `cleanupPeriodDays` (**default 30
days**) at startup. This tool derives every number from those files, so once they
are gone the hours are gone with them — "All time" can only reach as far back as
your retention window.

If you bill from these numbers, raise it before you need it:

```bash
claude-meter retention
```

It prints your current setting, what is on disk, which projects have already
lost their logs, and what a longer window costs — then asks before writing
anything. `--dry-run` shows all of that and changes nothing.

The two costs it will quote you, because neither is free:

- **Disk.** It measures your actual growth rate and extrapolates. At 28 MB/day,
  ten years of retention is roughly 100 GB.
- **Privacy.** Transcripts are plaintext and unencrypted. Anything passing
  through a tool is written to them, including file contents and command
  output, so a credential read from a `.env` is in there too. A longer window
  means a longer-lived copy on disk.

Equivalent manual edit in `~/.claude/settings.json`:

```json
{ "cleanupPeriodDays": 3650 }
```

Extending retention never recovers anything already deleted — it only stops the
next sweep. A pruned project leaves its directory behind with a
`sessions-index.json` but no `.jsonl` transcripts, so it silently drops out of
the report rather than showing zero. `claude-meter doctor` flags this too.

### Performance

Scans are cached per file on mtime + size, so only sessions that changed get
re-read. A cold scan of ~500 MB of logs takes a few seconds; warm reloads are
under 100 ms. The cache survives restarts.

### Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Page won't load | Container stopped or Docker Desktop is off — `docker compose ps`, then `docker compose start` |
| Days look shifted | `TZ` not set or wrong — fix `.env`, then `docker compose up -d` |
| Port already in use | Something else owns the port. Change `CLAUDE_METER_PORT`, or find the owner — a stray `claude-meter serve` on the host will win over Docker on `127.0.0.1` |
| "No log directories found" | Set `CLAUDE_LOGS_DIR` (Docker) or `claude-meter config --set logPaths='["/path"]'` |
| Hours look too low | Raise the idle cutoff in the header dropdown — long unattended builds may exceed it |
| Hours look too high | Lower the idle cutoff, or read wall-clock instead of summed if you run several terminals |
| Toast says logs were skipped | One or more logs were unreadable and totals are incomplete — check `docker compose logs` |
| Projects missing from "All time" | Claude Code deleted their transcripts — run `claude-meter retention` to see which, and to extend the window |
| "All time" only reaches back a month | Same cause: `cleanupPeriodDays` defaults to 30 days |

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
