import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/cast.ts', import.meta.url), 'utf8');
const sharedStub = `
export const CAST_NAMESPACE = 'test';
export const isSeekOffsetSec = value => [-15, -5, 5, 15].includes(value);
`;
const code = ts.transpileModule(source.replace(
  "import { CAST_NAMESPACE, isSeekOffsetSec, type ControlMessage } from '@4kframe/shared';",
  sharedStub,
), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const { parseControl } = await import(`data:text/javascript,${encodeURIComponent(code)}`);

test('Cast parsing accepts supported seeks', () => {
  for (const offsetSec of [-15, -5, 5, 15]) {
    assert.deepEqual(parseControl({ type: 'seek', offsetSec }), { type: 'seek', offsetSec });
  }
});

test('Cast parsing rejects malformed seek payloads', () => {
  for (const offsetSec of [undefined, null, '5', 0, 20, NaN, Infinity]) {
    assert.equal(parseControl({ type: 'seek', offsetSec }), null);
  }
  assert.equal(parseControl('{bad json'), null);
});
