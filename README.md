# node-red-contrib-nibepi-lite

Minimale Node-RED-Nodes für NIBE-Wärmepumpen der F-Serie (entwickelt und geprüft anhand eines
Mitschnitts einer **F1255-6**) über **RS485**. Es gibt genau drei Nodes:

| Node | Aufgabe |
|---|---|
| `nibe-config` | Verbindung (serieller Port) und Registerliste des Modells |
| `nibe-input`  | Registerwerte lesen (LOG.SET der Pumpe und aktives Lesen) |
| `nibe-output` | Wert in ein Register schreiben |

Es ist ein schlanker Nachbau der Kernfunktion von **node-red-contrib-nibepi 1.2.1**. Dashboard,
Warmwasser-KI, Wetter, Strompreis, MQTT, Cloud-Anbindung und andere Modelle gibt es hier nicht.
Dadurch hängt das Paket nur an `serialport` (aktuell 13.x), und `npm audit` meldet **0 Schwachstellen**.

Die Dekodierung der Telegramme (Faktoren, Wertzuordnungen, Plausibilitätsgrenzen, 32-Bit-Werte) ist Schritt
für Schritt aus NibePi 1.2.1 übernommen. Ein Mitschnitt der F1255-6 mit 863 Telegrammen und 2066 Werten
liefert damit dieselben Ergebnisse wie das Original, einschließlich der Startsequenz und des Schreibtelegramms
für Register 47044.

## Voraussetzungen

* Node.js ≥ 20, Node-RED ≥ 3 (Node-RED nur mit 5.0.8 getestet; der Kern läuft in den Tests unter Node.js 20, 22, 24, 25 und 26)
* RS485-Anschluss an der Pumpe (Zubehöranschluss, Adresse 0x20, 9600 Baud, 8N1)
  * Raspberry Pi mit RS485-Aufsatz am UART: `/dev/ttyAMA0`
  * oder USB-RS485-Adapter: am besten über den festen Pfad `/dev/serial/by-id/usb-…`
* Der Benutzer, unter dem Node-RED läuft, muss auf den Port zugreifen dürfen (Gruppe `dialout`).

## Installation

Altes Paket zuerst entfernen (beide dürfen nicht gleichzeitig geladen sein, die Node-Typen heißen gleich):

```bash
cd ~/.node-red
npm uninstall node-red-contrib-nibepi        # bzw. das Fork-Paket
npm install github:Becker884/node-red-contrib-nibepi-lite
node-red-restart                              # oder: Node-RED neu starten
```

Eine bestimmte Version (sobald es auf GitHub einen Release mit diesem Tag gibt):
`npm install github:Becker884/node-red-contrib-nibepi-lite#v0.1.3`. Alternativ aus einer Paketdatei:
`npm install /pfad/zu/node-red-contrib-nibepi-lite-0.1.3.tgz`.

Danach Port, Modell und „Nur lesen“ im `nibe-config`-Node prüfen. Bestehende Flows mit den Node-Typen
`nibe-config`, `nibe-input` und `nibe-output` laden unverändert. Die Felder `serial_port`, `readonly`,
`name` und `add` bedeuten dasselbe wie bisher. Überzählige Felder aus alten Flows (MQTT, `connection`, …)
werden ignoriert.

Hinweis: In der Flow-Datei steht unter `global-config` noch eine Modulliste mit `node-red-contrib-nibepi`.
Die Node-Typen werden vom neuen Paket bereitgestellt, daher sollte das keine Rolle spielen. Falls Node-RED
trotzdem ein fehlendes Modul meldet, den alten Eintrag in der Modulliste (Flow-Datei bzw. Export) entfernen.
Das habe ich mit einem echten Node-RED nicht nachstellen können.

## Einstellungen (`nibe-config`)

| Feld | Bedeutung |
|---|---|
| Serieller Port | `/dev/ttyAMA0`, `/dev/serial0` oder `/dev/serial/by-id/…`. Die Liste füllt sich über den Aktualisieren-Knopf. |
| Modell | Datei aus `models/` (mitgeliefert: `F1255`). Die Pumpe meldet ihr Modell selbst; bei Abweichung gibt es eine Warnung. |
| Nur lesen | Es wird nichts zur Pumpe geschrieben, auch keine Startsequenz. |
| Alarm quittieren | Wie bisher: beim Start sowie bei Alarm 251 (Kommunikationsstörung) wird der Alarm zurückgesetzt. **Das quittiert auch echte Alarme.** Zum Beobachten ausschalten. |
| Mitschnitt | Schreibt Telegramme in eine Datei (höchstens 20 MB) – nur zur Fehlersuche. |

`global.register` wird weiterhin gesetzt: ein Array mit allen Registern des Modells
(`register`, `data`, `raw_data`, `titel`, `unit`, `timestamp`, …), also auch für Function-Nodes wie bisher.

## `nibe-input`

* **Name = Registernummer** (z. B. `40008`): Werte dieses Registers.
* **Name leer**: Werte aller Register.
* **Name `error`**: Fehlermeldungen des Kerns.
* **Register lesen** (`add`): Das Register wird zyklisch abgefragt. Register, die die Pumpe sowieso über
  LOG.SET sendet, werden nicht zusätzlich abgefragt.

Ausgang 1 sendet nur bei Wertänderung, Ausgang 2 bei jedem Wert. Nachricht:
`{ topic: "40008", payload: 30.5, raw: <Registerobjekt> }`.

## `nibe-output`

* Register steht im **Node-Namen** oder in `msg.topic` (wenn der Name leer ist).
* `msg.payload` ist der Wert so, wie ihn das Display zeigt (also `37` für 37,0 °C). Der Faktor wird angewendet.
* Zahlen mit Komma werden akzeptiert. Wird auf ganze Rohwerte **gerundet** (das Original schnitt ab).
* Ungültige Werte (keine Zahl, außerhalb von min/max, Register nur lesbar) werden mit einer Fehlermeldung
  **abgelehnt**, es geht nichts zur Pumpe. Im Original wurde dann `0` geschrieben oder nach 10 s nur „Timeout“ gemeldet.
* Geschrieben wird, wenn die Pumpe das Schreib-Token schickt (ca. einmal pro Sekunde). Pro Register gilt der neueste
  Wert; Aufträge, die 30 s nicht abgeholt wurden, werden verworfen.

## Unterschiede zu NibePi 1.2.1

* Kein Dashboard, kein MQTT, keine Cloud, keine KI, keine anderen Modelle, keine `config.json`.
* Telegramme werden stromorientiert zerlegt: Zwei Telegramme in einem Datenblock oder Störbytes
  kosten keine Werte mehr.
* Der Kern lebt außerhalb der Nodes und übersteht Deploys (10 s Schonfrist): Beim Deployen wird weder
  der Port neu geöffnet noch die Startsequenz wiederholt.
* Pumpenmodell und Port-Fehler werden gemeldet (Warnung im Node-RED-Log bzw. Ausgang des `error`-Inputs),
  ein verlorener Port wird automatisch neu geöffnet.

## Vorgehen beim ersten Test an der Pumpe

1. **Nur lesen** aktivieren und „Alarm quittieren“ ausschalten. Deploy. Der `nibe-input` sollte nach
   spätestens einigen Sekunden Werte liefern, der Status wechselt von „warte auf Pumpe“ auf den Wert.
2. Werte mit der Pumpenanzeige vergleichen (z. B. 40004 Außentemperatur, 40008 Vorlauf).
3. „Nur lesen“ ausschalten. Einen **harmlosen** Wert schreiben (z. B. Warmwasser-Starttemperatur 47044 von 36 auf 37 °C)
   und im Pumpenmenü kontrollieren.
4. Bei Problemen „Mitschnitt“ einschalten und die Datei mitschicken.

## Node.js 26

Unter Node.js 26 (getestet mit 26.11.1) liefert serialport 13 Empfangsdaten verspätet. Der native Poller von
serialport ruft sein JavaScript-Callback ohne Callback-Scope auf; die wartenden Promise-Fortsetzungen, über die
serialport die Daten liest, laufen erst, wenn irgendein anderes Ereignis die Event-Loop weckt. Die Pumpe sieht dann
keine Antworten, wiederholt Tokens und Telegramme, und die Werte kommen im Schub. Node 20, 22, 24 und 25 sind nicht
betroffen.

Der Kern hängt sich deshalb an den Poller und plant nach jedem Poller-Ereignis ein `setImmediate` ein. Das lässt die
Event-Loop einmal durchlaufen und leert die Warteschlange (Empfangsverzögerung unter 1 ms im Test, im Leerlauf kein
Aufwand). Das gilt auf allen Node-Versionen. Findet der Kern den Poller nicht (andere serialport-Version oder andere
Bindings), startet er ab Node 26 ersatzweise einen leeren 5-ms-Timer.

Hidden-Eigenschaft `wake_ms` am `nibe-config`-Node (nur zur Fehlersuche): `> 0` erzwingt den Timer mit diesem
Intervall in ms, `0` schaltet den Timer ganz ab.

Stand: Die Timer-Variante (0.1.2) ist auf einer Pi 3 mit Node 26.11.1 bestätigt. Die `setImmediate`-Variante
(ab 0.1.3) ist im Test mit simulierter Pumpe unter Node 20 bis 26 geprüft und auf der Pi noch zu bestätigen.

## Kommunikationstest ohne Node-RED

Node-RED stoppen, dann:

```bash
node ~/.node-red/node_modules/node-red-contrib-nibepi-lite/tools/nibe-probe.js /dev/ttyAMA0 40004 30
```

Das öffnet den Port mit demselben Kern wie das Paket (nur lesen) und zeigt jede Sekunde den Wert, die Zähler und die
Antwortzeiten. Unten steht, ob die Pumpe antwortet.

## Entwicklung

```bash
npm install
npm test        # 49 Tests: Telegramme, Register, Kern, Replay des Mitschnitts
npm audit       # 0 Schwachstellen
```

Die Modelldateien (`models/*.json`) stammen aus NibePi 1.2.1. Weitere Modelle ließen sich als Datei ergänzen,
sind aber hier **nicht geprüft**.

## Entstehung

Der Code ist gemeinsam mit **Claude** (KI-Assistent von Anthropic) entstanden und von [@Becker884](https://github.com/Becker884)
an einer NIBE F1255-6 (Raspberry Pi 3, Joy-it RB-RS485) in Betrieb genommen worden. Claude hat das Protokoll anhand des
NibePi-Quelltexts und eines Mitschnitts nachgebaut, die Tests geschrieben und den Node.js-26-Fehler eingegrenzt.
Geprüft an der echten Pumpe wurde nur von Becker884: Lesen (LOG.SET und aktive Abfrage) und Schreiben laufen.
Die Grundlage, das Protokoll-Wissen und die Registerlisten stammen aus
[node-red-contrib-nibepi](https://github.com/anerdins/node-red-contrib-nibepi) von anerdins.

## Lizenz

MIT, siehe `LICENSE`. Grundlage ist node-red-contrib-nibepi von anerdins (MIT).
