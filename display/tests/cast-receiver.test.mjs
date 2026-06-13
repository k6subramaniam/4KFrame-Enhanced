import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const sourceUrl = new URL('../src/cast.ts', import.meta.url);
let source = await readFile(sourceUrl, 'utf8');
source = source.replace(
  "import { CAST_NAMESPACE, type ControlMessage } from '@4kframe/shared';",
  "const CAST_NAMESPACE = 'urn:x-cast:test';",
);
const { outputText: code } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});

test('starts CAF with the active page media element and HTML playback options', async () => {
  const starts = [];
  const listeners = [];
  const mediaElement = { tagName: 'VIDEO' };
  globalThis.window = {
    cast: {
      framework: {
        CastReceiverContext: {
          getInstance: () => ({
            addCustomMessageListener: (...args) => listeners.push(args),
            start: (options) => starts.push(options),
          }),
        },
      },
    },
  };

  const { initCastReceiver } = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  initCastReceiver(mediaElement, assert.fail);

  assert.equal(listeners.length, 1);
  assert.equal(listeners[0][0], 'urn:x-cast:test');
  assert.deepEqual(starts, [{
    mediaElement,
    skipPlayersLoad: true,
    statusText: 'Ready to display photos and videos',
  }]);
});
