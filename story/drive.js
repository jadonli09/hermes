// Uploads story images to a Google Drive folder for phone-based review.
import fs from 'fs';
import { Readable } from 'stream';
import { google } from 'googleapis';

// Sheets access alone is not enough to write files; drive.file grants access to
// files this service account creates, which is all we need.
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file'
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

  const created = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media,
    fields: 'id, name, webViewLink'
  });
  return { ...created.data, replaced: false };
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
