// Uploads story images to a Google Drive folder for phone-based review.
import fs from 'fs';
import { Readable } from 'stream';
import { google } from 'googleapis';

// The full drive scope is required, not drive.file.
//
// drive.file is per-file: it only grants access to files this app itself
// created. A folder a user shared with the service account was not created by
// us, so every call against it returns notFound - indistinguishable from the
// folder not being shared at all, which makes this failure very easy to
// misdiagnose.
//
// This is not over-privileged in practice: a service account can still only
// reach what has been explicitly shared with it, which here is the spreadsheet
// and the story folder.
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive'
];

/**
 * @param {string} credentialsPath
 * @returns {Promise<Object>} authenticated Drive client
 */
export async function authenticateDrive(credentialsPath) {
  const auth = new google.auth.GoogleAuth({ keyFile: credentialsPath, scopes: SCOPES });
  return google.drive({ version: 'v3', auth });
}

/**
 * Uploads a PNG, replacing any existing file of the same name in the folder.
 *
 * Re-running for a date should update that date's images rather than pile up
 * duplicates, so the caller can regenerate freely after fixing a bad row.
 *
 * @param {Object} drive
 * @param {string} folderId
 * @param {string} name - e.g. story-2026-02-10-p1.png
 * @param {Buffer} buffer
 * @returns {Promise<{id: string, name: string, replaced: boolean, webViewLink: string}>}
 */
export async function uploadImage(drive, folderId, name, buffer) {
  const existing = await drive.files.list({
    q: `name = '${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`,
    fields: 'files(id)',
    pageSize: 1
  });

  const media = { mimeType: 'image/png', body: Readable.from(buffer) };
  const prior = existing.data.files?.[0];

  if (prior) {
    const updated = await drive.files.update({
      fileId: prior.id,
      media,
      fields: 'id, name, webViewLink'
    });
    return { ...updated.data, replaced: true };
  }

  try {
    const created = await drive.files.create({
      requestBody: { name, parents: [folderId] },
      media,
      fields: 'id, name, webViewLink'
    });
    return { ...created.data, replaced: false };
  } catch (error) {
    // A service account owns whatever it creates, and has no storage quota -
    // even inside a folder someone else owns. Shared drives are the documented
    // way around this, but they are a Workspace feature and unavailable on a
    // personal Gmail account. The message Google returns points at fixes that
    // do not apply here, so replace it with one that does.
    if (/storage quota/i.test(error.message)) {
      throw new Error(
        'Google blocks service accounts from owning files, so uploads to a personal ' +
        'Drive account are not possible (shared drives are Workspace-only).\n' +
        '  Use --out=<dir> to write locally, ideally into a Google Drive for Desktop\n' +
        '  folder so the images still sync to your phone.'
      );
    }
    throw error;
  }
}

/**
 * Verifies the folder exists and is writable before rendering, so a
 * misconfiguration surfaces as an explicit message rather than a bare 403 after
 * the work is done.
 * @param {Object} drive
 * @param {string} folderId
 * @param {string} serviceAccountEmail
 */
export async function assertFolderWritable(drive, folderId, serviceAccountEmail) {
  try {
    const folder = await drive.files.get({ fileId: folderId, fields: 'id, name, mimeType' });

    if (folder.data.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error(`GOOGLE_DRIVE_FOLDER_ID points at "${folder.data.name}", which is not a folder`);
    }
    return folder.data;
  } catch (error) {
    if (error.code === 404 || error.code === 403) {
      throw new Error(
        `Cannot access Drive folder ${folderId}.\n` +
        `  1. Share the folder with ${serviceAccountEmail} as Editor\n` +
        `  2. Enable the Drive API: https://console.cloud.google.com/apis/library/drive.googleapis.com\n` +
        `  (original error: ${error.message})`
      );
    }
    throw error;
  }
}
