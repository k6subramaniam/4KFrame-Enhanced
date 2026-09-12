/**
 * Display client entrypoint.
 *
 * Connects to the backend WebSocket, renders the slideshow with WebGL transitions for
 * photos and an HTML5 <video> element for videos, applies overlays, and acts as a
 * Chromecast receiver when applicable.
 *
 * Rendering is **aspect-aware**: every frame is composed to this display's real screen
 * size, so the same library casts correctly to 16:9 TVs, ultrawide, 4:3, square and
 * portrait frames at the same time — each connected display composes for its own screen.
 */
import {
  defaultConfig,
  faceCenterToPan,
  type ControlMessage,
  type FrameConfig,
  type FillMode,
  type FrameEvent,
  type LiveCastInfo,
  renderSharedSettings,
  type MediaItem,
  type SettingsPatch,
  normalizeTransform,
  orientedDimensions,
} from '@4kframe/shared';
import { GLRenderer } from './gl.js';
import { compose, contentRect } from './compositor.js';
import { applyOverlays, setCaption, setStatus } from './overlays.js';
import { initCastReceiver } from './cast.js';
import { playbackBlockedStatusMessage, seekActiveVideo, syncVideoPlaybackProperties } from './videoPlayback.js';
import { attachMediaGestures } from './gestures.js';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const video = document.getElementById('video') as HTMLVideoElement;
const videoBg = document.getElementById('video-bg') as HTMLElement;
const renderer = new GLRenderer(canvas);
const app = document.getElementById('app') as HTMLElement;

let config: FrameConfig = defaultConfig();
let prevFrame: HTMLCanvasElement | null = null;
let socket: WebSocket | null = null;

// Current content, retained so we can recompose on screen resize / config change.
let lastItems: MediaItem[] | null = null;
let lastVideoItem: MediaItem | null = null;
let showingVideo = false;
let paused = false;
let holding = false;
let receivedConfigEvent = false;
let receivedPausedEvent = false;
let lastPlaybackReportAt = 0;
let displayHeartbeatTimer: ReturnType<typeof window.setInterval> | undefined;
let tvAudioFallbackActive = false;
let tvAudioUnlocked = false;
/** Set when the browser refuses even muted playback, so a later gesture can retry it. */
let playbackBlocked = false;
/** Set when playback runs but no video frame ever decodes (audio-only on this TV). */
let videoTrackMissing = false;
/** Base transform for the active video, so the repaint pump can append to it. */
let videoBaseTransform = '';
let repaintPumpHandle = 0;
let repaintPumpUsesFrameCallback = false;
let repaintNudge = false;
let videoRetryItemId: string | null = null;
let videoRetryCount = 0;
let videoSkipTimer: ReturnType<typeof window.setTimeout> | undefined;
let displayMediaToken: string | undefined;
const PLAYBACK_REPORT_INTERVAL_MS = 1_000;
const DISPLAY_HEARTBEAT_MS = 5_000;
const VIDEO_SEEK_SECONDS = 10;

/** Forward a control message to the backend (used to bridge Cast custom messages). */
function sendControl(msg: ControlMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function reportVideoPlayback(force = false): void {
  if (!showingVideo || !lastVideoItem) return;
  const now = Date.now();
  if (!force && now - lastPlaybackReportAt < PLAYBACK_REPORT_INTERVAL_MS) return;
  lastPlaybackReportAt = now;
  sendControl({
    type: 'playbackState',
    itemId: lastVideoItem.id,
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    seekable: video.seekable.length > 0 && Number.isFinite(video.duration) && video.duration > 0,
  });
}

/** This display's render size in device pixels, capped to bound texture memory. */
function screenPixels(): { w: number; h: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = Math.round(window.innerWidth * dpr);
  let h = Math.round(window.innerHeight * dpr);
  if (config.screenRotation === 90 || config.screenRotation === 270) [w, h] = [h, w];
  const longest = Math.max(w, h);
  const maxEdge = 3840;
  if (longest > maxEdge) {
    const s = maxEdge / longest;
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

function logicalViewport(): { w: number; h: number } {
  return config.screenRotation === 90 || config.screenRotation === 270
    ? { w: window.innerHeight, h: window.innerWidth }
    : { w: window.innerWidth, h: window.innerHeight };
}

function applyScreenTransform(): void {
  const quarterTurn = config.screenRotation === 90 || config.screenRotation === 270;
  const identity = config.screenRotation === 0
    && !config.screenFlipHorizontal
    && !config.screenFlipVertical;

  if (identity) {
    // No rotation or flip: leave #app on its plain `inset: 0` CSS with no transform at all.
    // A transform — even an identity one — forces a compositing context, and TV browsers
    // commonly fail to composite hardware-decoded video inside a transformed ancestor
    // (the audio plays but no frame is ever painted).
    app.style.inset = '';
    app.style.left = '';
    app.style.top = '';
    app.style.width = '';
    app.style.height = '';
    app.style.transformOrigin = '';
    app.style.transform = '';
    return;
  }

  app.style.inset = 'auto';
  app.style.left = '50%';
  app.style.top = '50%';
  app.style.width = quarterTurn ? '100vh' : '100vw';
  app.style.height = quarterTurn ? '100vw' : '100vh';
  app.style.transformOrigin = 'center';
  app.style.transform = `translate(-50%, -50%) rotate(${config.screenRotation}deg) scale(${config.screenFlipHorizontal ? -1 : 1}, ${config.screenFlipVertical ? -1 : 1})`;
}

function composeCurrent(items: MediaItem[]): Promise<HTMLCanvasElement> {
  const { w, h } = screenPixels();
  return compose(items, {
    screenWidth: w,
    screenHeight: h,
    fillMode: config.fillMode,
    aspect: config.frameAspect,
    zoom: config.zoom,
    panX: config.panX,
    panY: config.panY,
    smartFraming: config.smartFraming,
  });
}

async function renderItems(items: MediaItem[], interactive: boolean): Promise<void> {
  stopMotion();
  const videoItem = items.find((i) => i.kind === 'video');
  if (videoItem) {
    lastItems = null;
    await renderVideo(videoItem);
    return;
  }

  if (showingVideo) hideVideo();
  lastItems = items;
  lastVideoItem = null;

  const toFrame = await composeCurrent(items);
  const duration = interactive ? config.interactiveTransitionPeriod : config.transitionPeriod;
  if (prevFrame) {
    await renderer.transition(prevFrame, toFrame, String(config.transition), duration);
  } else {
    renderer.show(toFrame);
  }
  prevFrame = toFrame;
  setCaption(items, config);
  syncPublicControls();

  // Photos that fail to load produced a silent black screen with no status and no skip —
  // unlike videos, which already self-skip. Treat them the same way.
  if (toFrame.dataset.mediaFailed === 'true') {
    setStatus('');
    const failedIds = items.map((i) => i.id).join(',');
    window.setTimeout(() => {
      if (lastItems?.map((i) => i.id).join(',') !== failedIds) return; // already moved on
      setStatus(statusText());
      if (!paused) goNext();
    }, 2500);
    return;
  }

  // Ken Burns motion only for single photos (not dual layout), and never while paused.
  if (items.length === 1 && !paused) startMotion();
}

// --- Ken Burns ambient motion (CSS transform on the GL canvas, GPU-composited) ---

let motionAnim: Animation | null = null;

function stopMotion(): void {
  motionAnim?.cancel();
  motionAnim = null;
  canvas.style.transform = '';
}

function startMotion(): void {
  stopMotion();
  if (config.motion === 'off') return;
  const seconds = config.photoPeriod > 0 ? config.photoPeriod : 12;
  const z = 1.18;
  const sign = () => (Math.random() < 0.5 ? -1 : 1);
  const px = (sign() * 3).toFixed(2);
  const py = (sign() * 2).toFixed(2);
  let from: string;
  let to: string;
  if (config.motion === 'zoom') {
    [from, to] = ['scale(1)', `scale(${z})`];
  } else if (config.motion === 'pan') {
    // Pan needs a little zoom so there's room to move within the screen.
    [from, to] = [`scale(${z}) translate(${px}%, ${py}%)`, `scale(${z}) translate(${-Number(px)}%, ${-Number(py)}%)`];
  } else {
    [from, to] = ['scale(1) translate(0,0)', `scale(${z}) translate(${px}%, ${py}%)`];
  }
  motionAnim = canvas.animate([{ transform: from }, { transform: to }], {
    duration: seconds * 1000,
    easing: 'ease-out',
    fill: 'forwards',
  });
}

function reportPlaybackBlocked(error: unknown): void {
  // Keep autoplay-policy noise out of the TV UI.
  console.warn('Video playback was blocked by the browser.', error);
  setStatus('');
}

/**
 * Whether the page has ever seen a real user interaction.
 *
 * Audible playback is impossible before this, so there is no point unmuting (and trying
 * costs us the picture: a browser refuses the play() outright rather than playing silently).
 */
function hasUserActivation(): boolean {
  const ua = (navigator as Navigator & {
    userActivation?: { hasBeenActive: boolean; isActive: boolean };
  }).userActivation;
  if (ua) return ua.hasBeenActive || ua.isActive;
  return tvAudioUnlocked; // engines without the API: fall back to our own gesture latch
}

/**
 * Start (or resume) the active video, preferring TV audio but never at the cost of the
 * picture. Falls back to muted playback, and latches `playbackBlocked` when even muted
 * playback is refused so a later user gesture can retry it.
 */
async function attemptVideoPlayback(): Promise<void> {
  if (!showingVideo || paused) return;
  try {
    await video.play();
    playbackBlocked = false;
    return;
  } catch (error) {
    reportPlaybackBlocked(error);
    // A redundant play() on an already-running video can be rejected; that is not a block.
    if (!video.paused) return;
    if (video.muted) {
      // Even silent playback was refused — this TV requires an interaction for any
      // playback at all. Say so instead of sitting on a dead frame.
      playbackBlocked = true;
      setStatus(playbackBlockedStatusMessage(config.videoAudioMode));
      return;
    }
    // Audible playback was refused; retry silently so the frame still shows motion.
    tvAudioFallbackActive = true;
    tvAudioUnlocked = false;
    video.muted = true;
    video.defaultMuted = true;
  }
  try {
    await video.play();
    playbackBlocked = false;
  } catch (error) {
    reportPlaybackBlocked(error);
    if (!video.paused) return; // playing already; the retry was simply redundant
    playbackBlocked = true;
    setStatus(playbackBlockedStatusMessage(config.videoAudioMode));
  }
}

/**
 * Audible autoplay can be rejected by Chromecast/TV Chromium until the page receives a
 * trusted remote/touch interaction. Never leave the TV black in that case: retry the same
 * video muted immediately. A later trusted interaction unlocks TV audio.
 */
function recoverBlockedVideoPlayback(error: unknown): void {
  reportPlaybackBlocked(error);
  if (!showingVideo || paused) return;
  void attemptVideoPlayback();
}

function desiredDisplayVideoMuted(): boolean {
  if (config.videoAudioMode !== 'tv') return true;
  // Without a user gesture the browser will reject audible playback outright, taking the
  // picture with it. Start silent and upgrade to sound on the first interaction.
  if (!hasUserActivation()) return true;
  return tvAudioFallbackActive && !tvAudioUnlocked;
}

/** Keep the active video element aligned with persisted playback settings. */
function syncActiveVideoPlaybackProperties(restartAfterUnmute = false): void {
  syncVideoPlaybackProperties(video, {
    muted: desiredDisplayVideoMuted(),
    loop: config.videoLoop || holding,
    playbackRate: config.videoPlaybackRate,
    volume: config.videoVolume,
    restartAfterUnmute: restartAfterUnmute && showingVideo && !paused,
    onPlaybackRejected: recoverBlockedVideoPlayback,
  });
}

/** A trusted TV/browser interaction can promote muted fallback playback back to TV audio. */
function unlockTvAudioFromUserGesture(event: Event): void {
  if (!event.isTrusted) return;
  // A TV that refuses even muted autoplay leaves the frame stopped; this interaction is
  // the first chance to start it, whatever the audio mode is.
  if (playbackBlocked && showingVideo && !paused) {
    playbackBlocked = false;
    video.muted = desiredDisplayVideoMuted();
    video.defaultMuted = video.muted;
    void attemptVideoPlayback();
    return;
  }
  if (config.videoAudioMode !== 'tv') return;
  tvAudioUnlocked = true;
  if (!showingVideo || paused || (!tvAudioFallbackActive && !video.muted)) return;
  tvAudioFallbackActive = false;
  video.muted = false;
  video.defaultMuted = false;
  void video.play().catch((error) => {
    // Some receiver builds still reject the first audible restart. Preserve visual playback.
    tvAudioUnlocked = false;
    tvAudioFallbackActive = true;
    video.muted = true;
    video.defaultMuted = true;
    reportPlaybackBlocked(error);
    void video.play().catch(reportPlaybackBlocked);
  });
}

async function ensureDisplayMediaSession(): Promise<void> {
  try {
    const response = await fetch('/api/display-media-session', {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) return;
    const body = await response.json() as { token?: unknown };
    displayMediaToken = typeof body.token === 'string' && body.token ? body.token : undefined;
  } catch {
    // Private-LAN/no-auth mode does not depend on this session; normal media errors still
    // flow through the retry/skip path below.
  }
}

function displayMediaUrl(file: string): string {
  const base = `/photos/${file}`;
  return displayMediaToken
    ? `${base}?media_auth=${encodeURIComponent(displayMediaToken)}`
    : base;
}

async function renderVideo(item: MediaItem): Promise<void> {
  showingVideo = true;
  lastVideoItem = item;
  videoTrackMissing = false; // video→video transitions skip hideVideo()
  if (videoRetryItemId !== item.id) {
    videoRetryItemId = item.id;
    videoRetryCount = 0;
  }
  window.clearTimeout(videoSkipTimer);
  videoSkipTimer = undefined;
  // Establish the scoped media cookie before assigning src. Chromecast's media stack
  // performs separate HEAD/Range requests that otherwise lose an admin/query handoff.
  await ensureDisplayMediaSession();
  layoutVideo(item);
  syncActiveVideoPlaybackProperties();
  video.onerror = () => handleVideoError(item);
  // Show the video's own first frame while it loads — and keep showing it if this TV
  // refuses to autoplay at all. Without a poster the element paints pure black.
  const posterFile = item.poster ?? item.thumb;
  if (posterFile) video.poster = displayMediaUrl(posterFile);
  else video.removeAttribute('poster');
  video.src = displayMediaUrl(item.file);
  lastPlaybackReportAt = 0;
  video.classList.add('visible');
  await attemptVideoPlayback();
  setCaption([item], config);
  reportVideoPlayback(true);
  syncPublicControls();
}

/** A video that can't be decoded (bad/unsupported file) shouldn't freeze the frame on black. */
function handleVideoError(item: MediaItem): void {
  if (lastVideoItem?.id !== item.id) return; // stale handler from a previous item

  // TV media stacks occasionally fail the first decoder/load attempt during a source
  // transition. Retry once before declaring the file unplayable.
  if (videoRetryItemId !== item.id) {
    videoRetryItemId = item.id;
    videoRetryCount = 0;
  }
  if (videoRetryCount < 1) {
    videoRetryCount += 1;
    console.warn(`Video ${item.file} failed to load; retrying once before skip.`);
    setStatus('');
    window.setTimeout(() => {
      if (lastVideoItem?.id !== item.id) return;
      video.load();
      void attemptVideoPlayback();
    }, 650);
    return;
  }

  console.error(`Cannot play video ${item.file} after retry — skipping.`);
  setStatus('');
  window.clearTimeout(videoSkipTimer);
  // Delay so several genuinely bad files in a row skip calmly rather than in a tight loop.
  videoSkipTimer = window.setTimeout(() => {
    if (lastVideoItem?.id !== item.id) return;
    setStatus(statusText());
    if (!paused) goNext();
  }, 2500);
}

/** Position the <video> into the aspect content rect and set its backdrop. */
function effectiveVideoFit(fillMode: FillMode): 'cover' | 'contain' | 'stretch' {
  // Blur mode keeps the sharp foreground video contained above the blurred backdrop.
  if (fillMode === 'blur') return 'contain';
  return fillMode;
}

function fittedMediaSize(
  item: MediaItem,
  frameW: number,
  frameH: number,
  fillMode: FillMode | 'cover' | 'contain' | 'stretch',
  zoom = 1,
): { w: number; h: number } {
  const safeZoom = Math.max(1, Number.isFinite(zoom) ? zoom : 1);
  if (fillMode === 'stretch') return { w: frameW * safeZoom, h: frameH * safeZoom };
  const fit = fillMode === 'cover' ? 'cover' : 'contain';
  const source = orientedDimensions(item.width, item.height, item.rotation ?? 0);
  const base = fit === 'cover'
    ? Math.max(frameW / source.width, frameH / source.height)
    : Math.min(frameW / source.width, frameH / source.height);
  return { w: source.width * base * safeZoom, h: source.height * base * safeZoom };
}

function hasManualVideoOverride(): boolean {
  return Math.abs(config.panX) > 0.001 || Math.abs(config.panY) > 0.001 || config.zoom > 1.001;
}

function smartVideoObjectPosition(item: MediaItem, r: { w: number; h: number }, fit: 'cover' | 'contain' | 'stretch'): { panX: number; panY: number } {
  if (hasManualVideoOverride()) return { panX: config.panX, panY: config.panY };
  if (!config.smartFraming || !item.faces?.length) return { panX: 0, panY: 0 };

  const fitted = fittedMediaSize(item, r.w, r.h, fit, config.zoom);
  return faceCenterToPan({
    item,
    frameWidth: r.w,
    frameHeight: r.h,
    fittedWidth: fitted.w,
    fittedHeight: fitted.h,
  });
}

function layoutVideo(item: MediaItem): void {
  const viewport = logicalViewport();
  const r = contentRect(viewport.w, viewport.h, config.frameAspect);
  const fillMode = effectiveVideoFit(config.fillMode);
  const zoom = clampN(config.zoom, MIN_ZOOM, MAX_ZOOM);
  const raw = fittedMediaSize(item, r.w, r.h, fillMode, zoom);
  // An item with missing/zero stored dimensions makes the fit math produce NaN, which the
  // browser then ignores — leaving the element unsized. Fall back to filling the frame so
  // the picture is always laid out somewhere real.
  const fitted = Number.isFinite(raw.w) && Number.isFinite(raw.h) && raw.w >= 1 && raw.h >= 1
    ? raw
    : { w: r.w, h: r.h };
  const pan = smartVideoObjectPosition(item, r, fillMode);
  const overflowX = Math.max(0, fitted.w - r.w);
  const overflowY = Math.max(0, fitted.h - r.h);
  const dx = r.x + (r.w - fitted.w) / 2 - (clampN(pan.panX, -1, 1) * overflowX) / 2;
  const dy = r.y + (r.h - fitted.h) / 2 - (clampN(pan.panY, -1, 1) * overflowY) / 2;

  const transform = normalizeTransform(item);
  const quarterTurn = transform.rotation === 90 || transform.rotation === 270;
  video.style.left = `${dx + fitted.w / 2}px`;
  video.style.top = `${dy + fitted.h / 2}px`;
  video.style.width = `${quarterTurn ? fitted.h : fitted.w}px`;
  video.style.height = `${quarterTurn ? fitted.w : fitted.h}px`;
  videoBaseTransform = `translate(-50%, -50%) rotate(${transform.rotation}deg) scale(${transform.flipHorizontal ? -1 : 1}, ${transform.flipVertical ? -1 : 1})`;
  video.style.transform = videoBaseTransform;
  video.style.objectFit = 'fill';
  video.style.objectPosition = '50% 50%';
  video.style.clipPath = '';

  // Opaque backdrop hides the stale photo behind any bars; blurred poster in blur mode.
  videoBg.classList.add('visible');
  videoBg.style.filter = '';
  videoBg.style.transform = '';
  videoBg.style.backgroundSize = '';
  videoBg.style.backgroundRepeat = '';
  // Some TVs composite video on a hardware overlay *beneath* the page, visible only where
  // the page is transparent — an opaque layer over it yields sound with a black picture.
  // Hide the GL canvas and drop the black backdrop while a video is up; the body is
  // already black, so letterbox bars look identical either way.
  canvas.style.visibility = 'hidden';
  if (config.fillMode === 'blur' && item.poster) {
    videoBg.style.backgroundColor = '';
    videoBg.style.backgroundImage = `url("${displayMediaUrl(item.poster)}")`;
  } else {
    videoBg.style.backgroundColor = 'transparent';
    videoBg.style.backgroundImage = 'none';
  }
}

/**
 * On-screen video diagnostics, enabled with `?debug=1`.
 *
 * A TV browser has no devtools, so the numbers needed to tell these cases apart have to be
 * readable from the couch:
 *   decoded 0x0 while playing  -> the TV cannot decode this video track (audio-only)
 *   rect 0x0 or off-screen     -> the element is mis-laid-out, not a decode problem
 *   opacity 0 / visible=false  -> it is playing but hidden
 */
function initVideoDiagnostics(): void {
  if (!new URLSearchParams(window.location.search).has('debug')) return;
  const panel = document.createElement('pre');
  panel.id = 'debug-panel';
  document.body.appendChild(panel);

  const tick = (): void => {
    const rect = video.getBoundingClientRect();
    const cs = window.getComputedStyle(video);
    const err = video.error;
    panel.textContent = [
      `file      ${lastVideoItem?.file ?? '(no video showing)'}`,
      `meta dims ${lastVideoItem?.width ?? '?'} x ${lastVideoItem?.height ?? '?'}`,
      `DECODED   ${video.videoWidth} x ${video.videoHeight}${video.videoWidth ? '' : '   <-- NO VIDEO TRACK DECODED'}`,
      `rect      ${Math.round(rect.width)} x ${Math.round(rect.height)} at ${Math.round(rect.left)},${Math.round(rect.top)}`,
      `css size  ${video.style.width || '(auto)'} x ${video.style.height || '(auto)'}`,
      `opacity   ${cs.opacity}   visible=${video.classList.contains('visible')}   display=${cs.display}`,
      `playback  paused=${video.paused} muted=${video.muted} t=${video.currentTime.toFixed(1)} ready=${video.readyState} net=${video.networkState}`,
      `error     ${err ? `code ${err.code} ${err.message}` : 'none'}`,
      `poster    ${video.poster ? video.poster.split('/').pop() : '(none)'}`,
      `config    fill=${config.fillMode} aspect=${config.frameAspect} zoom=${config.zoom} rot=${config.screenRotation}`,
      `compositing app-transform=${window.getComputedStyle(app).transform === 'none' ? 'none' : 'SET'}`
        + ` canvas=${window.getComputedStyle(canvas).visibility}`
        + ` backdrop=${window.getComputedStyle(videoBg).backgroundColor}`,
    ].join('\n');
  };
  tick();
  window.setInterval(tick, 500);
}

/**
 * Keep the compositor producing frames while a video is on screen.
 *
 * Some TV browsers only composite the hardware video overlay when the page itself paints.
 * A slideshow parked on a video paints nothing, so the picture stays black while the audio
 * plays — which is exactly why `?debug=1` "fixed" it: that panel rewrote its text twice a
 * second and incidentally drove the repaints.
 *
 * The nudge is a sub-pixel translateZ on the video's own layer: visually identical (there
 * is no perspective, so Z has no effect), but it marks the layer dirty so a frame is
 * produced. Driven off requestVideoFrameCallback where available so it ticks with the
 * video's own cadence rather than the display refresh rate.
 */
function startVideoRepaintPump(): void {
  stopVideoRepaintPump();
  const tick = (): void => {
    if (!showingVideo || paused) { repaintPumpHandle = 0; return; }
    repaintNudge = !repaintNudge;
    video.style.transform = `${videoBaseTransform} translateZ(${repaintNudge ? '0.01px' : '0px'})`;
    schedule();
  };
  const schedule = (): void => {
    const vfc = (video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    }).requestVideoFrameCallback;
    if (typeof vfc === 'function') {
      repaintPumpUsesFrameCallback = true;
      repaintPumpHandle = vfc.call(video, tick);
    } else {
      repaintPumpUsesFrameCallback = false;
      repaintPumpHandle = window.requestAnimationFrame(tick);
    }
  };
  schedule();
}

function stopVideoRepaintPump(): void {
  if (!repaintPumpHandle) return;
  const cancelVfc = (video as HTMLVideoElement & {
    cancelVideoFrameCallback?: (handle: number) => void;
  }).cancelVideoFrameCallback;
  if (repaintPumpUsesFrameCallback && typeof cancelVfc === 'function') {
    cancelVfc.call(video, repaintPumpHandle);
  } else if (!repaintPumpUsesFrameCallback) {
    window.cancelAnimationFrame(repaintPumpHandle);
  }
  repaintPumpHandle = 0;
  if (videoBaseTransform) video.style.transform = videoBaseTransform;
}

/**
 * Some TV browsers decode a clip's audio but not its video track (HEVC / 10-bit / high
 * profile). That plays sound over a black screen with no error event at all, so watch for
 * playback that is running without any decoded frame and show the still frame instead.
 */
function checkVideoTrackDecoding(): void {
  if (!showingVideo || !lastVideoItem || video.paused) return;
  if (video.videoWidth > 0) { videoTrackMissing = false; return; }
  // Give the decoder a moment before declaring the track unusable.
  if (video.currentTime < 0.6 || videoTrackMissing) return;

  videoTrackMissing = true;
  const posterFile = lastVideoItem.poster ?? lastVideoItem.thumb;
  console.warn(`No decoded video frames for ${lastVideoItem.file} — audio-only playback.`);
  if (posterFile) {
    // Paint the poster full-frame (unblurred) so the TV shows the picture, not black.
    videoBg.style.filter = 'none';
    videoBg.style.transform = 'none';
    videoBg.style.backgroundSize = 'contain';
    videoBg.style.backgroundRepeat = 'no-repeat';
    videoBg.style.backgroundImage = `url("${displayMediaUrl(posterFile)}")`;
  }
  setStatus('This TV can’t decode that video format — showing the still frame.');
}

function hideVideo(): void {
  showingVideo = false;
  lastVideoItem = null;
  window.clearTimeout(videoSkipTimer);
  videoSkipTimer = undefined;
  videoRetryItemId = null;
  videoRetryCount = 0;
  video.onerror = null;
  video.classList.remove('visible');
  video.removeAttribute('poster'); // don't flash the previous clip's frame on the next one
  stopVideoRepaintPump();
  videoBaseTransform = '';
  playbackBlocked = false;
  videoTrackMissing = false;
  videoBg.classList.remove('visible');
  videoBg.style.backgroundColor = '';
  canvas.style.visibility = ''; // photos render through the GL canvas again
  video.pause();
  video.removeAttribute('src');
  video.load();
  syncPublicControls();
}

/** Recompose the current content for a new screen size or fill/aspect/zoom change (no transition). */
async function rerender(): Promise<void> {
  stopMotion();
  if (showingVideo && lastVideoItem) {
    layoutVideo(lastVideoItem);
    return;
  }
  if (lastItems) {
    const frame = await composeCurrent(lastItems);
    renderer.show(frame);
    prevFrame = frame;
    if (lastItems.length === 1 && !paused) startMotion();
  }
}

function statusText(): string {
  // Playback state lives in the controls themselves; keep the media canvas text-free.
  return '';
}

// --- Live Cast overlay ---------------------------------------------------------------
// A one-off push from the companion app, shown over the slideshow until it expires. The
// server keeps rotating underneath (and keeps sending 'show'), so ending a cast is just a
// matter of hiding the overlay and repainting the last real payload.

/** Upper bound for the local expiry timer — mirrors the server's MAX_TTL_SEC (300s). */
const LIVE_CAST_MAX_MS = 300_000;

const liveCastImg = document.getElementById('live-cast-img') as HTMLImageElement | null;
const liveCastVideo = document.getElementById('live-cast-video') as HTMLVideoElement | null;
let liveCastActive: LiveCastInfo | null = null;
let lastShowEvent: Extract<FrameEvent, { type: 'show' }> | null = null;
let liveCastTimer: ReturnType<typeof setTimeout> | undefined;

function startLiveCast(info: LiveCastInfo): void {
  if (!liveCastImg || !liveCastVideo) return;
  clearTimeout(liveCastTimer);
  liveCastActive = info;
  stopMotion();

  // If the bytes can't be fetched (expired, replaced, auth), bail out immediately rather
  // than holding a black layer over the slideshow for the rest of the window.
  const onMediaError = (): void => {
    setStatus('');
    endLiveCast();
  };
  liveCastImg.onerror = onMediaError;
  liveCastVideo.onerror = onMediaError;

  const url = `/api/live-cast/${encodeURIComponent(info.id)}`;
  if (info.kind === 'video') {
    liveCastImg.classList.remove('visible');
    liveCastImg.removeAttribute('src');
    liveCastVideo.src = url;
    liveCastVideo.classList.add('visible');
    liveCastVideo.play().catch(() => {}); // muted, so this should not be blocked
  } else {
    liveCastVideo.classList.remove('visible');
    liveCastVideo.pause();
    liveCastVideo.removeAttribute('src');
    liveCastImg.src = url;
    liveCastImg.classList.add('visible');
  }

  // Don't rely solely on the server's liveCastEnd broadcast — a display that reconnects
  // mid-window would otherwise stay stuck on an expired cast. `expiresAt` is server-clock
  // based, so clamp it: a skewed display clock could otherwise dismiss instantly or
  // schedule past setTimeout's 32-bit ceiling (which also fires immediately).
  const remaining = Math.min(LIVE_CAST_MAX_MS, Math.max(0, info.expiresAt - Date.now()));
  liveCastTimer = setTimeout(endLiveCast, remaining);
}

function endLiveCast(): void {
  if (!liveCastActive) return;
  clearTimeout(liveCastTimer);
  liveCastActive = null;
  for (const el of [liveCastImg, liveCastVideo]) {
    if (!el) continue;
    el.onerror = null; // detach first: clearing src can itself fire `error`
    el.classList.remove('visible');
    el.removeAttribute('src');
  }
  liveCastVideo?.pause();
  if (lastShowEvent) renderItems(lastShowEvent.items, false).catch((err) => console.error(err));
  else rerender().catch((err) => console.error(err));
}

function handleEvent(event: FrameEvent): void {
  switch (event.type) {
    case 'config':
      receivedConfigEvent = true;
      config = event.config;
      applyScreenTransform();
      syncActiveVideoPlaybackProperties(true);
      applyOverlays(config);
      renderPublicSettings();
      updateControlStates();
      rerender().catch((err) => console.error(err));
      break;
    case 'show':
      // Always remember the latest real payload, even while a live cast covers the screen,
      // so ending the cast can repaint instantly without waiting for the next rotation.
      lastShowEvent = event;
      if (!liveCastActive) renderItems(event.items, event.interactive).catch((err) => console.error(err));
      break;
    case 'liveCast':
      startLiveCast(event.liveCast);
      break;
    case 'liveCastEnd':
      endLiveCast();
      break;
    case 'seek':
      if ('offsetSec' in event) {
        seekActiveVideo(video, event.offsetSec, showingVideo);
      } else if (showingVideo && lastVideoItem?.id === event.itemId && Number.isFinite(video.duration)) {
        video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + event.deltaSec));
        reportVideoPlayback(true);
      }
      break;
    case 'library':
      // No-op for the display; the server drives what is shown.
      break;
    case 'paused':
      receivedPausedEvent = true;
      paused = event.paused;
      if (showingVideo) {
        if (paused) { video.pause(); stopVideoRepaintPump(); }
        else void attemptVideoPlayback();
      } else if (paused) {
        motionAnim?.pause();
      } else {
        motionAnim?.play();
      }
      setStatus(statusText());
      updateControlStates();
      break;
    case 'hold':
      holding = event.holding;
      if (showingVideo) syncActiveVideoPlaybackProperties();
      setStatus(statusText());
      break;
    case 'log':
      if (event.level === 'error') console.error(event.message);
      break;
  }
}

video.addEventListener('loadedmetadata', () => reportVideoPlayback(true));
// The browser is the authority on whether playback actually started — clear any
// "autoplay blocked" notice from here rather than trying to track every play() path.
video.addEventListener('playing', () => {
  playbackBlocked = false;
  startVideoRepaintPump();
  // Don't clobber the "can't decode this format" notice — `playing` re-fires after every
  // buffering stall, which would otherwise wipe it moments after it appears.
  if (videoTrackMissing) return;
  // Unconditional otherwise: statusText() is '' unless paused/holding, so this both clears
  // a stale "autoplay blocked" notice and restores the right badge.
  setStatus(statusText());
});
video.addEventListener('durationchange', () => reportVideoPlayback(true));
video.addEventListener('timeupdate', () => { reportVideoPlayback(); checkVideoTrackDecoding(); });
video.addEventListener('seeked', () => reportVideoPlayback(true));

/**
 * TV remote / keyboard control. D-pad and OK on TV browsers arrive as arrow + Enter keys;
 * media remotes send the Media* keys. All control flows through the same WebSocket protocol.
 *
 * When zoomed in (zoom > 1), the D-pad arrows pan the image instead of navigating; zoom out
 * to 1× to navigate again. `+`/`-` zoom, `0` resets.
 */
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.2;
const PAN_STEP = 0.1;

function clampN(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function goNext(): void {
  sendControl({ type: 'next' });
}

function goPrevious(): void {
  sendControl({ type: 'previous' });
}

function navigateContext(direction: -1 | 1): void {
  if (showingVideo && seekActiveVideo(video, direction * VIDEO_SEEK_SECONDS, true)) {
    reportVideoPlayback(true);
    syncPublicVideoTimeline();
    return;
  }
  if (direction < 0) goPrevious();
  else goNext();
}

function togglePause(): void {
  sendControl({ type: paused ? 'resume' : 'pause' });
}

function adjustConfig(patch: Partial<FrameConfig>): void {
  sendControl({ type: 'publicConfig', patch });
}

function setZoom(zoom: number): void {
  const z = clampN(zoom, MIN_ZOOM, MAX_ZOOM);
  adjustConfig(z <= MIN_ZOOM + 0.001 ? { zoom: MIN_ZOOM, panX: 0, panY: 0 } : { zoom: z });
}

function setPan(panX: number, panY: number): void {
  adjustConfig({
    panX: clampN(panX, -1, 1),
    panY: clampN(panY, -1, 1),
  });
}

function resetZoomPan(): void {
  adjustConfig({ zoom: MIN_ZOOM, panX: 0, panY: 0 });
}

/**
 * Touch gestures on the media itself: double-tap zooms 2× centered on the tap (double-tap
 * again resets), dragging while zoomed pans. Pan broadcasts are throttled (leading +
 * trailing) so a drag doesn't flood the WebSocket/config store with per-frame patches.
 */
function wireMediaGestures(): void {
  const app = document.getElementById('app');
  if (!app) return;
  const PAN_SEND_MS = 120;
  let lastPanSend = 0;
  let panTrailing: ReturnType<typeof setTimeout> | undefined;
  const sendZoomPan = (zoom: number, panX: number, panY: number): void => {
    adjustConfig({
      zoom: clampN(zoom, MIN_ZOOM, MAX_ZOOM),
      panX: clampN(panX, -1, 1),
      panY: clampN(panY, -1, 1),
    });
  };
  attachMediaGestures(app as HTMLElement, {
    getZoom: () => config.zoom,
    getPan: () => ({ panX: config.panX, panY: config.panY }),
    setZoomPan: (zoom, panX, panY) => {
      const now = performance.now();
      clearTimeout(panTrailing);
      if (now - lastPanSend >= PAN_SEND_MS) {
        lastPanSend = now;
        sendZoomPan(zoom, panX, panY);
      } else {
        panTrailing = setTimeout(() => {
          lastPanSend = performance.now();
          sendZoomPan(zoom, panX, panY);
        }, PAN_SEND_MS - (now - lastPanSend));
      }
    },
    resetZoomPan,
  });
}

function getElementByIds<T extends HTMLElement>(...ids: string[]): T | null {
  for (const id of ids) {
    const element = document.getElementById(id) as T | null;
    if (element) return element;
  }
  return null;
}

type PublicConfigKey =
  | 'photoPeriod'
  | 'transitionPeriod'
  | 'zoom'
  | 'panX'
  | 'panY'
  | 'fillMode'
  | 'frameAspect'
  | 'transition'
  | 'motion'
  | 'playbackMediaMode'
  | 'smartFraming'
  | 'showQr';

const NUMERIC_PUBLIC_CONFIG_KEYS = new Set<PublicConfigKey>(['photoPeriod', 'transitionPeriod', 'zoom', 'panX', 'panY']);
const BOOLEAN_PUBLIC_CONFIG_KEYS = new Set<PublicConfigKey>(['smartFraming', 'showQr']);

const controlsToggle = getElementByIds<HTMLButtonElement>('public-controls-toggle', 'controls-toggle');
const publicControlsRoot = document.getElementById('public-controls') as HTMLElement | null;
const publicSettingsRoot = document.getElementById('public-settings') as HTMLElement | null;
const publicControls = getElementByIds<HTMLElement>('public-control-panel', 'public-controls');
const bottomController = document.getElementById('public-bottom-controller') as HTMLElement | null;
const publicVideoTimeline = document.getElementById('public-video-timeline') as HTMLElement | null;
const publicVideoSeek = document.getElementById('public-video-seek') as HTMLInputElement | null;
const publicVideoCurrent = document.getElementById('public-video-current') as HTMLElement | null;
const publicVideoDuration = document.getElementById('public-video-duration') as HTMLElement | null;
const zoomPanSection = document.getElementById('public-zoom-pan-section') as HTMLElement | null;
const zoomPanToggle = document.getElementById('public-zoom-pan-toggle') as HTMLButtonElement | null;
const ZOOM_PAN_COLLAPSE_STORAGE_KEY = '4kframe.publicControls.zoomPanOpen';
const CONTROL_DIM_TIMEOUT_MS = 1800;
const CONTROL_HIDE_TIMEOUT_MS = 3800;
let controlDimTimer: ReturnType<typeof window.setTimeout> | undefined;
let controlHideTimer: ReturnType<typeof window.setTimeout> | undefined;
let publicTimelineScrubbing = false;

const QUICK_ACTIONS = [
  'fill-cover',
  'fill-contain',
  'smart-crop',
  'zoom-in',
  'zoom-out',
  'reset-view',
  'pan-up',
  'pan-down',
  'pan-left',
  'pan-right',
] as const;

type QuickAction = typeof QUICK_ACTIONS[number];

function isQuickAction(action: string | undefined): action is QuickAction {
  return QUICK_ACTIONS.includes(action as QuickAction);
}

function isPublicControlTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('#public-controls, #public-control-panel, #public-controls-toggle, #controls-toggle'));
}

function clearControlIdleTimers(): void {
  window.clearTimeout(controlDimTimer);
  window.clearTimeout(controlHideTimer);
  controlDimTimer = undefined;
  controlHideTimer = undefined;
}

function showBottomController(): void {
  bottomController?.classList.remove('is-hidden', 'is-dim');
  controlsToggle?.classList.remove('is-hidden');
  // The Controls pill sits at low opacity and previously only brightened on hover or
  // focus-visible — neither of which a TV remote produces, leaving it invisible. Tie it to
  // the same activity signal as the bottom bar. Keeping it faint when idle also avoids
  // burning a static bright element into a panel that runs 24/7.
  controlsToggle?.classList.add('is-active');
}

function scheduleControlIdle(): void {
  if (!bottomController) return;
  clearControlIdleTimers();
  controlDimTimer = window.setTimeout(() => {
    bottomController.classList.add('is-dim');
  }, CONTROL_DIM_TIMEOUT_MS);
  controlHideTimer = window.setTimeout(() => {
    // YouTube-style idle state: the media is the entire screen. Hide every control,
    // close every adjustments panel, and drop stale focus until the next touch/move/key.
    bottomController.classList.add('is-hidden');
    controlsToggle?.classList.add('is-hidden');
    controlsToggle?.classList.remove('is-active');
    if (publicControls && !publicControls.hidden) setControlsOpen(false, false);
    if (isPublicControlTarget(document.activeElement)) {
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
  }, CONTROL_HIDE_TIMEOUT_MS);
}

function registerPublicControlActivity(): void {
  showBottomController();
  scheduleControlIdle();
}

/**
 * Ordered list of on-screen controls a TV remote can land on.
 *
 * Chromecast's browser has no built-in spatial navigation and a remote sends no Tab, so
 * without an explicit roving-focus implementation these controls are literally unreachable
 * from the couch.
 */
function focusableControls(): HTMLElement[] {
  const roots = [bottomController, controlsToggle, publicControls].filter(Boolean) as HTMLElement[];
  const seen = new Set<HTMLElement>();
  const out: HTMLElement[] = [];
  for (const root of roots) {
    if (root.hidden || root.classList.contains('is-hidden')) continue;
    const candidates = root.matches('button, a[href], select, input')
      ? [root]
      : [...root.querySelectorAll<HTMLElement>('button, a[href], select, input, [tabindex]:not([tabindex="-1"])')];
    for (const el of candidates) {
      if (seen.has(el)) continue;
      if ((el as HTMLButtonElement).disabled) continue;
      if (el.tabIndex < 0) continue;
      if (el.offsetParent === null) continue; // not rendered
      seen.add(el);
      out.push(el);
    }
  }
  return out;
}

/** Move focus by `delta` within the on-screen controls. Returns false if it can't. */
function moveControlFocus(delta: number): boolean {
  const list = focusableControls();
  if (!list.length) return false;
  const current = list.indexOf(document.activeElement as HTMLElement);
  if (current < 0) {
    list[0].focus({ preventScroll: true });
    return true;
  }
  const next = current + delta;
  if (next < 0 || next >= list.length) return false; // let the caller decide (e.g. exit)
  list[next].focus({ preventScroll: true });
  return true;
}

/** Leave the control layer and hand the remote back to slideshow navigation. */
function exitControlFocus(): void {
  (document.activeElement as HTMLElement | null)?.blur?.();
  scheduleControlIdle();
}

function isDisplayRemoteKey(key: string): boolean {
  return [
    'ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp',
    'PageDown', 'MediaTrackNext', 'n', 'N',
    'PageUp', 'MediaTrackPrevious', 'p', 'P',
    '+', '=', 'Add', '-', '_', 'Subtract', '0',
    'Enter', ' ', 'Spacebar', 'MediaPlayPause', 'MediaPlay', 'MediaPause',
    'Escape', 'Backspace', 'BrowserBack', 'GoBack',
  ].includes(key);
}

function setControlsOpen(open: boolean, revealController = true): void {
  if (!controlsToggle || !publicControls) return;
  publicControls.hidden = !open;
  controlsToggle.setAttribute('aria-expanded', String(open));
  controlsToggle.setAttribute('aria-label', open ? 'Close slideshow controls' : 'Open slideshow controls');
  controlsToggle.textContent = open ? '✕' : '•••';
  if (revealController) registerPublicControlActivity();
}

function publicConfigPatch(key: string | undefined, rawValue: string): Partial<FrameConfig> | null {
  if (!key) return null;
  const publicKey = key as PublicConfigKey;
  if (NUMERIC_PUBLIC_CONFIG_KEYS.has(publicKey)) {
    const divisor = publicKey === 'zoom' || publicKey === 'panX' || publicKey === 'panY' ? 100 : 1;
    const parsed = Number(rawValue) / divisor;
    return Number.isFinite(parsed) ? { [publicKey]: parsed } : null;
  }
  if (BOOLEAN_PUBLIC_CONFIG_KEYS.has(publicKey)) {
    if (rawValue !== 'true' && rawValue !== 'false') return null;
    return { [publicKey]: rawValue === 'true' };
  }
  if (['fillMode', 'frameAspect', 'transition', 'motion', 'playbackMediaMode'].includes(publicKey)) {
    return { [publicKey]: rawValue };
  }
  return null;
}

function sharedSettingsConfigPatch(patch: SettingsPatch): Partial<FrameConfig> | null {
  const nextPatch: Partial<FrameConfig> = {};

  for (const [key, value] of Object.entries(patch)) {
    const publicKey = key as PublicConfigKey;
    if (NUMERIC_PUBLIC_CONFIG_KEYS.has(publicKey)) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return null;
      Object.assign(nextPatch, { [publicKey]: parsed });
    } else if (BOOLEAN_PUBLIC_CONFIG_KEYS.has(publicKey)) {
      if (typeof value === 'boolean') {
        Object.assign(nextPatch, { [publicKey]: value });
      } else if (value === 'true' || value === 'false') {
        Object.assign(nextPatch, { [publicKey]: value === 'true' });
      } else {
        return null;
      }
    } else if (['fillMode', 'frameAspect', 'transition', 'motion', 'playbackMediaMode'].includes(publicKey)) {
      Object.assign(nextPatch, { [publicKey]: String(value) });
    }
  }

  return Object.keys(nextPatch).length ? nextPatch : null;
}

function renderPublicSettings(): void {
  if (!publicSettingsRoot) return;

  const openPanels = new Map<string, boolean>();
  publicSettingsRoot.querySelectorAll<HTMLElement>('.panel[data-panel-id]').forEach((panel) => {
    const id = panel.dataset.panelId;
    if (id) openPanels.set(id, panel.dataset.collapsed !== 'true');
  });

  renderSharedSettings(publicSettingsRoot, {
    getConfig: () => config,
    updateConfig: (patch: SettingsPatch) => {
      const normalizedPatch = sharedSettingsConfigPatch(patch);
      if (normalizedPatch) adjustConfig(normalizedPatch);
    },
  }, {
    isPanelOpen: (id: string) => openPanels.get(id) ?? true,
  });

  publicSettingsRoot.querySelectorAll<HTMLButtonElement>('.panel-toggle').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const panel = toggle.closest<HTMLElement>('.panel');
      const body = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
      if (!panel || !body) return;
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      panel.dataset.collapsed = open ? 'false' : 'true';
      toggle.setAttribute('aria-expanded', String(open));
      body.toggleAttribute('aria-hidden', !open);
      body.toggleAttribute('inert', !open);
    });
  });
}

function setZoomPanSectionOpen(open: boolean, persist = true): void {
  if (!zoomPanSection || !zoomPanToggle) return;
  const body = document.getElementById(zoomPanToggle.getAttribute('aria-controls') ?? '') as HTMLElement | null;
  zoomPanSection.dataset.collapsed = open ? 'false' : 'true';
  zoomPanToggle.setAttribute('aria-expanded', String(open));
  if (body) {
    body.hidden = !open;
    body.toggleAttribute('aria-hidden', !open);
    body.toggleAttribute('inert', !open);
  }
  if (persist) window.localStorage.setItem(ZOOM_PAN_COLLAPSE_STORAGE_KEY, open ? 'true' : 'false');
}

function wireZoomPanSection(): void {
  if (!zoomPanToggle) return;
  const storedOpen = window.localStorage.getItem(ZOOM_PAN_COLLAPSE_STORAGE_KEY);
  if (storedOpen === 'true' || storedOpen === 'false') setZoomPanSectionOpen(storedOpen === 'true', false);
  zoomPanToggle.addEventListener('click', () => {
    registerPublicControlActivity();
    setZoomPanSectionOpen(zoomPanToggle.getAttribute('aria-expanded') !== 'true');
  });
}

function applyQuickAction(action: QuickAction): void {
  switch (action) {
    case 'fill-cover': {
      const patch = publicConfigPatch('fillMode', 'cover');
      if (patch) adjustConfig(patch);
      break;
    }
    case 'fill-contain': {
      const patch = publicConfigPatch('fillMode', 'contain');
      if (patch) adjustConfig(patch);
      break;
    }
    case 'smart-crop':
      adjustConfig({ fillMode: 'cover', smartFraming: true, zoom: MIN_ZOOM, panX: 0, panY: 0 });
      break;
    case 'zoom-in':
      setZoom(config.zoom + ZOOM_STEP);
      break;
    case 'zoom-out':
      setZoom(config.zoom - ZOOM_STEP);
      break;
    case 'reset-view':
      resetZoomPan();
      break;
    case 'pan-up':
      setPan(config.panX, config.panY - PAN_STEP);
      break;
    case 'pan-down':
      setPan(config.panX, config.panY + PAN_STEP);
      break;
    case 'pan-left':
      setPan(config.panX - PAN_STEP, config.panY);
      break;
    case 'pan-right':
      setPan(config.panX + PAN_STEP, config.panY);
      break;
  }
}

function quickActionDisabled(action: QuickAction, configControlsReady: boolean): boolean {
  if (!configControlsReady) return true;
  switch (action) {
    case 'zoom-in':
      return config.zoom >= MAX_ZOOM - 0.001;
    case 'zoom-out':
      return config.zoom <= MIN_ZOOM + 0.001;
    case 'reset-view':
      return config.zoom <= MIN_ZOOM + 0.001 && Math.abs(config.panX) <= 0.001 && Math.abs(config.panY) <= 0.001;
    case 'pan-up':
      return config.panY <= -1 + 0.001;
    case 'pan-down':
      return config.panY >= 1 - 0.001;
    case 'pan-left':
      return config.panX <= -1 + 0.001;
    case 'pan-right':
      return config.panX >= 1 - 0.001;
    default:
      return false;
  }
}

function quickActionSelected(action: QuickAction): boolean {
  switch (action) {
    case 'fill-cover':
      return config.fillMode === 'cover';
    case 'fill-contain':
      return config.fillMode === 'contain';
    case 'smart-crop':
      return config.fillMode === 'cover' && config.smartFraming;
    default:
      return false;
  }
}

function isQuickActionToggle(action: QuickAction): boolean {
  return action === 'fill-cover' || action === 'fill-contain' || action === 'smart-crop';
}

function quickActionButtons(root: ParentNode): NodeListOf<HTMLButtonElement> {
  return root.querySelectorAll<HTMLButtonElement>('button[data-quick-action]');
}

function syncQuickActions(root: ParentNode): void {
  quickActionButtons(root).forEach((button) => {
    const action = button.dataset.quickAction;
    if (!isQuickAction(action)) return;
    const selected = quickActionSelected(action);
    button.classList.toggle('is-selected', selected);
    if (isQuickActionToggle(action)) button.setAttribute('aria-pressed', String(selected));
  });
}

function wireQuickActions(root: ParentNode): void {
  quickActionButtons(root).forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset.quickAction;
      if (isQuickAction(action)) applyQuickAction(action);
    });
  });
}

function updateQuickActionDisabledStates(root: ParentNode, configControlsReady: boolean): void {
  quickActionButtons(root).forEach((button) => {
    const action = button.dataset.quickAction;
    button.disabled = isQuickAction(action) ? quickActionDisabled(action, configControlsReady) : !configControlsReady;
  });
}


function formatVideoTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const rounded = Math.floor(safe);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function syncPublicVideoTimeline(): void {
  const duration = Number(video.duration);
  const active = showingVideo
    && lastVideoItem !== null
    && video.readyState >= 1
    && Number.isFinite(duration)
    && duration > 0;

  publicVideoTimeline?.classList.toggle('hidden', !active);
  if (!active || !publicVideoSeek) return;

  const current = Math.min(duration, Math.max(0, Number.isFinite(video.currentTime) ? video.currentTime : 0));
  if (!publicTimelineScrubbing) publicVideoSeek.value = String(Math.round((current / duration) * 1000));
  const previewCurrent = publicTimelineScrubbing
    ? (Number(publicVideoSeek.value) / 1000) * duration
    : current;

  if (publicVideoCurrent) publicVideoCurrent.textContent = formatVideoTime(previewCurrent);
  if (publicVideoDuration) publicVideoDuration.textContent = formatVideoTime(duration);
  publicVideoSeek.setAttribute(
    'aria-valuetext',
    `${formatVideoTime(previewCurrent)} of ${formatVideoTime(duration)}`,
  );
}

function syncPublicControls(): void {
  const videoSeekMode = showingVideo
    && video.readyState >= 1
    && Number.isFinite(video.duration)
    && video.duration > 0;

  publicControlsRoot?.querySelectorAll<HTMLButtonElement>('[data-control="previous"], #control-previous').forEach((button) => {
    button.textContent = videoSeekMode ? `↶${VIDEO_SEEK_SECONDS}` : '‹';
    button.setAttribute('data-label', videoSeekMode ? `Back ${VIDEO_SEEK_SECONDS}s` : 'Previous');
    button.setAttribute('aria-label', videoSeekMode ? `Seek backward ${VIDEO_SEEK_SECONDS} seconds` : 'Previous item');
  });
  publicControlsRoot?.querySelectorAll<HTMLButtonElement>('[data-control="next"], #control-next').forEach((button) => {
    button.textContent = videoSeekMode ? `${VIDEO_SEEK_SECONDS}↷` : '›';
    button.setAttribute('data-label', videoSeekMode ? `Forward ${VIDEO_SEEK_SECONDS}s` : 'Next');
    button.setAttribute('aria-label', videoSeekMode ? `Seek forward ${VIDEO_SEEK_SECONDS} seconds` : 'Next item');
  });
  publicControlsRoot?.querySelectorAll<HTMLButtonElement>('[data-control="play-pause"], #control-pause').forEach((button) => {
    button.textContent = paused ? '▶' : '⏸';
    button.setAttribute('aria-label', paused ? 'Resume slideshow' : 'Pause slideshow');
    button.setAttribute('aria-pressed', String(paused));
  });

  // The shared settings panel renders its own controls and wires them via
  // wireSharedSettings(); it emits `data-range-key`, never `data-config-key`, so there is
  // nothing here to sync by hand. Values re-sync when renderPublicSettings() re-renders.
  syncPublicVideoTimeline();
  if (publicControls) syncQuickActions(publicControls);
}

function wirePublicControls(): void {
  if (!publicControlsRoot) return;

  controlsToggle?.addEventListener('click', () => {
    setControlsOpen(publicControls?.hidden ?? true);
  });
  wireZoomPanSection();

  publicControlsRoot.querySelectorAll<HTMLButtonElement>('[data-control="previous"], #control-previous').forEach((button) => {
    button.addEventListener('click', () => {
      registerPublicControlActivity();
      navigateContext(-1);
    });
  });
  publicControlsRoot.querySelectorAll<HTMLButtonElement>('[data-control="next"], #control-next').forEach((button) => {
    button.addEventListener('click', () => {
      registerPublicControlActivity();
      navigateContext(1);
    });
  });
  publicControlsRoot.querySelectorAll<HTMLButtonElement>('[data-control="play-pause"], #control-pause').forEach((button) => {
    button.addEventListener('click', () => {
      registerPublicControlActivity();
      togglePause();
    });
  });

  if (publicControls) {
    wireQuickActions(publicControls);
  }

  publicVideoSeek?.addEventListener('input', () => {
    publicTimelineScrubbing = true;
    registerPublicControlActivity();
    syncPublicVideoTimeline();
  });
  publicVideoSeek?.addEventListener('change', () => {
    const duration = Number(video.duration);
    if (showingVideo && Number.isFinite(duration) && duration > 0) {
      const desired = (Number(publicVideoSeek.value) / 1000) * duration;
      video.currentTime = Math.min(duration, Math.max(0, desired));
      reportVideoPlayback(true);
    }
    publicTimelineScrubbing = false;
    syncPublicVideoTimeline();
  });
  publicVideoSeek?.addEventListener('pointercancel', () => {
    publicTimelineScrubbing = false;
    syncPublicVideoTimeline();
  });
  for (const eventName of ['loadedmetadata', 'durationchange', 'timeupdate', 'seeking', 'seeked', 'ended'] as const) {
    video.addEventListener(eventName, syncPublicVideoTimeline);
  }

  // Selects/ranges/groups inside the shared settings panel are wired by
  // wireSharedSettings() (called from renderSharedSettings), so they need no wiring here.

  window.addEventListener('pointermove', registerPublicControlActivity, { passive: true });
  window.addEventListener('pointerdown', registerPublicControlActivity, { passive: true });
  window.addEventListener('touchstart', registerPublicControlActivity, { passive: true });
  window.addEventListener('focusin', (e) => {
    if (isPublicControlTarget(e.target)) registerPublicControlActivity();
  });
  window.addEventListener('focusout', (e) => {
    if (isPublicControlTarget(e.target)) scheduleControlIdle();
  });

  window.addEventListener('keydown', (e) => {
    if (isDisplayRemoteKey(e.key)) registerPublicControlActivity();
    if (e.key === 'Escape' && publicControls && !publicControls.hidden) {
      setControlsOpen(false);
      controlsToggle?.focus({ preventScroll: true });
      e.preventDefault();
      e.stopPropagation();
    }
  }, { capture: true });

  setControlsOpen(false, false);
  syncPublicControls();
}

function wireRemote(): void {
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    const inControls = Boolean(target?.closest('#public-settings')) || isPublicControlTarget(target);

    // --- Focus is on a control: arrows rove between controls, Back/Up leaves. ---
    if (inControls) {
      switch (e.key) {
        case 'ArrowRight': case 'ArrowDown':
          if (moveControlFocus(1)) e.preventDefault();
          registerPublicControlActivity();
          return;
        case 'ArrowLeft':
          if (moveControlFocus(-1)) e.preventDefault();
          registerPublicControlActivity();
          return;
        case 'ArrowUp':
          // At the top of the list, Up returns to the slideshow rather than trapping.
          if (!moveControlFocus(-1)) exitControlFocus();
          e.preventDefault();
          return;
        case 'Escape': case 'Backspace': case 'BrowserBack': case 'GoBack':
          // Chromecast's Back would otherwise exit the whole app.
          exitControlFocus();
          if (publicControls && !publicControls.hidden) setControlsOpen(false);
          e.preventDefault();
          return;
        default:
          return; // Enter/Space etc. fall through to native activation
      }
    }

    const zoomed = config.zoom > 1.01;
    switch (e.key) {
      case 'ArrowRight':
        if (zoomed) setPan(config.panX + PAN_STEP, config.panY);
        else navigateContext(1);
        break;
      case 'ArrowLeft':
        if (zoomed) setPan(config.panX - PAN_STEP, config.panY);
        else navigateContext(-1);
        break;
      case 'ArrowDown':
        // When zoomed, Down pans. Otherwise it enters the on-screen controls — the usual
        // TV convention, and nothing is lost because Left/Right already do prev/next.
        if (zoomed) setPan(config.panX, config.panY + PAN_STEP);
        else { registerPublicControlActivity(); moveControlFocus(1); }
        break;
      case 'ArrowUp':
        if (zoomed) setPan(config.panX, config.panY - PAN_STEP);
        else goPrevious();
        break;
      case 'Backspace': case 'BrowserBack': case 'GoBack':
        if (publicControls && !publicControls.hidden) {
          setControlsOpen(false);
          registerPublicControlActivity();
          e.preventDefault();
        }
        return;
      case 'PageDown': case 'MediaTrackNext': case 'n': case 'N':
        goNext();
        break;
      case 'PageUp': case 'MediaTrackPrevious': case 'p': case 'P':
        goPrevious();
        break;
      case '+': case '=': case 'Add':
        setZoom(config.zoom + ZOOM_STEP);
        break;
      case '-': case '_': case 'Subtract': {
        setZoom(config.zoom - ZOOM_STEP);
        break;
      }
      case '0':
        resetZoomPan();
        break;
      case 'Enter': case ' ': case 'Spacebar':
      case 'MediaPlayPause': case 'MediaPlay': case 'MediaPause':
        togglePause();
        break;
      default:
        return;
    }
    registerPublicControlActivity();
    e.preventDefault();
  });
}

function setPublicControlDisabled(selector: string, disabled: boolean): void {
  publicControlsRoot?.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(selector).forEach((control) => {
    control.disabled = disabled;
  });
}

function updateControlStates(): void {
  const connected = socket?.readyState === WebSocket.OPEN;
  const configControlsReady = connected && receivedConfigEvent;
  const pauseControlReady = connected && receivedPausedEvent;

  setPublicControlDisabled('[data-control="previous"], [data-control="next"], #control-previous, #control-next', !connected);
  setPublicControlDisabled('[data-control="play-pause"], #control-pause', !pauseControlReady);
  setPublicControlDisabled('#public-settings button, #public-settings input, #public-settings select', !configControlsReady);
  if (publicControlsRoot) updateQuickActionDisabledStates(publicControlsRoot, configControlsReady);
  syncPublicControls();
}

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  socket = ws;
  const heartbeat = (): void => {
    if (socket === ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'displayHeartbeat' }));
      // Do not rely only on HTMLMediaElement timeupdate. Some TV browsers throttle it
      // during buffering/system overlays, which used to make the companion seek bar vanish.
      reportVideoPlayback(true);
    }
  };
  ws.onopen = () => {
    window.clearInterval(displayHeartbeatTimer);
    heartbeat();
    displayHeartbeatTimer = window.setInterval(heartbeat, DISPLAY_HEARTBEAT_MS);
    // Restore the real indicator rather than blanking it — setStatus('') used to wipe the
    // Paused/Loop badge on every reconnect.
    setStatus(statusText());
    updateControlStates();
  };
  ws.onmessage = (ev) => {
    try { handleEvent(JSON.parse(ev.data) as FrameEvent); } catch { /* ignore */ }
  };
  ws.onclose = () => {
    window.clearInterval(displayHeartbeatTimer);
    if (socket === ws) socket = null;
    setStatus('Reconnecting…');
    // Controls send over this socket, so leaving them enabled while it's down means
    // presses silently do nothing.
    updateControlStates();
    setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
}

// Recompose when the screen changes (cast handoff, rotation, window resize).
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    applyScreenTransform();
    rerender().catch((err) => console.error(err));
  }, 150);
});
window.addEventListener('orientationchange', () => {
  applyScreenTransform();
  rerender().catch((err) => console.error(err));
});
applyScreenTransform();
renderPublicSettings();
wirePublicControls();
updateControlStates();
wireRemote();
wireMediaGestures();
window.addEventListener('pointerdown', unlockTvAudioFromUserGesture, { capture: true, passive: true });
window.addEventListener('touchstart', unlockTvAudioFromUserGesture, { capture: true, passive: true });
window.addEventListener('keydown', unlockTvAudioFromUserGesture, { capture: true });
initCastReceiver(video, sendControl);
initVideoDiagnostics();
connect();
