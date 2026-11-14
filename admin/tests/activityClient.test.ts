import test from 'node:test';
import assert from 'node:assert/strict';
import { recordInteraction } from '../src/activityClient.js';

test('retry uses the same receipt and payload after a failed response', async (t) => {
  const bodies: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return bodies.length === 1 ? new Response('', {status:503}) : Response.json({updates:[]});
  });
  await recordInteraction(['a','a'], 'selection');
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(JSON.parse(bodies[0]).ids, ['a']);
});
test('large select-all operations are deduplicated and batched into distinct receipts', async (t) => {
  const payloads: {ids:string[];eventId:string}[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    payloads.push(JSON.parse(String(init.body))); return Response.json({updates:[]});
  });
  await recordInteraction(Array.from({length:1001},(_,i)=>String(i)), 'selection');
  assert.deepEqual(payloads.map(p=>p.ids.length), [500,500,1]);
  assert.equal(new Set(payloads.map(p=>p.eventId)).size, 3);
});
test('authentication errors are not retried or reported as a saved count', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', {status:401}); });
  await assert.rejects(()=>recordInteraction(['a'],'click'), /401/); assert.equal(calls, 1);
});
