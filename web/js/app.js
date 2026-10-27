/*
 * app.js — the plain page's menu: play solo, host a game, or join one from a link.
 *
 * Hosting makes up a game id, opens the WebRTC mesh for it (js/mesh.js, signaling
 * through js/signal.js) and asks the engine to host. The invite link carries the game id
 * and the host's peer id, and opening it joins. Once everyone is in, the host loads a
 * level in the Levels window and each player presses Start/Ready, as on the desktop.
 *
 * Plain script; defines window.AvaraApp.
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var REASONS = { 1: 'cancelled', 2: 'no answer from the host', 3: 'bad address' };
  var A = { mode: 'menu', game: null };     // mode: menu | solo | host | client

  function call(fn, types, args) {
    try { return Module.ccall(fn, null, types || [], args || []); }
    catch (e) { console.error('[avara] ' + fn, e); }
  }
  function stored(k, v) {   // localStorage that private modes and blocked storage cannot break
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {}
    return null;
  }

  function show(screen) {
    $('overlay').classList.remove('hidden');
    ['s-loading', 's-menu', 's-msg'].forEach(function (s) { $(s).classList.toggle('on', s === screen); });
    bar();
  }
  function hideOverlay() {
    $('overlay').classList.add('hidden');
    $('canvas').focus();
    bar();
  }
  function message(text, button) {
    $('msg').textContent = text;
    $('b-msg').hidden = !button;
    show('s-msg');
  }

  function callsign() {
    return ($('callsign').value || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24);
  }
  function applyCallsign() {
    var n = callsign();
    stored('avara.callsign', n);
    if (n) call('avara_web_set_name', ['string'], [n]);
  }

  function inviteLink() {
    return location.origin + location.pathname + '?join=' + A.game.id + '&peer=' + A.game.peer;
  }

  // The strip above the game: where you are, the invite link when hosting, and Leave.
  function bar() {
    var inGame = $('overlay').classList.contains('hidden') && A.mode !== 'menu';
    $('bar').hidden = !inGame;
    if (!inGame) return;
    var links = A.mode === 'solo' ? [] : AvaraMesh.links().filter(function (l) { return l.open; });
    $('where').textContent = A.mode === 'solo' ? 'Solo'
      : A.mode === 'host' ? 'Hosting · ' + (links.length + 1) + (links.length ? ' players' : ' player')
      : 'In a game · ' + (links.length + 1) + ' players';
    $('b-link').hidden = A.mode !== 'host';
    $('b-leave').textContent = A.mode === 'solo' ? 'Menu' : 'Leave';
  }

  function solo() {
    applyCallsign();
    A.mode = 'solo';
    hideOverlay();
  }

  function host() {
    applyCallsign();
    A.mode = 'host';
    A.game = { id: crypto.randomUUID(), peer: AvaraMesh.hex(AvaraMesh.id) };
    message('Starting a game…');           // before the call: the engine reports 'hosting' during it
    AvaraMesh.join(A.game.id, { host: true });
    call('avara_web_host');
  }

  function join(id, peer) {
    applyCallsign();
    A.mode = 'client';
    A.game = { id: id, peer: peer };
    message('Joining…');
    AvaraMesh.join(id, { hostId: parseInt(peer, 16) });
    call('avara_web_join', ['string'], ['peer:' + peer]);
  }

  function leave(why) {
    if (A.mode === 'host' || A.mode === 'client') {
      AvaraLatency.host(false);
      call('avara_web_leave');
      AvaraMesh.leave();
      background(false);
    }
    A.mode = 'menu';
    A.game = null;
    if (why) message(why, true);
    else show('s-menu');
  }

  // ---- what the engine says (WebEvent in the engine) ------------------------------------
  function engineEvent(kind, d) {
    if (kind === 'net') {
      if (d.state === 'hosting' && A.mode === 'host') { AvaraLatency.host(true); hideOverlay(); }
      else if (d.state === 'connected' && A.mode === 'client') hideOverlay();
      else if (d.state === 'failed' && A.mode === 'client') {
        AvaraMesh.leave();
        A.mode = 'menu'; A.game = null;
        if (d.reason !== 1) message("Couldn't join: " + (REASONS[d.reason] || 'error ' + d.reason) + '.', true);
      }
      bar();
    } else if (kind === 'quit') {               // /quit: a page cannot quit; back to the menu
      leave();
    }
  }

  // The link to the host closing while we are in its game: the host has left.
  AvaraMesh.onevent = function (kind, d) {
    if ((kind === 'linkfail' || kind === 'bye') && A.mode === 'client' && A.game && d.peer === A.game.peer) {
      leave('The host left the game.');
    }
    bar();
  };

  // A hidden tab gets no animation frames, and its timers slow to about one a second; in
  // a game with others everyone would wait on our input. A worker's timers are not slowed,
  // so while hidden its ticks drive the engine (avara_web_tick).
  var bgWorker = null;
  function background(hidden) {
    if (hidden && !bgWorker && (A.mode === 'host' || A.mode === 'client')) {
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

  function ready() {
    $('callsign').value = stored('avara.callsign') || '';
    $('build').textContent = window.AVARA_BUILD || 'dev';
    applyCallsign();
    var q = new URLSearchParams(location.search);
    if (q.get('join') && q.get('peer')) join(q.get('join'), q.get('peer'));
    else if (q.has('host')) host();
    else show('s-menu');
  }

  $('b-solo').onclick = solo;
  $('b-host').onclick = host;
  $('b-msg').onclick = function () { show('s-menu'); };
  $('b-leave').onclick = function () { if (A.mode === 'solo') { A.mode = 'menu'; show('s-menu'); } else leave(); };
  $('b-link').onclick = function () {
    var link = inviteLink();
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
      .then(function () { $('b-link').textContent = 'Link copied'; },
            function () { window.prompt('Invite link:', link); })
      .then(function () { setTimeout(function () { $('b-link').textContent = 'Copy invite link'; }, 1500); });
  };
  $('callsign').addEventListener('change', applyCallsign);
  setInterval(bar, 1000);

  window.AvaraApp = { ready: ready, engineEvent: engineEvent, leave: leave, get state() { return A; } };
})();
