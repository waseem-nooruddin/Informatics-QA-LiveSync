import * as XLSX from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
import { parseWorkbook, type Cell, type RawSheet, type SheetJsLike } from '../core/index.ts';
import { classifyHttp, fetchWithRetry } from './fetch.ts';
import { accessToken } from './oauth.ts';
import { SourceError, type Connection, type DocRef, type SourceAdapter } from './types.ts';

const DRIVE = 'https://www.googleapis.com/drive/v3';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const MIME_SHEET = 'application/vnd.google-apps.spreadsheet';
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MIME_XLS = 'application/vnd.ms-excel';

async function authed(conn: Connection, url: string, what: string): Promise<Response> {
  const token = await accessToken(conn.project_id, conn.credential_id, 'google');
  const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) classifyHttp(res, what);
  return res;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  version?: string;
  modifiedTime?: string;
  md5Checksum?: string;
  parents?: string[];
  trashed?: boolean;
}

const FIELDS = 'id,name,mimeType,version,modifiedTime,md5Checksum,parents,trashed';

function toDoc(f: DriveFile): DocRef {
  const fileType = f.mimeType === MIME_SHEET ? 'google-sheet' : f.mimeType === MIME_XLS ? 'xls' : f.mimeType === 'text/csv' ? 'csv' : 'xlsx';
  return {
    fileId: f.id,
    displayName: f.name,
    fileType,
    revision: `${f.version ?? ''}:${f.md5Checksum ?? f.modifiedTime ?? ''}`,
    modifiedAt: f.modifiedTime ?? null,
    parentRef: f.parents?.[0] ?? null,
  };
}

async function getFile(conn: Connection, fileId: string): Promise<DriveFile> {
  const res = await authed(conn, `${DRIVE}/files/${encodeURIComponent(fileId)}?fields=${FIELDS}&supportsAllDrives=true`, 'Drive file');
  const f = (await res.json()) as DriveFile;
  if (f.trashed) throw new SourceError('NOT_FOUND', `"${f.name}" is in the trash`);
  return f;
}

/** Google Sheets (native) and Excel files stored in Google Drive, plus folder discovery. */
export const googleAdapter: SourceAdapter = {
  async list(conn) {
    if (conn.provider !== 'google-drive-folder') {
      const f = await getFile(conn, conn.external_id);
      if (![MIME_SHEET, MIME_XLSX, MIME_XLS, 'text/csv'].includes(f.mimeType)) {
        throw new SourceError('UNSUPPORTED_TYPE', `"${f.name}" (${f.mimeType}) is not a supported workbook`);
      }
      return [toDoc(f)];
    }
    const q = `'${conn.external_id.replace(/'/g, "\\'")}' in parents and trashed = false and (mimeType = '${MIME_SHEET}' or mimeType = '${MIME_XLSX}' or mimeType = '${MIME_XLS}')`;
    const docs: DocRef[] = [];
    let pageToken = '';
    do {
      const url = `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(${FIELDS})&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const j = await (await authed(conn, url, 'Drive folder')).json();
      docs.push(...(j.files as DriveFile[]).map(toDoc));
      pageToken = j.nextPageToken ?? '';
    } while (pageToken);
    return docs;
  },

  async revision(conn, doc) {
    return toDoc(await getFile(conn, doc.fileId)).revision;
  },

  async read(conn, doc) {
    if (doc.fileType !== 'google-sheet') {
      const res = await authed(conn, `${DRIVE}/files/${encodeURIComponent(doc.fileId)}?alt=media&supportsAllDrives=true`, 'Drive download');
      try {
        return parseWorkbook(XLSX as unknown as SheetJsLike, new Uint8Array(await res.arrayBuffer()));
      } catch (e) {
        throw new SourceError('PARSE_FAILED', `Could not parse "${doc.displayName}": ${(e as Error).message}`);
      }
    }
    const meta = await (await authed(conn, `${SHEETS}/${encodeURIComponent(doc.fileId)}?fields=sheets.properties(sheetId,title,hidden,sheetType)`, 'Sheets metadata')).json();
    const props = (meta.sheets as { properties: { sheetId: number; title: string; hidden?: boolean; sheetType?: string } }[])
      .map((s) => s.properties)
      .filter((p) => (p.sheetType ?? 'GRID') === 'GRID');
    if (props.length === 0) return [];
    const ranges = props.map((p) => `ranges=${encodeURIComponent(`'${p.title.replace(/'/g, "''")}'`)}`).join('&');
    const vals = await (
      await authed(conn, `${SHEETS}/${encodeURIComponent(doc.fileId)}/values:batchGet?${ranges}&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&majorDimension=ROWS`, 'Sheets values')
    ).json();
    return props.map((p, i): RawSheet => ({
      sheetId: String(p.sheetId),
      title: p.title,
      hidden: !!p.hidden,
      rows: ((vals.valueRanges?.[i]?.values ?? []) as Cell[][]),
    }));
  },
};
