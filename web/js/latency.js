/*
 * latency.js — while hosting, set the latency tolerance floor from the measured round trip.
 *
 * Latency tolerance (LT, in 64 ms classic frames) is how far ahead each player's input is
 * sent. The engine adjusts it during a round between a floor and a ceiling, the host's
 * preferences, sent to everyone. That adjustment was made for the desktop, where a frame
 * that waits for late input goes on the moment it arrives. In a browser a frame can only be
 * drawn at an animation frame, so input that misses one is a stall, and the engine, which
 * sees little waiting, keeps LT too low.
 *
 * So while hosting, between rounds, the floor is raised to cover one way of the round trip
 * (its 75th percentile, from mesh.js's pings) plus half a 60 Hz frame plus 2 ms, rounded up
 * to a quarter LT and never above the ceiling: about one frame more than the engine's own
 * choice. Measured with one-way delays of 25, 50 and 75 ms (jitter 15 ms), that is 0.75, 1
 * and 1.25 to 1.5, which played without stalls. The player's own floor comes back when
 * hosting stops; own() is it, for saving preferences.
 *
 * Plain script; defines window.AvaraLatency. Needs window.AvaraMesh and the engine.
 */
(function () {
  var FRAME_MS = 1000 / 60;
  var PREFS = '/libsdl/Avaraline/Avara/prefs.json';
  var S = { own: null, floor: null, timer: null };

  function enginePref(name) {
    for (var i = 0; i < 2; i++) {
      try { return JSON.parse(Module.FS.readFile(PREFS, { encoding: 'utf8' }))[name]; }
      catch (e) { try { Module.ccall('avara_web_save_prefs', null, [], []); } catch (e2) {} }   // first visit: no file yet
    }
    return undefined;
  }
  function playing() {
    try { return JSON.parse(Module.ccall('avara_web_probe', 'string', [], [])).playing === 1; } catch (e) { return false; }
  }
  function setFloor(v) {
    var ok = false;
    try { ok = Module.ccall('avara_web_set_pref', 'number', ['string', 'string'], ['latencyToleranceMin', v.toFixed(2)]); } catch (e) {}
    if (ok) S.floor = v;
    return ok;
  }
  function tune() {
    if (playing()) return;
    if (S.own == null) {
      var own = enginePref('latencyToleranceMin');
      if (typeof own !== 'number') return;
      S.own = S.floor = own;
    }
    var rtt = AvaraMesh.rtt(), want = S.own;
    if (rtt.links > 0) {
      var ceiling = enginePref('latencyTolerance');
      want = Math.max(S.own, Math.ceil((rtt.p75 / 2 + FRAME_MS / 2 + 2) / FRAME_MS) / 4);
      if (typeof ceiling === 'number' && ceiling > 0) want = Math.min(want, Math.max(ceiling, S.own));
    }
    if (want !== S.floor && setFloor(want)) {
      console.log('[avara] latency tolerance floor ' + want + ' (round trip p50 ' + Math.round(rtt.p50) +
                  ' ms, p75 ' + Math.round(rtt.p75) + ', p95 ' + Math.round(rtt.p95) + ')');
    }
  }

  window.AvaraLatency = {
    // on: hosting began; off: it ended (the player's own floor comes back)
    host: function (on) {
      clearInterval(S.timer); S.timer = null;
      if (on) { S.timer = setInterval(tune, 500); return; }   // soon after someone joins
      if (S.own != null && S.floor !== S.own) setFloor(S.own);
      S.own = S.floor = null;
    },
    own: function () { return S.own; },
  };
})();
