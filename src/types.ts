export interface Tag {
  tag: string;
  type?: number;
}

export interface ItemSnapshot {
  id: number;
  libraryID: number;
  title: string;
  tags: Tag[];
}

export interface EditorBridge {
  initialItems: ItemSnapshot[];
  availableTags: string[];
  colors: Record<string, string>;
  context: 'library' | 'reader';
  save(base: ItemSnapshot[], draft: ItemSnapshot[]): Promise<void>;
  reload(): Promise<ItemSnapshot[]>;
  undo(): Promise<ItemSnapshot[]>;
  undoCount(): number;
  getShortcut(): string;
  setShortcut(value: string): void;
}
