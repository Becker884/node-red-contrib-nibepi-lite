'use strict';
/*
 * nibe-output: schreibt einen Wert in ein Register der Pumpe.
 *
 *   name = Registernummer fest eingestellt, oder leer -> msg.topic ist die Registernummer
 *   msg.payload = Wert in Einheiten der Anzeige (z. B. 37 für 37,0 °C; Faktor wird angewendet)
 *
 * Ausgang: { topic: <Register>, payload: <Wert> } sobald der Wert gesendet wurde.
 * Ungültige Werte (keine Zahl, außerhalb von min/max, Register nur lesbar) werden
 * abgelehnt und als Fehler gemeldet; es wird nichts zur Pumpe geschickt.
 */
module.exports = function (RED) {
  function NibeOutput(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    const core = server && server.core;
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'Config-Node fehlt oder fehlerhaft' });
      return;
    }

    const fixed = String(config.name === undefined || config.name === null ? '' : config.name).trim();
    let closed = false;
    let clearTimer = null;
    const timers = new Set();
    const later = (fn, ms) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
      return t;
    };

    node.on('input', function (msg, send, done) {
      send = send || ((m) => node.send(m));
      done = done || ((e) => e && node.error(e, msg));
      const register = fixed || String(msg.topic === undefined || msg.topic === null ? '' : msg.topic).trim();
      if (!/^\d+$/.test(register)) {
        node.status({ fill: 'red', shape: 'dot', text: 'ungültiges Register' });
        return done(new Error(`"${register}" ist keine Registernummer (Node-Name oder msg.topic)`));
      }

      clearTimeout(clearTimer);
      node.status({ fill: 'yellow', shape: 'dot', text: `${msg.payload}` });
      const timeout = later(() => node.status({ fill: 'red', shape: 'dot', text: 'Zeitüberschreitung beim Senden' }), 10000);

      return core.write(register, msg.payload, (err) => {
        timers.delete(timeout);
        clearTimeout(timeout);
        if (closed) return done();
        if (err) {
          node.status({ fill: 'red', shape: 'dot', text: err.message.slice(0, 60) });
          return done(err);
        }
        send({ topic: fixed ? register : msg.topic, payload: msg.payload });
        node.status({ fill: 'green', shape: 'dot', text: `${msg.payload}` });
        clearTimer = later(() => node.status({}), 10000);
        return done();
      });
    });

    const onLink = (up) => {
      if (!up) node.status({ fill: 'red', shape: 'ring', text: 'keine Verbindung zur Pumpe' });
      else node.status({});
    };
    core.on('link', onLink);

    node.on('close', function () {
      closed = true;
      core.removeListener('link', onLink);
      for (const t of timers) clearTimeout(t);
      timers.clear();
    });
  }
  RED.nodes.registerType('nibe-output', NibeOutput);
};
