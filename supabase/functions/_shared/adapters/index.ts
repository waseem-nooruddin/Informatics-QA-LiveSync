import { googleAdapter } from './google.ts';
import { microsoftAdapter } from './microsoft.ts';
import type { ConnectionProvider, SourceAdapter } from './types.ts';
import { uploadAdapter } from './upload.ts';

export function adapterFor(provider: ConnectionProvider): SourceAdapter {
  switch (provider) {
    case 'google-sheets':
    case 'google-drive-xlsx':
    case 'google-drive-folder':
      return googleAdapter;
    case 'onedrive':
    case 'onedrive-folder':
      return microsoftAdapter;
    case 'upload':
      return uploadAdapter;
  }
}

export * from './types.ts';
