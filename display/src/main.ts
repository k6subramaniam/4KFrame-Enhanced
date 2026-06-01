/**
 * Display client entrypoint.
 *
 * Connects to the backend WebSocket, renders the slideshow with WebGL transitions for
 * photos and an HTML5 <video> element for videos, applies overlays, and acts as a
 * Chromecast receiver when applicable.
 */

import { defaultConfig, type FrameConfig, type FrameEvent, type MediaItem } from '@4kframe/shared';
import { GLRenderer } from './gl.js';
import { compose } from './compositor.js';
import { applyOverlays, setCaption, setStatus } from './overlays.js';
import { initCastReceiver } from './cast.js';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const video = document.getElementById('video') as HTMLVideoElement;
const renderer = new GLRenderer(canvas);

let config: FrameConfig = defaultConfig();
let prevFrame: HTMLCanvasElement | null = null;
let showingVideo = false;

async function renderItems(items: MediaItem[], interactive: boolean): Promise<void> {
  const videoItem = items.find((i) => i.kind === 'video');
  if (videoItem) {
    await renderVideo(videoItem);
    return;
  }

  // Photo(s): compose then transition with WebGL.
  if (showingVideo) hideVideo();
  const toFrame = await compose(items, {
    frameWidth: config.frameWidth,
    frameHeight: config.frameHeight,
    fill: config.frameFill,
  });
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
  video.classList.toggle('fill', config.frameFill);
  video.muted = config.videoMuted;
  video.loop = config.videoLoop;
  video.src = `/photos/${item.file}`;
  video.classList.add('visible');
  try { await video.play(); } catch { /* autoplay may require muted; already muted */ }
  setCaption([item], config);
}

function hideVideo(): void {
  showingVideo = false;
  video.classList.remove('visible');
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function handleEvent(event: FrameEvent): void {
  switch (event.type) {
    case 'config':
      config = event.config;
      applyOverlays(config);
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
  ws.onopen = () => setStatus('');
  ws.onmessage = (ev) => {
    try { handleEvent(JSON.parse(ev.data) as FrameEvent); } catch { /* ignore */ }
  };
  ws.onclose = () => {
    setStatus('Reconnecting…');
    setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
}

initCastReceiver();
connect();
