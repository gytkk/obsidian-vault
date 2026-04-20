import type { TFile } from 'obsidian';

export const DATA_VERSION = 1;
export const NAME_COLUMN_ID = '__name__';

export type ColumnType = 'text' | 'checkbox' | 'single-select' | 'multi-select' | 'relation';

export interface RelationConfig {
  tableId: string;
  displayField: string;
}

export interface ColumnSchema {
  id: string;
  name: string;
  type: ColumnType;
  hidden: boolean;
  options: string[];
  relation: RelationConfig | null;
}

export interface TableSchema {
  id: string;
  sourceFolder: string;
  columns: ColumnSchema[];
  defaultViewId: string;
}

export interface SortState {
  columnId: string;
  direction: 'asc' | 'desc';
}

export interface TableViewDefinition {
  id: string;
  tableId: string;
  name: string;
  columnOrder: string[];
  sort: SortState | null;
}

export interface PageItem {
  viewId: string;
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
}

export interface PageLayout {
  id: string;
  name: string;
  items: PageItem[];
}

export interface PluginData {
  version: number;
  tables: Record<string, TableSchema>;
  views: Record<string, TableViewDefinition>;
  pages: Record<string, PageLayout>;
  folderToTableId: Record<string, string>;
  recentViewIds: string[];
}

export interface RowRecord {
  file: TFile;
  filePath: string;
  name: string;
  values: Record<string, unknown>;
}

export function createEmptyPluginData(): PluginData {
  return {
    version: DATA_VERSION,
    tables: {},
    views: {},
    pages: {},
    folderToTableId: {},
    recentViewIds: [],
  };
}
