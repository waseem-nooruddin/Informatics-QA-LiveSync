// Google Drive Picker (SRS V1.5 FR-GD-001/003/005). The browser only ever receives a
// short-lived access token minted by the backend; refresh tokens never leave the server.

export interface PickerConfig {
  apiKey: string;
  appId: string;
  accessToken: string;
  expiresAt: number;
  account: string;
}

export interface PickedItem {
  id: string;
  name: string;
  mimeType: string;
}

declare global {
  interface Window {
    gapi?: { load: (lib: string, cb: () => void) => void };
    google?: any;
  }
}

let loading: Promise<void> | null = null;

function loadPickerLibrary(): Promise<void> {
  if (window.google?.picker) return Promise.resolve();
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://apis.google.com/js/api.js';
      s.async = true;
      s.onload = () => window.gapi!.load('picker', () => resolve());
      s.onerror = () => {
        loading = null;
        reject(new Error('The Google Picker could not be loaded (blocked by the browser or network).'));
      };
      document.head.appendChild(s);
    });
  }
  return loading;
}

const WORKBOOK_TYPES = [
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.google-apps.folder',
].join(',');

/**
 * Open Google's own Picker. Resolves with the selection, or null when the user closes it
 * without choosing (which must leave the application unchanged — FR-GD-007).
 */
export async function openDrivePicker(cfg: PickerConfig, mode: 'folder' | 'sources'): Promise<PickedItem[] | null> {
  await loadPickerLibrary();
  const g = window.google;
  return new Promise((resolve) => {
    const view =
      mode === 'folder'
        ? new g.picker.DocsView(g.picker.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder')
        : new g.picker.DocsView().setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes(WORKBOOK_TYPES);
    let builder = new g.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(cfg.accessToken)
      .setDeveloperKey(cfg.apiKey)
      .setTitle(mode === 'folder' ? 'Choose the project’s Google Drive folder' : 'Choose Google Sheets, Excel files or folders')
      .setCallback((data: any) => {
        if (data.action === g.picker.Action.PICKED) {
          resolve((data.docs as any[]).map((d) => ({ id: d.id, name: d.name, mimeType: d.mimeType })));
        } else if (data.action === g.picker.Action.CANCEL) {
          resolve(null);
        }
      });
    if (cfg.appId) builder = builder.setAppId(cfg.appId);
    if (mode === 'sources') builder = builder.enableFeature(g.picker.Feature.MULTISELECT_ENABLED);
    builder.build().setVisible(true);
  });
}
