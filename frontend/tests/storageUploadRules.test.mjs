import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_UPLOAD_RULES, storageFileType, storageFileAccept } from '../src/storageUploadRules.ts';

for (const [bucket,rule] of Object.entries(STORAGE_UPLOAD_RULES)) {
  test(`${bucket} accepts supported files at the exact limit and rejects oversized, empty or unsafe files`,()=>{
    const boundary=rule.megabytes*1024*1024;
    for (const [extension,type] of Object.entries(rule.types)) {
      assert.equal(storageFileType(bucket,{name:`file.${extension.toUpperCase()}`,type,size:boundary}),type);
      assert.equal(storageFileType(bucket,{name:`file.${extension}`,type:'',size:10}),type);
      assert.ok(storageFileAccept(bucket).includes(`.${extension}`));
    }
    for(const size of [0,-1,NaN,Infinity,boundary+1])
      assert.throws(()=>storageFileType(bucket,{name:'photo.png',type:'image/png',size}),/MB/);
    for(const [name,type] of [['script.html','text/html'],['vector.svg','image/svg+xml'],['program.exe','application/octet-stream'],['picture.png','text/html'],['document.docm','application/vnd.ms-word.document.macroEnabled.12'],['file.constructor','']])
      assert.throws(()=>storageFileType(bucket,{name,type,size:100}),/use/);
  });
}
test('business-file permissions differ from avatar formats and preserve the existing chat size limit',()=>{
  assert.throws(()=>storageFileType('profile-avatars',{name:'quote.pdf',type:'application/pdf',size:100}),/images/);
  assert.throws(()=>storageFileType('sales-desk-attachments',{name:'slides.pptx',type:'',size:100}),/Excel/);
  assert.equal(storageFileType('chat-attachments',{name:'slides.pptx',type:'',size:25*1024*1024}),STORAGE_UPLOAD_RULES['chat-attachments'].types.pptx);
  assert.equal(storageFileType('chat-attachments',{name:'data.csv',type:'',size:100}),'text/csv');
});
