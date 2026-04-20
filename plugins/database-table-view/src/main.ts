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
const WIKILINK_RE = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/;

interface DraftRowState {
  key: string;
  name: string;
}

interface PickerEntry {
  id: string;
  label: string;
  meta?: string;
  selected: boolean;
  create?: boolean;
}

interface SearchPickerConfig {
  mode: 'single' | 'multiple';
  placeholder: string;
  initialQuery?: string;
  initialSelectedIds: string[];
  allowClear: boolean;
  buildEntries: (query: string, selectedIds: Set<string>) => PickerEntry[];
  onCommit: (selectedIds: string[]) => Promise<void>;
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

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
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
  private activePicker: HTMLElement | null = null;
  private activePickerHandler: ((event: MouseEvent) => void) | null = null;
  private columnFormState: {
    name: string;
    type: ColumnType;
    relationFolder: string;
  } = {
      name: '',
      type: 'text',
      relationFolder: '',
    };

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
    this.closeActivePicker();
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

    const watchedFolders = new Set<string>([definition.table.sourceFolder]);
    for (const column of definition.table.columns) {
      if (column.type !== 'relation' || !column.relation) continue;
      const targetTable = this.plugin.data.tables[column.relation.tableId];
      if (targetTable) {
        watchedFolders.add(targetTable.sourceFolder);
      }
    }

    return [...watchedFolders].some((folder) => path === folder || path.startsWith(`${folder}/`));
  }

  async handleVaultChange(path: string): Promise<void> {
    if (!this.watchesPath(path)) return;
    this.requestRefresh();
  }

  private async persistPluginData(): Promise<void> {
    await this.plugin.savePluginData();
  }

  private closeActivePicker(): void {
    if (this.activePicker) {
      this.activePicker.remove();
      this.activePicker = null;
    }
    if (this.activePickerHandler) {
      document.removeEventListener('click', this.activePickerHandler);
      this.activePickerHandler = null;
    }
  }

  private positionPicker(popup: HTMLElement, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${rect.left}px`;

    requestAnimationFrame(() => {
      const popupRect = popup.getBoundingClientRect();
      if (popupRect.right > window.innerWidth - 8) {
        popup.style.left = `${Math.max(8, window.innerWidth - popupRect.width - 8)}px`;
      }
      if (popupRect.bottom > window.innerHeight - 8) {
        popup.style.top = `${Math.max(8, rect.top - popupRect.height - 4)}px`;
      }
    });
  }

  private isPickerEvent(event: MouseEvent, popup: HTMLElement): boolean {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (path.length > 0) {
      return path.includes(popup);
    }
    return popup.contains(event.target as Node);
  }

  private openSearchPicker(anchor: HTMLElement, config: SearchPickerConfig): void {
    this.closeActivePicker();

    const popup = document.createElement('div');
    popup.className = 'dtv-picker';
    this.activePicker = popup;

    const input = document.createElement('input');
    input.className = 'dtv-picker-input';
    input.type = 'text';
    input.placeholder = config.placeholder;
    input.value = config.initialQuery ?? '';
    popup.appendChild(input);

    const list = document.createElement('div');
    list.className = 'dtv-picker-list';
    popup.appendChild(list);

    const selectedIds = new Set(config.initialSelectedIds);
    let activeIndex = 0;

    const getEntries = (): PickerEntry[] => {
      return config.buildEntries(input.value, selectedIds);
    };

    const renderEntries = (): void => {
      const entries = getEntries();
      if (activeIndex >= entries.length) {
        activeIndex = Math.max(0, entries.length - 1);
      }

      list.empty();
      if (entries.length === 0) {
        list.createDiv({ cls: 'dtv-picker-empty', text: 'No matches' });
        return;
      }

      entries.forEach((entry, index) => {
        const item = list.createDiv({ cls: 'dtv-picker-item' });
        if (entry.selected) item.addClass('is-selected');
        if (index === activeIndex) item.addClass('is-active');

        if (config.mode === 'multiple') {
          const checkbox = item.createEl('input', { type: 'checkbox' });
          checkbox.checked = entry.selected;
          checkbox.addEventListener('click', (event) => {
            event.stopPropagation();
          });
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
              selectedIds.add(entry.id);
            } else {
              selectedIds.delete(entry.id);
            }
            renderEntries();
          });
        }

        const content = item.createDiv({ cls: 'dtv-picker-item-content' });
        content.createDiv({ cls: 'dtv-picker-item-label', text: entry.label });
        if (entry.meta) {
          content.createDiv({ cls: 'dtv-picker-item-meta', text: entry.meta });
        }

        item.addEventListener('mouseenter', () => {
          activeIndex = index;
        });
        item.addEventListener('click', async (event) => {
          event.stopPropagation();
          if (config.mode === 'single') {
            this.closeActivePicker();
            await config.onCommit([entry.id]);
            return;
          }

          if (selectedIds.has(entry.id)) {
            selectedIds.delete(entry.id);
          } else {
            selectedIds.add(entry.id);
          }
          renderEntries();
        });
      });
    };

    const commitAndClose = async (): Promise<void> => {
      this.closeActivePicker();
      await config.onCommit([...selectedIds]);
    };

    input.addEventListener('input', () => {
      activeIndex = 0;
      renderEntries();
    });
    input.addEventListener('keydown', (event) => {
      const entries = getEntries();

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (entries.length > 0) {
          activeIndex = Math.min(activeIndex + 1, entries.length - 1);
        }
        renderEntries();
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (entries.length > 0) {
          activeIndex = Math.max(activeIndex - 1, 0);
        }
        renderEntries();
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        const entry = entries[activeIndex];
        if (!entry) return;

        if (config.mode === 'single') {
          this.closeActivePicker();
          void config.onCommit([entry.id]);
          return;
        }

        if (selectedIds.has(entry.id)) {
          selectedIds.delete(entry.id);
        } else {
          selectedIds.add(entry.id);
        }
        renderEntries();
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        if (config.mode === 'multiple') {
          void commitAndClose();
        } else {
          this.closeActivePicker();
        }
      }
    });

    if (config.allowClear) {
      const clear = document.createElement('div');
      clear.className = 'dtv-picker-clear';
      clear.textContent = 'Clear';
      clear.addEventListener('click', async (event) => {
        event.stopPropagation();
        selectedIds.clear();
        await commitAndClose();
      });
      popup.appendChild(clear);
    }

    renderEntries();
    document.body.appendChild(popup);
    this.positionPicker(popup, anchor);
    input.focus();
    input.select();

    setTimeout(() => {
      this.activePickerHandler = (event: MouseEvent) => {
        if (!this.activePicker || !this.isPickerEvent(event, popup)) {
          if (config.mode === 'multiple') {
            void commitAndClose();
          } else {
            this.closeActivePicker();
          }
        }
      };
      document.addEventListener('click', this.activePickerHandler);
    }, 0);
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
    this.closeActivePicker();

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

    const shell = container.createDiv({ cls: 'dtv-shell' });
    this.renderMasthead(shell, definition.table, definition.view, sortedRows.length, visibleColumns.length);

    const toolbar = shell.createDiv({ cls: 'dtv-toolbar' });
    const leadingGroup = toolbar.createDiv({ cls: 'dtv-toolbar-group' });
    const folderButton = leadingGroup.createEl('button', {
      cls: 'dtv-folder-button',
      text: definition.table.sourceFolder,
    });
    folderButton.addEventListener('click', () => this.plugin.openFolderPicker());
    leadingGroup.createDiv({ cls: 'dtv-folder-meta', text: 'Source folder' });

    const actionGroup = toolbar.createDiv({ cls: 'dtv-toolbar-group' });
    this.renderColumnManagerButton(actionGroup, definition.table, definition.view);

    const newRowButton = actionGroup.createEl('button', { cls: 'dtv-action-button', text: '+ New row' });
    newRowButton.addEventListener('click', () => {
      if (!this.draftRow) {
        this.draftRow = { key: `${Date.now()}`, name: '' };
      }
      void this.render();
    });

    const wrapper = shell.createDiv({ cls: 'dtv-table-wrapper' });
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

  private renderMasthead(
    container: HTMLElement,
    table: TableSchema,
    view: TableViewDefinition,
    rowCount: number,
    columnCount: number,
  ): void {
    const masthead = container.createDiv({ cls: 'dtv-masthead' });
    const heading = masthead.createDiv({ cls: 'dtv-heading' });
    heading.createDiv({ cls: 'dtv-kicker', text: 'Folder Database' });
    heading.createEl('h2', {
      cls: 'dtv-title',
      text: this.getTableTitle(table),
    });
    heading.createDiv({
      cls: 'dtv-subtitle',
      text: `${table.sourceFolder} · ${view.name}`,
    });

    const stats = masthead.createDiv({ cls: 'dtv-stat-strip' });
    this.renderStatChip(stats, 'Rows', String(rowCount));
    this.renderStatChip(stats, 'Columns', String(columnCount));
    this.renderStatChip(stats, 'View', view.name);
  }

  private renderStatChip(container: HTMLElement, label: string, value: string): void {
    const chip = container.createDiv({ cls: 'dtv-stat-chip' });
    chip.createDiv({ cls: 'dtv-stat-label', text: label });
    chip.createDiv({ cls: 'dtv-stat-value', text: value });
  }

  private getTableTitle(table: TableSchema): string {
    const segments = table.sourceFolder.split('/').filter(Boolean);
    return segments[segments.length - 1] ?? table.sourceFolder;
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
      value: this.columnFormState.name,
      attr: { placeholder: 'Column name' },
    });
    nameInput.addEventListener('input', () => {
      this.columnFormState.name = nameInput.value;
    });

    const typeSelect = form.createEl('select', { cls: 'dtv-column-form-select' });
    for (const type of ['text', 'checkbox', 'single-select', 'multi-select', 'relation'] as const) {
      const option = typeSelect.createEl('option', {
        value: type,
        text: getColumnTypeLabel(type),
      });
      option.selected = type === this.columnFormState.type;
    }
    typeSelect.addEventListener('change', () => {
      this.columnFormState.type = typeSelect.value as ColumnType;
      this.renderColumnManagerPanel(panel, table, view);
    });

    if (this.columnFormState.type === 'relation') {
      const relationButton = form.createEl('button', {
        cls: 'dtv-folder-button',
        text: this.columnFormState.relationFolder || 'Choose relation folder',
      });
      relationButton.addEventListener('click', (event) => {
        event.preventDefault();
        new FolderSuggestModal(this.app, (folder) => {
          this.columnFormState.relationFolder = folder.path;
          this.renderColumnManagerPanel(panel, table, view);
        }).open();
      });
    }

    const addButton = form.createEl('button', { cls: 'dtv-action-button', text: 'Add column' });
    addButton.addEventListener('click', async () => {
      let relationTableId: string | null = null;
      if (this.columnFormState.type === 'relation') {
        if (!this.columnFormState.relationFolder) {
          new Notice('Choose a relation folder');
          return;
        }
        relationTableId = ensureTableForFolder(this.plugin.data, this.columnFormState.relationFolder).table.id;
      }

      const result = addColumn(table, view, {
        name: this.columnFormState.name,
        type: this.columnFormState.type,
        relationTableId,
      });
      if (result.status === 'invalid') {
        new Notice('Column name is invalid');
        return;
      }
      if (result.status === 'conflict') {
        new Notice(`A column named "${this.columnFormState.name.trim()}" already exists`);
        return;
      }

      this.columnFormState = {
        name: '',
        type: 'text',
        relationFolder: '',
      };
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
    switch (column.type) {
      case 'checkbox':
        this.renderCheckboxCell(cell, row, column);
        return;
      case 'single-select':
        this.renderSingleSelectCell(cell, row, column);
        return;
      case 'multi-select':
        this.renderMultiSelectCell(cell, row, column);
        return;
      case 'relation':
        this.renderRelationCell(cell, row, column);
        return;
      case 'text':
      default:
        this.renderTextCell(cell, row, column);
    }
  }

  private renderCheckboxCell(cell: HTMLElement, row: RowRecord, column: ColumnSchema): void {
    const checkbox = cell.createEl('input', { type: 'checkbox', cls: 'dtv-cell-checkbox' });
    checkbox.checked = row.values[column.id] === true;
    checkbox.addEventListener('change', async () => {
      await updateColumnValue(this.app, row, column, checkbox.checked);
      this.requestRefresh();
    });
  }

  private renderTextCell(cell: HTMLElement, row: RowRecord, column: ColumnSchema): void {
    const value = this.getCellTextValue(row, column);
    cell.addClass('dtv-cell-editable');
    cell.setText(value);
    cell.addEventListener('click', () => {
      if (cell.querySelector('input')) return;
      this.editTextCell(cell, row, column, value);
    });
  }

  private renderSingleSelectCell(cell: HTMLElement, row: RowRecord, column: ColumnSchema): void {
    cell.addClass('dtv-cell-editable');
    const value = this.getCellTextValue(row, column);
    this.renderTagList(cell, value ? [value] : []);
    cell.addEventListener('click', (event) => {
      event.stopPropagation();
      this.showSingleSelectPicker(cell, row, column);
    });
  }

  private renderMultiSelectCell(cell: HTMLElement, row: RowRecord, column: ColumnSchema): void {
    cell.addClass('dtv-cell-editable');
    const values = Array.isArray(row.values[column.id])
      ? (row.values[column.id] as string[])
      : [];
    this.renderTagList(cell, values);
    cell.addEventListener('click', (event) => {
      event.stopPropagation();
      this.showMultiSelectPicker(cell, row, column);
    });
  }

  private renderRelationCell(cell: HTMLElement, row: RowRecord, column: ColumnSchema): void {
    cell.addClass('dtv-cell-editable');

    const resolved = this.resolveRelationRow(row, column);
    if (resolved) {
      const link = cell.createEl('a', {
        cls: 'dtv-name-link internal-link',
        text: resolved.name,
      });
      link.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.app.workspace.openLinkText(resolved.filePath, row.filePath);
      });
    } else {
      cell.setText(this.getCellTextValue(row, column));
    }

    cell.addEventListener('click', (event) => {
      if (event.target instanceof HTMLElement && event.target.closest('a')) return;
      event.stopPropagation();
      void this.showRelationPicker(cell, row, column);
    });
  }

  private renderTagList(cell: HTMLElement, values: string[]): void {
    cell.empty();
    if (values.length === 0) {
      cell.createDiv({ cls: 'dtv-cell-placeholder', text: '' });
      return;
    }

    const list = cell.createDiv({ cls: 'dtv-tag-list' });
    for (const value of values) {
      const tag = list.createSpan({ cls: 'dtv-tag', text: value });
      tag.style.setProperty('--dtv-tag-hue', String(hashString(value) % 360));
    }
  }

  private showSingleSelectPicker(anchor: HTMLElement, row: RowRecord, column: ColumnSchema): void {
    const currentValue = this.getCellTextValue(row, column);
    this.openSearchPicker(anchor, {
      mode: 'single',
      placeholder: 'Search or create an option...',
      initialQuery: currentValue,
      initialSelectedIds: currentValue ? [currentValue] : [],
      allowClear: true,
      buildEntries: (query) => {
        const normalizedQuery = query.trim().toLowerCase();
        const options = column.options.filter((option) => option.toLowerCase().includes(normalizedQuery));
        const entries: PickerEntry[] = options.map((option) => ({
          id: option,
          label: option,
          selected: option === currentValue,
        }));
        const trimmed = query.trim();
        if (trimmed && !column.options.some((option) => option === trimmed)) {
          entries.unshift({
            id: trimmed,
            label: trimmed,
            meta: 'Create option',
            selected: false,
            create: true,
          });
        }
        return entries;
      },
      onCommit: async (selectedIds) => {
        const nextValue = selectedIds[0] ?? '';
        if (nextValue && !column.options.includes(nextValue)) {
          column.options.push(nextValue);
          await this.persistPluginData();
        }
        await updateColumnValue(this.app, row, column, nextValue);
        this.requestRefresh();
      },
    });
  }

  private showMultiSelectPicker(anchor: HTMLElement, row: RowRecord, column: ColumnSchema): void {
    const currentValues = Array.isArray(row.values[column.id])
      ? (row.values[column.id] as string[])
      : [];
    this.openSearchPicker(anchor, {
      mode: 'multiple',
      placeholder: 'Search or create options...',
      initialSelectedIds: currentValues,
      allowClear: true,
      buildEntries: (query, selectedIds) => {
        const normalizedQuery = query.trim().toLowerCase();
        const knownOptions = new Set([...column.options, ...selectedIds]);
        const options = [...knownOptions].filter((option) => option.toLowerCase().includes(normalizedQuery));
        const entries: PickerEntry[] = options.map((option) => ({
          id: option,
          label: option,
          selected: selectedIds.has(option),
        }));
        const trimmed = query.trim();
        if (trimmed && !knownOptions.has(trimmed)) {
          entries.unshift({
            id: trimmed,
            label: trimmed,
            meta: 'Create option',
            selected: false,
            create: true,
          });
        }
        return entries;
      },
      onCommit: async (selectedIds) => {
        let optionsChanged = false;
        for (const value of selectedIds) {
          if (!column.options.includes(value)) {
            column.options.push(value);
            optionsChanged = true;
          }
        }
        if (optionsChanged) {
          await this.persistPluginData();
        }
        await updateColumnValue(this.app, row, column, selectedIds);
        this.requestRefresh();
      },
    });
  }

  private async showRelationPicker(anchor: HTMLElement, row: RowRecord, column: ColumnSchema): Promise<void> {
    if (!column.relation) {
      new Notice(`"${column.name}" is missing a relation target`);
      return;
    }

    const targetTable = this.plugin.data.tables[column.relation.tableId];
    if (!targetTable) {
      new Notice(`"${column.name}" relation target is unavailable`);
      return;
    }

    const targetRows = await loadRows(this.app, targetTable);
    const currentRelation = this.resolveRelationRow(row, column);
    this.openSearchPicker(anchor, {
      mode: 'single',
      placeholder: 'Search related rows...',
      initialSelectedIds: currentRelation ? [currentRelation.filePath] : [],
      allowClear: true,
      buildEntries: (query) => {
        const normalizedQuery = query.trim().toLowerCase();
        return targetRows
          .filter((candidate) => candidate.name.toLowerCase().includes(normalizedQuery))
          .map((candidate) => ({
            id: candidate.filePath,
            label: candidate.name,
            meta: targetTable.sourceFolder,
            selected: currentRelation?.filePath === candidate.filePath,
          }));
      },
      onCommit: async (selectedIds) => {
        const selectedId = selectedIds[0];
        if (!selectedId) {
          await updateColumnValue(this.app, row, column, '');
          this.requestRefresh();
          return;
        }

        const targetRow = targetRows.find((candidate) => candidate.filePath === selectedId);
        if (!targetRow) return;

        const linkText = this.app.metadataCache.fileToLinktext(targetRow.file, row.filePath, true);
        const relationValue = linkText === targetRow.name
          ? `[[${linkText}]]`
          : `[[${linkText}|${targetRow.name}]]`;
        await updateColumnValue(this.app, row, column, relationValue);
        this.requestRefresh();
      },
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
    if (column.type === 'relation') {
      const resolved = this.resolveRelationRow(row, column);
      return resolved?.name ?? this.extractRelationLabel(row.values[column.id]);
    }

    const rawValue = row.values[column.id];
    if (Array.isArray(rawValue)) {
      return rawValue.map((value) => String(value)).join(', ');
    }
    if (rawValue === null || rawValue === undefined) return '';
    return String(rawValue);
  }

  private extractRelationLabel(rawValue: unknown): string {
    if (typeof rawValue !== 'string') return '';
    const trimmed = rawValue.trim();
    const match = trimmed.match(WIKILINK_RE);
    if (!match) return trimmed;
    return match[2] ?? match[1] ?? '';
  }

  private resolveRelationRow(row: RowRecord, column: ColumnSchema): RowRecord | null {
    if (!column.relation) return null;
    const targetTable = this.plugin.data.tables[column.relation.tableId];
    if (!targetTable) return null;

    const rawValue = row.values[column.id];
    if (typeof rawValue !== 'string' || !rawValue.trim()) return null;

    const match = rawValue.trim().match(WIKILINK_RE);
    const linkTarget = match?.[1] ?? rawValue.trim();
    const file = this.app.metadataCache.getFirstLinkpathDest(linkTarget, row.filePath);
    if (!file || !file.path.startsWith(`${targetTable.sourceFolder}/`)) return null;

    return {
      file,
      filePath: file.path,
      name: file.basename,
      values: {},
    };
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
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)
      .find((leaf) => leaf.getRoot() === this.app.workspace.rootSplit);
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return existing;
    }

    const leaf = this.app.workspace.getLeaf('tab');

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
