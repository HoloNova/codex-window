#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <wchar.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "resource.h"

#define WM_TRAY (WM_APP + 1)
#define WM_JOB_DONE (WM_APP + 2)
#define WM_CLOSE_ICON (WM_APP + 3)
#define WM_OPEN_PANEL (WM_APP + 4)
#define MENU_OPEN 100
#define MENU_EXIT 101
#define PATH_CAP 4096
static HWND window_handle;
static HINSTANCE app_instance;
static WCHAR home[PATH_CAP], core[PATH_CAP], class_name[96];
static HANDLE singleton, panel_process, job_process, job_wait;
static WCHAR job_log[PATH_CAP];
static int job_kind;
static NOTIFYICONDATAW icon_data;

static int chinese(void) {
    WCHAR path[PATH_CAP]; char data[8192]; DWORD count = 0;
    if (_snwprintf_s(path, PATH_CAP, _TRUNCATE, L"%s\\preferences.json", home) < 0) return 0;
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return 0;
    BOOL ok = ReadFile(file, data, (DWORD)sizeof(data) - 1, &count, NULL); CloseHandle(file);
    if (!ok) return 0;
    data[count] = 0;
    const char *key = strstr(data, "\"language\"");
    if (!key) return 0;
    key += strlen("\"language\"");
    while (*key == ' ' || *key == '\t' || *key == '\r' || *key == '\n') key++;
    if (*key++ != ':') return 0;
    while (*key == ' ' || *key == '\t' || *key == '\r' || *key == '\n') key++;
    return strncmp(key, "\"zh-CN\"", 7) == 0;
}
static void show_error(const WCHAR *english, const WCHAR *zh) { MessageBoxW(window_handle, chinese() ? zh : english, L"Codex Window", MB_OK | MB_ICONERROR); }
/* Quote each argument using Windows CRT rules; never invoke cmd/PowerShell. */
static int argument(WCHAR *command, size_t capacity, const WCHAR *value) {
    size_t at = wcslen(command), slashes = 0;
    if (at && at + 1 < capacity) command[at++] = L' ';
    if (at + 2 >= capacity) return 0;
    command[at++] = L'"';
    for (;;) {
        WCHAR c = *value++;
        if (c == L'\\') { slashes++; continue; }
        size_t emit = (c == L'"' || c == 0) ? slashes * 2 : slashes;
        if (at + emit + 3 >= capacity) return 0;
        while (emit--) command[at++] = L'\\';
        slashes = 0;
        if (!c) break;
        if (c == L'"') command[at++] = L'\\';
        command[at++] = c;
    }
    command[at++] = L'"'; command[at] = 0; return 1;
}
static HANDLE launch(const WCHAR *verb, int console, const WCHAR *log_path) {
    WCHAR command[32768] = L""; STARTUPINFOW startup; PROCESS_INFORMATION process;
    ZeroMemory(&startup, sizeof(startup)); startup.cb = (DWORD)sizeof(startup);
    ZeroMemory(&process, sizeof(process));
    if (!argument(command, 32768, core) || !argument(command, 32768, verb) || !argument(command, 32768, L"--home") || !argument(command, 32768, home)) return NULL;
    HANDLE output = INVALID_HANDLE_VALUE, input = INVALID_HANDLE_VALUE;
    SECURITY_ATTRIBUTES security = { (DWORD)sizeof(SECURITY_ATTRIBUTES), NULL, TRUE };
    if (!console) {
        output = CreateFileW(log_path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &security, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
        input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        if (output == INVALID_HANDLE_VALUE || input == INVALID_HANDLE_VALUE) {
            if (output != INVALID_HANDLE_VALUE) CloseHandle(output);
            if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
            return NULL;
        }
        startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW; startup.wShowWindow = SW_HIDE;
        startup.hStdInput = input; startup.hStdOutput = output; startup.hStdError = output;
    }
    BOOL ok = CreateProcessW(core, command, NULL, NULL, console ? FALSE : TRUE, console ? CREATE_NEW_CONSOLE : CREATE_NO_WINDOW, NULL, NULL, &startup, &process);
    if (output != INVALID_HANDLE_VALUE) CloseHandle(output);
    if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
    if (!ok) return NULL;
    CloseHandle(process.hThread); return process.hProcess;
}
static VOID CALLBACK job_finished(PVOID context, BOOLEAN timed_out) {
    (void)context; (void)timed_out; PostMessageW(window_handle, WM_JOB_DONE, 0, 0);
}
static void start_job(int kind) {
    WCHAR temporary[PATH_CAP];
    if (job_process) return;
    DWORD size = GetTempPathW(PATH_CAP, temporary);
    if (!size || size >= PATH_CAP || !GetTempFileNameW(temporary, L"cww", 0, job_log)) {
        show_error(L"Could not create a temporary startup log.", L"无法创建临时启动日志。"); return;
    }
    job_process = launch(kind == MENU_EXIT ? L"quit" : L"start", 0, job_log);
    if (!job_process) { DeleteFileW(job_log); show_error(L"Could not start the bundled application.", L"无法启动随包提供的程序。"); return; }
    job_kind = kind;
    icon_data.uFlags = NIF_TIP;
    wcscpy_s(icon_data.szTip, ARRAYSIZE(icon_data.szTip), kind == MENU_EXIT ? (chinese() ? L"Codex Window - 正在安全退出…" : L"Codex Window - exiting safely…") : L"Codex Window Autorefresh");
    Shell_NotifyIconW(NIM_MODIFY, &icon_data);
    if (!RegisterWaitForSingleObject(&job_wait, job_process, job_finished, NULL, INFINITE, WT_EXECUTEONLYONCE)) {
        /* Never kill the child on an observer failure. It owns its own locks. */
        CloseHandle(job_process); job_process = NULL;
        icon_data.uFlags = NIF_TIP;
        wcscpy_s(icon_data.szTip, ARRAYSIZE(icon_data.szTip), L"Codex Window Autorefresh"); Shell_NotifyIconW(NIM_MODIFY, &icon_data);
        show_error(L"Could not observe startup. Open the panel to inspect application state.", L"无法监视启动结果，请打开面板检查状态。");
    }
}
static void open_panel(void) {
    DWORD code = 0;
    if (panel_process && GetExitCodeProcess(panel_process, &code) && code == STILL_ACTIVE) {
        if (AttachConsole(GetProcessId(panel_process))) {
            HWND console = GetConsoleWindow(); FreeConsole();
            if (console && IsWindowVisible(console)) { ShowWindowAsync(console, SW_RESTORE); SetForegroundWindow(console); }
        }
        return;
    }
    if (panel_process) { CloseHandle(panel_process); panel_process = NULL; }
    panel_process = launch(L"tui", 1, NULL);
    if (!panel_process) show_error(L"Could not open the TUI console.", L"无法打开 TUI 终端窗口。");
}
static void menu(void) {
    HMENU popup = CreatePopupMenu(); POINT point;
    int zh = chinese();
    AppendMenuW(popup, MF_STRING | (job_process ? MF_GRAYED : 0), MENU_OPEN, zh ? L"打开面板" : L"Open TUI");
    AppendMenuW(popup, MF_SEPARATOR, 0, NULL);
    AppendMenuW(popup, MF_STRING | (job_process ? MF_GRAYED : 0), MENU_EXIT, zh ? L"退出应用" : L"Exit application");
    GetCursorPos(&point); SetForegroundWindow(window_handle);
    UINT selected = (UINT)TrackPopupMenu(popup, TPM_RETURNCMD | TPM_RIGHTBUTTON, point.x, point.y, 0, window_handle, NULL);
    DestroyMenu(popup); PostMessageW(window_handle, WM_NULL, 0, 0);
    if (selected == MENU_OPEN) open_panel();
    if (selected == MENU_EXIT) start_job(MENU_EXIT);
}
static LRESULT CALLBACK procedure(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam) {
    static UINT taskbar_created;
    if (!taskbar_created) taskbar_created = RegisterWindowMessageW(L"TaskbarCreated");
    if (message == taskbar_created) { icon_data.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP; Shell_NotifyIconW(NIM_ADD, &icon_data); return 0; }
    switch (message) {
        case WM_TRAY:
            if (lparam == WM_RBUTTONUP || lparam == WM_CONTEXTMENU) menu();
            else if (lparam == WM_LBUTTONDBLCLK && !job_process) open_panel();
            return 0;
        case WM_JOB_DONE: {
            DWORD code = 1; WCHAR note[PATH_CAP + 256]; int kind = job_kind;
            if (job_wait) { UnregisterWaitEx(job_wait, INVALID_HANDLE_VALUE); job_wait = NULL; }
            if (job_process) { GetExitCodeProcess(job_process, &code); CloseHandle(job_process); job_process = NULL; }
            if (code == 0) { DeleteFileW(job_log); if (kind == MENU_EXIT) DestroyWindow(hwnd); }
            else {
                icon_data.uFlags = NIF_TIP;
                wcscpy_s(icon_data.szTip, ARRAYSIZE(icon_data.szTip), L"Codex Window Autorefresh"); Shell_NotifyIconW(NIM_MODIFY, &icon_data);
                _snwprintf_s(note, ARRAYSIZE(note), _TRUNCATE, chinese() ? L"操作未完成；没有强制终止进程。详细日志：\n%s" : L"Operation did not finish; no process was force-killed. Details:\n%s", job_log);
                MessageBoxW(hwnd, note, L"Codex Window", MB_OK | MB_ICONWARNING);
            }
            return 0;
        }
        case WM_OPEN_PANEL:
            if (!job_process) open_panel();
            return 0;
        case WM_CLOSE_ICON: DestroyWindow(hwnd); return 0;
        case WM_CLOSE: start_job(MENU_EXIT); return 0;
        case WM_DESTROY:
            Shell_NotifyIconW(NIM_DELETE, &icon_data);
            if (job_wait) { UnregisterWaitEx(job_wait, INVALID_HANDLE_VALUE); job_wait = NULL; }
            if (job_process) { CloseHandle(job_process); job_process = NULL; }
            if (panel_process) { CloseHandle(panel_process); panel_process = NULL; }
            if (job_kind == MENU_EXIT) DeleteFileW(job_log);
            PostQuitMessage(0); return 0;
        default: return DefWindowProcW(hwnd, message, wparam, lparam);
    }
}
int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command_line, int show) {
    (void)previous; (void)command_line; (void)show;
    int argc = 0, close_only = 0; WCHAR requested[PATH_CAP] = L"";
    WCHAR **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv) return 1;
    for (int i = 1; i < argc; i++) {
        if (wcscmp(argv[i], L"--close-icon") == 0) close_only = 1;
        else if (wcscmp(argv[i], L"--home") == 0 && i + 1 < argc) {
            if (wcslen(argv[++i]) >= PATH_CAP) { LocalFree(argv); return 1; }
            wcscpy_s(requested, PATH_CAP, argv[i]);
        } else { LocalFree(argv); return 1; }
    }
    LocalFree(argv);
    if (!requested[0]) {
        DWORD size = GetEnvironmentVariableW(L"CODEX_WINDOW_HOME", requested, PATH_CAP);
        if (size >= PATH_CAP) return 1;
        if (!size) {
            WCHAR profile[PATH_CAP]; size = GetEnvironmentVariableW(L"USERPROFILE", profile, PATH_CAP);
            if (!size || size >= PATH_CAP || _snwprintf_s(requested, PATH_CAP, _TRUNCATE, L"%s\\.codex-window-node", profile) < 0) return 1;
        }
    }
    DWORD length = GetFullPathNameW(requested, PATH_CAP, home, NULL);
    if (!length || length >= PATH_CAP) return 1;
    while (length > 3 && (home[length - 1] == L'\\' || home[length - 1] == L'/')) home[--length] = 0;
    WCHAR normalized[PATH_CAP]; wcscpy_s(normalized, PATH_CAP, home); CharLowerBuffW(normalized, length);
    uint64_t hash = UINT64_C(14695981039346656037);
    for (size_t i = 0; normalized[i]; i++) { if (normalized[i] == L'/') normalized[i] = L'\\'; hash ^= (uint64_t)normalized[i]; hash *= UINT64_C(1099511628211); }
    _snwprintf_s(class_name, ARRAYSIZE(class_name), _TRUNCATE, L"CodexWindowTray_%016llx", (unsigned long long)hash);
    if (close_only) {
        HWND existing = FindWindowW(class_name, NULL);
        if (!existing) return 0;
        DWORD pid = 0; GetWindowThreadProcessId(existing, &pid);
        HANDLE process = pid ? OpenProcess(SYNCHRONIZE, FALSE, pid) : NULL;
        if (!PostMessageW(existing, WM_CLOSE_ICON, 0, 0)) { if (process) CloseHandle(process); return 1; }
        if (!process) return IsWindow(existing) ? 1 : 0;
        DWORD result = WaitForSingleObject(process, 5000); CloseHandle(process);
        return result == WAIT_OBJECT_0 ? 0 : 1;
    }
    WCHAR mutex_name[128]; _snwprintf_s(mutex_name, ARRAYSIZE(mutex_name), _TRUNCATE, L"Local\\%s", class_name);
    singleton = CreateMutexW(NULL, TRUE, mutex_name);
    if (!singleton) return 1;
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        HWND existing = FindWindowW(class_name, NULL);
        if (existing) {
            DWORD pid = 0; GetWindowThreadProcessId(existing, &pid);
            if (pid) AllowSetForegroundWindow(pid);
            PostMessageW(existing, WM_OPEN_PANEL, 0, 0);
        }
        CloseHandle(singleton); return 0;
    }
    DWORD path_size = GetModuleFileNameW(NULL, core, PATH_CAP);
    if (!path_size || path_size >= PATH_CAP) { CloseHandle(singleton); return 1; }
    WCHAR *slash = wcsrchr(core, L'\\');
    if (!slash) { CloseHandle(singleton); return 1; }
    slash[1] = 0;
    if (wcscat_s(core, PATH_CAP, L"codex-window-core.exe") != 0 || GetFileAttributesW(core) == INVALID_FILE_ATTRIBUTES) {
        show_error(L"codex-window-core.exe is missing. Extract the entire release package.", L"缺少 codex-window-core.exe，请完整解压发行包。"); CloseHandle(singleton); return 1;
    }
    app_instance = instance;
    WNDCLASSW klass; ZeroMemory(&klass, sizeof(klass)); klass.lpfnWndProc = procedure; klass.hInstance = app_instance; klass.lpszClassName = class_name;
    klass.hIcon = LoadIconW(app_instance, MAKEINTRESOURCEW(IDI_CODEX_WINDOW));
    if (!RegisterClassW(&klass)) { CloseHandle(singleton); return 1; }
    window_handle = CreateWindowExW(0, class_name, L"Codex Window", WS_OVERLAPPED, 0, 0, 0, 0, NULL, NULL, instance, NULL);
    if (!window_handle) { CloseHandle(singleton); return 1; }
    ZeroMemory(&icon_data, sizeof(icon_data)); icon_data.cbSize = (DWORD)sizeof(icon_data); icon_data.hWnd = window_handle; icon_data.uID = 1;
    icon_data.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP; icon_data.uCallbackMessage = WM_TRAY;
    icon_data.hIcon = (HICON)LoadImageW(app_instance, MAKEINTRESOURCEW(IDI_CODEX_WINDOW), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), LR_SHARED);
    if (!icon_data.hIcon) icon_data.hIcon = klass.hIcon;
    wcscpy_s(icon_data.szTip, ARRAYSIZE(icon_data.szTip), L"Codex Window Autorefresh");
    if (!Shell_NotifyIconW(NIM_ADD, &icon_data)) { DestroyWindow(window_handle); CloseHandle(singleton); return 1; }
    /* TUI startup already ensures the backend; show it rather than starting hidden. */
    open_panel();
    MSG message; int result;
    while ((result = (int)GetMessageW(&message, NULL, 0, 0)) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    CloseHandle(singleton); return result < 0 ? 1 : 0;
}
