# Platform packaging

The **display** app (`/display`) is a single web artifact that runs on every target.
This directory holds the thin per-platform wrappers.

## Chromecast (Custom Web Receiver)
- The built display page *is* the receiver. Deploy `display/dist` to an HTTPS URL.
- Register an application id at the [Cast SDK Developer Console](https://cast.google.com/publish)
  and point it at that URL. Put the id in `packaging/cast/receiver.json` and set
  `VITE_CAST_APP_ID` when building the admin (sender).

## Samsung TV (Tizen)
- Tizen apps are HTML5/JS. `packaging/tizen/config.xml` points the app at the display.
- Package with Tizen Studio (`tizen build-web` / `tizen package -t wgt`) or load the
  display URL in the TV browser for a quick start.

## Android TV
- `packaging/androidtv` is a thin Trusted Web Activity / WebView wrapper around the
  display URL, plus a home-screen channel. Build with Android Studio / Bubblewrap.

See the repository `README.md` "Deployment" section for the full flow.
