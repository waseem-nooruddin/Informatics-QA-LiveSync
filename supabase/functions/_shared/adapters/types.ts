import type { RawSheet } from '../core/index.ts';

export type ConnectionProvider =
  | 'google-sheets'
  | 'google-drive-xlsx'
  | 'google-drive-folder'
  | 'onedrive'
  | 'onedrive-folder'
  | 'upload';

export interface Connection {
  id: string;
  project_id: string;
  provider: ConnectionProvider;
  external_id: string;
  display_name: string;
  credential_id: string | null;
  storage_path: string | null;
  /** Main module this source feeds; null for a project-root folder connection. */
  main_module_id?: string | null;
}

export interface DocRef {
  fileId: string;
  displayName: string;
  fileType: 'google-sheet' | 'xlsx' | 'xls' | 'csv';
  revision: string;
  modifiedAt: string | null;
  parentRef: string | null;
}

export class SourceError extends Error {
  constructor(
    public code:
      | 'ACCESS_DENIED'
      | 'NOT_FOUND'
      | 'RATE_LIMITED'
      | 'UNSUPPORTED_TYPE'
      | 'CREDENTIAL_MISSING'
      | 'TOKEN_REFRESH_FAILED'
      | 'REVISION_CHANGED'
      | 'PARSE_FAILED'
      | 'NETWORK',
    message: string,
  ) {
    super(message);
  }
}

/** Read-only provider adapter (FR-SRC-001..007). */
export interface SourceAdapter {
  /** Enumerate documents: a file connection yields itself, a folder yields eligible children. */
  list(conn: Connection): Promise<DocRef[]>;
  /** Current revision of one document (for change-during-read detection). */
  revision(conn: Connection, doc: DocRef): Promise<string>;
  read(conn: Connection, doc: DocRef): Promise<RawSheet[]>;
}
