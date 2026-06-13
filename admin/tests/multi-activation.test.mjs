import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/multiActivation.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { createMultiActivationRecognizer, directionalPlaybackAction } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

function harness() {
  const pending = new Map();
  let id = 0;
  const actions = [];
  const recognizer = createMultiActivationRecognizer(
    () => actions.push('single'),
    () => actions.push('double'),
    {
      setTimer: (callback) => { const next = ++id; pending.set(next, callback); return next; },
      clearTimer: (timer) => pending.delete(timer),
    },
  );
  return { actions, recognizer, flush: () => { for (const callback of pending.values()) callback(); pending.clear(); } };
}

test('single activation runs once after the recognition window', () => {
  const h = harness();
  h.recognizer.activate();
  assert.deepEqual(h.actions, []);
  h.flush();
  assert.deepEqual(h.actions, ['single']);
});

test('double activation replaces both pending singles with one double action', () => {
  const h = harness();
  h.recognizer.activate();
  h.recognizer.activate();
  h.flush();
  assert.deepEqual(h.actions, ['double']);
});

test('directional controls seek videos but retain previous/next navigation for photos', () => {
  assert.deepEqual(directionalPlaybackAction('video', -5), { type: 'seek', offsetSec: -5 });
  assert.deepEqual(directionalPlaybackAction('video', 15), { type: 'seek', offsetSec: 15 });
  assert.deepEqual(directionalPlaybackAction('photo', -5), { type: 'navigate' });
  assert.deepEqual(directionalPlaybackAction(undefined, 5), { type: 'navigate' });
});
