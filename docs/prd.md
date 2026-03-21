# Claude Meter — Product Requirements Document (PRD)

## 1. Overview

**Claude Meter** is a lightweight CLI tool that analyzes local Claude Code logs and provides clear, actionable insights into token usage and estimated cost.

It focuses on:

* Simplicity
* Speed
* Local-first execution
* Zero setup beyond install

The tool helps developers answer:

* How many tokens did I use today / this month?
* What portion was fresh vs cached?
* What would this cost under Claude Opus pricing?
* Is my usage normal or exploding due to cache?

---

## 2. Problem Statement

Claude Code users lack:

* Historical token visibility
* Clear breakdown of usage (input vs output vs cache)
* Cost estimation for API-equivalent usage
* Easy CLI-based reporting

Current solutions are:

* Limited (`/stats`, `/usage`)
* Not historical
* Not detailed
* Not exportable

Users resort to:

* Manual log parsing
* Scripts
* Third-party tools

This creates friction and confusion.

---

## 3. Goals

### Primary Goals

* Provide **accurate local usage insights**
* Enable **time-based queries** (today, week, month, range)
* Show **token breakdown clearly**
* Estimate **cost using Claude pricing**
* Output **clean human-readable + JSON formats**

### Secondary Goals

* Be extremely fast (<2s typical run)
* Work cross-platform (Windows, macOS, Linux)
* Require zero config for basic usage

---

## 4. Non-Goals

* No cloud syncing
* No dashboards or UI
* No authentication
* No real-time streaming (v1)
* No billing integration

---

## 5. Target Users

### Primary

* Developers using Claude Code CLI daily
* AI power users tracking usage

### Secondary

* Teams estimating API costs
* Builders creating agent workflows

---

## 6. Core Features

## 6.1 Command Interface

```bash
claude-meter today
claude-meter week
claude-meter month
claude-meter last30
claude-meter range <start> <end>
claude-meter all
```

---

## 6.2 Output Types

### Default (human-readable)

* Clean formatted summary
* Token breakdown
* Cost estimate
* Clear labeling

### JSON Output

```bash
claude-meter last30 --json
```

Returns structured data:

* period
* totals
* pricing assumptions
* cost estimate

---

## 6.3 Token Breakdown

Each report must include:

* input_tokens
* output_tokens
* cache_read_input_tokens
* cache_creation_input_tokens
* fresh_total_tokens
* full_total_tokens

---

## 6.4 Cost Estimation

Based on Claude Opus pricing:

* Input cost
* Output cost
* Cache read cost
* Cache creation cost (5m + 1h estimate)

Outputs:

* Lower estimate (5m cache)
* Upper estimate (1h cache)

---

## 6.5 Filtering by Time

Supported ranges:

* today
* last 7 days
* last 30 days
* custom date range

Uses:

* timestamp field from JSON logs
* not file modification time

---

## 6.6 File Discovery

Search paths:

* `~/.claude/projects/`
* `~/.config/claude/projects/`

Features:

* Recursive scan
* Cross-platform path handling

---

## 6.7 Safety + Error Handling

* Skip invalid JSON lines
* Ignore malformed entries
* Continue on errors
* Provide `doctor` command

---

## 6.8 Diagnostic Commands

```bash
claude-meter doctor
claude-meter paths
```

Outputs:

* detected paths
* number of files
* sanity checks

---

## 7. CLI Flags

### Core Flags

* `--json` → structured output
* `--fresh` → input + output only
* `--full` → include cache (default)

### Optional (future)

* `--by day`
* `--by project`
* `--csv`

---

## 8. Data Processing Flow

1. Locate log directories

2. Find all `.jsonl` files

3. Stream files line-by-line

4. Parse JSON safely

5. Filter:

   * `type == "assistant"`
   * has `usage`
   * valid timestamp

6. Convert timestamps

7. Filter by range

8. Aggregate token fields

9. Compute totals

10. Estimate cost

11. Format output

---

## 9. Performance Requirements

* Must handle:

  * 100k+ log entries
  * 1000+ files

* Execution time target:

  * <2 seconds typical
  * <5 seconds worst case

* Memory:

  * streaming only (no full file load)

---

## 10. Output Example

### CLI Output

```bash
Claude Meter — Last 30 Days

Entries:            106,461
Input Tokens:       5,896,108
Output Tokens:      11,598,636
Fresh Total:        17,494,744

Cache Read:         8,266,956,710
Cache Created:      483,414,090
Full Total:         8,767,865,544

Estimated Cost:
- Input:            $29.48
- Output:           $289.96
- Cache Read:       $4,133.47
- Cache Create:     $3,021 – $4,834

Total Estimate:
$7,474 – $9,287
```

---

## 11. Risks & Edge Cases

### 11.1 Cache Inflation

* Large cache_read tokens can distort totals
* Must clearly separate fresh vs full

---

### 11.2 Duplicate Entries

* Logs may contain repeated entries
* v1: accept raw totals
* v2: optional deduplication

---

### 11.3 Missing Fields

* Some entries may lack usage fields
* Must default to zero

---

### 11.4 Timestamp Issues

* Invalid or missing timestamps
* Must skip safely

---

## 12. Future Enhancements (v2+)

* Daily breakdown charts
* Per-project analysis
* Deduplication engine
* Watch mode (`--live`)
* Export to CSV
* Config file support
* Cost models for other Claude variants

---

## 13. Success Metrics

* CLI execution < 2 seconds
* Accurate aggregation (±1% error tolerance)
* Clear output readability
* Adoption (GitHub stars, npm installs)

---

## 14. Key Design Principles

* Minimal friction
* Clear numbers
* Honest estimates (no fake precision)
* Local-first
* Developer-friendly

---

## 15. Final Definition of Done

Claude Meter is complete when a user can:

* Install globally
* Run a single command
* Instantly see:

  * usage breakdown
  * cost estimate
  * time-based report

Without needing documentation.

---

## 16. Key Question for Iteration

> Are users optimizing for **understanding usage**, or **reducing cost**?

This will guide:

* future features
* reporting formats
* default views

---
