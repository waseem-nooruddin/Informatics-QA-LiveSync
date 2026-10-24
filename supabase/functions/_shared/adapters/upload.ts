import * as XLSX from 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';
import { parseWorkbook, type SheetJsLike } from '../core/index.ts';
import { db } from '../db.ts';
import { SourceError, type Connection, type DocRef, type SourceAdapter } from './types.ts';

/** XLSX/CSV uploaded to the private `sources` bucket. Revision = content SHA-256 set at upload. */
export const uploadAdapter: SourceAdapter = {
  async list(conn) {
    const { data } = await db()
      .from('source_documents')
      .select('file_id,display_name,file_type,revision,modified_at')
      .eq('project_id', conn.project_id)
      .eq('connection_id', conn.id);
    if (!data?.length) throw new SourceError('NOT_FOUND', 'Uploaded file record missing');
    return data.map((d) => ({
      fileId: d.file_id,
      displayName: d.display_name,
      fileType: (d.file_type ?? 'xlsx') as DocRef['fileType'],
      revision: d.revision ?? '',
      modifiedAt: d.modified_at,
      parentRef: null,
    }));
  },
  async revision(conn, doc) {
    const [d] = await this.list(conn);
    return d?.revision ?? doc.revision;
  },
  async read(conn: Connection) {
    if (!conn.storage_path) throw new SourceError('NOT_FOUND', 'No stored file for upload source');
    const { data, error } = await db().storage.from('sources').download(conn.storage_path);
    if (error || !data) throw new SourceError('NOT_FOUND', 'Uploaded file not found in storage');
    try {
      return parseWorkbook(XLSX as unknown as SheetJsLike, new Uint8Array(await data.arrayBuffer()));
    } catch (e) {
      throw new SourceError('PARSE_FAILED', `Could not parse workbook: ${(e as Error).message}`);
    }
  },
};
