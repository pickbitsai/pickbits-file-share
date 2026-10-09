// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { loadConfig } from './config.mjs';
if(!process.argv.includes('--run'))throw new Error('Opt-in only: pass --run to create and clean up temporary AWS test accounts and files.');
const settings=loadConfig();
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';

// Test only accounts and files created by this run. No email is sent.
const out=JSON.parse(execFileSync('aws',['cloudformation','describe-stacks','--stack-name',settings.stackName,'--region',settings.region,'--output','json','--no-cli-pager'],{encoding:'utf8'}));
const config=Object.fromEntries(out.Stacks[0].Outputs.map(x=>[x.OutputKey,x.OutputValue]));
const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:settings.region}));
const cognito=new CognitoIdentityProviderClient({region:settings.region});const s3=new S3Client({region:settings.region});
const origin=`https://${settings.domain}`;const run=randomBytes(6).toString('hex');const accounts=[];const shares=[];
const sha=s=>createHash('sha256').update(s).digest('hex');
async function request(path,{session,method='GET',data,requestOrigin=origin}={}){const body=data===undefined?undefined:JSON.stringify(data);const r=await fetch(`${origin}/api${path}`,{method,headers:{...(session?{Cookie:`__Host-pickbits-file-share_session=${session}`} : {}),Origin:requestOrigin,'Content-Type':'application/json','x-amz-content-sha256':sha(body||'')},body,redirect:'manual'});let json;try{json=await r.json();}catch{json={};}return {status:r.status,headers:r.headers,data:json};}
async function newTestAccount(suffix){const username=`pickbits-file-share-qa-${run}-${suffix}@example.com`;const raw=randomBytes(32).toString('base64url');const result=await cognito.send(new AdminCreateUserCommand({UserPoolId:config.UserPoolId,Username:username,MessageAction:'SUPPRESS',UserAttributes:[{Name:'email',Value:username},{Name:'email_verified',Value:'true'}]}));const id=result.User.Attributes.find(a=>a.Name==='sub').Value;const account={username:result.User.Username,id,session:raw};accounts.push(account);await db.send(new PutCommand({TableName:config.TableName,Item:{pk:`SESSION#${sha(raw)}`,sk:'SESSION',username:account.username,user:{id,email:username,name:'Integration test',admin:false},expiresAt:Math.floor(Date.now()/1000)+900}}));return account;}
async function cleanup(){for(const share of shares)await db.send(new DeleteCommand({TableName:config.TableName,Key:{pk:`SHARE#${sha(share)}`,sk:'SHARE'}}));for(const account of accounts){let cursor;do{const result=await db.send(new QueryCommand({TableName:config.TableName,KeyConditionExpression:'pk = :pk',ExpressionAttributeValues:{':pk':`USER#${account.id}`},ExclusiveStartKey:cursor}));for(const item of result.Items||[])await db.send(new DeleteCommand({TableName:config.TableName,Key:{pk:item.pk,sk:item.sk}}));cursor=result.LastEvaluatedKey;}while(cursor);for(const prefix of [`files/${account.id}/`,`staging/${account.id}/`]){const versions=await s3.send(new ListObjectVersionsCommand({Bucket:config.FilesBucket,Prefix:prefix}));const objects=[...(versions.Versions||[]),...(versions.DeleteAveryers||[])].map(o=>({Key:o.Key,VersionId:o.VersionId}));if(objects.length)await s3.send(new DeleteObjectsCommand({Bucket:config.FilesBucket,Delete:{Objects:objects}}));}await db.send(new DeleteCommand({TableName:config.TableName,Key:{pk:`SESSION#${sha(account.session)}`,sk:'SESSION'}}));await cognito.send(new AdminDeleteUserCommand({UserPoolId:config.UserPoolId,Username:account.username}));}}
try{
  assert.equal((await request('/files')).status,401);console.log('PASS anonymous file access denied');
  const direct=await fetch(`${config.ApiUrl}api/health`);assert.equal(direct.status,403);console.log('PASS direct Lambda URL denied');
  const a=await newTestAccount('a'),b=await newTestAccount('b');
  assert.equal((await request('/me',{session:a.session})).data.user.id,a.id);
  const folder=await request('/folders',{session:a.session,method:'POST',data:{name:'QA folder',parentId:''}});assert.equal(folder.status,201,JSON.stringify(folder.data));const parentId=folder.data.file.id;console.log('PASS authenticated folder creation through CloudFront');
  const payload='PickBits File Share integration check: private upload and download.';
  const upload=await request('/uploads',{session:a.session,method:'POST',data:{name:'qa-note.txt',size:Buffer.byteLength(payload),mime:'text/plain',parentId}});assert.equal(upload.status,201,JSON.stringify(upload.data));const form=new FormData();for(const [k,v]of Object.entries(upload.data.fields))form.append(k,v);form.append('file',new Blob([payload],{type:'text/plain'}),'qa-note.txt');const sent=await fetch(upload.data.url,{method:'POST',body:form});assert.ok(sent.ok,await sent.text());
  const done=await request(`/uploads/${upload.data.id}/complete`,{session:a.session,method:'POST',data:{}});assert.equal(done.status,200,JSON.stringify(done.data));console.log('PASS direct S3 upload and finalization');
  const cors=await fetch(upload.data.url,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST'}});assert.ok(cors.ok);assert.equal(cors.headers.get('access-control-allow-origin'),origin);console.log('PASS browser upload cross-origin policy');
  const listing=await request('/files',{session:a.session});assert.equal(listing.data.files.length,2);const otherListing=await request('/files',{session:b.session});assert.equal(otherListing.data.files.length,0);
  assert.equal((await request(`/files/${upload.data.id}/download`,{session:b.session})).status,404);console.log('PASS cross-account isolation');
  const download=await request(`/files/${upload.data.id}/download`,{session:a.session});assert.equal(download.status,200);const bytes=await fetch(download.data.url);assert.equal(await bytes.text(),payload);console.log('PASS downloaded contents match original');
  const shared=await request(`/files/${upload.data.id}/share`,{session:a.session,method:'POST',data:{days:1}});assert.equal(shared.status,200,JSON.stringify(shared.data));shares.push(shared.data.token);
  assert.equal((await request(`/share/${shared.data.token}`)).status,401);assert.equal((await request(`/share/${shared.data.token}`,{session:b.session})).status,200);
  assert.equal((await request(`/files/${upload.data.id}/share`,{session:a.session,method:'DELETE'})).status,200);assert.equal((await request(`/share/${shared.data.token}`,{session:b.session})).status,404);console.log('PASS member-only sharing and revocation');
  assert.equal((await request(`/files/${parentId}`,{session:a.session,method:'PATCH',data:{action:'trash'}})).status,200);assert.equal((await request(`/files/${upload.data.id}/download`,{session:a.session})).status,400);assert.equal((await request(`/files/${parentId}`,{session:a.session,method:'PATCH',data:{action:'restore'}})).status,200);assert.equal((await request(`/files/${upload.data.id}/download`,{session:a.session})).status,200);console.log('PASS parent-folder trash and restore');
  assert.equal((await request('/folders',{session:a.session,method:'POST',data:{name:'Blocked'},requestOrigin:'https://example.com'})).status,403);assert.equal((await request('/admin/invite',{session:b.session,method:'POST',data:{email:'nobody@example.com'}})).status,403);console.log('PASS CSRF and owner-only invitation controls');
  const login=await request('/auth/login');assert.equal(login.status,302);const location=new URL(login.headers.get('location'));assert.equal(location.searchParams.get('code_challenge_method'),'S256');assert.equal(location.searchParams.get('redirect_uri'),`${origin}/api/auth/callback`);console.log('PASS Cognito login redirect and PKCE setup');
  console.log('All deployed file API checks passed. MFA API checks are in integration-mfa.mjs; the browser OAuth journey requires user sign-in.');
}finally{await cleanup();console.log('Removed all temporary test accounts, sessions, files, versions, and metadata.');}
