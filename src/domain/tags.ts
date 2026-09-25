import type { ItemSnapshot, Tag } from '../types';

/** Treat Zotero's omitted type and explicit manual type 0 identically. */
function tagType(tag: Tag): number {
  return tag.type ?? 0;
}

export function cloneItems(items: ItemSnapshot[]): ItemSnapshot[] {
  return items.map(item => ({ ...item, tags: item.tags.map(tag => ({ ...tag })) }));
}

/** Ordering is irrelevant; type changes remain visible to conflict detection. */
export function signature(tags: Tag[]): string {
  return JSON.stringify(tags.map(tag => [tag.tag, tagType(tag)] as const)
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
}

export function sameItems(a: ItemSnapshot[], b: ItemSnapshot[]): boolean {
  if (a.length !== b.length) return false;
  const byID = new Map(b.map(item => [item.id, item]));
  if (byID.size !== b.length || new Set(a.map(item => item.id)).size !== a.length) return false;
  return a.every(item => {
    const other = byID.get(item.id);
    return !!other && other.libraryID === item.libraryID && signature(item.tags) === signature(other.tags);
  });
}

export function validateTagName(input: string): string {
  const name = input.trim().normalize();
  if (!name) throw new Error('请输入标签名称。');
  if (/[\u0000-\u001f\u007f]/u.test(name)) throw new Error('标签名称不能包含换行或控制字符。');
  if (name.length > 255) throw new Error('标签名称不能超过 255 个字符。');
  return name;
}

/** Add only where absent. Existing automatic tags keep their original type. */
export function addTag(items: ItemSnapshot[], input: string): ItemSnapshot[] {
  const name = validateTagName(input);
  const next = cloneItems(items);
  for (const item of next) {
    if (!item.tags.some(tag => tag.tag === name)) item.tags.push({ tag: name, type: 0 });
  }
  return next;
}

export function removeTag(items: ItemSnapshot[], name: string): ItemSnapshot[] {
  return cloneItems(items).map(item => ({ ...item, tags: item.tags.filter(tag => tag.tag !== name) }));
}

/** Rename only on items that contain the source; merge any destination as manual. */
export function renameTag(items: ItemSnapshot[], oldName: string, input: string): ItemSnapshot[] {
  const newName = validateTagName(input);
  if (oldName === newName) return cloneItems(items);
  return cloneItems(items).map(item => {
    if (!item.tags.some(tag => tag.tag === oldName)) return item;
    return {
      ...item,
      tags: [...item.tags.filter(tag => tag.tag !== oldName && tag.tag !== newName), { tag: newName, type: 0 }],
    };
  });
}

/** A draft cannot change the selected item set or move items between libraries. */
export function assertSameTargets(base: ItemSnapshot[], draft: ItemSnapshot[]): void {
  const targets = new Map(base.map(item => [item.id, item.libraryID]));
  if (targets.size !== base.length || draft.length !== base.length
    || new Set(draft.map(item => item.id)).size !== draft.length
    || draft.some(item => targets.get(item.id) !== item.libraryID)) {
    throw new Error('目标条目发生变化，请重新打开标签编辑窗口。');
  }
}

export function changes(base: ItemSnapshot[], draft: ItemSnapshot[]): {
  itemCount: number; added: number; removed: number; typeChanged: number;
} {
  assertSameTargets(base, draft);
  const result = { itemCount: 0, added: 0, removed: 0, typeChanged: 0 };
  const originals = new Map(base.map(item => [item.id, item]));
  for (const item of draft) {
    const original = originals.get(item.id)!;
    if (signature(original.tags) !== signature(item.tags)) result.itemCount++;
    const oldTags = new Map(original.tags.map(tag => [tag.tag, tagType(tag)]));
    const newTags = new Map(item.tags.map(tag => [tag.tag, tagType(tag)]));
    for (const [name, type] of newTags) {
      if (!oldTags.has(name)) result.added++;
      else if (oldTags.get(name) !== type) result.typeChanged++;
    }
    for (const name of oldTags.keys()) if (!newTags.has(name)) result.removed++;
  }
  return result;
}
