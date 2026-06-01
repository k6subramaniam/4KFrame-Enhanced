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

import { defaultConfig, type ControlMessage, type FrameConfig, type FrameEvent, type MediaItem } from '@4kframe/shared';
import { GLRenderer } from './gl.js';
import { compose, contentRect } from './compositor.js';
import { applyOverlays, setCaption, setStatus } from './overlays.js';
import { initCastReceiver } from './cast.js';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const video = document.getElementById('video') as HTMLVideoElement;
const videoBg = document.getElementById('video-bg') as HTMLElement;
const renderer = new GLRenderer(canvas);

let config: FrameConfig = defaultConfig();
let prevFrame: HTMLCanvasElement | null = null;
let socket: WebSocket | null = null;

// Current content, retained so we can recompose on screen resize / config change.
let lastItems: MediaItem[] | null = null;
let lastVideoItem: MediaItem | null = null;
let showingVideo = false;

/** Forward a control message to the backend (used to bridge Cast custom messages). */
function sendControl(msg: ControlMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

/** This display's render size in device pixels, capped to bound texture memory. */
function screenPixels(): { w: number; h: number } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = Math.round(window.innerWidth * dpr);
  let h = Math.round(window.innerHeight * dpr);
  const longest = Math.max(w, h);
  const maxEdge = 3840;
  if (longest > maxEdge) {
    const s = maxEdge / longest;
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

function composeCurrent(items: MediaItem[]): Promise<HTMLCanvasElement> {
  const { w, h } = screenPixels();
  return compose(items, { screenWidth: w, screenHeight: h, fillMode: config.fillMode, aspect: config.frameAspect });
}

async function renderItems(items: MediaItem[], interactive: boolean): Promise<void> {
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
}

async function renderVideo(item: MediaItem): Promise<void> {
  showingVideo = true;
  lastVideoItem = item;
  layoutVideo(item);
  video.muted = config.videoMuted;
  video.loop = config.videoLoop;
  video.src = `/photos/${item.file}`;
  video.classList.add('visible');
  try { await video.play(); } catch { /* autoplay may require muted; already muted */ }
  setCaption([item], config);
}

/** Position the <video> into the aspect content rect and set its backdrop. */
function layoutVideo(item: MediaItem): void {
  const r = contentRect(window.innerWidth, window.innerHeight, config.frameAspect);
  video.style.left = `${r.x}px`;
  video.style.top = `${r.y}px`;
  video.style.width = `${r.w}px`;
  video.style.height = `${r.h}px`;
  video.style.objectFit = config.fillMode === 'cover' ? 'cover' : 'contain';

  // Opaque backdrop hides the stale photo behind any bars; blurred poster in blur mode.
  videoBg.classList.add('visible');
  if (config.fillMode === 'blur' && item.poster) {
    videoBg.style.backgroundImage = `url(/photos/${item.poster})`;
  } else {
    videoBg.style.backgroundImage = 'none';
  }
}

function hideVideo(): void {
  showingVideo = false;
  lastVideoItem = null;
  video.classList.remove('visible');
  videoBg.classList.remove('visible');
  video.pause();
  video.removeAttribute('src');
  video.load();
}

/** Recompose the current content for a new screen size or fill/aspect change (no transition). */
async function rerender(): Promise<void> {
  if (showingVideo && lastVideoItem) {
    layoutVideo(lastVideoItem);
    return;
  }
  if (lastItems) {
    const frame = await composeCurrent(lastItems);
    renderer.show(frame);
    prevFrame = frame;
  }
}

function handleEvent(event: FrameEvent): void {
  switch (event.type) {
    case 'config':
      config = event.config;
      applyOverlays(config);
      rerender().catch((err) => console.error(err));
      break;
    case 'show':
      renderItems(event.items, event.interactive).catch((err) => console.error(err));
      break;
    case 'library':
      // No-op for the display; the server drives what is shown.
      break;
    case 'log':
      if (event.level === 'error') console.error(event.message);
      break;
  }
}

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => setStatus('');
  ws.onmessage = (ev) => {
    try { handleEvent(JSON.parse(ev.data) as FrameEvent); } catch { /* ignore */ }
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    setStatus('Reconnecting…');
    setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
}

// Recompose when the screen changes (cast handoff, rotation, window resize).
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => rerender().catch((err) => console.error(err)), 150);
});

initCastReceiver(sendControl);
connect();
