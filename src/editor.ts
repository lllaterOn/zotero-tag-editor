import type { EditorBridge, ItemSnapshot } from "./types";
import {
  addTag,
  changes,
  cloneItems,
  removeTag,
  renameTag,
  sameItems,
  validateTagName,
} from "./domain/tags";

declare global {
  interface Window {
    arguments?: [EditorBridge];
  }
}

type Suggestion = { tag: string; create: boolean };
type MessageKind = "discard" | "reload" | "undo-dirty" | "undo-error" | null;

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const createHTML = <K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] =>
  document.createElementNS(XHTML_NS, tag) as HTMLElementTagNameMap[K];
const bridgeArgument = window.arguments?.[0];

if (!bridgeArgument) {
  throw new Error("标签编辑器缺少 EditorBridge");
}
let bridge: EditorBridge = bridgeArgument;

let base = cloneItems(bridge.initialItems);
let draft = cloneItems(base);
let history: ItemSnapshot[][] = [];
let selectedTag: string | null = null;
let renaming: string | null = null;
let suggestions: Suggestion[] = [];
let activeSuggestion = 0;
let suggestionsOpen = false;
let messageKind: MessageKind = null;
let notice = "";
let busy = false;
let allowClose = false;

const search = byId<HTMLInputElement>("search");
const addButton = byId<HTMLButtonElement>("add");
const suggestionBox = byId<HTMLDivElement>("suggestions");
const tagsBox = byId<HTMLDivElement>("tags");
const inspector = byId<HTMLDivElement>("inspector");
const message = byId<HTMLDivElement>("message");
const announcement = byId<HTMLParagraphElement>("announcement");

function names(items: ItemSnapshot[]): string[] {
  return [...new Set(items.flatMap(item => item.tags.map(tag => tag.tag)))];
}

function hasTag(item: ItemSnapshot, tagName: string): boolean {
  return item.tags.some(tag => tag.tag === tagName);
}

function count(items: ItemSnapshot[], tagName: string): number {
  return items.filter(item => hasTag(item, tagName)).length;
}

function automaticCount(items: ItemSnapshot[], tagName: string): number {
  return items.filter(item => item.tags.some(tag => tag.tag === tagName && tag.type === 1)).length;
}

function isDirty(): boolean {
  return !sameItems(base, draft);
}

function setBusy(value: boolean): void {
  busy = value;
  document.documentElement.classList.toggle("busy", value);
  search.disabled = value;
  byId<HTMLInputElement>("shortcut").disabled = value;
  byId<HTMLButtonElement>("save-shortcut").disabled = value;
  if (value) {
    document.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input")
      .forEach(control => { control.disabled = true; });
  }
  renderControls();
}

function setNotice(value: string): void {
  notice = value;
  announcement.textContent = value;
}

function fieldFeedback(id: string, value: string, kind = ""): void {
  const field = byId(id);
  field.textContent = value;
  field.title = value;
  field.classList.toggle("feedback-error", kind === "error");
  field.classList.toggle("feedback-success", kind === "success");
}

function closeSuggestions(): void {
  suggestionsOpen = false;
  suggestionBox.hidden = true;
  search.setAttribute("aria-expanded", "false");
  search.removeAttribute("aria-activedescendant");
}

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const value = String((error as { message?: unknown }).message ?? "").trim();
    if (value) return value;
  }
  return "操作未完成，请重试。";
}

function errorName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    return String((error as { name?: unknown }).name ?? "");
  }
  return "";
}

function makeButton(label: string, className = "button small"): HTMLButtonElement {
  const button = createHTML("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}

function mutate(next: ItemSnapshot[], successMessage: string): void {
  if (busy) return;
  if (sameItems(draft, next)) {
    setNotice("所选文献已具有这个标签，无需重复添加。");
    fieldFeedback("search-feedback", "所选文献已具有这个标签。");
    return;
  }
  history.push(cloneItems(draft));
  if (history.length > 100) history.shift();
  draft = next;
  messageKind = null;
  renaming = null;
  notice = successMessage;
  render();
}

function selectedNameIsVisible(): boolean {
  return selectedTag !== null && [...new Set([...names(base), ...names(draft)])].includes(selectedTag);
}

function renderHeader(): void {
  byId("context").textContent = bridge.context === "reader"
    ? "PDF 阅读 · 编辑所属文献"
    : `文献列表 · 已选择 ${draft.length} 篇`;

  byId("target-summary").textContent = draft.length === 1
    ? draft[0]?.title || "1 篇文献"
    : `查看选中的 ${draft.length} 篇文献`;

  const list = byId<HTMLUListElement>("target-list");
  list.replaceChildren(...draft.map(item => {
    const li = createHTML("li");
    li.textContent = item.title || `条目 ${item.id}`;
    return li;
  }));
}

function renderSuggestions(): void {
  const query = search.value.trim();
  addButton.disabled = busy || !query;
  suggestions = [];

  if (query) {
    const known = [...new Set([...bridge.availableTags, ...names(draft)])];
    const lowerQuery = query.toLocaleLowerCase();
    suggestions = known
      .filter(tag => tag.toLocaleLowerCase().includes(lowerQuery))
      .sort((a, b) => a === query ? -1 : b === query ? 1 : a.localeCompare(b, "zh-CN"))
      .slice(0, 7)
      .map(tag => ({ tag, create: false }));
    if (!known.includes(query)) suggestions.push({ tag: query, create: true });
  }

  activeSuggestion = Math.max(0, Math.min(activeSuggestion, suggestions.length - 1));
  suggestionBox.replaceChildren(...suggestions.map((suggestion, index) => {
    const button = makeButton("", "suggestion");
    button.id = `tag-editor-suggestion-${index}`;
    button.dataset.index = String(index);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === activeSuggestion));
    const label = createHTML("span");
    label.textContent = `${suggestion.create ? "＋ 创建" : "#"} ${suggestion.tag}`;
    const detail = createHTML("small");
    detail.textContent = suggestion.create ? "新标签" : "添加到全部";
    button.append(label, detail);
    return button;
  }));

  const expanded = suggestionsOpen && suggestions.length > 0;
  suggestionBox.hidden = !expanded;
  search.setAttribute("aria-expanded", String(expanded));
  if (expanded) search.setAttribute("aria-activedescendant", `tag-editor-suggestion-${activeSuggestion}`);
  else search.removeAttribute("aria-activedescendant");
  if (expanded) {
    const active = suggestionBox.children[activeSuggestion] as HTMLElement | undefined;
    if (active) {
      const top = active.offsetTop;
      if (top < suggestionBox.scrollTop) suggestionBox.scrollTop = top;
      else if (top + active.offsetHeight > suggestionBox.scrollTop + suggestionBox.clientHeight) {
        suggestionBox.scrollTop = top + active.offsetHeight - suggestionBox.clientHeight;
      }
    }
  }
}

function renderTags(): void {
  const allNames = [...new Set([...names(base), ...names(draft)])].sort((a, b) => a.localeCompare(b, "zh-CN"));
  byId("tag-total").textContent = `${names(draft).length} 个标签`;
  if (!selectedNameIsVisible()) selectedTag = allNames[0] || null;

  if (!allNames.length) {
    const empty = createHTML("p");
    empty.className = "empty";
    empty.textContent = "暂无标签，可在上方添加。";
    tagsBox.replaceChildren(empty);
    renderInspector();
    return;
  }

  tagsBox.replaceChildren(...allNames.map(tagName => {
    const before = count(base, tagName);
    const after = count(draft, tagName);
    const draftByID = new Map(draft.map(item => [item.id, item]));
    const tagChanged = base.some(item => {
      const oldTag = item.tags.find(tag => tag.tag === tagName);
      const newTag = draftByID.get(item.id)?.tags.find(tag => tag.tag === tagName);
      const oldState = oldTag ? oldTag.type ?? 0 : null;
      const newState = newTag ? newTag.type ?? 0 : null;
      return oldState !== newState;
    });
    const button = makeButton("", `tag-chip${after === 0 ? " removed" : ""}`);
    button.dataset.tag = tagName;
    button.setAttribute("aria-pressed", String(selectedTag === tagName));

    const color = bridge.colors[tagName];
    if (color) {
      const dot = createHTML("span");
      dot.className = "color-dot";
      dot.style.setProperty("--tag-color", color);
      dot.setAttribute("aria-label", "彩色标签");
      button.append(dot);
    }

    const label = createHTML("span");
    label.className = "tag-name";
    label.textContent = tagName;
    const tagCount = createHTML("span");
    tagCount.className = "tag-count";
    tagCount.textContent = `${after}/${draft.length}`;
    button.append(label, tagCount);

    const auto = automaticCount(draft, tagName);
    if (auto) {
      const mark = createHTML("span");
      mark.className = "auto-mark";
      mark.textContent = auto === after ? "自动" : "含自动";
      button.append(mark);
    }

    if (tagChanged) {
      const state = createHTML("span");
      state.className = "tag-state";
      state.textContent = after === 0 ? "待移除" : before === 0 ? "待添加" : "待更新";
      button.append(state);
    }
    return button;
  }));
  renderInspector();
}

function renderInspector(): void {
  inspector.replaceChildren();
  if (!selectedTag) {
    inspector.hidden = false;
    const hint = createHTML("span");
    hint.className = "subtle";
    hint.textContent = "选择标签后可应用到全部、改名或移除。";
    inspector.append(hint);
    return;
  }
  inspector.hidden = false;
  const tagName = selectedTag;
  const before = count(base, tagName);
  const after = count(draft, tagName);
  const auto = automaticCount(draft, tagName);

  const selected = createHTML("div");
  selected.className = "selected-name";
  const heading = createHTML("div");
  heading.className = "selected-heading";
  const caption = createHTML("span");
  caption.className = "selected-caption";
  caption.textContent = "已选标签";
  const name = createHTML("span");
  name.className = "selected-tag";
  name.textContent = tagName;
  name.title = tagName;
  heading.append(caption, name);
  const detail = createHTML("div");
  detail.className = "subtle";
  detail.textContent = `${after}/${draft.length} 篇具有此标签${before !== after ? ` · 原为 ${before}/${draft.length}` : ""}${auto ? " · 含自动标签" : ""}`;
  selected.append(heading, detail);

  const operations = createHTML("div");
  operations.className = "operations";
  const fill = makeButton(after === draft.length ? "全部已有" : "应用到全部");
  fill.dataset.action = "fill";
  fill.disabled = busy || after === draft.length;
  const rename = makeButton("改名");
  rename.dataset.action = "rename";
  rename.disabled = busy || after === 0;
  const remove = makeButton("移除", "button small danger");
  remove.dataset.action = "remove";
  remove.disabled = busy || after === 0;
  operations.append(fill, rename, remove);
  inspector.append(selected, operations);

  if (renaming === tagName) {
    const row = createHTML("div");
    row.className = "rename-row";
    const input = createHTML("input");
    input.id = "rename-input";
    input.setAttribute("aria-label", "新的标签名称");
    input.maxLength = 255;
    input.value = tagName;
    const confirm = makeButton("确认改名");
    confirm.dataset.action = "confirm-rename";
    const cancel = makeButton("取消", "text-button");
    cancel.dataset.action = "cancel-rename";
    const note = createHTML("span");
    note.className = "subtle rename-note";
    note.id = "rename-feedback";
    note.textContent = `仅修改具有此标签的 ${after} 篇文献；同名标签自动合并。`;
    row.append(input, confirm, cancel, note);
    inspector.append(row);
  }
}

function renderMessage(): void {
  message.replaceChildren();
  if (!messageKind) {
    message.hidden = true;
    return;
  }
  message.hidden = false;
  const text = createHTML("p");
  const actions = createHTML("div");
  actions.className = "message-actions";
  const stay = makeButton("继续编辑");
  stay.dataset.messageAction = "stay";
  actions.append(stay);

  if (messageKind === "discard") {
    text.textContent = "放弃尚未保存的修改？";
    const proceed = makeButton("放弃修改", "button small danger");
    proceed.dataset.messageAction = "discard";
    actions.append(proceed);
  } else if (messageKind === "reload") {
    text.textContent = notice || "重新载入将放弃当前草稿。";
    const proceed = makeButton("放弃草稿并重新载入");
    proceed.dataset.messageAction = "reload";
    actions.append(proceed);
  } else if (messageKind === "undo-dirty") {
    text.textContent = "请先保存或放弃当前编辑，再撤销上次保存。";
    const discard = makeButton("放弃草稿并撤销", "button small danger");
    discard.dataset.messageAction = "discard-and-undo";
    actions.append(discard);
  } else {
    text.textContent = notice || "上次保存涉及的标签后来发生了变化，无法安全撤销。";
    stay.textContent = "知道了";
  }
  message.append(text, actions);
}

function renderControls(): void {
  const delta = changes(base, draft);
  byId("change-summary").textContent = delta.itemCount ? `将修改 ${delta.itemCount} 篇文献` : "尚无修改";
  byId("change-detail").textContent = delta.itemCount
    ? `添加 ${delta.added} 处 · 移除 ${delta.removed} 处${delta.typeChanged ? ` · 类型更新 ${delta.typeChanged} 处` : ""}`
    : "其他标签保持不变";

  byId<HTMLButtonElement>("save").disabled = busy || !delta.itemCount;
  byId<HTMLButtonElement>("undo-step").disabled = busy || !history.length;
  byId<HTMLButtonElement>("reset").disabled = busy || !isDirty();
  byId<HTMLButtonElement>("cancel").disabled = busy;
  byId<HTMLButtonElement>("close").disabled = busy;
  const undoCount = bridge.undoCount();
  const undoSave = byId<HTMLButtonElement>("undo-save");
  undoSave.disabled = busy || undoCount <= 0;
  undoSave.textContent = undoCount > 0 ? `撤销上次保存（${undoCount} 篇）` : "撤销上次保存";
}

function render(): void {
  renderHeader();
  renderSuggestions();
  renderTags();
  renderMessage();
  renderControls();
  announcement.textContent = notice;
}

function addNamedTag(rawName: string): void {
  if (busy) return;
  try {
    fieldFeedback("search-feedback", "");
    const tagName = validateTagName(rawName);
    selectedTag = tagName;
    mutate(addTag(draft, tagName), "已加入待保存修改。");
    search.value = "";
    closeSuggestions();
    activeSuggestion = 0;
    renderSuggestions();
    search.focus();
  } catch (error) {
    fieldFeedback("search-feedback", errorText(error), "error");
  }
}

function beginRename(): void {
  if (!selectedTag) return;
  renaming = selectedTag;
  renderInspector();
  const input = document.getElementById("rename-input") as HTMLInputElement | null;
  input?.focus();
  input?.select();
}

function confirmRename(): void {
  if (!selectedTag) return;
  const input = document.getElementById("rename-input") as HTMLInputElement | null;
  try {
    const newName = validateTagName(input?.value || "");
    if (newName === selectedTag) {
      renaming = null;
      renderInspector();
      return;
    }
    const oldName = selectedTag;
    selectedTag = newName;
    mutate(renameTag(draft, oldName, newName), "已改名；已有的同名标签将在保存时合并。");
  } catch (error) {
    fieldFeedback("rename-feedback", errorText(error), "error");
    input?.focus();
  }
}

function requestClose(): void {
  if (busy) return;
  if (isDirty()) {
    messageKind = "discard";
    renderMessage();
    return;
  }
  allowClose = true;
  window.close();
}

async function reloadFromBridge(): Promise<void> {
  setBusy(true);
  try {
    const latest = await bridge.reload();
    base = cloneItems(latest);
    draft = cloneItems(latest);
    history = [];
    renaming = null;
    messageKind = null;
    notice = "已重新载入最新标签。";
  } catch (error) {
    messageKind = "reload";
    notice = `重新载入失败：${errorText(error)}`;
  } finally {
    setBusy(false);
    render();
    search.focus();
  }
}

async function save(): Promise<void> {
  if (busy || !isDirty()) return;
  if (renaming) {
    fieldFeedback("rename-feedback", "请先确认或取消当前改名。", "error");
    return;
  }
  setBusy(true);
  try {
    await bridge.save(cloneItems(base), cloneItems(draft));
    allowClose = true;
    window.close();
  } catch (error) {
    const prefix = errorName(error) === "ConflictError" ? "目标文献的标签已变化" : "保存未完成";
    notice = `${prefix}：${errorText(error)}`;
    messageKind = "reload";
  } finally {
    if (!allowClose) {
      setBusy(false);
      render();
    }
  }
}

async function undoSaved(discardDraft = false): Promise<void> {
  if (busy || bridge.undoCount() <= 0) return;
  if (isDirty() && !discardDraft) {
    messageKind = "undo-dirty";
    renderMessage();
    return;
  }
  setBusy(true);
  try {
    const restored = await bridge.undo();
    const restoredByID = new Map(restored.map(item => [item.id, item]));
    const local = base.map(item => {
      const replacement = restoredByID.get(item.id);
      return replacement?.libraryID === item.libraryID ? cloneItems([replacement])[0] : item;
    });
    base = cloneItems(local);
    draft = cloneItems(local);
    history = [];
    renaming = null;
    messageKind = null;
    notice = `已撤销上次保存，恢复 ${restored.length} 篇文献。`;
    try {
      const latest = await bridge.reload();
      base = cloneItems(latest);
      draft = cloneItems(latest);
    } catch (reloadError) {
      notice += ` 当前选择未能完整刷新：${errorText(reloadError)}`;
    }
  } catch (error) {
    messageKind = "undo-error";
    notice = `无法撤销上次保存：${errorText(error)}`;
  } finally {
    setBusy(false);
    render();
  }
}

search.addEventListener("input", () => {
  if (busy) return;
  activeSuggestion = 0;
  suggestionsOpen = true;
  fieldFeedback("search-feedback", "");
  renderSuggestions();
});

search.addEventListener("focus", () => {
  suggestionsOpen = true;
  renderSuggestions();
});
document.addEventListener("pointerdown", event => {
  if (!(event.target as HTMLElement).closest(".search-row")) closeSuggestions();
});
document.addEventListener("focusin", event => {
  if (!(event.target as HTMLElement).closest(".search-row")) closeSuggestions();
});

search.addEventListener("keydown", event => {
  if (busy || event.isComposing || event.ctrlKey || event.metaKey || !suggestions.length) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    if (suggestionsOpen) activeSuggestion = (activeSuggestion + direction + suggestions.length) % suggestions.length;
    suggestionsOpen = true;
    renderSuggestions();
  } else if (event.key === "Enter") {
    event.preventDefault();
    addNamedTag(suggestionsOpen ? suggestions[activeSuggestion]?.tag || search.value : search.value);
  }
});

addButton.addEventListener("click", () => addNamedTag(search.value));
suggestionBox.addEventListener("click", event => {
  if (busy) return;
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-index]");
  if (!target) return;
  addNamedTag(suggestions[Number(target.dataset.index)]?.tag || "");
});

tagsBox.addEventListener("click", event => {
  if (busy) return;
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-tag]");
  if (!target) return;
  selectedTag = target.dataset.tag || null;
  renaming = null;
  renderTags();
});

inspector.addEventListener("click", event => {
  if (busy) return;
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
  if (!target || !selectedTag) return;
  switch (target.dataset.action) {
    case "fill":
      mutate(addTag(draft, selectedTag), "已补齐到全部所选文献，保存后生效。");
      break;
    case "remove":
      mutate(removeTag(draft, selectedTag), "已从所选文献移除，保存后生效。");
      break;
    case "rename":
      beginRename();
      break;
    case "confirm-rename":
      confirmRename();
      break;
    case "cancel-rename":
      renaming = null;
      renderInspector();
      break;
  }
});

inspector.addEventListener("keydown", event => {
  if (busy || event.isComposing || event.key !== "Enter" || event.ctrlKey || event.metaKey) return;
  if ((event.target as HTMLElement).id === "rename-input") {
    event.preventDefault();
    confirmRename();
  }
});

byId("undo-step").addEventListener("click", () => {
  if (busy) return;
  const previous = history.pop();
  if (!previous) return;
  draft = previous;
  renaming = null;
  messageKind = null;
  notice = "已撤销上一步。";
  render();
});

byId("reset").addEventListener("click", () => {
  if (busy || !isDirty()) return;
  history.push(cloneItems(draft));
  draft = cloneItems(base);
  renaming = null;
  messageKind = null;
  notice = "已重置为打开窗口时的标签。";
  render();
});

message.addEventListener("click", event => {
  if (busy) return;
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-message-action]");
  if (!target) return;
  switch (target.dataset.messageAction) {
    case "stay":
      messageKind = null;
      renderMessage();
      break;
    case "discard":
      draft = cloneItems(base);
      allowClose = true;
      window.close();
      break;
    case "reload":
      void reloadFromBridge();
      break;
    case "discard-and-undo":
      draft = cloneItems(base);
      void undoSaved(true);
      break;
  }
});

byId("save").addEventListener("click", () => void save());
byId("undo-save").addEventListener("click", () => void undoSaved());
byId("cancel").addEventListener("click", requestClose);
byId("close").addEventListener("click", requestClose);

const shortcutInput = byId<HTMLInputElement>("shortcut");
shortcutInput.addEventListener("keydown", event => {
  if (event.key === "Tab") return;
  event.preventDefault();
  event.stopPropagation();
  if (busy || event.isComposing || event.repeat) return;
  if (event.key === "Escape") {
    shortcutInput.value = bridge.getShortcut();
    fieldFeedback("shortcut-hint", "点击后按组合键");
    return;
  }
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;
  const key = event.key.toUpperCase();
  if (!(event.ctrlKey || event.altKey || event.metaKey) || !/^(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4]))$/.test(key)) {
    fieldFeedback("shortcut-hint", "使用 Ctrl / Alt 加字母、数字或 F 键", "error");
    return;
  }
  shortcutInput.value = [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta", key].filter(Boolean).join("+");
  fieldFeedback("shortcut-hint", "待应用 · Esc 恢复");
});

byId("save-shortcut").addEventListener("click", () => {
  if (busy) return;
  const input = byId<HTMLInputElement>("shortcut");
  try {
    bridge.setShortcut(input.value.trim());
    input.value = bridge.getShortcut();
    fieldFeedback("shortcut-hint", "✓ 已生效", "success");
  } catch (error) {
    fieldFeedback("shortcut-hint", errorText(error), "error");
  }
});

document.addEventListener("keydown", event => {
  if (event.isComposing) return;
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void save();
    return;
  }
  if (event.key !== "Escape") return;
  event.preventDefault();
  if (suggestionsOpen && !suggestionBox.hidden) {
    closeSuggestions();
  } else if (renaming) {
    renaming = null;
    renderInspector();
    search.focus();
  } else if (messageKind) {
    messageKind = null;
    renderMessage();
  } else {
    requestClose();
  }
});

window.addEventListener("beforeunload", event => {
  if (!allowClose && (busy || isDirty())) {
    event.preventDefault();
    event.returnValue = "";
  }
});

// Add-on shutdown must not be blocked by an unsaved editor draft.
window.addEventListener("zotero-tag-editor-shutdown", () => {
  allowClose = true;
});

window.addEventListener("zotero-tag-editor-retarget", event => {
  if (busy || (isDirty() && !window.confirm("当前标签修改尚未保存。放弃这些修改，切换到新选中的文献？\n选择取消可继续编辑原来的文献。"))) {
    event.preventDefault();
    return;
  }
  const request = (event as CustomEvent<{ bridge: EditorBridge; accepted: boolean }>).detail;
  bridge = request.bridge;
  base = cloneItems(bridge.initialItems);
  draft = cloneItems(base);
  history = [];
  selectedTag = null;
  renaming = null;
  messageKind = null;
  notice = "";
  search.value = "";
  activeSuggestion = 0;
  closeSuggestions();
  fieldFeedback("search-feedback", "");
  fieldFeedback("shortcut-hint", "点击后按组合键");
  shortcutInput.value = bridge.getShortcut();
  byId("target-summary").parentElement?.removeAttribute("open");
  render();
  tagsBox.scrollTop = 0;
  search.focus();
  request.accepted = true;
});

byId<HTMLInputElement>("shortcut").value = bridge.getShortcut();
render();
window.setTimeout(() => search.focus(), 0);
