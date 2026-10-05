# Bench

Projektplaner für Elektronik-Bastelprojekte: Schritte, Teileliste mit Teilebibliothek,
Dateien und Schaltungsskizzen. Selbst gehostete Version der ursprünglichen Claude-Artifact-App.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `public/bench.html` | Die App (Vanilla JS, eine Datei) |
| `public/sim.js` | Gleichstrom-Simulation für den Test-Modus der Skizzen |
| `public/runtime.js` | Ersatz für `window.claude.use(…)`: `db`, `user`, `assets`, `downloads`, `sample` über das eigene Backend |
| `public/sw.js`, `public/manifest.webmanifest`, `public/icons/` | PWA (Homescreen-Installation) |
| `server/index.js` | Express-Server: Login, REST-API, Uploads, Teilesuche, Import, `/healthz` |
| `server/db.js` | PostgreSQL: Tabellen `projects`, `parts`, `sketches`, `drops`, `assets` (werden beim Start angelegt) |
| `server/identify.js` | Teilesuche und Drop über die Anthropic Messages API |
| `server/importer.js`, `scripts/import.js` | Import einer Backup-Datei |

## Drop

Die Ansicht **Drop** (Seitenleiste bzw. untere Leiste am Handy) ist Random Drop, eingebaut in Bench:
Umfang wählen, Feld, Schwierigkeit und Absicht werden gewürfelt, Bewertungen (Like / Not for me,
mit Kommentar) lenken spätere Würfe und schreiben alle 5 Bewertungen ein Geschmacksprofil.

- **From my parts:** baut aus der Teilebibliothek (Teile mit Bestand 0 zählen nicht) plus der Liste „Always on hand“
  (Widerstände, Kondensatoren, LEDs, Kleinsignal-Dioden und -Transistoren, Taster, Kabel …), die in den Drop-Einstellungen änderbar ist.
- **Anything goes:** ignoriert die Bibliothek.
- **Take it on** legt ein Bench-Projekt an: Schritte, Stückliste aus der Bibliothek, Notizen (Warum, Stolperstein, Erweiterungen).
  Auf der Projektseite lässt sich die Idee später noch bewerten.

Bewertungen und Profil liegen in der Tabelle `drops` (ein Eintrag `state`) und sind im Backup enthalten.
Modell über `DROP_MODEL`, Standard `claude-sonnet-4-6`.

## Skizzen testen

Im Skizzen-Editor startet **Test** (oder Shift+T) die Simulation:

- **Live-Simulation** im Browser (`public/sim.js`, Knotenanalyse mit Newton-Iteration): Batterie, Versorgung,
  Widerstand, Poti, Diode, LED, Schalter, Taster, Motor, Spule, NPN/PNP, N-MOSFET, Op-Amp (ideal).
  Schalter antippen, Taster halten, Poti-Regler im Panel. LEDs leuchten, Motoren drehen, wandernde Striche
  zeigen den Strom. Warnungen bei Überstrom an LEDs, Kurzschluss, zu viel Leistung an Widerständen,
  verpolten Elkos, offenem MOSFET-Gate und offenen Pins. ICs/Module und Kondensatoren werden nicht simuliert.
- **Check with Claude** schickt die Netzliste (inkl. ICs mit Teilenummer aus der Bibliothek) an `/api/review`.
  Das Ergebnis wird an der Skizze gespeichert und als veraltet markiert, sobald sich die Schaltung ändert.
  Modell über `REVIEW_MODEL`, Standard `claude-opus-5-5`, mit serverseitigem Fallback bei Ablehnung.

## Lokal starten

Voraussetzungen: Node 22, Docker (für PostgreSQL).

```bash
docker run -d --name bench-pg -e POSTGRES_USER=bench -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=bench -p 54329:5432 postgres:16-alpine
cp .env.example .env   # Werte eintragen, DATABASE_URL=postgres://bench:bench@localhost:54329/bench
npm install
npm run dev            # http://localhost:3000
npm test
```

## Umgebungsvariablen

Siehe `.env.example`. Pflicht: `DATABASE_URL`, `APP_PASSWORD`, `SESSION_SECRET` (min. 32 Zeichen).
Ohne `ANTHROPIC_API_KEY` läuft alles außer der Teilesuche.

## Backup übernehmen

In der App: **Import backup** (Seitenleiste bzw. unter der Projektliste) und die
`bench-backup-YYYY-MM-DD.json` wählen. Oder auf dem Server/Container:

```bash
npm run import -- bench-backup-2026-10-03.json
```

Einträge mit gleicher ID werden überschrieben. Backups enthalten keine hochgeladenen Dateien;
solche Einträge erscheinen in der App als „Missing“ und können gelöscht und neu hochgeladen werden.

## Deployment

Coolify mit Dockerfile-Build-Pack, PostgreSQL als eigene Ressource, persistentes Volume auf
`/data/uploads`, Healthcheck `GET /healthz`, Auto-Deploy bei Push auf `main`.
