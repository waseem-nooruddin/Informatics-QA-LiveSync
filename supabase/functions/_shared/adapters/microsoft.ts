import * as XLSX from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
import { parseWorkbook, type SheetJsLike } from '../core/index.ts';
import { classifyHttp, fetchWithRetry } from './fetch.ts';
import { accessToken } from './oauth.ts';
import { SourceError, type Connection, type DocRef, type SourceAdapter } from './types.ts';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const EXT = /\.(xlsx|xlsm|xls|csv)$/i;

interface DriveItem {
  id: string;
  name: string;
  eTag?: string;
  cTag?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: unknown;
  deleted?: unknown;
  parentReference?: { driveId?: string; id?: string };
}

/** external_id is "<driveId>!<itemId>" (resolved from a share URL at connection time). */
export function itemPath(externalId: string): string {
  const [driveId, itemId] = externalId.split('!');
  if (!driveId || !itemId) throw new SourceError('NOT_FOUND', 'Malformed OneDrive item reference');
  return `${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
}

async function authed(conn: Connection, url: string, what: string): Promise<Response> {
  const token = await accessToken(conn.project_id, conn.credential_id, 'microsoft');
  const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) classifyHttp(res, what);
  return res;
}

function toDoc(it: DriveItem): DocRef {
  const ext = (EXT.exec(it.name)?.[1] ?? 'xlsx').toLowerCase();
  return {
    fileId: `${it.parentReference?.driveId ?? ''}!${it.id}`,
    displayName: it.name,
    fileType: ext === 'csv' ? 'csv' : ext === 'xls' ? 'xls' : 'xlsx',
    // cTag changes only on content changes; eTag also on metadata.
    revision: it.cTag ?? it.eTag ?? it.lastModifiedDateTime ?? '',
    modifiedAt: it.lastModifiedDateTime ?? null,
    parentRef: it.parentReference?.id ?? null,
  };
}

/** OneDrive / SharePoint Excel workbooks via Microsoft Graph (FR-SRC-002). */
export const microsoftAdapter: SourceAdapter = {
  async list(conn) {
    const sel = '$select=id,name,eTag,cTag,lastModifiedDateTime,file,folder,deleted,parentReference';
    if (conn.provider === 'onedrive') {
      const it = (await (await authed(conn, `${itemPath(conn.external_id)}?${sel}`, 'OneDrive item')).json()) as DriveItem;
      if (it.deleted) throw new SourceError('NOT_FOUND', `"${it.name}" was deleted`);
      if (!it.file || !EXT.test(it.name)) throw new SourceError('UNSUPPORTED_TYPE', `"${it.name}" is not a supported workbook`);
      return [toDoc(it)];
    }
    const docs: DocRef[] = [];
    let url: string | null = `${itemPath(conn.external_id)}/children?${sel}&$top=200`;
    while (url) {
      const j = await (await authed(conn, url, 'OneDrive folder')).json();
      for (const it of j.value as DriveItem[]) if (it.file && EXT.test(it.name)) docs.push(toDoc(it));
      url = j['@odata.nextLink'] ?? null;
    }
    return docs;
  },

  async revision(conn, doc) {
    const it = (await (await authed(conn, `${itemPath(doc.fileId)}?$select=id,name,cTag,eTag,lastModifiedDateTime,parentReference`, 'OneDrive item')).json()) as DriveItem;
    return toDoc(it).revision;
  },

  async read(conn, doc) {
    const res = await authed(conn, `${itemPath(doc.fileId)}/content`, 'OneDrive download');
    try {
      return parseWorkbook(XLSX as unknown as SheetJsLike, new Uint8Array(await res.arrayBuffer()));
    } catch (e) {
      throw new SourceError('PARSE_FAILED', `Could not parse "${doc.displayName}": ${(e as Error).message}`);
    }
  },
};
