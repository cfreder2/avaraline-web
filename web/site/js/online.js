/*
 * online.js — accounts, who is online, friends, invitations, and Elo kept in the database.
 *
 * Accounts are optional (supabase/005-accounts.sql). A guest plays as before. Signed in,
 * your username is your name in the game, the rounds you play count toward an Elo rating
 * kept in the database, and you can add friends. The device stays an anonymous auth user
 * either way; signing in links it to the account.
 *
 * Who is online: every page announces itself on a Realtime presence channel (nothing is
 * stored): name, account and rating, and what it is doing (menu, solo, hosting or in a
 * game, and which). The Online screen lists everyone, your friends first, and the open
 * games. An invitation is a broadcast on the same channel to one page; the page it is for
 * shows it, with Join.
 *
 * Elo: when a round ends that the game rates (one player or team left), the engine reports
 * the finish order (WebEvent "result"); the host's page sends it to avara_report_result,
 * which rates the seats whose players are signed in (each player's page claimed its own
 * seat, avara_take_seat, on hosting or joining). Each signed-in player's page then reads
 * its new rating and says it in the message area.
 *
 * Desktop games: the Games tab also lists the games people host in the desktop app, from
 * Avaraline's tracker by way of the games Edge Function (supabase/functions/games). They
 * cannot be joined from a browser; each row says so and links the download.
 *
 * online.html uses this file too, to watch (AvaraOnline.watch): it lists, but is not
 * listed and has no buttons.
 *
 * Plain script: it defines window.AvaraOnline.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var TOPIC = 'avara-lobby';
  var KEY = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 18);   // this tab
  var O = {
    watching: false,         // online.html: list, do not announce
    account: null,           // { username, rating, ratedGames, wins, rank } when signed in
    friends: [],             // [{ username, rating, status: friend | asked | asks }]
    people: {},              // presence: key -> [meta]
    games: [],
    desktop: null,           // the desktop app's games (the games function); null until it answers
    desktopAt: 0,
    ch: null,
    lastMeta: '',
    invited: {},             // key -> time we invited them (the button rests a while)
    heard: {},               // sender key -> [times] of invitations, to ignore a flood
    tab: 'people',
    pollTimer: null,
  };

  function lobby() { return window.AvaraLobby; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function button(text, cls, fn) { var b = el('button', cls || 'small', text); b.onclick = fn; return b; }
  function ago(secs) { return secs < 90 ? 'just now' : secs < 3600 ? Math.round(secs / 60) + ' min ago' : secs < 86400 ? Math.round(secs / 3600) + ' h ago' : Math.round(secs / 86400) + ' d ago'; }
  function lc(s) { return String(s || '').toLowerCase(); }
  // a harness page (as telemetry.js decides; online.html has no telemetry): seen only by harness pages
  function synth() {
    if (window.AvaraTelemetry) return AvaraTelemetry.synth;
    return navigator.webdriver || window.__avaraTest ? 'agent' : /[?&](debug|test)\b/.test(location.search) ? 'debug' : null;
  }
  function build() { return window.AvaraTelemetry ? AvaraTelemetry.build : (window.AVARA_BUILD || 'dev'); }
  function message(text) { try { Module.ccall('avara_web_message', null, ['string'], [text]); } catch (e) { /* engine not up */ } }

  // ---- account ----------------------------------------------------------------------------
  function setAccount(a) {
    O.account = a || null;
    AvaraSupa.store('avara.account', a ? JSON.stringify({ username: a.username }) : null);
    var field = $('callsign');
    if (field) {
      if (a) { field.value = a.username; field.disabled = true; field.title = 'Signed in: your username is your name in the game'; }
      else if (field.disabled) { field.disabled = false; field.title = ''; field.value = AvaraSupa.store('avara.callsign') || ''; }
    }
    if (lobby() && lobby().applyCallsign) lobby().applyCallsign();
    if (a) refreshFriends(); else O.friends = [];
    takeSeat();          // a guest who signs in during a game: the seat now counts
    renderBar(); renderAccount(); renderOnline(); announce(true);
  }

  async function refreshMe() {
    var r = await AvaraSupa.rpc('avara_me', {});
    if (r && 'account' in r) setAccount(r.account);
    return r && r.account;
  }

  async function accountCall(fn, body) {
    var r = await AvaraSupa.rpc(fn, body);
    if (!r) return 'Could not reach the server. Check your connection.';
    if (r.error) return r.error;
    if ('account' in r) setAccount(r.account);
    return null;
  }

  function renderBar() {
    var bar = $('acctBar');
    if (!bar) return;
    bar.innerHTML = '';
    if (O.account) {
      bar.append('Signed in as ', el('b', null, O.account.username),
                 O.account.ratedGames ? ' · Elo ' + O.account.rating : ' · no rated rounds yet', ' ',
                 button('Account', 'link', function () { openAccount(); }));
    } else {
      bar.append('Playing as a guest. ', button('Sign in or create an account', 'link', function () { openAccount(); }),
                 ' to keep an Elo rating and add friends.');
    }
  }

  function renderAccount() {
    if (!$('s-account')) return;
    $('acctOut').style.display = O.account ? 'none' : '';
    $('acctIn').style.display = O.account ? '' : 'none';
    if (O.account) {
      var a = O.account;
      $('acctName').textContent = a.username;
      $('acctStats').textContent = a.ratedGames
        ? 'Elo ' + a.rating + (a.rank ? ' · #' + a.rank : '') + ' · ' + a.ratedGames + ' rated round' + (a.ratedGames === 1 ? '' : 's') + ' · ' + a.wins + ' won'
        : 'Elo 1500 to start. Rounds that end with one player or team left are rated.';
    }
  }

  function openAccount() {
    acctMsg('');
    renderAccount();
    lobby().showScreen('s-account');
    if (!O.account) setTimeout(function () { $('acctUser').focus(); }, 0);
  }
  function acctMsg(t, bad) { var m = $('acctMsg'); if (m) { m.textContent = t; m.classList.toggle('bad', !!bad); } }

  async function signIn(create) {
    var u = $('acctUser').value.trim(), p = $('acctPass').value;
    if (!u || !p) { acctMsg('Enter a username and a password.', true); return; }
    acctMsg(create ? 'Creating your account…' : 'Signing in…');
    $('acctSignIn').disabled = $('acctCreate').disabled = true;
    var err = await accountCall(create ? 'avara_register' : 'avara_login', { username: u, password: p });
    $('acctSignIn').disabled = $('acctCreate').disabled = false;
    if (err) { acctMsg(err, true); return; }
    $('acctPass').value = '';
    acctMsg('');
  }

  // ---- presence ---------------------------------------------------------------------------
  function myMeta() {
    var L = lobby() ? lobby().state : { mode: 'menu' };
    var g = (L.mode === 'host' || L.mode === 'client') && L.game ? L.game : null;
    return {
      v: 1, name: (lobby() && lobby().callsign()) || 'Unnamed Player',
      account: O.account ? O.account.username : null,
      rating: O.account && O.account.ratedGames ? O.account.rating : null,
      mode: L.mode, playing: !!L.playing,
      game: g ? { id: g.id, name: g.name, peer: g.peer, players: Math.max(1, (L.roster || []).length) } : null,
      level: L.level && L.level.name || '',
      build: build(), net: lobby() ? lobby().netVersion : 0, synth: synth(),
    };
  }

  function announce(force) {
    if (O.watching || !O.ch) return;
    var m = myMeta(), s = JSON.stringify(m);
    if (!force && s === O.lastMeta) return;
    O.lastMeta = s;
    O.ch.track(m);
  }

  // Everyone else on the channel, one entry per tab; harness pages only for harness pages.
  function others() {
    var out = [], mine = synth();
    Object.keys(O.people).forEach(function (k) {
      if (k === KEY) return;
      var metas = O.people[k];
      var m = metas[metas.length - 1];
      if (!m || m.v !== 1) return;
      if (m.synth && !mine) return;
      out.push(Object.assign({ key: k }, m));
    });
    return out;
  }

  function onSignal(msg) {
    if (!msg || O.watching) return;
    if (msg.t === 'invite' && msg.to === KEY) heardInvite(msg);
    else if (msg.t === 'friend' && O.account && lc(msg.to) === lc(O.account.username)) {
      refreshFriends().then(function () {
        var f = O.friends.filter(function (x) { return lc(x.username) === lc(msg.from); })[0];
        if (f && f.status === 'asks') toast(msg.from + ' wants to be friends.', [['Accept', function () { addFriend(msg.from); }], ['Not now', null]]);
        else if (f && f.status === 'friend') toast(msg.from + ' and you are now friends.', [['OK', null]]);
      });
    }
  }

  function connect() {
    O.ch = AvaraSupa.channel(TOPIC, onSignal, {
      presenceKey: O.watching ? '' : KEY,
      onpresence: function (map) { O.people = map; renderOnline(); renderCount(); },
    });
    announce(true);
  }

  // ---- invitations ------------------------------------------------------------------------
  function invite(p) {
    var L = lobby().state, g = L.game;
    if (!g || !(L.mode === 'host' || L.mode === 'client')) return;
    O.invited[p.key] = Date.now();
    O.ch.send({ t: 'invite', to: p.key, from: lobby().callsign() || 'Someone', account: O.account ? O.account.username : null,
                game: { id: g.id, name: g.name, peer: L.mode === 'host' ? AvaraMesh.hex(AvaraMesh.id) : g.peer },
                build: build(), net: lobby().netVersion });
    message('Invited ' + p.name + ' to the game.');
    renderOnline();
  }

  function heardInvite(msg) {
    var now = Date.now(), from = String(msg.from || 'Someone').slice(0, 24);
    var times = (O.heard[from] || []).filter(function (t) { return now - t < 60000; });
    if (times.length >= 3) return;                      // a flood from one sender: drop it
    O.heard[from] = times.concat(now);
    var g = msg.game;
    if (!g || !g.id || !g.peer) return;
    var L = lobby().state;
    if (L.game && L.game.id === g.id) return;           // already there
    toast(from + (msg.account ? '' : ' (guest)') + ' invites you to ' + String(g.name || 'a game').slice(0, 40) + '.',
          [['Join', function () { joinGame(Object.assign({}, g, { build: msg.build, net: msg.net })); }], ['No thanks', null]], 60000);
  }

  function sameVersion(g) {
    return lobby().tok(g.build) === lobby().tok(build()) && (g.net == null || g.net === lobby().netVersion);
  }

  function joinGame(g) {
    if (g.build && !sameVersion(g)) {
      toast('That game runs a different version of Avara. Whoever loaded the page longer ago should reload it.', [['OK', null]]);
      return;
    }
    var L = lobby().state;
    var go = function () { lobby().join({ id: g.id, name: g.name || 'game', peer: g.peer }); };
    if (L.mode === 'host' || L.mode === 'client') { lobby().leave(); setTimeout(go, 700); }
    else go();
  }

  // A note in the corner, over the game or the menu. actions: [[label, fn or null]].
  function toast(text, actions, ms) {
    var box = $('toasts');
    if (!box) return;
    var t = el('div', 'toast');
    t.append(el('div', 'toast-text', text));
    var row = el('div', 'toast-acts');
    var close = function () { if (t.parentNode) t.parentNode.removeChild(t); };
    (actions || [['OK', null]]).forEach(function (a, i) {
      row.append(button(a[0], i === 0 ? 'small go' : 'small ghost', function () { close(); if (a[1]) a[1](); }));
    });
    t.append(row);
    box.append(t);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(close, ms || 20000);
  }

  // ---- friends ----------------------------------------------------------------------------
  async function refreshFriends() {
    if (!O.account) { O.friends = []; return; }
    var r = await AvaraSupa.rpc('avara_friend_list', {});
    if (Array.isArray(r)) O.friends = r;
    renderOnline(); renderCount();
  }

  async function addFriend(username) {
    var r = await AvaraSupa.rpc('avara_friend_add', { username: username });
    if (!r) { friendMsg('Could not reach the server.', true); return; }
    if (r.error) { friendMsg(r.error, true); return; }
    O.friends = r.friends || [];
    var f = O.friends.filter(function (x) { return lc(x.username) === lc(username); })[0];
    friendMsg(f && f.status === 'friend' ? 'You and ' + f.username + ' are friends.' : 'Asked ' + (f ? f.username : username) + '. They are your friend once they accept.');
    if (O.ch) O.ch.send({ t: 'friend', to: f ? f.username : username, from: O.account.username });
    renderOnline(); renderCount();
  }

  async function removeFriend(username) {
    var r = await AvaraSupa.rpc('avara_friend_remove', { username: username });
    if (r && r.friends) O.friends = r.friends;
    renderOnline(); renderCount();
  }

  function friendMsg(t, bad) { var m = $('friendMsg'); if (m) { m.textContent = t; m.classList.toggle('bad', !!bad); } }

  // ---- what someone is doing ----------------------------------------------------------
  function doing(p) {
    if ((p.mode === 'host' || p.mode === 'client') && p.game) {
      return (p.mode === 'host' ? 'hosting ' : 'in ') + p.game.name + ' · ' + p.game.players + (p.game.players === 1 ? ' player' : ' players') +
             (p.playing ? ' · playing' + (p.level ? ' ' + p.level : '') : '');
    }
    if (p.mode === 'solo') return 'playing solo' + (p.level ? ' · ' + p.level : '');
    return 'in the menu';
  }

  function personRow(p, friend) {
    var L = lobby() ? lobby().state : { mode: 'menu' };
    var row = el('div', 'lvl person');
    var main = el('div', 'lvl-main');
    var title = el('div', 'lvl-title');
    title.append(el('span', 'online-dot' + (p.offline ? ' off' : '')), p.account || p.name);
    if (p.account && p.rating) title.append(el('span', 'elo', ' ' + p.rating));
    if (!p.account && !p.offline) title.append(el('span', 'guest', ' guest'));
    main.append(title, el('div', 'lvl-by', p.offline ? 'offline' : doing(p)));
    row.append(main, el('div'));
    var acts = el('div', 'lvl-acts');
    if (!O.watching && !p.offline) {
      var inMine = L.game && p.game && p.game.id === L.game.id;
      if ((L.mode === 'host' || L.mode === 'client') && L.game && !inMine) {
        var recent = O.invited[p.key] && Date.now() - O.invited[p.key] < 15000;
        var b = button(recent ? 'Invited' : 'Invite', 'small go', function () { invite(p); });
        b.disabled = !!recent || !sameVersion(p);
        if (!sameVersion(p)) b.title = 'They run a different version of Avara';
        acts.append(b);
      }
      if (p.game && !inMine && (p.mode === 'host' || p.mode === 'client')) {
        acts.append(button('Join', 'small', function () { joinGame(Object.assign({}, p.game, { build: p.build, net: p.net })); }));
      }
      if (O.account && p.account && !friend && lc(p.account) !== lc(O.account.username) &&
          !O.friends.some(function (f) { return lc(f.username) === lc(p.account); })) {
        acts.append(button('Add friend', 'small ghost', function () { addFriend(p.account); }));
      }
    }
    row.append(acts);
    return row;
  }

  // ---- the Online screen ------------------------------------------------------------------
  function renderCount() {
    var c = $('onlineCount');
    if (!c) return;
    var n = others().length;
    var asks = O.friends.filter(function (f) { return f.status === 'asks'; }).length;
    c.textContent = (n ? ' · ' + n + ' online' : '') + (asks ? ' · ' + asks + ' friend request' + (asks === 1 ? '' : 's') : '');
  }

  function renderOnline() {
    if (!$('s-online') || !$('s-online').classList.contains('on')) return;
    var people = others();
    var inGames = 0;
    O.games.forEach(function (g) { inGames += g.players; });
    var desk = O.desktop ? O.desktop.length : 0;
    $('onlineSummary').textContent = (people.length + (O.watching ? 0 : 1)) + ' online · ' + O.games.length + ' open game' + (O.games.length === 1 ? '' : 's') +
      ' · ' + inGames + ' playing online' + (desk ? ' · ' + desk + ' desktop game' + (desk === 1 ? '' : 's') : '') +
      (O.today ? ' · today: ' + O.today.playersToday + ' players, ' + O.today.roundsToday + ' rounds' : '');
    ['people', 'games', 'top'].forEach(function (t) {
      $('op-' + t).style.display = O.tab === t ? '' : 'none';
      $('ot-' + t).classList.toggle('on', O.tab === t);
    });
    if (O.tab === 'people') renderPeople(people);
    if (O.tab === 'games') renderGames();
  }

  function renderPeople(people) {
    // friends: signed in, with their presence if they are here
    var fb = $('friendsBox');
    if (fb && !O.watching) {
      // built once: the list below is redrawn whenever anyone comes, goes or changes,
      // and a box redrawn under someone typing in it loses what they typed
      if (!$('friendList')) {
        var guest = el('div', 'hint', 'Sign in to add friends and see when they are on.'); guest.id = 'friendGuest';
        var add = el('div', 'friend-add'); add.id = 'friendAdd';
        var input = el('input', 'text'); input.id = 'friendName'; input.placeholder = 'Username'; input.maxLength = 16;
        input.autocomplete = 'off'; input.spellcheck = false;
        var go = function () { if (input.value.trim()) addFriend(input.value.trim()); };
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
        add.append(input, button('Add friend', 'small go', go));
        var msg = el('div', 'hint', ''); msg.id = 'friendMsg';
        var holder = el('div', 'levels'); holder.id = 'friendList';
        fb.append(el('div', 'set-head', 'Friends'), guest, add, msg, holder);
      }
      $('friendGuest').style.display = O.account ? 'none' : '';
      $('friendAdd').style.display = $('friendMsg').style.display = $('friendList').style.display = O.account ? '' : 'none';
      if (O.account) {
        var list = $('friendList');
        list.innerHTML = '';
        if (!O.friends.length) list.append(el('div', 'empty', 'No friends yet. Add one by username, or with Add friend beside anyone online.'));
        O.friends.forEach(function (f) {
          var here = people.filter(function (p) { return p.account && lc(p.account) === lc(f.username); })[0];
          if (f.status === 'friend') {
            list.append(personRow(here || { account: f.username, rating: f.ratedGames ? f.rating : null, offline: true, name: f.username }, true));
            list.lastChild.querySelector('.lvl-acts').append(button('Remove', 'small ghost', function () { removeFriend(f.username); }));
          } else {
            var row = el('div', 'lvl person');
            var main = el('div', 'lvl-main');
            main.append(el('div', 'lvl-title', f.username), el('div', 'lvl-by', f.status === 'asks' ? 'wants to be friends' : 'asked; waiting for them'));
            var acts = el('div', 'lvl-acts');
            if (f.status === 'asks') acts.append(button('Accept', 'small go', function () { addFriend(f.username); }));
            acts.append(button(f.status === 'asks' ? 'Decline' : 'Cancel', 'small ghost', function () { removeFriend(f.username); }));
            row.append(main, el('div'), acts);
            list.append(row);
          }
        });
      }
    }
    var box = $('peopleList');
    box.innerHTML = '';
    if (!people.length) { box.append(el('div', 'empty', O.watching ? 'Nobody is on right now.' : 'Nobody else is on right now.')); return; }
    var rank = function (p) { return (p.mode === 'host' || p.mode === 'client') ? 0 : p.mode === 'solo' ? 1 : 2; };
    people.sort(function (a, b) { return rank(a) - rank(b) || lc(a.account || a.name).localeCompare(lc(b.account || b.name)); });
    people.forEach(function (p) { box.append(personRow(p, false)); });
  }

  async function loadGames() {
    var r = await AvaraSupa.rpc('avara_list_games', { synth: synth() });
    if (Array.isArray(r)) O.games = r;
    renderOnline();
  }

  function renderGames() {
    var box = $('onlineGames');
    box.innerHTML = '';
    if (O.desktop) box.append(el('div', 'set-head', 'Browser games'));
    if (!O.games.length) box.append(el('div', 'empty', 'No open games right now.'));
    O.games.forEach(function (g) {
      var row = el('div', 'lvl person');
      var main = el('div', 'lvl-main');
      main.append(el('div', 'lvl-title', g.name),
                  el('div', 'lvl-by', (g.hostName ? 'hosted by ' + g.hostName + ' · ' : '') + g.players + '/' + g.maxPlayers + ' players' +
                                     (g.level ? ' · ' + g.level : '') + (g.status === 'playing' ? ' · round in progress' : '') + ' · started ' + ago(g.ageSecs)));
      var acts = el('div', 'lvl-acts');
      if (!O.watching) {
        var L = lobby().state;
        var mine = L.game && L.game.id === g.id;
        var b = button(mine ? 'You are here' : 'Join', 'small go', function () { joinGame(g); });
        b.disabled = mine || g.players >= g.maxPlayers || !sameVersion(g);
        if (!sameVersion(g)) b.title = 'A different version of Avara: reload the page';
        acts.append(b);
      }
      row.append(main, el('div'), acts);
      box.append(row);
    });
    if (O.desktop) {
      box.append(el('div', 'set-head', 'Desktop games'));
      if (!O.desktop.length) box.append(el('div', 'empty', 'No desktop games right now.'));
      O.desktop.forEach(function (g) { box.append(desktopRow(g)); });
    }
  }

  // ---- desktop games ----------------------------------------------------------------------
  // The tracker sends no CORS headers, so a page cannot ask it; the games function does,
  // at most every 15 s, and answers in the tracker's own JSON (supabase/functions/games).
  // The page asks it as often, while the Online screen is up and the tab visible. If the
  // function or the tracker cannot be reached, the section is left out and nothing is said.
  // The tracker lists a game by its host's address and port: never shown.
  var DESKTOP_EVERY_MS = 15000;
  var DESKTOP_APP = 'https://github.com/avaraline/Avara/releases';   // Avaraline's downloads, Mac and Windows
  function loadDesktop() {
    if (document.hidden || Date.now() - O.desktopAt < DESKTOP_EVERY_MS - 1000) return;
    O.desktopAt = Date.now();
    AvaraSupa.fn('games').then(function (r) {
      O.desktop = r && Array.isArray(r.games) && !r.desktop_error
        ? r.games.filter(function (g) { return g && g.kind === 'desktop'; }) : null;
      renderOnline();
    });
  }

  // what a host typed can still hold an address: blank it out
  function noAddress(s) { return String(s || '').replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '…'); }

  function desktopRow(g) {
    var names = (Array.isArray(g.players) ? g.players : []).map(noAddress).filter(Boolean);
    // the desktop app starts the description with 6 characters of its build: "b139fe: ",
    // or "b139fe\*: " when modified (src/game/CAvaraApp.cpp, TrackerUpdate)
    var desc = noAddress(g.description).replace(/^[\w.-]{6}(\\\*)?:( |$)/, '').trim();
    var secs = Math.max(0, (Date.now() - Date.parse(g.first_seen)) / 1000);
    var row = el('div', 'lvl person');
    var main = el('div', 'lvl-main');
    main.append(el('div', 'lvl-title', desc || (names[0] ? names[0] + "'s game" : 'Desktop game')),
                el('div', 'lvl-by', (names.length ? names.join(', ') + ' · ' : '') + names.length + (names.length === 1 ? ' player' : ' players') +
                                   (g.password ? ' · password' : '') + (isNaN(secs) ? '' : ' · started ' + ago(secs))));
    var acts = el('div', 'lvl-acts');
    var a = el('a', 'applink', 'Needs the desktop app');
    a.href = DESKTOP_APP; a.target = '_blank'; a.rel = 'noopener';
    a.title = 'Hosted in the Avara app for Mac and Windows, and joined from it';
    acts.append(a);
    row.append(main, el('div'), acts);
    return row;
  }

  async function loadTop() {
    var lb = await AvaraSupa.rpc('avara_leaderboard', { limit: 25 });
    var box = $('topList');
    box.innerHTML = '';
    if (!Array.isArray(lb) || !lb.length) box.append(el('div', 'empty', 'No rated rounds yet. Rounds that end with one player or team left count, for players signed in.'));
    else lb.forEach(function (a, i) {
      var row = el('div', 'lvl person');
      var main = el('div', 'lvl-main');
      main.append(el('div', 'lvl-title', (i + 1) + '. ' + a.username), el('div', 'lvl-by', a.ratedGames + ' rated round' + (a.ratedGames === 1 ? '' : 's') + ' · ' + a.wins + ' won'));
      row.append(main, el('div'), el('div', 'elo big', String(a.rating)));
      if (O.account && lc(a.username) === lc(O.account.username)) row.classList.add('me');
      box.append(row);
    });
    var recent = await AvaraSupa.rpc('avara_recent_results', { limit: 10, synth: synth() });
    var rb = $('recentList');
    if (!rb) return;
    rb.innerHTML = '';
    if (Array.isArray(recent) && recent.length) {
      rb.append(el('div', 'set-head', 'Latest rated rounds'));
      recent.forEach(function (r) {
        var order = (r.players || []).slice().reverse();      // first place first
        var line = order.map(function (p) {
          var d = p.account ? Math.round(p.after - p.before) : null;
          return p.name + (d != null ? ' (' + (d >= 0 ? '+' : '') + d + ')' : '');
        }).join(', ');
        var row = el('div', 'lvl person');
        var main = el('div', 'lvl-main');
        main.append(el('div', 'lvl-title', r.level || 'a level'), el('div', 'lvl-by', line + ' · ' + ago(r.ageSecs)));
        row.append(main);
        rb.append(row);
      });
    }
  }

  function setTab(t) {
    O.tab = t;
    if (t === 'games') loadGames();
    if (t === 'top') loadTop();
    renderOnline();
  }

  function openOnline() {
    lobby().showScreen('s-online');
    refreshFriends();
    loadGames();
    loadDesktop();
    AvaraSupa.rpc('avara_now', {}).then(function (r) { if (r && !r.error) { O.today = r; renderOnline(); } });
    setTab(O.tab);
    clearInterval(O.pollTimer);
    O.pollTimer = setInterval(function () {
      if (!$('s-online').classList.contains('on') || $('overlay').classList.contains('hidden')) { clearInterval(O.pollTimer); return; }
      loadGames();
      loadDesktop();                // every third time: it keeps its own 15 s
    }, 5000);
  }

  // ---- seats and ratings ------------------------------------------------------------------
  var seat = null;   // { game, slot } while in a game
  function takeSeat() {
    if (!seat || O.watching) return;
    AvaraSupa.rpc('avara_take_seat', { game: seat.game, slot: seat.slot, name: lobby().callsign() || '' });
  }

  async function ratingAfterRound(tries) {
    if (!O.account) return;
    var before = O.account.ratedGames, was = O.account.rating;
    var r = await AvaraSupa.rpc('avara_me', {});
    var a = r && r.account;
    if (!a) return;
    if (a.ratedGames === before && a.rating === was) {
      if (tries > 0) setTimeout(function () { ratingAfterRound(tries - 1); }, 4000);
      return;
    }
    setAccount(a);
    var d = a.rating - was;
    message('Elo ' + a.rating + ' (' + (d >= 0 ? '+' : '') + d + ')' + (a.rank ? ', #' + a.rank : ''));
  }

  function engineEvent(kind, d) {
    if (O.watching) return;
    var L = lobby().state;
    if (kind === 'net') {
      if ((d.state === 'hosting' || d.state === 'connected') && L.game) { seat = { game: L.game.id, slot: d.slot }; takeSeat(); }
      else if (d.state === 'offline') seat = null;
    } else if (kind === 'result' && L.game && (L.mode === 'host' || L.mode === 'client')) {
      if (L.mode === 'host' && d.players && d.players.length >= 2) {
        AvaraSupa.rpc('avara_report_result', { id: crypto.randomUUID(), game: L.game.id, level: L.level.name, levelSet: L.level.set, players: d.players });
      }
      if (O.account) setTimeout(function () { ratingAfterRound(1); }, 2500);
    }
  }

  // ---- wiring -----------------------------------------------------------------------------
  function ready() {
    var cached = null;
    try { cached = JSON.parse(AvaraSupa.store('avara.account') || 'null'); } catch (e) {}
    if (cached && cached.username) setAccount({ username: cached.username, rating: 1500, ratedGames: 0, wins: 0 });
    renderBar();
    refreshMe();
    connect();
    setInterval(announce, 2000);
  }

  function wire() {
    if ($('b-online')) $('b-online').onclick = function () { lobby().applyCallsign(); openOnline(); };
    if ($('netchipOnline')) $('netchipOnline').onclick = openOnline;
    if ($('onlineBack')) $('onlineBack').onclick = function () { lobby().back(); };
    ['people', 'games', 'top'].forEach(function (t) { if ($('ot-' + t)) $('ot-' + t).onclick = function () { setTab(t); }; });
    if ($('acctSignIn')) {
      $('acctSignIn').onclick = function () { signIn(false); };
      $('acctCreate').onclick = function () { signIn(true); };
      $('acctPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') signIn(false); });
      $('acctUser').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('acctPass').focus(); });
      $('acctSignOut').onclick = async function () { await accountCall('avara_logout', {}); renderAccount(); };
      $('acctBack').onclick = function () { lobby().back(); };
      $('acctPwGo').onclick = async function () {
        var err = await AvaraSupa.rpc('avara_change_password', { old: $('acctPwOld').value, password: $('acctPwNew').value });
        $('acctPwMsg').textContent = !err ? 'Could not reach the server.' : err.error || 'Password changed.';
        if (err && !err.error) { $('acctPwOld').value = ''; $('acctPwNew').value = ''; }
      };
      $('acctDelGo').onclick = async function () {
        var e = await accountCall('avara_delete_account', { password: $('acctDelPw').value });
        $('acctDelMsg').textContent = e || '';
        if (!e) { $('acctDelPw').value = ''; acctMsg('Your account is deleted.'); }
      };
    }
  }

  // online.html: watch everyone, without being listed.
  function watch() {
    O.watching = true;
    O.tab = 'people';
    $('s-online').classList.add('on');
    ['people', 'games', 'top'].forEach(function (t) { if ($('ot-' + t)) $('ot-' + t).onclick = function () { setTab(t); }; });
    connect();
    var refresh = function () {
      loadGames();
      AvaraSupa.rpc('avara_now', {}).then(function (r) { if (r && !r.error) { O.today = r; renderOnline(); } });
      if (O.tab === 'top') loadTop();
    };
    refresh();
    setInterval(refresh, 10000);
    loadDesktop();
    setInterval(loadDesktop, DESKTOP_EVERY_MS);
    document.addEventListener('visibilitychange', loadDesktop);   // back on the tab: catch up
  }

  wire();

  window.AvaraOnline = {
    ready: ready,
    watch: watch,
    engineEvent: engineEvent,
    open: openOnline,
    openAccount: openAccount,
    get account() { return O.account; },
    get people() { return others(); },
    get friends() { return O.friends; },
    get key() { return KEY; },
  };
})();
