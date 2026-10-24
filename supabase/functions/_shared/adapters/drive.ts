// Read-only Google Drive inspection for the Drive Picker flows (SRS V1.5 FR-GD-001..006).
// Never uploads, edits, moves, deletes or renames Drive content.
import * as XLSX from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
import { parseWorkbook, type RawSheet, type SheetJsLike } from '../core/index.ts';
import { classifyHttp, fetchWithRetry } from './fetch.ts';
import { accessToken } from './oauth.ts';
import { SourceError } from './types.ts';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const MIME_FOLDER = 'application/vnd.google-apps.folder';
const MIME_SHEET = 'application/vnd.google-apps.spreadsheet';
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_XLS = 'application/vnd.ms-excel';

export interface DriveItemInfo {
  id: string;
  name: string;
  kind: 'folder' | 'google-sheet' | 'xlsx' | 'xls' | 'csv' | 'unsupported';
  mimeType: string;
}

/** projectId null = the platform credential used before a project exists. */
async function credFetch(projectId: string | null, credentialId: string, url: string, what: string): Promise<Response> {
  const token = await accessToken(projectId, credentialId, 'google');
  const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) classifyHttp(res, what);
  return res;
}

function kindOf(mimeType: string): DriveItemInfo['kind'] {
  if (mimeType === MIME_FOLDER) return 'folder';
  if (mimeType === MIME_SHEET) return 'google-sheet';
  if (mimeType === MIME_XLSX) return 'xlsx';
  if (mimeType === MIME_XLS) return 'xls';
  if (mimeType === 'text/csv') return 'csv';
  return 'unsupported';
}

export async function inspectItem(projectId: string | null, credentialId: string, id: string): Promise<DriveItemInfo> {
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new SourceError('NOT_FOUND', 'Not a valid Google Drive item id');
  const res = await credFetch(projectId, credentialId, `${DRIVE}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,trashed&supportsAllDrives=true`, 'Drive item');
  const f = await res.json();
  if (f.trashed) throw new SourceError('NOT_FOUND', `“${f.name}” is in the trash`);
  return { id: f.id, name: f.name, mimeType: f.mimeType, kind: kindOf(f.mimeType) };
}

async function listChildren(projectId: string | null, credentialId: string, folderId: string, mimeFilter: string): Promise<DriveItemInfo[]> {
  const q = `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false and (${mimeFilter})`;
  const out: DriveItemInfo[] = [];
  let pageToken = '';
  do {
    const url = `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType)&pageSize=200&orderBy=name&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const j = await (await credFetch(projectId, credentialId, url, 'Drive folder')).json();
    for (const f of j.files as { id: string; name: string; mimeType: string }[]) out.push({ id: f.id, name: f.name, mimeType: f.mimeType, kind: kindOf(f.mimeType) });
    pageToken = j.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

export function listSubfolders(projectId: string | null, credentialId: string, folderId: string): Promise<DriveItemInfo[]> {
  return listChildren(projectId, credentialId, folderId, `mimeType = '${MIME_FOLDER}'`);
}

export function listWorkbooks(projectId: string | null, credentialId: string, folderId: string): Promise<DriveItemInfo[]> {
  return listChildren(projectId, credentialId, folderId, `mimeType = '${MIME_SHEET}' or mimeType = '${MIME_XLSX}' or mimeType = '${MIME_XLS}'`);
}

/** Sheet tabs of a workbook for the confirmation preview (Sheets metadata, or a downloaded Excel file). */
export async function workbookSheets(projectId: string | null, credentialId: string, item: DriveItemInfo): Promise<RawSheet[]> {
  if (item.kind === 'google-sheet') {
    const meta = await (await credFetch(projectId, credentialId, `${SHEETS}/${encodeURIComponent(item.id)}?fields=sheets.properties(sheetId,title,hidden)`, 'Sheets metadata')).json();
    const props = (meta.sheets as { properties: { sheetId: number; title: string; hidden?: boolean } }[]).map((s) => s.properties);
    if (!props.length) return [];
    // First 10 rows are enough to classify each tab (header detection).
    const ranges = props.map((p) => `ranges=${encodeURIComponent(`'${p.title.replace(/'/g, "''")}'!A1:Z10`)}`).join('&');
    const vals = await (await credFetch(projectId, credentialId, `${SHEETS}/${encodeURIComponent(item.id)}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE`, 'Sheets values')).json();
    return props.map((p, i) => ({ sheetId: String(p.sheetId), title: p.title, hidden: !!p.hidden, rows: vals.valueRanges?.[i]?.values ?? [] }));
  }
  if (item.kind === 'unsupported' || item.kind === 'folder') return [];
  const res = await credFetch(projectId, credentialId, `${DRIVE}/files/${encodeURIComponent(item.id)}?alt=media&supportsAllDrives=true`, 'Drive download');
  try {
    return parseWorkbook(XLSX as unknown as SheetJsLike, new Uint8Array(await res.arrayBuffer()));
  } catch (e) {
    throw new SourceError('PARSE_FAILED', `Could not read “${item.name}”: ${(e as Error).message}`);
  }
}
