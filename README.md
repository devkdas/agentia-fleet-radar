# Agentia Fleet Radar

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-blue.svg)](package.json)
[![Agentia 0.122](https://img.shields.io/badge/agentia-0.122.0--alpha.1-blue.svg)](https://developer.copado.com/docs)

**Fleet Radar** checks readiness across org contexts and correlates
failures into escalate versus fix locally verdicts, with an incident
triage command fusing story state, test evidence, blast radius and an
AI root cause.

Isolated or systemic, answered in one run. Built for the **Agentia
Headless Virtual Hackathon** as an oclif plugin on top of the public
`agentia` CLI.

---

## Table of Contents

- [The Problem](#the-problem)
- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Live Demo Workflow](#live-demo-workflow)
- [Command Reference](#command-reference)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [How It Works](#how-it-works)
- [Security](#security)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Hackathon Fit](#hackathon-fit)
- [License](#license)

---

## The Problem

Teams running multiple orgs cannot tell whether a failure is isolated
to one org or systemic across all of them. Each org gets debugged
separately by hand, so fleet wide outages waste hours of duplicated
triage while the common cause sits in plain sight across the individual
reports.

## Features

- **Per org contexts** — repeatable `--dir` flags, each holding one
  org's project setup, checked independently like a CI matrix.
- **Readiness trio** — CICD, CRT and AI auth evaluated per org from
  live state.
- **Correlation engine** — same check failing in two or more orgs
  becomes fleet wide escalate, single org failures stay fix locally.
- **Plain webhook alerts** — fleet wide detections post text alerts,
  zero hosted infrastructure.
- **Opt-in AI suggestion** — `--ai-suggest` asks the plan agent about
  correlated failures. Off by default, null safe.
- **Dual output** — human verdicts plus `--json` fleet document.
- **Zero private imports** — only shells out to public `agentia`
  commands.

## Installation

### Prerequisites

- Node 18 or newer.
- Agentia CLI beta: `npm install -g @copado/agentia-cli@beta`
- One project directory per org context.

### Install from source

```sh
git clone https://github.com/devkdas/agentia-fleet-radar.git
cd agentia-fleet-radar
npm install
npm run build
agentia plugins link .
```

Re-run `npm run build` after every change to the TypeScript files.

## Quick Start

### 1. Check two contexts

```sh
agentia fleet check --dir ./proj-a --dir ./proj-b --label A --label B
```

### 2. Alert plus JSON verdict

```sh
agentia fleet check --dir ./proj-a --dir ./proj-b --slack-webhook https://hooks.slack.com/xxx --json
```

### 3. Add the AI suggestion

```sh
agentia fleet check --dir ./proj-a --dir ./proj-b --ai-suggest --json
```

### 4. Triage a production incident

```sh
agentia fleet incident --dir ./proj-a --dir ./proj-b --story US-0000024 --job 120561 --crt-project 76303
```

## Live Demo Workflow

Verified live:

```text
1. Real dir plus bogus dir -> isolated verdict naming the failing org
2. Two bogus dirs -> fleet-wide verdict correlating the same check
3. Healthy dirs -> fleet healthy with zero failing checks
```

## Command Reference

### `agentia fleet check`

| Flag | Description |
|---|---|
| `-d, --dir <path>` | Org context directory, repeatable (required) |
| `-l, --label <name>` | Display label per dir, repeatable |
| `--slack-webhook <url>` | Webhook URL for fleet wide alerts, optional |
| `--ai-suggest` | Plan agent fix suggestion, off by default |
| `-j, --json` | Machine readable JSON fleet document |

### `agentia fleet notify`

| Flag | Description |
|---|---|
| `-d, --dir <path>` | Org context directory, repeatable (required) |
| `-l, --label <name>` | Display label per dir, repeatable |
| `-w, --webhook <url>` | Webhook URL receiving the digest (required) |
| `--json` | Machine readable JSON output |

Sends a formatted fleet status digest in plain text with zero AI
involvement. Deterministic wording every run, delivery confirmed by
HTTP status with graceful failure that still prints the digest.

### `agentia fleet trends`

| Flag | Description |
|---|---|
| `-l, --ledger <path>` | History ledger file (defaults to the check ledger) |
| `-w, --weeks <n>` | Weeks of history analyzed (default 4, 1 to 26) |
| `--json` | Machine readable JSON output |

Reads the local history ledger appended by `fleet check --record` and
reports per week failure counts plus improving, worsening or flat
direction. Empty ledger reports honestly instead of inventing history.

### `agentia fleet ledger`

| Flag | Description |
|---|---|
| `-j, --json` | Machine readable JSON lines array |

Reads the local history ledger. Entries are appended by `fleet check
--record`. No delete path exists by design.

Fleet wide means the same check failing in two or more orgs. Alerts
fire only on fleet wide verdicts.

### `agentia fleet incident`

| Flag | Description |
|---|---|
| `-d, --dir <path>` | Org context directory, repeatable (required) |
| `-l, --label <name>` | Display label per dir, repeatable |
| `-s, --story <id>` | Story under incident for state context |
| `-j, --job <id>` | CRT job ID for test evidence, repeatable |
| `--crt-project <id>` | CRT project ID used with job IDs |
| `--graph-type/--graph-name` | Member for blast radius lookup |
| `--graph-credential-id/--graph-org-id/--graph-pipeline-id` | Blast scope IDs |
| `--ai-diagnose` | Operate agent root cause, off by default |
| `--json` | Machine readable triage document |

## Configuration

Directories plus flags only. Labels default to org-1, org-2 in flag
order. No files written, no state kept between runs.

## Troubleshooting

| Problem | Likely cause | Fix |
|---|---|---|
| All orgs unreachable | Wrong directory paths | Point each dir at a real project checkout |
| Everything passes unexpectedly | Shared global auth | Give contexts distinct project auth to diverge |
| AI suggestion null | Agent unreachable | Verdicts still stand, retry later |
| ESM auto-transpile warning | Linked ESM plugin notice | Benign, compiled output is used |

## How It Works

```text
agentia fleet check
  -> auth get --json per directory (independent contexts)
  -> readiness trio evaluated per org
  -> same failures counted across the fleet
  -> escalate vs local verdicts
  -> webhook text on fleet wide (optional)
  -> plan agent suggestion (opt-in, null safe)
```

## Security

Read operations only. No org writes, no tokens printed. Webhook URLs
stay in flags, never in files.

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript on Node 18+ |
| CLI Framework | oclif v4 (ESM, matching the host CLI) |
| Runtime calls | `node:child_process` to public `agentia` commands |
| HTTP | Global `fetch` for the optional webhook, no extra deps |

## Architecture

```text
Release manager / Agent
       |
agentia fleet check --dir ... [--slack-webhook] [--ai-suggest]
       |
Fleet Radar (this plugin)
  |- checker   -> auth state per directory
  |- correlator -> same failures counted fleet wide
  |- alerter   -> webhook text on fleet wide
  |- advisor   -> plan agent (opt-in)
       |
Verdicts plus JSON fleet document
```

## Hackathon Fit

Fills the observability corner no other entry covers, reusing proven
readiness plus ask patterns with zero hosted infrastructure. Escalate
versus local is the verdict multi org teams actually need.

## License

MIT License — see [LICENSE](LICENSE) for details.
