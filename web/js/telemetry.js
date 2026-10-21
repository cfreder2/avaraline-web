/*
 * telemetry.js — who plays, what, how well it runs, and whether joining works.
 *
 * Rows go to the `avara_*` tables in the VECTRENCH Supabase project (see
 * supabase/001-avara.sql), through window.AvaraSupa. Three kinds:
 *   - the session: one per page load, re-sent with fresh totals each minute, after every
 *     round, and as the page is hidden;
 *   - a round: one per level played, start to end, with its outcome, kills, frame rate
 *     and (with other players) the round trip and latency tolerance;
 *   - events: joins that worked or failed and why, how each WebRTC link got through.
 *
 * Every call fails soft and nothing in the game waits on it.
 *
 * Off on localhost, so building and testing does not fill the tables (?telemetry turns
 * it on there); localStorage['avara.offline']='1' turns it off anywhere. A session no
 * person is playing is still reported but flagged `synthetic`, and every summary view
 * leaves those out: a browser driven by automation (navigator.webdriver), a page that
 * set window.__avaraTest, or a ?debug / ?test start.
 *
 * Plain script; defines window.AvaraTelemetry.
 */
(function () {
  'use strict';

  var HEARTBEAT_MS = 60000;
  var q = new URLSearchParams(location.search);

  function where() {
    var h = location.hostname || '';
    if (h.endsWith('github.io')) return 'pages';
    if (h.indexOf('itch') >= 0) return 'itch';
    if (h === 'localhost' || h === '127.0.0.1' || h === '') return 'local';
    return 'other';
  }
  function device() {
    var touchOnly = navigator.maxTouchPoints > 0 && !matchMedia('(any-pointer: fine)').matches;
    if (!touchOnly) return 'desktop';
    return Math.min(screen.width, screen.height) < 600 ? 'phone' : 'tablet';
  }
  function renderer() {
    try {
      var gl = document.createElement('canvas').getContext('webgl2');
      var ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      return gl ? String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).slice(0, 160) : 'no webgl2';
    } catch (e) { return null; }
  }
  function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
  function low(a) {   // 5th percentile
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; });
    return s[Math.floor(s.length * 0.05)];
  }
  function r1(x) { return x == null ? null : Math.round(x * 10) / 10; }

  var host = where();
  var T = {
    enabled: AvaraSupa.store('avara.offline') !== '1' && (host !== 'local' || q.has('telemetry')),
    id: crypto.randomUUID(),
    build: (window.AVARA_BUILD || 'dev'),
    host: host, device: device(), renderer: null,
    screen: screen.width + 'x' + screen.height + '@' + (window.devicePixelRatio || 1),
    openedAt: Date.now(), playMs: 0, playingSince: 0,
    rounds: 0, mpRounds: 0, kills: 0, deaths: 0, wins: 0,
    hosted: 0, joined: 0, joinFails: 0,
    fps: [], scale: null, callsign: null,
    cur: null,          // the round in progress
    started: null,      // promise: the session row exists
  };

  function synth() {
    if (navigator.webdriver || window.__avaraTest) return 'agent';
    if (q.has('debug') || q.has('test')) return 'debug';
    return null;
  }

  function flush(keepalive) {
    if (!T.enabled) return Promise.resolve(null);
    var play = T.playMs + (T.playingSince ? Date.now() - T.playingSince : 0);
    return AvaraSupa.rpc('avara_record_session', {
      id: T.id, build: T.build, host: T.host, device: T.device, callsign: T.callsign,
      renderer: T.renderer, screen: T.screen,
      wall: Math.round((Date.now() - T.openedAt) / 1000), play: Math.round(play / 1000),
      rounds: T.rounds, mpRounds: T.mpRounds, kills: T.kills, deaths: T.deaths, wins: T.wins,
      hosted: T.hosted, joined: T.joined, joinFails: T.joinFails,
      fps: r1(mean(T.fps)), fpsLow: r1(low(T.fps)), scale: T.scale, synth: synth(),
    }, keepalive);
  }

  function ensureStarted() {
    if (!T.enabled) return Promise.resolve(null);
    if (!T.started) {
      T.renderer = renderer();
      T.started = flush();
      setInterval(function () { flush(); }, HEARTBEAT_MS);
    }
    return T.started;
  }

  function startClock() { if (!T.playingSince) T.playingSince = Date.now(); }
  function stopClock() { if (T.playingSince) { T.playMs += Date.now() - T.playingSince; T.playingSince = 0; } }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && T.started) flush(true);
  });
  window.addEventListener('pagehide', function () {
    if (T.cur) end('quit', {}, true);
    if (T.started) flush(true);
  });

  // A round began: the engine's 'start' event, plus what the lobby knows (mode, game).
  function begin(start, ctx) {
    if (T.cur) end('quit', {});
    T.cur = {
      mode: ctx.mode, game: ctx.gameId || null, level: start.name || '', levelSet: start.set || '',
      players: start.players || 1, at: Date.now(), samples: [], frame0: null, frameN: null, t0: 0, tN: 0,
      scale: T.scale,
    };
    startClock();
    ensureStarted();
  }

  // How the round ended. stop is the engine's 'stop' event.
  function end(outcome, stop, keepalive) {
    var c = T.cur;
    if (!c) return;
    T.cur = null;
    stopClock();
    T.rounds++;
    if (c.mode !== 'solo') T.mpRounds++;
    if (stop.kills != null) T.kills += stop.kills;
    if (outcome === 'win') T.wins++;
    var tickRate = c.frameN != null && c.tN > c.t0 ? (c.frameN - c.frame0) * 1000 / (c.tN - c.t0) : null;
    var row = {
      session: T.id, game: c.game, mode: c.mode, level: c.level, levelSet: c.levelSet,
      players: stop.players || c.players, outcome: outcome, secs: Math.round((Date.now() - c.at) / 100) / 10,
      kills: stop.kills, score: stop.points, lives: stop.lives,
      fps: r1(mean(c.samples)), fpsLow: r1(low(c.samples)), tickRate: r1(tickRate), scale: T.scale,
      lt: stop.lt, rtt: c.mode === 'solo' ? null : stop.rtt, build: T.build, synth: synth(),
    };
    if (!T.enabled) return;
    (T.started || ensureStarted()).then(function () {
      AvaraSupa.rpc('avara_record_round', row, keepalive);
      if (!keepalive) flush();
    });
  }

  function event(kind, data, gameId) {
    if (!T.enabled) return;
    ensureStarted().then(function () {
      AvaraSupa.rpc('avara_record_event', { session: T.id, kind: kind, game: gameId || null, build: T.build,
                                            data: data || {}, synth: synth() });
    });
  }

  window.AvaraTelemetry = {
    get sessionId() { return T.id; },
    get build() { return T.build; },
    get synth() { return synth(); },
    ensureStarted: ensureStarted,
    callsign: function (n) { T.callsign = n; },
    renderScale: function (s) { T.scale = s; if (T.cur) T.cur.scale = s; },
    // One second of play: frames drawn, and the frame number reached (sim ticks).
    fpsSample: function (fps, frameNumber, t) {
      T.fps.push(fps); if (T.fps.length > 7200) T.fps.shift();
      var c = T.cur;
      if (!c) return;
      c.samples.push(fps);
      if (c.frame0 == null) { c.frame0 = frameNumber; c.t0 = t; }
      c.frameN = frameNumber; c.tN = t;
    },
    begin: begin,
    end: end,
    paused: stopClock,
    resumed: startClock,
    inRound: function () { return !!T.cur; },
    event: event,
    count: function (what) { if (what in T) T[what]++; },
    flush: flush,
  };
})();
