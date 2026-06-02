# Deploying 4KFrame Enhanced

This guide takes you from zero to a permanent, always-on frame on your own network.
Running on a LAN host (instead of a Codespace/dev tunnel) removes the upload-size cap and
simplifies Google Photos OAuth and casting.

> **TL;DR**
> ```bash
> git clone https://github.com/k6subramaniam/4KFrame-Enhanced.git
> cd 4KFrame-Enhanced
> cp .env.example .env            # optional: add Google creds / TLS knobs
> docker compose up -d --build
> ```
> Then open `http://<host-ip>:9095/` on a TV and `http://<host-ip>:9095/admin/` on your phone.

## 1. Pick a host

Any always-on Linux machine on your LAN with **Docker + Docker Compose**:

- **Raspberry Pi 4/5** (8 GB recommended for 4K video transcoding) — can also be the display.
- A **mini-PC / NUC**, an old laptop, or a **NAS** that runs Docker.

Install Docker if needed:
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # log out/in afterwards
```

## 2. Get the code and run it

```bash
git clone https://github.com/k6subramaniam/4KFrame-Enhanced.git
cd 4KFrame-Enhanced
cp .env.example .env              # see step 4 for Google Photos
docker compose up -d --build      # builds the image (ffmpeg + openssl + sharp bundled)
```

Check it's healthy:
```bash
curl -s http://localhost:9095/api/health     # {"ok":true,"imageProcessing":true,"videoProcessing":true}
docker compose logs -f                        # watch startup + transcode logs
```

Find the host's LAN IP (for the URLs below):
```bash
hostname -I | awk '{print $1}'
```

## 3. Open it

- **Display (point your TVs here):** `http://<host-ip>:9095/`
- **Admin (phone/laptop):** `http://<host-ip>:9095/admin/`
- HTTPS (self-signed) is also on `https://<host-ip>:9096/` — browsers show a one-time warning.

Uploads here go **straight to the server (up to 1 GB)** — no proxy size limit.

## 4. Google Photos (optional)

Import uses Google's **Photo Picker API** and needs an **OAuth client** (not an API key — and
the *Photos* Picker API, not the *Google* Picker API). See the README "Google Photos" section
for the console steps, then in `.env`:

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:9095/api/google/callback
```

**Tip — connect without a domain or HTTPS:** Google allows `http://localhost` redirect URIs.
Register `http://localhost:9095/api/google/callback`, then run the **Connect** flow in a
browser **on the host itself** (or over an SSH tunnel: `ssh -L 9095:localhost:9095 user@host`,
then open `http://localhost:9095/admin/`). Tokens are stored server-side, so **Import** then
works from any device on your LAN. `docker compose restart` after editing `.env`.

## 5. Show it on a TV

**Option A — any smart TV with a browser (simplest).** Open `http://<host-ip>:9095/` in the
TV's built-in browser (Samsung Tizen, LG webOS, Android TV all have one). Done. The TV remote
controls it (arrows = prev/next, OK = pause, `+`/`-` zoom — see the README).

**Option B — a Raspberry Pi as a dedicated display (kiosk).** If the Pi is wired to the TV,
have it boot straight into the fullscreen display:

```bash
sudo cp packaging/kiosk/4kframe-kiosk.sh /usr/local/bin/4kframe-kiosk.sh
sudo chmod +x /usr/local/bin/4kframe-kiosk.sh
sudo cp packaging/kiosk/4kframe-kiosk.service /etc/systemd/system/
# point it at your server (omit if the Pi is also the server -> localhost):
sudo systemctl edit 4kframe-kiosk    # add: [Service]\nEnvironment=FRAME_URL=http://<host-ip>:9095/
sudo systemctl enable --now 4kframe-kiosk
```

Requires a desktop session with autologin (Raspberry Pi OS: `sudo raspi-config` →
*System Options → Boot/Auto Login → Desktop Autologin*) and Chromium + unclutter:
`sudo apt install -y chromium-browser unclutter`.

## 6. Day-2 operations

```bash
# Update to the latest code
git pull && docker compose up -d --build

# Logs (filter to problems only)
docker compose logs --since 15m | grep -iE '"level":(40|50)|"statusCode":[45][0-9][0-9]|error|warn'

# Back up the library + settings (media, DB, certs live in the named volume)
docker run --rm -v 4kframe-enhanced_frame-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/frame-backup.tgz -C /data .

# Stop / restart
docker compose restart
docker compose down            # add -v to also delete the data volume (wipes media!)
```

## 7. Casting notes

- **Web / LAN cast** and the **TV remote** work out of the box.
- **Native phone→Chromecast** additionally needs the display served from a **publicly
  reachable HTTPS URL** with a trusted cert plus a registered Cast Application ID
  (`VITE_CAST_APP_ID`) — see `packaging/`. Self-signed/LAN-only won't be trusted by Chromecast.

## 8. Cloud hosting (Railway / Fly.io)

For remote access (not just your LAN), host the **same Docker image** on a platform that runs
a persistent container with a volume. **Vercel does not work** (serverless — no persistent disk,
no long-lived WebSocket server, no ffmpeg).

> 🔒 **Set `FRAME_ADMIN_PASSWORD` first** — a public URL is open to anyone otherwise.
> With the password set, displays can still connect to `/ws` and receive live events without
> a login, but unauthenticated WebSocket clients cannot send slideshow/config/cast controls.
> These platforms terminate TLS at their edge and forward HTTP to the container, so set
> `FRAME_DISABLE_HTTPS=1` (the public URL is still `https://`, and `wss://` works).

**Fly.io** — a [`fly.toml`](fly.toml) is included:
```bash
fly launch --no-deploy --copy-config --name <unique-name>
fly volume create frame_data --size 10 --region iad
fly secrets set FRAME_ADMIN_PASSWORD=your-strong-password
fly deploy
```

The `frame_data` volume backs `/data`, so create it in the same region as the Fly machine (`primary_region`, `iad` by default).

**Railway** — a [`railway.json`](railway.json) pins the Dockerfile build. In the dashboard:
deploy from this repo → add a **Volume mounted at `/data`** → set the service's **target port to
`9095`** → add variables `FRAME_DISABLE_HTTPS=1` and `FRAME_ADMIN_PASSWORD=…` (plus
`GOOGLE_REDIRECT_URI=https://<your>.up.railway.app/api/google/callback` if using Google Photos).

**Cost/caveats:** keep one machine always running (a frame must stay up); media lives on the
paid volume; streaming 4K to the TV uses egress. For a home frame, LAN/Pi is cheaper and lower
latency — cloud mainly buys you remote access.
