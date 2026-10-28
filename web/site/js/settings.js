/*
 * settings.js — the Settings screen, and keeping settings between visits.
 *
 * The engine keeps its preferences in /libsdl/Avaraline/Avara/prefs.json, read once at
 * startup, before main(). In a tab that file system is gone when the tab closes, so the
 * page keeps a copy in localStorage: restore() writes it back before the engine starts
 * (Module.preRun), and save() asks the engine to write the file and copies it out, after
 * every change here and as the page goes away (which also keeps anything set with /pref).
 *
 * Changes are applied through avara_web_set_pref, the same path as the /pref command, so
 * each takes effect the way it does on the desktop (key bindings at once; field of view
 * and volume from the next round).
 *
 * "Connect only through the host" is the page's own setting (mesh.js): players see the IP
 * address of everyone they connect to directly, so with it on, only the host sees yours.
 *
 * Plain script; defines window.AvaraSettings.
 */
(function () {
  'use strict';

  var STORE = 'avara.prefs.v1';
  var FILES = 'avara.file.';     // the engine's other saved files: playerRatings.json (Elo), tags.json
  var DIR = '/libsdl/Avaraline/Avara', FILE = DIR + '/prefs.json';
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  // The bindings players change, in the order shown; defaults mirror src/gui/Preferences.h.
  var ACTIONS = [
    ['forward', 'Forward', ['W', 'Up']], ['backward', 'Back', ['S', 'Down']],
    ['left', 'Turn left', ['A', 'Left']], ['right', 'Turn right', ['D', 'Right']],
    ['jump', 'Jump', ['Space', 'B', 'N', 'M', ',']], ['boost', 'Boost', 'Left Shift'],
    ['loadMissile', 'Load missile', 'Q'], ['loadGrenade', 'Load grenade', ['E', 'Right Mouse']],
    ['fire', 'Fire loaded weapon', ['E', 'Right Mouse']],
    ['scoutView', 'Third-person drone', 'Tab'], ['heloControl', 'Fly the drone', 'C'],
    ['freeCamUp', 'Drone / camera up', 'R'], ['freeCamDown', 'Drone / camera down', 'F'],
    ['verticalMotion', 'Look up / down', 'Left Ctrl'], ['aimForward', 'Aim forward', '2'],
    ['lookLeft', 'Look left', '1'], ['lookRight', 'Look right', '3'],
    ['zoomIn', 'Zoom in', '='], ['zoomOut', 'Zoom out', '-'],
    ['scoreboard', 'Scoreboard', '/'], ['chatMode', 'Chat', 'Return'],
    ['pause', 'Pause', 'Escape'], ['abort', 'Self-destruct', '0'],
    ['toggleFreeCam', 'Free camera (spectating)', 'V'],
    ['spectateNext', 'Spectate next', ']'], ['spectatePrevious', 'Spectate previous', '['],
  ];

  // KeyboardEvent.code -> the name SDL_GetKeyFromName knows
  function sdlName(e) {
    var c = e.code, m;
    if ((m = /^Key([A-Z])$/.exec(c))) return m[1];
    if ((m = /^Digit(\d)$/.exec(c))) return m[1];
    if ((m = /^F(\d+)$/.exec(c))) return 'F' + m[1];
    if ((m = /^Numpad(\d)$/.exec(c))) return 'Keypad ' + m[1];
    var named = {
      Space: 'Space', Enter: 'Return', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace',
      ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
      AltLeft: 'Left Alt', AltRight: 'Right Alt', MetaLeft: 'Left GUI', MetaRight: 'Right GUI',
      ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']', Slash: '/', Backslash: '\\',
      Comma: ',', Period: '.', Semicolon: ';', Quote: "'", Backquote: '`', CapsLock: 'CapsLock',
      Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete',
      NumpadEnter: 'Keypad Enter', NumpadAdd: 'Keypad +', NumpadSubtract: 'Keypad -',
    };
    return named[c] || null;
  }

  // The engine's preferences, all of them. A first visit has no file until the engine
  // writes one, so ask it to: changing one key from a partial map would wipe the rest.
  function read() {
    try { return JSON.parse(Module.FS.readFile(FILE, { encoding: 'utf8' })); } catch (e) { /* not written yet */ }
    try {
      Module.ccall('avara_web_save_prefs', null, [], []);
      return JSON.parse(Module.FS.readFile(FILE, { encoding: 'utf8' }));
    } catch (e) { return null; }
  }

  // Before the engine starts: put last visit's preferences where it will read them.
  function restore() {
    try { Module.FS.mkdirTree(DIR); } catch (e) {}
    var text = AvaraSupa.store(STORE);
    if (text) {
      try {
        var prefs = JSON.parse(text);
        delete prefs.defaultArgs;            // the page decides what the engine boots into
        Module.FS.writeFile(FILE, JSON.stringify(prefs));
      } catch (e) { console.warn('[avara] stored settings unreadable; using defaults', e); }
    }
    // Elo ratings and level tags, kept the same way
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k.indexOf(FILES) === 0) Module.FS.writeFile(DIR + '/' + k.slice(FILES.length), localStorage.getItem(k));
      }
    } catch (e) { /* no storage */ }
  }

  function save() {
    try {
      Module.ccall('avara_web_save_prefs', null, [], []);
      var text = Module.FS.readFile(FILE, { encoding: 'utf8' });
      // while hosting, js/latency.js sets the latency tolerance floor from the round trip;
      // what is kept is the player's own
      var own = window.AvaraLatency && AvaraLatency.own();
      if (text && typeof own === 'number') {
        var prefs = JSON.parse(text);
        prefs.latencyToleranceMin = own;
        text = JSON.stringify(prefs);
      }
      if (text) AvaraSupa.store(STORE, text);
      Module.FS.readdir(DIR).forEach(function (name) {
        if (!/\.json$/.test(name) || name === 'prefs.json') return;
        var body = Module.FS.readFile(DIR + '/' + name, { encoding: 'utf8' });
        if (body && body.length < 200000) AvaraSupa.store(FILES + name, body);
      });
    } catch (e) { /* engine not up yet */ }
  }

  function set(name, value) {
    var ok = Module.ccall('avara_web_set_pref', 'number', ['string', 'string'], [name, JSON.stringify(value)]);
    if (!ok) console.warn('[avara] setting refused', name, value);
    save();
    return ok;
  }

  // ---- the screen ----------------------------------------------------------------------
  var capturing = null;   // { action, button } while waiting for a key

  function slider(label, min, max, step, value, fmt, onchange, note) {
    var row = el('label', 'set-row');
    var out = el('span', 'set-val', fmt(value));
    var inp = el('input'); inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = value;
    inp.oninput = function () { out.textContent = fmt(+inp.value); };
    inp.onchange = function () { onchange(+inp.value); };
    row.append(el('span', 'set-name', label), inp, out);
    if (note) row.title = note;
    return row;
  }
  function toggle(label, value, onchange, note) {
    var row = el('label', 'set-row');
    var inp = el('input'); inp.type = 'checkbox'; inp.checked = !!value;
    inp.onchange = function () { onchange(inp.checked); };
    row.append(el('span', 'set-name', label), inp, el('span', 'set-val', ''));
    if (note) { var n = el('div', 'set-note', note); var wrap = el('div'); wrap.append(row, n); return wrap; }
    return row;
  }

  function keysOf(map, action) { var k = map[action]; return k == null ? [] : Array.isArray(k) ? k : [k]; }

  function render() {
    var prefs = read() || {};
    var box = $('settingsBody');
    box.innerHTML = '';

    box.appendChild(el('div', 'set-head', 'Controls'));
    box.appendChild(slider('Mouse sensitivity', -3, 3, 0.25, prefs.mouseSensitivity || 0,
      function (v) { return '×' + Math.pow(2, v).toFixed(2).replace(/\.?0+$/, ''); }, function (v) { set('mouseSensitivity', v); }));
    box.appendChild(toggle('Invert mouse up / down', prefs.invertYAxis, function (v) { set('invertYAxis', v); }));

    box.appendChild(el('div', 'set-head', 'Display and sound'));
    box.appendChild(slider('Field of view', 30, 100, 1, prefs.fov || 50, function (v) { return Math.round(v) + '°'; },
      function (v) { set('fov', v); }, 'From the next round'));
    box.appendChild(slider('Volume', 0, 100, 5, prefs.soundVolume == null ? 100 : prefs.soundVolume, function (v) { return Math.round(v) + '%'; },
      function (v) { set('soundVolume', Math.round(v)); }, 'From the next round'));
    box.appendChild(slider('HUD opacity', 0.2, 1, 0.05, prefs.hudAlpha == null ? 1 : prefs.hudAlpha, function (v) { return Math.round(v * 100) + '%'; },
      function (v) { set('hudAlpha', v); }));
    box.appendChild(toggle('Show frame rate', window.AvaraFps && AvaraFps.shown, function (v) {
      if (window.AvaraFps) AvaraFps.show(v);
    }, 'Top right, during a round: frames a second, the lowest it dipped to (its slowest frame), and the drawing resolution. F8 (fn+F8 on a Mac) does the same.'));
    box.appendChild(toggle('Smooth edges (anti-aliasing)', AvaraSupa.store('avara.msaa') !== '0', function (v) {
      AvaraSupa.store('avara.msaa', v ? '1' : '0');
    }, 'Takes effect the next time the page loads. Off by itself on software graphics, where it halves the frame rate.'));
    var cb = el('label', 'set-row');
    var sel = el('select', 'text');
    ['Off', 'Deuteranopia', 'Protanopia', 'Tritanopia'].forEach(function (n, i) { var o = el('option', null, n); o.value = i; sel.appendChild(o); });
    sel.value = prefs.colorBlindMode || 0;
    sel.onchange = function () { set('colorBlindMode', +sel.value); };
    cb.append(el('span', 'set-name', 'Colour-blind colours'), sel, el('span', 'set-val', ''));
    box.appendChild(cb);

    box.appendChild(el('div', 'set-head', 'Online'));
    box.appendChild(toggle('Connect only through the host', AvaraSupa.store('avara.hostOnly') === '1', function (v) {
      AvaraSupa.store('avara.hostOnly', v ? '1' : '0');
    }, 'Other players can see the IP address of anyone they connect to directly. With this on, only the host sees yours; the others reach you through the host, which can add a little delay. Applies to the next game you join.'));
    box.appendChild(toggle('Send play statistics', AvaraSupa.store('avara.offline') !== '1', function (v) {
      AvaraSupa.store('avara.offline', v ? '0' : '1');
      AvaraTelemetry.setEnabled(v);
    }, 'Rounds played, frame rate, and whether joining games works, to find bugs. No IP or e-mail addresses. The full list: github.com/cfreder2/avaraline-web#privacy'));

    box.appendChild(el('div', 'set-head', 'Keys'));
    var map = prefs.keyboard || {};
    var grid = el('div', 'keys');
    ACTIONS.forEach(function (a) {
      var row = el('div', 'key-row');
      var keys = el('button', 'key-btn', keysOf(map, a[0]).join(', ') || '—');
      keys.title = 'Click, then press the key (or click the mouse button) to use. Esc cancels.';
      keys.onclick = function () {
        if (capturing) capturing.button.textContent = capturing.was;
        capturing = { action: a[0], button: keys, was: keys.textContent };
        keys.textContent = 'press a key…';
        keys.classList.add('wait');
      };
      row.append(el('span', 'key-name', a[1]), keys);
      grid.appendChild(row);
    });
    box.appendChild(grid);
    var reset = el('button', 'link', 'Reset keys to the defaults');
    reset.onclick = function () {
      var prefs = read();
      if (!prefs || !prefs.keyboard) return;
      var m = Object.assign({}, prefs.keyboard);
      ACTIONS.forEach(function (a) { m[a[0]] = a[2]; });
      set('keyboard', m);
      render();
    };
    box.appendChild(reset);
  }

  function finishCapture(name) {
    var c = capturing;
    capturing = null;
    c.button.classList.remove('wait');
    if (!name) { c.button.textContent = c.was; return; }
    var prefs = read();
    if (!prefs || !prefs.keyboard) { c.button.textContent = c.was; return; }   // never write a partial map
    var m = Object.assign({}, prefs.keyboard);
    // one key for this action; a key taken from another action is given up there
    Object.keys(m).forEach(function (act) {
      if (act === c.action) return;
      var ks = keysOf(m, act).filter(function (k) { return k !== name; });
      m[act] = ks.length === 1 ? ks[0] : ks;
    });
    m[c.action] = name;
    set('keyboard', m);
    render();
  }

  window.addEventListener('keydown', function (e) {
    if (!capturing) return;
    e.preventDefault(); e.stopPropagation();
    if (e.code === 'Escape') return finishCapture(null);
    var n = sdlName(e);
    if (n) finishCapture(n);
  }, true);
  window.addEventListener('mousedown', function (e) {
    if (!capturing || e.target === capturing.button) return;
    if (e.button === 2) { e.preventDefault(); finishCapture('Right Mouse'); }
    else if (e.button === 1) { e.preventDefault(); finishCapture('Middle Mouse'); }
  }, true);
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', function () { if (document.hidden) save(); });

  function open() {
    AvaraLobby.showScreen('s-settings');
    $('settingsBack').textContent = AvaraLobby.state.mode === 'menu' ? '← Back' : '← Back to the game';
    render();
  }

  function wire() { $('settingsBack').onclick = function () { save(); AvaraLobby.back(); }; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  window.AvaraSettings = { restore: restore, save: save, open: open, set: set };
})();
