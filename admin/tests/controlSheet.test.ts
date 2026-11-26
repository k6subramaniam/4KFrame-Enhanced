import assert from 'node:assert/strict';
import test from 'node:test';
import { wireControlSheet } from '../src/controlSheet.js';

class FakeClassList {
  private classes = new Set<string>();

  contains(name: string): boolean { return this.classes.has(name); }

  toggle(name: string, force?: boolean): boolean {
    const shouldHave = force ?? !this.classes.has(name);
    if (shouldHave) this.classes.add(name);
    else this.classes.delete(name);
    return shouldHave;
  }
}

class FakeElement extends EventTarget {
  readonly classList = new FakeClassList();
  readonly attributes = new Map<string, string>();
  hidden = false;
  inert = false;
  focusCount = 0;
  scrollTop = 0;

  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }

  toggleAttribute(name: string, force?: boolean): boolean {
    const shouldHave = force ?? !this.attributes.has(name);
    if (shouldHave) {
      this.attributes.set(name, '');
      if (name === 'hidden') this.hidden = true;
    } else {
      this.attributes.delete(name);
      if (name === 'hidden') this.hidden = false;
    }
    return shouldHave;
  }

  focus(): void { this.focusCount += 1; }
}

function keydown(key: string): Event {
  const ev = new Event('keydown');
  Object.defineProperty(ev, 'key', { value: key });
  return ev;
}

test('wireControlSheet initializes the controls sheet as inaccessible when collapsed', () => {
  const toggle = new FakeElement();
  const close = new FakeElement();
  const sheet = new FakeElement();
  const backdrop = new FakeElement();
  const body = new FakeElement();
  const doc = new EventTarget();

  const controller = wireControlSheet({
    toggle: toggle as unknown as HTMLButtonElement,
    close: close as unknown as HTMLButtonElement,
    sheet: sheet as unknown as HTMLElement,
    backdrop: backdrop as unknown as HTMLElement,
    body: body as unknown as HTMLElement,
    document: doc as Document,
  });

  assert.equal(controller.isOpen(), false);
  assert.equal(sheet.hidden, true);
  assert.equal(sheet.inert, true);
  assert.equal(sheet.getAttribute('aria-hidden'), 'true');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(sheet.classList.contains('open'), false);
  assert.equal(body.classList.contains('controls-open'), false);
});

test('wireControlSheet opens with the floating toggle and closes with close, backdrop, and Escape', () => {
  const toggle = new FakeElement();
  const close = new FakeElement();
  const sheet = new FakeElement();
  const backdrop = new FakeElement();
  const body = new FakeElement();
  const doc = new EventTarget();

  const controller = wireControlSheet({
    toggle: toggle as unknown as HTMLButtonElement,
    close: close as unknown as HTMLButtonElement,
    sheet: sheet as unknown as HTMLElement,
    backdrop: backdrop as unknown as HTMLElement,
    body: body as unknown as HTMLElement,
    document: doc as Document,
  });

  controller.setExpanded(true);
  toggle.dispatchEvent(new Event('click'));
  assert.equal(controller.isExpanded(), false, 'opening from the dock returns to the remote');
  assert.equal(controller.isOpen(), true);
  assert.equal(sheet.hidden, false);
  assert.equal(sheet.inert, false);
  assert.equal(sheet.getAttribute('aria-hidden'), 'false');
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(sheet.classList.contains('open'), true);
  assert.equal(body.classList.contains('controls-open'), true);
  assert.equal(close.focusCount, 1);

  close.dispatchEvent(new Event('click'));
  assert.equal(controller.isOpen(), false);
  assert.equal(sheet.hidden, true);
  assert.equal(sheet.inert, true);
  assert.equal(toggle.focusCount, 1);

  toggle.dispatchEvent(new Event('click'));
  backdrop.dispatchEvent(new Event('click'));
  assert.equal(controller.isOpen(), false);
  assert.equal(sheet.hidden, true);

  toggle.dispatchEvent(new Event('click'));
  doc.dispatchEvent(keydown('Escape'));
  assert.equal(controller.isOpen(), false);
  assert.equal(sheet.hidden, true);
  assert.equal(toggle.focusCount, 3);
});


test('expanded and compact sizes retain the open state and never reconstruct controls', () => {
  const sheet = new FakeElement();
  const body = new FakeElement();
  const controller = wireControlSheet({
    sheet: sheet as unknown as HTMLElement,
    body: body as unknown as HTMLElement,
    document: new EventTarget() as Document,
  }, true);
  assert.equal(controller.isOpen(), true);
  assert.equal(controller.isExpanded(), false, 'the remote is compact by default');
  assert.equal(sheet.classList.contains('controls-expanded'), false);
  controller.setExpanded(true);
  assert.equal(sheet.classList.contains('controls-expanded'), true);
  sheet.scrollTop = 250;
  controller.setExpanded(false);
  assert.equal(sheet.scrollTop, 0, 'collapsing restores the transport at the top');
  assert.equal(controller.isExpanded(), false);
  assert.equal(controller.isOpen(), true);
  assert.equal(sheet.inert, false);
  controller.setOpen(true); // A library refresh preserves the user's panel size.
  assert.equal(controller.isExpanded(), false);
  controller.setOpen(false);
  controller.setOpen(true);
  assert.equal(controller.isExpanded(), false);
  controller.setExpanded(true);
  assert.equal(sheet.classList.contains('controls-expanded'), true);
  assert.equal(body.classList.contains('controls-open'), true);
});
