import { App, TFile, TFolder, Vault } from 'obsidian';

import type { RowRecord, TableSchema } from './models';

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
    const parsed = app.metadataCache.getFileCache(file)?.frontmatter;
    if (parsed) return parsed;
  } catch {
    // Fall back to an empty object when metadata cache is unavailable.
  }

  return {};
}

export async function loadRows(app: App, table: TableSchema): Promise<RowRecord[]> {
  const folder = app.vault.getAbstractFileByPath(table.sourceFolder);
  if (!folder || !(folder instanceof TFolder)) return [];

  const files: TFile[] = [];
  Vault.recurseChildren(folder, (entry) => {
    if (entry instanceof TFile && entry.extension === 'md') {
      files.push(entry);
    }
  });

  files.sort((left, right) => left.basename.localeCompare(right.basename, 'ko', { numeric: true, sensitivity: 'base' }));

  return Promise.all(files.map(async (file) => {
    const frontmatter = await readFrontmatter(app, file);
    const values: Record<string, unknown> = {};
    for (const column of table.columns) {
      values[column.id] = frontmatter[column.name];
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
