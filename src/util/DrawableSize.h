/*
    DrawableSize.h — the size of what GL draws into, truthfully.

    In the browser, the page scales the canvas's drawing buffer (render scale: F9 and the
    automatic scaler in web/shell.html) to draw fewer pixels on slow GPUs. SDL never hears
    of it: on Emscripten, SDL_GL_GetDrawableSize is computed from SDL's own idea of the
    window size (window->w * pixel_ratio), not read from the canvas. A viewport sized from
    SDL's answer was then larger than the buffer, and the picture came out cropped and
    enlarged. So ask the canvas. Elsewhere, SDL's answer is the truth.
*/
#pragma once

#include <SDL2/SDL.h>
#ifdef __EMSCRIPTEN__
#include <emscripten/html5.h>
#endif

static inline void AvaraDrawableSize(SDL_Window *window, int *w, int *h) {
#ifdef __EMSCRIPTEN__
    if (emscripten_get_canvas_element_size("#canvas", w, h) == EMSCRIPTEN_RESULT_SUCCESS && *w > 0 && *h > 0)
        return;
#endif
    SDL_GL_GetDrawableSize(window, w, h);
}
