'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NibeCore } = require('../lib/core');
const { MockPort, pumpFrame, readResponse16, logSet, TOKEN_READ, TOKEN_WRITE } = require('./helpers');

function setup(extra = {}) {
  let t = 1_000_000;
  const port = new MockPort();
  const core = new NibeCore({ path: '/dev/test', createPort: () => port, now: () => t, retryMs: 20, ...extra });
  const feed = (bytes, dt = 5) => {
    t += dt;
    core.handleBytes(Buffer.from(bytes));
  };
  const last = () => port.written[port.written.length - 1];
  const open = async () => {
    core.start();
    await new Promise((r) => core.once('open', r));
  };
  return { core, port, feed, last, open, advance: (ms) => (t += ms), clock: () => t };
}

test('Token ohne Auftrag wird mit ACK beantwortet', async () => {
  const s = setup({ resetAlarm: false, blockWrites: true });
  await s.open();
  s.feed(TOKEN_READ);
  assert.deepEqual(s.last(), [0x06]);
  s.feed(TOKEN_WRITE);
  assert.deepEqual(s.last(), [0x06]);
  s.core.stop();
});

test('Lese-Token: abonnierte Register werden reihum angefragt', async () => {
  const s = setup({ resetAlarm: false, blockWrites: true });
  await s.open();
  s.core.addRegister('40008');
  s.core.addRegister('40012');
  const asked = [];
  for (let i = 0; i < 6; i++) {
    s.feed(TOKEN_READ);
    const w = s.last();
    asked.push(w[3] | (w[4] << 8));
  }
  // je ein Rücklese-Auftrag zuerst, danach reihum
  assert.deepEqual(asked.slice(0, 2).sort(), [40008, 40012]);
  assert.deepEqual(asked.slice(2), [40008, 40012, 40008, 40012]);
  s.core.stop();
});

test('LOG.SET-Register werden nicht aktiv abgefragt', async () => {
  const s = setup({ resetAlarm: false, blockWrites: true });
  await s.open();
  s.feed(logSet([[40008, 250]]));
  s.core.addRegister('40008');
  s.core.addRegister('40012');
  const asked = new Set();
  for (let i = 0; i < 6; i++) {
    s.feed(TOKEN_READ);
    const w = s.last();
    if (w.length > 1) asked.add(w[3] | (w[4] << 8));
  }
  assert.deepEqual([...asked], [40012]);
  // nach Ablauf des LOG.SET-Fensters wird wieder aktiv gelesen
  s.advance(60000);
  s.feed(TOKEN_READ);
  s.feed(TOKEN_READ);
  const lateAsked = new Set();
  for (let i = 0; i < 4; i++) {
    s.feed(TOKEN_READ);
    const w = s.last();
    if (w.length > 1) lateAsked.add(w[3] | (w[4] << 8));
  }
  assert.ok(lateAsked.has(40008));
  s.core.stop();
});

test('mehrere Nodes für dasselbe Register: Referenzzähler', async () => {
  const s = setup({ resetAlarm: false, blockWrites: true });
  await s.open();
  s.core.addRegister('40008');
  s.core.addRegister('40008');
  assert.deepEqual(s.core.pollList, ['40008']);
  s.core.removeRegister('40008');
  assert.deepEqual(s.core.pollList, ['40008']);
  s.core.removeRegister('40008');
  assert.deepEqual(s.core.pollList, []);
  s.core.stop();
});

test('unbekanntes Register wird abgelehnt und gemeldet', async () => {
  const s = setup({ blockWrites: true });
  const faults = [];
  s.core.on('fault', (f) => faults.push(f));
  await s.open();
  assert.equal(s.core.addRegister('12345'), false);
  assert.equal(faults.length, 1);
  s.core.stop();
});

test('Schreib-Token: Start-Schreibvorgänge zuerst, dann Nutzerwert, Callback nach dem Senden', async () => {
  const s = setup();
  await s.open();
  const seq = [];
  let cbRes;
  s.core.write('47044', 37, (e, ok) => (cbRes = { e, ok }));
  for (let i = 0; i < 5; i++) {
    s.feed(TOKEN_WRITE);
    const w = s.last();
    seq.push(w.length > 1 ? w[3] | (w[4] << 8) : 'ACK');
  }
  assert.deepEqual(seq, [45171, 48852, 45171, 47044, 'ACK']);
  assert.deepEqual(cbRes, { e: null, ok: true });
  s.core.stop();
});

test('Alarm-Reset beim Start lässt sich abschalten, Word-Swap bleibt', async () => {
  const s = setup({ resetAlarm: false });
  await s.open();
  const seq = [];
  for (let i = 0; i < 3; i++) {
    s.feed(TOKEN_WRITE);
    const w = s.last();
    seq.push(w.length > 1 ? w[3] | (w[4] << 8) : 'ACK');
  }
  assert.deepEqual(seq, [48852, 'ACK', 'ACK']);
  s.core.stop();
});

test('Schreibschutz: nichts geht zur Pumpe, auch nicht beim Start', async () => {
  const s = setup({ blockWrites: true });
  await s.open();
  let err;
  s.core.write('47044', 37, (e) => (err = e));
  assert.match(err.message, /gesperrt/);
  for (let i = 0; i < 5; i++) {
    s.feed(TOKEN_WRITE);
    assert.deepEqual(s.last(), [0x06]);
  }
  s.core.stop();
});

test('ungültiger Schreibwert: Fehler sofort, nichts wird gesendet', async () => {
  const s = setup({ resetAlarm: false, blockWrites: false });
  await s.open();
  const errs = [];
  s.core.write('47044', 'abc', (e) => errs.push(e));
  s.core.write('47044', 999, (e) => errs.push(e));
  s.core.write('40008', 20, (e) => errs.push(e));
  s.core.write('99999', 1, (e) => errs.push(e));
  assert.equal(errs.length, 4);
  assert.ok(errs.every((e) => e instanceof Error));
  s.core.stop();
});

test('neuester Wert gewinnt: wartender Auftrag wird ersetzt', async () => {
  const s = setup({ resetAlarm: false });
  await s.open();
  const res = [];
  s.core.write('47044', 36, (e) => res.push(['alt', e && e.message]));
  s.core.write('47044', 38, (e, ok) => res.push(['neu', e, ok]));
  s.feed(TOKEN_WRITE); // Word-Swap
  s.feed(TOKEN_WRITE); // Nutzerwert
  const w = s.last();
  assert.equal((w[5] | (w[6] << 8)), 380);
  assert.equal(res[0][0], 'alt');
  assert.match(res[0][1], /ersetzt/);
  assert.deepEqual(res[1], ['neu', null, true]);
  s.core.stop();
});

test('Schreibauftrag verfällt nach 30 s ohne Token (kein Spät-Schreiben)', async () => {
  const s = setup({ resetAlarm: false });
  await s.open();
  let err;
  s.core.write('47044', 37, (e) => (err = e));
  s.advance(31000);
  s.feed(TOKEN_WRITE); // Word-Swap (läuft nicht ab)
  s.feed(TOKEN_WRITE); // Nutzerwert ist verfallen
  assert.deepEqual(s.last(), [0x06]);
  assert.match(err.message, /verworfen/);
  s.core.stop();
});

test('Rücklesen nach dem Schreiben füllt den neuen Wert ohne Wartezeit', async () => {
  const s = setup({ resetAlarm: false });
  await s.open();
  s.core.write('47044', 37);
  s.feed(TOKEN_WRITE);
  s.feed(TOKEN_WRITE);
  s.feed(TOKEN_READ);
  const w = s.last();
  assert.equal(w[3] | (w[4] << 8), 47044);
  s.feed(readResponse16(47044, 370));
  assert.equal(s.core.getItem('47044').data, 37);
  s.core.stop();
});

test('NAK der Pumpe nach einem Schreibbefehl wird gemeldet', async () => {
  const s = setup({ resetAlarm: false });
  await s.open();
  const faults = [];
  const results = [];
  s.core.on('fault', (f) => faults.push(f));
  s.core.on('write-result', (r) => results.push(r));
  s.core.write('47044', 37);
  s.feed(TOKEN_WRITE);
  s.feed(TOKEN_WRITE);
  s.feed([0x15]);
  assert.equal(results.at(-1).ok, false);
  assert.match(faults.at(-1).message, /NAK/);
  s.core.stop();
});

test('falsche Prüfsumme wird mit NAK beantwortet', async () => {
  const s = setup({ blockWrites: true });
  await s.open();
  const bad = [...TOKEN_READ];
  bad[bad.length - 1] ^= 0x55;
  s.feed(bad);
  assert.deepEqual(s.last(), [0x15]);
  assert.equal(s.core.stats.badChecksum, 1);
  s.core.stop();
});

test('Alarm 251 (Kommunikationsstörung) wird einmal pro Minute quittiert', async () => {
  const s = setup();
  await s.open();
  // Start-Schreibvorgänge abarbeiten
  for (let i = 0; i < 3; i++) s.feed(TOKEN_WRITE);
  s.feed(readResponse16(45001, 251));
  s.feed(TOKEN_WRITE);
  let w = s.last();
  assert.equal(w[3] | (w[4] << 8), 45171);
  s.feed(readResponse16(45001, 251)); // innerhalb 60 s: kein zweiter Reset
  s.feed(TOKEN_WRITE);
  assert.deepEqual(s.last(), [0x06]);
  s.advance(61000);
  s.feed(readResponse16(45001, 251));
  s.feed(TOKEN_WRITE);
  w = s.last();
  assert.equal(w[3] | (w[4] << 8), 45171);
  // anderer Alarm wird NICHT quittiert
  s.advance(61000);
  s.feed(readResponse16(45001, 7));
  s.feed(TOKEN_WRITE);
  assert.deepEqual(s.last(), [0x06]);
  s.core.stop();
});

test('abweichendes Pumpenmodell wird gemeldet', async () => {
  const s = setup({ blockWrites: true });
  const faults = [];
  const announced = [];
  s.core.on('fault', (f) => faults.push(f));
  s.core.on('announce', (a) => announced.push(a));
  await s.open();
  // 0x6D wie im Mitschnitt, aber Modell "F1155-6" statt "F1255-6"
  s.feed(pumpFrame(0x6d, [0x01, 0x24, 0xe3, ...Buffer.from('F1155-6 E PC EM')]));
  assert.deepEqual(announced, [{ model: 'F1155', firmware: 9443 }]);
  assert.equal(faults.length, 1);
  assert.match(faults[0].message, /F1155.*konfiguriert ist F1255/);
  // dieselbe Meldung nochmals: keine zweite Fehlermeldung, kein zweites announce
  s.feed(pumpFrame(0x6d, [0x01, 0x24, 0xe3, ...Buffer.from('F1155-6 E PC EM')]));
  assert.equal(announced.length, 1);
  assert.equal(faults.length, 1);
  s.core.stop();
});

test('Modell F1155 konfiguriert und Pumpe meldet F1155: keine Warnung', async () => {
  const s = setup({ blockWrites: true, model: 'F1155' });
  const faults = [];
  const announced = [];
  s.core.on('fault', (f) => faults.push(f));
  s.core.on('announce', (a) => announced.push(a));
  await s.open();
  s.feed(pumpFrame(0x6d, [0x01, 0x24, 0xe3, ...Buffer.from('F1155-6 E PC EM')]));
  assert.deepEqual(announced, [{ model: 'F1155', firmware: 9443 }]);
  assert.equal(faults.length, 0);
  // LOG.SET-Wert wird mit der F1155-Liste dekodiert
  const got = [];
  s.core.on('40008', (i) => got.push(i.data));
  s.feed(logSet([[40008, 250]]));
  assert.deepEqual(got, [25]);
  s.core.stop();
});

test('Verbindungsausfall: link=false und Fehlermeldung, danach link=true', async () => {
  const s = setup({ blockWrites: true, linkTimeoutMs: 15000 });
  const links = [];
  const faults = [];
  s.core.on('link', (l) => links.push(l));
  s.core.on('fault', (f) => faults.push(f));
  await s.open();
  s.feed(TOKEN_READ);
  s.advance(16000);
  s.core._checkLink();
  s.feed(TOKEN_READ);
  assert.deepEqual(links, [true, false, true]);
  assert.match(faults[0].message, /Keine Telegramme/);
  s.core.stop();
});

test('Port-Fehler beim Öffnen: Meldung und automatischer Neuversuch', async () => {
  const s = setup({ blockWrites: true });
  s.port.openError = new Error('Permission denied');
  const faults = [];
  s.core.on('fault', (f) => faults.push(f));
  s.core.start();
  await new Promise((r) => setTimeout(r, 15));
  assert.match(faults[0].message, /Permission denied/);
  s.port.openError = null;
  await new Promise((r) => s.core.once('open', r));
  s.feed(TOKEN_READ);
  assert.deepEqual(s.last(), [0x06]);
  s.core.stop();
});

test('stop() bricht wartende Schreibaufträge ab und hinterlässt keine Timer', async () => {
  const s = setup({ resetAlarm: false });
  await s.open();
  let err;
  s.core.write('47044', 37, (e) => (err = e));
  s.core.stop();
  assert.match(err.message, /beendet/);
  assert.equal(s.core.port, null);
});

test('setOptions: Schreibschutz aufheben holt die Start-Schreibvorgänge nach, Sperren bricht Aufträge ab', async () => {
  const s = setup({ blockWrites: true });
  await s.open();
  s.feed(TOKEN_WRITE);
  assert.deepEqual(s.last(), [0x06]);
  s.core.setOptions({ blockWrites: false });
  const seq = [];
  for (let i = 0; i < 3; i++) {
    s.feed(TOKEN_WRITE);
    const w = s.last();
    seq.push(w.length > 1 ? w[3] | (w[4] << 8) : 'ACK');
  }
  assert.deepEqual(seq, [45171, 48852, 45171]);
  let err;
  s.core.write('47044', 37, (e) => (err = e));
  s.core.setOptions({ blockWrites: true });
  assert.match(err.message, /gesperrt/);
  s.feed(TOKEN_WRITE);
  assert.deepEqual(s.last(), [0x06]);
  s.core.stop();
});

test('setOptions: gleiche Optionen mehrfach setzen schreibt die Startsequenz nicht erneut', async () => {
  const s = setup();
  await s.open();
  for (let i = 0; i < 3; i++) s.feed(TOKEN_WRITE); // Startsequenz abarbeiten
  s.core.setOptions({ blockWrites: false, resetAlarm: true });
  s.core.setOptions({ blockWrites: false, resetAlarm: true });
  s.feed(TOKEN_WRITE);
  assert.deepEqual(s.last(), [0x06]);
  s.core.stop();
});

test('Poller-Haken (Node-26-Umgehung): setImmediate nach Poller-Ereignissen, kein Dauer-Timer', async () => {
  const { EventEmitter } = require('events');
  const s = setup({ resetAlarm: false, blockWrites: true });
  const poller = new EventEmitter();
  s.port.port = { poller }; // so sieht serialport (SerialPortStream.port.poller) von innen aus
  await s.open();
  assert.equal(poller._nibeKick, true);
  assert.equal(s.core._wakeTimer, null); // Haken gefunden -> kein Timer, auf jeder Node-Version

  const orig = global.setImmediate;
  let kicks = 0;
  global.setImmediate = (fn, ...a) => {
    kicks++;
    return orig(fn, ...a);
  };
  try {
    let got = null;
    poller.once('readable', (e) => (got = e)); // Listener funktionieren unverändert
    assert.equal(poller.emit('readable', null), true);
    assert.equal(got, null);
    assert.equal(kicks, 1);
    poller.emit('writable', null);
    poller.emit('disconnect', null);
    assert.equal(kicks, 3);
    poller.emit('irgendwas');
    assert.equal(kicks, 3);
  } finally {
    global.setImmediate = orig;
  }
  s.core.stop();
});

test('Poller-Haken wird pro Poller nur einmal gesetzt, pollKick:false lässt den Poller unberührt', async () => {
  const { EventEmitter } = require('events');
  const a = setup({ resetAlarm: false, blockWrites: true });
  a.port.port = { poller: new EventEmitter() };
  await a.open();
  const patched = a.port.port.poller.emit;
  assert.equal(a.core._hookPoller(a.port), true);
  assert.equal(a.port.port.poller.emit, patched);
  a.core.stop();

  const b = setup({ resetAlarm: false, blockWrites: true, pollKick: false, wakeMs: 0 });
  const poller = new EventEmitter();
  b.port.port = { poller };
  await b.open();
  assert.equal(poller._nibeKick, undefined);
  assert.equal(b.core._wakeTimer, null);
  b.core.stop();
});

test('ohne Poller (Mock, Fremd-Bindings): Notanker-Timer nur ab Node 26', async () => {
  const s = setup({ resetAlarm: false, blockWrites: true });
  await s.open();
  const major = Number(process.versions.node.split('.')[0]);
  const expected = major >= 26 && process.platform !== 'win32';
  assert.equal(s.core._wakeTimer !== null, expected);
  s.core.stop();
  assert.equal(s.core._wakeTimer, null);
});

test('Wecker-Timer (wakeMs erzwingt ihn): läuft nur bei offenem Port und wird sauber beendet', async () => {
  const on = setup({ resetAlarm: false, blockWrites: true, wakeMs: 5 });
  await on.open();
  assert.notEqual(on.core._wakeTimer, null);
  on.core.stop();
  assert.equal(on.core._wakeTimer, null);

  const off = setup({ resetAlarm: false, blockWrites: true, wakeMs: 0 });
  await off.open();
  assert.equal(off.core._wakeTimer, null);
  off.core.stop();
});

test('Wecker-Timer: Portfehler beendet den Timer, Wiederöffnen startet ihn neu', async () => {
  const s = setup({ resetAlarm: false, blockWrites: true, wakeMs: 5 });
  await s.open();
  assert.notEqual(s.core._wakeTimer, null);
  s.port.emit('error', new Error('weg'));
  assert.equal(s.core._wakeTimer, null);
  await new Promise((r) => s.core.once('open', r));
  assert.notEqual(s.core._wakeTimer, null);
  s.core.stop();
});
