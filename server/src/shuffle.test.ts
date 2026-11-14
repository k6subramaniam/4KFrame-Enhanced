import test from 'node:test';
import assert from 'node:assert/strict';
import { ShuffleRotation } from './shuffle.js';
function seeded() { let state=7; return () => ((state=(state*1664525+1013904223)>>>0)/2**32); }
test('shuffle visits every item once per cycle without immediate boundary repeats', () => {
  const bag = new ShuffleRotation(seeded()), ids=['a','b','c','d','e'];
  let current: string | undefined;
  for(let cycle=0;cycle<30;cycle++) {
    const seen = new Set<string>();
    for(let i=0;i<ids.length;i++) {
      const next=bag.step(ids,current,1)!;
      assert.notEqual(next,current); assert.equal(seen.has(next),false); seen.add(next); current=next;
    }
    assert.equal(seen.size,ids.length);
  }
});
test('Previous and Next retrace actual shuffle history, including cycle boundaries', () => {
  const bag=new ShuffleRotation(seeded()), ids=['a','b','c'];
  let current: string | undefined;
  const history = Array.from({length:5},()=>current=bag.step(ids,current,1));
  current=bag.step(ids,current,-1); assert.equal(current,history[3]);
  current=bag.step(ids,current,-1); assert.equal(current,history[2]);
  current=bag.step(ids,current,1); assert.equal(current,history[3]);
  current=bag.step(ids,current,1); assert.equal(current,history[4]);
});
test('removed favorites disappear and new favorites join the remaining bag', () => {
  const bag=new ShuffleRotation(seeded());
  let current=bag.step(['a','b','c'],undefined,1);
  const seen = new Set<string>();
  for(let n=0;n<8;n++) { current=bag.step(['b','d'],current,1); assert.ok(current==='b'||current==='d'); seen.add(current!); }
  assert.deepEqual([...seen].sort(),['b','d']);
});
test('zero and one favorite are safe and reset discards previous navigation', () => {
  const bag=new ShuffleRotation();
  assert.equal(bag.step([],undefined,1),undefined);
  assert.equal(bag.step(['a'],undefined,1),'a');
  assert.equal(bag.step(['a'],'a',1),'a');
  assert.equal(bag.step(['a'],'a',-1),'a');
  bag.reset(); assert.equal(bag.step(['z'],undefined,-1),'z');
});
