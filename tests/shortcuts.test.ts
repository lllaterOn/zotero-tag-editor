import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeShortcut, matchesShortcut } from '../src/zotero';

test('shortcut matching requires exact modifiers and ignores composing input', () => {
  const event={key:'M',ctrlKey:true,altKey:false,shiftKey:true,metaKey:false,isComposing:false};
  assert(matchesShortcut(event,'Ctrl+Shift+M'));
  assert(matchesShortcut({...event,key:'m'},'Ctrl+Shift+M'));
  assert(!matchesShortcut({...event,altKey:true},'Ctrl+Shift+M'));
  assert(!matchesShortcut({...event,metaKey:true},'Ctrl+Shift+M'));
  assert(!matchesShortcut({...event,shiftKey:false},'Ctrl+Shift+M'));
  assert(!matchesShortcut({...event,isComposing:true},'Ctrl+Shift+M'));
});

test('custom shortcuts normalize supported keys and reject ambiguous input', () => {
  assert.equal(normalizeShortcut(' shift + control + m '),'Ctrl+Shift+M');
  assert.equal(normalizeShortcut('Alt+F8'),'Alt+F8');
  for(const value of ['M','Shift+M','Ctrl+Ctrl+M','Ctrl+M+N','Ctrl+Shift','Ctrl+F25']){
    assert.throws(()=>normalizeShortcut(value),value);
  }
});
