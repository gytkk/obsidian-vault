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

import { createRowFile, deleteRowFile, loadRows, renameRowFile, validateRowName } from './frontmatter';
import { NAME_COLUMN_ID, createEmptyPluginData, type PluginData, type RowRecord, type SortState, type TableSchema, type TableViewDefinition } from './models';
import { ensureTableForFolder, getTableAndView, rememberRecentView, renameTableSourceFolder, sanitizePluginData } from './store';

const VIEW_TYPE = 'database-table-view';
const REFRESH_DEBOUNCE_MS = 250;

interface DraftRowState {
  key: string;
  name: string;
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
      this.render();
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
    const sortedRows = this.sortRows(rows, definition.view.sort);

    const toolbar = container.createDiv({ cls: 'dtv-toolbar' });
    const leadingGroup = toolbar.createDiv({ cls: 'dtv-toolbar-group' });
    const folderButton = leadingGroup.createEl('button', {
      cls: 'dtv-folder-button',
      text: definition.table.sourceFolder,
    });
    folderButton.addEventListener('click', () => this.plugin.openFolderPicker());
    leadingGroup.createDiv({ cls: 'dtv-folder-meta', text: `${sortedRows.length} item${sortedRows.length === 1 ? '' : 's'}` });

    const actionGroup = toolbar.createDiv({ cls: 'dtv-toolbar-group' });
    const newRowButton = actionGroup.createEl('button', { cls: 'dtv-action-button', text: '+ New row' });
    newRowButton.addEventListener('click', () => {
      if (!this.draftRow) {
        this.draftRow = { key: `${Date.now()}`, name: '' };
      }
      this.render();
    });

    const wrapper = container.createDiv({ cls: 'dtv-table-wrapper' });
    const tableEl = wrapper.createEl('table', { cls: 'dtv-table' });
    const thead = tableEl.createEl('thead');
    const headerRow = thead.createEl('tr');
    const nameHeader = headerRow.createEl('th');
    this.renderSortableHeader(nameHeader, 'Name', NAME_COLUMN_ID, definition.view);
    headerRow.createEl('th', { cls: 'dtv-actions-header' });

    const tbody = tableEl.createEl('tbody');
    for (const row of sortedRows) {
      this.renderRow(tbody, row, definition.table);
    }

    if (this.draftRow) {
      this.renderDraftRow(tbody, definition.table);
    }

    const addRow = tbody.createEl('tr');
    const addCell = addRow.createEl('td', {
      cls: 'dtv-add-row-cell',
      attr: { colspan: '2' },
    });
    const addButton = addCell.createEl('button', {
      cls: 'dtv-add-row-button',
      text: '+ New',
    });
    addButton.addEventListener('click', () => {
      if (!this.draftRow) {
        this.draftRow = { key: `${Date.now()}`, name: '' };
      }
      this.render();
    });
  }

  private renderEmptyState(container: HTMLElement): void {
    const empty = container.createDiv({ cls: 'dtv-empty-state' });
    empty.createEl('h3', { text: 'No table is open' });
    empty.createEl('p', { text: 'Open a folder to start a folder-backed table.' });
    const button = empty.createEl('button', { cls: 'dtv-empty-button', text: 'Choose folder' });
    button.addEventListener('click', () => this.plugin.openFolderPicker());
  }

  private renderSortableHeader(th: HTMLElement, label: string, columnId: string, view: TableViewDefinition): void {
    const currentSort = view.sort;
    const indicator = currentSort?.columnId === columnId
      ? currentSort.direction === 'asc' ? ' ▲' : ' ▼'
      : '';
    const button = th.createEl('button', {
      cls: 'dtv-header-button',
      text: `${label}${indicator}`,
    });
    button.addEventListener('click', async () => {
      if (!currentSort || currentSort.columnId !== columnId) {
        view.sort = { columnId, direction: 'asc' };
      } else if (currentSort.direction === 'asc') {
        view.sort = { columnId, direction: 'desc' };
      } else {
        view.sort = null;
      }
      await this.plugin.savePluginData();
      await this.render();
    });
  }

  private renderRow(tbody: HTMLElement, row: RowRecord, table: TableSchema): void {
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

  private renderDraftRow(tbody: HTMLElement, table: TableSchema): void {
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

    const actionCell = tr.createEl('td', { cls: 'dtv-actions-cell' });
    actionCell.createDiv({ cls: 'dtv-draft-hint', text: 'Draft' });

    const commit = async (): Promise<void> => {
      const validation = validateRowName(this.app, table, input.value);
      if (!validation.ok) {
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
      commit();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.draftRow = null;
        this.render();
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
      commit();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        restore();
      }
    });
  }

  private sortRows(rows: RowRecord[], sort: SortState | null): RowRecord[] {
    if (!sort || sort.columnId !== NAME_COLUMN_ID) return rows;

    const direction = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((left, right) => left.name.localeCompare(right.name, 'ko', { numeric: true, sensitivity: 'base' }) * direction);
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
          this.activateForFolder(file.path);
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
      this.activateForFolder(folder.path);
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
