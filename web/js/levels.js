/*
 * levels.js — level sets arrive when they are first played.
 *
 * The build preloads every set's manifest (set.json, so the Levels window lists every
 * level) and the set the game boots into; the rest of each set is one gzipped pack beside
 * the page (tools/pack_levels.mjs writes them and levels/index.json). When the engine is
 * asked to load a level from a set that is not here (CNetManager::ReceiveLoadLevel calls
 * AvaraLevels.ready), this fetches the set and any sets it requires, unpacks them into the
 * engine's file system under /levels/<set>/, and calls avara_web_set_ready, and the
 * engine carries on with the load.
 *
 * Community levels (web/js/community.js) come the same way, from Supabase rather than
 * from beside the page: their sets are named "community-<id>" and community.js supplies
 * the pack.
 *
 * Plain script; defines window.AvaraLevels.
 */
(function () {
  'use strict';

  var index = null, indexLoading = null;
  var installed = {};      // set -> true
  var failed = {};         // set -> true until a ready() check consumes it
  var fetching = {};       // set -> promise
  var sources = [];        // extra providers: function (set) -> promise of pack bytes, or null

  function loadIndex() {
    if (index) return Promise.resolve(index);
    if (!indexLoading) {
      var v = window.AVARA_BUILD && AVARA_BUILD !== 'dev' ? '?v=' + encodeURIComponent(AVARA_BUILD) : '';
      indexLoading = fetch('levels/index.json' + v).then(function (r) { return r.json(); })
        .then(function (j) {
          index = j;
          Object.keys(j.sets).forEach(function (s) { if (j.sets[s].preloaded) installed[s] = true; });
          return j;
        })
        .catch(function (e) { indexLoading = null; throw e; });
    }
    return indexLoading;
  }

  var hud = null, hudTimer = null;
  // AvaraLevels.onevent(kind, data), if the page sets it: 'levelset' when a set arrives,
  // 'error' when one could not be fetched.
  function emit(kind, data) { if (window.AvaraLevels && AvaraLevels.onevent) try { AvaraLevels.onevent(kind, data); } catch (e) {} }

  function toast(text, sticky) {
    hud = hud || document.getElementById('hud');
    if (!hud) return;
    hud.textContent = text;
    clearTimeout(hudTimer);
    if (!sticky) hudTimer = setTimeout(function () { hud.textContent = ''; }, 2500);
  }

  // Fetch a URL, reporting progress as bytes arrive.
  async function download(url, label, expect) {
    var r = await fetch(url);
    if (!r.ok) throw new Error(r.status + ' for ' + url);
    var total = +r.headers.get('content-length') || expect || 0, got = 0, chunks = [];
    var reader = r.body.getReader(), last = 0;
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      chunks.push(step.value); got += step.value.length;
      var t = performance.now();
      if (t - last > 150) {
        last = t;
        toast('Downloading ' + label + '… ' + (total ? Math.round(100 * got / total) + '%' : (got / 1048576).toFixed(1) + ' MB'), true);
      }
    }
    var out = new Uint8Array(got), at = 0;
    chunks.forEach(function (c) { out.set(c, at); at += c.length; });
    return out;
  }

  // A pack: gzipped (unless the host already undid that), then [u32 header length]
  // [header JSON][file bytes].
  async function unpack(bytes) {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      var ds = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
      bytes = new Uint8Array(await ds.arrayBuffer());
    }
    var hlen = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
    var header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hlen)));
    var base = 4 + hlen;
    return header.files.map(function (f) { return { path: f[0], data: bytes.subarray(base + f[1], base + f[1] + f[2]) }; });
  }

  function install(set, files) {
    var FS = Module.FS, root = '/levels/' + set;
    files.forEach(function (f) {
      var p = root + '/' + f.path;
      FS.mkdirTree(p.slice(0, p.lastIndexOf('/')));
      FS.writeFile(p, f.data);
    });
    installed[set] = true;
  }

  // Bring a set (and the sets it requires) into the file system.
  function fetchSet(set) {
    if (installed[set]) return Promise.resolve();
    if (fetching[set]) return fetching[set];
    fetching[set] = (async function () {
      var bytes = null, deps = [];
      for (var i = 0; i < sources.length && !bytes; i++) {
        var got = sources[i](set);
        if (got) { var r = await got; bytes = r.bytes; deps = r.deps || []; }
      }
      if (!bytes) {
        var idx = await loadIndex(), entry = idx.sets[set];
        if (!entry) throw new Error('no such level set: ' + set);
        if (entry.preloaded) { installed[set] = true; return; }
        deps = entry.deps || [];
        await Promise.all(deps.map(fetchSet));
        bytes = await download(entry.pack, '"' + set + '"', entry.bytes);
      } else {
        await Promise.all(deps.map(fetchSet));
      }
      install(set, await unpack(bytes));
    })();
    fetching[set].then(function () { delete fetching[set]; }, function () { delete fetching[set]; });
    return fetching[set];
  }

  // The engine's question: is this set here? If not, start bringing it, and say no; the
  // engine is told when it arrives. A set that failed to arrive is reported "ready" once,
  // so the load goes ahead and fails, and the other players hear that it did.
  function ready(set) {
    if (installed[set]) return true;
    if (failed[set]) { delete failed[set]; return true; }
    var t0 = performance.now();
    fetchSet(set).then(function () {
      toast('"' + set + '" ready (' + ((performance.now() - t0) / 1000).toFixed(1) + ' s)');
      emit('levelset', { set: set, ms: Math.round(performance.now() - t0) });
      Module.ccall('avara_web_set_ready', null, ['string', 'number'], [set, 1]);
    }, function (e) {
      console.error('[avara] level set', set, e);
      toast('Could not download "' + set + '": ' + e.message);
      emit('error', { what: 'levelset', set: set, msg: String(e.message).slice(0, 200) });
      failed[set] = true;
      Module.ccall('avara_web_set_ready', null, ['string', 'number'], [set, 0]);
    });
    return false;
  }

  window.AvaraLevels = {
    ready: ready,
    fetchSet: fetchSet,
    isInstalled: function (set) { return !!installed[set]; },
    // community.js registers here: fn(set) returns null, or a promise of { bytes, deps }.
    addSource: function (fn) { sources.push(fn); },
    install: install,
    unpack: unpack,
    index: loadIndex,
  };
  loadIndex().catch(function () { /* retried on first use */ });
})();
