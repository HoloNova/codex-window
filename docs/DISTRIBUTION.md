# Distribution, application exit and language

## Approved targets and boundaries

- Windows x64 desktop and Linux x64/glibc. No official macOS, ARM or Alpine/musl binaries.
- One directly downloadable executable per platform, no manual extraction, installer, administrator prompt, global command replacement, service deployment, auto-update or automatic startup.
- Runtime JavaScript uses Node built-ins only. `esbuild` and Node's documented `postject` injector are **build-only** development dependencies, not runtime services.
- [Node 24 SEA](https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html) embeds one bundled CommonJS script in a copy of the matching Node executable. Source remains ESM. Snapshots/code cache are disabled: device time zone and user files are evaluated on the user's machine, not at build time.
- CI builds each binary on its own OS. This is not cross-compilation and not a rewrite into native machine code; Node's baseline memory remains.

## Windows launcher

`native/tray.c` and `native/payload.c` compile with the Windows SDK and Visual Studio C compiler, UTF-8 source and static CRT, as `CodexWindow.exe` (GUI subsystem). They use Win32/Shell APIs only. The Node SEA console core is embedded as an RCDATA resource, not shipped beside the launcher.

On startup, a short-lived data-file mapping reads the payload; it is released afterwards rather than keeping the large resource resident in the tray. The core is cached under `%LOCALAPPDATA%\CodexWindow\bin\<core-sha256>\codex-window-core.exe`. Each launch compares cached bytes with the embedded core, rejects reparse points and non-directory cache components, and uses a per-content mutex plus flushed temporary file/atomic replacement for first extraction or repair. Other versions are not overwritten or automatically removed. Persistent failures are visible, never bypassed by executing unverified cached content. Content verification is not a digital signature or protection from a compromised user account.

Explicit CLI commands (for example `CodexWindow.exe --version`, `--license`, `status` or `quit`) forward to the core without creating windows/tray icons. The core inherits the absolute original launcher path so cooperative `quit` can close its tray even when running from the cache. A failed headless extraction reports to stderr, not a GUI dialog.

`assets/icon.svg` is the shared artwork: the refresh arrow is centered on the entire icon, in front of the window. The checked-in PNG and eight-size ICO are rendered assets. SDK `rc.exe` compiles `native/tray.rc`; the linked resource supplies both the launcher's Explorer/class icon and the tray's system-small icon. No loose icon is required in the release. Static asset tests validate ICO frames, and Windows package checks confirm every frame is embedded without starting a GUI.

1. Double-click the launcher: one per-data-home tray instance immediately opens the TUI. The panel's existing startup path ensures the backend is running.
2. Double-click the launcher again or use Open TUI: reopen a closed panel or request restoring the existing console, not another tray/panel instance. Restoring/focusing is best-effort and depends on the configured terminal host.
3. Close the TUI with its normal controls: leave tray and backend running.
4. Exit application: run the core's headless `quit`, wait asynchronously, and remove the icon only after cooperative shutdown. The menu and repeated-open requests are disabled while exit is pending. The icon tooltip indicates exit in progress.

No `cmd.exe`/PowerShell is used by the launcher at runtime: `CreateProcessW` receives an absolute executable path and CRT-quoted arguments. Unicode paths and custom `--home`/`CODEX_WINDOW_HOME` are passed explicitly. Windows Explorer restart restores the icon. There is no notification integration or Electron runtime.

Failure is visible via an error dialog and temporary diagnostic-log path; it does not terminate arbitrary PIDs or hide an unsuccessful exit. Source and package headless checks never launch the GUI. Native compilation and real tray behavior require Windows CI/manual verification.

The altered core must not retain Node's publisher signature: the Windows build removes it with SDK `signtool` before injection. The release does not sign the resulting launcher/core. Unsigned binaries may trigger SmartScreen/reputation warnings; do not bypass security software. Signing is a future release/operational decision, not included here.

## Cooperative exit versus Stop

Existing `stop` / TUI X means **pause all accounts and stop scheduling**. Existing SIGTERM handling retains that meaning. It is not used to implement tray Exit application.

New `quit` means **exit application processes while preserving business configuration and pending outcomes**:

- `application.json` contains only a versioned exit flag and generation. `session-<uuid>.json` identifies a live registered backend/panel/CLI operation by PID, role and generation; it contains no credentials.
- The application lock serializes start/quit transitions. Quit holds it while sessions drain; closing a session needs no application lock. A start queued before a newer exit cannot reopen it. A fresh explicit start can reopen a fully drained application.
- Sessions use directory notifications with a 30-second fallback. The pool closes read-only waits and independently drains each account's already-started token rotation/send. It does not call the business Stop operation or clear account enabled flags.
- Execution gates also read application control directly; safety does not assume a file notification arrived. New HTTP work after a completed rotation is blocked once exit is requested. Durable rotated credentials and pending markers survive.
- Panels abort cancellable waits and drain registered in-flight operations before cooperating with application exit. Normal double Ctrl+C remains the existing immediate panel-only exit; force-closing a console or the OS killing it cannot provide cooperative-drain guarantees.
- A bounded quit wait reports timeout rather than killing a process or pretending it exited. The user may retry after the in-flight operation finishes.
- Startup support is added to the same embedded executable; source-mode startup retains `node dist/cli.js`. No external `cli.js` or separately downloaded core is needed.

A running older backend lacking session registration is detected and not silently replaced. Before upgrade, close its panel and run its original `stop` once; this intentionally pauses accounts. The application will not stop Pi/Rust/other tools or migrate their credentials. Existing account files and settings are unchanged by this development work; real upgrade execution is left to the operator.

## Language

- Default **English**, without time-zone/system-locale guessing or mandatory first-run selection.
- Global `preferences.json`: `{"app":"codex-window-preferences","version":1,"language":"en"}`; only `en` / `zh-CN` are accepted. Missing file means English. It is separate from all account configuration/sync.
- S → Interface language applies immediately; CLI `language en|zh-CN` does the same. Opening settings or changing language does not pause an account. Saving actual business-setting changes still pauses affected profiles.
- A corrupt/symlink preference file is not repaired or overwritten. The display falls back to English with a warning; importantly it cannot prevent the safety `stop` command.
- `src/messages.ts` is the message catalog/help. Existing Chinese source literals identify messages; new persistent events are normalized to English. UI/CLI boundaries select display language. Model IDs, addresses, authorization codes and other message parameters remain opaque, not phrase-replaced.
- Old Chinese event text remains verbatim. New canonical events can display in either language. No rewrite of credentials, business configuration or prior journal entries occurs.
- Language changes invalidate only display/log/date-format caches. The background does not restart or reschedule because of display preferences.

## CI and local packaging

`.github/workflows/check.yml` checks types and non-UI tests on Linux/Windows, then builds both packages. Windows discovers the installed Visual Studio toolchain/SDK; Linux needs no native launcher compiler. GitHub permissions are read-only.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run package
npm run check:package
npm run release:files
```

For Windows local packaging use an x64 Visual Studio developer shell with C tools and SDK `signtool`. Packaging downloads only the **matching public Node LICENSE**, not credentials. Project/runtime licenses and build information are embedded as SEA assets; `--license` and `--version` work without creating an account directory. The application blob and the copied Node binary must use exactly the same version.

Generated files live under ignored `.artifacts/`:

- `codex-window` / `CodexWindow.exe` plus `.sha256` sidecars: the four official downloads;
- platform staging folders with build info, matching licenses, user README and executable SHA-256 sums;
- private build intermediates under `build-<target>/`, including the Windows core and resource objects, never uploaded.

Release inputs are explicit files, never a project/home-directory glob. The isolated headless smoke check copies **only the actual download executable**, uses temporary Unicode/space-containing home/cache directories, verifies embedded licenses/version and startup/status/language/quit. Windows also checks concurrent extraction, cache obstruction, cache corruption repair and icon resources. No credential—even synthetic—is installed, so no real token or usage endpoint can be contacted. Only explicit CLI paths are executed; automated verification never opens the TUI, tray or dialogs.

Workflow artifacts expire after 14 days. Authorized releases attach verified direct executables and checksum sidecars to [GitHub Releases](https://github.com/HoloNova/codex-window/releases), without Actions retention expiry. Publication uses the exact successful CI commit and an explicitly authorized stable/preview tag. The workflow itself does **not** create a release, sign binaries, push commits, install anything globally or deploy/stop a service. Future releases/pushes still require authorization.

## Manual acceptance (no UI automation)

- English first launch, S language selection, instant switch to Chinese/back, unchanged account configuration/enable flags. Opening S read-only; changing business settings still pauses affected profiles.
- Both languages in wide/narrow/short terminals: alignment, wrapped text, dialogs, three-row preview, D log scrolling, unframed toast/exit confirmation, Esc and double Ctrl+C. Existing Chinese history remains unchanged; model IDs/search input are never translated.
- Menu mouse clicks select the actual visible wrapped/scrolled row; Enter alone edits/confirms. Verify both languages, small windows, resizing and unchanged account flags. Text copying uses the terminal's selection modifier (often Shift+drag).
- Windows: download only CodexWindow.exe to a fresh directory; double-click opens the panel and creates a tray icon; close/reopen via the launcher or tray; repeated Open does not duplicate the panel; taskbar restart restores the icon; custom Unicode/space path works.
- Windows Exit application closes panel/backend/tray without altering enabled flags; next launch restores behavior after a fresh usage check. Test a pending read/rotation only with appropriate explicit authorization; never force production token-rotation experiments.
- Linux executable opens the same TUI without Node/npm. `quit` preserves account flags; `stop` pauses. No duplicate same-account schedulers.
- Before publication: run cross-platform CI, inspect the actual binary versions/checksums/licenses, verify anonymous downloads and disclose pending new-path manual acceptance. The user has accepted preview behavior and new sign-in scopes; new mouse interactions and single-file Windows launch still require manual confirmation. No stability label guarantees long-term resource behavior.
