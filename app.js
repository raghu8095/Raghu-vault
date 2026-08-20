/**
 * RaghuVault — Application controller
 * ---------------------------------------------------------------------------
 * Owns UI state, DOM rendering, and the Google Identity Services (GIS) token
 * lifecycle. Delegates every actual Drive network call to drive.js. No
 * framework, no build step — plain ES modules loaded directly by the browser.
 */

import { CONFIG } from './config.js';
import { DriveAPI, DriveApiError } from './drive.js';

/* ============================== State ================================== */

const state = {
  accessToken: null,
  tokenExpiresAt: 0,
  vaultFolderId: null,
  files: [],
  uploads: [],
  searchQuery: '',
  isLoadingFiles: false,
};

let tokenClient = null;
let tokenWaiters = [];
let pendingDeleteFileId = null;
let uploadIdCounter = 0;

const dom = {};

/* ============================ DOM caching ================================ */

function cacheDom() {
  dom.signedOutView = document.getElementById('signed-out-view');
  dom.signedInView = document.getElementById('signed-in-view');
  dom.connectBtn = document.getElementById('connect-btn');
  dom.connectError = document.getElementById('connect-error');
  dom.signOutBtn = document.getElementById('sign-out-btn');
  dom.refreshBtn = document.getElementById('refresh-btn');
  dom.headerDial = document.getElementById('header-dial');

  dom.dropZone = document.getElementById('drop-zone');
  dom.fileInput = document.getElementById('file-input');
  dom.browseBtn = document.getElementById('browse-btn');

  dom.searchInput = document.getElementById('search-input');
  dom.fileCount = document.getElementById('file-count');
  dom.fileList = document.getElementById('file-list');
  dom.emptyState = document.getElementById('empty-state');
  dom.uploadsList = document.getElementById('uploads-list');

  dom.toastContainer = document.getElementById('toast-container');

  dom.confirmModal = document.getElementById('confirm-modal');
  dom.confirmModalText = document.getElementById('confirm-modal-text');
  dom.confirmDeleteBtn = document.getElementById('confirm-delete-btn');
  dom.cancelDeleteBtn = document.getElementById('cancel-delete-btn');
}

/* ======================= Google Identity Services ======================== */

function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) {
      resolve();
      return;
    }
    const intervalId = setInterval(() => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        clearInterval(intervalId);
        clearTimeout(timeoutId);
        resolve();
      }
    }, 50);
    const timeoutId = setTimeout(() => {
      clearInterval(intervalId);
      reject(new Error('Google Identity Services did not load. Check your connection or ad blocker.'));
    }, 10000);
  });
}

function initTokenClient() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: CONFIG.DRIVE_SCOPE,
    callback: handleTokenResponse,
    error_callback: handleTokenError,
  });
}

function handleTokenResponse(response) {
  if (!response || response.error) {
    rejectTokenWaiters(
      new Error((response && response.error_description) || (response && response.error) || 'Authorization failed.')
    );
    return;
  }
  state.accessToken = response.access_token;
  state.tokenExpiresAt = Date.now() + Number(response.expires_in || 3600) * 1000;
  resolveTokenWaiters(state.accessToken);
}

function handleTokenError(err) {
  rejectTokenWaiters(new Error((err && err.message) || 'Sign-in was cancelled or blocked by the browser.'));
}

function resolveTokenWaiters(token) {
  const waiters = tokenWaiters.splice(0);
  waiters.forEach((waiter) => waiter.resolve(token));
}

function rejectTokenWaiters(err) {
  const waiters = tokenWaiters.splice(0);
  waiters.forEach((waiter) => waiter.reject(err));
}

function requestToken(promptMode) {
  return new Promise((resolve, reject) => {
    tokenWaiters.push({ resolve, reject });
    try {
      tokenClient.requestAccessToken({ prompt: promptMode });
    } catch (err) {
      tokenWaiters.pop();
      reject(err);
    }
  });
}

/** Returns a token guaranteed valid for the next request, refreshing if needed. */
async function ensureValidToken() {
  const stillFresh = state.accessToken && Date.now() < state.tokenExpiresAt - CONFIG.TOKEN_EXPIRY_BUFFER_MS;
  if (stillFresh) return state.accessToken;
  // Silent refresh once a session exists; otherwise this is the first grant.
  return requestToken(state.accessToken ? '' : 'consent');
}

/* ============================== Auth flow ================================ */

async function connectToDrive() {
  setConnectButtonLoading(true);
  dom.connectError.hidden = true;
  try {
    await requestToken('consent');
    await afterSignIn();
  } catch (err) {
    showToast('error', 'Could not connect to Google Drive', friendlyError(err));
  } finally {
    setConnectButtonLoading(false);
  }
}

function setConnectButtonLoading(isLoading) {
  dom.connectBtn.disabled = isLoading;
  dom.connectBtn.classList.toggle('is-loading', isLoading);
  dom.connectBtn.querySelector('.btn-label').textContent = isLoading ? 'Connecting…' : 'Connect Google Drive';
}

async function afterSignIn() {
  showSignedInShell();
  try {
    const folder = await DriveAPI.ensureVaultFolder(state.accessToken);
    state.vaultFolderId = folder.id;
    await refreshFiles();
    showToast('success', 'Vault connected', 'RaghuVault is now synced with your Google Drive.');
  } catch (err) {
    showToast('error', 'Vault setup failed', friendlyError(err));
  }
}

function signOut() {
  const token = state.accessToken;
  if (token && window.google && window.google.accounts) {
    google.accounts.oauth2.revoke(token, () => {});
  }
  state.accessToken = null;
  state.tokenExpiresAt = 0;
  state.vaultFolderId = null;
  state.files = [];
  state.uploads = [];
  state.searchQuery = '';
  dom.searchInput.value = '';
  dom.uploadsList.innerHTML = '';
  showSignedOutShell();
  showToast('info', 'Signed out', 'Your session and access token have been revoked.');
}

/* ============================ View toggling =============================== */

function showSignedInShell() {
  dom.signedOutView.hidden = true;
  dom.signedInView.hidden = false;
}

function showSignedOutShell() {
  dom.signedInView.hidden = true;
  dom.signedOutView.hidden = false;
}

/* ================================ Files ==================================== */

async function refreshFiles() {
  state.isLoadingFiles = true;
  dom.headerDial.classList.add('is-spinning');
  renderFileList();
  try {
    const token = await ensureValidToken();
    state.files = await DriveAPI.listFiles(token, state.vaultFolderId);
  } catch (err) {
    showToast('error', 'Could not load your files', friendlyError(err));
  } finally {
    state.isLoadingFiles = false;
    dom.headerDial.classList.remove('is-spinning');
    renderFileList();
  }
}

function getFilteredFiles() {
  const query = state.searchQuery.trim().toLowerCase();
  if (!query) return state.files;
  return state.files.filter((file) => file.name.toLowerCase().includes(query));
}

/* ============================ Rendering: list ============================== */

function renderFileList() {
  const filtered = getFilteredFiles();
  dom.fileCount.textContent = `${filtered.length} file${filtered.length === 1 ? '' : 's'}`;
  dom.fileList.innerHTML = '';

  if (state.isLoadingFiles && state.files.length === 0) {
    dom.emptyState.hidden = true;
    dom.fileList.appendChild(buildSkeletonRows());
    return;
  }

  if (filtered.length === 0) {
    dom.emptyState.hidden = false;
    dom.emptyState.querySelector('.empty-state-text').textContent = state.searchQuery
      ? `No files match "${state.searchQuery}".`
      : 'The vault is empty. Drop a file above to store it.';
    return;
  }

  dom.emptyState.hidden = true;
  const fragment = document.createDocumentFragment();
  filtered.forEach((file) => fragment.appendChild(buildFileRow(file)));
  dom.fileList.appendChild(fragment);
}

function buildSkeletonRows() {
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 4; i++) {
    const row = document.createElement('div');
    row.className = 'file-row file-row--skeleton';
    row.innerHTML =
      '<div class="skeleton-block badge-skeleton"></div>' +
      '<div class="skeleton-block name-skeleton"></div>' +
      '<div class="skeleton-block meta-skeleton"></div>';
    fragment.appendChild(row);
  }
  return fragment;
}

function buildFileRow(file) {
  const badge = getFileBadge(file);
  const row = document.createElement('div');
  row.className = 'file-row';
  row.dataset.fileId = file.id;

  row.innerHTML = `
    <div class="file-badge badge--${badge.accent}" aria-hidden="true">${badge.code}</div>
    <div class="file-main">
      <p class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</p>
      <p class="file-meta">
        <span class="mono">${formatBytes(file.size)}</span>
        <span class="dot-sep" aria-hidden="true">·</span>
        <span class="mono">${formatDate(file.modifiedTime)}</span>
      </p>
    </div>
    <div class="file-actions">
      <button type="button" class="icon-btn" data-action="download" aria-label="Download ${escapeHtml(file.name)}" title="Download">
        <svg class="icon"><use href="#icon-download"></use></svg>
      </button>
      <button type="button" class="icon-btn icon-btn--danger" data-action="delete" aria-label="Delete ${escapeHtml(file.name)}" title="Delete">
        <svg class="icon"><use href="#icon-trash"></use></svg>
      </button>
    </div>
  `;

  row.querySelector('[data-action="download"]').addEventListener('click', () => downloadFile(file));
  row.querySelector('[data-action="delete"]').addEventListener('click', () => openDeleteConfirm(file));
  return row;
}

/** Classifies a Drive file into a 3-letter ledger code + accent color. */
function getFileBadge(file) {
  const mime = file.mimeType || '';
  if (mime.startsWith('image/')) return { code: 'IMG', accent: 'image' };
  if (mime.startsWith('video/')) return { code: 'VID', accent: 'video' };
  if (mime.startsWith('audio/')) return { code: 'AUD', accent: 'video' };
  if (mime === 'application/pdf') return { code: 'PDF', accent: 'pdf' };
  if (/zip|compressed|rar|7z|x-tar|gzip/.test(mime)) return { code: 'ZIP', accent: 'archive' };
  if (/word|document|sheet|presentation|^text\//.test(mime)) return { code: 'DOC', accent: 'doc' };
  const ext = (file.name.split('.').pop() || '').toUpperCase().slice(0, 3);
  return { code: ext || 'BIN', accent: 'generic' };
}

/* ============================== Uploading =================================== */

function wireDropZone() {
  ['dragenter', 'dragover'].forEach((evtName) => {
    dom.dropZone.addEventListener(evtName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      dom.dropZone.classList.add('is-dragover');
    });
  });

  ['dragleave', 'drop'].forEach((evtName) => {
    dom.dropZone.addEventListener(evtName, (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (evtName === 'dragleave' && event.target !== dom.dropZone) return;
      dom.dropZone.classList.remove('is-dragover');
    });
  });

  dom.dropZone.addEventListener('drop', (event) => {
    const dropped = event.dataTransfer && event.dataTransfer.files;
    if (dropped && dropped.length) queueUploads(dropped);
  });

  dom.dropZone.addEventListener('click', () => dom.fileInput.click());
  dom.dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      dom.fileInput.click();
    }
  });
}

function wireFileInput() {
  dom.fileInput.addEventListener('change', () => {
    if (dom.fileInput.files.length) queueUploads(dom.fileInput.files);
    dom.fileInput.value = '';
  });
  dom.browseBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    dom.fileInput.click();
  });
}

function queueUploads(fileList) {
  if (!state.vaultFolderId) {
    showToast('error', 'Vault not ready', 'Please wait for the vault to finish connecting, then try again.');
    return;
  }
  Array.from(fileList).forEach((file) => startUpload(file));
}

async function startUpload(file) {
  const uploadId = `u${++uploadIdCounter}`;
  const entry = { id: uploadId, name: file.name, progress: 0, status: 'uploading', error: null };
  state.uploads.push(entry);
  renderUploads();

  try {
    const token = await ensureValidToken();
    const created = await DriveAPI.uploadFile(token, state.vaultFolderId, file, (fraction) => {
      entry.progress = fraction;
      updateUploadProgressDom(uploadId, fraction);
    });
    state.files = [normalizeUploadedFile(created, file), ...state.files];
    state.uploads = state.uploads.filter((u) => u.id !== uploadId);
    renderUploads();
    renderFileList();
    showToast('success', 'File stored', `${file.name} was added to the vault.`);
  } catch (err) {
    entry.status = 'error';
    entry.error = friendlyError(err);
    renderUploads();
    showToast('error', `Upload failed: ${file.name}`, entry.error);
  }
}

function normalizeUploadedFile(created, originalFile) {
  const nowIso = new Date().toISOString();
  return {
    id: created.id,
    name: created.name || originalFile.name,
    mimeType: created.mimeType || originalFile.type || 'application/octet-stream',
    size: created.size != null ? String(created.size) : String(originalFile.size || 0),
    modifiedTime: created.modifiedTime || nowIso,
    createdTime: created.createdTime || nowIso,
  };
}

function renderUploads() {
  dom.uploadsList.innerHTML = '';
  dom.uploadsList.hidden = state.uploads.length === 0;
  state.uploads.forEach((upload) => dom.uploadsList.appendChild(buildUploadRow(upload)));
}

function buildUploadRow(upload) {
  const row = document.createElement('div');
  row.className = `upload-row${upload.status === 'error' ? ' upload-row--error' : ''}`;
  row.dataset.uploadId = upload.id;
  const percent = Math.round(upload.progress * 100);

  row.innerHTML = `
    <div class="upload-row-top">
      <span class="upload-name" title="${escapeHtml(upload.name)}">${escapeHtml(upload.name)}</span>
      <span class="upload-percent mono">${upload.status === 'error' ? 'Failed' : percent + '%'}</span>
    </div>
    <div class="progress-track">
      <div class="progress-fill" style="width:${percent}%"></div>
    </div>
    ${
      upload.status === 'error'
        ? `<p class="upload-error">${escapeHtml(upload.error)} <button type="button" class="link-btn" data-action="dismiss">Dismiss</button></p>`
        : ''
    }
  `;

  if (upload.status === 'error') {
    row.querySelector('[data-action="dismiss"]').addEventListener('click', () => {
      state.uploads = state.uploads.filter((u) => u.id !== upload.id);
      renderUploads();
    });
  }
  return row;
}

function updateUploadProgressDom(uploadId, fraction) {
  const row = dom.uploadsList.querySelector(`[data-upload-id="${uploadId}"]`);
  if (!row) return;
  const percent = Math.round(fraction * 100);
  const fill = row.querySelector('.progress-fill');
  const label = row.querySelector('.upload-percent');
  if (fill) fill.style.width = `${percent}%`;
  if (label) label.textContent = `${percent}%`;
}

/* ========================== Download / Delete ============================== */

async function downloadFile(file) {
  try {
    const token = await ensureValidToken();
    await DriveAPI.downloadFile(token, file.id, file.name);
  } catch (err) {
    showToast('error', `Download failed: ${file.name}`, friendlyError(err));
  }
}

function openDeleteConfirm(file) {
  pendingDeleteFileId = file.id;
  dom.confirmModalText.textContent = `Delete "${file.name}" from RaghuVault? This can't be undone.`;
  dom.confirmModal.hidden = false;
  dom.confirmDeleteBtn.focus();
}

function closeDeleteConfirm() {
  pendingDeleteFileId = null;
  dom.confirmModal.hidden = true;
}

async function confirmDelete() {
  const fileId = pendingDeleteFileId;
  if (!fileId) return;
  const file = state.files.find((f) => f.id === fileId);
  closeDeleteConfirm();
  try {
    const token = await ensureValidToken();
    await DriveAPI.deleteFile(token, fileId);
    state.files = state.files.filter((f) => f.id !== fileId);
    renderFileList();
    showToast('success', 'File deleted', file ? `${file.name} was removed from the vault.` : 'File removed from the vault.');
  } catch (err) {
    showToast('error', 'Delete failed', friendlyError(err));
  }
}

/* ================================= Toasts =================================== */

function showToast(type, title, message) {
  const iconId = type === 'error' ? 'icon-alert' : type === 'success' ? 'icon-check' : 'icon-info';
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.innerHTML = `
    <svg class="icon toast-icon"><use href="#${iconId}"></use></svg>
    <div class="toast-body">
      <p class="toast-title">${escapeHtml(title)}</p>
      ${message ? `<p class="toast-message">${escapeHtml(message)}</p>` : ''}
    </div>
    <button type="button" class="toast-close" aria-label="Dismiss notification">
      <svg class="icon"><use href="#icon-close"></use></svg>
    </button>
  `;
  toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(toast));
  dom.toastContainer.appendChild(toast);

  while (dom.toastContainer.children.length > CONFIG.MAX_TOAST_COUNT) {
    dom.toastContainer.removeChild(dom.toastContainer.firstChild);
  }

  requestAnimationFrame(() => toast.classList.add('is-visible'));
  setTimeout(() => dismissToast(toast), CONFIG.TOAST_DURATION_MS);
}

function dismissToast(toast) {
  if (!toast.isConnected) return;
  toast.classList.remove('is-visible');
  setTimeout(() => toast.remove(), 250);
}

/* ================================ Formatting ================================= */

function formatBytes(bytes) {
  const numeric = Number(bytes);
  if (!numeric || Number.isNaN(numeric)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = numeric;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const rounded = unitIndex === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

function formatDate(isoString) {
  if (!isoString) return '—';
  const date = new Date(isoString);
  const datePart = date.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  const timePart = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${datePart}, ${timePart}`;
}

function friendlyError(err) {
  if (err instanceof DriveApiError) {
    if (err.status === 401 || err.status === 403) {
      return 'Your session expired or access was denied. Try signing in again.';
    }
    if (err.status === 0) {
      return 'Network error. Check your connection and try again.';
    }
    return err.message;
  }
  return (err && err.message) || 'Something went wrong.';
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

/* ================================== Wiring ==================================== */

function wireSearch() {
  dom.searchInput.addEventListener('input', () => {
    state.searchQuery = dom.searchInput.value;
    renderFileList();
  });
}

function wireModal() {
  dom.cancelDeleteBtn.addEventListener('click', closeDeleteConfirm);
  dom.confirmDeleteBtn.addEventListener('click', confirmDelete);
  dom.confirmModal.addEventListener('click', (event) => {
    if (event.target === dom.confirmModal) closeDeleteConfirm();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dom.confirmModal.hidden) closeDeleteConfirm();
  });
}

function wireHeader() {
  dom.signOutBtn.addEventListener('click', signOut);
  dom.refreshBtn.addEventListener('click', refreshFiles);
}

/* =================================== Boot ====================================== */

async function boot() {
  cacheDom();
  wireDropZone();
  wireFileInput();
  wireSearch();
  wireModal();
  wireHeader();
  dom.connectBtn.addEventListener('click', connectToDrive);

  const clientIdMissing = !CONFIG.GOOGLE_CLIENT_ID || CONFIG.GOOGLE_CLIENT_ID.includes('YOUR_GOOGLE_CLIENT_ID');
  if (clientIdMissing) {
    dom.connectError.hidden = false;
    dom.connectError.textContent = 'Add your OAuth Client ID to js/config.js before connecting. See README.md.';
    dom.connectBtn.disabled = true;
    return;
  }

  try {
    await loadGis();
    initTokenClient();
  } catch (err) {
    dom.connectError.hidden = false;
    dom.connectError.textContent = friendlyError(err);
    dom.connectBtn.disabled = true;
  }
}

document.addEventListener('DOMContentLoaded', boot);
