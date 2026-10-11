'use strict';
/*
 * Telegramm-Ebene des NIBE-F-Serie-RS485-Protokolls (Zubehör-Adresse 0x20).
 *
 * Abgeleitet aus node-red-contrib-nibepi / nibepi (MIT, (c) 2020 anerdins).
 * Reines Modul ohne Seiteneffekte, damit es ohne Pumpe testbar ist.
 */

const START = 0x5c;
const ACK = 0x06;
const NAK = 0x15;
const ADDR_ACCESSORY = 0x20;

const CMD = {
  READ_TOKEN: 0x69, // Pumpe: "Zubehör darf eine Leseanfrage senden"
  READ_RESPONSE: 0x6a,
  WRITE_TOKEN: 0x6b, // Pumpe: "Zubehör darf einen Schreibbefehl senden"
  LOG_SET: 0x68, // zyklisches Telegramm mit den LOG.SET-Registern
  ANNOUNCE: 0x6d, // Modell-/Firmware-Meldung der Pumpe
};

/** XOR über bytes[from, to). */
function xor(bytes, from, to) {
  let c = 0;
  for (let i = from; i < to; i++) c ^= bytes[i];
  return c;
}

/** Leseanfrage Zubehör -> Pumpe: C0 69 02 <reg lo> <reg hi> <xor> */
function buildReadRequest(register) {
  const f = [0xc0, CMD.READ_TOKEN, 0x02, register & 0xff, (register >> 8) & 0xff];
  f.push(xor(f, 0, f.length));
  return f;
}

/** Schreibbefehl Zubehör -> Pumpe: C0 6B 06 <reg lo> <reg hi> <int32 LE> <xor> */
function buildWriteRequest(register, value) {
  const f = [
    0xc0,
    CMD.WRITE_TOKEN,
    0x06,
    register & 0xff,
    (register >> 8) & 0xff,
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  ];
  f.push(xor(f, 0, f.length));
  return f;
}

/**
 * Prüft ein vollständiges Telegramm (Rohbytes von der Leitung).
 * Prüfsumme = XOR über Adresse..letztes Datenbyte; ein Wert 0x5C wird von der
 * Pumpe als 0xC5 gesendet.
 */
function checksumOk(frame) {
  const len = frame[4];
  const calc = xor(frame, 2, len + 5);
  const got = frame[len + 5];
  return got === calc || (got === 0xc5 && calc === 0x5c);
}

/**
 * Entfernt doppelte 0x5C im Datenbereich (Original-Verhalten von NibePi):
 * Länge herunterzählen, Prüfsumme neu berechnen.
 */
function unescapeFrame(frame) {
  const out = Array.from(frame);
  let changed = false;
  for (let i = 5; i < out.length - 1; i++) {
    if (out[i] === START && out[i + 1] === START) {
      out.splice(i, 1);
      out[4] = out[4] - 1;
      changed = true;
    }
  }
  if (changed) out[out.length - 1] = xor(out, 2, out[4] + 5);
  return out;
}

/**
 * Streaming-Parser: nimmt beliebig zerstückelte Bytes entgegen und liefert
 * vollständige, geprüfte Telegramme an die Pumpen-Adresse 0x20.
 *
 * Gegenüber dem Original (das nur einen Chunk-Anfang auswertet) geht kein
 * Telegramm verloren, wenn zwei Telegramme in einem Chunk ankommen, und nach
 * Störungen wird neu synchronisiert.
 *
 * Callbacks: onFrame(frameArray, rawArray), onAck(), onNak(), onBadChecksum(rawArray)
 */
class FrameParser {
  constructor({ onFrame, onAck, onNak, onBadChecksum, now = Date.now, stallMs = 300 } = {}) {
    this.onFrame = onFrame || (() => {});
    this.onAck = onAck || (() => {});
    this.onNak = onNak || (() => {});
    this.onBadChecksum = onBadChecksum || (() => {});
    this.now = now;
    this.stallMs = stallMs;
    this.buf = Buffer.alloc(0);
    this.partialSince = 0;
    this.junkBytes = 0;
  }

  push(chunk) {
    const t = this.now();
    // Ein angefangenes Telegramm, das nicht fertig wird, verwerfen wir (sonst
    // könnte ein zufälliges 0x5C in Störbytes die Auswertung blockieren).
    if (this.partialSince && t - this.partialSince > this.stallMs && this.buf.length > 0) {
      this.buf = this.buf.subarray(1);
      this.junkBytes++;
      this.partialSince = 0;
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    this._scan(t);
    if (this.buf.length > 4096) this.buf = this.buf.subarray(this.buf.length - 512);
  }

  _scan(t) {
    const b = this.buf;
    let i = 0;
    let waiting = false;
    while (i < b.length) {
      const x = b[i];
      if (x === START) {
        if (b.length - i < 5) {
          waiting = true;
          break;
        }
        if (b[i + 1] !== 0x00 || b[i + 2] !== ADDR_ACCESSORY) {
          this.junkBytes++;
          i++;
          continue;
        }
        const total = b[i + 4] + 6;
        if (b.length - i < total) {
          waiting = true;
          break;
        }
        const raw = Array.from(b.subarray(i, i + total));
        if (checksumOk(raw)) {
          this.onFrame(unescapeFrame(raw), raw);
          i += total;
        } else {
          this.onBadChecksum(raw);
          i++; // nur das Startbyte verwerfen und im Rest neu suchen
        }
      } else if (x === ACK) {
        this.onAck();
        i++;
      } else if (x === NAK) {
        this.onNak();
        i++;
      } else {
        this.junkBytes++;
        i++;
      }
    }
    this.buf = b.subarray(i);
    if (waiting) {
      if (!this.partialSince) this.partialSince = t;
    } else {
      this.partialSince = 0;
    }
  }
}

module.exports = {
  START,
  ACK,
  NAK,
  ADDR_ACCESSORY,
  CMD,
  xor,
  buildReadRequest,
  buildWriteRequest,
  checksumOk,
  unescapeFrame,
  FrameParser,
};
