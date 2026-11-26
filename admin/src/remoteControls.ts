import { cropPreviewControlPatch } from './cropPreview.js';

export interface RemoteFramingState { zoom: number; panX: number; panY: number }
type FramingInput = { zoom?: unknown; panX?: unknown; panY?: unknown };

export function normalizeRemoteFraming(config: FramingInput): RemoteFramingState {
  const bounded = (input: unknown, fallback: number, min: number, max: number): number => {
    const n = Number(input ?? fallback);
    return Math.round(Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback)) * 1000) / 1000;
  };
  return { zoom: bounded(config.zoom, 1, 1, 3), panX: bounded(config.panX, 0, -1, 1), panY: bounded(config.panY, 0, -1, 1) };
}

export function planPlayingJump(id: string | undefined, rendered: boolean, inLibrary: boolean): 'scroll' | 'focus-current' | 'missing' {
  return !id ? 'missing' : rendered ? 'scroll' : inLibrary ? 'focus-current' : 'missing';
}

/**
 * At most one acknowledged network write in flight and one latest target.
 * Rapid clicks compose against that target, not an older WebSocket echo.
 */
export function createRemoteFramingQueue(options: {
  read: () => FramingInput;
  commit: (state: RemoteFramingState) => Promise<void>;
  changed: () => void;
  failed: (error: unknown) => void;
}) {
  let desired: RemoteFramingState | undefined;
  let running = false;
  const state = () => desired ?? normalizeRemoteFraming(options.read());
  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (desired) {
        const target = desired;
        await options.commit(target);
        if (desired === target) desired = undefined;
        options.changed();
      }
    } catch (error) {
      desired = undefined;
      options.failed(error);
      options.changed();
    } finally {
      running = false;
    }
  }
  return {
    state,
    pending: () => desired !== undefined,
    activate(action: string): void {
      const previous = state();
      const patch = cropPreviewControlPatch(action, previous);
      if (!patch) return;
      const next = normalizeRemoteFraming({ ...previous, ...patch });
      if (action === 'zoom-out' && next.zoom === 1) { next.panX = 0; next.panY = 0; }
      if (next.zoom === previous.zoom && next.panX === previous.panX && next.panY === previous.panY) return;
      desired = next;
      options.changed();
      void drain();
    },
  };
}


export const REMOTE_HOLD_DELAY_MS = 350;
export const REMOTE_HOLD_INTERVAL_MS = 160;
type HoldSchedule = (task: () => void, delay: number) => () => void;

/** A tap keeps its normal click semantics; a held key repeats until release or cancellation. */
export function createRemoteHold(schedule: HoldSchedule = (task, delay) => {
  const timer = setTimeout(task, delay);
  return () => clearTimeout(timer);
}) {
  let active = false;
  let repeated = false;
  let cancelTimer: (() => void) | undefined;
  const end = (): boolean => {
    active = false;
    cancelTimer?.();
    cancelTimer = undefined;
    return repeated;
  };
  return {
    begin(step: () => boolean): void {
      end();
      active = true;
      repeated = false;
      const tick = () => {
        cancelTimer = undefined;
        if (!active) return;
        if (!step()) { end(); return; }
        repeated = true;
        if (active) cancelTimer = schedule(tick, REMOTE_HOLD_INTERVAL_MS);
      };
      cancelTimer = schedule(tick, REMOTE_HOLD_DELAY_MS);
    },
    end,
  };
}

/** Install one repeat controller for the whole remote. Keyboard and assistive clicks remain native. */
export function wireRemoteHoldKeys(
  root: ParentNode,
  available: () => boolean,
  activate: (button: HTMLButtonElement, feedback: boolean) => void,
): () => void {
  const hold = createRemoteHold();
  let held: HTMLButtonElement | null = null;
  let pointer = -1;
  let suppress: HTMLButtonElement | null = null;
  const stop = () => {
    if (!held) return;
    if (hold.end()) suppress = held;
    held.classList.remove('remote-held');
    held = null;
    pointer = -1;
  };
  root.querySelectorAll<HTMLButtonElement>('[data-remote-crop-action]').forEach((button) => {
    button.addEventListener('pointerdown', (event) => {
      if (button.disabled || !available() || event.button !== 0 || !event.isPrimary) return;
      stop();
      suppress = null;
      if (button.dataset.remoteCropAction === 'reset') return;
      held = button;
      pointer = event.pointerId;
      button.classList.add('remote-held');
      try { button.setPointerCapture(pointer); } catch { /* old TV/mobile engines */ }
      let first = true;
      hold.begin(() => {
        if (held !== button || button.disabled || !available()) { stop(); return false; }
        activate(button, first);
        first = false;
        return true;
      });
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      button.addEventListener(type, (event) => {
        if (held === button && event.pointerId === pointer) stop();
      });
    }
    button.addEventListener('click', (event) => {
      if (event.detail > 0 && suppress === button) { suppress = null; event.preventDefault(); return; }
      if (available() && !button.disabled) activate(button, true);
    });
    button.addEventListener('contextmenu', (event) => event.preventDefault());
  });
  return stop;
}
