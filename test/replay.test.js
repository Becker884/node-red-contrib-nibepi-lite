'use strict';
/*
 * Replay-Test: spielt den echten Mitschnitt (NIBE F1255-6, NibePi 1.2.1) Byte für
 * Byte in den neuen Kern und vergleicht mit den Ausgaben des Originals.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { NibeCore } = require('../lib/core');
const { MockPort } = require('./helpers');
const fx = require('./fixtures/f1255-replay.json');

function makeCore(extra = {}) {
  let t = 1_000_000;
  const port = new MockPort();
  const core = new NibeCore({ path: '/dev/null', createPort: () => port, now: () => t, ...extra });
  return { core, port, advance: (ms) => (t += ms), clock: () => t };
}

/** Spielt den Mitschnitt mit den echten Zeitabständen ein. */
function replay(core, advance, hook) {
  let last = 0;
  fx.chunks.forEach((chunk, i) => {
    advance(fx.times[i] - last);
    last = fx.times[i];
    if (hook) hook(i);
    core.handleBytes(Buffer.from(chunk));
  });
}

function opened(core) {
  return new Promise((resolve) => core.once('open', resolve));
}

test('Replay: alle dekodierten Werte stimmen mit NibePi 1.2.1 überein', async () => {
  const { core, advance } = makeCore();
  const seen = [];
  core.on('data', (item) => seen.push({ register: item.register, raw_data: item.raw_data, data: item.data }));
  core.start();
  await opened(core);

  replay(core, advance);

  assert.equal(core.stats.frames, fx.ok.length, 'Telegramme');
  assert.equal(core.stats.badChecksum, 0);
  assert.equal(core.parser.junkBytes, 0);
  assert.equal(core.stats.corrupt, 0);

  assert.equal(seen.length, fx.data.length, 'Anzahl Wertaktualisierungen');
  let diff = 0;
  fx.data.forEach((e, i) => {
    const g = seen[i];
    if (g.register !== e.register || g.raw_data !== e.raw_data || g.data !== e.data) {
      if (diff++ < 5) console.log('Abweichung', i, e, g);
    }
  });
  assert.equal(diff, 0, 'Abweichungen');
  core.stop();
});

test('Replay: Modell und Firmware werden erkannt', async () => {
  const { core, advance } = makeCore();
  const announced = [];
  core.on('announce', (a) => announced.push(a));
  core.start();
  await opened(core);
  replay(core, advance);
  assert.deepEqual(announced, [{ model: 'F1255', firmware: 9443 }]);
  core.stop();
});

test('Replay: Startsequenz schreibt wie das Original 45171, 48852, 45171', async () => {
  const { core, port, advance } = makeCore();
  core.start();
  await opened(core);
  replay(core, advance);
  const writes = port.written.filter((w) => w[1] === 0x6b);
  const original = fx.sent.slice(0, 3).map((s) => s.buffer);
  assert.deepEqual(writes.slice(0, 3), original);
  core.stop();
});

test('Replay: Schreibbefehl 47044 = 37 °C ergibt das Telegramm des Originals', async () => {
  const { core, port, advance } = makeCore();
  core.start();
  await opened(core);
  let cbResult;
  let fired = false;
  replay(core, advance, (i) => {
    if (i === 1200 && !fired) {
      fired = true;
      core.write('47044', 37, (err, ok) => (cbResult = { err, ok }));
    }
  });
  const original = fx.sent[3].buffer; // [192,107,6,196,183,114,1,0,0,173]
  assert.deepEqual(original, [192, 107, 6, 196, 183, 114, 1, 0, 0, 173]);
  const writes = port.written.filter((w) => w[1] === 0x6b);
  assert.ok(writes.some((w) => JSON.stringify(w) === JSON.stringify(original)), '47044-Telegramm wurde gesendet');
  assert.equal(cbResult.err, null);
  assert.equal(cbResult.ok, true);
  core.stop();
});

test('Replay: auf jedes Token folgt eine Antwort (Anfrage oder ACK)', async () => {
  const { core, port, advance } = makeCore();
  for (const r of ['40008', '40012', '43086']) core.addRegister(r);
  core.start();
  await opened(core);
  let tokens = 0;
  replay(core, advance);
  for (const f of fx.ok) if (f[3] === 0x69 || f[3] === 0x6b) tokens++;
  const responses = port.written.length;
  // plus ACKs für alle anderen Telegramme: insgesamt eine Antwort je Telegramm
  assert.equal(responses, fx.ok.length);
  assert.ok(tokens > 400);
  core.stop();
});
