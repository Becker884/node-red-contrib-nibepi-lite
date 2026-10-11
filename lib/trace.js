'use strict';
/*
 * Optionaler Mitschnitt der Telegramme in eine Textdatei, im selben Zeilenformat
 * wie NibePi 1.2.1 (z. B. "2026-10-10 17:14:39.658 SENT: [Register: 47044, Buffer: [...]]"),
 * damit sich Mitschnitte direkt auswerten und gegeneinander vergleichen lassen.
 * Begrenzt auf maxBytes, damit die SD-Karte nicht vollläuft (9600 Baud ~ 250 MB/Tag).
 */
const fs = require('fs');

class TraceFile {
  constructor(file, { maxBytes = 20 * 1024 * 1024, now = Date.now } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.now = now;
    this.bytes = 0;
    this.full = false;
    this.stream = fs.createWriteStream(file, { flags: 'w' });
    this.stream.on('error', () => {
      this.full = true; // z. B. kein Schreibrecht: still abschalten, den Betrieb nicht stören
    });
  }

  stamp() {
    const t = this.now();
    const off = new Date(t).getTimezoneOffset() * 60000;
    return new Date(t - off).toISOString().slice(0, -1).replace('T', ' ');
  }

  write({ kind, data }) {
    if (this.full) return;
    const line = `${this.stamp()} ${kind}: [${data}]\n`;
    if (this.bytes + line.length > this.maxBytes) {
      this.full = true;
      this.stream.write(`${this.stamp()} TRACE: [Größenlimit ${this.maxBytes} Byte erreicht, Mitschnitt beendet]\n`);
      return;
    }
    this.bytes += line.length;
    this.stream.write(line);
  }

  close() {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

module.exports = { TraceFile };
