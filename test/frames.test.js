'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../lib/frames');
const { pumpFrame, TOKEN_READ, TOKEN_WRITE } = require('./helpers');

test('Telegramme sind byte-identisch zum Original (Mitschnitt)', () => {
  assert.deepEqual(f.buildWriteRequest(47044, 370), [192, 107, 6, 196, 183, 114, 1, 0, 0, 173]);
  assert.deepEqual(f.buildWriteRequest(45171, 1), [192, 107, 6, 115, 176, 1, 0, 0, 0, 111]);
  assert.deepEqual(f.buildWriteRequest(48852, 0), [192, 107, 6, 212, 190, 0, 0, 0, 0, 199]);
});

test('negative Schreibwerte werden vorzeichenrichtig als int32 kodiert', () => {
  assert.deepEqual(f.buildWriteRequest(47011, -50).slice(5, 9), [0xce, 0xff, 0xff, 0xff]);
});

test('Prüfsumme: 0xC5 gilt als 0x5C', () => {
  // Nutzdaten so wählen, dass XOR = 0x5C ergibt
  const base = [0x5c, 0x00, 0x20, 0x68, 0x01, 0x00];
  let c = 0;
  for (let i = 2; i < base.length; i++) c ^= base[i];
  const data = c ^ 0x5c; // Datenbyte, das XOR auf 0x5C bringt
  const fr = [0x5c, 0x00, 0x20, 0x68, 0x01, data, 0xc5];
  assert.equal(f.checksumOk(fr), true);
  assert.equal(f.checksumOk([...fr.slice(0, -1), 0x00]), false);
});

test('doppelte 0x5C im Datenbereich werden entfernt, Länge/Prüfsumme angepasst', () => {
  const wire = [0x5c, 0x00, 0x20, 0x6a, 0x07, 0x10, 0x9c, 0x5c, 0x5c, 0x01, 0x00, 0x00];
  let c = 0;
  for (let i = 2; i < wire.length; i++) c ^= wire[i];
  wire.push(c);
  assert.equal(f.checksumOk(wire), true);
  const out = f.unescapeFrame(wire);
  assert.equal(out[4], 6);
  assert.deepEqual(out.slice(5, 11), [0x10, 0x9c, 0x5c, 0x01, 0x00, 0x00]);
  let c2 = 0;
  for (let i = 2; i < out.length - 1; i++) c2 ^= out[i];
  assert.equal(out[out.length - 1], c2);
});

function collect() {
  const got = { frames: [], acks: 0, naks: 0, bad: 0 };
  const p = new f.FrameParser({
    onFrame: (fr) => got.frames.push(fr),
    onAck: () => got.acks++,
    onNak: () => got.naks++,
    onBadChecksum: () => got.bad++,
  });
  return { p, got };
}

test('Parser: zerstückelt (Byte für Byte) und verklebt ergibt dieselben Telegramme', () => {
  const stream = [
    ...TOKEN_READ,
    0x06,
    ...pumpFrame(0x6a, [0x48, 0x9c, 7, 1, 0, 0]),
    ...TOKEN_WRITE,
    0x06,
  ];
  const a = collect();
  a.p.push(Buffer.from(stream));
  const b = collect();
  for (const byte of stream) b.p.push(Buffer.from([byte]));
  assert.equal(a.got.frames.length, 3);
  assert.deepEqual(a.got.frames, b.got.frames);
  assert.equal(a.got.acks, 2);
  assert.equal(b.got.acks, 2);
});

test('Parser: Störbytes und Fremdadressen werden übersprungen, danach wieder synchron', () => {
  const { p, got } = collect();
  p.push(Buffer.from([0x00, 0x13, 0x5c, 0x00, 0x19, 0x62, 0x00, 0x7b, 0xff]));
  p.push(Buffer.from(TOKEN_READ));
  assert.equal(got.frames.length, 1);
  assert.deepEqual(got.frames[0], TOKEN_READ);
});

test('Parser: falsche Prüfsumme wird gemeldet, nächstes Telegramm kommt trotzdem an', () => {
  const { p, got } = collect();
  const bad = [...TOKEN_READ];
  bad[bad.length - 1] ^= 0xff;
  p.push(Buffer.from([...bad, ...TOKEN_WRITE]));
  assert.equal(got.bad, 1);
  assert.equal(got.frames.length, 1);
  assert.deepEqual(got.frames[0], TOKEN_WRITE);
});

test('Parser: angefangenes, nie fertig werdendes Telegramm blockiert nicht', () => {
  let t = 1000;
  const got = [];
  const p = new f.FrameParser({ now: () => t, onFrame: (fr) => got.push(fr), stallMs: 300 });
  p.push(Buffer.from([0x5c, 0x00, 0x20, 0x68, 0x50, 0x01])); // Länge 80 angekündigt, Rest fehlt
  t += 500;
  p.push(Buffer.from(TOKEN_READ));
  p.push(Buffer.from(TOKEN_WRITE));
  assert.equal(got.length >= 1, true);
  assert.deepEqual(got[got.length - 1], TOKEN_WRITE);
});
