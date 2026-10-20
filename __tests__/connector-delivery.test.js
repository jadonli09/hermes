import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADDRESS, LINK, prepare, claim, acknowledge, verify } from '../automation/connector-delivery.js';
import { digest, writeState, readState } from '../automation/state.js';
import { slotFor } from '../automation/nightly.js';
let root, jobFile, image;
const now = new Date('2026-10-19T06:00:00Z'), id = '2026-10-18';
beforeEach(() => {
 root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-connector-'));
 jobFile = path.join(root, '.hermes/nightly', id, 'job.json');
 image = path.join(path.dirname(jobFile), 'images-1/story-2026-10-19-p1.png');
 fs.mkdirSync(path.dirname(image), {recursive:true});
 const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a','hex').copy(png); png.writeUInt32BE(1080,16);png.writeUInt32BE(1920,20);fs.writeFileSync(image,png);
 writeState(jobFile,{slot:slotFor(now),refreshed:true,status:'prepared',images:[{file:image,sha256:digest(png.toString('base64'))}]});
 writeState(path.join(root,'.hermes/nightly-config.json'),{enabled:true,deliveryMode:'connector',deliveryEnabled:false,recipient:ADDRESS,fromAddress:ADDRESS});
});
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
test('fresh matching Gmail preflight required before runner; disabled configuration refuses',async()=>{
 const runner=jest.fn();
 await expect(prepare(root,{runner})).rejects.toThrow(/preflight/);
 await expect(prepare(root,{runner,profileEmail:ADDRESS,linkId:LINK,checkedAt:'2020-01-01',now})).rejects.toThrow(/preflight/);
 writeState(path.join(root,'.hermes/nightly-config.json'),{enabled:false});
 await expect(prepare(root,{runner})).rejects.toThrow(/disabled/);expect(runner).not.toHaveBeenCalled();
});
test('prepare produces manifest without marking sent or invoking local delivery',async()=>{
 const runner=jest.fn().mockResolvedValue({status:'prepared'});
 const result=await prepare(root,{runner,profileEmail:ADDRESS,linkId:LINK,checkedAt:now.toISOString(),now,clock:()=>now});
 expect(result.status).toBe('awaiting-delivery');expect(result.manifest.targetDate).toBe('2026-10-19');
 expect(runner.mock.calls[0][0].deliver).toBe(false);
});
test('one consumer claims; ambiguous outcome cannot be claimed again',()=>{
 claim(root,id,now);expect(()=>claim(root,id,now)).toThrow(/Already claimed/);
});
test('expired window and changed images block claims',()=>{
 expect(()=>claim(root,id,new Date('2026-10-19T14:00:00Z'))).toThrow(/expired/);
 fs.appendFileSync(image,'changed');expect(()=>claim(root,id,now)).toThrow(/integrity/);
});
test('receipt is idempotent, conflicting or wrong-token receipt rejected; hashes verify',()=>{
 const {claimToken,manifest}=claim(root,id,now);
 expect(()=>acknowledge(root,id,'wrong','abc123')).toThrow(/Invalid/);
 acknowledge(root,id,claimToken,'abc123');acknowledge(root,id,claimToken,'abc123');
 expect(()=>acknowledge(root,id,claimToken,'def456')).toThrow(/Conflicting/);
 const evidence={messageId:'abc123',from:ADDRESS,to:ADDRESS,subject:manifest.subject,labels:['SENT','INBOX'],attachments:manifest.files.map(({filename,mimeType,size,sha256})=>({filename,mimeType,size,sha256}))};
 expect(()=>verify(root,id,claimToken,{...evidence,attachments:[]})).toThrow(/Attachment/);
 expect(verify(root,id,claimToken,evidence).status).toBe('verified');
 expect(readState(jobFile).status).toBe('sent');expect(()=>claim(root,id,now)).toThrow(/Already claimed/);
});

test('partial coverage claim binds warning into subject and required body',()=>{
 const job=readState(jobFile);job.coverageReport={complete:false,accounts:{bad:{status:'blocked'}}};writeState(jobFile,job);
 const result=claim(root,id,now);
 expect(result.manifest.subject).toContain('refresh incomplete');
 expect(result.manifest.requiredBodyText).toContain('newer events may be missing');
});
test('qualified receipt cannot verify unless the received email body includes the warning',()=>{
 const job=readState(jobFile);job.coverageReport={complete:false,accounts:{bad:{complete:false,status:'blocked'}}};writeState(jobFile,job);
 const {claimToken,manifest}=claim(root,id,now);acknowledge(root,id,claimToken,'abc123');
 const evidence={messageId:'abc123',from:ADDRESS,to:ADDRESS,subject:manifest.subject,labels:['SENT','INBOX'],attachments:manifest.files.map(({filename,mimeType,size,sha256})=>({filename,mimeType,size,sha256}))};
 expect(()=>verify(root,id,claimToken,evidence)).toThrow(/warning/);
 expect(verify(root,id,claimToken,{...evidence,bodyText:'Refresh incomplete; newer events may be missing.'}).status).toBe('verified');
});
