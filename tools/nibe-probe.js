#!/usr/bin/env node
'use strict';
/*
 * Kommunikationstest mit dem echten Kern (serialport + NibeCore), ohne Node-RED.
 * Schreibt nichts zur Pumpe, liest nur.
 *
 *   node tools/nibe-probe.js [Port] [Register,Register,...] [Sekunden]
 *   node tools/nibe-probe.js /dev/ttyAMA0 40004 30
 *
 * Node-RED vorher stoppen (nur ein Programm darf den Port öffnen).
 */
const { NibeCore } = require('../lib/core');

const port = process.argv[2] || '/dev/ttyAMA0';
const regs = (process.argv[3] || '40004').split(',').map((s) => s.trim()).filter(Boolean);
const secs = Number(process.argv[4] || 30);

const t0 = process.hrtime.bigint();
const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
const stamp = () => `${(ms() / 1000).toFixed(3).padStart(7)}s`;

const core = new NibeCore({ path: port, blockWrites: true, resetAlarm: false });
let lastRaw = 0;
let lastTx = 0;
const toTx = []; // Empfang -> Senden (ms)
const toDone = []; // Senden -> von serialport abgeschlossen (ms)
const values = {};

core.on('open', () => console.log(`${stamp()} Port ${port} offen`));
core.on('fault', (f) => console.log(`${stamp()} FEHLER ${f.from}: ${f.message}`));
core.on('trace', ({ kind }) => {
  const t = ms();
  if (kind === 'RAW') lastRaw = t;
  else if (kind === 'TX') {
    lastTx = t;
    toTx.push(t - lastRaw);
  } else if (kind === 'TXDONE') toDone.push(t - lastTx);
});
core.on('announce', (a) => console.log(`${stamp()} Pumpe meldet ${a.model}, Firmware ${a.firmware}`));
for (const r of regs) {
  core.on(r, (item) => {
    values[r] = (values[r] || 0) + 1;
    console.log(`${stamp()} ${r} = ${item.data}${item.unit || ''}`);
  });
}
core.start();
for (const r of regs) core.addRegister(r);

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : NaN);
const max = (a) => (a.length ? Math.max(...a) : NaN);
console.log(`Port ${port}, Register ${regs.join(',')}, ${secs} s, Node ${process.version}`);

const stats = setInterval(() => {
  const s = core.stats;
  console.log(`${stamp()}   [Telegramme ${s.frames}, Anfragen ${s.reads}, ACK von Pumpe ${s.acks}, Werte ${s.updates}]`);
}, 5000);

setTimeout(() => {
  clearInterval(stats);
  const s = core.stats;
  console.log('\nErgebnis:', JSON.stringify(s));
  console.log(
    `Antwortzeit Empfang->Senden: Median ${median(toTx).toFixed(1)} ms, Maximum ${max(toTx).toFixed(1)} ms; ` +
      `Senden->abgeschlossen: Median ${median(toDone).toFixed(1)} ms, Maximum ${max(toDone).toFixed(1)} ms`
  );
  if (s.updates > 0 && s.acks > 0) console.log('=> Die Pumpe antwortet auf unsere Anfragen.');
  else if (s.acks > 0) console.log('=> Die Pumpe bestätigt (ACK), liefert aber keine Werte.');
  else console.log('=> Die Pumpe reagiert nicht auf unsere Antworten.');
  core.stop();
  setTimeout(() => process.exit(0), 200);
}, secs * 1000);
