'use strict';
const { EventEmitter } = require('events');
const { checksumOk } = require('../lib/frames');

/** Port-Attrappe: sammelt alles, was der Kern sendet. */
class MockPort extends EventEmitter {
  constructor() {
    super();
    this.isOpen = false;
    this.written = []; // Arrays
    this.openError = null;
  }
  open(cb) {
    if (this.openError) return setImmediate(() => cb(this.openError));
    this.isOpen = true;
    setImmediate(() => cb(null));
  }
  write(buf, cb) {
    this.written.push(Array.from(buf));
    if (cb) cb(null);
  }
  close(cb) {
    this.isOpen = false;
    if (cb) cb();
  }
}

/** Telegramm Pumpe -> Zubehör bauen (inkl. Prüfsumme). */
function pumpFrame(cmd, data = []) {
  const f = [0x5c, 0x00, 0x20, cmd, data.length, ...data];
  let c = 0;
  for (let i = 2; i < f.length; i++) c ^= f[i];
  if (c === 0x5c) c = 0xc5;
  f.push(c);
  return f;
}

/** Leseantwort 0x6A für ein 16-Bit-Register. */
function readResponse16(register, rawValue) {
  return pumpFrame(0x6a, [register & 0xff, register >> 8, rawValue & 0xff, (rawValue >> 8) & 0xff, 0, 0]);
}

function logSet(entries) {
  // entries: [[register, rawValue16], ...]
  const d = [];
  for (const [r, v] of entries) d.push(r & 0xff, r >> 8, v & 0xff, (v >> 8) & 0xff);
  return pumpFrame(0x68, d);
}

const TOKEN_READ = pumpFrame(0x69);
const TOKEN_WRITE = pumpFrame(0x6b);

module.exports = { MockPort, pumpFrame, readResponse16, logSet, TOKEN_READ, TOKEN_WRITE, checksumOk };
