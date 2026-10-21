/*
 * lobby.js — the menu over the game: play alone, host a game, or join one.
 *
 * Hosting: this tab becomes Avara's slot 0 (the engine's server, a player like any
 * other), opens the game's signaling channel, and publishes a row to the Supabase game
 * list (avara_host_game) that it refreshes every 10 s with the level, the players and
 * whether a round is on. Joining: pick a row, open that game's signaling channel, and
 * ask the engine to connect to "peer:<host id>"; the mesh (mesh.js) negotiates the
 * WebRTC links underneath. Once in, the engine's own windows (Levels, Roster with chat)
 * run the game exactly as on the desktop: the host picks a level, everyone clicks
 * Start/Ready.
 *
 * The engine reports back through Module.onAvaraEvent -> AvaraLobby.engineEvent:
 *   net     {state: hosting|connecting|connected|failed|offline, slot, reason}
 *   level   {set, tag, name}          a level loaded
 *   start   {name, set, players, slot} a round started
 *   stop    {status, kills, lives, points, players, lt, rtt, ...}  a round stopped
 *   resume  {}                        a paused round resumed
 *   roster  {slot, net, players:[{slot, name, status}]}
 *
 * Plain script; defines window.AvaraLobby.
 */
(function () {
  'use strict';

  var NET_VERSION = 18;           // kAvaraNetVersion: games of other versions cannot be joined
  var HEARTBEAT_MS = 10000;
  var LIST_EVERY_MS = 4000;
  var REASONS = { 1: 'cancelled', 2: 'no answer from the host', 3: 'bad address' };

  var $ = function (id) { return document.getElementById(id); };
  // A build id as the game list stores it (avara_tok in supabase/001-avara.sql).
  var tok = function (s) { return String(s || '').toLowerCase().replace(/[^a-z0-9_.:\/-]/g, '').slice(0, 40); };
  var L = {
    mode: 'menu',                 // menu | solo | host | client
    game: null,                   // { id, name, peer } while hosting or in a game
    level: { name: '', set: '' },
    roster: [],
    playing: false,
    loaded: false,                // the engine has a level loaded
    offered: {},                  // players the host has loaded the level for
    joinStarted: 0,
    heartbeat: null, listTimer: null, pushTimer: null,
    newRounds: 0,
    ltOwn: null,                  // the player's own latency tolerance floor, while the host's replaces it
    ltFloor: null,                // the floor in force (tuneLatency)
    ltTimer: null,
  };

  function call(fn, types, args) {
    try { return Module.ccall(fn, null, types || [], args || []); }
    catch (e) { console.error('[avara] ' + fn, e); }
  }

  // Start/Ready only counts players with a level loaded, and the engine drops the loaded
  // level when hosting begins (as on the desktop). So hosting, or playing solo with
  // nothing loaded yet, loads the last level played here, or a simple open one.
  var FIRST_LEVEL = { set: 'aa-normal', tag: 'bwadi.alf' };
  function loadUsualLevel() {
    var last = null;
    try { last = JSON.parse(AvaraSupa.store('avara.lastLevel') || 'null'); } catch (e) {}
    var lv = (L.level && L.level.tag) ? L.level : (last && last.set && last.tag) ? last : FIRST_LEVEL;
    call('avara_web_load', ['string', 'string'], [lv.set, lv.tag]);
  }
  // Someone who joins has no level loaded either, and a start would leave them out. The
  // host loads the level again for each new arrival (once: a load that fails stays failed).
  var CONNECTED = 1;   // LoadingState kLConnected
  function offerLevel(players, mySlot) {
    if (L.mode !== 'host' || L.playing || !L.loaded || !L.level || !L.level.tag) return;
    var seen = {}, fresh = false;
    players.forEach(function (p) {
      var key = p.slot + ':' + p.name;
      seen[key] = true;
      if (p.slot !== mySlot && p.status === CONNECTED && !L.offered[key]) { L.offered[key] = true; fresh = true; }
    });
    Object.keys(L.offered).forEach(function (k) { if (!seen[k]) delete L.offered[k]; });
    if (fresh) { clearTimeout(L.offerTimer); L.offerTimer = setTimeout(function () { if (!L.playing) loadUsualLevel(); }, 1200); }
  }

  // ---- screens ------------------------------------------------------------------------
  function show(screen) {
    ['s-loading', 's-menu', 's-host', 's-join', 's-busy', 's-levels', 's-settings', 's-online', 's-account'].forEach(function (s) { if ($(s)) $(s).classList.toggle('on', s === screen); });
    $('overlay').classList.remove('hidden');
    if (screen !== 's-join') stopListing();
  }
  function hideOverlay() {
    $('overlay').classList.add('hidden');
    stopListing();
    canvas.focus();
  }
  function busy(msg, hint, button, spinning) {
    $('busyMsg').textContent = msg;
    $('busyMsg').classList.toggle('bad', !spinning);
    $('busyHint').textContent = hint || '';
    $('b-busy').textContent = button || 'Cancel';
    $('busySpin').style.display = spinning ? '' : 'none';
    show('s-busy');
  }
  // The bar over the game: what you are in, and the way to the levels and out. Hidden
  // while a round is on (the pointer is captured then anyway).
  function chip() {
    var c = $('netchip');
    if (L.mode === 'menu' || L.playing) { c.classList.remove('on'); return; }
    $('netchipText').innerHTML = '';
    if (L.mode === 'solo') {
      $('netchipText').append('Playing solo');
      $('netchipLeave').textContent = 'Menu';
    } else {
      var n = L.roster.length || 1;
      $('netchipText').append(L.mode === 'host' ? 'Hosting ' : 'In ', Object.assign(document.createElement('b'), { textContent: L.game.name }),
                              ' · ' + n + (n === 1 ? ' player' : ' players'));
      $('netchipLeave').textContent = 'Leave';
    }
    c.classList.add('on');
  }

  function callsign() {
    var v = ($('callsign').value || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24);
    return v;
  }
  function applyCallsign() {
    var n = callsign();
    if (!n) return;
    AvaraSupa.store('avara.callsign', n);
    AvaraTelemetry.callsign(n);
    call('avara_web_set_name', ['string'], [n]);
    if (window.AvaraSettings) AvaraSettings.save();
  }

  // ---- hosting ------------------------------------------------------------------------
  // Everyone in the game by name, the host (slot 0) first, as the tracker lists a desktop
  // game's players: the web game list shows them (supabase/006-web-game-list.sql).
  function playerNames() {
    var names = L.roster.slice().sort(function (a, b) { return a.slot - b.slot; })
      .map(function (p) { return String(p.name || '').trim(); }).filter(Boolean);
    return (names.length ? names : [callsign()].filter(Boolean)).slice(0, 8);
  }
  function hostPayload() {
    return {
      id: L.game.id, peer: AvaraMesh.hex(AvaraMesh.id), name: L.game.name, hostName: callsign(),
      level: L.level.name, levelSet: L.level.set, players: Math.max(1, L.roster.length),
      names: playerNames(),
      maxPlayers: 8, status: L.playing ? 'playing' : 'lobby', build: AvaraTelemetry.build,
      net: NET_VERSION, session: AvaraTelemetry.sessionId, synth: AvaraTelemetry.synth,
      newRounds: L.newRounds,
    };
  }
  function pushGame() {           // soon, but not on every flicker of the roster
    if (L.mode !== 'host') return;
    clearTimeout(L.pushTimer);
    L.pushTimer = setTimeout(sendGame, 800);
  }
  function sendGame() {
    if (L.mode !== 'host') return;
    var p = hostPayload();
    L.newRounds = 0;
    AvaraSupa.rpc('avara_host_game', p);
  }

  function startHosting() {
    applyCallsign();
    var name = ($('gamename').value || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || (callsign() || 'Avara') + "'s game";
    AvaraSupa.store('avara.gamename', $('gamename').value.trim());
    L.mode = 'host';
    L.game = { id: crypto.randomUUID(), name: name, peer: AvaraMesh.hex(AvaraMesh.id) };
    AvaraMesh.join(L.game.id, { host: true });
    busy('Opening your game…', '', 'Cancel', true);
    call('avara_web_host');
  }

  // ---- latency tolerance: the host sets the floor from the round trip ---------------------
  // Latency tolerance (LT, in 64 ms classic frames) is how far ahead each player's input is
  // sent. The engine adjusts it during a round, between a floor and a ceiling taken from the
  // host's preferences for everyone. Its adjustment was made for the desktop, where a frame
  // waits for a late input inside the frame and goes on the moment it arrives: it counts only
  // waits of a whole frame or more, and keeps LT where it is while up to a fifth of frames
  // wait. In a browser a frame can only be drawn at an animation frame, so input that misses
  // one shows as a stall (and the engine, which goes on with the frame as soon as the input
  // arrives, between animation frames, sees little waiting and lowers LT further).
  //
  // So while hosting a game with others, between rounds, the host raises the floor to what
  // the network needs, from the round trip mesh.js measures on the direct links: input sent
  // LT ahead must cover one way of the round trip (its 75th percentile: a little of the
  // jitter; each packet also carries the frames before it, so one late packet is often
  // covered by the next), plus half a frame (where one browser's animation frames fall
  // between the other's), plus 2 ms, in 60 Hz frames, rounded up to a quarter LT and never
  // above the ceiling. That is about one frame more than the engine's own choice from the
  // round trip, for the animation frame a browser waits for. Measured with
  // tools/hitch_check.mjs: one-way delays of 25, 50 and 75 ms (jitter 15) play without
  // stalls at 0.75, 1 and 1.25 to 1.5, which is what this chooses. The player's own floor
  // comes back when hosting stops, and it is the one Settings saves.
  var FRAME_MS = 1000 / 60;
  function enginePref(name) {
    var file = '/libsdl/Avaraline/Avara/prefs.json';
    for (var i = 0; i < 2; i++) {
      try { return JSON.parse(Module.FS.readFile(file, { encoding: 'utf8' }))[name]; }
      catch (e) { call('avara_web_save_prefs'); }   // a first visit has no file until the engine writes one
    }
    return undefined;
  }
  function setLatencyFloor(v) {
    var ok = false;
    try { ok = Module.ccall('avara_web_set_pref', 'number', ['string', 'string'], ['latencyToleranceMin', v.toFixed(2)]); } catch (e) {}
    if (ok) L.ltFloor = v;
    return ok;
  }
  function tuneLatency() {
    if (L.mode !== 'host' || L.playing) return;
    if (L.ltOwn == null) {
      var own = enginePref('latencyToleranceMin');
      if (typeof own !== 'number') return;
      L.ltOwn = own;
      L.ltFloor = own;
    }
    var rtt = AvaraMesh.rtt(), want = L.ltOwn;
    if (rtt.links > 0) {
      var ceiling = enginePref('latencyTolerance');
      var frames = Math.ceil((rtt.p75 / 2 + FRAME_MS / 2 + 2) / FRAME_MS);
      want = Math.max(L.ltOwn, frames / 4);
      if (typeof ceiling === 'number' && ceiling > 0) want = Math.min(want, Math.max(ceiling, L.ltOwn));
    }
    if (want !== L.ltFloor && setLatencyFloor(want)) {
      console.log('[avara] latency tolerance floor ' + want + ' (round trip ' + Math.round(rtt.p50) + ' ms, 75th percentile ' +
                  Math.round(rtt.p75) + ', 95th ' + Math.round(rtt.p95) + ')');
    }
  }
  function restoreLatencyFloor() {
    clearInterval(L.ltTimer); L.ltTimer = null;
    if (L.ltOwn != null && L.ltFloor !== L.ltOwn) setLatencyFloor(L.ltOwn);
    L.ltOwn = null; L.ltFloor = null;
  }

  // ---- joining ------------------------------------------------------------------------
  function stopListing() { clearInterval(L.listTimer); L.listTimer = null; }

  function listGames() {
    AvaraSupa.rpc('avara_list_games', { synth: AvaraTelemetry.synth }).then(function (games) {
      if (!$('s-join').classList.contains('on')) return;
      var box = $('games');
      box.innerHTML = '';
      if (!Array.isArray(games)) {
        box.innerHTML = '<div class="empty">Could not reach the game list. Check your connection.</div>';
        return;
      }
      if (!games.length) {
        box.innerHTML = '<div class="empty">No open games right now.<br>Host one, and it shows up here for everyone.</div>';
        return;
      }
      games.forEach(function (g) {
        var b = document.createElement('button');
        b.className = 'game';
        var same = g.build === tok(AvaraTelemetry.build) && g.net === NET_VERSION;
        var full = g.players >= g.maxPlayers;
        b.disabled = !same || full;
        var detail = (g.hostName ? 'hosted by ' + g.hostName : '') +
                     (g.level ? ' · ' + g.level : '') +
                     (g.status === 'playing' ? ' · round in progress' : '') +
                     (!same ? ' · different version: reload the page' : '') + (full ? ' · full' : '');
        b.append(Object.assign(document.createElement('span'), { className: 'n', textContent: g.name }),
                 Object.assign(document.createElement('span'), { className: 'p', textContent: g.players + '/' + g.maxPlayers }),
                 Object.assign(document.createElement('span'), { className: 'd', textContent: detail.replace(/^ · /, '') }));
        b.onclick = function () { join(g); };
        box.appendChild(b);
      });
    });
  }

  function join(g) {
    applyCallsign();
    L.mode = 'client';
    L.game = { id: g.id, name: g.name, peer: g.peer };
    L.joinStarted = performance.now();
    AvaraMesh.join(g.id, { hostId: parseInt(g.peer, 16) });
    busy('Joining ' + g.name + '…', 'Connecting directly to the host.', 'Cancel', true);
    call('avara_web_join', ['string'], ['peer:' + g.peer]);
  }

  // Back to the menu from any game: stop hosting, or leave the host.
  function leave(why) {
    var was = L.mode, game = L.game;
    if (was === 'host' && game) AvaraSupa.rpc('avara_close_game', { id: game.id });
    L.mode = 'menu'; L.game = null; L.roster = []; L.playing = false;
    clearTimeout(L.pushTimer);
    restoreLatencyFloor();
    call('avara_web_leave');
    AvaraMesh.leave();
    background(false);
    chip();
    if (why) busy(why, '', 'Back to the menu', false);
    else show('s-menu');
  }

  // ---- what the engine says -------------------------------------------------------------
  function engineEvent(kind, d) {
    if (kind === 'net') {
      if (d.state !== 'connecting') { L.loaded = false; L.offered = {}; }   // a change of net drops the level
      if (d.state === 'hosting' && L.mode === 'host') {
        AvaraTelemetry.count('hosted');
        AvaraTelemetry.event('host', { name: L.game.name }, L.game.id);
        sendGame();
        loadUsualLevel();
        clearInterval(L.heartbeat);
        L.heartbeat = setInterval(sendGame, HEARTBEAT_MS);
        clearInterval(L.ltTimer);
        L.ltTimer = setInterval(tuneLatency, 2000);
        hideOverlay(); chip();
      } else if (d.state === 'connected' && L.mode === 'client') {
        var ms = Math.round(performance.now() - L.joinStarted);
        var hostLink = AvaraMesh.links().filter(function (x) { return x.peer === L.game.peer; })[0];
        AvaraTelemetry.count('joined');
        AvaraTelemetry.event('join_ok', { ms: ms, path: hostLink && hostLink.path, slot: d.slot }, L.game.id);
        hideOverlay(); chip();
      } else if (d.state === 'failed' && L.mode === 'client') {
        var reason = REASONS[d.reason] || ('error ' + d.reason);
        var links = AvaraMesh.links();
        AvaraTelemetry.count('joinFails');
        AvaraTelemetry.event('join_fail', { reason: reason, ms: Math.round(performance.now() - L.joinStarted), links: links }, L.game && L.game.id);
        var hint = d.reason === 2
          ? 'The host may have left, or your network and theirs cannot reach each other directly.'
          : '';
        L.mode = 'menu'; L.game = null;
        AvaraMesh.leave();
        if (d.reason !== 1) busy("Couldn't join: " + reason + '.', hint, 'Back to the menu', false);
      }
      if (L.mode !== 'host') { clearInterval(L.heartbeat); L.heartbeat = null; }
    } else if (kind === 'level') {
      L.level = { name: d.name, set: d.set, tag: d.tag };
      L.loaded = true;
      if (d.set && d.tag && d.set.indexOf('community-') !== 0) AvaraSupa.store('avara.lastLevel', JSON.stringify({ set: d.set, tag: d.tag }));
      pushGame();
    } else if (kind === 'roster') {
      L.roster = d.players || [];
      offerLevel(L.roster, d.slot);
      chip();
      pushGame();
    }
    if (kind === 'quit') {                  // /quit: a page cannot quit; back to the menu
      if (L.mode === 'host' || L.mode === 'client') leave();
      else { L.mode = 'menu'; chip(); show('s-menu'); }
      return;
    }
    if (kind === 'removed' && (L.mode === 'host' || L.mode === 'client')) {
      leave(d.hostLeft ? 'The host left the game.' : 'You were removed from the game.');
      return;
    }
    if (window.AvaraCommunity) AvaraCommunity.engineEvent(kind, d);
    if (window.AvaraOnline) AvaraOnline.engineEvent(kind, d);
    if (kind === 'start') {
      L.playing = true;
      chip();
      L.newRounds++;
      AvaraTelemetry.begin(d, { mode: L.mode === 'host' || L.mode === 'client' ? L.mode : 'solo', gameId: L.game && L.game.id });
      pushGame();
    } else if (kind === 'resume') {
      L.playing = true;
      chip();
      AvaraTelemetry.resumed();
    } else if (kind === 'stop') {
      L.playing = false;
      chip();
      if (window.AvaraSettings) AvaraSettings.save();   // Elo ratings change at the end of a round
      if (d.status === 'pause') AvaraTelemetry.paused();
      else if (d.status === 'abort') AvaraTelemetry.end('abort', d);
      else if (d.status === 'win' || d.status === 'lose') AvaraTelemetry.end(d.lives > 0 ? 'win' : 'lose', d);
      pushGame();
    }
  }

  // A link to the host that dies while we are in its game: the host is gone.
  AvaraMesh.onevent = function (kind, d) {
    if (kind === 'link' || kind === 'relay' || kind === 'linkfail') {
      AvaraTelemetry.event(kind, d, L.game && L.game.id);
    }
    var inGame = $('overlay').classList.contains('hidden');
    if ((kind === 'linkfail' || kind === 'bye') && L.mode === 'client' && L.game && d.peer === L.game.peer && inGame) {
      leave('The host left the game.');
    }
  };

  // ---- wiring ------------------------------------------------------------------------
  function ready() {
    $('callsign').value = AvaraSupa.store('avara.callsign') || '';
    $('gamename').value = AvaraSupa.store('avara.gamename') || '';
    if (window.AVARA_BUILD) $('build').textContent = AVARA_BUILD;
    AvaraTelemetry.ensureStarted();
    applyCallsign();
    show('s-menu');
    if (window.AvaraOnline) AvaraOnline.ready();
    // ?host and ?join=<game id> skip the menu (handy for tests and shared links).
    var q = new URLSearchParams(location.search);
    if (q.has('host')) startHosting();
    else if (q.get('join')) {
      var peer = q.get('peer');
      if (peer) join({ id: q.get('join'), name: q.get('name') || 'game', peer: peer });
    }
  }

  function enterSolo() { applyCallsign(); L.mode = 'solo'; hideOverlay(); chip(); if (!L.loaded) loadUsualLevel(); }
  $('b-solo').onclick = enterSolo;
  $('b-levels').onclick = function () { applyCallsign(); AvaraCommunity.open(); };
  // a click on the bar leaves the keyboard with the game, not with the button
  $('netchip').addEventListener('mouseup', function () { setTimeout(function () { if (document.activeElement && document.activeElement.tagName === 'BUTTON' && $('overlay').classList.contains('hidden')) canvas.focus(); }, 0); });
  $('netchipLevels').onclick = function () { AvaraCommunity.open(); };
  $('netchipSettings').onclick = function () { AvaraSettings.open(); };
  $('b-settings').onclick = function () { applyCallsign(); AvaraSettings.open(); };
  $('b-host').onclick = function () { applyCallsign(); show('s-host'); $('gamename').placeholder = (callsign() || 'Avara') + "'s game"; $('gamename').focus(); };
  $('b-join').onclick = function () {
    applyCallsign(); show('s-join');
    $('games').innerHTML = '<div class="empty">Looking for games…</div>';
    listGames(); stopListing(); L.listTimer = setInterval(listGames, LIST_EVERY_MS);
  };
  $('b-host-go').onclick = startHosting;
  $('gamename').addEventListener('keydown', function (e) { if (e.key === 'Enter') startHosting(); });
  $('b-host-back').onclick = function () { show('s-menu'); };
  $('b-join-back').onclick = function () { show('s-menu'); };
  $('b-busy').onclick = function () {
    if (L.mode === 'host' || L.mode === 'client') leave();
    else show('s-menu');
  };
  $('netchipLeave').onclick = function () {
    if (L.mode === 'solo') { L.mode = 'menu'; chip(); show('s-menu'); }
    else leave();
  };
  $('callsign').addEventListener('change', applyCallsign);

  // A host closing the tab takes the game off the list now rather than in 30 s.
  window.addEventListener('pagehide', function () {
    if (L.mode === 'host' && L.game) AvaraSupa.rpc('avara_close_game', { id: L.game.id }, true);
  });
  // A hidden tab gets no animation frames, and Chrome slows its timers to about one a
  // second (less after five minutes). In a game with others, everyone would wait on our
  // input. A dedicated worker's timers are not slowed, so while hidden its ticks drive the
  // engine (avara_web_tick), and the normal loop takes over again when the tab is shown.
  var bgWorker = null;
  function background(hidden) {
    if (hidden && !bgWorker && (L.mode === 'host' || L.mode === 'client')) {
      var src = 'setInterval(function () { postMessage(0); }, 16);';
      bgWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      bgWorker.onmessage = function () { call('avara_web_tick'); };
      call('avara_web_background', ['number'], [1]);
    } else if (!hidden && bgWorker) {
      bgWorker.terminate(); bgWorker = null;
      call('avara_web_background', ['number'], [0]);
    }
  }
  document.addEventListener('visibilitychange', function () { background(document.hidden); });

  window.AvaraLobby = {
    ready: ready, engineEvent: engineEvent, leave: leave, get state() { return L; },
    join: join, callsign: callsign, applyCallsign: applyCallsign, tok: tok, netVersion: NET_VERSION,
    enterSolo: enterSolo,
    showScreen: show,
    closeOverlay: function () { hideOverlay(); chip(); },
    // Back from the Levels screen: to the game if we are in one, else the menu.
    back: function () { if (L.mode === 'menu') show('s-menu'); else { hideOverlay(); chip(); } },
  };
})();
