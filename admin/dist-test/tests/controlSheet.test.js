import assert from 'node:assert/strict';
import test from 'node:test';
import { wireControlSheet } from '../src/controlSheet.js';
class FakeClassList {
    classes = new Set();
    contains(name) { return this.classes.has(name); }
    toggle(name, force) {
        const shouldHave = force ?? !this.classes.has(name);
        if (shouldHave)
            this.classes.add(name);
        else
            this.classes.delete(name);
        return shouldHave;
    }
}
class FakeElement extends EventTarget {
    classList = new FakeClassList();
    attributes = new Map();
    hidden = false;
    inert = false;
    focusCount = 0;
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    toggleAttribute(name, force) {
        const shouldHave = force ?? !this.attributes.has(name);
        if (shouldHave) {
            this.attributes.set(name, '');
            if (name === 'hidden')
                this.hidden = true;
        }
        else {
            this.attributes.delete(name);
            if (name === 'hidden')
                this.hidden = false;
        }
        return shouldHave;
    }
    focus() { this.focusCount += 1; }
}
function keydown(key) {
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
        toggle: toggle,
        close: close,
        sheet: sheet,
        backdrop: backdrop,
        body: body,
        document: doc,
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
        toggle: toggle,
        close: close,
        sheet: sheet,
        backdrop: backdrop,
        body: body,
        document: doc,
    });
    toggle.dispatchEvent(new Event('click'));
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
    assert.equal(toggle.focusCount, 2);
});
//# sourceMappingURL=controlSheet.test.js.map