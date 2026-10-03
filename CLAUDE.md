# Bench – selbst gehostete Version

Bench ist ein Projektplaner für Elektronik-Bastelprojekte (Schritte, Teileliste mit
Teilebibliothek, Dateien, Schaltungsskizzen). Die erste Version läuft als Claude-Artifact
und liegt hier als `bench.html` (eine einzige Datei, Vanilla JS, keine Abhängigkeiten außer
Google Fonts). Ziel: dieselbe App unabhängig von Claude auf meinem Coolify betreiben.

## Ziel

- Oberfläche und Funktionen von `bench.html` bleiben gleich (Design, Texte, Editor).
- Läuft auf meinem Server via Coolify, erreichbar über eigene Domain, am PC und am Handy.
- Installierbar auf dem Handy-Homescreen (PWA: Manifest + einfacher Service Worker, Icon).
- Nur ich nutze die App: einfacher Login mit Passwort aus einer Umgebungsvariable,
  Session-Cookie (httpOnly, secure). Keine Registrierung.

## Was ersetzt werden muss

`bench.html` nutzt die Laufzeit von Claude-Artifacts über `claude.use(name)`. Diese
Aufrufe gibt es außerhalb von Claude nicht. Die genutzte Oberfläche ist klein:

| Claude-Laufzeit | Wird verwendet als | Ersatz |
|---|---|---|
| `db` | `collection(path)`, `.doc(id)`, `.set/.update/.delete/.get`, `.where(f,'==',v)`, `.onSnapshot(next, err)` | REST-API + PostgreSQL |
| `user` | nur `id()` für den Pfad `data/users/<id>/…` | fester Wert nach Login |
| `assets` | `upload(blob,{type})` → `{id,url}`, `list()` → `{usage}`, `delete(id)`; Anzeige über `/_blob/<id>` | Upload-Endpoint, Dateien auf persistentem Volume |
| `sample` | `sample.json(prompt, {signal, images})` für die Teilesuche | Backend-Endpoint, ruft die Anthropic Messages API auf |
| `downloads` | `save({filename, data})` | normaler Download per Blob-URL im Browser |

**Empfohlener Weg:** eine kleine Client-Datei `runtime.js` schreiben, die `window.claude.use`
mit derselben Schnittstelle nachbaut und intern das eigene Backend aufruft. Dann bleibt der
restliche Code in `bench.html` fast unverändert. `onSnapshot` darf per Polling (z. B. alle
10–15 s und sofort nach eigenen Schreibzugriffen) oder per Server-Sent Events umgesetzt werden.

Weitere Anpassungen:

- Die Notlösung für Binärdateien (Base64 in `text/plain`, Feld `enc: "b64"`) wird nicht mehr
  gebraucht: alle Dateitypen direkt speichern. Bestehende Datensätze mit `enc` weiter lesen können.
- Upload-Limit über Umgebungsvariable, Standard 50 MB.
- Den Hinweis „Open this in Claude“ (`S.err = 'noclaude'`) durch den Login ersetzen.

## Datenmodell (aus der aktuellen App)

Pfade in der App: `data/users/<uid>/projects/items/<id>`, `…/library/parts/<id>`,
`…/sketches/items/<id>`. Vorschlag: drei Tabellen `projects`, `parts`, `sketches` mit
`id text primary key`, `data jsonb`, `updated_at timestamptz`. Felder in `data`:

- **Projekt:** `name, status (idea|planning|building|testing|done|paused), description, notes,
  steps[{id,text,done,note}], bom[{id,partId,qty,note}], files[{id,assetId,name,type,size,enc,added}],
  created, updated`
- **Teil:** `name, mpn, manufacturer, category, package, value, description, pins[], specs[{k,v}],
  stock (Zahl oder null = nicht gezählt), location, datasheet, notes, created, updated`
- **Skizze:** `projectId, name, comps[], wires[], strokes[], created, updated`

## Teilesuche

- Endpoint `POST /api/identify` nimmt Prompt und optional Bilder entgegen und ruft die
  Anthropic Messages API auf. Der Prompt steht in `lookupPrompt()` in `bench.html`.
- API-Key nur serverseitig in `ANTHROPIC_API_KEY`, nie an den Browser geben.
- Modell über `ANTHROPIC_MODEL` einstellbar, Standard `claude-haiku-4-5-20251001`.
- Antwort als JSON parsen (Codeblock oder umgebenden Text tolerieren) und so zurückgeben,
  wie `sample.json` es tat.

## Daten übernehmen

Die alte App hat „Export backup“ und erzeugt `bench-backup-YYYY-MM-DD.json` mit
`{app, version, exported, projects[], parts[], sketches[]}`, jeweils mit `id`.

- Import-Funktion bauen (Button in der App oder `npm run import -- datei.json`), die
  diese Datei einliest und vorhandene IDs überschreibt.
- Hochgeladene Dateien sind im Backup **nicht** enthalten. Ihre Einträge in `files[]` beim
  Import entfernen oder als „fehlt“ markieren, damit keine kaputten Links entstehen.

## Deployment (Coolify)

- Node.js + Express, PostgreSQL als eigene Ressource in Coolify.
- **Dockerfile-Build-Pack verwenden, nicht Nixpacks.** Multi-Stage-Dockerfile.
- Persistentes Volume für Uploads (z. B. `/data/uploads`).
- Umgebungsvariablen: `DATABASE_URL`, `APP_PASSWORD`, `SESSION_SECRET`, `ANTHROPIC_API_KEY`,
  `ANTHROPIC_MODEL`, `UPLOAD_DIR`, `MAX_UPLOAD_MB`. Eine `.env.example` anlegen, keine
  echten Werte committen, `.env` in `.gitignore`.
- Tabellen beim Start anlegen, falls sie fehlen.
- Healthcheck-Route `GET /healthz`.
- Repo auf GitHub, Coolify mit Auto-Deploy bei Push auf `main`.
- CDN-Abhängigkeiten immer mit fester Version einbinden (keine `@latest`-URLs).

## Reihenfolge

1. Repo-Grundgerüst, Express-Server, Login, Tabellen.
2. `runtime.js` mit db-Ersatz, `bench.html` darauf umstellen, lokal testen.
3. Datei-Uploads, Downloads.
4. Teilesuche über das Backend.
5. Import der Backup-Datei.
6. PWA, Dockerfile, Deployment auf Coolify.

Nach jedem Schritt kurz testen, bevor es weitergeht.
