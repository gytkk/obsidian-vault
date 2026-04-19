import { App, MarkdownPostProcessorContext, MarkdownRenderChild, Notice, Plugin, TFile, TFolder, Vault, parseYaml } from 'obsidian';

// ─── Constants ──────────────────────────────────────────────

const INLINE_FIELD_RE = /^([^:\n]+)::\s*(.*)$/;
const DEBOUNCE_MS = 300;
const MAX_RELATION_HISTORY = 10;

// ─── Types ──────────────────────────────────────────────────

type FieldType = 'input' | 'number' | 'date' | 'url' | 'dropdown' | 'dropdown-multi' | 'checkbox' | 'relation' | 'relation-multi' | 'lookup';

interface FieldConfig {
  name: string;
  type: FieldType;
  options: string[];
  source?: string;
  relation?: string;
  field?: string;
  display?: 'fileName' | 'path';
  separator?: string;
}

interface EditableViewConfig {
  source: string;
  fields: FieldConfig[];
  template?: string;
  defaults: Record<string, unknown>;
  titlePattern?: string;
  newFileName?: string;
}

interface FileRecord {
  filePath: string;
  fileName: string;
  fields: Record<string, string>;
  aliases: string[];
}

interface SortState {
  field: string;
  direction: 'asc' | 'desc';
}

interface TableState {
  columnOrder: string[];
  hiddenColumns: string[];
  sort: SortState | null;
}

interface PluginData {
  tables: Record<string, TableState>;
  relationHistory: Record<string, string[]>;
}

type TextCellPart =
  | { type: 'text'; text: string }
  | { type: 'wikilink'; target: string; label: string };

interface WikiLinkPart {
  target: string;
  label: string;
}

const FIELD_TYPES: FieldType[] = ['input', 'number', 'date', 'url', 'dropdown', 'dropdown-multi', 'checkbox', 'relation', 'relation-multi', 'lookup'];
const UNTITLED_FILE_RE = /^Untitled(?: \d+)?$/;

// ─── ConfigParser ───────────────────────────────────────────

function parseConfig(source: string): EditableViewConfig | null {
  try {
    const parsed = parseYaml(source);
    const normalized = normalizeConfig(parsed);
    if (normalized) return normalized;
  } catch {
    // Fall back to the legacy parser for older configs.
  }
  return parseConfigLegacy(source);
}

function normalizeConfig(raw: unknown): EditableViewConfig | null {
  if (!raw || typeof raw !== 'object') return null;

  const config = raw as Record<string, unknown>;
  const sourceValue = config['source'];
  const fieldsValue = config['fields'];
  const templateValue = config['template'];
  const defaultsValue = config['defaults'];
  const titlePatternValue = config['titlePattern'];
  const newFileNameValue = config['newFileName'];
  const sourcePath = typeof sourceValue === 'string' ? sourceValue.trim() : '';
  const rawFields = Array.isArray(fieldsValue)
    ? fieldsValue as unknown[]
    : [];
  const fields = rawFields
    .map((field) => normalizeFieldConfig(field))
    .filter((field): field is FieldConfig => field !== null);

  if (!sourcePath || fields.length === 0) return null;
  return {
    source: sourcePath,
    fields,
    template: typeof templateValue === 'string' && templateValue.trim() ? templateValue.trim() : undefined,
    defaults: defaultsValue && typeof defaultsValue === 'object' && !Array.isArray(defaultsValue)
      ? defaultsValue as Record<string, unknown>
      : {},
    titlePattern: typeof titlePatternValue === 'string' && titlePatternValue.trim() ? titlePatternValue.trim() : undefined,
    newFileName: typeof newFileNameValue === 'string' && newFileNameValue.trim() ? newFileNameValue.trim() : undefined,
  };
}

function normalizeFieldConfig(raw: unknown): FieldConfig | null {
  if (!raw || typeof raw !== 'object') return null;

  const obj = raw as Record<string, unknown>;
  const name = typeof obj['name'] === 'string' ? obj['name'].trim() : '';
  if (!name) return null;

  const type = isFieldType(obj['type']) ? obj['type'] : 'input';
  const options = Array.isArray(obj['options'])
    ? obj['options'].map((option) => String(option).trim()).filter(Boolean)
    : [];
  const source = typeof obj['source'] === 'string' && obj['source'].trim()
    ? obj['source'].trim()
    : undefined;
  const relation = typeof obj['relation'] === 'string' && obj['relation'].trim()
    ? obj['relation'].trim()
    : undefined;
  const field = typeof obj['field'] === 'string' && obj['field'].trim()
    ? obj['field'].trim()
    : undefined;
  const display = obj['display'] === 'path' ? 'path' : 'fileName';
  const separator = typeof obj['separator'] === 'string' && obj['separator'].trim()
    ? obj['separator'].trim()
    : undefined;

  return { name, type, options, source, relation, field, display, separator };
}

function isFieldType(value: unknown): value is FieldType {
  return typeof value === 'string' && FIELD_TYPES.includes(value as FieldType);
}

function parseConfigLegacy(source: string): EditableViewConfig | null {
  const lines = source.split('\n').map((l) => l.trim());
  let sourcePath = '';
  const fields: FieldConfig[] = [];

  // Parse source
  for (const line of lines) {
    const m = line.match(/^source:\s*"([^"]+)"/);
    if (m) {
      sourcePath = m[1] ?? '';
      break;
    }
  }
  if (!sourcePath) return null;

  // Parse fields
  let currentField: FieldConfig | null = null;
  let inFields = false;

  for (const line of lines) {
    if (line === 'fields:') {
      inFields = true;
      continue;
    }
    if (!inFields) continue;

    const nameMatch = line.match(/^-\s*name:\s*(.+)$/);
    if (nameMatch) {
      if (currentField) fields.push(currentField);
      currentField = { name: nameMatch[1]!.trim(), type: 'input', options: [] };
      continue;
    }

    if (!currentField) continue;

    const typeMatch = line.match(/^type:\s*(.+)$/);
    if (typeMatch) {
      currentField.type = typeMatch[1]!.trim() as FieldType;
      continue;
    }

    const optionsMatch = line.match(/^options:\s*\[([^\]]*)\]$/);
    if (optionsMatch) {
      currentField.options = (optionsMatch[1] ?? '').split(',').map((o) => o.trim()).filter(Boolean);
    }
  }
  if (currentField) fields.push(currentField);

  if (fields.length === 0) return null;
  return { source: sourcePath, fields, defaults: {} };
}

// ─── DataLoader ─────────────────────────────────────────────

function parseInlineFields(content: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = content.split('\n');
  let inFrontmatter = false;
  let frontmatterCount = 0;

  for (const line of lines) {
    if (line.trim() === '---') {
      frontmatterCount++;
      inFrontmatter = frontmatterCount === 1;
      if (frontmatterCount === 2) inFrontmatter = false;
      continue;
    }
    if (inFrontmatter) continue;

    const m = line.match(INLINE_FIELD_RE);
    if (m) {
      fields[m[1]!.trim()] = (m[2] ?? '').trim();
    }
  }
  return fields;
}

async function loadRecords(app: App, source: string): Promise<FileRecord[]> {
  const folder = app.vault.getAbstractFileByPath(source);
  if (!folder || !(folder instanceof TFolder)) return [];

  const files: TFile[] = [];
  Vault.recurseChildren(folder, (f) => {
    if (f instanceof TFile && f.extension === 'md') files.push(f);
  });

  // Sort by creation time ascending so newest files appear last
  files.sort((a, b) => a.stat.ctime - b.stat.ctime);

  // Read all files in parallel
  const records = await Promise.all(
    files.map(async (file) => {
      const content = await app.vault.cachedRead(file);
      return {
        filePath: file.path,
        fileName: file.basename,
        fields: parseInlineFields(content),
        aliases: getFileAliases(app, file),
      };
    }),
  );
  return records;
}

function getFileAliases(app: App, file: TFile): string[] {
  const aliases = app.metadataCache.getFileCache(file)?.frontmatter?.['aliases'];
  if (typeof aliases === 'string') return aliases.trim() ? [aliases.trim()] : [];
  if (!Array.isArray(aliases)) return [];

  return aliases
    .map((alias) => String(alias).trim())
    .filter(Boolean);
}

// ─── FileWriter ─────────────────────────────────────────────

function upsertInlineField(data: string, fieldName: string, newValue: string): string {
  const lines = data.split('\n');
  let inFrontmatter = false;
  let frontmatterCount = 0;
  let lastFieldIdx = -1;
  let replacedIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '---') {
      frontmatterCount++;
      inFrontmatter = frontmatterCount === 1;
      if (frontmatterCount === 2) inFrontmatter = false;
      continue;
    }
    if (inFrontmatter) continue;

    if (INLINE_FIELD_RE.test(line)) {
      lastFieldIdx = i;
      const match = line.match(INLINE_FIELD_RE);
      if (match && match[1]!.trim() === fieldName) {
        replacedIdx = i;
      }
    }
  }

  if (replacedIdx !== -1) {
    lines[replacedIdx] = `${fieldName}:: ${newValue}`;
  } else if (lastFieldIdx !== -1) {
    lines.splice(lastFieldIdx + 1, 0, `${fieldName}:: ${newValue}`);
  } else {
    let insertIdx = lines.length;
    let fmCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim() === '---') {
        fmCount++;
        if (fmCount === 2) {
          insertIdx = i + 1;
          break;
        }
      }
    }
    lines.splice(insertIdx, 0, `${fieldName}:: ${newValue}`);
  }

  return lines.join('\n');
}

async function updateField(
  app: App,
  filePath: string,
  fieldName: string,
  newValue: string,
  isUpdatingRef: { value: boolean },
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!file || !(file instanceof TFile)) return;

  isUpdatingRef.value = true;
  try {
    await app.vault.process(file, (data) => upsertInlineField(data, fieldName, newValue));
  } finally {
    isUpdatingRef.value = false;
  }
}

// ─── Hash for tag colors ────────────────────────────────────

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeFileName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTextCellParts(value: string): TextCellPart[] | null {
  const wikiLinkRe = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  const parts: TextCellPart[] = [];
  let lastIndex = 0;
  let hasWikiLink = false;

  for (const match of value.matchAll(wikiLinkRe)) {
    const fullMatch = match[0] ?? '';
    const target = match[1]?.trim() ?? '';
    const label = (match[2] ?? target).trim();
    const index = match.index ?? 0;

    if (index > lastIndex) {
      parts.push({ type: 'text', text: value.slice(lastIndex, index) });
    }

    if (target) {
      parts.push({ type: 'wikilink', target, label: label || target });
      hasWikiLink = true;
    } else {
      parts.push({ type: 'text', text: fullMatch });
    }

    lastIndex = index + fullMatch.length;
  }

  if (!hasWikiLink) return null;
  if (lastIndex < value.length) {
    parts.push({ type: 'text', text: value.slice(lastIndex) });
  }

  return parts;
}

function parseWikiLinks(value: string): WikiLinkPart[] {
  const wikiLinkRe = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  const links: WikiLinkPart[] = [];

  for (const match of value.matchAll(wikiLinkRe)) {
    const target = match[1]?.trim() ?? '';
    const label = (match[2] ?? target).trim();
    if (!target) continue;
    links.push({ target, label: label || target });
  }

  return links;
}

function getDisplayText(value: string): string {
  const links = parseWikiLinks(value);
  if (links.length === 0) return value;
  return links.map((link) => link.label).join(', ');
}

function serializeConfigValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).join(', ');
  }
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function getReferencedSources(config: EditableViewConfig): string[] {
  const sources = new Set<string>();

  for (const field of config.fields) {
    if ((field.type === 'relation' || field.type === 'relation-multi') && field.source) {
      sources.add(field.source);
    }
    if (field.type === 'lookup' && field.relation) {
      const relationField = config.fields.find((candidate) => candidate.name === field.relation);
      if ((relationField?.type === 'relation' || relationField?.type === 'relation-multi') && relationField.source) {
        sources.add(relationField.source);
      }
    }
  }

  return [...sources];
}

// ─── EditableViewRenderer ───────────────────────────────────

class EditableViewRenderer {
  isUpdating = false;
  private isRendering = false;
  private pendingRender = false;
  private isUpdatingRef: { value: boolean };
  private state: TableState;
  private cachedRecords: FileRecord[] | null = null;
  private sourceRecordCache = new Map<string, FileRecord[]>();
  private activePopup: HTMLElement | null = null;
  private activePopupHandler: ((ev: MouseEvent) => void) | null = null;

  constructor(
    private app: App,
    private config: EditableViewConfig,
    private pluginData: PluginData,
    private onStateChange: () => void,
  ) {
    this.pluginData.relationHistory ??= {};
    this.state = pluginData.tables[config.source] ?? {
      columnOrder: config.fields.map((f) => f.name),
      hiddenColumns: [],
      sort: null,
    };
    const self = this;
    this.isUpdatingRef = {
      get value() { return self.isUpdating; },
      set value(v: boolean) { self.isUpdating = v; },
    };
  }

  /** Invalidate cache so next render re-reads files */
  invalidateCache(): void {
    this.cachedRecords = null;
    this.sourceRecordCache.clear();
  }

  /** Update a field value, invalidate cache, and re-render */
  private commitField(
    filePath: string,
    fieldName: string,
    newValue: string,
    container: HTMLElement,
    onSuccess?: () => void | Promise<void>,
  ): void {
    updateField(this.app, filePath, fieldName, newValue, this.isUpdatingRef).then(async () => {
      if (onSuccess) {
        await onSuccess();
      }
      this.invalidateCache();
      await this.preloadRelatedSources(this.config.fields);
      await this.maybeAutoRenameRecord(filePath);
      this.invalidateCache();
      this.render(container);
    });
  }

  private getPersistedFields(): FieldConfig[] {
    return this.config.fields.filter((field) => field.type !== 'lookup');
  }

  private getDefaultFieldValue(field: FieldConfig): string {
    return serializeConfigValue(this.config.defaults[field.name]);
  }

  private getUniqueFileName(baseName: string): string {
    const trimmed = sanitizeFileName(baseName) || 'Untitled';
    let fileName = trimmed;
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(`${this.config.source}/${fileName}.md`)) {
      fileName = `${trimmed} ${counter}`;
      counter++;
    }
    return fileName;
  }

  private applyTitlePattern(record: FileRecord): string {
    if (!this.config.titlePattern) return '';

    return this.config.titlePattern.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, tokenRaw: string) => {
      const token = tokenRaw.trim();
      if (!token) return '';
      if (token.endsWith('.label')) {
        const fieldName = token.slice(0, -'.label'.length);
        return this.getDisplayValue(record, fieldName);
      }
      if (token.endsWith('.value')) {
        const fieldName = token.slice(0, -'.value'.length);
        return record.fields[fieldName] ?? '';
      }
      return this.getDisplayValue(record, token);
    }).trim();
  }

  private async maybeAutoRenameRecord(filePath: string): Promise<void> {
    if (!this.config.titlePattern) return;

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof TFile)) return;
    if (!UNTITLED_FILE_RE.test(file.basename)) return;
    const oldName = file.basename;

    const content = await this.app.vault.cachedRead(file);
    const record: FileRecord = {
      filePath: file.path,
      fileName: file.basename,
      fields: parseInlineFields(content),
      aliases: getFileAliases(this.app, file),
    };
    await this.preloadRelatedSources(this.config.fields);

    const nextName = this.applyTitlePattern(record);
    if (!nextName || nextName === file.basename) return;

    const uniqueName = this.getUniqueFileName(nextName);
    const newPath = file.path.replace(/[^/]+\.md$/, `${uniqueName}.md`);
    if (newPath === file.path) return;

    await this.app.vault.rename(file, newPath);
    const renamedFile = this.app.vault.getAbstractFileByPath(newPath);
    if (!renamedFile || !(renamedFile instanceof TFile)) return;

    await this.app.vault.process(renamedFile, (data) => {
      const headingRe = new RegExp(`^(#\\s+)${escapeRegExp(oldName)}(\\s*)$`, 'm');
      if (!headingRe.test(data)) return data;
      return data.replace(headingRe, `$1${uniqueName}$2`);
    });
  }

  /** Create a new markdown file in the source folder with template/default values */
  private async createNewRecord(container: HTMLElement): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(this.config.source);
    if (!folder || !(folder instanceof TFolder)) {
      new Notice('editable-view: Source folder not found');
      return;
    }

    const baseName = this.config.newFileName ?? 'Untitled';
    const fileName = this.getUniqueFileName(baseName);
    const defaults = new Map<string, string>();
    for (const field of this.getPersistedFields()) {
      defaults.set(field.name, this.getDefaultFieldValue(field));
    }

    let content = '';
    if (this.config.template) {
      const templateFile = this.app.vault.getAbstractFileByPath(this.config.template);
      if (!templateFile || !(templateFile instanceof TFile)) {
        new Notice(`editable-view: Template not found: ${this.config.template}`);
        return;
      }

      content = await this.app.vault.cachedRead(templateFile);
      content = content.split('{{title}}').join(fileName);
      for (const field of this.getPersistedFields()) {
        content = upsertInlineField(content, field.name, defaults.get(field.name) ?? '');
      }
    } else {
      const lines = this.getPersistedFields().map((field) => `${field.name}:: ${defaults.get(field.name) ?? ''}`);
      content = lines.join('\n') + '\n';
    }

    const filePath = `${this.config.source}/${fileName}.md`;
    await this.app.vault.create(filePath, content);
  }

  /** Delete a file (move to Obsidian trash) */
  private async deleteRecord(record: FileRecord, container: HTMLElement): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(record.filePath);
    if (!file || !(file instanceof TFile)) return;

    await this.app.vault.trash(file, false);
  }

  /** Inline-rename a file from the Name cell */
  private editNameCell(td: HTMLElement, record: FileRecord, container: HTMLElement): void {
    if (td.querySelector('input')) return;

    const oldName = record.fileName;
    td.empty();
    const input = td.createEl('input', {
      cls: 'ev-cell-input',
      type: 'text',
      value: oldName,
    });
    input.focus();
    input.select();

    const commit = async () => {
      const newName = input.value.trim();
      input.remove();

      if (!newName || newName === oldName) {
        this.render(container);
        return;
      }

      const file = this.app.vault.getAbstractFileByPath(record.filePath);
      if (!file || !(file instanceof TFile)) {
        this.render(container);
        return;
      }

      const newPath = record.filePath.replace(/[^/]+\.md$/, `${newName}.md`);
      if (this.app.vault.getAbstractFileByPath(newPath)) {
        new Notice(`"${newName}" already exists`);
        this.render(container);
        return;
      }

      await this.app.vault.rename(file, newPath);
    };

    input.addEventListener('blur', () => commit());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = oldName; input.blur(); }
    });
  }

  private getVisibleFields(): FieldConfig[] {
    // Build ordered list from state, filtering out removed fields and adding new ones
    const configNames = new Set(this.config.fields.map((f) => f.name));
    const ordered: string[] = [];

    for (const name of this.state.columnOrder) {
      if (configNames.has(name)) ordered.push(name);
    }
    for (const f of this.config.fields) {
      if (!ordered.includes(f.name)) ordered.push(f.name);
    }
    this.state.columnOrder = ordered;

    const hidden = new Set(this.state.hiddenColumns);
    return ordered
      .filter((name) => !hidden.has(name))
      .map((name) => this.config.fields.find((f) => f.name === name)!)
      .filter(Boolean);
  }

  private getFieldConfig(name: string): FieldConfig | undefined {
    return this.config.fields.find((f) => f.name === name);
  }

  private getRelationHistoryKey(field: FieldConfig): string {
    return `${this.config.source}::${field.name}`;
  }

  private getRelationHistory(field: FieldConfig): string[] {
    return this.pluginData.relationHistory[this.getRelationHistoryKey(field)] ?? [];
  }

  private recordRelationSelection(field: FieldConfig, targetRecords: FileRecord[]): void {
    if (targetRecords.length === 0) return;

    const key = this.getRelationHistoryKey(field);
    const selectedPaths = targetRecords.map((record) => record.filePath);
    const deduped = [
      ...selectedPaths,
      ...this.getRelationHistory(field).filter((filePath) => !selectedPaths.includes(filePath)),
    ];

    this.pluginData.relationHistory[key] = deduped.slice(0, MAX_RELATION_HISTORY);
    this.onStateChange();
  }

  private async ensureSourceRecords(source: string): Promise<FileRecord[]> {
    const cached = this.sourceRecordCache.get(source);
    if (cached) return cached;

    const records = await loadRecords(this.app, source);
    this.sourceRecordCache.set(source, records);
    return records;
  }

  private async preloadRelatedSources(fields: FieldConfig[]): Promise<void> {
    const sources = new Set<string>();

    for (const field of fields) {
      if ((field.type === 'relation' || field.type === 'relation-multi') && field.source) {
        sources.add(field.source);
      }
      if (field.type === 'lookup' && field.relation) {
        const relationField = this.getFieldConfig(field.relation);
        if ((relationField?.type === 'relation' || relationField?.type === 'relation-multi') && relationField.source) {
          sources.add(relationField.source);
        }
      }
    }

    await Promise.all([...sources].map((source) => this.ensureSourceRecords(source)));
  }

  private resolveRelationRecord(linkTarget: string, relationField: FieldConfig, sourcePath: string): FileRecord | null {
    if (!relationField.source) return null;

    const file = this.app.metadataCache.getFirstLinkpathDest(linkTarget, sourcePath);
    if (!file) return null;
    if (!file.path.startsWith(`${relationField.source}/`)) return null;

    const sourceRecords = this.sourceRecordCache.get(relationField.source) ?? [];
    return sourceRecords.find((record) => record.filePath === file.path) ?? null;
  }

  private getRelationLinks(value: string, allowMultiple = false): WikiLinkPart[] {
    const parsedLinks = parseWikiLinks(value);
    if (parsedLinks.length > 0) return parsedLinks;

    const trimmed = value.trim();
    if (!trimmed) return [];
    const values = allowMultiple
      ? trimmed.split(',').map((part) => part.trim()).filter(Boolean)
      : [trimmed];
    return values.map((target) => ({ target, label: target }));
  }

  private getRelationCandidates(field: FieldConfig): FileRecord[] {
    if (!field.source) return [];
    return [...(this.sourceRecordCache.get(field.source) ?? [])]
      .sort((a, b) => a.fileName.localeCompare(b.fileName, 'ko'));
  }

  private filterRelationCandidates(relationRecords: FileRecord[], query: string): FileRecord[] {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return relationRecords;

    return relationRecords.filter((candidate) => {
      const haystack = [candidate.fileName, ...candidate.aliases].join(' ').toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }

  private getRelationUsageCounts(field: FieldConfig): Map<string, number> {
    const counts = new Map<string, number>();
    if (!this.cachedRecords) return counts;

    const allowMultiple = field.type === 'relation-multi';
    for (const record of this.cachedRecords) {
      const resolvedPaths = new Set(
        this.getRelationLinks(record.fields[field.name] ?? '', allowMultiple)
          .map((link) => this.resolveRelationRecord(link.target, field, record.filePath)?.filePath ?? null)
          .filter((filePath): filePath is string => filePath !== null),
      );

      for (const filePath of resolvedPaths) {
        counts.set(filePath, (counts.get(filePath) ?? 0) + 1);
      }
    }

    return counts;
  }

  private getRecommendedRelationPaths(field: FieldConfig, relationRecords: FileRecord[]): string[] {
    const availablePaths = new Set(relationRecords.map((record) => record.filePath));
    const recommended: string[] = [];

    for (const filePath of this.getRelationHistory(field)) {
      if (availablePaths.has(filePath) && !recommended.includes(filePath)) {
        recommended.push(filePath);
      }
    }

    const usageCounts = this.getRelationUsageCounts(field);
    const frequentRecords = relationRecords
      .filter((record) => !recommended.includes(record.filePath) && (usageCounts.get(record.filePath) ?? 0) > 0)
      .sort((a, b) => {
        const countDiff = (usageCounts.get(b.filePath) ?? 0) - (usageCounts.get(a.filePath) ?? 0);
        if (countDiff !== 0) return countDiff;
        return a.fileName.localeCompare(b.fileName, 'ko');
      });

    for (const record of frequentRecords) {
      recommended.push(record.filePath);
    }

    return recommended;
  }

  private getRelationDisplayGroups(field: FieldConfig, relationRecords: FileRecord[], currentValue: string, query: string): {
    ordered: FileRecord[];
    recommended: Set<string>;
    showRecommendations: boolean;
  } {
    const filtered = this.filterRelationCandidates(relationRecords, query);
    const shouldRecommend = !currentValue.trim() && !query.trim();
    if (!shouldRecommend) {
      return {
        ordered: filtered,
        recommended: new Set<string>(),
        showRecommendations: false,
      };
    }

    const filteredByPath = new Map(filtered.map((record) => [record.filePath, record]));
    const recommendedRecords = this.getRecommendedRelationPaths(field, relationRecords)
      .map((filePath) => filteredByPath.get(filePath))
      .filter((record): record is FileRecord => record !== undefined);
    const recommendedPaths = new Set(recommendedRecords.map((record) => record.filePath));
    const remainingRecords = filtered.filter((record) => !recommendedPaths.has(record.filePath));

    return {
      ordered: [...recommendedRecords, ...remainingRecords],
      recommended: recommendedPaths,
      showRecommendations: recommendedRecords.length > 0,
    };
  }

  private buildRelationListValue(targetRecords: FileRecord[], sourcePath: string): string {
    return targetRecords.map((targetRecord) => this.buildRelationValue(targetRecord, sourcePath)).join(', ');
  }

  private getLookupRawValue(record: FileRecord, field: FieldConfig): string {
    if (!field.relation || !field.field) return '';

    const relationField = this.getFieldConfig(field.relation);
    if (!relationField || (relationField.type !== 'relation' && relationField.type !== 'relation-multi')) return '';

    const relationValue = record.fields[relationField.name] ?? '';
    const relationLinks = this.getRelationLinks(relationValue, relationField.type === 'relation-multi');
    if (relationLinks.length === 0) return '';

    const separator = field.separator ?? ', ';
    const values = relationLinks
      .map((relationLink) => this.resolveRelationRecord(relationLink.target, relationField, record.filePath))
      .filter((relatedRecord): relatedRecord is FileRecord => relatedRecord !== null)
      .map((relatedRecord) => relatedRecord.fields[field.field!] ?? '')
      .filter(Boolean);

    return values.join(separator);
  }

  private getDisplayValue(record: FileRecord, fieldKey: string): string {
    if (fieldKey === '__name__') return record.fileName;

    const field = this.getFieldConfig(fieldKey);
    const rawValue = record.fields[fieldKey] ?? '';
    if (!field) return getDisplayText(rawValue);
    if (field.type === 'lookup') {
      return getDisplayText(this.getLookupRawValue(record, field));
    }

    return getDisplayText(rawValue);
  }

  private sortRecords(records: FileRecord[]): FileRecord[] {
    const { sort } = this.state;
    if (!sort) return records;

    const fieldConfig = this.getFieldConfig(sort.field);
    const isNumber = fieldConfig?.type === 'number';
    const dir = sort.direction === 'asc' ? 1 : -1;

    return [...records].sort((a, b) => {
      const va = this.getDisplayValue(a, sort.field);
      const vb = this.getDisplayValue(b, sort.field);

      // Empty values always last
      if (!va && !vb) return 0;
      if (!va) return 1;
      if (!vb) return -1;

      if (isNumber) {
        const na = parseFloat(va);
        const nb = parseFloat(vb);
        if (isNaN(na) && isNaN(nb)) return 0;
        if (isNaN(na)) return 1;
        if (isNaN(nb)) return -1;
        return (na - nb) * dir;
      }

      return va.localeCompare(vb, 'ko') * dir;
    });
  }

  private saveState(): void {
    this.pluginData.tables[this.config.source] = this.state;
    this.onStateChange();
  }

  private closeActivePopup(): void {
    if (this.activePopup) {
      this.activePopup.remove();
      this.activePopup = null;
    }
    if (this.activePopupHandler) {
      document.removeEventListener('click', this.activePopupHandler);
      this.activePopupHandler = null;
    }
  }

  private isPopupEvent(ev: MouseEvent, popup: HTMLElement): boolean {
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    if (path.length > 0) {
      return path.includes(popup);
    }

    return popup.contains(ev.target as Node);
  }

  async render(container: HTMLElement): Promise<void> {
    // Guard against concurrent renders
    if (this.isRendering) {
      this.pendingRender = true;
      return;
    }
    this.isRendering = true;

    try {
      await this.renderInternal(container);
    } finally {
      this.isRendering = false;
      if (this.pendingRender) {
        this.pendingRender = false;
        this.render(container);
      }
    }
  }

  private async renderInternal(container: HTMLElement): Promise<void> {
    if (!this.cachedRecords) {
      this.cachedRecords = await loadRecords(this.app, this.config.source);
    }
    const visibleFields = this.getVisibleFields();
    await this.preloadRelatedSources(visibleFields);
    const sorted = this.sortRecords(this.cachedRecords);

    const scrollTop = container.scrollTop;
    container.empty();
    container.addClass('ev-container');

    // ─── Toolbar ──────────────────────────────────
    const toolbar = container.createDiv({ cls: 'ev-toolbar' });
    this.renderColumnConfigButton(toolbar, container);

    // ─── Table ────────────────────────────────────
    const scrollWrapper = container.createDiv({ cls: 'ev-scroll-wrapper' });
    const table = scrollWrapper.createEl('table', { cls: 'ev-table' });

    // Header
    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr', { cls: 'ev-header-row' });

    // Name column header
    const nameHeader = headerRow.createEl('th', { cls: 'ev-th ev-th-name' });
    this.renderSortableHeader(nameHeader, 'Name', '__name__', container);

    for (const field of visibleFields) {
      const th = headerRow.createEl('th', { cls: 'ev-th' });
      this.renderSortableHeader(th, field.name, field.name, container);
    }

    // Empty header for delete column
    headerRow.createEl('th', { cls: 'ev-th ev-th-actions' });

    // Body
    const tbody = table.createEl('tbody');
    for (const record of sorted) {
      const tr = tbody.createEl('tr', { cls: 'ev-row' });
      tr.dataset['filePath'] = record.filePath;

      // Name cell (file link, double-click to rename)
      const nameTd = tr.createEl('td', { cls: 'ev-td ev-td-name' });
      const link = nameTd.createEl('a', {
        cls: 'internal-link',
        text: record.fileName,
      });
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.app.workspace.openLinkText(record.filePath, '');
      });
      nameTd.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.editNameCell(nameTd, record, container);
      });

      // Field cells
      for (const field of visibleFields) {
        const td = tr.createEl('td', { cls: 'ev-td' });
        const value = record.fields[field.name] ?? '';
        this.renderCell(td, value, field, record, container);
      }

      // Delete button cell
      const actionsTd = tr.createEl('td', { cls: 'ev-td ev-td-actions' });
      const deleteBtn = actionsTd.createEl('button', {
        cls: 'ev-delete-btn',
        text: '\u00D7',
        attr: { 'aria-label': '삭제' },
      });
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteRecord(record, container);
      });
    }

    // Add row button
    const addRow = tbody.createEl('tr', { cls: 'ev-row ev-add-row' });
    const addTd = addRow.createEl('td', {
      cls: 'ev-td ev-add-row-cell',
      attr: { colspan: String(visibleFields.length + 2) },
    });
    const addBtn = addTd.createEl('button', { cls: 'ev-add-row-btn', text: '+ New' });
    addBtn.addEventListener('click', (e) => {
      e.preventDefault();
      this.createNewRecord(container);
    });

    container.scrollTop = scrollTop;
  }

  private renderSortableHeader(th: HTMLElement, label: string, fieldKey: string, container: HTMLElement): void {
    const { sort } = this.state;
    let indicator = '';
    if (sort && sort.field === fieldKey) {
      indicator = sort.direction === 'asc' ? ' ▲' : ' ▼';
    }

    const span = th.createEl('span', { cls: 'ev-th-label', text: label + indicator });
    span.addEventListener('click', () => {
      if (!sort || sort.field !== fieldKey) {
        this.state.sort = { field: fieldKey, direction: 'asc' };
      } else if (sort.direction === 'asc') {
        this.state.sort = { field: fieldKey, direction: 'desc' };
      } else {
        this.state.sort = null;
      }
      this.saveState();
      this.render(container);
    });
  }

  private renderCell(td: HTMLElement, value: string, field: FieldConfig, record: FileRecord, container: HTMLElement): void {
    switch (field.type) {
      case 'checkbox':
        this.renderCheckboxCell(td, value, field, record, container);
        break;
      case 'url':
        this.renderUrlCell(td, value, field, record, container);
        break;
      case 'relation':
        this.renderRelationCell(td, value, field, record, container);
        break;
      case 'relation-multi':
        this.renderRelationMultiCell(td, value, field, record, container);
        break;
      case 'lookup':
        this.renderLookupCell(td, field, record);
        break;
      case 'dropdown':
      case 'dropdown-multi':
        this.renderTagCell(td, value, field, record, container);
        break;
      default:
        this.renderTextCell(td, value, field, record, container);
        break;
    }
  }

  // ─── Cell Renderers ─────────────────────────────

  private renderLinkedTextParts(td: HTMLElement, value: string, sourcePath: string): void {
    td.empty();
    td.removeClass('ev-td-has-wikilinks');
    const parts = parseTextCellParts(value);

    if (!parts) {
      td.textContent = value;
      return;
    }

    td.classList.add('ev-td-has-wikilinks');
    for (const part of parts) {
      if (part.type === 'text') {
        if (!part.text) continue;
        td.createSpan({ cls: 'ev-text-fragment', text: part.text });
        continue;
      }

      const link = td.createEl('a', {
        cls: 'internal-link ev-text-link',
        text: part.label,
      });
      link.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.app.workspace.openLinkText(part.target, sourcePath);
      });
    }
  }

  private renderTextCell(td: HTMLElement, value: string, field: FieldConfig, record: FileRecord, container: HTMLElement): void {
    td.classList.add('ev-td-editable');
    this.renderLinkedTextParts(td, value, record.filePath);

    td.addEventListener('click', (e) => {
      if (td.querySelector('input')) return;
      if (e.target instanceof HTMLElement && e.target.closest('a')) return;

      const inputType = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text';
      td.empty();
      const input = td.createEl('input', {
        cls: 'ev-cell-input',
        type: inputType,
        value,
      });
      input.focus();

      if (field.type === 'date') {
        try { input.showPicker(); } catch { /* not supported */ }
      }

      const commit = () => {
        const newValue = input.value.trim();
        input.remove();
        if (newValue !== value) {
          this.commitField(record.filePath, field.name, newValue, container);
        } else {
          this.renderLinkedTextParts(td, value, record.filePath);
        }
      };

      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = value; input.blur(); }
      });
    });
  }

  private renderRelationCell(td: HTMLElement, value: string, field: FieldConfig, record: FileRecord, container: HTMLElement): void {
    td.classList.add('ev-td-editable', 'ev-td-relation');
    this.renderLinkedTextParts(td, value, record.filePath);

    td.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target instanceof HTMLElement && e.target.closest('a')) return;
      this.showRelationPicker(td, value, field, record, container);
    });
  }

  private renderRelationMultiCell(td: HTMLElement, value: string, field: FieldConfig, record: FileRecord, container: HTMLElement): void {
    td.classList.add('ev-td-editable', 'ev-td-relation', 'ev-td-relation-multi');
    this.renderLinkedTextParts(td, value, record.filePath);

    td.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target instanceof HTMLElement && e.target.closest('a')) return;
      this.showRelationMultiPicker(td, value, field, record, container);
    });
  }

  private renderLookupCell(td: HTMLElement, field: FieldConfig, record: FileRecord): void {
    td.classList.add('ev-td-readonly');
    this.renderLinkedTextParts(td, this.getLookupRawValue(record, field), record.filePath);
  }

  private buildRelationValue(targetRecord: FileRecord, sourcePath: string): string {
    const file = this.app.vault.getAbstractFileByPath(targetRecord.filePath);
    if (!file || !(file instanceof TFile)) return `[[${targetRecord.fileName}]]`;

    const linkText = this.app.metadataCache.fileToLinktext(file, sourcePath, true);
    return linkText === targetRecord.fileName
      ? `[[${linkText}]]`
      : `[[${linkText}|${targetRecord.fileName}]]`;
  }

  private showRelationPicker(td: HTMLElement, value: string, field: FieldConfig, record: FileRecord, container: HTMLElement): void {
    if (!field.source) {
      new Notice(`editable-view: "${field.name}" is missing relation source`);
      return;
    }

    this.closeActivePopup();

    const relationRecords = this.getRelationCandidates(field);
    const selectedPath = this.getRelationLinks(value)[0]
      ? this.resolveRelationRecord(this.getRelationLinks(value)[0]!.target, field, record.filePath)?.filePath ?? null
      : null;

    const popup = document.createElement('div');
    popup.className = 'ev-dropdown-popup ev-relation-popup';
    this.activePopup = popup;

    const searchInput = document.createElement('input');
    searchInput.className = 'ev-relation-search';
    searchInput.type = 'text';
    searchInput.placeholder = 'Search notes...';
    popup.appendChild(searchInput);

    const list = document.createElement('div');
    list.className = 'ev-relation-list';
    popup.appendChild(list);

    let activeIndex = 0;

    const getFiltered = () => {
      return this.getRelationDisplayGroups(field, relationRecords, value, searchInput.value).ordered;
    };

    const chooseRecord = (targetRecord: FileRecord) => {
      this.closeActivePopup();
      const newValue = this.buildRelationValue(targetRecord, record.filePath);
      if (newValue !== value) {
        this.commitField(record.filePath, field.name, newValue, container, () => {
          this.recordRelationSelection(field, [targetRecord]);
        });
      }
    };

    const renderList = () => {
      const { ordered, recommended, showRecommendations } = this.getRelationDisplayGroups(field, relationRecords, value, searchInput.value);
      if (activeIndex >= ordered.length) activeIndex = Math.max(ordered.length - 1, 0);

      list.empty();
      if (ordered.length === 0) {
        list.createDiv({ cls: 'ev-relation-empty', text: 'No matches' });
        return;
      }

      let renderedRecommendationHeader = false;
      let renderedAllHeader = false;
      ordered.forEach((candidate, index) => {
        const isRecommended = recommended.has(candidate.filePath);
        if (showRecommendations && isRecommended && !renderedRecommendationHeader) {
          list.createDiv({ cls: 'ev-relation-section', text: '추천' });
          renderedRecommendationHeader = true;
        }
        if (showRecommendations && !isRecommended && !renderedAllHeader) {
          list.createDiv({ cls: 'ev-relation-section ev-relation-section-secondary', text: '전체' });
          renderedAllHeader = true;
        }

        const item = list.createDiv({ cls: 'ev-dropdown-item ev-relation-item' });
        if (candidate.filePath === selectedPath) item.addClass('is-selected');
        if (index === activeIndex) item.addClass('is-active');

        item.createDiv({ cls: 'ev-relation-item-main', text: candidate.fileName });
        if (candidate.aliases.length > 0) {
          item.createDiv({ cls: 'ev-relation-item-meta', text: candidate.aliases.join(', ') });
        }

        item.addEventListener('mouseenter', () => {
          activeIndex = index;
        });
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          chooseRecord(candidate);
        });
      });
    };

    searchInput.addEventListener('input', () => {
      activeIndex = 0;
      renderList();
    });
    searchInput.addEventListener('keydown', (e) => {
      const filtered = getFiltered();

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (filtered.length > 0) activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
        renderList();
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (filtered.length > 0) activeIndex = Math.max(activeIndex - 1, 0);
        renderList();
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const targetRecord = filtered[activeIndex];
        if (targetRecord) chooseRecord(targetRecord);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeActivePopup();
      }
    });

    const clearItem = document.createElement('div');
    clearItem.className = 'ev-dropdown-item ev-dropdown-clear';
    clearItem.textContent = '비우기';
    clearItem.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeActivePopup();
      if (value) {
        this.commitField(record.filePath, field.name, '', container);
      }
    });
    popup.appendChild(clearItem);

    renderList();
    document.body.appendChild(popup);
    this.positionPopup(popup, td);
    searchInput.focus();

    setTimeout(() => {
      this.activePopupHandler = (ev: MouseEvent) => {
        if (!this.isPopupEvent(ev, popup)) {
          this.closeActivePopup();
        }
      };
      document.addEventListener('click', this.activePopupHandler);
    }, 0);
  }

  private showRelationMultiPicker(td: HTMLElement, value: string, field: FieldConfig, record: FileRecord, container: HTMLElement): void {
    if (!field.source) {
      new Notice(`editable-view: "${field.name}" is missing relation source`);
      return;
    }

    this.closeActivePopup();

    const relationRecords = this.getRelationCandidates(field);
    const selectedPaths = new Set(
      this.getRelationLinks(value, true)
        .map((link) => this.resolveRelationRecord(link.target, field, record.filePath)?.filePath ?? null)
        .filter((filePath): filePath is string => filePath !== null),
    );

    const popup = document.createElement('div');
    popup.className = 'ev-dropdown-popup ev-relation-popup';
    this.activePopup = popup;

    const searchInput = document.createElement('input');
    searchInput.className = 'ev-relation-search';
    searchInput.type = 'text';
    searchInput.placeholder = 'Search notes...';
    popup.appendChild(searchInput);

    const list = document.createElement('div');
    list.className = 'ev-relation-list';
    popup.appendChild(list);

    let activeIndex = 0;

    const getFiltered = () => {
      return this.getRelationDisplayGroups(field, relationRecords, value, searchInput.value).ordered;
    };

    const commitSelection = () => {
      const selectedRecords = relationRecords.filter((candidate) => selectedPaths.has(candidate.filePath));
      const newValue = this.buildRelationListValue(selectedRecords, record.filePath);
      if (newValue !== value) {
        this.commitField(record.filePath, field.name, newValue, container, () => {
          this.recordRelationSelection(field, selectedRecords);
        });
      }
    };

    const toggleRecord = (targetRecord: FileRecord) => {
      if (selectedPaths.has(targetRecord.filePath)) {
        selectedPaths.delete(targetRecord.filePath);
      } else {
        selectedPaths.add(targetRecord.filePath);
      }
      renderList();
    };

    const renderList = () => {
      const { ordered, recommended, showRecommendations } = this.getRelationDisplayGroups(field, relationRecords, value, searchInput.value);
      if (activeIndex >= ordered.length) activeIndex = Math.max(ordered.length - 1, 0);

      list.empty();
      if (ordered.length === 0) {
        list.createDiv({ cls: 'ev-relation-empty', text: 'No matches' });
        return;
      }

      let renderedRecommendationHeader = false;
      let renderedAllHeader = false;
      ordered.forEach((candidate, index) => {
        const isRecommended = recommended.has(candidate.filePath);
        if (showRecommendations && isRecommended && !renderedRecommendationHeader) {
          list.createDiv({ cls: 'ev-relation-section', text: '추천' });
          renderedRecommendationHeader = true;
        }
        if (showRecommendations && !isRecommended && !renderedAllHeader) {
          list.createDiv({ cls: 'ev-relation-section ev-relation-section-secondary', text: '전체' });
          renderedAllHeader = true;
        }

        const item = list.createDiv({ cls: 'ev-dropdown-multi-item ev-relation-item' });
        if (selectedPaths.has(candidate.filePath)) item.addClass('is-selected');
        if (index === activeIndex) item.addClass('is-active');

        const checkbox = item.createEl('input', { type: 'checkbox' });
        checkbox.checked = selectedPaths.has(candidate.filePath);
        checkbox.addEventListener('click', (e) => {
          e.stopPropagation();
        });
        checkbox.addEventListener('change', () => {
          toggleRecord(candidate);
        });

        const content = item.createDiv({ cls: 'ev-relation-item-content' });
        content.createDiv({ cls: 'ev-relation-item-main', text: candidate.fileName });
        if (candidate.aliases.length > 0) {
          content.createDiv({ cls: 'ev-relation-item-meta', text: candidate.aliases.join(', ') });
        }

        item.addEventListener('mouseenter', () => {
          activeIndex = index;
        });
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          if (e.target instanceof HTMLInputElement) return;
          toggleRecord(candidate);
        });
      });
    };

    searchInput.addEventListener('input', () => {
      activeIndex = 0;
      renderList();
    });
    searchInput.addEventListener('keydown', (e) => {
      const filtered = getFiltered();

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (filtered.length > 0) activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
        renderList();
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (filtered.length > 0) activeIndex = Math.max(activeIndex - 1, 0);
        renderList();
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const targetRecord = filtered[activeIndex];
        if (targetRecord) toggleRecord(targetRecord);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeActivePopup();
        commitSelection();
      }
    });

    const clearItem = document.createElement('div');
    clearItem.className = 'ev-dropdown-item ev-dropdown-clear';
    clearItem.textContent = '비우기';
    clearItem.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedPaths.clear();
      this.closeActivePopup();
      if (value) {
        this.commitField(record.filePath, field.name, '', container);
      }
    });
    popup.appendChild(clearItem);

    renderList();
    document.body.appendChild(popup);
    this.positionPopup(popup, td);
    searchInput.focus();

    setTimeout(() => {
      this.activePopupHandler = (ev: MouseEvent) => {
        if (!this.isPopupEvent(ev, popup)) {
          this.closeActivePopup();
          commitSelection();
        }
      };
      document.addEventListener('click', this.activePopupHandler);
    }, 0);
  }

  private renderCheckboxCell(td: HTMLElement, value: string, field: FieldConfig, record: FileRecord, container: HTMLElement): void {
    const checkbox = td.createEl('input', { type: 'checkbox', cls: 'ev-cell-checkbox' });
    checkbox.checked = value === 'true';

    checkbox.addEventListener('change', () => {
      const newValue = checkbox.checked ? 'true' : 'false';
      this.commitField(record.filePath, field.name, newValue, container);
    });
  }

  private renderUrlCell(td: HTMLElement, value: string, field: FieldConfig, record: FileRecord, container: HTMLElement): void {
    td.classList.add('ev-td-url');

    if (value) {
      const linkWrapper = td.createDiv({ cls: 'ev-url-wrapper' });
      const link = linkWrapper.createEl('a', {
        cls: 'ev-url-link',
        href: value,
        text: '↗',
        attr: { target: '_blank', rel: 'noopener' },
      });
      link.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      const urlText = linkWrapper.createEl('span', {
        cls: 'ev-url-text',
        text: value.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      });
      urlText.addEventListener('click', () => {
        this.editUrlCell(td, value, field, record, container);
      });
    } else {
      td.classList.add('ev-td-editable');
      td.addEventListener('click', () => {
        this.editUrlCell(td, value, field, record, container);
      });
    }
  }

  private editUrlCell(td: HTMLElement, value: string, field: FieldConfig, record: FileRecord, container: HTMLElement): void {
    if (td.querySelector('input')) return;
    td.empty();
    const input = td.createEl('input', {
      cls: 'ev-cell-input',
      type: 'url',
      value,
      attr: { placeholder: 'https://' },
    });
    input.focus();

    const commit = () => {
      const newValue = input.value.trim();
      input.remove();
      if (newValue !== value) {
        this.commitField(record.filePath, field.name, newValue, container);
      } else {
        this.render(container);
      }
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = value; input.blur(); }
    });
  }

  private renderTagCell(td: HTMLElement, value: string, field: FieldConfig, record: FileRecord, container: HTMLElement): void {
    td.classList.add('ev-td-editable');

    if (field.type === 'dropdown-multi' && value) {
      const tags = value.split(',').map((t) => t.trim()).filter(Boolean);
      for (const tag of tags) {
        const hue = hashString(tag) % 360;
        const span = td.createEl('span', { cls: 'ev-tag', text: tag });
        span.style.setProperty('--ev-tag-hue', String(hue));
      }
    } else if (value) {
      const hue = hashString(value) % 360;
      const span = td.createEl('span', { cls: 'ev-tag', text: value });
      span.style.setProperty('--ev-tag-hue', String(hue));
    }

    td.addEventListener('click', (e) => {
      e.stopPropagation();
      if (field.type === 'dropdown-multi') {
        this.showMultiDropdown(td, value, field, record, container);
      } else {
        this.showDropdown(td, value, field, record, container);
      }
    });
  }

  // ─── Dropdown Popups ────────────────────────────

  private showDropdown(td: HTMLElement, value: string, field: FieldConfig, record: FileRecord, container: HTMLElement): void {
    this.closeActivePopup();

    const popup = document.createElement('div');
    popup.className = 'ev-dropdown-popup';
    this.activePopup = popup;

    for (const opt of field.options) {
      const item = document.createElement('div');
      item.className = 'ev-dropdown-item';
      if (opt === value) item.classList.add('is-selected');

      const hue = hashString(opt) % 360;
      const tag = document.createElement('span');
      tag.className = 'ev-tag';
      tag.textContent = opt;
      tag.style.setProperty('--ev-tag-hue', String(hue));
      item.appendChild(tag);

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeActivePopup();
        if (opt !== value) {
          this.commitField(record.filePath, field.name, opt, container);
        }
      });
      popup.appendChild(item);
    }

    // Clear option
    const clearItem = document.createElement('div');
    clearItem.className = 'ev-dropdown-item ev-dropdown-clear';
    clearItem.textContent = '비우기';
    clearItem.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeActivePopup();
      if (value) {
        this.commitField(record.filePath, field.name, '', container);
      }
    });
    popup.appendChild(clearItem);

    document.body.appendChild(popup);
    this.positionPopup(popup, td);

    setTimeout(() => {
      this.activePopupHandler = (ev: MouseEvent) => {
        if (!this.isPopupEvent(ev, popup)) {
          this.closeActivePopup();
        }
      };
      document.addEventListener('click', this.activePopupHandler);
    }, 0);
  }

  private showMultiDropdown(td: HTMLElement, value: string, field: FieldConfig, record: FileRecord, container: HTMLElement): void {
    this.closeActivePopup();

    const selected = new Set(value ? value.split(',').map((t) => t.trim()).filter(Boolean) : []);
    const popup = document.createElement('div');
    popup.className = 'ev-dropdown-popup';
    this.activePopup = popup;

    for (const opt of field.options) {
      const item = document.createElement('label');
      item.className = 'ev-dropdown-multi-item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = selected.has(opt);
      cb.addEventListener('change', () => {
        if (cb.checked) {
          selected.add(opt);
        } else {
          selected.delete(opt);
        }
      });
      item.appendChild(cb);

      const hue = hashString(opt) % 360;
      const tag = document.createElement('span');
      tag.className = 'ev-tag';
      tag.textContent = opt;
      tag.style.setProperty('--ev-tag-hue', String(hue));
      item.appendChild(tag);

      item.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      popup.appendChild(item);
    }

    document.body.appendChild(popup);
    this.positionPopup(popup, td);

    setTimeout(() => {
      this.activePopupHandler = (ev: MouseEvent) => {
        if (!this.isPopupEvent(ev, popup)) {
          this.closeActivePopup();
          const newValue = [...selected].join(', ');
          if (newValue !== value) {
            this.commitField(record.filePath, field.name, newValue, container);
          }
        }
      };
      document.addEventListener('click', this.activePopupHandler);
    }, 0);
  }

  private positionPopup(popup: HTMLElement, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${rect.left}px`;

    // Adjust if popup goes below viewport
    requestAnimationFrame(() => {
      const popupRect = popup.getBoundingClientRect();
      if (popupRect.bottom > window.innerHeight) {
        popup.style.top = `${rect.top - popupRect.height - 4}px`;
      }
      if (popupRect.right > window.innerWidth) {
        popup.style.left = `${window.innerWidth - popupRect.width - 8}px`;
      }
    });
  }

  // ─── Column Config Panel ────────────────────────

  private renderColumnConfigButton(toolbar: HTMLElement, container: HTMLElement): void {
    const btn = toolbar.createEl('button', { cls: 'ev-column-config-btn', text: 'Columns' });
    let panel: HTMLElement | null = null;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (panel) {
        panel.remove();
        panel = null;
        return;
      }

      panel = toolbar.createDiv({ cls: 'ev-column-config-panel' });
      panel.addEventListener('click', (ev) => ev.stopPropagation());

      this.renderColumnConfigItems(panel, container);

      // Close on outside click
      const closePanel = (ev: MouseEvent) => {
        if (panel && !panel.contains(ev.target as Node) && ev.target !== btn) {
          panel.remove();
          panel = null;
          document.removeEventListener('click', closePanel);
        }
      };
      setTimeout(() => document.addEventListener('click', closePanel), 0);
    });
  }

  private renderColumnConfigItems(panel: HTMLElement, container: HTMLElement): void {
    panel.empty();
    const hidden = new Set(this.state.hiddenColumns);
    let dragSrcIdx: number | null = null;

    for (let i = 0; i < this.state.columnOrder.length; i++) {
      const name = this.state.columnOrder[i]!;
      const item = panel.createDiv({ cls: 'ev-column-config-item' });
      item.draggable = true;
      item.dataset['idx'] = String(i);

      // Drag handle
      item.createEl('span', { cls: 'ev-drag-handle', text: '⠿' });

      // Visibility checkbox
      const cb = item.createEl('input', { type: 'checkbox', cls: 'ev-column-config-cb' });
      cb.checked = !hidden.has(name);
      cb.addEventListener('change', () => {
        if (cb.checked) {
          this.state.hiddenColumns = this.state.hiddenColumns.filter((n) => n !== name);
        } else {
          this.state.hiddenColumns.push(name);
        }
        this.saveState();
        this.render(container);
      });

      item.createEl('span', { cls: 'ev-column-config-name', text: name });

      // Drag events
      item.addEventListener('dragstart', (e) => {
        dragSrcIdx = i;
        item.classList.add('ev-dragging');
        e.dataTransfer?.setData('text/plain', String(i));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        item.classList.add('ev-drag-over');
      });

      item.addEventListener('dragleave', () => {
        item.classList.remove('ev-drag-over');
      });

      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('ev-drag-over');
        if (dragSrcIdx === null || dragSrcIdx === i) return;

        const order = [...this.state.columnOrder];
        const [moved] = order.splice(dragSrcIdx, 1);
        if (moved) {
          order.splice(i, 0, moved);
          this.state.columnOrder = order;
          this.saveState();
          this.renderColumnConfigItems(panel, container);
          this.render(container);
        }
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('ev-dragging');
        dragSrcIdx = null;
      });
    }
  }
}

// ─── Plugin ─────────────────────────────────────────────────

export default class EditableViewPlugin extends Plugin {
  private pluginData: PluginData = { tables: {}, relationHistory: {} };

  async onload(): Promise<void> {
    const saved = await this.loadData();
    if (saved && typeof saved === 'object') {
      const savedData = saved as Record<string, unknown>;
      const tables = savedData['tables'];
      const relationHistory = savedData['relationHistory'];
      this.pluginData = {
        tables: tables && typeof tables === 'object' && !Array.isArray(tables)
          ? tables as Record<string, TableState>
          : {},
        relationHistory: relationHistory && typeof relationHistory === 'object' && !Array.isArray(relationHistory)
          ? relationHistory as Record<string, string[]>
          : {},
      };
    }

    this.registerMarkdownCodeBlockProcessor(
      'editable-view',
      (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
        const config = parseConfig(source);
        if (!config) {
          el.createEl('p', { text: 'editable-view: Invalid configuration.', cls: 'ev-error' });
          new Notice('editable-view: Invalid configuration');
          return;
        }

        // Use MarkdownRenderChild for proper lifecycle management.
        // Events registered on `child` are automatically cleaned up when
        // the code block is removed (page navigation, view switch, re-render).
        const child = new MarkdownRenderChild(el);
        ctx.addChild(child);

        const renderer = new EditableViewRenderer(
          this.app,
          config,
          this.pluginData,
          () => this.saveData(this.pluginData),
        );
        const watchedSources = new Set([config.source, ...getReferencedSources(config)]);

        let refreshTimeout: ReturnType<typeof setTimeout> | null = null;
        const scheduleRefresh = () => {
          if (refreshTimeout) clearTimeout(refreshTimeout);
          refreshTimeout = setTimeout(() => renderer.render(el), DEBOUNCE_MS);
        };

        // Invalidate cache + re-render on vault changes
        const invalidateAndRefresh = () => {
          renderer.invalidateCache();
          scheduleRefresh();
        };
        const watchesPath = (path: string) => [...watchedSources].some((source) => path.startsWith(`${source}/`));

        // Register events on child (not plugin) so they are cleaned up on unload
        child.registerEvent(
          this.app.vault.on('modify', (file) => {
            if (watchesPath(file.path) && !renderer.isUpdating) {
              invalidateAndRefresh();
            }
          }),
        );
        child.registerEvent(
          this.app.vault.on('delete', (file) => {
            if (watchesPath(file.path)) invalidateAndRefresh();
          }),
        );
        child.registerEvent(
          this.app.vault.on('create', (file) => {
            if (watchesPath(file.path)) invalidateAndRefresh();
          }),
        );
        child.registerEvent(
          this.app.vault.on('rename', (file, oldPath) => {
            if (watchesPath(file.path) || watchesPath(oldPath)) {
              invalidateAndRefresh();
            }
          }),
        );

        // Clean up debounce timer on unload
        child.register(() => {
          if (refreshTimeout) clearTimeout(refreshTimeout);
        });

        // Initial render (awaited via then to ensure el is populated before events fire)
        renderer.render(el);
      },
    );
  }

  async onunload(): Promise<void> {}
}
