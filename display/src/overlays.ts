/**
 * Overlays drawn on top of the slideshow: QR code (scan to manage), clock, and
 * the photo caption. Visibility is driven by the frame config.
 */

import type { FrameConfig, MediaItem } from '@4kframe/shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let clockTimer: number | undefined;

export function applyOverlays(config: FrameConfig): void {
  const qr = $('qr');
  const qrImg = qr.querySelector('img') as HTMLImageElement;
  if (config.showQr) {
    qrImg.src = '/api/qr';
    qr.classList.remove('hidden');
  } else {
    qr.classList.add('hidden');
  }

  const clock = $('clock');
  if (config.overlays?.clock) {
    clock.classList.remove('hidden');
    const tick = () => { clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
    tick();
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = window.setInterval(tick, 10_000);
  } else {
    clock.classList.add('hidden');
    if (clockTimer) { clearInterval(clockTimer); clockTimer = undefined; }
  }
}

export function setCaption(items: MediaItem[], config: FrameConfig): void {
  const caption = $('caption');
  const text = config.overlays?.caption ? items.map((i) => i.caption).filter(Boolean).join(' · ') : '';
  if (text) { caption.textContent = text; caption.classList.remove('hidden'); }
  else caption.classList.add('hidden');
}

export function setStatus(text: string): void {
  const status = $('status');
  if (!text) { status.classList.add('hidden'); return; }
  status.textContent = text;
  status.classList.remove('hidden');
}
