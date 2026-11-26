const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

type ControlSection = 'zoom' | 'video' | 'all';

export interface ControlSheetElements {
  toggle?: HTMLButtonElement | null;
  close?: HTMLButtonElement | null;
  sheet?: HTMLElement | null;
  backdrop?: HTMLElement | null;
  body?: HTMLElement | null;
  document?: Document | null;
}

export interface ControlSheetController {
  isOpen(): boolean;
  setOpen(open: boolean): void;
  isExpanded(): boolean;
  setExpanded(expanded: boolean): void;
}

/** Add navigation around the existing controls; never replace settings or media nodes. */
function installNavigation(doc: Document | null, sheet: HTMLElement | null) {
  if (!doc?.createElement || !sheet?.querySelector) return null;
  const header = sheet.querySelector<HTMLElement>('#control-sheet-header');
  if (!header) return null;
  const title = header.querySelector('h2');
  if (title) title.textContent = 'All controls';

  let resize = header.querySelector<HTMLButtonElement>('#controls-resize');
  if (!resize) {
    resize = doc.createElement('button');
    resize.id = 'controls-resize';
    resize.type = 'button';
    resize.setAttribute('aria-controls', sheet.id);
    header.insertBefore(resize, header.querySelector('#controls-close'));
  }
  let shortcuts = header.querySelector<HTMLElement>('#controls-shortcuts');
  if (!shortcuts) {
    shortcuts = doc.createElement('div');
    shortcuts.id = 'controls-shortcuts';
    shortcuts.setAttribute('role', 'group');
    shortcuts.setAttribute('aria-label', 'Jump to controls');
    for (const [section, label] of [
      ['zoom', 'Zoom & pan'], ['video', 'Video & audio'], ['all', 'All settings'],
    ] as const) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.dataset.controlSection = section;
      button.textContent = label;
      shortcuts.append(button);
    }
    header.append(shortcuts);
  }

  let launcher = doc.getElementById('controls-launcher') as HTMLButtonElement | null;
  const library = doc.getElementById('media-filter-panel');
  if (!launcher && library) {
    launcher = doc.createElement('button');
    launcher.id = 'controls-launcher';
    launcher.type = 'button';
    launcher.setAttribute('aria-controls', sheet.id);
    launcher.setAttribute('aria-expanded', 'false');
    launcher.innerHTML = '<span><strong>Zoom & all controls</strong><small>Expand for zoom, pan, rotation, speed, audio and settings</small></span><span aria-hidden="true">↗</span>';
    library.before(launcher);
  }
  return { resize, shortcuts, launcher };
}

/** Resolve targets on each click because settings may be refreshed while the sheet stays open. */
function revealSection(sheet: HTMLElement, section: ControlSection): void {
  sheet.classList.add('controls-jumping');
  const ids = section === 'zoom' ? ['scaling', 'zoom-pan'] : ['video-audio', 'video-speed', 'video-quality'];
  sheet.querySelectorAll<HTMLElement>('#settings [data-panel-id]').forEach((panel) => {
    if (section !== 'all' && !ids.includes(panel.dataset.panelId ?? '')) return;
    const toggle = panel.querySelector<HTMLButtonElement>('.panel-toggle');
    // Use the original toggle handler so accessibility and saved panel preferences stay in sync.
    if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
    if (section === 'zoom') {
      panel.querySelectorAll<HTMLDetailsElement>('.settings-fallback').forEach((details) => { details.open = true; });
    }
  });
  const target = section === 'zoom'
    ? sheet.querySelector<HTMLElement>('.crop-preview-frame')?.closest<HTMLElement>('.active-crop-preview')
      ?? sheet.querySelector<HTMLElement>('[data-panel-id="zoom-pan"]')
    : section === 'video'
      ? sheet.querySelector<HTMLElement>('[data-panel-id="video-audio"]')
      : sheet.querySelector<HTMLElement>('#settings');
  if (target) {
    const headerHeight = sheet.querySelector<HTMLElement>('#control-sheet-header')?.getBoundingClientRect().height ?? 0;
    // Scroll only the sheet, never the library behind it. Leave the sticky shortcuts visible.
    const top = sheet.scrollTop + target.getBoundingClientRect().top - sheet.getBoundingClientRect().top - headerHeight - 12;
    sheet.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    const focus = target.querySelector<HTMLElement>('.crop-preview-frame, .panel-toggle') ?? target;
    if (!focus.hasAttribute('tabindex') && focus.tagName !== 'BUTTON') focus.setAttribute('tabindex', '-1');
    focus.focus({ preventScroll: true });
  }
  sheet.ownerDocument.defaultView?.requestAnimationFrame(() => sheet.classList.remove('controls-jumping'));
}

export function wireControlSheet(elements: ControlSheetElements, initialOpen = false): ControlSheetController {
  const {
    toggle = null,
    close = null,
    sheet = null,
    backdrop = null,
    body = globalThis.document?.body ?? null,
    document: doc = globalThis.document ?? null,
  } = elements;
  const navigation = installNavigation(doc, sheet);
  let controlsOpen = initialOpen;
  let expanded = false;
  let opener: HTMLButtonElement | null = toggle;

  if (toggle) {
    toggle.textContent = 'Remote';
    toggle.setAttribute('aria-label', 'Open remote control');
    toggle.setAttribute('title', 'Open remote control');
  }

  const setExpanded = (value: boolean): void => {
    expanded = value;
    sheet?.classList.toggle('controls-expanded', value);
    if (!value && sheet) sheet.scrollTop = 0; // Return to the transport when collapsing.
    if (navigation) {
      const heading = sheet?.querySelector<HTMLElement>('#control-sheet-header h2');
      if (heading) heading.textContent = value ? 'All controls' : 'Remote control';
      navigation.resize.textContent = value ? 'Remote' : 'Settings';
      navigation.resize.setAttribute('aria-pressed', String(value));
      navigation.resize.setAttribute('aria-label', value ? 'Use compact controls panel' : 'Expand controls panel');
    }
  };

  const setOpen = (open: boolean): void => {
    controlsOpen = open;
    sheet?.classList.toggle('open', open);
    sheet?.toggleAttribute('hidden', !open);
    sheet?.setAttribute('aria-hidden', String(!open));
    if (sheet) sheet.inert = !open;
    body?.classList.toggle('controls-open', open);
    toggle?.setAttribute('aria-expanded', String(open));
    navigation?.launcher?.setAttribute('aria-expanded', String(open));
  };

  const dismiss = (): void => {
    setOpen(false);
    opener?.focus({ preventScroll: true });
  };

  toggle?.addEventListener('click', () => {
    opener = toggle;
    if (!controlsOpen) setExpanded(false);
    setOpen(!controlsOpen);
    if (controlsOpen) close?.focus({ preventScroll: true });
  });
  navigation?.launcher?.addEventListener('click', () => {
    opener = navigation.launcher;
    setExpanded(true);
    setOpen(true);
    if (sheet) revealSection(sheet, 'zoom');
  });
  navigation?.resize.addEventListener('click', () => setExpanded(!expanded));
  navigation?.shortcuts.querySelectorAll<HTMLButtonElement>('[data-control-section]').forEach((button) => {
    button.addEventListener('click', () => {
      // Compact mode deliberately hides the advanced panels. Expand before jumping.
      setExpanded(true);
      if (sheet) revealSection(sheet, button.dataset.controlSection as ControlSection);
    });
  });
  close?.addEventListener('click', dismiss);
  backdrop?.addEventListener('click', dismiss);
  doc?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && controlsOpen) {
      ev.preventDefault();
      dismiss();
      return;
    }
    // Do not allow Tab to reach the library or a collapsed settings section behind the dialog.
    if (ev.key !== 'Tab' || !controlsOpen || !sheet) return;
    const focusable = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null
        && !el.closest('[inert], [hidden], [aria-hidden="true"]'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = doc.activeElement;
    if (ev.shiftKey && (active === first || !sheet.contains(active))) {
      ev.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!ev.shiftKey && (active === last || !sheet.contains(active))) {
      ev.preventDefault();
      first.focus({ preventScroll: true });
    }
  });
  setExpanded(expanded);
  setOpen(controlsOpen);

  return { isOpen: () => controlsOpen, setOpen, isExpanded: () => expanded, setExpanded };
}
