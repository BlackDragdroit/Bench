<div align="center">

<img src="public/icons/icon-192.png" width="72" alt="">

# Bench

**A workbench for electronics side projects.**
Plan the build, keep track of your parts, sketch the circuit, test it, and let it roll you the next idea.

Self-hosted · single user · works on desktop and as a phone app

<br>

<img src="docs/screenshots/hero.png" alt="Bench on desktop and phone: a project with its steps, and the Drop idea roller" width="100%">

</div>

<br>

## What it does

| | |
|---|---|
| **Projects** | Steps you can tick off, a parts list that knows what's in stock, files (datasheets, photos, firmware, STL), notes, and a status from *idea* to *done*. |
| **Parts library** | Every part you own, with pins, specs, stock and where it lives. Type the number printed on a part (or snap a photo, or just describe it) and Claude fills in the rest. |
| **Circuit sketches** | A schematic editor made for the phone: symbols, wires, freehand notes, parts straight from your library with their real pins. Export as PNG or SVG. |
| **Test mode** | A live DC simulation right in the browser. Flip switches, hold buttons, turn pots; LEDs glow, motors spin and moving dashes show where current flows. Warnings for burnt LEDs, shorts and the like, plus a full review of the circuit by Claude. |
| **Drop** | Pick a scope, hit roll, get a project you can actually finish, built from the parts you have. Your likes and dislikes steer future rolls. |
| **Installable** | A PWA: add it to your home screen and it opens like an app. Light and dark theme follow your system. |

## A closer look

### Test your circuit before you solder it

<img src="docs/screenshots/sketch-test.png" alt="Sketch editor in test mode: a button switches a BC547 that lights a green LED, the panel shows voltage and current" width="100%">

Open a sketch and press **Test** (or <kbd>Shift</kbd>+<kbd>T</kbd>). The simulation runs in the browser and handles batteries, supplies, resistors, pots, diodes, LEDs, switches, buttons, motors, inductors, NPN/PNP transistors, N-MOSFETs and ideal op-amps.

It flags LEDs without a series resistor (and suggests one), short circuits, resistors running hot, reversed electrolytics, floating MOSFET gates and pins left open. Tap any part for its voltage, current and power.

ICs and modules aren't simulated. For those, **Check with Claude** sends the whole netlist, including the part numbers from your library, and comes back with a verdict and concrete fixes. The result stays with the sketch until the circuit changes.

### Drop: roll your next project

<img src="docs/screenshots/drop.png" alt="Drop: a front panel with an LCD, scope keys and a red ROLL button, above a work order for a project idea" width="100%">

Drop picks the field, difficulty and vibe at random and writes a work order you can take on.

- **From my parts** builds only from your library plus an editable *always on hand* list (resistors, caps, LEDs, small transistors, wires …). **Anything goes** ignores the library.
- **Take it on** turns the idea into a project. Parts you don't have yet are added to your library as *not counted* and to the project's parts list.
- Drop's suggested steps and parts stay **hidden** until you switch them on, so the project starts as yours.
- Every 👍 / 👎 (with an optional comment) shifts the odds, and every few ratings Drop rewrites a short taste profile you can edit.

### Parts library, light theme and phone

<table>
<tr>
<td width="62%"><img src="docs/screenshots/parts-library.png" alt="Parts library with stock counters"></td>
<td rowspan="2" align="center"><img src="docs/screenshots/mobile-project.png" alt="A project on the phone" width="260"></td>
</tr>
<tr>
<td><img src="docs/screenshots/light-theme.png" alt="A project in the light theme"></td>
</tr>
</table>

## How it's built

Bench started as a single-file Claude artifact. This repo is the same app running on its own server: no build step, no frontend framework.

| Path | What's in it |
|---|---|
| `public/bench.html` | The whole app: vanilla JS, one file |
| `public/runtime.js` | Recreates the artifact runtime (`window.claude.use`: `db`, `user`, `assets`, `downloads`, `sample`) on top of the REST API. Live updates by ETag polling |
| `public/sim.js` | The DC simulator: nodal analysis with Newton iteration, wire currents, findings |
| `public/sw.js`, `public/manifest.webmanifest`, `public/icons/` | PWA |
| `server/index.js` | Express: login, REST API, uploads, part lookup, Drop, circuit review, import, `/healthz` |
| `server/db.js` | PostgreSQL. Tables `projects`, `parts`, `sketches`, `drops`, `assets` (`id`, `data jsonb`, `updated_at`), created on start |
| `server/identify.js` | Calls to the Anthropic Messages API. The key never leaves the server |
| `server/importer.js`, `scripts/import.js` | Backup import |
| `test/` | Unit tests (`node --test`) |

Login is a single password from the environment and a signed, `httpOnly`, `secure` session cookie. Uploaded files are stored as-is on a volume; anything that isn't an image, video, audio or PDF is served in a sandbox.

## Run it locally

You need Node 22 and Docker (for PostgreSQL).

```bash
docker run -d --name bench-pg -e POSTGRES_USER=bench -e POSTGRES_PASSWORD=bench -e POSTGRES_DB=bench -p 54329:5432 postgres:16-alpine
cp .env.example .env   # fill in, DATABASE_URL=postgres://bench:bench@localhost:54329/bench
npm install
npm run dev            # http://localhost:3000
npm test
```

## Configuration

| Variable | Required | Default | |
|---|---|---|---|
| `DATABASE_URL` | yes | | PostgreSQL connection string |
| `APP_PASSWORD` | yes | | The login password |
| `SESSION_SECRET` | yes | | At least 32 random characters, e.g. `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | | | Enables part lookup, Drop and Check with Claude. Everything else works without it |
| `ANTHROPIC_MODEL` | | `claude-haiku-4-5-20251001` | Part lookup |
| `DROP_MODEL` | | `claude-sonnet-4-6` | Drop |
| `REVIEW_MODEL` | | `claude-opus-5-5` | Check with Claude (with server-side fallback if a request is declined) |
| `UPLOAD_DIR` | | `./data/uploads` | Where uploaded files go (`/data/uploads` in the container) |
| `MAX_UPLOAD_MB` | | `50` | Upload limit per file |
| `PORT` | | `3000` | |

See `.env.example`.

## Backups

**Export backup** in the app saves projects, parts, sketches and Drop's ratings as `bench-backup-YYYY-MM-DD.json`. To restore, use **Import backup** in the app, or on the server:

```bash
npm run import -- bench-backup-2026-10-03.json
```

Entries with the same ID are replaced. Uploaded files aren't part of the backup; their entries show up as *missing* so you can upload them again.

## Deploying

Bench runs on [Coolify](https://coolify.io) with the **Dockerfile** build pack (multi-stage, `node:22-alpine`):

- PostgreSQL as its own resource, `DATABASE_URL` pointing at its internal URL
- a persistent volume on `/data/uploads`
- health check `GET /healthz`
- auto-deploy on push to `main`

Any other Docker host works the same way.
