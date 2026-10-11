'use strict';
/*
 * NibeCore - minimaler Kern für NIBE F-Serie (RS485, Zubehör-Adresse 0x20).
 *
 * Ablauf (wie node-red-contrib-nibepi 1.2.1):
 *   - Die Pumpe sendet zyklisch Token (0x69 = Leseanfrage erlaubt,
 *     0x6B = Schreibbefehl erlaubt). Auf jedes Token antworten wir sofort mit
 *     einer Anfrage aus der Warteschlange oder mit ACK.
 *   - Alle anderen Telegramme der Pumpe (LOG.SET 0x68, Antworten 0x6A,
 *     Meldung 0x6D, ...) werden mit ACK bestätigt und ausgewertet.
 *
 * Abgeleitet aus node-red-contrib-nibepi / nibepi (MIT, (c) 2020 anerdins).
 */

const { EventEmitter } = require('events');
const frames = require('./frames');
const regs = require('./registers');

const { CMD, ACK, NAK } = frames;

const NOOP = () => {};

const ALARM_REGISTER = '45001';
const ALARM_RESET_REGISTER = '45171';
const WORD_SWAP_REGISTER = '48852';
const COMM_ALARM = 251; // "Kommunikationsstörung" - wird (wie bisher) quittiert

class NibeCore extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.path          serieller Port, z. B. /dev/ttyAMA0 oder /dev/serial/by-id/...
   * @param {string} [o.model]       Modelldatei in models/ (Standard F1255)
   * @param {string} [o.modelDir]
   * @param {number} [o.baudRate]    9600
   * @param {boolean}[o.resetAlarm]  Alarm beim Start (und Alarm 251 im Betrieb) quittieren, Standard true
   * @param {boolean}[o.blockWrites] gar nichts zur Pumpe schreiben (auch keine Start-Schreibvorgänge)
   * @param {function}[o.createPort] Port-Fabrik (Tests); sonst serialport
   */
  constructor(o = {}) {
    super();
    this.setMaxListeners(0);
    this.path = o.path;
    this.modelName = o.model || 'F1255';
    this.baudRate = o.baudRate || 9600;
    this.resetAlarm = o.resetAlarm !== false;
    this.blockWrites = o.blockWrites === true;
    this.createPort = o.createPort;
    this.now = o.now || Date.now;
    this.retryMs = o.retryMs ?? 10000;
    this.writeTtlMs = o.writeTtlMs ?? 30000;
    this.linkTimeoutMs = o.linkTimeoutMs ?? 15000;
    this.logsetWindowMs = o.logsetWindowMs ?? 30000;
    // Node.js 26 + serialport (bindings-cpp): Der native Poller ruft sein JS-Callback ohne Callback-Scope
    // auf. Unter Node 26 werden danach wartende Promise-Fortsetzungen nicht abgearbeitet, bis irgendein
    // anderes Ereignis die Event-Loop weckt. serialport liest per `await`, also kommen Daten verspätet.
    // Abhilfe 1 (Standard): nach jedem Poller-Ereignis ein setImmediate einplanen (kostet im Leerlauf nichts).
    // Abhilfe 2 (nur wenn der Poller nicht gefunden wird, ab Node 26): leerer 5-ms-Timer.
    // wakeMs überschreibt: > 0 erzwingt den Timer, 0 schaltet ihn ab. pollKick:false schaltet Abhilfe 1 ab.
    this.pollKick = o.pollKick !== false;
    this.wakeMs = o.wakeMs;

    this._registers = regs.loadModel(this.modelName, o.modelDir); // bleibt dasselbe Array-Objekt
    this._lookup = regs.buildLookup(this._registers);

    this.refs = new Map(); // Register -> Anzahl Abonnenten
    this.pollList = []; // Reihenfolge der zyklisch gelesenen Register
    this.rr = 0;
    this.onDemand = [];
    this.sendQueue = [];
    this._logsetAt = new Map();
    this._lastAlarmReset = 0;
    this._startupQueued = false;
    this._lastTx = null;
    this._lastFrameAt = 0;
    this.linked = false;
    this.pump = null; // { model, firmware } nach 0x6D
    this.stats = { frames: 0, badChecksum: 0, acks: 0, naks: 0, reads: 0, writes: 0, updates: 0, corrupt: 0 };

    this._stopped = true;
    this.port = null;
    this._retryTimer = null;
    this._linkTimer = null;
    this._wakeTimer = null;
    this._faultSeen = new Map();

    this.parser = new frames.FrameParser({
      now: this.now,
      onFrame: (frame, raw) => this._onFrame(frame, raw),
      onAck: () => this._onAck(),
      onNak: () => this._onNak(),
      onBadChecksum: (raw) => {
        this.stats.badChecksum++;
        this._trace('CHKSUM', raw);
        this._tx([NAK]);
      },
    });
  }

  /**
   * Optionen im laufenden Betrieb ändern (z. B. nach einem Deploy in Node-RED).
   * Wird der Schreibschutz aufgehoben, bevor die Start-Schreibvorgänge liefen,
   * werden diese jetzt nachgeholt.
   */
  setOptions(o = {}) {
    if (o.resetAlarm !== undefined) this.resetAlarm = o.resetAlarm !== false;
    if (o.blockWrites !== undefined) {
      this.blockWrites = o.blockWrites === true;
      if (this.blockWrites) {
        // laufende Schreibaufträge abbrechen, damit nach dem Sperren nichts mehr hinausgeht
        for (const w of this.sendQueue.splice(0)) if (w.cb) w.cb(new Error('Schreiben ist gesperrt (Schreibschutz aktiv)'));
        this._startupQueued = false;
      }
    }
    if (!this._stopped) this._queueStartupWrites();
  }

  /** Array aller Register (für global.register). Identität bleibt konstant. */
  get registers() {
    return this._registers;
  }

  getItem(address) {
    return this._lookup.get(String(address));
  }

  // ------------------------------------------------------------------ Lebenszyklus

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._lastFrameAt = 0;
    this._queueStartupWrites();
    this._open();
    this._linkTimer = setInterval(() => this._checkLink(), 5000);
    if (this._linkTimer.unref) this._linkTimer.unref();
    setImmediate(() => this.emit('ready'));
  }

  stop() {
    this._stopped = true;
    this._startupQueued = false;
    clearTimeout(this._retryTimer);
    clearInterval(this._linkTimer);
    this._retryTimer = null;
    this._linkTimer = null;
    this._stopWake();
    const p = this.port;
    this.port = null;
    if (p) {
      p.removeAllListeners && p.removeAllListeners();
      try {
        if (p.isOpen) p.close(() => {});
      } catch (e) {
        /* ignorieren */
      }
    }
    // offene Schreibaufträge abbrechen
    for (const w of this.sendQueue.splice(0)) if (w.cb) w.cb(new Error('Verbindung wird beendet'));
  }

  _defaultPort() {
    const { SerialPort } = require('serialport');
    return new SerialPort({
      path: this.path,
      baudRate: this.baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      autoOpen: false,
    });
  }

  _open() {
    if (this._stopped) return;
    let port;
    try {
      port = this.createPort ? this.createPort({ path: this.path, baudRate: this.baudRate }) : this._defaultPort();
    } catch (e) {
      this._portProblem(e);
      return;
    }
    this.port = port;
    port.on('data', (b) => this.handleBytes(b));
    port.on('error', (e) => this._portProblem(e));
    port.on('close', () => {
      if (!this._stopped && this.port === port) this._portProblem(new Error('Port wurde geschlossen'));
    });
    port.open((err) => {
      if (err) return this._portProblem(err);
      this._startWake(this.pollKick && this._hookPoller(port));
      this.emit('open');
    });
  }

  // Hängt an den Poller von serialport (port.port.poller): nach jedem Ereignis wird ein setImmediate
  // eingeplant, das die Event-Loop einmal durchlaufen lässt und damit die Promise-Warteschlange leert.
  // Gibt true zurück, wenn der Poller gefunden wurde (nur Unix-Bindings haben einen).
  _hookPoller(port) {
    const poller = port && port.port && port.port.poller;
    if (!poller || typeof poller.emit !== 'function') return false;
    if (poller._nibeKick) return true;
    const emit = poller.emit;
    poller.emit = function (ev, ...args) {
      const r = emit.call(this, ev, ...args);
      if (ev === 'readable' || ev === 'writable' || ev === 'disconnect') setImmediate(NOOP);
      return r;
    };
    poller._nibeKick = true;
    return true;
  }

  _startWake(hooked) {
    this._stopWake();
    let ms = this.wakeMs;
    if (ms === undefined || ms === null) {
      const major = Number(process.versions.node.split('.')[0]);
      ms = !hooked && major >= 26 && process.platform !== 'win32' ? 5 : 0;
    }
    if (!(ms > 0)) return;
    this._wakeTimer = setInterval(NOOP, ms);
    if (this._wakeTimer.unref) this._wakeTimer.unref();
  }

  _stopWake() {
    if (this._wakeTimer) clearInterval(this._wakeTimer);
    this._wakeTimer = null;
  }

  _portProblem(err) {
    if (this._stopped) return;
    this._fault('serial', `${this.path}: ${err.message}`);
    this._setLink(false);
    this._stopWake();
    const old = this.port;
    this.port = null;
    if (old) {
      old.removeAllListeners && old.removeAllListeners();
      try {
        if (old.isOpen) old.close(() => {});
      } catch (e) {
        /* ignorieren */
      }
    }
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._open(), this.retryMs);
  }

  _fault(from, message) {
    // gleiche Meldung höchstens einmal pro Minute melden
    const key = `${from}|${message}`;
    const t = this.now();
    if (t - (this._faultSeen.get(key) || 0) < 60000) return;
    this._faultSeen.set(key, t);
    this.emit('fault', { from, message });
  }

  _setLink(up) {
    if (this.linked === up) return;
    this.linked = up;
    this.emit('link', up);
  }

  _checkLink() {
    if (this.linked && this.now() - this._lastFrameAt > this.linkTimeoutMs) {
      this._setLink(false);
      this._fault('core', `Keine Telegramme von der Pumpe seit ${Math.round(this.linkTimeoutMs / 1000)} s`);
    }
  }

  // ------------------------------------------------------------------ Senden

  _tx(bytes) {
    const p = this.port;
    if (!p || !p.isOpen) {
      this._trace('TX-FAIL', 'Port nicht offen');
      return false;
    }
    this._trace('TX', bytes);
    p.write(Buffer.from(bytes), (err) => {
      if (err) this._fault('serial', `Schreibfehler: ${err.message}`);
      this._trace('TXDONE', err ? `Fehler: ${err.message}` : 'ok');
    });
    return true;
  }

  _trace(kind, data) {
    if (this.listenerCount('trace') > 0) this.emit('trace', { kind, data });
  }

  // ------------------------------------------------------------------ Register verwalten

  /** Register zyklisch lesen (Referenzzähler, mehrere Nodes pro Register möglich). */
  addRegister(address) {
    const key = String(address);
    const item = this._lookup.get(key);
    if (!item) {
      this._fault('Register', `Register ${key} ist nicht in der Datenbank (${this.modelName})`);
      return false;
    }
    const n = this.refs.get(key) || 0;
    this.refs.set(key, n + 1);
    if (n === 0) {
      this.pollList.push(key);
      this.requestRead(key);
    }
    return true;
  }

  removeRegister(address) {
    const key = String(address);
    const n = this.refs.get(key) || 0;
    if (n <= 1) {
      this.refs.delete(key);
      const i = this.pollList.indexOf(key);
      if (i !== -1) {
        this.pollList.splice(i, 1);
        if (this.rr > i) this.rr--;
      }
    } else {
      this.refs.set(key, n - 1);
    }
  }

  _isLogset(key) {
    const t = this._logsetAt.get(key);
    const active = t !== undefined && this.now() - t < this.logsetWindowMs;
    const item = this._lookup.get(key);
    if (item) item.logset = active;
    return active;
  }

  /** Einmalige Leseanfrage (z. B. Rücklesen nach Schreiben). */
  requestRead(address) {
    const key = String(address);
    if (!this._lookup.has(key)) return;
    if (this._isLogset(key)) return; // kommt ohnehin über LOG.SET
    if (!this.onDemand.includes(key)) this.onDemand.push(key);
  }

  _nextReadRequest() {
    while (this.onDemand.length) {
      const key = this.onDemand.shift();
      if (!this._isLogset(key)) return frames.buildReadRequest(Number(key));
    }
    const n = this.pollList.length;
    for (let k = 0; k < n; k++) {
      if (this.rr >= n) this.rr = 0;
      const key = this.pollList[this.rr++];
      if (!this._isLogset(key)) return frames.buildReadRequest(Number(key));
    }
    return null;
  }

  // ------------------------------------------------------------------ Schreiben

  _queueStartupWrites() {
    if (this.blockWrites || this._startupQueued) return;
    this._startupQueued = true;
    const q = (register, value) => {
      const prep = regs.prepareWrite(this.getItem(register), value);
      if (!prep.ok) return;
      this.sendQueue.push({
        register,
        frame: frames.buildWriteRequest(Number(register), prep.value),
        cb: null,
        expires: 0, // Start-Schreibvorgänge verfallen nicht
        startup: true,
      });
    };
    // Reihenfolge wie im Original: Alarm quittieren, Word-Swap = 0, Alarm quittieren
    if (this.resetAlarm) q(ALARM_RESET_REGISTER, 1);
    q(WORD_SWAP_REGISTER, 0);
    if (this.resetAlarm) q(ALARM_RESET_REGISTER, 1);
  }

  /**
   * Wert zur Pumpe schreiben. cb(err, true) wird aufgerufen, sobald das
   * Telegramm auf der Leitung gesendet wurde (wie im Original).
   */
  write(address, value, cb = () => {}) {
    const key = String(address);
    if (this.blockWrites) return cb(new Error('Schreiben ist gesperrt (Schreibschutz aktiv)'));
    const prep = regs.prepareWrite(this.getItem(key), value);
    if (!prep.ok) {
      this._fault('Senden', prep.error);
      return cb(new Error(prep.error));
    }
    const entry = {
      register: key,
      frame: frames.buildWriteRequest(Number(key), prep.value),
      cb,
      expires: this.now() + this.writeTtlMs,
      startup: false,
    };
    // Neuester Wert gewinnt: wartender Auftrag für dasselbe Register wird ersetzt.
    const i = this.sendQueue.findIndex((w) => w.register === key && !w.startup);
    if (i !== -1) {
      const old = this.sendQueue[i];
      this.sendQueue[i] = entry;
      if (old.cb) old.cb(new Error('Durch einen neueren Wert ersetzt'));
    } else {
      this.sendQueue.push(entry);
    }
    return undefined;
  }

  _takeWrite() {
    const t = this.now();
    while (this.sendQueue.length) {
      const w = this.sendQueue.shift();
      if (w.expires && t > w.expires) {
        if (w.cb) w.cb(new Error('Schreibbefehl verworfen: keine Verbindung zur Pumpe'));
        continue;
      }
      return w;
    }
    return null;
  }

  // ------------------------------------------------------------------ Empfangen

  /** Rohbytes vom Port (oder aus einem Test) verarbeiten. */
  handleBytes(chunk) {
    if (this.listenerCount('trace') > 0) this._trace('RAW', Array.from(chunk));
    this.parser.push(chunk);
  }

  _onAck() {
    this.stats.acks++;
    const tx = this._lastTx;
    if (tx && tx.kind === 'write' && this.now() - tx.t < 1000) {
      this._lastTx = null;
      this.emit('write-result', { register: tx.register, ok: true });
    }
  }

  _onNak() {
    this.stats.naks++;
    const tx = this._lastTx;
    if (tx && tx.kind === 'write' && this.now() - tx.t < 1000) {
      this._lastTx = null;
      this._fault('Senden', `Pumpe hat Register ${tx.register} nicht akzeptiert (NAK)`);
      this.emit('write-result', { register: tx.register, ok: false });
    }
  }

  _onFrame(frame) {
    const now = this.now();
    this.stats.frames++;
    this._lastFrameAt = now;
    this._setLink(true);
    this._trace('OK', frame);

    this._respond(frame, now);

    if (frame[3] === CMD.ANNOUNCE) this._onAnnouncement(frame);
    if (frame[3] === CMD.LOG_SET || frame[3] === CMD.READ_RESPONSE) this._onData(frame, now);
  }

  _respond(frame, now) {
    const cmd = frame[3];
    const noData = frame[4] === 0x00;
    if (cmd === CMD.READ_TOKEN && noData) {
      const req = this._nextReadRequest();
      if (req) {
        this._lastTx = { kind: 'read', register: req[3] | (req[4] << 8), t: now };
        this.stats.reads++;
        this._tx(req);
      } else {
        this._tx([ACK]);
      }
    } else if (cmd === CMD.WRITE_TOKEN && noData) {
      const w = this._takeWrite();
      if (w) {
        this._lastTx = { kind: 'write', register: w.register, t: now };
        this.stats.writes++;
        this._trace('SENT', `Register: ${w.register}, Buffer: ${JSON.stringify(w.frame)}`);
        this._tx(w.frame);
        this.emit('ack', w.register);
        if (w.cb) w.cb(null, true);
        // Rücklesen, damit der neue Wert ohne Wartezeit in global.register steht
        if (!w.startup) this.requestRead(w.register);
      } else {
        this._tx([ACK]);
      }
    } else {
      this._tx([ACK]);
    }
  }

  _onAnnouncement(frame) {
    let info;
    try {
      info = regs.parseAnnouncement(frame);
    } catch (e) {
      return;
    }
    const changed = !this.pump || this.pump.model !== info.model || this.pump.firmware !== info.firmware;
    this.pump = info;
    if (changed) {
      this.emit('announce', info);
      if (info.model !== this.modelName) {
        this._fault(
          'core',
          `Pumpe meldet ${info.model}, konfiguriert ist ${this.modelName} - Registerliste passt eventuell nicht`
        );
      }
    }
    // Alarm 251 (Kommunikationsstörung) wie bisher erkennen und quittieren
    if (this.resetAlarm && !this.blockWrites) this.requestRead(ALARM_REGISTER);
  }

  _onData(frame, now) {
    const { found, updates } = regs.decodeFrame(frame, this._lookup, now);
    if (frame[3] === CMD.LOG_SET) {
      for (const item of found) {
        this._logsetAt.set(String(item.register), now);
        item.logset = true;
      }
    }
    for (const u of updates) {
      if (u.corrupt) {
        this.stats.corrupt++;
        this._fault('Daten', `Unplausibler Wert von Register ${u.item.register} (${u.item.titel}): ${u.raw}`);
        continue;
      }
      this.stats.updates++;
      this.emit(String(u.item.register), u.item);
      this.emit('data', u.item);
      if (
        this.resetAlarm &&
        !this.blockWrites &&
        u.item.register === ALARM_REGISTER &&
        u.raw === COMM_ALARM &&
        now - this._lastAlarmReset > 60000
      ) {
        this._lastAlarmReset = now;
        this.write(ALARM_RESET_REGISTER, 1);
      }
    }
  }
}

module.exports = { NibeCore, ALARM_REGISTER, ALARM_RESET_REGISTER, WORD_SWAP_REGISTER };
