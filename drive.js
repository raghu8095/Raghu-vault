/**
 * RaghuVault — Google Drive service layer
 * ---------------------------------------------------------------------------
 * A thin, stateless wrapper around the Drive API v3 REST endpoints. This
 * module knows nothing about authentication lifecycle or UI — it takes a
 * valid access token as an argument on every call and returns plain data or
 * throws a DriveApiError. All auth/session concerns live in app.js.
 */

import { CONFIG } from './config.js';

/** Error thrown for any non-2xx response from the Drive API. */
export class DriveApiError extends Error {
  constructor(status, rawBody) {
    let message = `Drive API request failed (HTTP ${status})`;
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed && parsed.error && parsed.error.message) {
        message = parsed.error.message;
      }
    } catch (_) {
      // rawBody wasn't JSON — keep the default message.
    }
    super(message);
    this.name = 'DriveApiError';
    this.status = status;
    this.rawBody = rawBody;
  }
}

/**
 * fetch() wrapper that attaches the bearer token and turns non-OK responses
 * into a DriveApiError instead of silently returning them.
 */
async function authedFetch(url, accessToken, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch (networkErr) {
    throw new DriveApiError(0, networkErr && networkErr.message);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new DriveApiError(response.status, body);
  }
  return response;
}

/**
 * Builds the raw multipart/related request body for a Drive upload without
 * ever loading the file into memory as a string or base64 blob. Mixing text
 * parts and the raw File/Blob directly inside a Blob([...]) array lets the
 * browser stream the bytes efficiently, which matters for large binaries
 * (video, archives, etc.).
 */
function buildMultipartBody(metadata, file, boundary) {
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadataPart =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata);

  const fileHeaderPart =
    delimiter + `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`;

  return new Blob([metadataPart, fileHeaderPart, file, closeDelimiter], {
    type: `multipart/related; boundary=${boundary}`,
  });
}

export const DriveAPI = {
  /**
   * Looks for an existing top-level folder named CONFIG.VAULT_FOLDER_NAME.
   * Returns { id, name } or null if none exists yet.
   */
  async findVaultFolder(accessToken) {
    const query = [
      `name='${CONFIG.VAULT_FOLDER_NAME}'`,
      `mimeType='${CONFIG.FOLDER_MIME_TYPE}'`,
      `trashed=false`,
      `'root' in parents`,
    ].join(' and ');

    const url =
      `${CONFIG.DRIVE_API_BASE}/files` +
      `?q=${encodeURIComponent(query)}` +
      `&fields=${encodeURIComponent('files(id,name)')}` +
      `&spaces=drive`;

    const res = await authedFetch(url, accessToken);
    const data = await res.json();
    return data.files && data.files.length > 0 ? data.files[0] : null;
  },

  /** Creates the RaghuVault root folder and returns { id, name }. */
  async createVaultFolder(accessToken) {
    const url = `${CONFIG.DRIVE_API_BASE}/files?fields=${encodeURIComponent('id,name')}`;
    const res = await authedFetch(url, accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: CONFIG.VAULT_FOLDER_NAME,
        mimeType: CONFIG.FOLDER_MIME_TYPE,
        parents: ['root'],
      }),
    });
    return res.json();
  },

  /** Finds the vault folder, creating it on first run. Idempotent. */
  async ensureVaultFolder(accessToken) {
    const existing = await this.findVaultFolder(accessToken);
    if (existing) return existing;
    return this.createVaultFolder(accessToken);
  },

  /**
   * Lists every non-trashed file directly inside the vault folder, newest
   * first, transparently following pagination for large vaults.
   */
  async listFiles(accessToken, folderId) {
    const query = `'${folderId}' in parents and trashed=false`;
    const fields = `nextPageToken,files(${CONFIG.FILE_FIELDS})`;
    let files = [];
    let pageToken = '';

    do {
      const url =
        `${CONFIG.DRIVE_API_BASE}/files` +
        `?q=${encodeURIComponent(query)}` +
        `&orderBy=${encodeURIComponent('createdTime desc')}` +
        `&pageSize=1000` +
        `&fields=${encodeURIComponent(fields)}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');

      const res = await authedFetch(url, accessToken);
      const data = await res.json();
      files = files.concat(data.files || []);
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    return files;
  },

  /**
   * Uploads a File/Blob into the vault folder via multipart upload, reporting
   * fractional progress (0–1) through onProgress. Uses XMLHttpRequest because
   * fetch() cannot expose upload progress events.
   */
  uploadFile(accessToken, folderId, file, onProgress) {
    return new Promise((resolve, reject) => {
      const boundary = `raghuvault-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const metadata = { name: file.name, parents: [folderId] };
      const body = buildMultipartBody(metadata, file, boundary);

      const url =
        `${CONFIG.DRIVE_UPLOAD_BASE}/files` +
        `?uploadType=multipart` +
        `&fields=${encodeURIComponent(CONFIG.FILE_FIELDS)}`;

      const xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
      xhr.setRequestHeader('Content-Type', `multipart/related; boundary=${boundary}`);

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && typeof onProgress === 'function') {
          onProgress(event.loaded / event.total);
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (err) {
            reject(new DriveApiError(xhr.status, xhr.responseText));
          }
        } else {
          reject(new DriveApiError(xhr.status, xhr.responseText));
        }
      };

      xhr.onerror = () => reject(new DriveApiError(0, 'Network error during upload'));
      xhr.onabort = () => reject(new DriveApiError(0, 'Upload was cancelled'));

      xhr.send(body);
    });
  },

  /** Permanently deletes a file from Drive (not just the trash). */
  async deleteFile(accessToken, fileId) {
    await authedFetch(`${CONFIG.DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`, accessToken, {
      method: 'DELETE',
    });
  },

  /**
   * Downloads a file's bytes and saves it locally via a temporary blob URL —
   * no server round-trip, no redirect to Drive's own UI.
   */
  async downloadFile(accessToken, fileId, fileName) {
    const url = `${CONFIG.DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`;
    const res = await authedFetch(url, accessToken);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);

    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = fileName || 'download';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    // Give the browser a moment to pick up the object URL before revoking it.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
  },
};
