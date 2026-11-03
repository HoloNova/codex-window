# Codex Window

[简体中文](README.zh-CN.md)

A small, unofficial **TypeScript + Node.js** subscription-window scheduler with a terminal UI.

**Sign in → check real usage → wait → send one `hello` only when eligible → show local results.**

It does not reset an active window or increase your allowance. Requests can consume quota. Subscription endpoints are not a stable public API and may change. This is not an OpenAI product.

## Run

### Portable packages

The packaging workflow builds **Windows x64** and **Linux x64** packages with Node included; users do not need Node/npm. Until a release is published, successful CI runs expose the packages as Actions artifacts.

- **Windows 10/11 desktop:** extract the whole package, run `CodexWindow.exe`, then use the tray's **Open TUI** / **Exit application**. Keep `codex-window-core.exe` beside the launcher. Closing the panel does not stop the backend. Preview binaries are unsigned; do not disable security software to run them.
- **Linux (glibc, e.g. Ubuntu 22.04+):** extract into a dedicated folder, then `chmod +x codex-window && ./codex-window`. No system service or automatic startup is installed.
- No official macOS, ARM or Alpine/musl binary support in this preview. Source is not deliberately blocked, but those targets are unverified.

The workflow builds artifacts and checksums, **not GitHub Releases**. Windows compilation/interaction and cross-platform CI must pass before calling the packages verified. See [distribution details](docs/DISTRIBUTION.md).

### From source

Requires **Node.js 24+**. Runtime code uses only Node's standard library; build tools are development dependencies.

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js
```

`npm start` is equivalent but retains an extra npm process. Do not globally install over an older command or run two schedulers against the same real account, including Pi/Rust/other tools. This application never reads their credentials or replaces their services.

If an older backend is already running, close its panel and use its `stop` command once, wait for it to exit, then reopen the new version. This pauses accounts; credentials and pending outcomes remain. No live backend replacement is attempted.

## First use and controls

Use **L → sign in**, **M → select a main five-hour allowance model**, then **R → enable**. Device authorization requires the account to allow device-code login; browser authorization needs a desktop session.

| Key | Action |
| --- | --- |
| A | Switch/add accounts; switching reads local cache only |
| L | Sign in; pauses this account, saves by real identity |
| M | Select model; five-minute per-account in-memory catalog cache |
| S | Edit settings, sync switch, and global interface language |
| C | Request a read-only usage check |
| R | Review a pending outcome, enable this account, then check usage |
| I / F2 | Pause this account; read-only checks continue |
| X | **Pause all accounts and stop the backend** |
| D | Scroll session logs; no account changes |
| Esc | Return one step; discard the current edit/wait |
| Ctrl+C twice | Close only the panel; confirm within 3 seconds |

The rounded-card layout adapts to width and scrolls vertically; there is no minimum-size lockout. Recent events preview three lines. The detailed log is a bounded panel-session view (up to 1000 entries, initially up to eight cached events), **not a complete persistent journal**. Search and full cross-session history are deferred.

**English is the default**, independent of time zone/system locale. Choose English / 简体中文 under S, or use `language en|zh-CN`. Language is global, does not sync account configuration, and does not pause accounts. Opening S is read-only; saving changed business settings pauses affected accounts. L/M still pause the current account. New messages can display in either language; older Chinese history is not rewritten.

Quota is expressed as remaining percentage, with green/yellow/red and text labels; stale data is explicitly marked. `NO_COLOR=1` disables colors. Toasts have no border and expire after three seconds; the first Ctrl+C produces a red confirmation. UI/terminal interactions are manually tested, never automated.

## Accounts, configuration and safety

- One backend process, independent per-account tasks. Slow or damaged accounts do not block healthy accounts. Real account identities are deduplicated; switching accounts does not fetch data.
- New accounts start paused. **Settings sync defaults to on**: saving model, time zone, allowed hours or interval copies those settings to all accounts. Only changed accounts pause. Credentials, usage, enable flags and pending outcomes are never copied. With sync off, only the selected account changes.
- Every account's `config.json` is the only source for its settings. Runtime results go to `state.json`, never back into configuration. Manual edits affect one account only, even if UI settings sync is on.

```json
{
  "app": "codex-window-config",
  "version": 1,
  "model": "MODEL_ID",
  "timezone": "Asia/Shanghai",
  "start": "04:30",
  "end": "19:30",
  "pollMinutes": 30,
  "enabled": false
}
```

The zone above is an example, not a fixed default. New settings use the **runtime device** zone (the server when using SSH); existing accounts keep their zone. Search the IANA list/UTC in settings. Equal start/end means all day; overnight hours work. Intervals must divide one day evenly and be 5–1440 minutes.

The backend uses due timers, file notifications and a 30-second fallback—not 250ms polling. It re-reads configuration before sending. Invalid/missing configuration blocks sending for that account and is not overwritten. Do not save the same config concurrently in an editor and UI; editor writes cannot participate in the application's locks. Prefer atomic saves.

By default, checks follow half-hour local slots. Near a reset, one check is scheduled for reset + 90 seconds. Already-active windows are left alone. Sending requires fresh, complete, consistent usage, sufficient allowance, permitted hours and an enabled account. No speculative sending or alternate-model probes.

A pending marker is saved **before** one model-specific `hello`. Unknown outcomes are not retried, including after a restart. A valid observed active window or explicit R review can clear it. Token rotation is saved before subsequent requests; ambiguous renewal requires sign-in, never replaying the old refresh token. Esc lets an already-started exchange finish saving; immediately closing a panel with double Ctrl+C can instead require sign-in again.

## Headless commands and exit

For a Linux package use `./codex-window`; from source substitute `node dist/cli.js`; on Windows use `.\codex-window-core.exe` in a terminal.

```sh
./codex-window accounts
./codex-window login --add
./codex-window config --sync-settings off
./codex-window config --model MODEL_ID
./codex-window start
./codex-window status --account ID
./codex-window language zh-CN
./codex-window pause --account ID
./codex-window quit
```

`--home PATH` / `CODEX_WINDOW_HOME` selects a dedicated data home. Account commands accept `--account ID` (default `default`); global lifecycle commands do not. `--help` lists all commands.

**`quit` / Windows Exit application:** cooperatively close this data home's panels/backend and wait for in-flight requests and credential saves; preserve enable flags and pending outcomes. Previously enabled accounts resume with fresh usage at next startup. No process is force-killed. A timed-out exit reports the problem instead of pretending success.

**`stop` / X:** pause all accounts and stop the backend. Next launch stays paused. Closing just the TUI leaves the backend running.

Proxy support uses Node's `NODE_OPTIONS=--use-env-proxy` with `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`; custom CAs use `NODE_EXTRA_CA_CERTS`. Never disable TLS verification.

## Local data

Default: `~/.codex-window-node` (`USERPROFILE` on Windows), separate from release files and other tools.

- `auth.json`: **private plaintext credentials**; never commit, share or attach them to reports. Unix uses private modes; Windows applies per-user/SYSTEM directory permissions.
- `config.json`, `state.json`: per-account settings and runtime observations/pending outcomes.
- `accounts.json`, `accounts/<hashed-id>/`: registry/sync and additional profiles. Existing default credentials stay in place.
- `preferences.json`: global display language only. Invalid display preferences warn/fall back to English without blocking the safety Stop command or overwriting the bad file.
- `application.json`, `session-*.json`, `*.lock`: application-exit coordination and local locks; do not edit them.
- `worker.log`: backend diagnostics; daily results are in state/TUI. Startup truncates it above 1 MiB.

Do not delete state to troubleshoot duplicate requests: that loses pending markers. Do not point `--home` at Pi/Codex/old Rust directories. Keep the source build or release folder while its backend runs. Detailed design: [accounts](docs/MULTI_ACCOUNT.md), [configuration/scheduling](docs/CONFIG_AND_SCHEDULING.md).

## Development and verification

```sh
npm run check
npm test
npm run package        # native target; Windows needs VS C tools + SDK developer shell
npm run check:package  # isolated executable, temporary home, no credentials or UI
npm run archive
```

Tests use temporary homes, synthetic tokens and local mock HTTP only. No automated TUI/tray tests. The Linux/Windows workflow checks source, builds portable packages, verifies the headless executable and uploads allowlisted archives/checksums. Windows tray interaction, real multiple-account flows and long-running behavior still require manual acceptance; CI configuration is not proof of a passing run. See [verification](docs/VERIFICATION.md) and [plan](docs/PLAN.md).

## License

[MIT](LICENSE). OAuth/usage formats and some scheduling rules reference [codex-switch](https://github.com/xjoker/codex-switch) and the previous Rust implementation; retained attribution is in [NOTICE.md](NOTICE.md). Portable packages also carry the matching Node runtime/third-party license in `LICENSE_NODE.txt`.
