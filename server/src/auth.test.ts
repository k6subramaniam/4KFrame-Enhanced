import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  authRequired, passwordEnabled, googleLoginEnabled, isEmailAllowed, adminEmails,
  issueToken, verifyToken, issueStateToken, verifyStateToken,
  cookieFromHeader, setCookie, checkPassword,
} from './auth.js';

beforeEach(() => {
  delete process.env.FRAME_ADMIN_PASSWORD;
  delete process.env.FRAME_ADMIN_EMAILS;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.FRAME_AUTH_SECRET;
});

test('auth is disabled until a password or Google sign-in is configured', () => {
  assert.equal(authRequired(), false);

  process.env.FRAME_ADMIN_PASSWORD = 'hunter2';
  assert.equal(authRequired(), true);
  assert.equal(passwordEnabled(), true);
  assert.equal(googleLoginEnabled(), false);
  delete process.env.FRAME_ADMIN_PASSWORD;

  // Google sign-in needs credentials AND an allowlist.
  process.env.GOOGLE_CLIENT_ID = 'id';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  assert.equal(googleLoginEnabled(), false);
  process.env.FRAME_ADMIN_EMAILS = 'owner@example.com';
  assert.equal(googleLoginEnabled(), true);
  assert.equal(authRequired(), true);
  assert.equal(passwordEnabled(), false);
});

test('email allowlist is case-insensitive and comma-separated', () => {
  process.env.FRAME_ADMIN_EMAILS = ' Owner@Example.com, second@example.com ,';
  assert.deepEqual(adminEmails(), ['owner@example.com', 'second@example.com']);
  assert.equal(isEmailAllowed('OWNER@example.COM'), true);
  assert.equal(isEmailAllowed('second@example.com'), true);
  assert.equal(isEmailAllowed('intruder@example.com'), false);
});

test('session tokens round-trip and reject tampering', () => {
  process.env.FRAME_AUTH_SECRET = 'test-secret';
  const token = issueToken();
  assert.equal(verifyToken(token), true);
  assert.equal(verifyToken(token + 'x'), false);
  assert.equal(verifyToken(`1.${token.split('.')[1]}`), false); // expired
  assert.equal(verifyToken(undefined), false);

  const header = setCookie(token, false);
  assert.equal(cookieFromHeader(`foo=bar; ${header.split(';')[0]}`), token);
});

test('oauth state tokens verify and expire', () => {
  process.env.FRAME_AUTH_SECRET = 'test-secret';
  const state = issueStateToken();
  assert.equal(verifyStateToken(state), true);
  // Flip the last signature character to a *different* one. Appending a fixed '0' made
  // this flaky: when the hex signature already ended in '0' the "tampered" token was
  // identical to the original and verified correctly (~1 run in 16).
  const tampered = state.slice(0, -1) + (state.endsWith('0') ? '1' : '0');
  assert.notEqual(tampered, state);
  assert.equal(verifyStateToken(tampered), false);
  assert.equal(verifyStateToken(undefined), false);
});

test('checkPassword only accepts the configured password', () => {
  assert.equal(checkPassword('anything'), false); // no password configured
  process.env.FRAME_ADMIN_PASSWORD = 'hunter2';
  assert.equal(checkPassword('hunter2'), true);
  assert.equal(checkPassword('wrong'), false);
  assert.equal(checkPassword(42), false);
});
