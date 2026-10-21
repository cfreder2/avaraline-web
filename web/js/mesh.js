/*
 * mesh.js — WebRTC links between the browsers in one game.
 *
 * Avara's netcode is a full mesh: every player sends each frame of input straight to
 * every other player, and the host (slot 0, a player like any other) is only special for
 * logins, level loads and starts. This file gives the engine that mesh in a browser:
 *
 *   - Every tab has a random peer id. src/net/AvaraTCP_web.cpp uses it as the "IP
 *     address", so the engine sends a datagram to peer X and this file gets it there.
 *   - A link is an RTCPeerConnection with one DataChannel, {ordered:false,
 *     maxRetransmits:0}: datagrams, like UDP, because the engine does its own
 *     reliability on top.
 *   - Links are negotiated over a Supabase Realtime broadcast channel for the game
 *     (offer, answer, ICE candidates), opened by the lobby when it hosts or joins. Of any
 *     two peers, the lower id makes the offer; the other asks it to with 'want'. So the
 *     two can never offer at once.
 *   - Some pairs of home networks cannot reach each other directly, and every new link
 *     takes a second or so to negotiate. Everyone can reach the host (they joined
 *     through it), so until a client's direct link to X is open, its datagrams for X go
 *     through the host, and from the moment the direct link opens they go straight to
 *     X. The engine never waits and never knows: datagrams arrive marked with the true
 *     sender's id either way.
 *
 * DataChannel framing (first byte):
 *   0x00 data      [0][payload]                 a datagram from the link's other end
 *   0x01 relay     [1][to u32 LE][payload]      client -> host: pass this on to `to`
 *   0x02 relayed   [2][from u32 LE][payload]    host -> client: this came from `from`
 *
 * Plain script; defines window.AvaraMesh. Needs window.AvaraSupa for signaling.
 */
(function () {
  'use strict';

  var RELAYED_AFTER_MS = 6000;     // still going through the host by then: report it
  var WANT_EVERY_MS = 1500;        // re-ask a higher-id peer to offer until it does
  var RETRY_AFTER_MS = 3000;       // a failed link may be tried again after this
  var STALL_MS = 10000;            // not open this long after it began: negotiate it again
                                   // (Realtime broadcast is best-effort: a lost offer, answer
                                   // or ICE candidate can leave a link "connecting" forever)
  var QUEUE_MAX = 256;             // datagrams held per peer while a link opens
  var INQ_MAX = 4096;              // datagrams held for the engine (it drains every frame)

  // STUN finds each side's public address; TURN, when configured, relays for networks
  // that STUN cannot get through. window.AVARA_ICE (set by the page) can add servers.
  function iceServers() {
    var list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
    if (Array.isArray(window.AVARA_ICE)) list = list.concat(window.AVARA_ICE);
    return list;
  }

  function newId() {
    // 31 bits, never 0, and a low byte of 1..9: CUDPComm::IsLAN reads the id as an IPv4
    // address with that byte first, and must not take it for 10.x, 127.x, 172.x or 192.x.
    var a = new Uint32Array(1);
    crypto.getRandomValues(a);
    var hi = (a[0] & 0x7fffff00) || 0x100;
    return (hi | (1 + (a[0] % 9))) >>> 0;
  }

  var M = {
    id: newId(),
    gameId: null,
    hostId: null,          // the game's host (this tab when isHost)
    isHost: false,
    peers: new Map(),      // id -> link
    inq: [],
    chan: null,
    onevent: null,         // (kind, data) for the lobby and telemetry
    counters: { relayedOut: 0, relayedIn: 0, forwarded: 0, dropped: 0 },
  };

  function emit(kind, data) { if (M.onevent) try { M.onevent(kind, data); } catch (e) { console.error(e); } }
  function now() { return performance.now(); }
  function hex(id) { return (id >>> 0).toString(16); }

  function signal(msg) {
    if (!M.chan) return;
    msg.from = M.id;
    M.chan.send(msg);
  }

  function link(id) {
    var l = M.peers.get(id);
    if (!l) {
      l = { id: id, pc: null, dc: null, open: false, queue: [], began: now(), wantAt: 0,
            remoteSet: false, pendingIce: [], failedAt: 0, relay: false, path: null, openedMs: null };
      M.peers.set(id, l);
    }
    return l;
  }

  function closeLink(l, why) {
    if (l.dc) { try { l.dc.close(); } catch (e) {} }
    if (l.pc) { try { l.pc.close(); } catch (e) {} }
    l.pc = null; l.dc = null; l.open = false; l.remoteSet = false; l.pendingIce = [];
    if (why) { l.failedAt = now(); emit('linkfail', { peer: hex(l.id), why: why, ms: Math.round(now() - l.began) }); }
  }

  function wireChannel(l, dc) {
    l.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = function () {
      l.open = true; l.relay = false; l.relaySince = 0;
      l.openedMs = Math.round(now() - l.began);
      var q = l.queue; l.queue = [];
      for (var i = 0; i < q.length; i++) sendFramed(l, q[i]);
      describePath(l).then(function (path) {
        l.path = path;
        emit('link', { peer: hex(l.id), ms: l.openedMs, path: path, host: l.id === M.hostId });
      });
    };
    dc.onclose = function () { l.open = false; };
    dc.onmessage = function (ev) { onData(l, new Uint8Array(ev.data)); };
  }

  function makePc(l) {
    var pc = new RTCPeerConnection({ iceServers: iceServers() });
    l.pc = pc;
    pc.onicecandidate = function (ev) {
      if (ev.candidate) signal({ t: 'ice', to: l.id, c: ev.candidate.toJSON() });
    };
    pc.onconnectionstatechange = function () {
      if (l.pc !== pc) return;
      var st = pc.connectionState;
      if (st === 'failed' || st === 'closed') closeLink(l, st);
    };
    pc.ondatachannel = function (ev) { wireChannel(l, ev.channel); };
    return pc;
  }

  async function offer(l) {
    closeLink(l);
    l.began = now();
    var pc = makePc(l);
    wireChannel(l, pc.createDataChannel('avara', { ordered: false, maxRetransmits: 0 }));
    try {
      await pc.setLocalDescription(await pc.createOffer());
      signal({ t: 'offer', to: l.id, sdp: pc.localDescription.sdp });
    } catch (e) { closeLink(l, 'offer:' + e.message); }
  }

  async function onSignal(msg) {
    if (!msg || msg.from === M.id) return;
    var from = msg.from >>> 0;
    if (msg.t === 'bye') {               // to everyone: that peer has left the game
      var gone = M.peers.get(from);
      if (gone) { closeLink(gone); M.peers.delete(from); }
      emit('bye', { peer: hex(from) });
      return;
    }
    if (msg.to !== M.id || blocked(from)) return;
    var l = link(from);
    try {
      if (msg.t === 'want') {
        // They want a link and we are the one to offer. Unless one is already on its way.
        if (M.id < from && !(l.pc && (l.open || l.pc.connectionState === 'connecting' || l.pc.signalingState === 'have-local-offer'))) {
          await offer(l);
        }
      } else if (msg.t === 'offer') {
        closeLink(l);
        l.began = now();
        var pc = makePc(l);
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        l.remoteSet = true;
        flushIce(l);
        await pc.setLocalDescription(await pc.createAnswer());
        signal({ t: 'answer', to: from, sdp: pc.localDescription.sdp });
      } else if (msg.t === 'answer') {
        if (l.pc && l.pc.signalingState === 'have-local-offer') {
          await l.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
          l.remoteSet = true;
          flushIce(l);
        }
      } else if (msg.t === 'ice') {
        if (l.pc && l.remoteSet) await l.pc.addIceCandidate(msg.c);
        else l.pendingIce.push(msg.c);
      }
    } catch (e) {
      console.warn('[avara-mesh]', msg.t, 'from', hex(from), e.message);
    }
  }

  function flushIce(l) {
    var c = l.pendingIce; l.pendingIce = [];
    c.forEach(function (x) { l.pc.addIceCandidate(x).catch(function () {}); });
  }

  // A client that chose "connect only through the host" (Settings) makes no direct link
  // to the other clients, so only the host learns its address; its traffic with them goes
  // through the host. tools/mp.mjs NODIRECT=1 forces the same, to test the relay.
  function blocked(id) { return (M.hostOnly || !!window.__meshNoDirect) && !M.isHost && id !== M.hostId; }

  // Make sure a link to l is open or on its way.
  function ensure(l) {
    if (l.open || !M.chan || blocked(l.id)) return;
    var t = now();
    if (l.failedAt && t - l.failedAt < RETRY_AFTER_MS) return;
    if (M.id < l.id) {
      if (!l.pc) offer(l);
    } else if (t - l.wantAt > WANT_EVERY_MS) {
      l.wantAt = t;
      signal({ t: 'want', to: l.id });
    }
  }

  function u32le(b, at, v) { b[at] = v & 255; b[at + 1] = (v >>> 8) & 255; b[at + 2] = (v >>> 16) & 255; b[at + 3] = (v >>> 24) & 255; }
  function readU32le(b, at) { return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0; }

  function sendFramed(l, framed) {
    try { l.dc.send(framed); } catch (e) { M.counters.dropped++; }
  }

  function frame(op, peer, bytes) {
    var head = op === 0 ? 1 : 5, out = new Uint8Array(head + bytes.length);
    out[0] = op;
    if (op !== 0) u32le(out, 1, peer);
    out.set(bytes, head);
    return out;
  }

  function onData(l, b) {
    if (!b.length) return;
    var op = b[0];
    if (op === 0) {
      push(l.id, b.subarray(1));
    } else if (op === 1 && M.isHost && b.length >= 5) {
      // a client asks us to pass a datagram on
      var to = readU32le(b, 1), dest = M.peers.get(to);
      if (to === M.id) push(l.id, b.subarray(5));
      else if (dest && dest.open) { sendFramed(dest, frame(2, l.id, b.subarray(5))); M.counters.forwarded++; }
      else M.counters.dropped++;
    } else if (op === 2 && b.length >= 5) {
      M.counters.relayedIn++;
      push(readU32le(b, 1), b.subarray(5));
    }
  }

  function push(from, bytes) {
    M.inq.push({ from: from, bytes: bytes });
    if (M.inq.length > INQ_MAX) { M.inq.shift(); M.counters.dropped++; }
  }

  // ---- the engine's side (library_avara_net.js) -----------------------------------------
  M.attach = function () {};

  M.send = function (to, bytes) {
    if (!to || to === M.id || !M.chan) return;
    var l = link(to);
    l.sent = (l.sent || 0) + 1;
    if (l.open) { sendFramed(l, frame(0, 0, bytes)); return; }
    ensure(l);
    // Not open yet: a client goes through the host meanwhile; otherwise (the link to the
    // host itself) hold the datagram for when the link opens.
    var host = M.hostId != null && !M.isHost && to !== M.hostId ? M.peers.get(M.hostId) : null;
    if (host && host.open) {
      if (!l.relaySince) l.relaySince = now();
      sendFramed(host, frame(1, to, bytes));
      M.counters.relayedOut++;
      return;
    }
    l.queue.push(bytes);
    if (l.queue.length > QUEUE_MAX) l.queue.shift();
  };

  M.recv = function () { return M.inq.length ? M.inq.shift() : null; };

  // ---- the lobby's side --------------------------------------------------------------
  // Join the game's signaling channel. opts: { host: true } to host it, or
  // { hostId: <number> } to join the host with that id.
  M.join = function (gameId, opts) {
    M.leave(true);
    M.gameId = gameId;
    M.isHost = !!(opts && opts.host);
    M.hostOnly = AvaraSupa.store('avara.hostOnly') === '1';
    M.hostId = M.isHost ? M.id : (opts && opts.hostId) >>> 0;
    M.chan = AvaraSupa.channel('avara-game-' + gameId, onSignal);
    // Watch for links stuck half-open: a lost offer is re-made, a lost 'want' re-sent.
    clearInterval(M.timer);
    M.timer = setInterval(function () {
      M.peers.forEach(function (l) {
        if (l.open) return;
        if (l.relaySince && !l.relay && now() - l.relaySince > RELAYED_AFTER_MS) {
          l.relay = true;           // no direct link yet: this pair is relying on the host
          emit('relay', { peer: hex(l.id), ms: Math.round(now() - l.relaySince) });
        }
        if (l.pc && now() - l.began > STALL_MS) closeLink(l, 'stalled');
        if (l.queue.length || l.relaySince) ensure(l);
      });
    }, 1000);
  };

  // Leave the game: say goodbye, and close the links once the engine's logout has had a
  // moment to go out on them.
  M.leave = function (now_) {
    if (!M.chan) return;
    var chan = M.chan, peers = Array.from(M.peers.values());
    signal({ t: 'bye' });
    M.chan = null; M.gameId = null; M.hostId = null; M.isHost = false;
    M.peers = new Map(); M.inq = [];
    clearInterval(M.timer);
    var done = function () { peers.forEach(function (l) { closeLink(l); }); chan.close(); };
    if (now_) done(); else setTimeout(done, 400);
  };

  // What each link is, for the lobby and telemetry.
  M.links = function () {
    var out = [];
    M.peers.forEach(function (l) {
      out.push({ peer: hex(l.id), open: l.open, relay: !l.open && l.relay, path: l.path, sent: l.sent || 0, queued: l.queue.length,
                 ms: l.openedMs, state: l.pc ? l.pc.connectionState : 'none' });
    });
    return out;
  };

  // How a link got through: 'host' (same network), 'srflx' (straight through NAT, via
  // STUN), 'relay' (TURN). Read from the selected candidate pair.
  async function describePath(l) {
    try {
      var stats = await l.pc.getStats(), pair = null, local = {}, remote = {};
      stats.forEach(function (s) {
        if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
        if (s.type === 'local-candidate') local[s.id] = s.candidateType;
        if (s.type === 'remote-candidate') remote[s.id] = s.candidateType;
      });
      if (!pair) stats.forEach(function (s) { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
      if (!pair) return 'unknown';
      return (local[pair.localCandidateId] || '?') + '/' + (remote[pair.remoteCandidateId] || '?');
    } catch (e) { return 'unknown'; }
  }

  M.hex = hex;
  window.AvaraMesh = M;
})();
