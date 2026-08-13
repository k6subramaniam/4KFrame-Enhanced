/**
 * Non-blocking feedback for the companion app.
 *
 * Replaces `alert()`/`confirm()`, which are a poor fit on a phone: they freeze the page,
 * and iOS offers a "don't show more alerts" escape hatch after which every subsequent
 * failure becomes silent. These render into an `aria-live` region instead, so messages are
 * announced without stealing focus.
 */

const AUTO_DISMISS_MS = 4500;

function host(): HTMLElement | null {
  return document.getElementById('toasts');
}

function dismiss(el: HTMLElement, timer?: ReturnType<typeof setTimeout>): void {
  clearTimeout(timer);
  el.remove();
}

/** Show a transient message. Errors persist a little longer and are visually distinct. */
export function toast(message: string, options: { error?: boolean } = {}): void {
  const root = host();
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast${options.error ? ' error' : ''}`;
  el.setAttribute('role', options.error ? 'alert' : 'status');

  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;
  el.appendChild(msg);

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Dismiss';
  close.setAttribute('aria-label', `Dismiss: ${message}`);
  el.appendChild(close);

  root.appendChild(el);
  const timer = setTimeout(() => dismiss(el), options.error ? AUTO_DISMISS_MS * 2 : AUTO_DISMISS_MS);
  close.addEventListener('click', () => dismiss(el, timer));
}

/**
 * Ask for confirmation inline instead of blocking on `confirm()`.
 * Resolves true if confirmed, false if cancelled or dismissed.
 */
export function confirmToast(
  message: string,
  options: { confirmLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  const root = host();
  if (!root) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-label', message);

    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = message;

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.textContent = options.confirmLabel ?? 'Confirm';
    if (options.danger) confirm.className = 'danger';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';

    el.append(msg, cancel, confirm);
    root.appendChild(el);

    // Return focus where the user was, so confirming doesn't strand keyboard users.
    const previous = document.activeElement as HTMLElement | null;
    const settle = (result: boolean): void => {
      el.remove();
      previous?.focus?.({ preventScroll: true });
      resolve(result);
    };

    confirm.addEventListener('click', () => settle(true));
    cancel.addEventListener('click', () => settle(false));
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); settle(false); }
    });
    cancel.focus({ preventScroll: true }); // safe default for a destructive prompt
  });
}
