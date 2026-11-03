#define WIN32_LEAN_AND_MEAN
#include "payload.h"
#include "resource.h"
#include "bundle.h"
#include <stdio.h>
#include <wchar.h>
#include <string.h>
#define CACHE_PATH_CAP 4096

static int directory(const WCHAR *path) {
    if (!CreateDirectoryW(path, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) return 0;
    DWORD attributes = GetFileAttributesW(path);
    return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) && !(attributes & FILE_ATTRIBUTE_REPARSE_POINT);
}
static int matches(const WCHAR *path, const unsigned char *data, DWORD length) {
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (file == INVALID_HANDLE_VALUE) return 0;
    BY_HANDLE_FILE_INFORMATION info; LARGE_INTEGER size;
    int ok = GetFileInformationByHandle(file, &info) && !(info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) && GetFileSizeEx(file, &size) && size.QuadPart == (LONGLONG)length;
    unsigned char buffer[65536]; DWORD at = 0;
    while (ok && at < length) {
        DWORD count = 0, wanted = length - at < (DWORD)sizeof(buffer) ? length - at : (DWORD)sizeof(buffer);
        ok = ReadFile(file, buffer, wanted, &count, NULL) && count == wanted && memcmp(buffer, data + at, count) == 0;
        at += count;
    }
    CloseHandle(file); return ok;
}
static int cached_core(HMODULE instance, WCHAR *path, size_t capacity) {
    HRSRC resource = FindResourceW(instance, MAKEINTRESOURCEW(IDR_CODEX_CORE), RT_RCDATA);
    if (!resource) return 0;
    DWORD length = SizeofResource(instance, resource);
    HGLOBAL loaded = LoadResource(instance, resource);
    const unsigned char *data = loaded ? (const unsigned char *)LockResource(loaded) : NULL;
    if (!data || length != CW_CORE_SIZE) return 0;
    WCHAR base[CACHE_PATH_CAP], parent[CACHE_PATH_CAP], cache[CACHE_PATH_CAP], mutex_name[128];
    DWORD size = GetEnvironmentVariableW(L"LOCALAPPDATA", base, CACHE_PATH_CAP);
    if (!size || size >= CACHE_PATH_CAP) return 0;
    if (_snwprintf_s(parent, CACHE_PATH_CAP, _TRUNCATE, L"%s\\CodexWindow", base) < 0 || !directory(parent)) return 0;
    if (_snwprintf_s(cache, CACHE_PATH_CAP, _TRUNCATE, L"%s\\bin", parent) < 0 || !directory(cache)) return 0;
    if (_snwprintf_s(parent, CACHE_PATH_CAP, _TRUNCATE, L"%s\\%s", cache, CW_CORE_SHA256) < 0 || !directory(parent)) return 0;
    if (_snwprintf_s(path, capacity, _TRUNCATE, L"%s\\codex-window-core.exe", parent) < 0) return 0;
    if (_snwprintf_s(mutex_name, ARRAYSIZE(mutex_name), _TRUNCATE, L"Local\\CodexWindowCore_%s", CW_CORE_SHA256) < 0) return 0;
    HANDLE mutex = CreateMutexW(NULL, FALSE, mutex_name);
    if (!mutex) return 0;
    DWORD waited = WaitForSingleObject(mutex, 15000);
    if (waited != WAIT_OBJECT_0 && waited != WAIT_ABANDONED) { CloseHandle(mutex); return 0; }
    int ok = matches(path, data, length);
    if (!ok) {
        /* Never follow a pre-existing target junction/symlink, even to repair it. */
        DWORD attributes = GetFileAttributesW(path);
        if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) goto finished;
        WCHAR temporary[CACHE_PATH_CAP];
        if (_snwprintf_s(temporary, CACHE_PATH_CAP, _TRUNCATE, L"%s\\.core-%lu-%llu.tmp", parent, GetCurrentProcessId(), (unsigned long long)GetTickCount64()) < 0) goto finished;
        HANDLE file = CreateFileW(temporary, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
        if (file == INVALID_HANDLE_VALUE) goto finished;
        ok = 1; DWORD at = 0;
        while (ok && at < length) {
            DWORD count = 0, wanted = length - at < 1048576 ? length - at : 1048576;
            ok = WriteFile(file, data + at, wanted, &count, NULL) && count == wanted;
            at += count;
        }
        if (ok) ok = FlushFileBuffers(file);
        CloseHandle(file);
        if (ok) {
            ok = 0;
            for (int attempt = 0; attempt < 10; attempt++) {
                if (MoveFileExW(temporary, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) { ok = 1; break; }
                DWORD error = GetLastError();
                if (error != ERROR_ACCESS_DENIED && error != ERROR_SHARING_VIOLATION && error != ERROR_LOCK_VIOLATION) break;
                Sleep(attempt < 4 ? (DWORD)(10U << attempt) : 100);
            }
        }
        if (!ok) DeleteFileW(temporary);
        /* A successful rename publishes only the complete embedded bytes. */
        if (ok) ok = matches(path, data, length);
    }
finished:
    ReleaseMutex(mutex); CloseHandle(mutex); return ok;
}
int prepare_core(HINSTANCE instance, WCHAR *path, size_t capacity) {
    WCHAR executable[CACHE_PATH_CAP];
    DWORD size = GetModuleFileNameW(instance, executable, CACHE_PATH_CAP);
    if (!size || size >= CACHE_PATH_CAP) return 0;
    /* A separate data mapping can be released after verification, rather than
       leaving the large payload resident in the long-lived tray's image. */
    HMODULE image = LoadLibraryExW(executable, NULL, LOAD_LIBRARY_AS_DATAFILE_EXCLUSIVE);
    if (!image) return 0;
    int ok = cached_core(image, path, capacity);
    FreeLibrary(image); return ok;
}
