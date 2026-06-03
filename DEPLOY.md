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

You can skip this entire section unless you want to import selected photos/videos from Google
Photos. Import uses Google's **Photo Picker API** and needs an OAuth **Web application** client
(not an API key — and not the similarly named Google Picker / Drive widget).

**Google Cloud setup:**

1. In Google Cloud Console, select this project (or create one) and enable **Photos Picker API**.
2. In **Google Auth Platform → Audience / OAuth consent screen**, configure the app, add your
   Google account as a **Test user** while the app is in Testing, and request the scope
   `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`.
3. In **Google Auth Platform → Clients → Create client**, choose **Web application**.
4. Add the exact **Authorized redirect URI** for where this frame is hosted:

   | Deployment | Authorized redirect URI / `GOOGLE_REDIRECT_URI` |
   |---|---|
   | Railway | `https://4kframe-enhanced-production.up.railway.app/api/google/callback` |
   | Docker on a LAN host | `http://<frame-host>:9095/api/google/callback` |
   | Local dev | `http://localhost:9095/api/google/callback` |

5. Copy the generated **Client ID** and **Client secret** into your deployment variables:

   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=https://4kframe-enhanced-production.up.railway.app/api/google/callback
   ```

For Railway, set those three values under the service's **Variables** tab, redeploy, then open
`/admin/` and use **Connect Google Photos → Import from Google Photos**. Tokens are stored
server-side on the frame, so after the first connect the import flow works from your phone.

**Tip — connect without a domain or HTTPS for LAN testing:** Google allows `http://localhost`
redirect URIs. Register `http://localhost:9095/api/google/callback`, then run the **Connect** flow
in a browser **on the host itself** (or over an SSH tunnel: `ssh -L 9095:localhost:9095 user@host`,
then open `http://localhost:9095/admin/`). `docker compose restart` after editing `.env`.


## Smart Face Match privacy (optional)

Smart Face Match is **off by default**. To opt in, set the server-side flag and restart:

```bash
FRAME_ENABLE_FACE_MATCH=1
```

When enabled, detection runs in the server's local media pipeline. Photos are analyzed after
server-side image normalization, and videos are analyzed only from the generated poster frame
rather than by scanning the whole video file. The app persists only app-owned metadata on each
media item (face bounding boxes, optional local embeddings, and optional labels assigned in the
admin UI).

Do **not** configure a detector that sends face images, embeddings, or other biometric data to
third-party APIs unless you have explicitly decided to do so and have handled the privacy,
consent, and compliance obligations for your deployment. The built-in default detector is a
privacy-preserving no-op until a local detector is registered.

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
> With the password set, browsers/TVs must log in before they can load `/api/current`,
> `/api/qr`, or raw media under `/photos/`. Displays can still connect to `/ws` and receive
> live events without a login, but unauthenticated WebSocket clients cannot send admin-only
> slideshow/config/cast controls. These platforms terminate TLS at their edge and forward
> HTTP to the container, so set `FRAME_DISABLE_HTTPS=1` (the public URL is still `https://`,
> and `wss://` works).

**Fly.io** — a [`fly.toml`](fly.toml) is included:
```bash
fly launch --no-deploy --copy-config --name <unique-name>
fly volume create frame_data --size 10 --region iad
fly secrets set FRAME_ADMIN_PASSWORD=your-strong-password
fly deploy
```

The `frame_data` volume backs `/data`, so create it in the same region as the Fly machine (`primary_region`, `iad` by default).

**Railway** — a [`railway.json`](railway.json) pins the Dockerfile build. Use **one** Railway
service for this repo (for example `4KFrame-Enhanced` / `FrameCast`). Do **not** deploy separate
`admin`, `display`, or `server` services: the root Docker image builds those workspaces and the
server serves both web UIs. In the dashboard, configure the remaining service like this:

- **Builder:** Dockerfile
- **Dockerfile Path:** `/Dockerfile`
- **Custom Start Command:** leave unset (the Dockerfile `CMD` starts the server)
- **Public Networking target port:** `9095`
- **Healthcheck path:** `/api/health` (path only, not the full `https://...` URL)
- **Volume:** mounted at `/data`
- **Variables:** add only the values you need:

  | Variable | Railway value | Required? | Notes |
  | --- | --- | --- | --- |
  | `FRAME_DISABLE_HTTPS` | `1` | Yes | Railway terminates public HTTPS and forwards HTTP to the container. |
  | `FRAME_ADMIN_PASSWORD` | a strong password | Yes for public Railway apps | Use the literal password only; do not append `${{...}}` or reference itself. |
  | `FRAME_ENABLE_FACE_MATCH` | `1` | Optional | Enables the Smart Face Match pipeline; the built-in detector is a no-op until a local detector is registered. |
  | `GOOGLE_CLIENT_ID` | Google OAuth client ID | Optional | Only needed for Google Photos import. Leave blank/remove until you have the real ID. |
  | `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | Optional | Only needed for Google Photos import. Leave blank/remove until you have the real secret. |
  | `GOOGLE_REDIRECT_URI` | `https://<your>.up.railway.app/api/google/callback` | Optional | Required only when Google Photos import is enabled; include `https://` and `/api/google/callback`. |

  You can ignore Railway's other suggested variables (`FRAME_TLS_KEY`, `FRAME_TLS_CERT`,
  `FRAME_HTTP_PORT`, `FRAME_HTTPS_PORT`, `FRAME_HOST`, `FRAME_DATA_DIR`) unless you have a
  specific custom setup. The Docker image already defaults to `/data` and port `9095`. Railway rejects
  Dockerfile `VOLUME` instructions, so persistence must come from the Railway volume mount
  (Railway also injects `RAILWAY_VOLUME_MOUNT_PATH`).

After changing the target port, healthcheck path, or variables, redeploy the service and check
`https://<your>.up.railway.app/api/health` before opening `/admin/`. If the deploy detail page
shows `Network › Healthcheck`, verify Railway's healthcheck field is `/api/health`; a full URL
there will fail.

If Railway shows multiple failed services (`admin`, `display`, `server`, etc.), open each failed
service's **Deployments → latest failed build → View logs** to confirm the exact error, then remove
the extra services from **Project Settings → Danger → Manage Services**. Keep only the single
root/Dockerfile service and the `/data` volume.

**Cost/caveats:** keep one machine always running (a frame must stay up); media lives on the
paid volume; streaming 4K to the TV uses egress. For a home frame, LAN/Pi is cheaper and lower
latency — cloud mainly buys you remote access.
