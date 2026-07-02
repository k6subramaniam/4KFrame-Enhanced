export function wireControlSheet(elements, initialOpen = false) {
    const { toggle = null, close = null, sheet = null, backdrop = null, body = globalThis.document?.body ?? null, document: doc = globalThis.document ?? null, } = elements;
    let controlsOpen = initialOpen;
    const setOpen = (open) => {
        controlsOpen = open;
        sheet?.classList.toggle('open', open);
        sheet?.toggleAttribute('hidden', !open);
        sheet?.setAttribute('aria-hidden', String(!open));
        if (sheet)
            sheet.inert = !open;
        body?.classList.toggle('controls-open', open);
        toggle?.setAttribute('aria-expanded', String(open));
    };
    toggle?.addEventListener('click', () => {
        setOpen(!controlsOpen);
        if (!controlsOpen)
            return;
        close?.focus({ preventScroll: true });
    });
    close?.addEventListener('click', () => {
        setOpen(false);
        toggle?.focus({ preventScroll: true });
    });
    backdrop?.addEventListener('click', () => setOpen(false));
    doc?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && controlsOpen) {
            setOpen(false);
            toggle?.focus({ preventScroll: true });
        }
    });
    setOpen(controlsOpen);
    return {
        isOpen: () => controlsOpen,
        setOpen,
    };
}
//# sourceMappingURL=controlSheet.js.map