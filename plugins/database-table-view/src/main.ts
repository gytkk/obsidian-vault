import {
  App,
  FuzzySuggestModal,
  ItemView,
  Notice,
  Plugin,
  TAbstractFile,
  TFolder,
  WorkspaceLeaf,
} from 'obsidian';

import {
  createRowFile,
  deleteRowFile,
  loadRows,
  renameColumnProperty,
  renameRowFile,
  updateColumnValue,
  validateRowName,
} from './frontmatter';
import {
  NAME_COLUMN_ID,
  createEmptyPluginData,
  type ColumnSchema,
  type ColumnType,
  type PluginData,
  type RowRecord,
  type SortState,
  type TableSchema,
  type TableViewDefinition,
} from './models';
import {
  addColumn,
  ensureTableForFolder,
  getOrderedColumns,
  getTableAndView,
  rememberRecentView,
  renameColumn,
  renameTableSourceFolder,
  reorderColumn,
  sanitizePluginData,
  setColumnHidden,
} from './store';

const VIEW_TYPE = 'database-table-view';
const REFRESH_DEBOUNCE_MS = 250;

interface DraftRowState {
  key: string;
  name: string;
}

function getColumnTypeLabel(type: ColumnType): string {
  switch (type) {
    case 'text':
      return 'Text';
    case 'checkbox':
      return 'Checkbox';
    case 'single-select':
      return 'Single select';
    case 'multi-select':
      return 'Multi select';
    case 'relation':
      return 'Relation';
    default:
      return type;
  }
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
  private readonly folders: TFolder[];

  constructor(
    app: App,
    private readonly onChoose: (folder: TFolder) => void,
  ) {
    super(app);
    this.setPlaceholder('Choose a folder to open as a table');
    this.folders = app.vault.getAllLoadedFiles()
      .filter((entry): entry is TFolder => entry instanceof TFolder && entry.path.length > 0)
      .sort((left, right) => left.path.localeCompare(right.path, 'ko'));
  }

  getItems(): TFolder[] {
    return this.folders;
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.onChoose(folder);
  }
}

class DatabaseTableView extends ItemView {
  private currentViewId: string | null = null;
  private draftRow: DraftRowState | null = null;
  private refreshTimeout: ReturnType<typeof setTimeout> | null = null;
  private isRendering = false;
  private pendingRender = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: DatabaseTableViewPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Database Table';
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('dtv-view');
    if (!this.currentViewId && this.plugin.data.recentViewIds[0]) {
      this.currentViewId = this.plugin.data.recentViewIds[0] ?? null;
    }
    await this.render();
  }

  async onClose(): Promise<void> {
    if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
  }

  getState(): Record<string, unknown> {
    return { viewId: this.currentViewId };
  }

  async setState(state: unknown): Promise<void> {
    const viewId = state && typeof state === 'object' && 'viewId' in state && typeof (state as Record<string, unknown>)['viewId'] === 'string'
      ? (state as Record<string, unknown>)['viewId'] as string
      : null;
    this.currentViewId = viewId;
    await this.render();
  }

  async openView(viewId: string): Promise<void> {
    this.currentViewId = viewId;
    this.plugin.rememberRecentView(viewId);
    await this.leaf.setViewState({
      type: VIEW_TYPE,
      active: true,
      state: this.getState(),
    });
    await this.render();
  }

  requestRefresh(): void {
    if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
    this.refreshTimeout = setTimeout(() => {
      void this.render();
    }, REFRESH_DEBOUNCE_MS);
  }

  private getCurrentDefinition(): { table: TableSchema; view: TableViewDefinition } | null {
    if (!this.currentViewId) return null;
    return getTableAndView(this.plugin.data, this.currentViewId);
  }

  private watchesPath(path: string): boolean {
    const definition = this.getCurrentDefinition();
    if (!definition) return false;
    const folder = definition.table.sourceFolder;
    return path === folder || path.startsWith(`${folder}/`);
  }

  async handleVaultChange(path: string): Promise<void> {
    if (!this.watchesPath(path)) return;
    this.requestRefresh();
  }

  private async persistPluginData(): Promise<void> {
    await this.plugin.savePluginData();
  }

  private async render(): Promise<void> {
    if (this.isRendering) {
      this.pendingRender = true;
      return;
    }

    this.isRendering = true;
    try {
      await this.renderInternal();
    } finally {
      this.isRendering = false;
      if (this.pendingRender) {
        this.pendingRender = false;
        await this.render();
      }
    }
  }

  private async renderInternal(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('dtv-view');

    const definition = this.getCurrentDefinition();
    if (!definition) {
      this.renderEmptyState(container);
      return;
    }

    const rows = await loadRows(this.app, definition.table);
    const visibleColumns = getOrderedColumns(definition.table, definition.view);
    const sortedRows = this.sortRows(rows, definition.view.sort, definition.table);

    const toolbar = container.createDiv({ cls: 'dtv-toolbar' });
    const leadingGroup = toolbar.createDiv({ cls: 'dtv-toolbar-group' });
    const folderButton = leadingGroup.createEl('button', {
      cls: 'dtv-folder-button',
      text: definition.table.sourceFolder,
    });
    folderButton.addEventListener('click', () => this.plugin.openFolderPicker());
    leadingGroup.createDiv({
      cls: 'dtv-folder-meta',
      text: `${sortedRows.length} item${sortedRows.length === 1 ? '' : 's'} · ${visibleColumns.length} column${visibleColumns.length === 1 ? '' : 's'}`,
    });

    const actionGroup = toolbar.createDiv({ cls: 'dtv-toolbar-group' });
    this.renderColumnManagerButton(actionGroup, definition.table, definition.view);

    const newRowButton = actionGroup.createEl('button', { cls: 'dtv-action-button', text: '+ New row' });
    newRowButton.addEventListener('click', () => {
      if (!this.draftRow) {
        this.draftRow = { key: `${Date.now()}`, name: '' };
      }
      void this.render();
    });

    const wrapper = container.createDiv({ cls: 'dtv-table-wrapper' });
    const tableEl = wrapper.createEl('table', { cls: 'dtv-table' });
    const thead = tableEl.createEl('thead');
    const headerRow = thead.createEl('tr');
    const nameHeader = headerRow.createEl('th');
    this.renderSortableHeader(nameHeader, 'Name', NAME_COLUMN_ID, definition.table, definition.view);
    for (const column of visibleColumns) {
      const th = headerRow.createEl('th');
      this.renderSortableHeader(th, column.name, column.id, definition.table, definition.view);
    }
    headerRow.createEl('th', { cls: 'dtv-actions-header' });

    const tbody = tableEl.createEl('tbody');
    for (const row of sortedRows) {
      this.renderRow(tbody, row, definition.table, visibleColumns);
    }

    if (this.draftRow) {
      this.renderDraftRow(tbody, definition.table, visibleColumns);
    }

    const addRow = tbody.createEl('tr');
    const addCell = addRow.createEl('td', {
      cls: 'dtv-add-row-cell',
      attr: { colspan: String(visibleColumns.length + 2) },
    });
    const addButton = addCell.createEl('button', {
      cls: 'dtv-add-row-button',
      text: '+ New',
    });
    addButton.addEventListener('click', () => {
      if (!this.draftRow) {
        this.draftRow = { key: `${Date.now()}`, name: '' };
      }
      void this.render();
    });
  }

  private renderColumnManagerButton(toolbar: HTMLElement, table: TableSchema, view: TableViewDefinition): void {
    const button = toolbar.createEl('button', { cls: 'dtv-action-button', text: 'Columns' });
    let panel: HTMLElement | null = null;

    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (panel) {
        panel.remove();
        panel = null;
        return;
      }

      panel = toolbar.createDiv({ cls: 'dtv-column-panel' });
      panel.addEventListener('click', (panelEvent) => panelEvent.stopPropagation());
      this.renderColumnManagerPanel(panel, table, view);

      const closePanel = (documentEvent: MouseEvent) => {
        if (!panel) return;
        if (!panel.contains(documentEvent.target as Node) && documentEvent.target !== button) {
          panel.remove();
          panel = null;
          document.removeEventListener('click', closePanel);
        }
      };

      setTimeout(() => {
        document.addEventListener('click', closePanel);
      }, 0);
    });
  }

  private renderColumnManagerPanel(panel: HTMLElement, table: TableSchema, view: TableViewDefinition): void {
    panel.empty();
    panel.createDiv({ cls: 'dtv-column-panel-title', text: 'Columns' });

    const hiddenColumns = new Set(table.columns.filter((column) => column.hidden).map((column) => column.id));
    let dragSourceId: string | null = null;

    for (const column of getOrderedColumns(table, view, true)) {
      const item = panel.createDiv({ cls: 'dtv-column-item' });
      item.draggable = true;

      const dragHandle = item.createSpan({ cls: 'dtv-column-drag-handle', text: '⠿' });
      dragHandle.setAttribute('aria-hidden', 'true');

      const visibility = item.createEl('input', { type: 'checkbox', cls: 'dtv-column-visibility' });
      visibility.checked = !hiddenColumns.has(column.id);
      visibility.addEventListener('change', async () => {
        const changed = setColumnHidden(table, column.id, !visibility.checked);
        if (!changed) return;
        if (visibility.checked === false && view.sort?.columnId === column.id) {
          view.sort = null;
        }
        await this.persistPluginData();
        await this.render();
      });

      const meta = item.createDiv({ cls: 'dtv-column-meta' });
      meta.createDiv({ cls: 'dtv-column-name', text: column.name });
      meta.createDiv({ cls: 'dtv-column-type', text: getColumnTypeLabel(column.type) });

      const renameButton = item.createEl('button', { cls: 'dtv-column-rename', text: 'Rename' });
      renameButton.addEventListener('click', async () => {
        const nextName = window.prompt('Column name', column.name);
        if (nextName === null) return;

        const result = renameColumn(table, column.id, nextName);
        if (result.status === 'invalid') {
          new Notice('Column name is invalid');
          return;
        }
        if (result.status === 'conflict') {
          new Notice(`A column named "${nextName.trim()}" already exists`);
          return;
        }
        if (result.previousName && result.previousName !== result.column?.name) {
          await renameColumnProperty(this.app, table, result.previousName, result.column?.name ?? result.previousName);
        }
        await this.persistPluginData();
        await this.render();
      });

      item.addEventListener('dragstart', (event) => {
        dragSourceId = column.id;
        item.addClass('is-dragging');
        event.dataTransfer?.setData('text/plain', column.id);
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
        }
      });
      item.addEventListener('dragover', (event) => {
        event.preventDefault();
        item.addClass('is-drag-over');
      });
      item.addEventListener('dragleave', () => {
        item.removeClass('is-drag-over');
      });
      item.addEventListener('drop', async (event) => {
        event.preventDefault();
        item.removeClass('is-drag-over');
        if (!dragSourceId || dragSourceId === column.id) return;
        const targetIndex = view.columnOrder.indexOf(column.id);
        if (targetIndex === -1) return;
        const changed = reorderColumn(view, dragSourceId, targetIndex);
        if (!changed) return;
        await this.persistPluginData();
        await this.render();
      });
      item.addEventListener('dragend', () => {
        dragSourceId = null;
        item.removeClass('is-dragging');
      });
    }

    if (table.columns.length === 0) {
      panel.createDiv({ cls: 'dtv-column-empty', text: 'No columns yet. Name is always shown.' });
    }

    const form = panel.createDiv({ cls: 'dtv-column-form' });
    const nameInput = form.createEl('input', {
      cls: 'dtv-column-form-input',
      type: 'text',
      attr: { placeholder: 'Column name' },
    });
    const typeSelect = form.createEl('select', { cls: 'dtv-column-form-select' });
    for (const type of ['text', 'checkbox'] as const) {
      typeSelect.createEl('option', {
        value: type,
        text: getColumnTypeLabel(type),
      });
    }
    const addButton = form.createEl('button', { cls: 'dtv-action-button', text: 'Add column' });
    addButton.addEventListener('click', async () => {
      const result = addColumn(table, view, {
        name: nameInput.value,
        type: typeSelect.value as ColumnType,
      });
      if (result.status === 'invalid') {
        new Notice('Column name is invalid');
        return;
      }
      if (result.status === 'conflict') {
        new Notice(`A column named "${nameInput.value.trim()}" already exists`);
        return;
      }
      nameInput.value = '';
      await this.persistPluginData();
      await this.render();
    });
  }

  private renderEmptyState(container: HTMLElement): void {
    const empty = container.createDiv({ cls: 'dtv-empty-state' });
    empty.createEl('h3', { text: 'No table is open' });
    empty.createEl('p', { text: 'Open a folder to start a folder-backed table.' });
    const button = empty.createEl('button', { cls: 'dtv-empty-button', text: 'Choose folder' });
    button.addEventListener('click', () => this.plugin.openFolderPicker());
  }

  private renderSortableHeader(
    th: HTMLElement,
    label: string,
    columnId: string,
    table: TableSchema,
    view: TableViewDefinition,
  ): void {
    const indicator = view.sort?.columnId === columnId
      ? view.sort.direction === 'asc' ? ' ▲' : ' ▼'
      : '';
    const button = th.createEl('button', {
      cls: 'dtv-header-button',
      text: `${label}${indicator}`,
    });
    button.addEventListener('click', async () => {
      const currentSort = view.sort;
      if (!currentSort || currentSort.columnId !== columnId) {
        view.sort = { columnId, direction: 'asc' };
      } else if (currentSort.direction === 'asc') {
        view.sort = { columnId, direction: 'desc' };
      } else {
        view.sort = null;
      }
      await this.persistPluginData();
      await this.render();
    });

    if (columnId !== NAME_COLUMN_ID) {
      const column = table.columns.find((candidate) => candidate.id === columnId);
      if (column?.hidden) {
        th.addClass('is-hidden');
      }
    }
  }

  private renderRow(tbody: HTMLElement, row: RowRecord, table: TableSchema, columns: ColumnSchema[]): void {
    const tr = tbody.createEl('tr', { cls: 'dtv-row' });
    const nameCell = tr.createEl('td', { cls: 'dtv-name-cell' });
    const link = nameCell.createEl('a', {
      cls: 'dtv-name-link internal-link',
      text: row.name,
    });
    link.addEventListener('click', (event) => {
      event.preventDefault();
      this.app.workspace.openLinkText(row.filePath, '');
    });
    nameCell.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.editExistingNameCell(nameCell, row, table);
    });

    for (const column of columns) {
      const cell = tr.createEl('td');
      this.renderCell(cell, row, column);
    }

    const actionCell = tr.createEl('td', { cls: 'dtv-actions-cell' });
    const deleteButton = actionCell.createEl('button', {
      cls: 'dtv-delete-button',
      text: '×',
      attr: { 'aria-label': 'Delete row' },
    });
    deleteButton.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await deleteRowFile(this.app, row);
      this.requestRefresh();
    });
  }

  private renderCell(cell: HTMLElement, row: RowRecord, column: ColumnSchema): void {
    if (column.type === 'checkbox') {
      const checkbox = cell.createEl('input', { type: 'checkbox', cls: 'dtv-cell-checkbox' });
      checkbox.checked = row.values[column.id] === true;
      checkbox.addEventListener('change', async () => {
        await updateColumnValue(this.app, row, column, checkbox.checked);
        this.requestRefresh();
      });
      return;
    }

    const value = this.getCellTextValue(row, column);
    cell.addClass('dtv-cell-editable');
    cell.setText(value);
    cell.addEventListener('click', () => {
      if (cell.querySelector('input')) return;
      this.editTextCell(cell, row, column, value);
    });
  }

  private editTextCell(cell: HTMLElement, row: RowRecord, column: ColumnSchema, currentValue: string): void {
    cell.empty();
    const input = cell.createEl('input', {
      cls: 'dtv-cell-input',
      type: 'text',
      value: currentValue,
    });
    input.focus();
    input.select();

    const restore = async (): Promise<void> => {
      await this.render();
    };

    const commit = async (): Promise<void> => {
      const nextValue = input.value.trim();
      if (nextValue === currentValue) {
        await restore();
        return;
      }

      await updateColumnValue(this.app, row, column, nextValue);
      this.requestRefresh();
    };

    input.addEventListener('blur', () => {
      void commit();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        void restore();
      }
    });
  }

  private renderDraftRow(tbody: HTMLElement, table: TableSchema, columns: ColumnSchema[]): void {
    const draft = this.draftRow;
    if (!draft) return;

    const tr = tbody.createEl('tr', { cls: 'dtv-row' });
    const nameCell = tr.createEl('td', { cls: 'dtv-name-cell' });
    const input = nameCell.createEl('input', {
      cls: 'dtv-cell-input',
      type: 'text',
      value: draft.name,
      attr: { placeholder: 'Name' },
    });

    queueMicrotask(() => {
      input.focus();
      input.select();
    });

    for (const _column of columns) {
      const cell = tr.createEl('td');
      cell.createDiv({ cls: 'dtv-draft-hint', text: 'Set after create' });
    }

    const actionCell = tr.createEl('td', { cls: 'dtv-actions-cell' });
    actionCell.createDiv({ cls: 'dtv-draft-hint', text: 'Draft' });

    const commit = async (): Promise<void> => {
      const validation = validateRowName(this.app, table, input.value);
      if (!validation.ok) {
        if (validation.reason === 'duplicate') {
          new Notice(`"${input.value.trim()}" already exists in ${table.sourceFolder}`);
        }
        this.draftRow = null;
        await this.render();
        return;
      }

      await createRowFile(this.app, table, validation.baseName);
      this.draftRow = null;
      this.requestRefresh();
    };

    input.addEventListener('input', () => {
      if (this.draftRow) {
        this.draftRow.name = input.value;
      }
    });
    input.addEventListener('blur', () => {
      void commit();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.draftRow = null;
        void this.render();
      }
    });
  }

  private editExistingNameCell(cell: HTMLElement, row: RowRecord, table: TableSchema): void {
    if (cell.querySelector('input')) return;

    const oldName = row.name;
    cell.empty();
    const input = cell.createEl('input', {
      cls: 'dtv-cell-input',
      type: 'text',
      value: oldName,
    });
    input.focus();
    input.select();

    const restore = async (): Promise<void> => {
      await this.render();
    };

    const commit = async (): Promise<void> => {
      const nextValue = input.value.trim();
      if (!nextValue || nextValue === oldName) {
        await restore();
        return;
      }

      try {
        await renameRowFile(this.app, row, table, nextValue);
        this.requestRefresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown';
        if (message === 'duplicate') {
          new Notice(`"${nextValue}" already exists in ${table.sourceFolder}`);
        } else if (message === 'empty') {
          new Notice('Name cannot be empty');
        } else {
          new Notice(`Rename failed: ${message}`);
        }
        await restore();
      }
    };

    input.addEventListener('blur', () => {
      void commit();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        void restore();
      }
    });
  }

  private getCellTextValue(row: RowRecord, column: ColumnSchema): string {
    const rawValue = row.values[column.id];
    if (Array.isArray(rawValue)) {
      return rawValue.map((value) => String(value)).join(', ');
    }
    if (rawValue === null || rawValue === undefined) return '';
    return String(rawValue);
  }

  private sortRows(rows: RowRecord[], sort: SortState | null, table: TableSchema): RowRecord[] {
    if (!sort) return rows;

    const direction = sort.direction === 'asc' ? 1 : -1;
    if (sort.columnId === NAME_COLUMN_ID) {
      return [...rows].sort((left, right) => left.name.localeCompare(right.name, 'ko', { numeric: true, sensitivity: 'base' }) * direction);
    }

    const column = table.columns.find((candidate) => candidate.id === sort.columnId);
    if (!column) return rows;

    return [...rows].sort((left, right) => {
      const leftValue = left.values[column.id];
      const rightValue = right.values[column.id];

      if (column.type === 'checkbox') {
        const leftBool = leftValue === true ? 1 : 0;
        const rightBool = rightValue === true ? 1 : 0;
        return (leftBool - rightBool) * direction;
      }

      const leftText = this.getCellTextValue(left, column);
      const rightText = this.getCellTextValue(right, column);

      if (!leftText && !rightText) return 0;
      if (!leftText) return 1;
      if (!rightText) return -1;

      return leftText.localeCompare(rightText, 'ko', { numeric: true, sensitivity: 'base' }) * direction;
    });
  }
}

export default class DatabaseTableViewPlugin extends Plugin {
  data: PluginData = createEmptyPluginData();

  async onload(): Promise<void> {
    this.data = sanitizePluginData(await this.loadData());

    this.registerView(VIEW_TYPE, (leaf) => new DatabaseTableView(leaf, this));

    this.addRibbonIcon('table', 'Open database table view', () => {
      this.openFolderPicker();
    });

    this.addCommand({
      id: 'open-database-table-folder',
      name: 'Open Folder as Database Table',
      callback: () => this.openFolderPicker(),
    });

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file: TAbstractFile) => {
      if (!(file instanceof TFolder) || file.path.length === 0) return;
      menu.addItem((item) => {
        item.setTitle('Open as database table');
        item.setIcon('table');
        item.onClick(() => {
          void this.activateForFolder(file.path);
        });
      });
    }));

    this.registerEvent(this.app.vault.on('create', (file) => {
      this.forwardVaultChange(file.path);
    }));
    this.registerEvent(this.app.vault.on('modify', (file) => {
      this.forwardVaultChange(file.path);
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      this.forwardVaultChange(file.path);
    }));
    this.registerEvent(this.app.vault.on('rename', async (file, oldPath) => {
      if (file instanceof TFolder) {
        const changed = renameTableSourceFolder(this.data, oldPath, file.path);
        if (changed) {
          await this.savePluginData();
        }
      }
      this.forwardVaultChange(file.path);
      this.forwardVaultChange(oldPath);
    }));
  }

  async activateForFolder(folderPath: string): Promise<void> {
    const { view } = ensureTableForFolder(this.data, folderPath);
    rememberRecentView(this.data, view.id);
    await this.savePluginData();

    const leaf = await this.getOrCreateLeaf();
    const tableView = leaf.view;
    if (tableView instanceof DatabaseTableView) {
      await tableView.openView(view.id);
    }
  }

  openFolderPicker(): void {
    new FolderSuggestModal(this.app, (folder) => {
      void this.activateForFolder(folder.path);
    }).open();
  }

  rememberRecentView(viewId: string): void {
    rememberRecentView(this.data, viewId);
    void this.savePluginData();
  }

  async savePluginData(): Promise<void> {
    await this.saveData(this.data);
  }

  private async getOrCreateLeaf(): Promise<WorkspaceLeaf> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return existing;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      throw new Error('Unable to open a workspace leaf');
    }

    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  private forwardVaultChange(path: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof DatabaseTableView) {
        void leaf.view.handleVaultChange(path);
      }
    }
  }
}
