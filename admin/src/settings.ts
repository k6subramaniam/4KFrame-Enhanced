/**
 * Settings panel: photo period, effects, scaling, QR, and Google Photos — mirroring
 * the original frame controls and adding the enhanced options.
 */

import { EFFECT_PRESETS, PHOTO_PERIOD_PRESETS, TRANSITIONS, type ApiDataPayload } from '@4kframe/shared';
import { updateData, googleStatus } from './api.js';

const PERIOD_LABELS: Record<number, string> = {
  0: 'Paused', 10: '10s', 15: '15s', 20: '20s', 40: '40s', 60: '60s', 300: '5 min',
};

function seg(name: string, options: { label: string; value: string; active: boolean }[]): string {
  return `<div class="row seg" data-group="${name}">${options
    .map((o) => `<button data-value="${o.value}" class="${o.active ? 'active' : ''}">${o.label}</button>`)
    .join('')}</div>`;
}

export async function renderSettings(root: HTMLElement, data: ApiDataPayload): Promise<void> {
  const period = Math.round(Number(data.photoPeriod ?? 15));
  const transPeriod = Number(data.transitionPeriod ?? 0.75);
  const fill = (data.frameFill ?? 'true') === 'true';
  const qr = (data.showQr ?? 'true') === 'true';
  const transition = data.transition ?? 'fade.glsl';
  const usedMB = Math.round(Number(data.storageUsed ?? 0) / 1e6);
  const freeMB = Math.round(Number(data.storageFree ?? 0) / 1e6);
  const total = usedMB + freeMB;
  const pct = total ? Math.round((usedMB / total) * 100) : 0;
  const gp = await googleStatus().catch(() => ({ configured: false, connected: false }));

  const effectValue = (() => {
    const entry = Object.entries(EFFECT_PRESETS).find(([, v]) => v === transPeriod);
    return entry?.[0] ?? 'custom';
  })();

  root.innerHTML = `
    <div class="panel">
      <h2>Photo Period</h2>
      ${seg('photoPeriod', PHOTO_PERIOD_PRESETS.map((p) => ({ label: PERIOD_LABELS[p] ?? `${p}s`, value: String(p), active: p === period })))}
    </div>
    <div class="panel">
      <h2>Effects</h2>
      ${seg('effect', Object.entries(EFFECT_PRESETS).map(([k, v]) => ({ label: k[0].toUpperCase() + k.slice(1), value: String(v), active: k === effectValue })))}
      <h2 style="margin-top:1rem">Transition</h2>
      ${seg('transition', TRANSITIONS.map((t) => ({ label: t.replace('.glsl', ''), value: t, active: t === transition })))}
    </div>
    <div class="panel">
      <h2>Scaling</h2>
      ${seg('frameFill', [
        { label: 'Fill Frame', value: 'true', active: fill },
        { label: 'Fit Frame', value: 'false', active: !fill },
      ])}
    </div>
    <div class="panel">
      <h2>QR Code</h2>
      ${seg('showQr', [
        { label: 'On', value: 'true', active: qr },
        { label: 'Off', value: 'false', active: !qr },
      ])}
    </div>
    <div class="panel">
      <h2>Storage</h2>
      <div class="muted">${pct}% used · ${usedMB} MB used · ${freeMB} MB free</div>
    </div>
    <div class="panel">
      <h2>Google Photos</h2>
      ${gp.connected
        ? '<div class="muted">Connected. Selected albums auto-sync to the frame.</div><div class="row"><button id="gsync">Sync now</button></div>'
        : gp.configured
          ? '<div class="row"><a href="/api/google/auth"><button>Connect Google Photos</button></a></div>'
          : '<div class="muted">Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the server to enable Google Photos import &amp; auto-sync.</div>'}
    </div>
  `;

  root.querySelectorAll<HTMLElement>('[data-group]').forEach((group) => {
    const key = group.dataset.group!;
    group.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const value = btn.dataset.value!;
        group.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const patch: Record<string, string> = key === 'effect' ? { transitionPeriod: value } : { [key]: value };
        await updateData(patch);
      });
    });
  });

  root.querySelector('#gsync')?.addEventListener('click', () => fetch('/api/google/sync', { method: 'POST' }));
}
