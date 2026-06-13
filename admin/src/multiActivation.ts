export interface MultiActivationOptions {
  delayMs?: number;
  setTimer?: typeof window.setTimeout;
  clearTimer?: typeof window.clearTimeout;
}

export function directionalPlaybackAction(
  activeKind: 'photo' | 'video' | undefined,
  offsetSec: number,
): { type: 'seek'; offsetSec: number } | { type: 'navigate' } {
  return activeKind === 'video' ? { type: 'seek', offsetSec } : { type: 'navigate' };
}

/** Delay a single activation so a second activation can replace it with one double action. */
export function createMultiActivationRecognizer(
  onSingle: () => void,
  onDouble: () => void,
  options: MultiActivationOptions = {},
): { activate: () => void; cancel: () => void } {
  const delayMs = options.delayMs ?? 250;
  const setTimer = options.setTimer ?? window.setTimeout.bind(window);
  const clearTimer = options.clearTimer ?? window.clearTimeout.bind(window);
  let timer: ReturnType<typeof window.setTimeout> | undefined;

  const cancel = (): void => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };

  return {
    activate: () => {
      if (timer !== undefined) {
        cancel();
        onDouble();
        return;
      }
      timer = setTimer(() => {
        timer = undefined;
        onSingle();
      }, delayMs);
    },
    cancel,
  };
}
