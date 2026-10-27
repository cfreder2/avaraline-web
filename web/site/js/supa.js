/*
 * supa.js — the page's line to Supabase: who this device is, RPC calls, public Edge
 * Functions, and Realtime channels for the WebRTC handshake.
 *
 * Rows go to the VECTRENCH Supabase project, beside VECTRENCH's, AXI's and MANTIS's
 * tables; every Avara name starts `avara_` (supabase/001-avara.sql). Identity is that
 * project's anonymous sign-in: the first time a device plays it silently becomes an auth
 * user, and the refresh token in localStorage is the device from then on. No email.
 *
 * Every call fails soft. The lobby needs the network; the game itself never waits on it.
 *
 * Plain script (no modules, no bundler): it defines window.AvaraSupa.
 */
(function () {
  'use strict';

  var URL_BASE = 'https://csicwkbfgmjtuharranh.supabase.co';
  var KEY = 'sb_publishable_PSvK48E7hZgivrIXhAR0Og_QwN15V4D';   // public by design; RLS and the RPCs guard the data
  var IDENT_KEY = 'avara.identity.v1';

  function store(k, v) {
    try {
      if (v === undefined) return localStorage.getItem(k);
      if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v);
    } catch (e) { /* private mode: this session only */ }
    return null;
  }

  var token = null, tokenExp = 0, userId = null, minting = null;

  async function call(path, body, auth, keepalive) {
    try {
      var headers = { apikey: KEY, 'Content-Type': 'application/json' };
      if (auth) {
        // On the way out (pagehide) there is no time to sign in: use a token we hold.
        var t = keepalive ? token : await session();
        if (!t) return null;
        headers.Authorization = 'Bearer ' + t;
      }
      var r = await fetch(URL_BASE + path, { method: 'POST', headers: headers, body: JSON.stringify(body), keepalive: !!keepalive });
      var data = null;
      try { data = await r.json(); } catch (e) { /* 204 */ }
      return { status: r.status, data: data };
    } catch (e) { return null; }
  }

  // The device's access token, signing in (anonymously) or refreshing as needed.
  async function session() {
    if (token && Date.now() / 1000 < tokenExp - 60) return token;
    if (minting) return minting;
    minting = (async function () {
      var id = null;
      try { id = JSON.parse(store(IDENT_KEY) || 'null'); } catch (e) { /* start fresh */ }
      var r = null;
      if (id && id.refresh_token) {
        r = await call('/auth/v1/token?grant_type=refresh_token', { refresh_token: id.refresh_token }, false);
        if (r && r.status !== 200) r = null;     // revoked or pruned: be born again
      }
      if (!r) r = await call('/auth/v1/signup', {}, false);
      if (!r || r.status !== 200 || !r.data || !r.data.access_token) return null;
      token = r.data.access_token;
      tokenExp = r.data.expires_at || (Date.now() / 1000 + (r.data.expires_in || 3600));
      userId = r.data.user && r.data.user.id;
      store(IDENT_KEY, JSON.stringify({ refresh_token: r.data.refresh_token, user_id: userId }));
      return token;
    })();
    var t = await minting;
    minting = null;
    return t;
  }

  // An RPC taking one jsonb argument `p` (the shape every avara_* function has).
  // Resolves to the function's result, or null when anything went wrong.
  async function rpc(name, p, keepalive) {
    var r = await call('/rest/v1/rpc/' + name, { p: Object.assign({ v: 1 }, p || {}) }, true, keepalive);
    if (!r || r.status >= 300) {
      if (r) console.warn('[avara] rpc', name, r.status, r.data && (r.data.message || r.data));
      return null;
    }
    return r.data === null ? true : r.data;
  }

  // A public Edge Function's JSON, by GET (supabase/functions). No sign-in and no headers,
  // so the browser asks without a preflight. Resolves to null when anything went wrong.
  async function fn(name, query) {
    try {
      var r = await fetch(URL_BASE + '/functions/v1/' + name + (query ? '?' + query : ''));
      return r.ok ? await r.json() : null;
    } catch (e) { return null; }
  }

  // ---- Realtime: one Phoenix socket, broadcast channels, presence -----------------------
  // Public broadcast channels need no table and no policy: they are a relay for messages
  // between whoever joined the same topic, used here for WebRTC offers, answers and ICE
  // candidates, and for invitations. Presence (who is on a channel, and what each says
  // about itself) is kept by Realtime in memory: the Online screen. Nothing is stored.
  var sock = null, sockOpen = false, ref = 0, channels = {}, heartbeat = null, backoff = 500;

  function rtUrl() {
    return URL_BASE.replace('https://', 'wss://') + '/realtime/v1/websocket?apikey=' + KEY + '&vsn=1.0.0';
  }

  function rtSend(msg) {
    if (sock && sockOpen) { sock.send(JSON.stringify(msg)); return true; }
    return false;
  }

  function rtJoin(ch) {
    ch.joinRef = String(++ref);
    ch.joined = false;
    rtSend({ topic: ch.topic, event: 'phx_join', ref: ch.joinRef, join_ref: ch.joinRef,
             payload: { config: { broadcast: { self: false, ack: false },
                                  presence: { key: ch.presenceKey || '', enabled: !!ch.onpresence }, private: false },
                        access_token: token || KEY } });
  }

  function rtTrack(ch) {
    if (!ch.joined || !ch.meta) return;
    rtSend({ topic: ch.topic, event: 'presence', ref: String(++ref), join_ref: ch.joinRef,
             payload: { type: 'presence', event: 'track', payload: ch.meta } });
  }

  // presence_state is everyone; presence_diff is who came and went (a key's metas are its
  // tabs, told apart by phx_ref)
  function rtPresence(ch, event, payload) {
    if (event === 'presence_state') ch.presence = {};
    var add = event === 'presence_state' ? payload : (payload.joins || {});
    var drop = event === 'presence_state' ? {} : (payload.leaves || {});
    Object.keys(drop).forEach(function (k) {
      var gone = (drop[k].metas || []).map(function (m) { return m.phx_ref; });
      var left = (ch.presence[k] || []).filter(function (m) { return gone.indexOf(m.phx_ref) < 0; });
      if (left.length) ch.presence[k] = left; else delete ch.presence[k];
    });
    Object.keys(add).forEach(function (k) {
      var keep = (ch.presence[k] || []).filter(function (m) { return !(add[k].metas || []).some(function (n) { return n.phx_ref === m.phx_ref; }); });
      ch.presence[k] = keep.concat(add[k].metas || []);
    });
    try { ch.onpresence(ch.presence); } catch (e) { console.error('[avara] presence handler', e); }
  }

  function rtConnect() {
    if (sock) return;
    sock = new WebSocket(rtUrl());
    sock.onopen = function () {
      sockOpen = true; backoff = 500;
      Object.keys(channels).forEach(function (t) { rtJoin(channels[t]); });
      clearInterval(heartbeat);
      heartbeat = setInterval(function () {
        rtSend({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++ref) });
      }, 25000);
    };
    sock.onmessage = function (m) {
      var d; try { d = JSON.parse(m.data); } catch (e) { return; }
      var ch = channels[d.topic];
      if (!ch) return;
      if (d.event === 'phx_reply' && d.ref === ch.joinRef) {
        ch.joined = d.payload && d.payload.status === 'ok';
        if (ch.joined) { var q = ch.queue; ch.queue = []; q.forEach(function (p) { ch.send(p); }); rtTrack(ch); }
        else console.warn('[avara] realtime join refused', d.payload);
      } else if (d.event === 'broadcast' && d.payload && d.payload.event === 'sig') {
        try { ch.onmessage(d.payload.payload); } catch (e) { console.error('[avara] signal handler', e); }
      } else if ((d.event === 'presence_state' || d.event === 'presence_diff') && ch.onpresence && d.payload) {
        rtPresence(ch, d.event, d.payload);
      } else if (d.event === 'phx_error' || d.event === 'phx_close') {
        ch.joined = false;
      }
    };
    sock.onclose = function () {
      sock = null; sockOpen = false; clearInterval(heartbeat);
      if (Object.keys(channels).length) {   // somebody still needs it: come back
        setTimeout(rtConnect, backoff); backoff = Math.min(backoff * 2, 8000);
      }
    };
    sock.onerror = function () { /* onclose follows */ };
  }

  // A broadcast channel on `topic`. onmessage(payload) hears everyone else's sends.
  // opts.presenceKey and opts.onpresence(map of key -> [meta]) make it a presence channel
  // too: ch.track(meta) says who we are (again whenever it changes); without track, we
  // only watch.
  function channel(topic, onmessage, opts) {
    var full = 'realtime:' + topic;
    opts = opts || {};
    var ch = {
      topic: full, onmessage: onmessage, joined: false, joinRef: null, queue: [],
      presenceKey: opts.presenceKey || '', onpresence: opts.onpresence || null, presence: {}, meta: null,
      track: function (meta) { ch.meta = meta; rtTrack(ch); },
      send: function (payload) {
        if (!ch.joined) { ch.queue.push(payload); if (ch.queue.length > 200) ch.queue.shift(); return; }
        rtSend({ topic: full, event: 'broadcast', ref: String(++ref), join_ref: ch.joinRef,
                 payload: { type: 'broadcast', event: 'sig', payload: payload } });
      },
      close: function () {
        if (channels[full] === ch) delete channels[full];
        rtSend({ topic: full, event: 'phx_leave', payload: {}, ref: String(++ref), join_ref: ch.joinRef });
        if (!Object.keys(channels).length && sock) { var s = sock; sock = null; sockOpen = false; s.onclose = null; s.close(); clearInterval(heartbeat); }
      }
    };
    channels[full] = ch;
    if (sockOpen) rtJoin(ch); else rtConnect();
    return ch;
  }

  // Storage: put a file in a bucket as the signed-in player; the public URL of one.
  async function upload(bucket, path, bytes) {
    var t = await session();
    if (!t) return { ok: false, error: 'not signed in' };
    try {
      var r = await fetch(URL_BASE + '/storage/v1/object/' + bucket + '/' + path, {
        method: 'POST', body: bytes,
        // never overwrite: every level gets a new id, and Storage allows an overwrite only
        // with read and update policies, which the bucket deliberately does not have
        headers: { apikey: KEY, Authorization: 'Bearer ' + t, 'Content-Type': 'application/octet-stream', 'x-upsert': 'false' },
      });
      if (r.ok) return { ok: true };
      var d = null; try { d = await r.json(); } catch (e) {}
      return { ok: false, error: (d && (d.message || d.error)) || ('upload failed: ' + r.status) };
    } catch (e) { return { ok: false, error: e.message }; }
  }
  async function remove(bucket, path) {
    var t = await session();
    if (!t) return false;
    try {
      var r = await fetch(URL_BASE + '/storage/v1/object/' + bucket + '/' + path, {
        method: 'DELETE', headers: { apikey: KEY, Authorization: 'Bearer ' + t } });
      return r.ok;
    } catch (e) { return false; }
  }
  function publicUrl(bucket, path) {
    return URL_BASE + '/storage/v1/object/public/' + bucket + '/' + path.split('/').map(encodeURIComponent).join('/');
  }

  // mesh.js negotiates its links over window.AvaraSignal; on this page, Supabase Realtime.
  window.AvaraSignal = { channel: function (topic, onmessage) { return channel(topic, onmessage); } };

  window.AvaraSupa = {
    rpc: rpc,
    fn: fn,
    upload: upload,
    remove: remove,
    publicUrl: publicUrl,
    session: session,
    channel: channel,
    get userId() { return userId; },
    store: store,
  };
})();
