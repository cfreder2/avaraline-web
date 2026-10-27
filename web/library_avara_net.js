/*
 * library_avara_net.js — the wasm side's door to the page's WebRTC mesh.
 *
 * Linked into the module with `--js-library`; implements the extern "C" functions that
 * src/net/AvaraTCP_web.cpp declares. The mesh itself (peer connections, signaling over
 * Supabase Realtime, relaying through the host when two players cannot reach each other)
 * is plain page script in web/js/mesh.js, as window.AvaraMesh, so it can be read and
 * tested without a wasm build. With no mesh on the page (or before the lobby makes one),
 * sends are dropped and nothing is received: exactly a network with nobody on it.
 */

mergeInto(LibraryManager.library, {
    avara_net_init: function () {
        if (!globalThis.AvaraMesh) return;
        if (AvaraMesh.attach) AvaraMesh.attach();
        // A datagram that arrives while the game owes ticks (it was waiting on another
        // player at the last animation frame) may be the input it waits for: try them now
        // (avara_web_poll in CAvaraApp.cpp) instead of up to a frame later. Module.avaraOwed
        // is kept by the engine; nothing is called while the game is on time.
        AvaraMesh.onarrive = function () {
            if (Module.avaraOwed > 0 && Module._avara_web_poll) Module._avara_web_poll();
        };
    },

    avara_net_send: function (peer, dataPtr, len) {
        if (!globalThis.AvaraMesh) return;
        // slice, not subarray: the bytes outlive this call (queued until a channel opens)
        AvaraMesh.send(peer >>> 0, HEAPU8.slice(dataPtr, dataPtr + len));
    },

    avara_net_recv: function (bufPtr, maxlen, outPeerPtr) {
        if (!globalThis.AvaraMesh) return -1;
        var item = AvaraMesh.recv();
        if (!item) return -1;
        var n = Math.min(item.bytes.length, maxlen);
        HEAPU8.set(item.bytes.subarray(0, n), bufPtr);
        HEAPU32[outPeerPtr >> 2] = item.from >>> 0;
        return n;
    }
});
