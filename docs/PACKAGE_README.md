Codex Window Autorefresh
========================

Unofficial subscription-window scheduler. It cannot reset an active window or
increase your allowance. A hello request can consume a small amount of quota.

Windows x64 (desktop Windows 10/11)
-----------------------------------
Extract ALL files together, then double-click CodexWindow.exe. It opens the TUI
and keeps a tray icon. Double-click the launcher again, double-click the icon or
choose Open TUI to reopen the panel. Closing the panel leaves the backend running.
Keep codex-window-core.exe beside the launcher; do not start it separately.
Exit application drains this application's requests/credential saves and exits
its panels/backend/tray, preserving account enabled flags and pending outcomes.
The next launch resumes previously enabled accounts after querying fresh usage.
No administrator rights or startup registration are requested. Unsigned preview
executables may trigger Windows reputation/SmartScreen warnings; there is no
claim of code signing. Do not disable your security software to run this tool.

Linux x64 (glibc; e.g. supported Ubuntu/Debian releases)
------------------------------------------------------
Run: chmod +x codex-window
Then: ./codex-window
Close the panel with Ctrl+C twice; the backend keeps running.
Use ./codex-window quit to exit while preserving account settings.
Use ./codex-window stop to pause all accounts AND stop the backend.
No system service or automatic startup is installed. Alpine/musl, ARM and macOS
are not official binary targets in this preview.

First use
---------
L signs in, M selects a model, R enables the selected account. A switches/adds
accounts; switching shows local cached data only. New accounts start paused.
S edits settings and the global interface language (English / Simplified Chinese).
Language changes do not pause accounts or synchronize account settings. Business
setting changes pause affected accounts and need explicit R to enable again.
Esc returns one step. Ctrl+C twice closes only the panel. D opens session logs.

Data and safety
---------------
Data defaults to ~/.codex-window-node (USERPROFILE on Windows), outside this
release folder. --home PATH or CODEX_WINDOW_HOME selects another dedicated home.
Never point it at Pi/Codex/other credential directories. auth.json contains your
private plaintext credentials; do not share it, commit it or put it in reports.
Each account owns its config.json and state.json. preferences.json stores only
application display language. Do not edit application/session/lock files.
Settings synchronization defaults to on; manual edits of one config do NOT sync.
Uncertain sends retain a pending marker and are not automatically repeated.
Do not enable multiple schedulers for the same real account, including old tools.
Before replacing an older running build, close its panel and run its stop command.
The application will not silently replace an incompatible running backend.

Help: ./codex-window --help (Linux)
      .\codex-window-core.exe --help (Windows terminal)

Downloads: https://github.com/HoloNova/codex-window/releases
Source: https://github.com/HoloNova/codex-window
Application license/source attribution: LICENSE and NOTICE.md
Bundled Node runtime and third-party notices: LICENSE_NODE.txt
Executable checksums: SHA256SUMS. Build details: BUILDINFO.json.
