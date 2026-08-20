/**
 * RaghuVault — Configuration
 * ---------------------------------------------------------------------------
 * Set GOOGLE_CLIENT_ID to an OAuth 2.0 Client ID (type: "Web application")
 * created in Google Cloud Console. Full setup steps are in README.md.
 *
 * This file holds no secrets. An OAuth Client ID for a browser app is public
 * by design — the security boundary is the "Authorized JavaScript origins"
 * list configured for that Client ID in Google Cloud Console, not secrecy of
 * this value. Never put a Client Secret in a static site; this app never
 * needs one because it uses the GIS token model (implicit-style access
 * tokens), not the server-side authorization-code flow.
 */

export const CONFIG = Object.freeze({
  // OAuth 2.0 Web Client ID from Google Cloud Console → APIs & Services →
  // Credentials → Create Credentials → OAuth client ID → Web application.
  GOOGLE_CLIENT_ID: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',

  // Narrowest Drive scope available: RaghuVault can only ever see or manage
  // files/folders that it itself created (or that the user explicitly opened
  // with it via the Drive file picker). It can never browse, read, or touch
  // the rest of the user's Drive.
  DRIVE_SCOPE: 'https://www.googleapis.com/auth/drive.file',

  // Dedicated folder RaghuVault creates at the root of the user's Drive on
  // first connect, and uses as its sole storage location thereafter.
  VAULT_FOLDER_NAME: 'RaghuVault',

  // Google Drive REST API v3 endpoints — called directly with fetch/XHR.
  // No gapi client library, no server, no proxy.
  DRIVE_API_BASE: 'https://www.googleapis.com/drive/v3',
  DRIVE_UPLOAD_BASE: 'https://www.googleapis.com/upload/drive/v3',

  FOLDER_MIME_TYPE: 'application/vnd.google-apps.folder',

  // Refresh the access token this many ms before its real expiry so a
  // request never begins with a token that dies mid-flight.
  TOKEN_EXPIRY_BUFFER_MS: 60_000,

  // Metadata fields requested from Drive for each file record.
  FILE_FIELDS: 'id,name,mimeType,size,modifiedTime,createdTime,iconLink,webContentLink',

  // Toast notification behavior.
  MAX_TOAST_COUNT: 4,
  TOAST_DURATION_MS: 4500,
});
