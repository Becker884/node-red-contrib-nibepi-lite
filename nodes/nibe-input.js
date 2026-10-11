'use strict';
/*
 * nibe-input: liefert Registerwerte der Pumpe.
 *
 *   name = Registernummer (z. B. 40008)   -> Werte dieses Registers
 *   name = leer                           -> Werte aller Register
 *   name = error                          -> Fehlermeldungen des Kerns
 *   add  = true                           -> Register zyklisch von der Pumpe lesen
 *
 * Ausgang 1: nur bei Wertänderung, Ausgang 2: bei jedem Wert
 * Nachricht: { topic: <Register>, payload: <Wert>, raw: <Registerobjekt> }
 */
module.exports = function (RED) {
  function NibeInput(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    const core = server && server.core;
    if (!core) {
      node.status({ fill: 'red', shape: 'ring', text: 'Config-Node fehlt oder fehlerhaft' });
      return;
    }

    const name = String(config.name === undefined || config.name === null ? '' : config.name).trim();
    const lower = name.toLowerCase();
    const isRegister = /^\d+$/.test(name);
    const listeners = []; // [event, handler]
    const on = (event, handler) => {
      core.on(event, handler);
      listeners.push([event, handler]);
    };

    let added = false;
    if (config.add === true && isRegister) added = core.addRegister(name);

    const showValue = (item) => node.status({ fill: 'green', shape: 'dot', text: `${item.data}${item.unit || ''}` });
    const linkStatus = (up) => {
      if (!up) return node.status({ fill: 'red', shape: 'ring', text: 'keine Verbindung zur Pumpe' });
      const item = isRegister ? core.getItem(name) : null;
      if (item && item.timestamp) return showValue(item);
      return node.status({});
    };

    if (lower === 'error') {
      let savedError = {};
      on('fault', (f) => {
        if (savedError.from !== f.from || savedError.message !== f.message) {
          node.send({ topic: f.from, payload: f.message });
          savedError = f;
        }
        node.send([null, { topic: f.from, payload: f.message }]);
      });
    } else if (name === '') {
      on('data', (item) => {
        const saved = node.context().get(item.register);
        if (saved != item.data) { // eslint-disable-line eqeqeq
          node.send([{ topic: item.register, payload: item.data }, { topic: item.register, payload: item.data, raw: item }]);
          node.context().set(item.register, item.data);
          node.status({ fill: 'green', shape: 'dot', text: `${item.register}: ${item.data} ${item.unit || ''}` });
        } else {
          node.send([null, { topic: item.register, payload: item.data, raw: item }]);
        }
      });
    } else if (isRegister) {
      on(name, (item) => {
        const saved = node.context().get(item.register);
        if (saved != item.data) { // eslint-disable-line eqeqeq
          node.send([
            { topic: item.register, payload: item.data, raw: item },
            { topic: item.register, payload: item.data, raw: item },
          ]);
          node.context().set(item.register, item.data);
          showValue(item);
        } else {
          node.send([null, { topic: item.register, payload: item.data, raw: item }]);
        }
      });
    } else {
      node.warn(`"${name}" ist keine Registernummer (erlaubt: Zahl, leer oder "error")`);
      node.status({ fill: 'red', shape: 'ring', text: 'ungültiges Register' });
    }

    if (lower !== 'error' && (isRegister || name === '')) {
      on('link', linkStatus);
      if (core.linked) linkStatus(true);
      else node.status({ fill: 'grey', shape: 'ring', text: 'warte auf Pumpe' });
    }

    node.on('close', function () {
      for (const [event, handler] of listeners) core.removeListener(event, handler);
      if (added) core.removeRegister(name);
    });
  }
  RED.nodes.registerType('nibe-input', NibeInput);
};
