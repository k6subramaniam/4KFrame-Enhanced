import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const browserCandidates = [
  process.env.CHROME_BIN,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
].filter(Boolean);

const browser = browserCandidates.find((candidate) => existsSync(candidate));
const port = 4179;
const origin = `http://127.0.0.1:${port}`;

async function waitForServer(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('public quick actions apply exactly one step and reject unknown actions', { timeout: 30_000 }, async (t) => {
  if (!browser) {
    t.skip('Set CHROME_BIN or install Chromium to run the browser-level test.');
    return;
  }

  const vitePath = new URL('../../node_modules/vite/bin/vite.js', import.meta.url);
  const server = spawn(process.execPath, [vitePath.pathname, '--host', '127.0.0.1', '--port', String(port)], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
  });

  try {
    await waitForServer(`${origin}/tests/quick-actions.browser.html`);
    const result = await run(browser, [
      '--headless',
      '--disable-gpu-sandbox',
      '--no-sandbox',
      '--virtual-time-budget=3000',
      '--dump-dom',
      `${origin}/tests/quick-actions.browser.html`,
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /<title>PASS<\/title>/, result.stdout);
  } finally {
    server.kill('SIGTERM');
  }
});
