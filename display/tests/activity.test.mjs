import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/activity.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { DisplayActivityTracker } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
test('acknowledged renders, reconnects, buffering and redraws cannot add another play', () => {
  const sent = []; const tracker = new DisplayActivityTracker(message => sent.push(message));
  tracker.begin('episode1'); tracker.rendered(['p'], 'stale'); assert.equal(sent.length, 0);
  tracker.rendered(['p'], 'episode1'); tracker.retry(); assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
  tracker.acknowledge('episode1', ['p']); tracker.rendered(['p'], 'episode1'); tracker.retry(); assert.equal(sent.length, 2);
  tracker.begin('episode1'); tracker.rendered(['p'], 'episode1'); assert.equal(sent.length, 2);
  tracker.begin('episode2'); tracker.rendered(['p'], 'episode2'); assert.equal(sent.length, 3);
});
test('new presentations discard unsent stale confirmations and old acknowledgements', () => {
  const sent = []; const tracker = new DisplayActivityTracker(message => sent.push(message));
  tracker.begin('old'); tracker.rendered(['x'], 'old'); tracker.begin('new');
  tracker.acknowledge('old', ['x']); tracker.retry(); assert.equal(sent.length, 1);
  tracker.rendered(['x'], 'new'); assert.equal(sent[1].presentationId, 'new');
});
