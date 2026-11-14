import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { defaultConfig, type MediaItem } from '@4kframe/shared';
const dir=await mkdtemp(path.join(tmpdir(),'4kframe-favorites-'));
process.env.FRAME_DATA_DIR=dir;
delete process.env.FRAME_ADMIN_PASSWORD;
const [store,show,{registerApi},auth] = await Promise.all([import('./store.js'),import('./slideshow.js'),import('./routes/api.js'),import('./auth.js')]);
await store.initStore();
const app=Fastify({logger:false}); await registerApi(app); await app.ready();
after(async()=>{show.setPaused(true);await app.close();await rm(dir,{recursive:true,force:true});});
const media=(id:string, patch:Partial<MediaItem>={}):MediaItem=>({id,kind:'photo',file:`${id}.jpg`,preview:'',thumb:'',width:100,height:100,createdAt:1,source:'upload',...patch});
async function reset(values:MediaItem[]) {
  show.setPaused(true); show.clearQueue();
  await store.removeItems(store.listItems().map(i=>i.id));
  await store.setConfig({...defaultConfig(),photoPeriod:0,zoom:1.6,panX:.2,videoPlaybackRate:.5});
  for(const i of values) await store.addItem(i);
  show.startSlideshow();
}
const play=(order='ordered',media='both',sort='library')=>app.inject({method:'POST',url:'/api/favorites/play',payload:{order,media,sort}});
test('Play favorites persists mode, starts ordered media, and releases pause/hold/temporary queue',async()=>{
  await reset([media('late',{createdAt:5}),media('first',{createdAt:1}),media('no',{enabled:false}),media('clip',{kind:'video'})]);
  show.playSequence(['no']);show.setHold(true);
  const res=await play('ordered','photos','oldest');
  assert.equal(res.statusCode,200);assert.equal(res.json().count,2);
  assert.equal(show.getCurrent()[0]?.id,'first');assert.equal(show.isPaused(),false);assert.equal(show.isHolding(),false);assert.equal(show.getQueueState().active,false);
  assert.equal(store.getConfig().zoom,1.6);assert.equal(store.getConfig().panX,.2);assert.equal(store.getConfig().videoPlaybackRate,.5);
  assert.equal(store.getConfig().photoPeriod,15);
  show.setPaused(true); show.next(); assert.equal(show.getCurrent()[0]?.id,'late');show.next();assert.equal(show.getCurrent()[0]?.id,'first');
  await store.initStore();assert.equal(store.getConfig().favoritesSort,'oldest');assert.equal(store.getConfig().playbackMediaMode,'photos');
});
test('Shuffle excludes unstarred/processing media and previous retraces actual playback',async()=>{
  await reset([media('a'),media('b'),media('c'),media('no',{enabled:false}),media('busy',{kind:'video',upscaling:true})]);
  const response=await play('shuffle');assert.equal(response.statusCode,200);show.setPaused(true);
  const first=show.getCurrent()[0]!.id;show.next();const second=show.getCurrent()[0]!.id;show.next();const third=show.getCurrent()[0]!.id;
  assert.deepEqual([first,second,third].sort(),['a','b','c']);
  show.previous();assert.equal(show.getCurrent()[0]?.id,second);show.next();assert.equal(show.getCurrent()[0]?.id,third);
  show.next();assert.notEqual(show.getCurrent()[0]?.id,third);
  await store.initStore();assert.equal(store.getConfig().playbackOrder,'shuffle');
});
test('removing the active favorite advances; deleting every favorite empties playback',async()=>{
  await reset([media('a'),media('b')]);await play();show.setPaused(true);
  await store.setItemsEnabled(['a'],false);show.refresh();assert.equal(show.getCurrent()[0]?.id,'b');
  await store.setItemsEnabled(['b'],false);show.refresh();assert.deepEqual(show.getCurrent(),[]);
});
test('star and bulk save are idempotent and survive restart and recoverable deletion',async()=>{
  await reset([media('a',{enabled:false}),media('b',{enabled:false})]);
  for(let n=0;n<2;n++) { const res=await app.inject({method:'POST',url:'/api/items/enabled',payload:{ids:['a','b'],enabled:true}});assert.equal(res.statusCode,200); }
  await store.initStore();assert.equal(store.getItem('a')?.enabled,true);assert.equal(store.getItem('b')?.enabled,true);
  await store.trashItems(['a']);await store.restoreTrashItems(['a']);assert.equal(store.getItem('a')?.enabled,true);
});
test('invalid or empty favorites requests do not mutate preferences or stop the current media',async()=>{
  await reset([media('a')]);const prior=store.getConfig();const current=show.getCurrent()[0]?.id;
  assert.equal((await play('invalid')).statusCode,400);assert.equal((await play('shuffle','videos')).statusCode,409);
  assert.deepEqual(store.getConfig(),prior);assert.equal(show.getCurrent()[0]?.id,current);
  const bad=await app.inject({method:'POST',url:'/api/favorites/play',payload:[]});assert.equal(bad.statusCode,400);
});
test('favorites playback and mutations retain authentication',async()=>{
  process.env.FRAME_ADMIN_PASSWORD='local-test-only';
  try {
    assert.equal((await play()).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/items/enabled',payload:{ids:['a'],enabled:false}})).statusCode,401);
    const res=await app.inject({method:'POST',url:'/api/favorites/play',headers:{cookie:`frame_auth=${auth.issueToken()}`},payload:{order:'ordered',media:'photos',sort:'library'}});
    assert.equal(res.statusCode,200);show.setPaused(true);
  } finally {delete process.env.FRAME_ADMIN_PASSWORD;}
});
