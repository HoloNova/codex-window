Codex Window Autorefresh
========================

Unofficial subscription-window scheduler. It cannot reset an active window or
increase your allowance. A hello request can consume a small amount of quota.

Windows x64 (desktop Windows 10/11)
-----------------------------------
Download and double-click CodexWindow.exe; no manual extraction is needed. It opens the TUI
and keeps a tray icon. Double-click the launcher again, double-click the icon or
choose Open TUI to reopen the panel. Closing the panel leaves the backend running.
The embedded core is verified and cached under
%LOCALAPPDATA%\CodexWindow\bin\<content-hash>; no extra download is needed.
Exit application drains this application's requests/credential saves and exits
its panels/backend/tray, preserving account enabled flags and pending outcomes.
The next launch resumes previously enabled accounts after querying fresh usage.
No administrator rights or startup registration are requested. Unsigned
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
are not official binary targets.

First use
---------
L signs in, M selects a model, R enables the selected account. Device-code
sign-in copies the code to the system clipboard when available; the code stays
visible and selectable, with a bottom-right confirmation. A switches/adds
accounts; switching shows local cached data only. New accounts start paused.
S edits settings and the global interface language (English / Simplified Chinese).
Click menu items to select, then Enter to edit/confirm. Settings arrows wrap at
either end; Home/End jumps to the first/last item. Text selection/copying uses
your terminal's modifier (often Shift+drag).
Next action shows a local check plan, not a guaranteed send time.
The panel checks GitHub Releases once per launch. If a newer release exists, the title shows New version; press U on the home/log screen to open the releases page. It never downloads or installs an update, and failed checks stay silent.
Language changes do not pause accounts or synchronize account settings. Business
setting changes pause affected accounts and need explicit R to enable again.
Esc returns one step. Ctrl+C twice closes only the panel. D opens session logs,
with concise results and text-labelled category colours; the home preview stays plain.

Opening strategy
----------------
Every usage query completion pushes the regular check back by the configured
interval (default 30 minutes). Reset/confirmation tasks keep independent deadlines.
A reset inside the interval schedules a fresh check at reset + 30 seconds.
Valid reset time within five hours +/- 10 seconds means unopened; operating
hours, pause and quota restrictions still apply. An occasional overlap with a
user who has just started working is accepted.
After an opening command finishes, wait 30 seconds and check. If still clearly
unopened, retry once, wait 30 seconds and check again: at most two sends per task,
including after a restart. Failed/expired/inconsistent observations never authorize
retry or prove success. C only reads and does not consume these independent tasks.

Data and safety
---------------
Data defaults to ~/.codex-window-node (USERPROFILE on Windows), outside this
release folder. --home PATH or CODEX_WINDOW_HOME selects another dedicated home.
Never point it at Pi/Codex/other credential directories. auth.json contains your
private plaintext credentials; do not share it, commit it or put it in reports.
New sign-ins request identity/offline-renewal scopes, without connector access.
Existing credentials and grants are unchanged.
Each account owns its config.json and state.json. preferences.json stores only
application display language. Do not edit application/session/lock files.
Settings synchronization defaults to on; manual edits of one config do NOT sync.
Uncertain outcomes retain a pending marker; ordinary checks cannot reset the
retry budget. Legacy pending outcomes never gain automatic retries. Pause or
configuration/control changes revoke the old task's retry permission. Review the
account before R explicitly clears the pending outcome and allows a new task.
Do not enable multiple schedulers for the same real account, including old tools.
Before replacing a running build, exit it using the tray or ./codex-window quit.
Very old builds without cooperative quit need stop instead; that pauses accounts.
The application will not silently replace an incompatible running backend.

Help: ./codex-window --help (Linux)
      .\CodexWindow.exe --help (Windows terminal)

Downloads: https://github.com/HoloNova/codex-window/releases
Source: https://github.com/HoloNova/codex-window
Application/runtime licenses and attribution are embedded: use --license.
Build information: --version. Matching .sha256 downloads verify each executable.
