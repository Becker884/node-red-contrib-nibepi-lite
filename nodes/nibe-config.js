'use strict';
/*
 * nibe-config: Verbindung zur Wärmepumpe (serielle Schnittstelle).
 *
 * Eigenschaften im Flow (kompatibel zu node-red-contrib-nibepi 1.2.1):
 *   serial_port   Port, z. B. /dev/ttyAMA0, /dev/ttyUSB0 oder /dev/serial/by-id/...
 *   readonly      true = nichts zur Pumpe schreiben
 * Neu:
 *   model         Modelldatei in models/ (Standard F1255)
 *   reset_alarm   Alarm beim Start quittieren (Standard true, wie bisher)
 *   trace, trace_file   Telegramm-Mitschnitt (Standard aus)
 *
 * Die Registerliste steht weiterhin als global.register zur Verfügung
 * (Array von Objekten mit register, data, raw_data, titel, unit, timestamp, ...).
 */
const fs = require('fs');
const path = require('path');
const shared = require('../lib/shared');
const { TraceFile } = require('../lib/trace');

const MODELS_DIR = path.join(__dirname, '..', 'models');

function listModels() {
  try {
    return fs
      .readdirSync(MODELS_DIR)
      .filter((f) => /^[A-Za-z0-9_-]+\.json$/.test(f))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch (e) {
    return [];
  }
}

async function listPorts() {
  const out = new Map(); // path -> Beschreibung
  for (const p of ['/dev/ttyAMA0', '/dev/serial0', '/dev/ttyS0']) {
    if (fs.existsSync(p)) out.set(p, 'Pi-UART');
  }
  try {
    const { SerialPort } = require('serialport');
    for (const p of await SerialPort.list()) {
      const label = [p.manufacturer, p.serialNumber].filter(Boolean).join(' ') || 'USB/seriell';
      if (p.pnpId) {
        const byId = `/dev/serial/by-id/${p.pnpId}`;
        if (fs.existsSync(byId)) out.set(byId, `${label} (fester Pfad, empfohlen)`);
      }
      if (p.path && !out.has(p.path)) out.set(p.path, label);
    }
  } catch (e) {
    /* serialport nicht ladbar: nur die statische Liste anbieten */
  }
  return [...out].map(([p, label]) => ({ path: p, label }));
}

module.exports = function (RED) {
  function NibeConfig(n) {
    RED.nodes.createNode(this, n);
    const node = this;
    const portPath = String(n.serial_port || '').trim();
    const model = String(n.model || 'F1255').trim();
    node.core = null;

    if (!portPath) {
      node.error('Kein serieller Port eingetragen (serial_port)');
      return;
    }

    let acq;
    try {
      acq = shared.acquire({
        path: portPath,
        model,
        blockWrites: n.readonly === true,
        resetAlarm: n.reset_alarm !== false,
        // nur zur Fehlersuche: erzwingt den Wecker-Timer (ms, 0 = aus), siehe README (Node.js 26)
        coreOptions: n.wake_ms !== undefined && n.wake_ms !== '' && Number.isFinite(Number(n.wake_ms)) ? { wakeMs: Number(n.wake_ms) } : undefined,
      });
    } catch (e) {
      node.error(`NIBE-Kern konnte nicht gestartet werden: ${e.message}`);
      return;
    }
    const core = acq.core;
    node.core = core;
    node.model = model;
    node.serialPort = portPath;

    // wie bisher: Registerliste als global.register, dasselbe Array-Objekt
    node.context().global.set('register', core.registers);

    const onFault = (f) => node.warn(`${f.from}: ${f.message}`);
    core.on('fault', onFault);

    let trace = null;
    let onTrace = null;
    if (n.trace === true) {
      try {
        trace = new TraceFile(String(n.trace_file || '/tmp/nibepi-lite.log'));
        onTrace = (t) => trace.write(t);
        core.on('trace', onTrace);
        node.warn(`Telegramm-Mitschnitt aktiv: ${trace.file} (nur zur Fehlersuche, danach wieder abschalten)`);
      } catch (e) {
        node.warn(`Mitschnitt konnte nicht gestartet werden: ${e.message}`);
      }
    }

    node.on('close', function (removed, done) {
      core.removeListener('fault', onFault);
      if (onTrace) core.removeListener('trace', onTrace);
      shared.release(acq.key);
      if (trace) trace.close().then(() => done());
      else done();
    });
  }
  RED.nodes.registerType('nibe-config', NibeConfig);

  RED.httpAdmin.get('/nibepi-lite/options', RED.auth.needsPermission('nibe-config.read'), async (req, res) => {
    res.json({ ports: await listPorts(), models: listModels() });
  });
};
