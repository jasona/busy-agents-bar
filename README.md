# BUSY Agents Bar

![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)
![Dependencies](https://img.shields.io/badge/dependencies-zero-blue)
![BUSY Bar API](https://img.shields.io/badge/BUSY%20Bar%20API-24.3%2B-orange)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

A standalone, zero-dependency Node.js daemon that monitors local AI coding agent sessions in real time and drives a USB-connected [**BUSY Bar**](https://busy.app/products/busy-bar) (`72 × 16` front RGB LED matrix) so you can tell at a glance which agents are running, waiting on your input, errored, or finished.

Built for **Antigravity** out of the box (transcript + swarm telemetry), with a lightweight webhook/provider extensibility layer for Claude Code, Codex, CI runners, or custom tools.

---

## Visual Display Layout (`72 × 16` Front RGB)

The renderer splits the front matrix into two clean bands plus a left status accent bar:

```text
+------------------------------------------------------------------------+
| [##]  2 WAIT                                                      1R   |  <- Band 1 (y=1..9): counts / project / reason
|                                                                        |
| [################] [################] [################] [############]|  <- Band 2 (y=13..15): per-agent status pips (up to 18)
+------------------------------------------------------------------------+
```

| Phase | Priority | Left Accent & Text | Right Side | LED Blink (Configurable) | Audio Chime (Configurable) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`error`** | Highest | Red `#FF2222` · `<N> ERR` | `<M>W` / `<M>R` or project/tag | `#FF0000FF` (red) | `shared/calendar_event_starts.snd` |
| **`waiting`** | 2nd | Amber `#FFAA00` · `<N> WAIT` | `<M>R` or project / `APPR` / `ASK` / `STUCK` | `#FFAA00FF` (amber) | `shared/calendar_event_starts.snd` |
| **`running`** | 3rd | Green `#00FF55` · `<N> RUN` | `<M> OK` or active project name (auto-scrolls if long) | Off | None |
| **`all_done`** | 4th | Teal `#00DDAA` · `ALL DONE` | Centered; stays on until cleared | `#00FFAAFF` (teal) | `shared/volume_change.snd` |
| **`cleared`** | Lowest | Releases screen (`DELETE /api/display/draw`) back to default BUSY Bar clock/app | — | Off | None |

---

## Features

- **Real-Time Antigravity Telemetry**: Watches `~/.gemini/*/brain/` transcripts (`transcript.jsonl`), swarm state (`members.json`, `board.jsonl`, `view.json`), and `~/.gemini/config/projects/*.json` via `fs.watch` + fast polling. Classifies approvals, `ask_question` prompts, model/quota errors, stuck sessions (>10 min), active runs/swarms (deduplicating worker conversations into their coordinator), and completions.
- **Stay On Until Cleared**: `ALL DONE` remains latched on the screen until you acknowledge it via `busy-bar clear`, `POST /clear`, or a physical button reset.
- **Physical Button Reset (`/api/status/ws`)**: Streams hardware button events over WebSocket using a zero-dependency protobuf decoder (`BSB_State.State`). Pressing the small orange **`BACK`** button (configurable to `ok` or `start`) immediately dismisses stuck or manually canceled sessions until they receive new activity.
- **Independent Alert Controls**: Enable or disable LED blinking (`led_notification_color`) and speaker chimes (`/api/audio/play`) separately via config file, environment variables, CLI flags, or live HTTP `POST /alerts`, with per-event toggles and cooldown throttling.
- **Clean Canvas Redraws**: Clears the app's Canvas layer (`DELETE /api/display/draw?application_name=...`) before replacing an active frame so removed elements and scrolling labels never leave ghost pixels across state transitions.
- **USB Disconnect Resilience**: Automatically detects disconnects and re-pushes the current fleet state as soon as the BUSY Bar comes back online.
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

## Physical Controls & Reset Semantics

Three complementary ways to clear or reset the bar:

| Action | CLI / Endpoint / Hardware | Effect |
| :--- | :--- | :--- |
| **Clear done** | `busy-bar clear` / `POST /clear` | Clears `done` completions (`clearedAtMs = now`), leaving active `running` / `waiting` / `error` sessions visible. |
| **Dismiss one** | `busy-bar dismiss --session <id>` / `POST /dismiss` | Suppresses one specific session until its `updatedAtMs` advances. |
| **Full reset** | Orange **`BACK`** button (default) / `busy-bar reset` / `POST /reset` | Dismisses **all** currently visible sessions (including manually stopped/stuck `running` prompts) until they receive new activity, and releases the screen. |

Button listener notes:
- Pressing `BACK` when the BUSY Bar display is already idle (`cleared`) is a no-op so navigating the BUSY Bar's own built-in menus works normally.
- Change the trigger button via `--reset-button <back|ok|start|none>`, `BUSY_BAR_RESET_BUTTON`, or `controls.resetButton` in config.
- Test live hardware button events directly in your terminal with `node ./bin/busy-bar.mjs watch-buttons`.

---

## CLI Reference

```text
busy-bar daemon [--config <path>] [--no-blink] [--no-chime] [--no-buttons] [--reset-button <back|ok|start|none>] [--port <n>] [--url <url>] [--token <token>]
busy-bar status [--once]
busy-bar clear
busy-bar reset
busy-bar dismiss --session <id> [--provider <name>]
busy-bar sync-once [--no-blink]
busy-bar emit --provider <name> --session <id> --status <running|waiting|error|done|idle> [options]
busy-bar test-screen [running|waiting|error|all_done|mixed] [--dry-run] [--no-blink]
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
| `--reset-button <key>` | Button that triggers reset: `back` (default), `ok`, `start`, or `none` |
| `--attention <kind>` | For `emit`: `approval`, `question`, `error`, `quota`, or `stuck` |
| `--project`, `--title`, `--activity`, `--ttl` | Optional metadata and TTL (ms) for `emit` |

---

## Loopback HTTP Control API

While running, the daemon exposes a loopback-only HTTP server at `http://127.0.0.1:4388`:

| Method & Path | Description |
| :--- | :--- |
| `GET /health` | Liveness + device connection state, current `phase`, and `uptimeSec` |
| `GET /status` | Full snapshot, provider health, alert config, input watcher status, and last draw result |
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
    "showProjectName": true
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
