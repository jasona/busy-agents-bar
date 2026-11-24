# BUSY Agents Bar

![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-zero-blue)
![BUSY Bar API](https://img.shields.io/badge/BUSY%20Bar%20API-24.3%2B-orange)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

A standalone, zero-dependency Node.js daemon that monitors local AI coding agent sessions in real time and drives a USB-connected [**BUSY Bar**](https://busy.app/products/busy-bar) (`72 × 16` front RGB LED matrix) so you can tell at a glance which agents are running, waiting on your input, errored, or finished.

Built for **Antigravity** out of the box (transcript + swarm telemetry), with a lightweight webhook/provider extensibility layer for Claude Code, Codex, CI runners, or custom tools.

---

## Visual Display Modes (`72 × 16` Front RGB)

While active (`running`, `waiting`, or `error`), the daemon auto-rotates between **Fleet** and **Spotlight** views every 5 seconds (configurable), snaps immediately back to **Fleet** when an urgent approval/error arrives, and stays calm in **Fleet** for `ALL DONE`:

1. **Fleet Overview (`fleet`)** — Gradient left status rail + stock status icon (`spinner_front_8x8.anim`, `hourglass_5x5.image`, `error_front_8x8.image`, `checkmark_front_8x8.image`) + primary count (`2 RUN`, `1 WAIT`, `1 ERR`) + native on-device `time_since` timer (`mm:ss`, RTC-aligned via `GET /api/time`) + gradient bottom pips colored by phase & provider:
   - **Antigravity (`AGY`)**: Cyan `#00D4FF`
   - **Claude Code (`CLD`)**: Coral `#FF7A45`
   - **Codex / ChatGPT (`CDX`)**: Violet `#C084FC`
   - **Waiting Urgency Escalation**: Unanswered `waiting` sessions warm from amber (`<2m`) → deep orange (`>=2m`) → hot red-magenta (`>=5m`).

```text
+------------------------------------------------------------------------+
| [##] (*) 2 RUN                                                 02:05   |  <- gradient bar + spinner + timer
|                                                                        |
| [################>] [################>]                                |  <- status->provider gradient pips
+------------------------------------------------------------------------+
```

2. **Live Spotlight (`spotlight`)** — 2-row live inspector showing `[TAG] [project]` + badge (`SWM 2/4`, `APPR`, or `1/3` pager) on row 1, scrolling live activity (`Edit renderer.mjs`, `Approve Bash: git push`, thinking heading) on row 2, and bright/dimmed pager pips along the bottom.

```text
+------------------------------------------------------------------------+
| [##] AGY  busy-bar                                           SWM 2/4   |  <- provider tag + project + swarm/pager
| [##] Edit renderer.mjs                                                 |  <- scrolling live tool / prompt activity
| [################>] [................]                                 |  <- active pip highlighted
+------------------------------------------------------------------------+
```

3. **Fleet Pulse (`pulse`)** — Per-provider counts (`AGY:2 CLD:1 CDX:1`) + daily completed count (`4D` or `MUTE` when chimes are muted) over a full-width `72 × 7` proportional segmented gradient bar.

| Phase | Priority | Left Accent & Text | Right Side | LED Blink (Configurable) | Audio Chime (Configurable) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`error`** | Highest | Red gradient · `<N> ERR` | `<M>W` / `<M>R` or project/tag | `#FF0000FF` (red) | `shared/calendar_event_starts.snd` |
| **`waiting`** | 2nd | Escalating amber->red · `<N> WAIT` | `<M>R` or live `time_since` wait timer | `#FFAA00FF` (amber) | `shared/calendar_event_starts.snd` |
| **`running`** | 3rd | Green->cyan gradient + spinner · `<N> RUN` | `<M> OK` or live `time_since` turn timer | Off | None |
| **`all_done`** | 4th | Teal gradient + checkmark · `ALL DONE` | `x<N>` count; stays on until cleared | `#00FFAAFF` (teal) | `shared/volume_change.snd` |
| **`cleared`** | Lowest | Releases screen (`DELETE /api/display/draw`) unless `pulse` is pinned | — | Off | None |

---

## Features

- **Real-Time Multi-Agent Telemetry**: Watches `~/.gemini/*/brain/` transcripts (`transcript.jsonl`) and swarms (`members.json`, `board.jsonl`, `view.json`), plus Claude Code & Codex hooks with exact `tool_input` targets (`Edit foo.mjs`, `Run npm test`) and per-turn elapsed timers (`turnStartedAtMs`).
- **Auto-Rotating View Carousel & Live Timers**: Cycles `fleet` ↔ active `spotlight` sessions automatically on the `72 × 16` front RGB matrix while aligning hardware `CountdownElement` (`time_since`) timers to the BUSY Bar's RTC (`GET /api/time`).
- **Stay On Until Cleared + Daily Stats**: `ALL DONE` remains latched until cleared; completed/error tallies persist per local calendar day in `state.json`.
- **Multi-Button Hardware Controls (`/api/status/ws`)**: Zero-dependency `BSB_State.State` protobuf decoder distinguishes `short_press` and `long_press` (`>= 700ms`) across **`OK`**, **`BACK`**, and **`START`** with crisp bordered confirmation toasts (`CHIME OFF`, `BLINK ON`, `DISMISSED`, `AUTO MODE`).
- **Independent Alert Controls**: Enable or disable LED blinking (`led_notification_color`) and speaker chimes (`/api/audio/play`) via config file, env vars, CLI flags, HTTP `POST /alerts`, or the `START` button.
- **Flicker-Free Smart Redraws & USB Resilience**: Only clears prior canvas elements when switching views, phases, or removing IDs so animations and timers stay smooth, and automatically re-syncs after USB reconnects.
- **Extensible Provider Architecture**: Push events from any CLI hook (`busy-bar emit` or `POST /hooks/:provider`), register native payload adapters (`registerHookAdapter`), or load custom ESM provider modules (`providers.customModules`).

---

## Requirements

- **Node.js `>= 20.0.0`** (tested on Node `v26.13.1`, zero npm packages required)
- **BUSY Bar** plugged in via USB virtual LAN (`http://10.0.4.20`, Firmware `1.0.2` / HTTP API `24.3.0+`) or reachable on your LAN

> **Implementation note:** `BusyBarClient` uses Node's built-in `node:http` / `node:https` transport rather than global `fetch()` (`undici`), because the BUSY Bar's embedded HTTP server triggers `UND_ERR_RES_CONTENT_LENGTH_MISMATCH` under `undici`.

---

## Quick Start

```bash
git clone https://github.com/jasona/busy-agents-bar.git
cd busy-agents-bar

# 1. Preview rendered 72x16 JSON + ASCII layout without touching hardware
node ./bin/busy-bar.mjs test-screen mixed --dry-run

# 2. Inspect live Antigravity sessions detected on this machine
node ./bin/busy-bar.mjs status --once

# 3. Push your current live status once to the BUSY Bar
node ./bin/busy-bar.mjs sync-once

# 4. Run the daemon in the foreground
npm start
```

### Run as a `systemd --user` service (Linux)

```bash
node ./bin/busy-bar.mjs install-service
systemctl --user daemon-reload
systemctl --user enable --now busy-bar.service
systemctl --user status busy-bar.service
```

### Install Provider Hooks (Claude Code, Codex / ChatGPT, Antigravity)

Built-in native hook adapters and idempotent installers ship for **Claude Code** (`~/.claude/settings.json`), **OpenAI Codex / ChatGPT** (`~/.codex/hooks.json`), and **Antigravity** (`~/.gemini/config/hooks.json`). All existing user hooks and settings are preserved untouched:

```bash
# Preview the merged hook changes for all supported agents
node ./bin/busy-bar.mjs install-hooks all --dry-run

# Install Claude Code and Codex/ChatGPT hooks (or use "all" to include Antigravity)
node ./bin/busy-bar.mjs install-hooks claude codex

# Remove only busy-bar's managed hooks cleanly
node ./bin/busy-bar.mjs install-hooks all --uninstall
```

- **Claude Code (`~/.claude/settings.json`)**: Hooks `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Notification` (`permission_prompt`, `elicitation_dialog`, errors; ignores `idle_prompt`), `Stop`, and `SessionEnd` via `busy-bar hook claude`.
- **Codex / ChatGPT (`~/.codex/hooks.json`)**: Hooks `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`, `Interrupt`, and `SessionEnd` via `busy-bar hook codex` (also supports legacy Codex `notify` `agent-turn-complete` payloads). Note that Codex prompts or records hook trust under `[hooks.state]` in `~/.codex/config.toml` the first time you run a session with new hooks.
- **Antigravity (`~/.gemini/config/hooks.json`)**: Adds `"busy-bar-stop"` to auto-dismiss turns when `Stop` fires with `"terminationReason": "USER_CANCELED"`.

---

## Physical Controls & Multi-Button Gestures

With `controls.multiButton: true` (default), all three physical BUSY Bar buttons work interactively via WebSocket (`/api/status/ws`):

| Button | Short Press | Long Press (`>= 700ms`) |
| :--- | :--- | :--- |
| **`OK`** | Cycle `fleet` → `spotlight[0..N-1]` → `pulse` → `auto` | Snap back to `auto` carousel (`AUTO MODE` toast) |
| **`BACK`** | Dismiss only the spotlighted session (when viewing `spotlight` with `>1` sessions, `DISMISSED` toast), or full reset in `fleet`/`pulse` | Always full fleet reset |
| **`START`** | Toggle speaker chimes on/off (`CHIME ON` / `CHIME OFF` toast) | Toggle LED blink on/off (`BLINK ON` / `BLINK OFF` toast) |

CLI and HTTP reset/dismiss controls:

| Action | CLI / Endpoint | Effect |
| :--- | :--- | :--- |
| **Switch view** | `busy-bar view [auto\|fleet\|spotlight\|pulse\|next] [--index <n>]` / `POST /view` | Pin a display view or return to auto-rotation. |
| **Clear done** | `busy-bar clear` / `POST /clear` | Clears `done` completions (`clearedAtMs = now`), leaving active `running` / `waiting` / `error` sessions visible. |
| **Dismiss one** | `busy-bar dismiss --session <id>` / `POST /dismiss` | Suppresses one specific session until its `updatedAtMs` advances. |
| **Full reset** | `busy-bar reset` / `POST /reset` | Dismisses **all** currently visible sessions until they receive new activity, resets view to `auto`, and releases the screen. |

Button listener notes:
- Pressing `OK`, `BACK`, or `START` while the BUSY Bar display is idle (`cleared`) is a clean no-op so navigating the BUSY Bar's own built-in menus and timer works normally.
- Set `--no-multi-button` (or `controls.multiButton: false`) to restore legacy single-button reset behavior (`--reset-button <back|ok|start|none>`).
- Test live raw button events and `short_press`/`long_press` gestures in your terminal with `node ./bin/busy-bar.mjs watch-buttons`.

---

## CLI Reference

```text
busy-bar daemon [--config <path>] [--no-blink] [--no-chime] [--no-buttons] [--no-multi-button] [--no-carousel] [--no-animations] [--no-timers] [--reset-button <back|ok|start|none>] [--port <n>] [--url <url>] [--token <token>]
busy-bar status [--once]
busy-bar view [auto|fleet|spotlight|pulse|next] [--index <n>]
busy-bar clear
busy-bar reset
busy-bar dismiss --session <id> [--provider <name>]
busy-bar sync-once [--no-blink]
busy-bar emit --provider <name> --session <id> --status <running|waiting|error|done|idle> [options]
busy-bar test-screen [running|waiting|error|all_done|mixed|swarm] [--view <fleet|spotlight|pulse>] [--dry-run] [--no-blink] [--no-animations] [--no-timers]
busy-bar test-chime [waiting|error|all_done]
busy-bar sounds
busy-bar alerts [--blink on|off] [--chime on|off]
busy-bar watch-buttons
busy-bar hook <claude|codex|chatgpt|antigravity> [--event <name>]
busy-bar install-hooks [all|antigravity|claude|codex|chatgpt ...] [--dry-run] [--uninstall]
busy-bar install-service [--dry-run]
busy-bar install-hook [--dry-run] [--uninstall]
```

| Flag | Description |
| :--- | :--- |
| `--config <path>` | Path to custom JSON config file (default `~/.config/busy-bar/config.json`) |
| `--url <url>` | Override BUSY Bar base URL (default `http://10.0.4.20`) |
| `--token <token>` | Optional API token for Wi-Fi (`X-API-Token`) or cloud (`Authorization: Bearer`) access |
| `--port <n>` | Override loopback control server port (default `4388`) |
| `--no-blink` / `--blink` | Disable or enable LED notification blinking |
| `--no-chime` / `--chime` | Disable or enable audio chimes |
| `--no-buttons` / `--buttons` | Disable or enable the WebSocket hardware button watcher |
| `--no-multi-button` | Restore legacy single-button reset mode instead of multi-button gestures |
| `--no-carousel` | Keep front display pinned on `fleet` instead of rotating with `spotlight` |
| `--no-animations` | Disable stock status icons/spinner on the front screen |
| `--no-timers` | Show scrolling project name instead of live hardware `CountdownElement` timers |
| `--reset-button <key>` | Legacy reset button when multi-button mode is off: `back` (default), `ok`, `start`, or `none` |
| `--attention <kind>` | For `emit`: `approval`, `question`, `error`, `quota`, or `stuck` |
| `--project`, `--title`, `--activity`, `--ttl` | Optional metadata and TTL (ms) for `emit` |

---

## Loopback HTTP Control API

While running, the daemon exposes a loopback-only HTTP server at `http://127.0.0.1:4388`:

| Method & Path | Description |
| :--- | :--- |
| `GET /health` | Liveness + device connection state, current `phase`, and `uptimeSec` |
| `GET /status` | Full snapshot, active `view`, `dailyStats`, provider health, alert config, input watcher status, and last draw result |
| `POST /view` | Switch front view (`{"mode":"auto"\|"fleet"\|"spotlight"\|"pulse"\|"next","index":0}`) |
| `POST /clear` | Clears `done` sessions and persists `clearedAtMs` |
| `POST /reset` | Dismisses all currently visible sessions until new activity and clears the display |
| `POST /dismiss` | Dismisses a single session (`{"provider":"antigravity","sessionId":"<id>"}`) |
| `POST /alerts` | Runtime alert toggle (`{"blink":true,"chime":false}` or nested `alerts` patch) |
| `POST /hooks/:provider` | Ingests a session event from an external hook/tool |
| `DELETE /hooks/:provider/:sessionId` | Removes a hook session and triggers an immediate redraw |

Examples:

```bash
# Disable chimes while keeping LED blinking active
node ./bin/busy-bar.mjs alerts --chime off --blink on

# Or via curl
curl -X POST http://127.0.0.1:4388/alerts \
  -H 'Content-Type: application/json' \
  -d '{"blink":true,"chime":false}'

# Reset stuck sessions over HTTP
curl -X POST http://127.0.0.1:4388/reset
```

---

## Configuration

Copy [`config.example.json`](./config.example.json) to `~/.config/busy-bar/config.json` and customize any section (all fields are deep-merged with defaults):

```json
{
  "device": {
    "baseUrl": "http://10.0.4.20",
    "apiToken": null,
    "applicationName": "agent-status",
    "priority": 50,
    "urgentPriority": 95,
    "urgentOverrideTimer": false,
    "timeoutMs": 3000
  },
  "daemon": {
    "pollIntervalMs": 1000,
    "healthIntervalMs": 5000,
    "controlHost": "127.0.0.1",
    "controlPort": 4388,
    "stateFile": "~/.config/busy-bar/state.json"
  },
  "display": {
    "stayOnUntilCleared": true,
    "clearBehavior": "release",
    "clearOnShutdown": true,
    "showProjectName": true,
    "animations": true,
    "showTimers": true,
    "providerColors": true,
    "carousel": {
      "enabled": true,
      "intervalMs": 5000,
      "modes": ["fleet", "spotlight"]
    },
    "urgencyEscalation": {
      "enabled": true,
      "elevatedAfterMs": 120000,
      "criticalAfterMs": 300000
    }
  },
  "alerts": {
    "blink": {
      "enabled": true,
      "onWaiting": true,
      "onError": true,
      "onAllDone": true,
      "colors": {
        "waiting": "#FFAA00FF",
        "error": "#FF0000FF",
        "allDone": "#00FFAAFF"
      }
    },
    "chime": {
      "enabled": true,
      "onWaiting": true,
      "onError": true,
      "onAllDone": true,
      "cooldownMs": 15000,
      "volume": null,
      "sounds": {
        "waiting": { "stockPath": "shared/calendar_event_starts.snd" },
        "error": { "stockPath": "shared/calendar_event_starts.snd" },
        "allDone": { "stockPath": "shared/volume_change.snd" }
      }
    }
  },
  "providers": {
    "antigravity": {
      "enabled": true,
      "stuckAfterMs": 600000,
      "staleAfterMs": 21600000,
      "recentDoneWindowMs": 900000,
      "appDataDirs": null,
      "projectsDir": null
    },
    "hooks": {
      "enabled": true,
      "defaultTtlMs": 3600000
    },
    "customModules": []
  },
  "controls": {
    "wsInputEnabled": true,
    "multiButton": true,
    "longPressMs": 700,
    "resetButton": "back",
    "resetAction": "press",
    "reconnectDelayMs": 3000,
    "debounceMs": 500
  }
}
```

### Environment Variable Overrides

| Variable | Effect |
| :--- | :--- |
| `BUSY_BAR_CONFIG` | Config JSON path |
| `BUSY_BAR_URL` | BUSY Bar base URL |
| `BUSY_BAR_TOKEN` | Optional Wi-Fi / cloud API token |
| `BUSY_BAR_PORT` | Loopback HTTP control port |
| `BUSY_BAR_BLINK` | `true` / `false` |
| `BUSY_BAR_CHIME` | `true` / `false` |
| `BUSY_BAR_WS_INPUT` | `true` / `false` |
| `BUSY_BAR_MULTI_BUTTON` | `true` / `false` |
| `BUSY_BAR_CAROUSEL` | `true` / `false` |
| `BUSY_BAR_ANIMATIONS` | `true` / `false` |
| `BUSY_BAR_TIMERS` | `true` / `false` |
| `BUSY_BAR_RESET_BUTTON` | `back`, `ok`, or `start` |

---

## Extending with New Providers & Hooks

### Option 1: Push events from CLI hooks (`busy-bar emit` or `POST /hooks/:provider`)

Any coding agent, build script, or webhook can report status directly into the running daemon:

```bash
# Mark a Claude Code session as running
busy-bar emit --provider claude-code --session cc-1 --project api --status running

# Mark it as waiting for approval
busy-bar emit --provider claude-code --session cc-1 --project api --status waiting --attention approval

# Mark it done
busy-bar emit --provider claude-code --session cc-1 --project api --status done
```

Or via HTTP:

```bash
curl -X POST http://127.0.0.1:4388/hooks/claude-code \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"cc-1","project":"api","status":"waiting","attentionKind":"approval"}'
```

### Option 2: Register a native payload adapter

Use `registerHookAdapter(providerName, transformFn)` in [`src/providers/webhook-provider.mjs`](./src/providers/webhook-provider.mjs) to translate native payloads from another tool straight into `{ session, ttlMs }`:

```js
import { registerHookAdapter } from './src/providers/webhook-provider.mjs';

registerHookAdapter('claude-code', (provider, payload, now) => ({
  session: {
    id: payload.session_id,
    provider,
    project: payload.cwd?.split('/').pop() || 'general',
    status: payload.hook_event_name === 'Notification' ? 'waiting' : 'running',
    attentionKind: payload.hook_event_name === 'Notification' ? 'approval' : null,
    updatedAtMs: now,
  },
}));
```

### Option 3: Load a custom ESM provider module

Add paths to `providers.customModules` in `~/.config/busy-bar/config.json` exporting `createProvider(config, ctx)`:

```js
// ~/.config/busy-bar/my-provider.mjs
export function createProvider(config, ctx) {
  return {
    id: 'my-agent',
    label: 'My Agent',
    async start({ emitChange }) {
      // Optional: attach fs.watch / WebSocket and call emitChange() on state changes
    },
    async poll(now) {
      return [
        {
          id: 'job-1',
          project: 'my-repo',
          title: 'Background job',
          status: 'running', // 'running' | 'waiting' | 'error' | 'done' | 'idle'
          updatedAtMs: now,
        },
      ];
    },
    async stop() {},
  };
}
```

---

## Architecture

```text
busy-agents-bar/
├── bin/busy-bar.mjs                     # CLI entrypoint (daemon, status, clear, reset, emit, hooks, diagnostics)
├── config.example.json                  # Full reference configuration
├── systemd/busy-bar.service             # systemd --user service template
├── src/
│   ├── alerts.mjs                       # Independent blink + chime policy engine & cooldowns
│   ├── config.mjs                       # Config loader (defaults -> JSON -> env -> CLI flags)
│   ├── control-server.mjs               # Loopback HTTP API & hook ingress server
│   ├── daemon.mjs                       # Poll loop, state persistence, diff redraws, reconnect recovery
│   ├── model.mjs                        # Canonical AgentSession normalization, dismissal, snapshots, transitions
│   ├── busybar/
│   │   ├── client.mjs                   # node:http/https BUSY Bar API 24.3.0 client
│   │   ├── renderer.mjs                 # 72x16 front RGB layout builder + ASCII validator
│   │   └── ws-input.mjs                 # Zero-dependency protobuf decoder & /api/status/ws button watcher
│   └── providers/
│       ├── index.mjs                    # Registry factory from config
│       ├── registry.mjs                 # Multi-provider polling, error isolation, custom ESM module loader
│       ├── webhook-provider.mjs         # Push-based HookProvider + adapter registry
│       ├── hooks-install.mjs            # Idempotent hook installers for Claude Code, Codex, Antigravity
│       ├── adapters/
│       │   ├── index.mjs                # Built-in adapter registration
│       │   ├── generic.mjs              # Generic normalized payload adapter
│       │   ├── claude-code.mjs          # Claude Code hook payload adapter
│       │   └── codex.mjs                # OpenAI Codex / ChatGPT hook payload adapter
│       └── antigravity/
│           ├── discovery.mjs            # Brain directory & workspace project discovery
│           ├── index.mjs                # AntigravityProvider (fs.watch + polling)
│           ├── swarm.mjs                # Swarm roster/board/view parser & worker deduplication
│           └── transcript.mjs           # Cached JSONL transcript state analyzer
└── test/                                # node:test unit & end-to-end suites
    ├── adapters.test.mjs
    ├── alerts.test.mjs
    ├── antigravity.test.mjs
    ├── daemon.test.mjs
    ├── hooks-install.test.mjs
    ├── model.test.mjs
    ├── providers.test.mjs
    ├── renderer.test.mjs
    └── ws-input.test.mjs
```

---

## Development & Testing

```bash
npm test
```

All tests use Node's built-in `node:test` runner and `node:assert/strict` with temporary filesystem fixtures and local mock HTTP/WebSocket servers.

---

## License

[MIT](./LICENSE) © 2026 Jason Alexander
