# Bench

Projektplaner für Elektronik-Bastelprojekte: Schritte, Teileliste mit Teilebibliothek,
Dateien und Schaltungsskizzen. Selbst gehostete Version der ursprünglichen Claude-Artifact-App.

## Aufbau

| Pfad | Inhalt |
|---|---|
| `public/bench.html` | Die App (Vanilla JS, eine Datei) |
| `public/runtime.js` | Ersatz für `window.claude.use(…)`: `db`, `user`, `assets`, `downloads`, `sample` über das eigene Backend |
| `public/sw.js`, `public/manifest.webmanifest`, `public/icons/` | PWA (Homescreen-Installation) |
| `server/index.js` | Express-Server: Login, REST-API, Uploads, Teilesuche, Import, `/healthz` |
| `server/db.js` | PostgreSQL: Tabellen `projects`, `parts`, `sketches`, `assets` (werden beim Start angelegt) |
| `server/identify.js` | Teilesuche über die Anthropic Messages API |
| `server/importer.js`, `scripts/import.js` | Import einer Backup-Datei |

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
