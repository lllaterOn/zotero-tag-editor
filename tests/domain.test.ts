import assert from 'node:assert/strict';
import test from 'node:test';
import { addTag, removeTag, renameTag, cloneItems, signature, sameItems, changes, validateTagName, assertSameTargets } from '../src/domain/tags';
import type { ItemSnapshot } from '../src/types';

const sample = (): ItemSnapshot[] => [
  { id: 1, libraryID: 1, title: 'one', tags: [{ tag: 'A', type: 1 }, { tag: 'B', type: 0 }] },
  { id: 2, libraryID: 1, title: 'two', tags: [{ tag: 'B' }, { tag: 'C', type: 0 }] },
];

test('adding a shared tag fills only missing items and preserves existing types', () => {
  const base = sample();
  const draft = addTag(base, ' A ');
  assert.deepEqual(draft[0].tags, base[0].tags);
  assert.deepEqual(draft[1].tags.at(-1), { tag: 'A', type: 0 });
  assert.deepEqual(changes(base, draft), { itemCount: 1, added: 1, removed: 0, typeChanged: 0 });
  assert.equal(sameItems(draft, addTag(draft, 'A')), true);
  assert.equal(base[1].tags.length, 2);
});

test('removing a specified tag preserves each item’s unrelated labels', () => {
  const base = sample();
  const draft = removeTag(base, 'B');
  assert.deepEqual(draft.map(item => item.tags), [[{tag:'A',type:1}], [{tag:'C',type:0}]]);
  assert.deepEqual(changes(base, draft), {itemCount:2,added:0,removed:2,typeChanged:0});
});

test('rename is local to source holders and merges an existing destination', () => {
  const base = sample();
  const draft = renameTag(base, 'A', 'B');
  assert.deepEqual(draft[0].tags, [{tag:'B',type:0}]);
  assert.deepEqual(draft[1], base[1]);
  assert.equal(changes(base, draft).itemCount, 1);
});

test('a renamed automatic tag becomes manual; unrelated automatic tags survive', () => {
  const base = sample();
  base[0].tags.push({tag:'keep',type:1});
  const draft = renameTag(base, 'A', '新的标签');
  assert(draft[0].tags.some(t => t.tag === '新的标签' && t.type === 0));
  assert(draft[0].tags.some(t => t.tag === 'keep' && t.type === 1));
  assert.equal(draft[1].tags.some(t => t.tag === '新的标签'), false);
});

test('merging into automatic destination turns the intentional renamed result manual', () => {
  const base=sample();base[0].tags[1].type=1;
  const draft=renameTag(base,'A','B');
  assert.deepEqual(changes(base,draft),{itemCount:1,added:0,removed:1,typeChanged:1});
});

test('add then remove a new tag returns to the original semantic state', () => {
  const base=sample();
  assert(sameItems(base,removeTag(addTag(base,'D'),'D')));
  assert.deepEqual(changes(base,base),{itemCount:0,added:0,removed:0,typeChanged:0});
});

test('tag order and omitted manual type are equivalent, automatic type is not', () => {
  assert.equal(signature([{tag:'A'},{tag:'B',type:0}]),signature([{tag:'B'},{tag:'A',type:0}]));
  assert.notEqual(signature([{tag:'A'}]),signature([{tag:'A',type:1}]));
  const base=sample();
  assert(sameItems(base,base.slice().reverse()));
  const titled=cloneItems(base);titled[0].title='changed title';
  assert(sameItems(base,titled));
});

test('validation rejects blank/control text but preserves Unicode and punctuation', () => {
  for(const input of ['','  ','a\nb','a\u0000b'])assert.throws(()=>validateTagName(input));
  assert.equal(validateTagName(' 中文, #甲/乙 '),'中文, #甲/乙');
  assert.equal(validateTagName('__proto__'),'__proto__');
  assert.equal(validateTagName('e\u0301'),'é');
  assert.equal(validateTagName('甲'.repeat(255)).length,255);
  assert.throws(()=>validateTagName('甲'.repeat(256)),/255/);
  const draft=addTag(sample(),'__proto__');
  assert(draft.every(i=>i.tags.some(t=>t.tag==='__proto__')));
});

test('snapshots do not alias tag arrays or tag objects', () => {
  const base=sample();const draft=cloneItems(base);draft[0].tags[0].tag='changed';
  assert.equal(base[0].tags[0].tag,'A');
});

test('draft identity cannot change, duplicate or silently discard target items', () => {
  const base=sample();
  assert.throws(()=>assertSameTargets(base,base.slice(0,1)));
  assert.throws(()=>assertSameTargets(base,[base[0],base[0]]));
  const moved=cloneItems(base);moved[0].libraryID=2;
  assert.throws(()=>changes(base,moved));
  assert.equal(sameItems(base,moved),false);
});
