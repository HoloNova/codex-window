#ifndef CODEX_WINDOW_PAYLOAD_H
#define CODEX_WINDOW_PAYLOAD_H
#include <windows.h>
#include <stddef.h>

/* Only this application's content-addressed cache is touched. */
int prepare_core(HINSTANCE instance, WCHAR *path, size_t capacity);
#endif
