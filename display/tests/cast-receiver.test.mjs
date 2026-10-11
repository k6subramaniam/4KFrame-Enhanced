import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const sourceUrl = new URL('../src/cast.ts', import.meta.url);
let source = await readFile(sourceUrl, 'utf8');
// Stub the shared imports (a data: module can't resolve workspace specifiers). The regex
// tolerates changes to the imported names so the replace can't silently no-op again.
source = source.replace(
  /import\s*\{[^}]*\}\s*from\s*'@4kframe\/shared';/,
  "const CAST_NAMESPACE = 'urn:x-cast:test'; " +
    'const isSeekOffsetSec = (v) => typeof v === "number" && [-15, -5, 5, 15].includes(v);',
);
if (source.includes('@4kframe/shared')) throw new Error('shared import stub did not apply');
const { outputText: code } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});

/**
 * Enough of a DOM for the receiver to run under node:test. The receiver now stabilizes the
 * page's video layer and routes sources through CAF, so it touches document, MutationObserver
 * and the media element — none of which this environment provides.
 */
function stubDom() {
  const style = () => {
    const props = new Map();
    return { setProperty: (k, v) => props.set(k, v), removeProperty: (k) => props.delete(k), props };
  };
  const el = (id) => ({ id, style: style(), classList: { contains: () => false, toggle: () => false }, appendChild: () => {} });
  const byId = new Map([['gl', el('gl')], ['video-bg', el('video-bg')]]);
  globalThis.document = {
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => ({ tag, style: style(), classList: { add: () => {}, toggle: () => false } }),
    head: { appendChild: (node) => byId.set(node.id, node) },
    body: { ...el('body'), classList: { contains: () => false, toggle: () => false }, appendChild: () => {} },
    documentElement: el('html'),
  };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
}

test('starts CAF with the active page media element and routes sources through the player manager', async () => {
  const starts = [];
  const listeners = [];
  const loads = [];
  const mediaElement = {
    tagName: 'VIDEO',
    paused: true,
    currentTime: 0,
    videoWidth: 0,
    classList: { contains: () => false },
    addEventListener: () => {},
    getAttribute: () => null,
    pause: () => {},
    play: () => Promise.resolve(),
  };
  stubDom();
  globalThis.window = {
    location: { href: 'https://frame.test/' },
    cast: {
      framework: {
        CastReceiverContext: {
          getInstance: () => ({
            addCustomMessageListener: (...args) => listeners.push(args),
            getPlayerManager: () => ({ load: (r) => { loads.push(r); return Promise.resolve(); } }),
            start: (options) => starts.push(options),
          }),
        },
        messages: {
          MediaInformation: class { },
          LoadRequestData: class { },
        },
      },
    },
  };

  const { initCastReceiver } = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  initCastReceiver(mediaElement, assert.fail);

  assert.equal(listeners.length, 1);
  assert.equal(listeners[0][0], 'urn:x-cast:test');
  // CAF's managed player must stay enabled: skipPlayersLoad was the old audio-over-black path.
  assert.deepEqual(starts, [{
    mediaElement,
    statusText: 'Ready to display photos and videos',
  }]);
  // No src yet, so nothing should have been handed to the player manager.
  assert.deepEqual(loads, []);
});
