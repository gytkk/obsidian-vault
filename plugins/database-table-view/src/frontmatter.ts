import { App, TFile, TFolder, Vault, parseYaml } from 'obsidian';

import type { ColumnSchema, RowRecord, TableSchema } from './models';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const INVALID_FILE_NAME_RE = /[\\/:*?"<>|]/g;

export function sanitizeFileBaseName(value: string): string {
  return value.replace(INVALID_FILE_NAME_RE, '-').replace(/\s+/g, ' ').trim();
}

export function buildFilePath(sourceFolder: string, baseName: string): string {
  return sourceFolder ? `${sourceFolder}/${baseName}.md` : `${baseName}.md`;
}

export function validateRowName(
  app: App,
  table: TableSchema,
  rawName: string,
  excludeFilePath?: string,
): { ok: true; baseName: string; filePath: string } | { ok: false; reason: 'empty' | 'duplicate' } {
  const baseName = sanitizeFileBaseName(rawName);
  if (!baseName) {
    return { ok: false, reason: 'empty' };
  }

  const filePath = buildFilePath(table.sourceFolder, baseName);
  if (excludeFilePath !== filePath && app.vault.getAbstractFileByPath(filePath)) {
    return { ok: false, reason: 'duplicate' };
  }

  return { ok: true, baseName, filePath };
}

async function readFrontmatter(app: App, file: TFile): Promise<Record<string, unknown>> {
  const content = await app.vault.cachedRead(file);
  const match = content.match(FRONTMATTER_RE);
  if (!match?.[1]) return {};

  try {
    const parsed = parseYaml(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid frontmatter is treated as empty so the table can still render.
  }

  return {};
}

async function collectMarkdownFiles(app: App, sourceFolder: string): Promise<TFile[]> {
  const folder = app.vault.getAbstractFileByPath(sourceFolder);
  if (!folder || !(folder instanceof TFolder)) return [];

  const files: TFile[] = [];
  Vault.recurseChildren(folder, (entry) => {
    if (entry instanceof TFile && entry.extension === 'md') {
      files.push(entry);
    }
  });

  files.sort((left, right) => left.basename.localeCompare(right.basename, 'ko', { numeric: true, sensitivity: 'base' }));
  return files;
}

function normalizeColumnValue(column: ColumnSchema, rawValue: unknown): unknown {
  switch (column.type) {
    case 'checkbox':
      return rawValue === true;
    case 'multi-select':
      if (Array.isArray(rawValue)) {
        return rawValue.map((value) => String(value).trim()).filter(Boolean);
      }
      if (typeof rawValue === 'string') {
        return rawValue.split(',').map((value) => value.trim()).filter(Boolean);
      }
      return [];
    case 'relation':
    case 'single-select':
    case 'text':
      if (rawValue === null || rawValue === undefined) return '';
      return String(rawValue).trim();
    default:
      return rawValue;
  }
}

function serializeColumnValue(column: ColumnSchema, value: unknown): unknown {
  switch (column.type) {
    case 'checkbox':
      return value === true;
    case 'multi-select': {
      const normalized = Array.isArray(value)
        ? value.map((entry) => String(entry).trim()).filter(Boolean)
        : [];
      return normalized.length > 0 ? normalized : undefined;
    }
    case 'relation':
    case 'single-select':
    case 'text': {
      const normalized = typeof value === 'string' ? value.trim() : '';
      return normalized ? normalized : undefined;
    }
    default:
      return undefined;
  }
}

export async function loadRows(app: App, table: TableSchema): Promise<RowRecord[]> {
  const files = await collectMarkdownFiles(app, table.sourceFolder);

  return Promise.all(files.map(async (file) => {
    const frontmatter = await readFrontmatter(app, file);
    const values: Record<string, unknown> = {};
    for (const column of table.columns) {
      values[column.id] = normalizeColumnValue(column, frontmatter[column.name]);
    }

    return {
      file,
      filePath: file.path,
      name: file.basename,
      values,
    };
  }));
}

export async function createRowFile(app: App, table: TableSchema, baseName: string): Promise<TFile> {
  return app.vault.create(buildFilePath(table.sourceFolder, baseName), '');
}

export async function renameRowFile(app: App, row: RowRecord, table: TableSchema, nextName: string): Promise<void> {
  const validation = validateRowName(app, table, nextName, row.filePath);
  if (!validation.ok) {
    throw new Error(validation.reason);
  }

  await app.fileManager.renameFile(row.file, validation.filePath);
}

export async function deleteRowFile(app: App, row: RowRecord): Promise<void> {
  await app.vault.trash(row.file, false);
}

export async function updateColumnValue(
  app: App,
  row: RowRecord,
  column: ColumnSchema,
  value: unknown,
): Promise<void> {
  const serialized = serializeColumnValue(column, value);
  await app.fileManager.processFrontMatter(row.file, (frontmatter: Record<string, unknown>) => {
    if (serialized === undefined) {
      delete frontmatter[column.name];
      return;
    }
    frontmatter[column.name] = serialized;
  });
}

export async function renameColumnProperty(
  app: App,
  table: TableSchema,
  previousName: string,
  nextName: string,
): Promise<void> {
  if (previousName === nextName) return;

  const files = await collectMarkdownFiles(app, table.sourceFolder);
  for (const file of files) {
    await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      if (!(previousName in frontmatter)) return;
      if (!(nextName in frontmatter)) {
        frontmatter[nextName] = frontmatter[previousName];
      }
      delete frontmatter[previousName];
    });
  }
}
