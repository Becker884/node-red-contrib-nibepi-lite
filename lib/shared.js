'use strict';
/*
 * Gemeinsame Kerne pro Port.
 *
 * Node-RED baut bei jedem Deploy alle Nodes neu. Das Original (NibePi 1.2.1)
 * läuft als Modul im Prozess und übersteht Deploys: Verbindung, Registerwerte
 * und die einmalige Startsequenz (Alarm quittieren, Word-Swap) bleiben erhalten.
 * Dasselbe leistet diese Verwaltung: Der Kern wird beim letzten release() nicht
 * sofort, sondern erst nach einer Schonfrist gestoppt. Holt ein neuer Config-Node
 * ihn in dieser Zeit wieder ab, läuft er einfach weiter.
 */

const { NibeCore } = require('./core');

const cores = new Map(); // key -> { core, refs, timer }
let portFactory = null; // nur für Tests
const GRACE_MS = 10000;

function keyOf(o) {
  return JSON.stringify([o.path, o.model || 'F1255', o.baudRate || 9600]);
}

/**
 * Holt (oder startet) den Kern für diese Port-/Modell-Kombination.
 * Änderbare Optionen (Schreibschutz, Alarm-Reset) werden am laufenden Kern gesetzt.
 */
function acquire(o) {
  const key = keyOf(o);
  let entry = cores.get(key);
  if (entry) {
    clearTimeout(entry.timer);
    entry.timer = null;
    entry.refs++;
    entry.core.setOptions({ blockWrites: o.blockWrites === true, resetAlarm: o.resetAlarm !== false });
    return { key, core: entry.core, reused: true };
  }
  const core = new NibeCore({
    path: o.path,
    model: o.model || 'F1255',
    baudRate: o.baudRate || 9600,
    resetAlarm: o.resetAlarm !== false,
    blockWrites: o.blockWrites === true,
    createPort: portFactory || undefined,
    ...(o.coreOptions || {}),
  });
  entry = { core, refs: 1, timer: null };
  cores.set(key, entry);
  core.start();
  return { key, core, reused: false };
}

function release(key, graceMs = GRACE_MS) {
  const entry = cores.get(key);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0) return;
  const stopNow = () => {
    if (cores.get(key) === entry && entry.refs === 0) {
      cores.delete(key);
      entry.core.stop();
    }
  };
  if (graceMs <= 0) return stopNow();
  entry.timer = setTimeout(stopNow, graceMs);
  if (entry.timer.unref) entry.timer.unref();
}

/** Alles sofort beenden (Tests, Prozessende). */
function shutdownAll() {
  for (const [key, entry] of cores) {
    clearTimeout(entry.timer);
    entry.core.stop();
    cores.delete(key);
  }
}

module.exports = {
  acquire,
  release,
  shutdownAll,
  GRACE_MS,
  _setPortFactory: (f) => {
    portFactory = f;
  },
  _size: () => cores.size,
};
