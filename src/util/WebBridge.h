/*
    WebBridge.h — the engine telling the browser page what happened (browser build only).

    The page runs the menus and the lobby; the engine knows when a connection succeeds or
    fails. WebEvent hands each of those to Module.onAvaraEvent(kind, data) as a kind token
    and a JSON object. Every call site is inside #ifdef __EMSCRIPTEN__.
*/
#pragma once

#include <string>

void WebEvent(const char *kind, const std::string &json);

// A JSON string literal for s (quotes included), for building WebEvent payloads.
std::string WebJsonString(const std::string &s);
