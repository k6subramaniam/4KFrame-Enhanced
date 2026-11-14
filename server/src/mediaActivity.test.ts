import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { getMediaActivity, type MediaItem } from '@4kframe/shared';

const directory = await mkdtemp(path.join(tmpdir(), '4kframe-activity-'));
process.env.FRAME_DATA_DIR = directory;
delete process.env.FRAME_ADMIN_PASSWORD;
const [store, slideshow, activity, { registerApi }, liveCast] = await Promise.all([
  import('./store.js'), import('./slideshow.js'), import('./mediaActivity.js'), import('./routes/api.js'), import('./liveCast.js'),
]);
await store.initStore();
await store.setConfig({ ...store.getConfig(), photoPeriod: 0 });
after(async () => { slideshow.setPaused(true); liveCast.stopLiveCast(); await rm(directory, { recursive: true, force: true }); });
const item = (id: string, kind: MediaItem['kind'] = 'photo'): MediaItem => ({
  id, kind, file: `${id}.jpg`, thumb: '', preview: '', width: 10, height: 10, createdAt: Date.now(), source: 'upload',
});

test('concurrent increments and retries are durable and count each event exactly once', async () => {
  await store.addItem(item('concurrent'));
  const events = Array.from({length: 20}, (_,i) => store.recordMediaInteraction(['concurrent'], 'click', `click-${i}`));
  events.push(store.recordMediaInteraction(['concurrent', 'concurrent'], 'click', 'click-0'));
  await Promise.all(events);
  assert.equal(getMediaActivity(store.getItem('concurrent')!).clickCount, 20);
  await store.initStore();
  assert.equal(getMediaActivity(store.getItem('concurrent')!).clickCount, 20);
  const duplicate = await store.recordMediaInteraction(['concurrent'], 'click', 'click-0');
  assert.ok(duplicate.ok && duplicate.duplicate);
  const conflict = await store.recordMediaInteraction(['concurrent'], 'selection', 'click-0');
  assert.deepEqual(conflict, { ok: false, error: 'conflict' });
  assert.equal(getMediaActivity(store.getItem('concurrent')!).selectionCount, 0);
  const persisted = JSON.parse(await readFile(path.join(directory, 'frame.json'), 'utf8'));
  assert.equal(persisted.items.find((i: MediaItem) => i.id === 'concurrent').activity.clickCount, 20);
});
test('missing IDs reject the whole interaction; select-all duplicates count once per item', async () => {
  await store.addItem(item('selected'));
  assert.deepEqual(await store.recordMediaInteraction(['selected', 'missing'], 'selection', 'batch-missing'), { ok: false, error: 'missing' });
  assert.equal(getMediaActivity(store.getItem('selected')!).selectionCount, 0);
  await store.recordMediaInteraction(['selected','selected'], 'selection', 'batch-good');
  assert.equal(getMediaActivity(store.getItem('selected')!).selectionCount, 1);
});
test('only confirmed current appearances count; stale reports, loops and reconnects do not inflate views', async () => {
  await store.addItem(item('shown'));
  await store.addItem(item('video', 'video'));
  await slideshow.cast('shown');
  const receipt = slideshow.getCurrentPresentationId();
  assert.equal(getMediaActivity(store.getItem('shown')!).viewCount, 0, 'requesting playback is not a view');
  assert.equal(await activity.reportMediaPresented('shown','invalid'), false);
  await Promise.all([activity.reportMediaPresented('shown',receipt), activity.reportMediaPresented('shown',receipt)]);
  assert.equal(getMediaActivity(store.getItem('shown')!).viewCount, 1);
  await store.initStore();
  await activity.reportMediaPresented('shown',receipt);
  assert.equal(getMediaActivity(store.getItem('shown')!).viewCount, 1, 'receipt survives reload');
  await slideshow.cast('video');
  assert.equal(await activity.reportMediaPresented('shown',receipt), false);
  const videoReceipt = slideshow.getCurrentPresentationId();
  await activity.reportMediaPresented('video',videoReceipt);
  assert.equal(getMediaActivity(store.getItem('video')!).playCount, 1);
  assert.equal(getMediaActivity(store.getItem('video')!).viewCount, 0);
  await slideshow.cast('shown');
  liveCast.pushLiveCast({kind:'photo', mimeType:'image/jpeg', bytes:Buffer.from('test')});
  assert.equal(await activity.reportMediaPresented('shown',slideshow.getCurrentPresentationId()), false);
  liveCast.stopLiveCast();
  await activity.reportMediaPresented('shown',slideshow.getCurrentPresentationId());
  assert.equal(getMediaActivity(store.getItem('shown')!).viewCount, 2);
});
test('activity survives recoverable deletion and is included in a safe backup', async () => {
  await store.trashItems(['selected']);
  assert.equal(getMediaActivity(store.getTrashItem('selected')!).selectionCount, 1);
  assert.equal(store.createSafeBackup().trash.find(i => i.id === 'selected')?.activity?.selectionCount, 1);
  await store.restoreTrashItems(['selected']);
  assert.equal(getMediaActivity(store.getItem('selected')!).selectionCount, 1);
});
test('backend filtering is numeric, inclusive, before pagination and backwards-compatible', () => {
  const legacy = item('zero'), viewed = item('viewed');
  viewed.activity = {viewCount:12,playCount:0,clickCount:2,selectionCount:1};
  assert.equal(activity.queryMediaActivity([legacy,viewed], {}).items.length, 2);
  assert.deepEqual(activity.queryMediaActivity([legacy,viewed], {maxViews:'0'}).items.map(i=>i.id), ['zero']);
  const page = activity.queryMediaActivity([legacy,viewed], {sort:'views-desc',limit:'1'});
  assert.equal(page.total, 2); assert.equal(page.items[0].id, 'viewed');
  assert.throws(()=>activity.queryMediaActivity([legacy], {limit:'501'}), RangeError);
  assert.throws(()=>activity.queryMediaActivity([legacy], {minClicks:'-1'}), RangeError);
  assert.throws(()=>activity.queryMediaActivity([legacy], {minViews:'2',maxViews:'1'}), RangeError);
});
test('activity API validates input and retains admin authentication', async (t) => {
  const app = Fastify({logger:false}); await registerApi(app); await app.ready();
  t.after(()=>app.close());
  let response = await app.inject({method:'POST',url:'/api/media/activity',payload:{kind:'click',ids:['selected'],eventId:'api-event-1'}});
  assert.equal(response.statusCode, 200);
  response = await app.inject({method:'POST',url:'/api/media/activity',payload:{kind:'play',ids:['selected'],eventId:'api-event-2'}});
  assert.equal(response.statusCode, 400, 'client cannot fabricate playback counts');
  response = await app.inject({method:'GET',url:'/api/thumbs?maxViews=-1'});
  assert.equal(response.statusCode, 400);
  response = await app.inject({method:'GET',url:'/api/thumbs?maxViews=0&limit=1'});
  assert.equal(response.statusCode, 200); assert.equal(response.json().items.length, 1);
  process.env.FRAME_ADMIN_PASSWORD = 'test-only-password';
  try {
    response = await app.inject({method:'POST',url:'/api/media/activity',payload:{kind:'click',ids:['selected'],eventId:'unauth-event'}});
    assert.equal(response.statusCode, 401);
    response = await app.inject({method:'GET',url:'/api/media/activity'});
    assert.equal(response.statusCode, 401);
  } finally { delete process.env.FRAME_ADMIN_PASSWORD; }
});
