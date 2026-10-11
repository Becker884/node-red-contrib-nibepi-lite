'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const regs = require('../lib/registers');
const { pumpFrame, logSet, readResponse16 } = require('./helpers');

const lookup = () => regs.buildLookup(regs.loadModel('F1255'));

test('Modell F1255 hat 983 Register und enthält die Pflichtregister', () => {
  const m = regs.loadModel('F1255');
  assert.equal(m.length, 983);
  const lk = regs.buildLookup(m);
  for (const r of ['40008', '47044', '45001', '45171', '48852']) assert.ok(lk.get(r), r);
});

test('LOG.SET: 16-Bit-Werte, Vorzeichen und Faktor', () => {
  const lk = lookup();
  const { found, updates } = regs.decodeFrame(logSet([[40008, 263], [40004, 0xfff6]]), lk, 1000);
  assert.equal(found.length, 2);
  assert.equal(updates.length, 2);
  assert.equal(lk.get('40008').data, 26.3);
  assert.equal(lk.get('40008').raw_data, 26.3);
  assert.equal(lk.get('40008').timestamp, 1000);
  assert.equal(lk.get('40004').data, -1);
});

test('Leseantwort 32 Bit: vertauschte Wortreihenfolge (Werte aus dem Mitschnitt)', () => {
  const lk = lookup();
  // 43416 (s32): Rohbytes [0,0,200,8] -> 2248 ; 42439 (u32, Faktor 10): [9,0,111,169] -> 63319.9
  regs.decodeFrame(pumpFrame(0x6a, [0x98, 0xa9, 0, 0, 200, 8]), lk);
  assert.equal(lk.get('43416').data, 2248);
  regs.decodeFrame(pumpFrame(0x6a, [0xc7, 0xa5, 9, 0, 111, 169]), lk);
  assert.equal(lk.get('42439').data, 63319.9);
});

test('LOG.SET 32 Bit: zwei Einträge à 4 Byte, Low-Word zuerst', () => {
  const lk = lookup();
  // 43416 (s32) = 100000 = 0x000186A0
  regs.decodeFrame(pumpFrame(0x68, [0x98, 0xa9, 0xa0, 0x86, 0x99, 0xa9, 0x01, 0x00]), lk);
  assert.equal(lk.get('43416').data, 100000);
});

test('Wertzuordnung (map): Text in data, Zahl in raw_data', () => {
  const lk = lookup();
  regs.decodeFrame(logSet([[47260, 2]]), lk);
  assert.equal(lk.get('47260').data, 'Hastighet 2');
  assert.equal(lk.get('47260').raw_data, 2);
});

test('unplausible Werte (außerhalb min/max) werden nicht übernommen', () => {
  const lk = lookup();
  const item = lk.get('47044'); // Rohbereich 50..700, Faktor 10 -> 5..70 °C
  const { updates } = regs.decodeFrame(readResponse16(47044, 900), lk);
  assert.equal(updates[0].corrupt, true);
  assert.equal(item.data, undefined);
  regs.decodeFrame(readResponse16(47044, 370), lk);
  assert.equal(item.data, 37);
});

test('Schreibwert: Rundung statt Abschneiden, Komma als Dezimaltrennzeichen', () => {
  const lk = lookup();
  const item = lk.get('47044');
  assert.deepEqual(regs.prepareWrite(item, 37), { ok: true, value: 370 });
  assert.deepEqual(regs.prepareWrite(item, '37,5'), { ok: true, value: 375 });
  // 1.15 * 100 = 114.99999999999999: das Original hätte 114 geschrieben
  const fake = { register: '1', factor: 100, mode: 'R/W', min: '0', max: '0' };
  assert.equal(regs.prepareWrite(fake, 1.15).value, 115);
});

test('Schreibwert: ungültig, nur lesbar, außerhalb des Bereichs', () => {
  const lk = lookup();
  assert.equal(regs.prepareWrite(lk.get('47044'), 'aus').ok, false);
  assert.equal(regs.prepareWrite(lk.get('47044'), NaN).ok, false);
  assert.equal(regs.prepareWrite(lk.get('47044'), 99).ok, false);
  assert.equal(regs.prepareWrite(lk.get('47044'), 2).ok, false);
  assert.equal(regs.prepareWrite(lk.get('40008'), 20).ok, false);
  assert.equal(regs.prepareWrite(undefined, 1).ok, false);
});

test('Modellerkennung aus dem 0x6D-Telegramm (Mitschnitt)', () => {
  const fr = [92, 0, 32, 109, 18, 1, 36, 227, 70, 49, 50, 53, 53, 45, 54, 32, 69, 32, 80, 67, 32, 69, 77, 185];
  assert.deepEqual(regs.parseAnnouncement(fr), { model: 'F1255', firmware: 9443 });
});

test('Modellname wird geprüft (kein Pfad-Trick, unbekanntes Modell)', () => {
  assert.throws(() => regs.loadModel('../etc/passwd'));
  assert.throws(() => regs.loadModel('F9999'));
});

test('alle mitgelieferten Modelle sind ladbar, vollständig und ohne doppelte Register', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'models');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.includes('F1255.json') && files.includes('F1155.json'));
  for (const f of files) {
    const list = regs.loadModel(f.replace(/\.json$/, ''));
    assert.ok(list.length > 900, `${f}: zu wenige Register`);
    const seen = new Set();
    for (const r of list) {
      for (const k of ['register', 'factor', 'size', 'mode', 'titel']) assert.ok(r[k] !== undefined, `${f}: ${r.register} ohne ${k}`);
      assert.ok(!seen.has(r.register), `${f}: doppeltes Register ${r.register}`);
      seen.add(r.register);
    }
  }
});
