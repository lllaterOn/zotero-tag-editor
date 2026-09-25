import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shutdown, startup } from '../src/zotero';
import type { EditorBridge, Tag } from '../src/types';

function cloneTags(tags: Tag[]): Tag[] {
  return tags.map(tag => ({ ...tag }));
}

class FakeItem {
  readonly libraryID = 1;
  deleted = false;
  cacheTags: Tag[];
  dbTags: Tag[];

  constructor(readonly id: number, readonly title: string, tags: Tag[]) {
    this.cacheTags = cloneTags(tags);
    this.dbTags = cloneTags(tags);
  }

  isRegularItem(): boolean { return true; }
  isEditable(): boolean { return true; }
  getField(): string { return this.title; }
  getTags(): Tag[] { return cloneTags(this.cacheTags); }
  setTags(tags: Tag[]): void { this.cacheTags = cloneTags(tags); }

  async save(): Promise<void> {
    if (fixtureState.failSaveID === this.id) throw new Error(`save failed for ${this.id}`);
    this.dbTags = cloneTags(this.cacheTags);
  }
}

interface FakeNode {
  id: string;
  attributes: Map<string, string>;
  listeners: Map<string, Set<(event?: any) => void>>;
  children: FakeNode[];
  setAttribute(name: string, value: string): void;
  addEventListener(name: string, listener: (event?: any) => void): void;
  removeEventListener(name: string, listener: (event?: any) => void): void;
  append(...children: FakeNode[]): void;
  remove(): void;
  fire(name: string, event?: any): void;
}

function fakeNode(): FakeNode {
  const node: FakeNode = {
    id: '',
    attributes: new Map(),
    listeners: new Map(),
    children: [],
    setAttribute(name, value) { this.attributes.set(name, value); },
    addEventListener(name, listener) {
      const listeners = this.listeners.get(name) ?? new Set();
      listeners.add(listener);
      this.listeners.set(name, listeners);
    },
    removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); },
    append(...children) { this.children.push(...children); },
    remove() {},
    fire(name, event) { for (const listener of this.listeners.get(name) ?? []) listener(event); },
  };
  return node;
}

const fixtureState: { failSaveID: number | null } = { failSaveID: null };

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for the editor bridge');
}

function makeFixture(initialItems: FakeItem[]) {
  const byID = new Map(initialItems.map(item => [item.id, item]));
  let selection = [...initialItems];
  let bridge: EditorBridge | undefined;
  let transactionCount = 0;
  let reloadCount = 0;
  const popup = fakeNode();
  popup.id = 'menu_ToolsPopup';
  const hostListeners = new Map<string, Set<(event?: any) => void>>();

  const editorListeners = new Map<string, Set<(event?: any) => void>>();
  const editorWindow: any = {
    closed: false,
    CustomEvent: class {
      detail: any;
      constructor(readonly type: string, options?: { detail: any }) { this.detail = options?.detail; }
    },
    addEventListener(name: string, listener: (event?: any) => void) {
      const listeners = editorListeners.get(name) ?? new Set();
      listeners.add(listener);
      editorListeners.set(name, listeners);
    },
    dispatchEvent(event: { type: string }) {
      for (const listener of editorListeners.get(event.type) ?? []) listener(event);
    },
    removeEventListener(name: string, listener: (event?: any) => void) {
      editorListeners.get(name)?.delete(listener);
    },
    focus() {},
    close() {
      this.closed = true;
      for (const listener of editorListeners.get('unload') ?? []) {
        listener({target:{documentURI:'chrome://zotero-tag-editor/content/editor.xhtml'}});
      }
    },
  };

  const host: any = {
    closed: false,
    location: { href: 'chrome://zotero/content/zoteroPane.xhtml' },
    Zotero_Tabs: { selectedType: 'library', selectedID: 'zotero-pane' },
    ZoteroPane: { getSelectedItems: () => selection },
    document: {
      getElementById: (id: string) => id === 'menu_ToolsPopup' ? popup : undefined,
      createXULElement: () => fakeNode(),
    },
    addEventListener(name: string, listener: (event?: any) => void) {
      const listeners = hostListeners.get(name) ?? new Set();
      listeners.add(listener);
      hostListeners.set(name, listeners);
    },
    removeEventListener(name: string, listener: (event?: any) => void) {
      hostListeners.get(name)?.delete(listener);
    },
    setTimeout(callback: () => void) { callback(); },
    openDialog(_url: string, _name: string, features: string, value: EditorBridge) {
      assert.match(features, /width=720,height=520/);
      bridge = value;
      return editorWindow;
    },
  };

  const Zotero: any = {
    initializationPromise: Promise.resolve(),
    getMainWindows: () => [host],
    Reader: { _readers: [], getByTabID: () => undefined },
    Prefs: {
      value: 'Ctrl+Shift+M',
      get() { return this.value; },
      set(_name: string, value: string) { this.value = value; },
    },
    Libraries: { get: () => ({ libraryType: 'user', editable: true }) },
    Tags: {
      getAll: async () => [{ tag: 'existing' }],
      getColors: () => new Map([['existing', { color: '#112233' }]]),
    },
    Items: {
      getAsync: async (id: number) => byID.get(id),
      loadDataTypes: async () => {},
      reload: async (ids: number[]) => {
        reloadCount++;
        for (const id of ids) {
          const item = byID.get(id);
          if (item) item.cacheTags = cloneTags(item.dbTags);
        }
      },
    },
    DB: {
      executeTransaction: async (callback: () => Promise<void>) => {
        transactionCount++;
        const before = new Map([...byID].map(([id, item]) => [id, cloneTags(item.dbTags)]));
        try { await callback(); }
        catch (error) {
          for (const [id, tags] of before) byID.get(id)!.dbTags = cloneTags(tags);
          throw error;
        }
      },
    },
    logError() {},
  };
  const Services: any = {
    wm: {
      getEnumerator: () => ({ hasMoreElements: () => false }),
      addListener() {},
      removeListener() {},
    },
    prompt: { alert() {} },
  };

  return {
    Zotero,
    Services,
    items: byID,
    setSelection(items: FakeItem[]) { selection = items; },
    transactionCount: () => transactionCount,
    reloadCount: () => reloadCount,
    async retarget(accept: boolean): Promise<EditorBridge> {
      let received = false;
      const listener = (event: any) => {
        received = true;
        event.detail.accepted = accept;
        if (accept) bridge = event.detail.bridge;
      };
      editorWindow.addEventListener('zotero-tag-editor-retarget', listener);
      popup.children.find(child => child.id === 'zotero-tag-editor-tools-menuitem')!.fire('command');
      await waitFor(() => received);
      editorWindow.removeEventListener('zotero-tag-editor-retarget', listener);
      return bridge!;
    },
    initialDocumentUnload() {
      editorWindow.dispatchEvent({type:'unload',target:{documentURI:'about:blank'}});
    },
    async openFromTools(): Promise<EditorBridge> {
      await startup(Zotero, Services);
      const menuItem = popup.children.find(child => child.id === 'zotero-tag-editor-tools-menuitem');
      assert.ok(menuItem, 'Tools menu entry was registered');
      menuItem.fire('command');
      await waitFor(() => Boolean(bridge));
      return bridge!;
    },
  };
}

test('runtime enforces frozen targets and detects external tag conflicts', async () => {
  fixtureState.failSaveID = null;
  const first = new FakeItem(1, 'First', [{ tag: 'existing', type: 0 }]);
  const fixture = makeFixture([first]);
  try {
    const bridge = await fixture.openFromTools();
    const wrongBase = bridge.initialItems.map(item => ({ ...item, id: 999 }));
    await assert.rejects(bridge.save(wrongBase, wrongBase), /目标条目发生变化/);
    assert.equal(fixture.transactionCount(), 0);

    first.cacheTags = [{ tag: 'external', type: 0 }];
    first.dbTags = cloneTags(first.cacheTags);
    const draft = structuredClone(bridge.initialItems);
    draft[0].tags.push({ tag: 'draft', type: 0 });
    await assert.rejects(
      bridge.save(structuredClone(bridge.initialItems), draft),
      (error: any) => error?.name === 'ConflictError',
    );
    assert.deepEqual(first.dbTags, [{ tag: 'external', type: 0 }]);
  } finally {
    await shutdown();
  }
});

test('reopening switches frozen targets only after the editor accepts the new selection', async () => {
  const first = new FakeItem(1, 'First', [{ tag: 'one', type: 0 }]);
  const second = new FakeItem(2, 'Second', [{ tag: 'two', type: 0 }]);
  const fixture = makeFixture([first, second]);
  fixture.setSelection([first]);
  try {
    const original = await fixture.openFromTools();
    fixture.setSelection([second]);
    assert.equal(await fixture.retarget(false), original);
    await original.reload();
    const switched = await fixture.retarget(true);
    assert.deepEqual(switched.initialItems.map(item => item.id), [2]);
    await assert.rejects(original.reload(), /已失效/);
    const draft = structuredClone(switched.initialItems);
    draft[0].tags.push({ tag: 'new', type: 0 });
    await switched.save(structuredClone(switched.initialItems), draft);
    assert.deepEqual(first.dbTags, [{ tag: 'one', type: 0 }]);
    assert.ok(second.dbTags.some(tag => tag.tag === 'new'));
  } finally { await shutdown(); }
});

test('initial about:blank unload does not invalidate the editor save session', async () => {
  fixtureState.failSaveID = null;
  const first = new FakeItem(1,'First',[{tag:'keep',type:0}]);
  const fixture = makeFixture([first]);
  try {
    const bridge = await fixture.openFromTools();
    fixture.initialDocumentUnload();
    const draft = structuredClone(bridge.initialItems);
    draft[0].tags.push({tag:'new',type:0});
    await bridge.save(structuredClone(bridge.initialItems),draft);
    assert(first.dbTags.some(tag=>tag.tag==='new'));
    assert.equal(bridge.undoCount(),1);
  } finally { await shutdown(); }
});

test('failed batch save rolls back DB and cache, then undo ignores the current selection', async () => {
  const first = new FakeItem(1, 'First', [{ tag: 'one', type: 0 }]);
  const second = new FakeItem(2, 'Second', [{ tag: 'two', type: 0 }]);
  const unselected = new FakeItem(3, 'Third', [{ tag: 'three', type: 0 }]);
  const fixture = makeFixture([first, second, unselected]);
  fixture.setSelection([first, second]);
  try {
    const bridge = await fixture.openFromTools();
    const base = structuredClone(bridge.initialItems);
    const draft = structuredClone(base);
    for (const item of draft) item.tags.push({ tag: 'batch', type: 0 });

    fixtureState.failSaveID = 2;
    await assert.rejects(bridge.save(structuredClone(base), structuredClone(draft)), /save failed/);
    assert.equal(fixture.reloadCount(), 1, 'failed transaction reloads Zotero item caches');
    assert.deepEqual(first.cacheTags, [{ tag: 'one', type: 0 }]);
    assert.deepEqual(second.cacheTags, [{ tag: 'two', type: 0 }]);
    assert.equal(bridge.undoCount(), 0);

    fixtureState.failSaveID = null;
    await bridge.save(structuredClone(base), structuredClone(draft));
    assert.equal(bridge.undoCount(), 2);
    assert.ok(first.dbTags.some(tag => tag.tag === 'batch'));
    assert.ok(second.dbTags.some(tag => tag.tag === 'batch'));

    const savedFirst = cloneTags(first.dbTags);
    first.dbTags.push({ tag: 'after-save', type: 0 });
    first.cacheTags = cloneTags(first.dbTags);
    await assert.rejects(
      bridge.undo(),
      (error: any) => error?.name === 'ConflictError',
    );
    assert.ok(first.dbTags.some(tag => tag.tag === 'after-save'));
    assert.equal(bridge.undoCount(), 2, 'a conflicted undo remains available for a later safe retry');
    first.dbTags = cloneTags(savedFirst);
    first.cacheTags = cloneTags(savedFirst);

    fixture.setSelection([unselected]);
    const restored = await bridge.undo();
    assert.deepEqual(restored.map(item => item.id), [1, 2]);
    assert.deepEqual(first.dbTags, [{ tag: 'one', type: 0 }]);
    assert.deepEqual(second.dbTags, [{ tag: 'two', type: 0 }]);
    assert.deepEqual(unselected.dbTags, [{ tag: 'three', type: 0 }]);
    assert.equal(bridge.undoCount(), 0);
  } finally {
    fixtureState.failSaveID = null;
    await shutdown();
  }
});
