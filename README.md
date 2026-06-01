# 4KFrame Enhanced

An enhanced, **web-first** re-imagining of the original *4kFrame – Photo Slideshow
Server*. It displays a looping 4K slideshow of **photos and videos** with beautiful GPU
transitions, and is managed from any browser on your network. Compared to the original
Android-only app it adds **video playback**, **Google Photos** (manual import *and*
automatic album sync), and **casting** (native Google Cast, a companion PWA, and the
classic web "cast to frame").

## Why web-first?

The display must run on **Chromecast / Android TV *and* Samsung TVs**. Samsung TVs run
Tizen (not Android), so a native Android app can't cover them. The web is the one runtime
common to all three — and a Chromecast **Custom Web Receiver** *is* a web app, so the
display page doubles as the Cast receiver. One display codebase, every TV.

```
/server     Node.js + TypeScript backend ("frame brain"): API, WebSocket, media pipeline
/display    WebGL/HTML5 slideshow (runs on the TV; also the Chromecast receiver)
/admin      Admin + companion PWA (upload, cast/view/delete, settings, Google Photos)
/shared     Shared types: config schema, API contracts, filename helpers
/packaging  Tizen / Android TV / Cast wrappers
```

## Architecture

A small always-on **backend** (Raspberry Pi / mini-PC / NAS / Docker on your LAN) stores
and processes media and coordinates casting. Thin **display clients** on each TV pull from
it over a **WebSocket** (replacing the original's polling) and render the slideshow. This
preserves the original's LAN-first, no-cloud-required design while supporting heavier
video + Google Photos workloads that shouldn't run on a TV.

## Quick start (development)

```bash
npm install
npm run build:shared          # build shared types first
npm run dev:server            # backend on http://localhost:9095
npm run dev:display           # display on http://localhost:5173 (proxies to backend)
npm run dev:admin             # admin   on http://localhost:5174
```

Open the admin, drag in some photos/videos, switch to **Cast** mode and click one — it
appears on the display.

## Production (Docker, LAN device)

```bash
docker compose up --build -d   # serves admin + display + API on :9095 (and :9096 HTTPS)
```

- Display: `http://<frame-host>:9095/`
- Admin:   `http://<frame-host>:9095/admin/`

### Runtime dependencies
- **ffmpeg** (in the Docker image) — video posters & transcoding. Without it, videos are
  served as-is and posters are skipped.
- **sharp** (optional npm dependency) — image variant generation. Without it, originals
  are served as-is.

## Google Photos

Set on the server to enable import + auto-sync:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://<frame-host>:9095/api/google/callback
```

Then **Connect Google Photos** in the admin, pick albums to auto-sync, or import items
on demand.

## Casting

- **Google Cast** — deploy the display as a Custom Web Receiver (see `packaging/`), set
  `VITE_CAST_APP_ID` for the admin sender. Cast from Google Photos or the companion.
- **Companion / web** — the admin PWA's Cast mode pushes any item to the frame over the
  LAN via `POST /api/cast/:id`.

## API (original-compatible)

`/api/progress` · `/api/next` · `/api/previous` · `/api/current` · `/api/data` ·
`/api/thumbs` · `/api/cast/:id` · `/api/delete/:id` · `/api/photo/:id` ·
`/api/preview/:id` · `/photos/:filename`
New: `/api/upload`, `/api/video/:id`, `/api/google/*`, `/api/qr`, `/api/logs`, WS `/ws`.

Media keeps the original `‹identity›.‹width›.‹height›.jpg` filename convention.

## Status

Foundation milestones (M0–M3) plus the integration scaffolding for casting (M4) and
Google Photos (M5) are in place. See the build plan for the full roadmap. The API is for
personal/non-commercial use, mirroring the original.

## License

MIT
