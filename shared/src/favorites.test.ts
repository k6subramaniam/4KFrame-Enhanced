import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, fromApiData, toApiData } from './config.js';
import { isFavorite, playableFavorites } from './favorites.js';
import type { MediaItem } from './api.js';
const item = (id: string, patch: Partial<MediaItem> = {}): MediaItem => ({ id, kind:'photo', width:100, height:100, file:`${id}.jpg`, preview:'',thumb:'',createdAt:1,source:'upload',...patch });

test('favorites preserve existing stars and legacy inclusion defaults', () => {
  assert.equal(isFavorite(item('old')), true);
  assert.equal(isFavorite(item('no', { enabled:false })), false);
  assert.equal(isFavorite(item('yes', { enabled:true })), true);
});
test('favorite playback includes only ready starred media of the chosen type', () => {
  const values = [item('p'),item('v',{kind:'video'}),item('off',{enabled:false}),item('busy',{kind:'video',transcoding:true}),item('up',{kind:'video',upscaling:true})];
  assert.deepEqual(playableFavorites(values).map(i=>i.id), ['p','v']);
  assert.deepEqual(playableFavorites(values,'photos').map(i=>i.id), ['p']);
  assert.deepEqual(playableFavorites(values,'videos').map(i=>i.id), ['v']);
});
test('in-order choices are stable and do not mutate the library', () => {
  const values = [item('a',{originalFilename:'Photo 10.jpg',createdAt:3}),item('c',{originalFilename:'Photo 2.jpg',createdAt:2}),item('b',{originalFilename:'Photo 1.jpg',createdAt:4,originalCreatedAt:1})];
  const ids = (sort: Parameters<typeof playableFavorites>[2])=>playableFavorites(values,'both',sort).map(i=>i.id);
  assert.deepEqual(ids('library'), ['a','c','b']);
  assert.deepEqual(ids('oldest'), ['b','c','a']);
  assert.deepEqual(ids('newest'), ['a','c','b']);
  assert.deepEqual(ids('filename'), ['b','c','a']);
  assert.deepEqual(values.map(i=>i.id), ['a','c','b']);
});
test('playback preferences default safely and round-trip with validation', () => {
  const base = defaultConfig();
  assert.equal(base.playbackOrder, 'ordered');
  const cfg = fromApiData(base, { playbackOrder:'shuffle', favoritesSort:'filename' });
  assert.equal(cfg.playbackOrder, 'shuffle'); assert.equal(cfg.favoritesSort,'filename');
  assert.deepEqual(fromApiData(base,toApiData(cfg)).playbackOrder, 'shuffle');
  const invalid = fromApiData(cfg, { playbackOrder:'random??', favoritesSort:'<script>' });
  assert.equal(invalid.playbackOrder,'shuffle'); assert.equal(invalid.favoritesSort,'filename');
});
