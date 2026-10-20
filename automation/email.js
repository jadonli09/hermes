import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// This bounded automation is authorized only for this sender and destination.
const ADDRESS = 'ai.jadonli09@gmail.com';
export function validateEmailConfig(recipient, fromAddress) {
  if (recipient !== ADDRESS || fromAddress !== ADDRESS) throw new Error('Confirmed email recipient and sender required before starting paid work');
}

export const MAIL_SCRIPT = `on run argv
 set senderAddress to item 1 of argv
 set recipientAddress to item 2 of argv
 tell application "Mail"
  set matchingAccounts to {}
  repeat with candidate in accounts
   if enabled of candidate and (email addresses of candidate contains senderAddress) then
    if enabled of delivery account of candidate then set end of matchingAccounts to candidate
   end if
  end repeat
  if (count matchingAccounts) is not 1 then error "Exactly one enabled matching Mail sender is required"
  set outgoing to make new outgoing message with properties {visible:false, sender:senderAddress, subject:(item 3 of argv), content:(item 4 of argv)}
  tell outgoing
   make new to recipient at end of to recipients with properties {address:recipientAddress}
   repeat with n from 5 to count argv
    set attachmentFile to POSIX file (item n of argv)
    make new attachment with properties {file name:attachmentFile} at after last paragraph of content
   end repeat
   if (count attachments of content) is not ((count argv) - 4) then error "Attachment count mismatch"
  end tell
  if sender of outgoing is not senderAddress then error "Mail sender mismatch"
  if not (send outgoing) then error "Mail submission was not confirmed"
 end tell
end run`;

export async function sendEmail(files, recipient, { fromAddress, targetDate, spawnProcess = spawn } = {}) {
  validateEmailConfig(recipient, fromAddress);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate || '') || !Array.isArray(files) || !files.length) throw new Error('Email requires dated PNG attachments');
  for (const [i, file] of files.entries()) {
    if (!path.isAbsolute(file) || path.basename(file) !== `story-${targetDate}-p${i + 1}.png` || !fs.statSync(file).isFile()) throw new Error('Invalid email attachment');
  }
  const subject = `Hermes — ${targetDate}`;
  const body = `Hermes events for ${targetDate}. All ${files.length} image page(s) are attached.\n\n`;
  await new Promise((resolve, reject) => {
    const child = spawnProcess('/usr/bin/osascript', ['-e', MAIL_SCRIPT, fromAddress, recipient, subject, body, ...files], { stdio: 'ignore' });
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, 60000);
    const killer = setTimeout(() => child.kill('SIGKILL'), 70000);
    child.once('error', error => { clearTimeout(timer); clearTimeout(killer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(killer);
      code === 0 && !expired ? resolve() : reject(new Error('Mail submission failed or is uncertain; do not automatically resend'));
    });
  });
}
