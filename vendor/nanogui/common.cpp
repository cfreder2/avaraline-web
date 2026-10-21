/*
    nanogui/nanogui.cpp -- Basic initialization and utility routines

    NanoGUI was developed by Wenzel Jakob <wenzel.jakob@epfl.ch>.
    The widget drawing code is based on the NanoVG demo application
    by Mikko Mononen.

    All rights reserved. Use of this source code is governed by a
    BSD-style license that can be found in the LICENSE.txt file.
*/

#include <nanogui/screen.h>

#if defined(_WIN32)
#  include <windows.h>
#  include <commdlg.h>
#  include <prsht.h>
#endif

#include <nanogui/opengl.h>
#include <map>
#include <thread>
#include <chrono>
#include <iostream>
#include <algorithm>

#if !defined(_WIN32)
#  include <locale.h>
#  include <signal.h>
#  include <sys/dir.h>
#endif

NAMESPACE_BEGIN(nanogui)

extern std::vector<Screen *> __nanogui_screens;

double gStartTime = 0.0;

void setTime(double t) {
    gStartTime = t;
}

double getTime() {
    return ((double)SDL_GetTicks() / (double)1000.0) - gStartTime;
}

void init() {
    #if !defined(_WIN32)
        /* Avoid locale-related number parsing issues */
        setlocale(LC_NUMERIC, "C");
    #endif

#ifndef __EMSCRIPTEN__
    if (SDL_Init(SDL_INIT_EVERYTHING) != 0)
        throw std::runtime_error("Could not initialize SDL!");
#else /* __EMSCRIPTEN__ */
    // SDL_INIT_EVERYTHING pulls in haptic/sensor subsystems that the browser's
    // SDL port can't provide and fails the whole init. Request only what exists.
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO | SDL_INIT_EVENTS |
                 SDL_INIT_JOYSTICK | SDL_INIT_GAMECONTROLLER) != 0)
        throw std::runtime_error(std::string("Could not initialize SDL! ") + SDL_GetError());
#endif /* __EMSCRIPTEN__ */

    setTime(0);
}

static bool mainloop_active = false;
int throttle = 0;

#ifndef __EMSCRIPTEN__
void mainloop(int refresh) {
    throttle = refresh;
    if (mainloop_active)
        throw std::runtime_error("Main loop is already running!");
#else /* __EMSCRIPTEN__ */
#include <emscripten.h>
#include <emscripten/html5.h>
#endif /* __EMSCRIPTEN__ */

#ifndef __EMSCRIPTEN__
    mainloop_active = true;
#else /* __EMSCRIPTEN__ */
EM_JS(double, avara_get_render_scale, (), {
    return (typeof Module !== 'undefined' && Module.avaraRenderScale > 0) ? Module.avaraRenderScale : 1.0;
});
#endif /* __EMSCRIPTEN__ */

#ifndef __EMSCRIPTEN__
    //try {
        SDL_Event theEvent;
#else /* __EMSCRIPTEN__ */
// Re-apply the render-resolution scale whenever it changes (live, e.g. from a
// hotkey). Shrinking the canvas drawing buffer makes the next frame's
// glViewport (read from SDL_GL_GetDrawableSize) render at the lower resolution;
// the full-size CSS canvas upscales it. Uniform scale keeps the aspect ratio,
// so the projection needs no update.
// Also re-applied when the page resizes (checked every 15 refreshes): a resize
// puts the canvas back to full size, which would quietly undo the scale.
static void avara_poll_render_scale() {
    static double applied = -1.0;
    static int want_w = 0, want_h = 0, countdown = 0;
    double s = avara_get_render_scale();
    if (s == applied && --countdown > 0) return;
    countdown = 15;
    double cssW = 0, cssH = 0;
    if (emscripten_get_element_css_size("#canvas", &cssW, &cssH) != EMSCRIPTEN_RESULT_SUCCESS)
        return;
    double dpr = emscripten_get_device_pixel_ratio();
    int w = (int)(cssW * dpr * s), h = (int)(cssH * dpr * s);
    int cur_w = 0, cur_h = 0;
    emscripten_get_canvas_element_size("#canvas", &cur_w, &cur_h);
    if (s == applied && w == want_w && h == want_h && cur_w == w && cur_h == h) return;
    applied = s;
    want_w = w; want_h = h;
    if (w > 0 && h > 0 && (cur_w != w || cur_h != h))
        emscripten_set_canvas_element_size("#canvas", w, h);
}
#endif /* __EMSCRIPTEN__ */

#ifndef __EMSCRIPTEN__
        while (mainloop_active) {
            int numScreens = 0;
            for(auto screen : __nanogui_screens) {
                if (!screen->visible()) {
                    continue;
                }
                screen->idle();
                screen->drawAll();
                numScreens++;
            }
#else /* __EMSCRIPTEN__ */
// One iteration, driven by the browser's requestAnimationFrame via
// emscripten_set_main_loop. We do NOT use ASYNCIFY: it more than doubled the
// wasm size (14MB -> 35MB) and made the cold module take ~30s to initialize in
// the browser (a "Page Unresponsive" freeze). Nothing in the engine may block
// waiting for the network; see the multiplayer notes in CPlayerManager.cpp.
//
// Input events are pumped every rAF. How many game ticks this refresh gets is
// decided by WebPacer in CAvaraAppImpl::idle(), which counts refreshes instead of
// comparing timestamps, so callback jitter cannot drop a frame.
static void mainloop_iter() {
    avara_poll_render_scale();   // apply live render-scale changes
#endif /* __EMSCRIPTEN__ */

#ifndef __EMSCRIPTEN__
            if (numScreens == 0) {
                /* Give up if there was nothing to draw */
                mainloop_active = false;
                break;
            }

            /* Wait for mouse/keyboard or empty refresh events */
            int result = SDL_WaitEventTimeout(&theEvent, throttle);  // uses SDL_PollEvent(&theEvent) when throttle == 0
            if(result) {
                if (theEvent.type == SDL_QUIT) {
                    mainloop_active = false;
                }
                for(auto screen : __nanogui_screens) {
                    screen->handleSDLEvent(theEvent);
                }
            }
#else /* __EMSCRIPTEN__ */
    SDL_Event theEvent;
    while (SDL_PollEvent(&theEvent)) {
        if (theEvent.type == SDL_QUIT) {
            mainloop_active = false;
#endif /* __EMSCRIPTEN__ */
        }
#ifdef __EMSCRIPTEN__
        for (auto screen : __nanogui_screens) {
            screen->handleSDLEvent(theEvent);
        }
    }
#endif /* __EMSCRIPTEN__ */

#ifndef __EMSCRIPTEN__
        /* Process events once more */
        SDL_PollEvent(&theEvent);
    //} catch (const std::exception &e) {
    //    std::cerr << "Caught exception in main loop: " << e.what() << std::endl;
    //    leave();
    //}
#else /* __EMSCRIPTEN__ */
    for (auto screen : __nanogui_screens) {
        if (!screen->visible())
            continue;
        screen->idle();
        screen->drawAll();
    }
}

// One pass of the loop on demand: while the tab is hidden the page pauses the
// requestAnimationFrame loop (a hidden tab gets none) and calls this from a Web Worker's
// clock instead (see web/js/lobby.js, avara_web_background).
extern "C" EMSCRIPTEN_KEEPALIVE void avara_web_tick() {
    mainloop_iter();
}

void mainloop(int refresh) {
    throttle = refresh;
    mainloop_active = true;
    // fps=0 -> requestAnimationFrame (display-synced); simulate_infinite_loop=1
    // unwinds the C++ stack and hands control to the browser. No ASYNCIFY.
    emscripten_set_main_loop(mainloop_iter, 0, 1);
#endif /* __EMSCRIPTEN__ */
}

void leave() {
    mainloop_active = false;
}

bool active() {
    return mainloop_active;
}

void shutdown() {
    SDL_Quit();
}

uint32_t utf8_decode(char *p, size_t len) {
    uint32_t codepoint = 0;
    size_t i = 0;

    if (!len)
        return 0;

    for (; i < len; ++i) {
        if (i == 0) {
            codepoint = (0xff >> len) & *p;
        }
        else {
            codepoint <<= 6;
            codepoint |= 0x3f & *p;
        }
        if (!*p)
            return 0;
        p++;
    }

    return codepoint;
}

std::array<char, 8> utf8(int c) {
    std::array<char, 8> seq;
    int n = 0;
    if (c < 0x80) n = 1;
    else if (c < 0x800) n = 2;
    else if (c < 0x10000) n = 3;
    else if (c < 0x200000) n = 4;
    else if (c < 0x4000000) n = 5;
    else if (c <= 0x7fffffff) n = 6;
    seq[n] = '\0';
    switch (n) {
        case 6: seq[5] = 0x80 | (c & 0x3f); c = c >> 6; c |= 0x4000000;
        case 5: seq[4] = 0x80 | (c & 0x3f); c = c >> 6; c |= 0x200000;
        case 4: seq[3] = 0x80 | (c & 0x3f); c = c >> 6; c |= 0x10000;
        case 3: seq[2] = 0x80 | (c & 0x3f); c = c >> 6; c |= 0x800;
        case 2: seq[1] = 0x80 | (c & 0x3f); c = c >> 6; c |= 0xc0;
        case 1: seq[0] = c;
    }
    return seq;
}

int __nanogui_get_image(NVGcontext *ctx, const std::string &name, uint8_t *data, uint32_t size) {
    static std::map<std::string, int> iconCache;
    auto it = iconCache.find(name);
    if (it != iconCache.end())
        return it->second;
    int iconID = nvgCreateImageMem(ctx, 0, data, size);
    if (iconID == 0)
        throw std::runtime_error("Unable to load resource data.");
    iconCache[name] = iconID;
    return iconID;
}

void Object::decRef(bool dealloc) const noexcept {
    --m_refCount;
    if (m_refCount == 0 && dealloc) {
        delete this;
    } else if (m_refCount < 0) {
        fprintf(stderr, "Internal error: Object reference count < 0!\n");
        abort();
    }
}

Object::~Object() { }

NAMESPACE_END(nanogui)
