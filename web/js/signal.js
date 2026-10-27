/*
 * signal.js — the channel the WebRTC handshake travels over.
 *
 * mesh.js exchanges offers, answers and ICE candidates with the other players in a game
 * through AvaraSignal.channel(topic, onmessage), which returns { send(msg), close() }.
 * Every message sent on a topic reaches everyone listening on it (mesh.js ignores its own).
 *
 * This one uses web/serve.py: a message is POSTed to signal/<topic>, and arrives as a
 * server-sent event on the same path. Everyone in a game must load the page from the same
 * server. A page served another way can define window.AvaraSignal before mesh.js runs,
 * with the same two calls.
 *
 * Plain script; defines window.AvaraSignal unless the page already has one.
 */
(function () {
  if (window.AvaraSignal) return;
  var BASE = window.AVARA_SIGNAL_URL || 'signal/';

  window.AvaraSignal = {
    channel: function (topic, onmessage) {
      var url = BASE + encodeURIComponent(topic);
      var events = new EventSource(url);
      events.onmessage = function (ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        onmessage(msg);
      };
      return {
        send: function (msg) {
          fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) })
            .catch(function () {});   // a lost message is resent by mesh.js
        },
        close: function () { events.close(); },
      };
    },
  };
})();
