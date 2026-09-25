import { assertSameTargets, changes, cloneItems, sameItems, signature } from './domain/tags';
import type { EditorBridge, ItemSnapshot, Tag } from './types';

const PLUGIN_ID = 'zotero-tag-editor@lllateron';
const EDITOR_URL = 'chrome://zotero-tag-editor/content/editor.xhtml';
const EDITOR_WINDOW_NAME = 'zotero-tag-editor';
const PREF_SHORTCUT = 'lllateron.tagEditor.shortcut';
const DEFAULT_SHORTCUT = 'Ctrl+T';
const MAIN_WINDOW_URL = 'chrome://zotero/content/zoteroPane.xhtml';
const READER_WINDOW_URL = 'chrome://zotero/content/reader.xhtml';
const MENU_ITEM_ID = 'zotero-tag-editor-tools-menuitem';
const MENU_SEPARATOR_ID = 'zotero-tag-editor-tools-separator';

type ZoteroAPI = any;
type ServicesAPI = any;
type HostWindow = any;
type ZoteroItem = any;

interface ShortcutSpec {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

interface TargetKey {
  id: number;
  libraryID: number;
}

interface EditorSession {
  token: symbol;
  context: 'library' | 'reader';
  targetKeys: TargetKey[];
  base: ItemSnapshot[];
  bridge: EditorBridge;
}

interface UndoRecord {
  before: ItemSnapshot[];
  after: ItemSnapshot[];
}

interface HostBinding {
  window: HostWindow;
  hotkey: (event: KeyboardEvent) => void;
  contentLoaded: () => void;
  unload: () => void;
  menuItem?: any;
  menuSeparator?: any;
  menuPopup?: any;
  menuPopupShowing?: () => void;
}

interface FrameBinding {
  window: HostWindow;
  hostWindow: HostWindow;
  hotkey: (event: KeyboardEvent) => void;
}

export class ConflictError extends Error {
  override name = 'ConflictError';
}

export function normalizeShortcut(input: string): string {
  if (typeof input !== 'string') throw new Error('快捷键格式无效。');
  const tokens = input.split('+').map(token => token.trim()).filter(Boolean);
  if (tokens.length < 2) throw new Error('快捷键必须包含修饰键和一个按键。');

  const modifiers = new Set<string>();
  let key = '';
  for (const raw of tokens) {
    const token = raw.toLowerCase();
    const modifier = token === 'control' ? 'ctrl'
      : token === 'cmd' || token === 'command' || token === 'win' ? 'meta'
        : token;
    if (modifier === 'ctrl' || modifier === 'alt' || modifier === 'shift' || modifier === 'meta') {
      if (modifiers.has(modifier)) throw new Error('快捷键包含重复的修饰键。');
      modifiers.add(modifier);
      continue;
    }
    if (key) throw new Error('快捷键只能包含一个普通按键。');
    const upper = raw.toUpperCase();
    if (!/^[A-Z0-9]$/.test(upper) && !/^F(?:[1-9]|1\d|2[0-4])$/.test(upper)) {
      throw new Error('快捷键按键仅支持字母、数字或 F1–F24。');
    }
    key = upper;
  }
  if (!key || !(modifiers.has('ctrl') || modifiers.has('alt') || modifiers.has('meta'))) {
    throw new Error('快捷键必须包含 Ctrl、Alt 或 Meta。');
  }
  return [
    modifiers.has('ctrl') ? 'Ctrl' : '',
    modifiers.has('alt') ? 'Alt' : '',
    modifiers.has('shift') ? 'Shift' : '',
    modifiers.has('meta') ? 'Meta' : '',
    key,
  ].filter(Boolean).join('+');
}

function shortcutSpec(value: string): ShortcutSpec {
  const normalized = normalizeShortcut(value);
  const tokens = normalized.split('+');
  return {
    ctrl: tokens.includes('Ctrl'),
    alt: tokens.includes('Alt'),
    shift: tokens.includes('Shift'),
    meta: tokens.includes('Meta'),
    key: tokens.at(-1)!,
  };
}

export function matchesShortcut(event: Pick<KeyboardEvent,
  'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'isComposing'>, value: string): boolean {
  if (event.isComposing) return false;
  const spec = shortcutSpec(value);
  return event.ctrlKey === spec.ctrl
    && event.altKey === spec.alt
    && event.shiftKey === spec.shift
    && event.metaKey === spec.meta
    && event.key.toUpperCase() === spec.key;
}

function normalizedTag(input: Tag, legacySignatures?: Set<string>): Tag {
  if (!input || typeof input.tag !== 'string') throw new Error('标签数据无效。');
  const tag = input.tag.trim().normalize();
  if (!tag) throw new Error('标签名称不能为空。');
  const type = input.type ?? 0;
  if (type !== 0 && type !== 1) throw new Error('标签类型只能是手动或自动标签。');
  const normalized = type === 1 ? { tag, type: 1 } : { tag, type: 0 };
  const isLegacy = legacySignatures?.has(signature([normalized]));
  if (!isLegacy && /[\u0000-\u001f\u007f]/u.test(tag)) {
    throw new Error('标签名称不能包含换行或控制字符。');
  }
  if (!isLegacy && tag.length > 255) throw new Error('标签名称不能超过 255 个字符。');
  return normalized;
}

function normalizedDraft(items: ItemSnapshot[], legacyByItem?: Map<number, Set<string>>): ItemSnapshot[] {
  if (!Array.isArray(items)) throw new Error('条目草稿无效。');
  return items.map(item => {
    if (!item || !Number.isInteger(item.id) || !Number.isInteger(item.libraryID)
      || !Array.isArray(item.tags)) {
      throw new Error('条目草稿无效。');
    }
    const names = new Set<string>();
    const tags = item.tags.map(tag => normalizedTag(tag, legacyByItem?.get(item.id)));
    for (const tag of tags) {
      if (names.has(tag.tag)) throw new Error(`标签“${tag.tag}”重复。`);
      names.add(tag.tag);
    }
    return { id: item.id, libraryID: item.libraryID, title: String(item.title ?? ''), tags };
  });
}

class RuntimeController {
  private readonly hostBindings = new Map<HostWindow, HostBinding>();
  private readonly frameBindings = new Map<HostWindow, FrameBinding>();
  private editorWindow: HostWindow | null = null;
  private session: EditorSession | null = null;
  private undoRecord: UndoRecord | null = null;
  private operation: Promise<unknown> | null = null;
  private openOperation: Promise<void> | null = null;
  private stopping = false;
  private windowMediatorListener: any;

  constructor(private readonly Z: ZoteroAPI, private readonly services: ServicesAPI) {}

  async start(): Promise<void> {
    await this.Z.initializationPromise;
    for (const window of this.Z.getMainWindows()) this.attachHostWindow(window);
    const readers = this.services.wm.getEnumerator('zotero:reader');
    while (readers.hasMoreElements()) this.attachHostWindow(readers.getNext());

    this.windowMediatorListener = {
      onOpenWindow: (xulWindow: any) => {
        const window = xulWindow.docShell.domWindow;
        const onLoad = () => {
          window.removeEventListener('load', onLoad, false);
          this.attachHostWindow(window);
        };
        window.addEventListener('load', onLoad, false);
      },
      onCloseWindow: (xulWindow: any) => this.detachHostWindow(xulWindow.docShell.domWindow),
    };
    this.services.wm.addListener(this.windowMediatorListener);
  }

  onMainWindowLoad(window: HostWindow): void {
    this.attachHostWindow(window);
  }

  onMainWindowUnload(window: HostWindow): void {
    this.detachHostWindow(window);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.windowMediatorListener) {
      this.services.wm.removeListener(this.windowMediatorListener);
      this.windowMediatorListener = undefined;
    }
    const pending = this.operation;
    if (pending) {
      try { await pending; } catch { /* The caller already receives the operation failure. */ }
    }
    const opening = this.openOperation;
    if (opening) {
      try { await opening; } catch { /* Shutdown intentionally cancels an in-flight open. */ }
    }
    if (this.editorWindow && !this.editorWindow.closed) {
      this.editorWindow.dispatchEvent(new this.editorWindow.CustomEvent('zotero-tag-editor-shutdown'));
      this.editorWindow.close();
    }
    this.editorWindow = null;
    this.session = null;
    this.undoRecord = null;
    for (const window of [...this.hostBindings.keys()]) this.detachHostWindow(window);
    for (const binding of this.frameBindings.values()) {
      try { binding.window.removeEventListener('keydown', binding.hotkey, true); } catch { /* Dead reader frame. */ }
    }
    this.frameBindings.clear();
  }

  private windowURL(window: HostWindow): string {
    try { return String(window.location?.href ?? ''); } catch { return ''; }
  }

  private attachHostWindow(window: HostWindow): void {
    if (this.stopping || !window || window.closed || this.hostBindings.has(window)) return;
    const url = this.windowURL(window);
    if (url !== MAIN_WINDOW_URL && url !== READER_WINDOW_URL) return;
    const hotkey = (event: KeyboardEvent) => this.handleHotkey(event, window);
    const contentLoaded = () => window.setTimeout(() => this.refreshReaderFrames(window), 0);
    const unload = () => this.detachHostWindow(window);
    const binding: HostBinding = { window, hotkey, contentLoaded, unload };
    this.hostBindings.set(window, binding);
    window.addEventListener('keydown', hotkey, true);
    window.addEventListener('DOMContentLoaded', contentLoaded, true);
    window.addEventListener('unload', unload, { once: true });
    if (url === MAIN_WINDOW_URL) this.addToolsMenu(binding);
    this.refreshReaderFrames(window);
  }

  private detachHostWindow(window: HostWindow): void {
    const binding = this.hostBindings.get(window);
    if (!binding) return;
    window.removeEventListener('keydown', binding.hotkey, true);
    window.removeEventListener('DOMContentLoaded', binding.contentLoaded, true);
    window.removeEventListener('unload', binding.unload);
    if (binding.menuPopup && binding.menuPopupShowing) {
      binding.menuPopup.removeEventListener('popupshowing', binding.menuPopupShowing);
    }
    binding.menuItem?.remove();
    binding.menuSeparator?.remove();
    this.hostBindings.delete(window);
    for (const [frame, frameBinding] of this.frameBindings) {
      if (frameBinding.hostWindow !== window) continue;
      try { frame.removeEventListener('keydown', frameBinding.hotkey, true); } catch { /* Dead reader frame. */ }
      this.frameBindings.delete(frame);
    }
  }

  private refreshReaderFrames(hostWindow: HostWindow): void {
    const readers: any[] = Array.isArray(this.Z.Reader?._readers) ? this.Z.Reader._readers : [];
    for (const reader of readers) {
      if (reader?._window !== hostWindow || !reader._iframeWindow) continue;
      const frameWindow = reader._iframeWindow;
      if (this.frameBindings.has(frameWindow)) continue;
      const hotkey = (event: KeyboardEvent) => this.handleHotkey(event, hostWindow);
      frameWindow.addEventListener('keydown', hotkey, true);
      this.frameBindings.set(frameWindow, { window: frameWindow, hostWindow, hotkey });
    }
    for (const [frame, binding] of this.frameBindings) {
      let closed = false;
      try { closed = Boolean(frame.closed); } catch { closed = true; }
      if (binding.hostWindow === hostWindow && closed) {
        try { frame.removeEventListener('keydown', binding.hotkey, true); } catch { /* Dead reader frame. */ }
        this.frameBindings.delete(frame);
      }
    }
  }

  private addToolsMenu(binding: HostBinding): void {
    const { document } = binding.window;
    const popup = document.getElementById('menu_ToolsPopup');
    if (!popup || document.getElementById(MENU_ITEM_ID)) return;
    const separator = document.createXULElement('menuseparator');
    separator.id = MENU_SEPARATOR_ID;
    const item = document.createXULElement('menuitem');
    item.id = MENU_ITEM_ID;
    item.setAttribute('label', '标签编辑器…');
    item.setAttribute('class', 'menuitem-iconic');
    item.setAttribute('image', 'chrome://zotero-tag-editor/content/tag.svg');
    item.setAttribute('style', 'font: inherit');
    item.setAttribute('acceltext', this.getShortcut());
    item.addEventListener('command', () => {
      void this.openEditor(binding.window).catch(error => this.showError(binding.window, error));
    });
    const updateShortcut = () => item.setAttribute('acceltext', this.getShortcut());
    popup.append(separator, item);
    popup.addEventListener('popupshowing', updateShortcut);
    Object.assign(binding, {
      menuItem: item,
      menuSeparator: separator,
      menuPopup: popup,
      menuPopupShowing: updateShortcut,
    });
  }

  private handleHotkey(event: KeyboardEvent, hostWindow: HostWindow): void {
    if (this.stopping || event.defaultPrevented || event.repeat || event.isComposing) return;
    let matches = false;
    try { matches = matchesShortcut(event, this.getShortcut()); } catch { /* Fall back below. */ }
    if (!matches) return;
    event.preventDefault();
    event.stopPropagation();
    void this.openEditor(hostWindow).catch(error => this.showError(hostWindow, error));
  }

  private getShortcut(): string {
    try {
      const value = this.Z.Prefs.get(PREF_SHORTCUT);
      return normalizeShortcut(typeof value === 'string' && value ? value : DEFAULT_SHORTCUT);
    } catch {
      return DEFAULT_SHORTCUT;
    }
  }

  private setShortcut(value: string): void {
    const normalized = normalizeShortcut(value);
    this.Z.Prefs.set(PREF_SHORTCUT, normalized);
    for (const binding of this.hostBindings.values()) {
      binding.menuItem?.setAttribute('acceltext', normalized);
    }
  }

  private async openEditor(hostWindow: HostWindow): Promise<void> {
    if (this.stopping) throw new Error('插件正在关闭。');
    if (this.openOperation) {
      await this.openOperation;
      return this.openEditor(hostWindow);
    }
    if (this.operation) {
      try { await this.operation; } catch { /* A failed operation does not block reopening. */ }
    }
    this.openOperation = this.createEditor(hostWindow);
    try { await this.openOperation; } finally { this.openOperation = null; }
  }

  private async createEditor(hostWindow: HostWindow): Promise<void> {
    const target = await this.resolveTarget(hostWindow);
    const existingWindow = this.editorWindow && !this.editorWindow.closed ? this.editorWindow : null;
    if (existingWindow && this.session
      && this.session.context === target.context
      && this.session.targetKeys.length === target.items.length
      && target.items.every(item => this.session!.targetKeys.some(key => key.id === item.id && key.libraryID === item.libraryID))) {
      existingWindow.focus();
      return;
    }
    const base = await this.snapshotItems(target.items);
    const targetKeys = base.map(({ id, libraryID }) => ({ id, libraryID }));
    const availableTags: Tag[] = await this.Z.Tags.getAll(target.libraryID);
    const colors = this.colorRecord(this.Z.Tags.getColors(target.libraryID));
    const token = Symbol('editor-session');
    const session = {} as EditorSession;
    const bridge: EditorBridge = {
      initialItems: cloneItems(base),
      availableTags: [...new Set(availableTags.map((tag: Tag) => String(tag.tag)))],
      colors,
      context: target.context,
      save: (providedBase, draft) => this.withOperation(() => this.save(session, providedBase, draft)),
      reload: () => this.withOperation(() => this.reload(session)),
      undo: () => this.withOperation(() => this.undo(session)),
      undoCount: () => this.undoRecord?.before.length ?? 0,
      getShortcut: () => this.getShortcut(),
      setShortcut: value => this.setShortcut(value),
    };
    Object.assign(session, { token, context: target.context, targetKeys, base: cloneItems(base), bridge });

    if (this.stopping) throw new Error('插件正在关闭。');
    if (existingWindow) {
      existingWindow.focus();
      const request = { bridge, accepted: false };
      const event = new existingWindow.CustomEvent('zotero-tag-editor-retarget', {
        detail: request, cancelable: true,
      });
      existingWindow.dispatchEvent(event);
      if (request.accepted) this.session = session;
      return;
    }
    this.session = session;
    let window: HostWindow;
    try {
      window = hostWindow.openDialog(
        EDITOR_URL,
        EDITOR_WINDOW_NAME,
        'chrome,centerscreen,resizable,dialog=no,width=720,height=520',
        bridge,
      );
    } catch (error) {
      if (this.session?.token === token) this.session = null;
      throw error;
    }
    this.editorWindow = window;
    const onEditorUnload = (event: { target?: { documentURI?: string } }) => {
      // openDialog initially replaces about:blank. That unload is not the
      // editor closing and must not invalidate the newly created session.
      if (event.target?.documentURI !== EDITOR_URL) return;
      window.removeEventListener('unload', onEditorUnload);
      if (this.editorWindow === window) {
        this.editorWindow = null;
        this.session = null;
      }
    };
    window.addEventListener('unload', onEditorUnload);
    window.focus();
  }

  private async resolveTarget(hostWindow: HostWindow): Promise<{
    items: ZoteroItem[];
    libraryID: number;
    context: 'library' | 'reader';
  }> {
    const url = this.windowURL(hostWindow);
    if (url === READER_WINDOW_URL) {
      return this.readerTarget(hostWindow.reader);
    }
    if (url !== MAIN_WINDOW_URL) throw new Error('请从 Zotero 文献库或 PDF 阅读器打开标签编辑器。');

    const selectedType = String(hostWindow.Zotero_Tabs?.selectedType ?? '');
    if (selectedType.startsWith('reader')) {
      const reader = this.Z.Reader.getByTabID(hostWindow.Zotero_Tabs.selectedID);
      return this.readerTarget(reader);
    }

    const selected = hostWindow.ZoteroPane?.getSelectedItems?.() ?? [];
    if (!selected.length) throw new Error('请先选择至少一个文献条目。');
    if (selected.some((item: ZoteroItem) => !item?.isRegularItem?.())) {
      throw new Error('请选择文献条目；第一版不编辑附件、笔记或批注的标签。');
    }
    const libraryIDs = new Set<number>(selected.map((item: ZoteroItem) => item.libraryID));
    if (libraryIDs.size !== 1) throw new Error('暂不支持同时编辑多个文献库中的条目。');
    const libraryID = [...libraryIDs][0];
    this.assertWritable(selected, libraryID);
    return { items: selected, libraryID, context: 'library' };
  }

  private async readerTarget(reader: any): Promise<{
    items: ZoteroItem[];
    libraryID: number;
    context: 'reader';
  }> {
    if (!reader?.itemID) throw new Error('当前阅读器尚未载入 PDF。');
    const attachment = await this.Z.Items.getAsync(reader.itemID);
    if (!attachment?.isAttachment?.()
      || String(attachment.attachmentContentType ?? '').toLowerCase() !== 'application/pdf') {
      throw new Error('第一版只处理 PDF 所属的文献条目。');
    }
    if (!attachment.parentItemID) throw new Error('当前 PDF 没有所属的文献条目。');
    const parent = await this.Z.Items.getAsync(attachment.parentItemID);
    if (!parent?.isRegularItem?.()) throw new Error('当前 PDF 没有可编辑的文献父条目。');
    this.assertWritable([parent], parent.libraryID);
    return { items: [parent], libraryID: parent.libraryID, context: 'reader' };
  }

  private assertWritable(items: ZoteroItem[], libraryID: number): void {
    const library = this.Z.Libraries.get(libraryID);
    if (!library || library.libraryType === 'feed' || !library.editable
      || items.some(item => item.deleted || !item.isEditable())) {
      throw new Error('所选条目所在文献库为只读，或条目已在回收站中。');
    }
  }

  private async snapshotItems(items: ZoteroItem[]): Promise<ItemSnapshot[]> {
    await this.Z.Items.loadDataTypes(items, ['tags']);
    return items.map(item => ({
      id: item.id,
      libraryID: item.libraryID,
      title: String(item.getField('title') || '（无标题）'),
      // Preserve legacy long tags so users can remove or rename them. New tag
      // names still obey Zotero's 255 UTF-16-unit synchronization limit.
      tags: item.getTags().map((tag: Tag) => normalizedTag(tag, new Set([signature([tag])]))),
    }));
  }

  private async itemsForTargets(targets: TargetKey[]): Promise<ZoteroItem[]> {
    const items: ZoteroItem[] = [];
    for (const target of targets) {
      const item = await this.Z.Items.getAsync(target.id);
      if (!item || item.libraryID !== target.libraryID || !item.isRegularItem?.()) {
        throw new ConflictError('目标条目已不存在或已发生变化，请重新打开标签编辑窗口。');
      }
      items.push(item);
    }
    const libraries = new Set(items.map(item => item.libraryID));
    if (libraries.size !== 1) throw new ConflictError('目标条目所属文献库发生变化。');
    this.assertWritable(items, items[0].libraryID);
    return items;
  }

  private assertActiveSession(session: EditorSession): void {
    if (this.stopping || this.session?.token !== session.token) {
      throw new Error('标签编辑窗口已失效，请重新打开。');
    }
  }

  private assertFrozenTargets(session: EditorSession, items: ItemSnapshot[]): void {
    const expected = session.targetKeys.map(({ id, libraryID }) => ({ id, libraryID, title: '', tags: [] }));
    const actual = items.map(({ id, libraryID }) => ({ id, libraryID, title: '', tags: [] }));
    assertSameTargets(expected, actual);
  }

  private async save(session: EditorSession, providedBase: ItemSnapshot[], draft: ItemSnapshot[]): Promise<void> {
    this.assertActiveSession(session);
    const legacyByItem = new Map(session.base.map(item => [
      item.id,
      new Set(item.tags.map(tag => signature([tag]))),
    ]));
    const cleanBase = normalizedDraft(providedBase, legacyByItem);
    const cleanDraft = normalizedDraft(draft, legacyByItem);
    this.assertFrozenTargets(session, cleanBase);
    this.assertFrozenTargets(session, cleanDraft);
    assertSameTargets(cleanBase, cleanDraft);
    if (!sameItems(cleanBase, session.base)) {
      throw new ConflictError('编辑基线已变化，请重新载入后再保存。');
    }
    if (changes(cleanBase, cleanDraft).itemCount === 0) return;

    const ids = session.targetKeys.map(target => target.id);
    let current: ItemSnapshot[] = [];
    try {
      await this.Z.DB.executeTransaction(async () => {
        const items = await this.itemsForTargets(session.targetKeys);
        current = await this.snapshotItems(items);
        if (!sameItems(current, cleanBase)) {
          throw new ConflictError('目标条目的标签已在外部改变，请重新载入后检查草稿。');
        }
        const draftByID = new Map(cleanDraft.map(item => [item.id, item]));
        for (let index = 0; index < items.length; index++) {
          const item = items[index];
          const next = draftByID.get(item.id)!;
          if (signature(current[index].tags) === signature(next.tags)) continue;
          item.setTags(next.tags);
          await item.save();
        }
      });
    } catch (error) {
      try { await this.Z.Items.reload(ids, ['primaryData', 'tags'], true); }
      catch (reloadError) { this.Z.logError(reloadError); }
      throw error;
    }

    const currentByID = new Map(current.map(item => [item.id, item]));
    const draftByID = new Map(cleanDraft.map(item => [item.id, item]));
    const changedIDs = session.targetKeys
      .map(target => target.id)
      .filter(id => signature(currentByID.get(id)!.tags) !== signature(draftByID.get(id)!.tags));
    this.undoRecord = {
      before: changedIDs.map(id => cloneItems([currentByID.get(id)!])[0]),
      after: changedIDs.map(id => cloneItems([draftByID.get(id)!])[0]),
    };
    session.base = cloneItems(cleanDraft);
  }

  private async reload(session: EditorSession): Promise<ItemSnapshot[]> {
    this.assertActiveSession(session);
    const items = await this.itemsForTargets(session.targetKeys);
    const current = await this.snapshotItems(items);
    session.base = cloneItems(current);
    return cloneItems(current);
  }

  private async undo(session: EditorSession): Promise<ItemSnapshot[]> {
    this.assertActiveSession(session);
    const record = this.undoRecord;
    if (!record?.before.length) throw new Error('本次 Zotero 运行期间没有可撤销的标签保存。');
    const targets = record.after.map(({ id, libraryID }) => ({ id, libraryID }));
    const ids = targets.map(target => target.id);
    try {
      await this.Z.DB.executeTransaction(async () => {
        const items = await this.itemsForTargets(targets);
        const current = await this.snapshotItems(items);
        if (!sameItems(current, record.after)) {
          throw new ConflictError('这些条目的标签在保存后又发生了变化，撤销已暂停。');
        }
        const beforeByID = new Map(record.before.map(item => [item.id, item]));
        for (const item of items) {
          item.setTags(beforeByID.get(item.id)!.tags);
          await item.save();
        }
      });
    } catch (error) {
      try { await this.Z.Items.reload(ids, ['primaryData', 'tags'], true); }
      catch (reloadError) { this.Z.logError(reloadError); }
      throw error;
    }
    this.undoRecord = null;
    return cloneItems(record.before);
  }

  private colorRecord(colors: Map<string, { color: string }>): Record<string, string> {
    const record: Record<string, string> = Object.create(null);
    for (const [name, data] of colors) record[name] = data.color;
    return record;
  }

  private withOperation<T>(task: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('插件正在关闭。'));
    if (this.operation) return Promise.reject(new Error('另一项标签操作正在进行，请稍候。'));
    const operation = task();
    this.operation = operation;
    void operation.finally(() => {
      if (this.operation === operation) this.operation = null;
    }).catch(() => { /* The original promise reports the failure. */ });
    return operation;
  }

  private showError(window: HostWindow, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.services.prompt.alert(window, 'Zotero Tag Editor', message);
  }
}

let controller: RuntimeController | undefined;

export async function startup(Z: ZoteroAPI, services: ServicesAPI): Promise<void> {
  if (controller) return;
  const next = new RuntimeController(Z, services);
  controller = next;
  try { await next.start(); }
  catch (error) { controller = undefined; throw error; }
}

export function onMainWindowLoad(window: HostWindow): void {
  controller?.onMainWindowLoad(window);
}

export function onMainWindowUnload(window: HostWindow): void {
  controller?.onMainWindowUnload(window);
}

export async function shutdown(): Promise<void> {
  const current = controller;
  controller = undefined;
  await current?.stop();
}

export const runtimeIdentity = { pluginID: PLUGIN_ID, editorURL: EDITOR_URL } as const;
