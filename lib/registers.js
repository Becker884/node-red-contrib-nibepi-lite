'use strict';
/*
 * Register-Datenbank, Dekodierung (LOG.SET 0x68 und Leseantwort 0x6A) und
 * Kodierung von Schreibwerten.
 *
 * Die Dekodierung folgt Schritt für Schritt node-red-contrib-nibepi 1.2.1
 * (MIT, (c) 2020 anerdins), damit `item.data` / `item.raw_data` exakt gleich
 * bleiben. Abweichungen sind unten mit "ABWEICHUNG" markiert.
 */

const fs = require('fs');
const path = require('path');
const { CMD } = require('./frames');

/** Lädt die Modelldatei (frische Kopie, damit Instanzen sich nicht teilen). */
function loadModel(name, dir = path.join(__dirname, '..', 'models')) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Ungültiger Modellname: ${name}`);
  const file = path.join(dir, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Modell nicht unterstützt: ${name} (keine ${file})`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function buildLookup(registers) {
  const m = new Map();
  for (const item of registers) m.set(String(item.register), item);
  return m;
}

/** Erkennt Modell und Firmware aus dem 0x6D-Telegramm der Pumpe. */
function parseAnnouncement(frame) {
  const modelLength = frame[4] + 5;
  const parts = Buffer.from(frame).subarray(8, modelLength).toString().split(' ');
  const firmware = frame[6] * 256 + frame[7];
  if (['VVM', 'SMO', 'Tehowatti', 'STAR'].includes(parts[0])) parts[0] = parts[0] + parts[1];
  let model = parts[0].split('-')[0];
  model = model.replace(',', '');
  return { model, firmware };
}

/**
 * Dekodiert ein LOG.SET- (0x68) oder Antwort-Telegramm (0x6A).
 * Gibt zurück: { found: [item...], updates: [{item, data, raw}] }
 *  - found:   alle im Telegramm enthaltenen, bekannten Register
 *  - updates: Register mit gültigem Wert (Plausibilitätsprüfung bestanden);
 *             item.data / item.raw_data / item.timestamp sind bereits gesetzt.
 */
function decodeFrame(buf, lookup, now = Date.now()) {
  const cmd = buf[3];
  const found = [];
  const updates = [];
  if (cmd !== CMD.LOG_SET && cmd !== CMD.READ_RESPONSE) return { found, updates };

  for (let i = 5; i < buf.length - 3; i = i + 1) {
    const address = buf[i + 1] * 256 + buf[i];
    const item = lookup.get(String(address));
    if (!item) {
      i = i + 3;
      continue;
    }
    found.push(item);

    let data;
    switch (item.size) {
      case 's32':
        if (cmd === CMD.LOG_SET) {
          data = buf[i + 2] | (buf[i + 3] << 8) | (buf[i + 6] << 16) | (buf[i + 7] << 24);
          i = i + 7;
        } else {
          // Leseantwort: Wortreihenfolge vertauscht (Pumpe mit Word-Swap = 0)
          data = buf[i + 4] | (buf[i + 5] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24);
          i = i + 5;
        }
        if (data >= 2147483647) data = data - 4294967294;
        break;
      case 'u32':
        if (cmd === CMD.LOG_SET) {
          data = buf[i + 2] | (buf[i + 3] << 8) | (buf[i + 6] << 16) | (buf[i + 7] << 24);
          i = i + 7;
        } else {
          data =
            (buf[i + 4] & 0xff) |
            ((buf[i + 5] & 0xff) << 8) |
            ((buf[i + 2] & 0xff) << 16) |
            ((buf[i + 3] & 0xff) << 24);
          i = i + 5;
        }
        data = data >>> 0;
        break;
      case 's16':
        data = ((buf[i + 3] & 0xff) << 8) | (buf[i + 2] & 0xff);
        i = i + 3;
        if (data >= 32768) data = data - 65536;
        break;
      case 's8':
        data = ((buf[i + 3] & 0xff) << 8) | (buf[i + 2] & 0xff);
        i = i + 3;
        if (data > 128 && data < 32768) data = data - 256;
        else if (data >= 32768) data = data - 65536;
        break;
      case 'u16':
      case 'u8':
        data = ((buf[i + 3] & 0xff) << 8) | (buf[i + 2] & 0xff);
        i = i + 3;
        break;
      default:
        // ABWEICHUNG: Das Original würde hier den Wert des vorigen Registers
        // wiederverwenden. Unbekannte Größe -> Register überspringen.
        i = i + 3;
        continue;
    }

    data = data / item.factor;

    let valueMap;
    if (item.map !== undefined) {
      for (let y = 0; y < item.map.length; y = y + 1) {
        if (Number(Object.keys(item.map[y])) == data) valueMap = Object.values(item.map[y])[0]; // eslint-disable-line eqeqeq
      }
    }

    const min = Number(item.min);
    const max = Number(item.max);
    let corrupt = false;
    if (min !== 0 || max !== 0) {
      if (data > max / item.factor || data < min / item.factor) corrupt = true;
    }
    if (!corrupt) {
      item.data = valueMap !== undefined ? valueMap : data;
      item.raw_data = data;
      item.timestamp = now;
      updates.push({ item, data: item.data, raw: data });
    } else {
      updates.push({ item, corrupt: true, raw: data });
    }
  }
  return { found, updates };
}

/**
 * Bereitet einen Schreibwert vor.
 * Rückgabe: { ok: true, value } mit ganzzahligem Rohwert (Wert * Faktor)
 *        oder { ok: false, error }.
 *
 * ABWEICHUNG zum Original:
 *  - Wert wird gerundet statt abgeschnitten (1.15 * 100 ergibt sonst 114).
 *  - Ungültige Werte (NaN, außerhalb min/max) werden mit Fehlermeldung
 *    abgelehnt (das Original schrieb bei NaN stillschweigend 0 bzw. meldete
 *    nach 10 s nur "Timeout").
 */
function prepareWrite(item, userValue) {
  if (!item) return { ok: false, error: 'Register nicht in der Datenbank' };
  if (item.mode !== 'R/W') return { ok: false, error: `Register ${item.register} ist nicht beschreibbar` };
  const num = typeof userValue === 'string' ? Number(userValue.replace(',', '.')) : Number(userValue);
  if (!Number.isFinite(num)) return { ok: false, error: `Wert "${userValue}" ist keine Zahl` };
  const raw = Math.round(num * item.factor);
  const min = Number(item.min);
  const max = Number(item.max);
  if (min !== 0 || max !== 0) {
    if (raw > max || raw < min) {
      return {
        ok: false,
        error: `Wert ${num} liegt außerhalb des erlaubten Bereichs (${min / item.factor} … ${max / item.factor}) für Register ${item.register}`,
      };
    }
  }
  return { ok: true, value: raw };
}

module.exports = { loadModel, buildLookup, parseAnnouncement, decodeFrame, prepareWrite };
