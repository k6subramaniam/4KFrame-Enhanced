# 4KFrame Enhanced

An enhanced, **web-first** re-imagining of the original *4kFrame – Photo Slideshow
Server*. It displays a looping 4K slideshow of **photos and videos** with beautiful GPU
transitions, and is managed from any browser on your network. Compared to the original
Android-only app it adds **video playback**, **Google Photos** (on-demand import via
Google's Photo Picker), and **casting** (native Google Cast, a companion PWA, and the
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

- Display: `http://<frame-host>:9095/` (or `https://<frame-host>:9096/`)
- Admin:   `http://<frame-host>:9095/admin/`

### HTTPS
HTTPS is served on **:9096**. On first boot the server **self-signs** a certificate (via
`openssl`) into the data volume, with `localhost` and the LAN IP in its SAN — browsers will
show a one-time "not trusted" warning. To use your own (trusted) certificate, set
`FRAME_TLS_CERT` / `FRAME_TLS_KEY` to its paths, or disable HTTPS with `FRAME_DISABLE_HTTPS=1`.
HTTPS is required for PWA install and to serve the display as a publicly reachable Cast
receiver.

### Runtime dependencies
- **ffmpeg** (in the Docker image) — video posters & transcoding. Without it, videos are
  served as-is and posters are skipped.
- **openssl** (in the Docker image) — self-signs the HTTPS cert on first boot. Without it,
  HTTPS is skipped and HTTP still serves.
- **sharp** (optional npm dependency) — image variant generation. Without it, originals
  are served as-is.

## Google Photos

Import is built on Google's **[Photo Picker API](https://developers.google.com/photos/picker)**.
Google retired broad Library API access in March 2025, so apps can no longer list a user's
albums or auto-sync them — instead the user explicitly **picks** the photos/videos to import,
and the frame downloads just those. (There is no automatic album sync — that capability was
removed by Google.)

### 1. Create OAuth credentials (not an API key)
The Photos Picker API authorizes per user via **OAuth 2.0** — an **API key will not work**, and
note this is the *Photos* Picker API, not the similarly-named *Google Picker API* (a Drive widget).

In [Google Cloud Console](https://console.cloud.google.com/):
1. **APIs & Services → Library →** enable **"Photos Picker API"**.
2. **OAuth consent screen →** add the scope `…/auth/photospicker.mediaitems.readonly`, and add
   your Google account under **Test users** (while the app is in *Testing*).
3. **Credentials → Create credentials → OAuth client ID → Web application.** Add an
   **Authorized redirect URI** matching your deployment (see below). Copy the **Client ID** and
   **Client secret**.

### 2. Configure the frame
Copy `.env.example` to `.env` (gitignored) and fill in:

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=<frame-url>/api/google/callback
```

Pick the `<frame-url>` that matches where you run it — and register that **exact** value as the
OAuth redirect URI:

| Deployment | `GOOGLE_REDIRECT_URI` |
|---|---|
| Docker on a LAN host | `http://<frame-host>:9095/api/google/callback` |
| GitHub Codespace | `https://<codespace>-9095.app.github.dev/api/google/callback` |
| Local dev | `http://localhost:9095/api/google/callback` |

> **Codespace note:** set the forwarded **port 9095 to Public** during the OAuth flow, so
> Google's redirect back to the callback isn't intercepted by GitHub's auth page.

Then `docker compose up -d`. In the admin: **Connect Google Photos → Import from Google Photos**,
pick items in Google's UI, and they're imported onto the frame.

## Casting

- **Google Cast** — deploy the display as a Custom Web Receiver (see `packaging/`), set
  `VITE_CAST_APP_ID` for the admin sender. Cast from Google Photos or the companion.
- **Companion / web** — the admin PWA's Cast mode pushes any item to the frame over the
  LAN via `POST /api/cast/:id`.

### Aspect ratios & framing
Every display composes each frame to **its own real screen**, so the same library casts
correctly to 16:9 TVs, ultrawide, 4:3, square, and portrait frames — and multiple displays
of different shapes can run at once, each framed correctly. In **Admin → Scaling** choose how
content fits — **Cover** (crop to fill), **Contain** (letterbox), or **Blur Fill** (a blurred,
zoomed copy fills the bars) — and an **Aspect Ratio**: **Auto** (match each screen) or a forced
shape (16:9, 9:16, 4:3, 3:4, 1:1, 21:9) centered within the screen.

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
