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
