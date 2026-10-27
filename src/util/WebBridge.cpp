#ifdef __EMSCRIPTEN__   // browser build only

#include "WebBridge.h"

#include <cstdio>

#include <emscripten.h>

EM_JS(void, avara_web_event, (const char *kind, const char *json), {
    if (typeof Module === 'undefined' || !Module.onAvaraEvent) return;
    var k = UTF8ToString(kind), d;
    try { d = JSON.parse(UTF8ToString(json)); } catch (e) { console.error('[avara] bad event', k, e); return; }
    try { Module.onAvaraEvent(k, d); } catch (e) { console.error('[avara] event handler', k, e); }
});

void WebEvent(const char *kind, const std::string &json) {
    avara_web_event(kind, json.c_str());
}

std::string WebJsonString(const std::string &s) {
    std::string out = "\"";
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof buf, "\\u%04x", c);
                    out += buf;
                } else {
                    out += (char)c;   // UTF-8 passes through
                }
        }
    }
    return out + "\"";
}

#endif // __EMSCRIPTEN__
