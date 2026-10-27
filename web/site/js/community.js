/*
 * community.js — levels players make: upload, browse, play, star, upvote.
 *
 * A community level is a set, like the built-in ones, named "community-<8 hex>" (from its
 * id). Its files travel as one gzipped pack (the same format tools/pack_levels.mjs makes),
 * built here in the uploader's browser from an .alf file or a whole set folder, kept in
 * the public Storage bucket `avara-levels`, and described by a row in avara_levels
 * (supabase/003-community-levels.sql).
 *
 * Uploading: choose the file(s), give it a title, and Try it: the pack is installed in
 * this tab and loaded, so the uploader plays it before anyone else can. Only a level that
 * loaded can be published. Publishing uploads the pack, then records the row.
 *
 * Playing: the engine is asked to load the set like any other (avara_web_load); it asks
 * levels.js for the set, and the source registered here fetches the pack from Storage.
 * In a game with others the host's load goes to everyone, and each of their pages
 * fetches the pack the same way, by set name (avara_get_level).
 *
 * Stars are favorites: a player's own list, with the count shown. Upvotes rank levels.
 * Plays are counted by the server, once per player per level per 10 minutes.
 *
 * Plain script; defines window.AvaraCommunity.
 */
(function () {
  'use strict';

  var BUCKET = 'avara-levels';
  var MAX_BYTES = 5 * 1024 * 1024;
  var known = {};          // set name -> level row (from listings and lookups)
  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  var tab = 'community', sort = 'top', query = '', searchTimer = null;

  function setNameFor(id) { return 'community-' + id.replace(/-/g, '').slice(0, 8); }

  // levels.js asks us for community sets.
  AvaraLevels.addSource(function (set) {
    if (set.indexOf('community-') !== 0) return null;
    return (async function () {
      var row = known[set];
      if (!row) row = await AvaraSupa.rpc('avara_get_level', { set: set });
      if (!row || !row.path) throw new Error('this community level no longer exists');
      known[set] = row;
      var r = await fetch(AvaraSupa.publicUrl(BUCKET, row.path));
      if (!r.ok) throw new Error('download failed (' + r.status + ')');
      return { bytes: new Uint8Array(await r.arrayBuffer()), deps: row.deps || [] };
    })();
  });

  // Load a level for this game: alone from the menu, or for everyone when in a game.
  function play(set, alf) {
    if (AvaraLobby.state.mode === 'menu') AvaraLobby.enterSolo();
    else AvaraLobby.closeOverlay();
    Module.ccall('avara_web_load', null, ['string', 'string'], [set, alf]);
  }

  // A round started: count a play for a community level.
  function roundStarted(set) {
    if (set && set.indexOf('community-') === 0) AvaraSupa.rpc('avara_level_played', { set: set });
  }

  // ---- the screen ----------------------------------------------------------------------
  function open(which) {
    tab = which || tab;
    AvaraLobby.showScreen('s-levels');
    ['community', 'library', 'upload'].forEach(function (t) {
      $('lt-' + t).classList.toggle('on', t === tab);
      $('lp-' + t).style.display = t === tab ? '' : 'none';
    });
    $('levelsBack').textContent = AvaraLobby.state.mode === 'menu' ? '← Back' : '← Back to the game';
    if (tab === 'community') listCommunity();
    if (tab === 'library') listLibrary();
  }

  function stat(cls, icon, n, on, title, onclick) {
    var b = el('button', 'stat ' + cls + (on ? ' on' : ''));
    b.title = title;
    b.append(el('span', 'i', icon), el('span', 'n', String(n)));
    if (onclick) b.onclick = function (e) { e.stopPropagation(); onclick(b); }; else b.disabled = true;
    return b;
  }

  async function listCommunity() {
    var box = $('communityList');
    box.innerHTML = '<div class="empty">Loading levels…</div>';
    var rows = await AvaraSupa.rpc('avara_list_levels', { sort: sort, q: query, synth: AvaraTelemetry.synth });
    box.innerHTML = '';
    if (!Array.isArray(rows)) {
      box.innerHTML = '<div class="empty">Could not reach the level list. Check your connection.</div>';
      return;
    }
    if (!rows.length) {
      box.appendChild(el('div', 'empty', sort === 'favorites' ? 'No starred levels yet. Star a level to keep it here.'
        : sort === 'mine' ? 'You have not published a level yet. Make one in the Upload tab.'
        : query ? 'No levels match "' + query + '".' : 'No community levels yet. Be the first: Upload.'));
      return;
    }
    rows.forEach(function (lv) {
      known[lv.set] = lv;
      var row = el('div', 'lvl');
      var main = el('div', 'lvl-main');
      main.append(el('div', 'lvl-title', lv.title),
                  el('div', 'lvl-by', 'by ' + (lv.authorName || 'anonymous') + (lv.levels > 1 ? ' · ' + lv.levels + ' levels' : '')));
      if (lv.description) main.appendChild(el('div', 'lvl-desc', lv.description));
      var stats = el('div', 'lvl-stats');
      stats.append(
        stat('up', '▲', lv.upvotes, lv.upvoted, lv.upvoted ? 'Remove your upvote' : 'Upvote', function (b) {
          var on = !b.classList.contains('on');
          b.classList.toggle('on', on);
          AvaraSupa.rpc('avara_vote_level', { id: lv.id, on: on }).then(function (r) { if (r) b.querySelector('.n').textContent = r.upvotes; });
        }),
        stat('star', '★', lv.favorites, lv.favorited, lv.favorited ? 'Unstar' : 'Star: keep it in your favorites', function (b) {
          var on = !b.classList.contains('on');
          b.classList.toggle('on', on);
          AvaraSupa.rpc('avara_favorite_level', { id: lv.id, on: on }).then(function (r) { if (r) b.querySelector('.n').textContent = r.favorites; });
        }),
        stat('plays', '▶', lv.plays, false, 'Times played'));
      var acts = el('div', 'lvl-acts');
      var playBtn = el('button', 'small go', AvaraLobby.state.mode === 'host' ? 'Load for all' : 'Play');
      playBtn.onclick = function () { play(lv.set, lv.alf); };
      acts.appendChild(playBtn);
      if (lv.mine) {
        var del = el('button', 'small', 'Delete');
        del.onclick = async function () {
          if (!confirm('Delete "' + lv.title + '" for everyone?')) return;
          await AvaraSupa.rpc('avara_delete_level', { id: lv.id });
          await AvaraSupa.remove(BUCKET, lv.path);
          listCommunity();
        };
        acts.appendChild(del);
      } else {
        var rep = el('button', 'small ghost', '⚑');
        rep.title = 'Report this level';
        rep.onclick = function () {
          var why = prompt('Report "' + lv.title + '": what is wrong with it?');
          if (why === null) return;
          AvaraSupa.rpc('avara_report_level', { id: lv.id, reason: why }).then(function () { rep.textContent = 'Reported'; rep.disabled = true; });
        };
        acts.appendChild(rep);
      }
      row.append(main, stats, acts);
      box.appendChild(row);
    });
  }

  // The built-in library, set by set, with how often each level has been played.
  async function listLibrary() {
    var box = $('libraryList');
    box.innerHTML = '<div class="empty">Loading…</div>';
    var idx = await AvaraLevels.index().catch(function () { return null; });
    var plays = (await AvaraSupa.rpc('avara_library_plays', {})) || {};
    box.innerHTML = '';
    if (!idx) { box.innerHTML = '<div class="empty">Could not read the level list.</div>'; return; }
    var sets = Object.keys(idx.sets).sort(function (a, b) { return a.toLowerCase() < b.toLowerCase() ? -1 : 1; });
    sets.forEach(function (set) {
      var manifest;
      try { manifest = JSON.parse(Module.FS.readFile('/levels/' + set + '/set.json', { encoding: 'utf8' })); } catch (e) { return; }
      var levels = manifest.LEDI || [];
      var total = levels.reduce(function (s, l) { return s + (plays[set + '/' + l.Name] || 0); }, 0);
      var det = el('details', 'set');
      var sum = el('summary');
      sum.append(el('span', 'set-name', set), el('span', 'set-meta',
        levels.length + (levels.length === 1 ? ' level' : ' levels') +
        (idx.sets[set].bytes ? ' · ' + (idx.sets[set].bytes / 1048576).toFixed(1) + ' MB' : '') +
        (total ? ' · ▶ ' + total : '')));
      det.appendChild(sum);
      det.addEventListener('toggle', function () {
        if (!det.open || det.dataset.filled) return;
        det.dataset.filled = '1';
        levels.forEach(function (l) {
          var b = el('button', 'lib-level');
          b.append(el('span', 'lib-name', l.Name), el('span', 'lib-plays', '▶ ' + (plays[set + '/' + l.Name] || 0)));
          if (l.Message) b.title = l.Message;
          b.onclick = function () { play(set, l.Alf); };
          det.appendChild(b);
        });
      });
      box.appendChild(det);
    });
  }

  // ---- uploading -----------------------------------------------------------------------
  var draft = null;   // { id, set, files:[{path,data}], alf, levelName, levels, deps, tested }

  async function readFiles(list) {
    var files = Array.from(list);
    if (!files.length) return null;
    var out = [], hasFolder = files.some(function (f) { return f.webkitRelativePath; });
    for (var i = 0; i < files.length; i++) {
      var f = files[i], rel = f.webkitRelativePath || f.name;
      if (hasFolder) rel = rel.split('/').slice(1).join('/');     // drop the chosen folder's own name
      if (!rel || /(^|\/)\./.test(rel) || /\.r$/.test(rel)) continue;
      out.push({ path: rel, data: new Uint8Array(await f.arrayBuffer()) });
    }
    return out;
  }

  // Make a set from what was chosen: a folder with a set.json, or .alf file(s) alone.
  function shapeDraft(files, title, desc) {
    var setJson = files.find(function (f) { return f.path === 'set.json'; });
    var manifest;
    if (setJson) {
      manifest = JSON.parse(new TextDecoder().decode(setJson.data));
      if (!manifest.LEDI || !manifest.LEDI.length) throw new Error('set.json lists no levels (LEDI)');
    } else {
      var alfs = files.filter(function (f) { return /\.alf$/i.test(f.path); });
      if (!alfs.length) throw new Error('choose an .alf level file, or a folder with a set.json');
      files = files.map(function (f) { return /\.alf$/i.test(f.path) && f.path.indexOf('/') < 0 ? { path: 'alf/' + f.path, data: f.data } : f; });
      manifest = { LEDI: alfs.map(function (f, i) {
        var base = f.path.split('/').pop();
        return { Alf: base, Name: alfs.length === 1 ? (title || base.replace(/\.alf$/i, '')) : base.replace(/\.alf$/i, ''), Message: i === 0 ? desc : '' };
      }) };
      files.push({ path: 'set.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
    }
    var first = manifest.LEDI[0];
    if (!files.some(function (f) { return f.path === 'alf/' + first.Alf || f.path.endsWith('/' + first.Alf); }))
      throw new Error('the level file ' + first.Alf + ' named in set.json is missing');
    return {
      files: files, alf: first.Alf, levelName: first.Name, levels: manifest.LEDI.length,
      deps: (manifest.REQD || []).map(function (r) { return r.Package; }).filter(Boolean),
    };
  }

  async function makePack(files) {
    var header = { files: [] }, off = 0;
    files.forEach(function (f) { header.files.push([f.path, off, f.data.length]); off += f.data.length; });
    var head = new TextEncoder().encode(JSON.stringify(header));
    var raw = new Uint8Array(4 + head.length + off);
    raw[0] = head.length & 255; raw[1] = (head.length >> 8) & 255; raw[2] = (head.length >> 16) & 255; raw[3] = (head.length >>> 24) & 255;
    raw.set(head, 4);
    var at = 4 + head.length;
    files.forEach(function (f) { raw.set(f.data, at); at += f.data.length; });
    var z = new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip')));
    return new Uint8Array(await z.arrayBuffer());
  }

  function upMsg(text, bad) { $('upMsg').textContent = text; $('upMsg').classList.toggle('bad', !!bad); }

  async function tryIt() {
    var title = ($('upTitle').value || '').trim().slice(0, 60);
    var desc = ($('upDesc').value || '').trim().slice(0, 500);
    var files = await readFiles($('upFile').files.length ? $('upFile').files : $('upFolder').files);
    if (!files) return upMsg('Choose a level file or a set folder first.', true);
    var shaped;
    try { shaped = shapeDraft(files, title, desc); } catch (e) { return upMsg(e.message, true); }
    var id = (draft && draft.files === files) ? draft.id : crypto.randomUUID();
    draft = Object.assign({ id: id, set: setNameFor(id), title: title || shaped.levelName, desc: desc, tested: false }, shaped);
    draft.pack = await makePack(draft.files);
    if (draft.pack.length > MAX_BYTES) { upMsg('That is ' + (draft.pack.length / 1048576).toFixed(1) + ' MB packed; the limit is 5 MB.', true); draft = null; return; }
    AvaraLevels.install(draft.set, await AvaraLevels.unpack(draft.pack));
    Module.ccall('avara_web_set_ready', null, ['string', 'number'], [draft.set, 1]);   // the engine re-reads its package list
    upMsg('Loading it… Play it, then come back here (Levels) to publish.');
    $('upPublish').disabled = true;
    play(draft.set, draft.alf);
  }

  async function publish() {
    if (!draft || !draft.tested) return upMsg('Try the level first: only a level that loads can be published.', true);
    $('upPublish').disabled = true;
    upMsg('Uploading…');
    await AvaraSupa.session();
    var uid = AvaraSupa.userId;
    if (!uid) { $('upPublish').disabled = false; return upMsg('Could not sign in to upload. Check your connection.', true); }
    var path = uid + '/' + draft.id + '.packz';
    var up = await AvaraSupa.upload(BUCKET, path, draft.pack);
    if (!up.ok) { $('upPublish').disabled = false; return upMsg('Upload failed: ' + up.error, true); }
    var r = await AvaraSupa.rpc('avara_publish_level', {
      id: draft.id, title: draft.title, description: draft.desc, alf: draft.alf, levelName: draft.levelName,
      levels: draft.levels, deps: draft.deps, authorName: AvaraSupa.store('avara.callsign') || '', synth: AvaraTelemetry.synth,
    });
    if (!r || !r.ok) { $('upPublish').disabled = false; return upMsg('Publishing failed: ' + ((r && r.error) || 'no answer'), true); }
    AvaraTelemetry.event('publish', { set: draft.set, bytes: draft.pack.length, levels: draft.levels });
    upMsg('Published "' + draft.title + '". It is in the Community tab for everyone.');
    draft = null;
    $('upFile').value = ''; $('upFolder').value = '';
    sort = 'mine'; markSort(); setTimeout(function () { open('community'); }, 900);
  }

  // The engine says a level loaded, or failed to: that is the test of a draft.
  function engineEvent(kind, d) {
    if (!draft || d.set !== draft.set) {
      if (kind === 'start') roundStarted(d.set);
      return;
    }
    if (kind === 'level') {
      draft.tested = true;
      $('upPublish').disabled = false;
      upMsg('"' + d.name + '" loaded. Play it; when it is ready, Publish.');
    } else if (kind === 'levelerr') {
      draft.tested = false;
      upMsg('The level did not load (error ' + d.err + '). Check the .alf file and try again.', true);
      open('upload');
    } else if (kind === 'start') {
      roundStarted(d.set);
    }
  }

  function markSort() {
    document.querySelectorAll('#sortChips button').forEach(function (b) { b.classList.toggle('on', b.dataset.sort === sort); });
  }

  // ---- wiring --------------------------------------------------------------------------
  function wire() {
    ['community', 'library', 'upload'].forEach(function (t) { $('lt-' + t).onclick = function () { open(t); }; });
    document.querySelectorAll('#sortChips button').forEach(function (b) {
      b.onclick = function () { sort = b.dataset.sort; markSort(); listCommunity(); };
    });
    $('levelSearch').addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { query = $('levelSearch').value.trim(); listCommunity(); }, 300);
    });
    $('levelsBack').onclick = function () { AvaraLobby.back(); };
    $('upTry').onclick = tryIt;
    $('upPublish').onclick = publish;
    $('upFile').onchange = function () { $('upFolder').value = ''; if (!$('upTitle').value && this.files[0]) $('upTitle').value = this.files[0].name.replace(/\.alf$/i, ''); };
    $('upFolder').onchange = function () { $('upFile').value = ''; };
    markSort();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();

  window.AvaraCommunity = { open: open, engineEvent: engineEvent, play: play };
})();
