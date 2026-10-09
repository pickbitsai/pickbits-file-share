// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi, hash, validateName, MAX_FILE_SIZE } from '../server/api.mjs';

const ownerId='owner-123',friendId='friend-456',fileId='b6c8b8ca-1b78-4f0d-b7c6-a46c0da21853',folderId='c03e96e6-3c51-45c3-8b8b-a6172eb99f4e';
function harness({admin=false,disabled=false,records=[],mfaVerified=true,userId=ownerId,sharedMembers=[]}={}){
  const calls=[];const signed=[];const rows=new Map();const add=item=>rows.set(`${item.pk}|${item.sk}`,structuredClone(item));
  add({pk:`SESSION#${hash('session-test')}`,sk:'SESSION',authenticatedAt:Math.floor(Date.now()/1000),expiresAt:Math.floor(Date.now()/1000)+3600,username:'owner',user:{id:userId,email:'owner@example.com',admin},...(admin&&mfaVerified?{mfaVersion:'test-mfa'}:{})});if(admin)add({pk:`USER#${userId}`,sk:'MFA',version:'test-mfa',secret:'JBSWY3DPEHPK3PXP',lastCounter:0});records.forEach(add);
  const db={async send(command){calls.push(command);const p=command.input;switch(command.constructor.name){case 'GetCommand':return {Item:rows.get(`${p.Key.pk}|${p.Key.sk}`)};case 'QueryCommand':return {Items:[...rows.values()].filter(r=>r.pk===p.ExpressionAttributeValues[':pk']&&r.sk.startsWith(p.ExpressionAttributeValues[':prefix']))};case 'PutCommand':add(p.Item);return {};case 'DeleteCommand':rows.delete(`${p.Key.pk}|${p.Key.sk}`);return {};case 'UpdateCommand':return {};case 'TransactWriteCommand':return {};default:throw new Error(command.constructor.name);}}};
  const cognito={async send(c){calls.push(c);return {Enabled:!disabled};}};
  const s3={async send(c){calls.push(c);return {};}};
  const api=createApi({db,s3,cognito,env:{TABLE_NAME:'test',USER_POOL_ID:'us-east-2_test',CLIENT_ID:'testclient',APP_ORIGIN:'https://files.example.com',FILES_BUCKET:'test-bucket',TEAM_WORKSPACE_MEMBERS:JSON.stringify(sharedMembers)},verifier:{verify(){throw new Error('Unused');}},signUrl:async(client,c)=>{signed.push(c.input);return 'https://example.com/signed';},signPost:async(client,p)=>{signed.push(p);return {url:'https://example.com/upload',fields:{}};}});
  const request=(path,{method='GET',body,authenticated=true,origin='https://files.example.com'}={})=>api(new Request(`https://files.example.com/api${path}`,{method,headers:{...(authenticated?{Cookie:'__Host-pickbits-file-share_session=session-test'}:{}),Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}));
  return {request,calls,rows,signed};
}
const file=(owner=ownerId,extra={})=>({pk:`USER#${owner}`,sk:`FILE#${fileId}`,id:fileId,name:'private.html',kind:'file',size:20,mime:'text/html',parentId:'',status:'ready',key:`files/${owner}/${fileId}`,...extra});
test('unauthenticated users cannot list or download files',async()=>{const h=harness({records:[file()]});for(const path of ['/files',`/files/${fileId}/download`])assert.equal((await h.request(path,{authenticated:false})).status,401);assert.equal(h.signed.length,0);});
test('file listing is partitioned by authenticated owner',async()=>{const h=harness({records:[file(),file(friendId)]});const r=await h.request('/files');const data=await r.json();assert.equal(data.files.length,1);assert.equal(data.files[0].key,undefined);assert.equal(data.files[0].pk,undefined);});
test('knowing another member file ID does not authorize a download',async()=>{const h=harness({records:[file(friendId)]});assert.equal((await h.request(`/files/${fileId}/download`)).status,404);assert.equal(h.signed.length,0);});
test('disabled accounts cannot reuse an existing session',async()=>{const h=harness({disabled:true,records:[file()]});assert.equal((await h.request('/files')).status,401);});
test('cross-origin writes are rejected before any mutation',async()=>{const h=harness();assert.equal((await h.request('/folders',{method:'POST',body:{name:'No'},origin:'https://evil.example'})).status,403);assert.equal(h.calls.length,0);});
test('only the owner can invite members',async()=>{const h=harness();assert.equal((await h.request('/admin/invite',{method:'POST',body:{email:'friend@example.com'}})).status,403);assert.ok(!h.calls.some(c=>c.constructor.name==='AdminCreateUserCommand'));});
test('owner invitations validate email and send only explicit request',async()=>{const h=harness({admin:true});assert.equal((await h.request('/admin/invite',{method:'POST',body:{email:'friend@example.com'}})).status,201);assert.equal(h.calls.filter(c=>c.constructor.name==='AdminCreateUserCommand').length,1);assert.equal((await h.request('/admin/invite',{method:'POST',body:{email:'bad'}})).status,400);});
test('expired share links cannot generate download URLs',async()=>{const token='a'.repeat(43);const h=harness({records:[file(),{pk:`SHARE#${hash(token)}`,sk:'SHARE',ownerId,fileId,expiresAt:1}]});assert.equal((await h.request(`/share/${token}`)).status,404);assert.equal(h.signed.length,0);});
test('a stale share record does not reactivate a revoked link',async()=>{const token='a'.repeat(43);const h=harness({records:[file(),{pk:`SHARE#${hash(token)}`,sk:'SHARE',ownerId,fileId,expiresAt:Math.floor(Date.now()/1000)+500}]});assert.equal((await h.request(`/share/${token}`)).status,404);assert.equal(h.signed.length,0);});
test('a deleted ancestor blocks download even when child is not deleted',async()=>{const h=harness({records:[file(ownerId,{parentId:folderId}),{pk:`USER#${ownerId}`,sk:`FILE#${folderId}`,id:folderId,kind:'folder',deletedAt:'2026-01-01'}]});assert.equal((await h.request(`/files/${fileId}/download`)).status,400);assert.equal(h.signed.length,0);});
test('uploaded active content is forced to download',async()=>{const h=harness({records:[file()]});assert.equal((await h.request(`/files/${fileId}/download?preview=1`)).status,200);assert.match(h.signed[0].ResponseContentDisposition,/^attachment/);assert.equal(h.signed[0].ResponseContentType,'application/octet-stream');});
test('upload policy enforces exact length and a staging key',async()=>{const h=harness();const r=await h.request('/uploads',{method:'POST',body:{name:'image.png',size:500,mime:'image/png'}});assert.equal(r.status,201);assert.match(h.signed[0].Key,/^staging\/owner-123\//);assert.deepEqual(h.signed[0].Conditions[0],['content-length-range',500,500]);assert.equal(h.signed[0].Expires,300);const tx=h.calls.find(c=>c.constructor.name==='TransactWriteCommand');assert.equal(tx.input.TransactItems.length,2);});
test('oversized uploads and unsafe names are rejected',async()=>{const h=harness();assert.equal((await h.request('/uploads',{method:'POST',body:{name:'big',size:MAX_FILE_SIZE+1}})).status,400);for(const n of ['','../file','file\nname','a\\b'])assert.throws(()=>validateName(n));assert.equal(validateName('  holiday.jpg  '),'holiday.jpg');});
test('moving a folder beneath itself is rejected',async()=>{const h=harness({records:[file(ownerId,{kind:'folder',size:0})]});assert.equal((await h.request(`/files/${fileId}`,{method:'PATCH',body:{parentId:fileId}})).status,400);});
test('responses are not cacheable and do not sniff content',async()=>{const h=harness();const r=await h.request('/me');assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-content-type-options'),'nosniff');});
test('health exposes no account or configuration data',async()=>{const h=harness();const r=await h.request('/health',{authenticated:false});assert.deepEqual(await r.json(),{ok:true});});
test('owner password-only sessions cannot access files or invite members',async()=>{const h=harness({admin:true,mfaVerified:false,records:[file()]});assert.equal((await h.request('/files')).status,403);assert.equal((await h.request('/admin/invite',{method:'POST',body:{email:'friend@example.com'}})).status,403);const status=await (await h.request('/me')).json();assert.equal(status.mfa.required,true);assert.equal(status.mfa.verified,false);assert.ok(!h.calls.some(c=>c.constructor.name==='AdminCreateUserCommand'));});
test('owner authenticator requirements cannot be disabled',async()=>{const h=harness({admin:true});assert.equal((await h.request('/mfa/disable',{method:'POST',body:{code:'000000'}})).status,403);});
test('MFA setup secrets are never returned in account status',async()=>{const h=harness({admin:true,mfaVerified:false});const r=await h.request('/me');const d=await r.json();assert.equal(d.mfa.verified,false);assert.equal(d.mfa.ownerRequired,true);assert.equal(d.mfa.enabled,true);assert.equal(d.mfa.factor,undefined);assert.ok(!JSON.stringify(d).includes('JBSWY'));});

const sharedMembers=[{id:ownerId,email:'owner@example.com',name:'Avery'},{id:friendId,email:'friend@example.com',name:'Jordan'}];
const otherFileId='5e78225e-528a-44ca-99d5-4609257a1351';
test('both team members list and download existing partner uploads automatically',async()=>{
  for(const [viewer,partner] of [[ownerId,friendId],[friendId,ownerId]]){
    const h=harness({userId:viewer,sharedMembers,records:[file(partner),file(viewer,{id:otherFileId,sk:`FILE#${otherFileId}`}),file('outsider')]});
    const data=await (await h.request('/files')).json();assert.equal(data.files.length,2);
    assert.deepEqual(new Set(data.files.map(f=>f.uploadedByName)),new Set(['Jordan','Avery']));
    for(const f of data.files){assert.equal(f.pk,undefined);assert.equal(f.key,undefined);assert.equal(f.stagingKey,undefined);}
    assert.equal((await h.request(`/files/${fileId}/download`)).status,200);assert.equal(h.signed[0].Key,`files/${partner}/${fileId}`);
    assert.equal((await (await h.request('/me')).json()).user.workspace.shared,true);
  }
});
test('an invited outsider including an admin cannot discover or change the team workspace',async()=>{
  for(const admin of [false,true]){
    const h=harness({userId:'outsider',admin,sharedMembers,records:[file(friendId)]});
    assert.equal((await (await h.request('/files')).json()).files.length,0);
    assert.equal((await (await h.request('/me')).json()).user.workspace.shared,false);
    for(const [path,method,body] of [[`/files/${fileId}/download`,'GET'],[`/files/${fileId}`,'PATCH',{action:'trash'}],[`/files/${fileId}/share`,'POST',{days:1}]])assert.equal((await h.request(path,{method,body})).status,404);
    assert.equal(h.signed.length,0);
  }
});
test('partner changes target the original uploader partition and preserve attribution',async()=>{
  const h=harness({sharedMembers,records:[file(friendId)]});
  for(const body of [{name:'Review.txt'},{starred:true},{action:'trash'},{action:'restore'}]){
    assert.equal((await h.request(`/files/${fileId}`,{method:'PATCH',body})).status,200);
    const update=h.calls.filter(c=>c.constructor.name==='UpdateCommand').at(-1).input;
    assert.deepEqual(update.Key,{pk:`USER#${friendId}`,sk:`FILE#${fileId}`});
  }
  assert.equal((await h.request(`/files/${fileId}/share`,{method:'POST',body:{days:1}})).status,200);
  const writes=h.calls.find(c=>c.constructor.name==='TransactWriteCommand').input.TransactItems;
  assert.equal(writes[0].Put.Item.ownerId,friendId);assert.equal(writes[1].Update.Key.pk,`USER#${friendId}`);
});
test('shared links require membership in the specific team workspace',async()=>{
  const token='a'.repeat(43),expiresAt=Math.floor(Date.now()/1000)+500;
  const records=[file(friendId,{shareToken:token,shareExpires:expiresAt}),{pk:`SHARE#${hash(token)}`,sk:'SHARE',ownerId:friendId,fileId,expiresAt}];
  assert.equal((await harness({sharedMembers,records}).request(`/share/${token}`)).status,200);
  assert.equal((await harness({userId:'outsider',sharedMembers,records}).request(`/share/${token}`)).status,404);
});
test('uploads and nested folders work inside a partner folder while quotas stay with the uploader',async()=>{
  const folder={pk:`USER#${friendId}`,sk:`FILE#${folderId}`,id:folderId,kind:'folder',parentId:''};
  const h=harness({sharedMembers,records:[folder]});
  assert.equal((await h.request('/uploads',{method:'POST',body:{name:'review.txt',size:20,mime:'text/plain',parentId:folderId}})).status,201);
  const tx=h.calls.find(c=>c.constructor.name==='TransactWriteCommand').input.TransactItems;
  assert.equal(tx[0].Update.Key.pk,`USER#${ownerId}`);assert.equal(tx[1].Put.Item.parentId,folderId);
  assert.equal((await h.request('/folders',{method:'POST',body:{name:'Replies',parentId:folderId}})).status,201);
});
test('cross-account folder cycles and trashed ancestors block access',async()=>{
  const parent={pk:`USER#${friendId}`,sk:`FILE#${folderId}`,id:folderId,kind:'folder',parentId:fileId};
  const h=harness({sharedMembers,records:[file(ownerId,{kind:'folder',size:0}),parent]});
  assert.equal((await h.request(`/files/${fileId}`,{method:'PATCH',body:{parentId:folderId}})).status,400);
  const deleted=harness({sharedMembers,records:[file(ownerId,{parentId:folderId}),{...parent,parentId:'',deletedAt:'2026-09-12'}]});
  assert.equal((await deleted.request(`/files/${fileId}/download`)).status,400);
  assert.equal(deleted.signed.length,0);
});
test('shared membership does not bypass disabled accounts or owner MFA',async()=>{
  assert.equal((await harness({sharedMembers,disabled:true,records:[file(friendId)]}).request('/files')).status,401);
  assert.equal((await harness({sharedMembers,admin:true,mfaVerified:false,records:[file(friendId)]}).request('/files')).status,403);
});
test('partner pending uploads stay hidden and cannot be finalized or cleaned up by the viewer',async()=>{
  const h=harness({sharedMembers,records:[file(friendId,{status:'pending',createdAt:'2026-01-01'})]});
  assert.equal((await (await h.request('/files')).json()).files.length,0);
  assert.equal((await h.request(`/uploads/${fileId}/complete`,{method:'POST',body:{}})).status,404);
  assert.ok(!h.calls.some(c=>c.constructor.name==='TransactWriteCommand'));
});
