import {
  createEmptyPluginData,
  type ColumnSchema,
  type ColumnType,
  type PageItem,
  type PageLayout,
  type PluginData,
  type TableSchema,
  type TableViewDefinition,
} from './models';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeFolderPath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '').trim();
}

export function generateId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function normalizeColumnName(name: string): string {
  return name.trim();
}

function matchesColumnName(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

function sanitizePageItem(raw: unknown): PageItem | null {
  if (!isRecord(raw)) return null;
  const viewId = typeof raw['viewId'] === 'string' ? raw['viewId'] : '';
  if (!viewId) return null;

  const positionValue = raw['position'];
  const position = isRecord(positionValue)
    && typeof positionValue['x'] === 'number'
    && typeof positionValue['y'] === 'number'
    && typeof positionValue['width'] === 'number'
    && typeof positionValue['height'] === 'number'
    ? {
      x: positionValue['x'],
      y: positionValue['y'],
      width: positionValue['width'],
      height: positionValue['height'],
    }
    : null;

  return { viewId, position };
}

function sanitizePage(raw: unknown): PageLayout | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw['id'] === 'string' ? raw['id'] : '';
  const name = typeof raw['name'] === 'string' ? raw['name'] : '';
  if (!id || !name) return null;

  const items = Array.isArray(raw['items'])
    ? raw['items'].map((item) => sanitizePageItem(item)).filter((item): item is PageItem => item !== null)
    : [];

  return { id, name, items };
}

function sanitizeView(raw: unknown): TableViewDefinition | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw['id'] === 'string' ? raw['id'] : '';
  const tableId = typeof raw['tableId'] === 'string' ? raw['tableId'] : '';
  const name = typeof raw['name'] === 'string' ? raw['name'] : '';
  if (!id || !tableId || !name) return null;

  const columnOrder = Array.isArray(raw['columnOrder'])
    ? raw['columnOrder'].filter((columnId): columnId is string => typeof columnId === 'string')
    : [];
  const sortValue = raw['sort'];
  let sort = null;
  if (isRecord(sortValue)
    && typeof sortValue['columnId'] === 'string'
    && (sortValue['direction'] === 'asc' || sortValue['direction'] === 'desc')) {
    sort = {
      columnId: sortValue['columnId'],
      direction: sortValue['direction'],
    } as const;
  }

  return { id, tableId, name, columnOrder, sort };
}

function sanitizeTable(raw: unknown): TableSchema | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw['id'] === 'string' ? raw['id'] : '';
  const sourceFolder = typeof raw['sourceFolder'] === 'string' ? normalizeFolderPath(raw['sourceFolder']) : '';
  const defaultViewId = typeof raw['defaultViewId'] === 'string' ? raw['defaultViewId'] : '';
  const columns = Array.isArray(raw['columns'])
    ? raw['columns'].filter((column): column is TableSchema['columns'][number] => isRecord(column)
      && typeof column['id'] === 'string'
      && typeof column['name'] === 'string'
      && (column['type'] === 'text'
        || column['type'] === 'checkbox'
        || column['type'] === 'single-select'
        || column['type'] === 'multi-select'
        || column['type'] === 'relation')
      && typeof column['hidden'] === 'boolean'
      && Array.isArray(column['options'])
      && column['options'].every((option) => typeof option === 'string')
      && (column['relation'] === null || (isRecord(column['relation'])
        && typeof column['relation']['tableId'] === 'string'
        && typeof column['relation']['displayField'] === 'string')))
      .map((column) => ({
        id: column['id'] as string,
        name: column['name'] as string,
        type: column['type'] as TableSchema['columns'][number]['type'],
        hidden: column['hidden'] as boolean,
        options: (column['options'] as string[]).map((option) => option.trim()).filter(Boolean),
        relation: column['relation'] === null
          ? null
          : {
            tableId: (column['relation'] as unknown as Record<string, unknown>)['tableId'] as string,
            displayField: (column['relation'] as unknown as Record<string, unknown>)['displayField'] as string,
          },
      }))
    : [];

  if (!id || !sourceFolder) return null;
  return { id, sourceFolder, defaultViewId, columns };
}

function createDefaultView(tableId: string, name = 'Default view'): TableViewDefinition {
  return {
    id: generateId('view'),
    tableId,
    name,
    columnOrder: [],
    sort: null,
  };
}

export function sanitizePluginData(raw: unknown): PluginData {
  const data = createEmptyPluginData();
  if (!isRecord(raw)) return data;

  if (isRecord(raw['tables'])) {
    for (const [tableId, tableValue] of Object.entries(raw['tables'])) {
      const table = sanitizeTable(tableValue);
      if (!table) continue;
      data.tables[tableId] = table;
    }
  }

  if (isRecord(raw['views'])) {
    for (const [viewId, viewValue] of Object.entries(raw['views'])) {
      const view = sanitizeView(viewValue);
      if (!view) continue;
      data.views[viewId] = view;
    }
  }

  if (isRecord(raw['pages'])) {
    for (const [pageId, pageValue] of Object.entries(raw['pages'])) {
      const page = sanitizePage(pageValue);
      if (!page) continue;
      data.pages[pageId] = page;
    }
  }

  if (isRecord(raw['folderToTableId'])) {
    for (const [folderPath, tableId] of Object.entries(raw['folderToTableId'])) {
      if (typeof tableId !== 'string' || !data.tables[tableId]) continue;
      data.folderToTableId[normalizeFolderPath(folderPath)] = tableId;
    }
  }

  data.recentViewIds = Array.isArray(raw['recentViewIds'])
    ? raw['recentViewIds'].filter((viewId): viewId is string => typeof viewId === 'string' && !!data.views[viewId])
    : [];

  for (const table of Object.values(data.tables)) {
    data.folderToTableId[table.sourceFolder] = table.id;
    const defaultView = table.defaultViewId ? data.views[table.defaultViewId] : null;
    if (!defaultView) {
      const nextView = createDefaultView(table.id);
      table.defaultViewId = nextView.id;
      data.views[nextView.id] = nextView;
    }
    syncViewColumnOrder(table, data.views[table.defaultViewId]!);
  }

  return data;
}

export function ensureTableForFolder(data: PluginData, folderPath: string): {
  table: TableSchema;
  view: TableViewDefinition;
  created: boolean;
} {
  const normalizedPath = normalizeFolderPath(folderPath);
  const existingTableId = data.folderToTableId[normalizedPath];
  const existingTable = existingTableId ? data.tables[existingTableId] : null;
  if (existingTable) {
    const existingView = data.views[existingTable.defaultViewId] ?? createDefaultView(existingTable.id);
    data.views[existingView.id] = existingView;
    existingTable.defaultViewId = existingView.id;
    syncViewColumnOrder(existingTable, existingView);
    return { table: existingTable, view: existingView, created: false };
  }

  const tableId = generateId('table');
  const defaultView = createDefaultView(tableId);
  const table: TableSchema = {
    id: tableId,
    sourceFolder: normalizedPath,
    columns: [],
    defaultViewId: defaultView.id,
  };

  data.tables[tableId] = table;
  data.views[defaultView.id] = defaultView;
  data.folderToTableId[normalizedPath] = tableId;

  return { table, view: defaultView, created: true };
}

export function syncViewColumnOrder(table: TableSchema, view: TableViewDefinition): boolean {
  const knownIds = new Set(table.columns.map((column) => column.id));
  const nextOrder = view.columnOrder.filter((columnId) => knownIds.has(columnId));
  for (const column of table.columns) {
    if (!nextOrder.includes(column.id)) {
      nextOrder.push(column.id);
    }
  }

  const changed = nextOrder.length !== view.columnOrder.length
    || nextOrder.some((columnId, index) => view.columnOrder[index] !== columnId);

  if (changed) {
    view.columnOrder = nextOrder;
  }

  if (view.sort && view.sort.columnId !== '__name__' && !knownIds.has(view.sort.columnId)) {
    view.sort = null;
    return true;
  }

  return changed;
}

export function rememberRecentView(data: PluginData, viewId: string): void {
  data.recentViewIds = [viewId, ...data.recentViewIds.filter((candidate) => candidate !== viewId)].slice(0, 10);
}

export function getTableAndView(data: PluginData, viewId: string): {
  table: TableSchema;
  view: TableViewDefinition;
} | null {
  const view = data.views[viewId];
  if (!view) return null;
  const table = data.tables[view.tableId];
  if (!table) return null;
  syncViewColumnOrder(table, view);
  return { table, view };
}

export function renameTableSourceFolder(data: PluginData, oldPath: string, newPath: string): boolean {
  const oldNormalized = normalizeFolderPath(oldPath);
  const newNormalized = normalizeFolderPath(newPath);
  const tableId = data.folderToTableId[oldNormalized];
  if (!tableId) return false;

  const table = data.tables[tableId];
  if (!table) return false;

  delete data.folderToTableId[oldNormalized];
  table.sourceFolder = newNormalized;
  data.folderToTableId[newNormalized] = table.id;
  return true;
}

export function getOrderedColumns(table: TableSchema, view: TableViewDefinition, includeHidden = false): ColumnSchema[] {
  syncViewColumnOrder(table, view);
  const columnsById = new Map(table.columns.map((column) => [column.id, column]));
  const ordered = view.columnOrder
    .map((columnId) => columnsById.get(columnId))
    .filter((column): column is ColumnSchema => column !== undefined);

  return includeHidden ? ordered : ordered.filter((column) => !column.hidden);
}

export function findColumnById(table: TableSchema, columnId: string): ColumnSchema | null {
  return table.columns.find((column) => column.id === columnId) ?? null;
}

export function addColumn(
  table: TableSchema,
  view: TableViewDefinition,
  input: {
    name: string;
    type: ColumnType;
  },
): { status: 'added' | 'restored' | 'invalid' | 'conflict'; column?: ColumnSchema } {
  const nextName = normalizeColumnName(input.name);
  if (!nextName || matchesColumnName(nextName, 'Name')) {
    return { status: 'invalid' };
  }

  const existing = table.columns.find((column) => matchesColumnName(column.name, nextName));
  if (existing) {
    if (existing.hidden) {
      existing.hidden = false;
      syncViewColumnOrder(table, view);
      return { status: 'restored', column: existing };
    }
    return { status: 'conflict', column: existing };
  }

  const column: ColumnSchema = {
    id: generateId('column'),
    name: nextName,
    type: input.type,
    hidden: false,
    options: [],
    relation: null,
  };
  table.columns.push(column);
  syncViewColumnOrder(table, view);
  return { status: 'added', column };
}

export function renameColumn(
  table: TableSchema,
  columnId: string,
  nextNameInput: string,
): { status: 'renamed' | 'invalid' | 'conflict'; column?: ColumnSchema; previousName?: string } {
  const column = findColumnById(table, columnId);
  if (!column) return { status: 'invalid' };

  const nextName = normalizeColumnName(nextNameInput);
  if (!nextName || matchesColumnName(nextName, 'Name')) {
    return { status: 'invalid' };
  }

  const conflict = table.columns.find((candidate) => candidate.id !== columnId && matchesColumnName(candidate.name, nextName));
  if (conflict) {
    return { status: 'conflict', column: conflict };
  }

  if (column.name === nextName) {
    return { status: 'renamed', column, previousName: column.name };
  }

  const previousName = column.name;
  column.name = nextName;
  return { status: 'renamed', column, previousName };
}

export function setColumnHidden(table: TableSchema, columnId: string, hidden: boolean): boolean {
  const column = findColumnById(table, columnId);
  if (!column || column.hidden === hidden) return false;
  column.hidden = hidden;
  return true;
}

export function reorderColumn(view: TableViewDefinition, columnId: string, targetIndex: number): boolean {
  const currentIndex = view.columnOrder.indexOf(columnId);
  if (currentIndex === -1 || currentIndex === targetIndex) return false;

  const nextOrder = [...view.columnOrder];
  const [moved] = nextOrder.splice(currentIndex, 1);
  if (!moved) return false;

  const boundedIndex = Math.max(0, Math.min(targetIndex, nextOrder.length));
  nextOrder.splice(boundedIndex, 0, moved);
  view.columnOrder = nextOrder;
  return true;
}
