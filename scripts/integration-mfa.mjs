// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { deploymentConfig } from './deployment-config.mjs';
import { randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { makeTotp } from '../server/mfa.mjs';

// Isolated accounts and seeded app sessions exercise the deployed MFA gate.
// This does not exercise the browser's Cognito password/redirect flow. No email is sent.
if(!process.argv.includes('--run'))throw new Error('Opt-in only: pass --run to create and clean up temporary MFA accounts.');
const config=deploymentConfig();
const db=DynamoDBDocumentClient.from(new DynamoDBClient({region:config.region}));
const cognito=new CognitoIdentityProviderClient({region:config.region});
const run=randomBytes(6).toString('hex'), accounts=[], sessions=[];
const sha=s=>createHash('sha256').update(s).digest('hex');
async function request(path,session,data){
  const body=data===undefined?undefined:JSON.stringify(data);
  const r=await fetch(`${config.url}/api${path}`,{method:body?'POST':'GET',headers:{Cookie:`__Host-pickbits-file-share_session=${session}`,Origin:config.url,'Content-Type':'application/json','x-amz-content-sha256':sha(body||'')},body});
  return {status:r.status,data:await r.json()};
}
async function newSession(account){
  const raw=randomBytes(32).toString('base64url');sessions.push(raw);
  await db.send(new PutCommand({TableName:config.tableName,Item:{pk:`SESSION#${sha(raw)}`,sk:'SESSION',username:account.username,user:{id:account.id,email:account.email,name:'MFA integration test',admin:account.admin},authenticatedAt:Math.floor(Date.now()/1000),expiresAt:Math.floor(Date.now()/1000)+900}}));
  return raw;
}
async function newAccount(admin){
  const email=`pickbits-file-share-mfa-qa-${run}-${admin?'owner':'member'}@example.com`;
  const r=await cognito.send(new AdminCreateUserCommand({UserPoolId:config.userPoolId,Username:email,MessageAction:'SUPPRESS',UserAttributes:[{Name:'email',Value:email},{Name:'email_verified',Value:'true'}]}));
  const account={id:r.User.Attributes.find(a=>a.Name==='sub').Value,username:r.User.Username,email,admin};accounts.push(account);
  account.session=await newSession(account);return account;
}
async function cleanup(){
  for(const raw of sessions)await db.send(new DeleteCommand({TableName:config.tableName,Key:{pk:`SESSION#${sha(raw)}`,sk:'SESSION'}}));
  for(const a of accounts){
    for(const pk of [`USER#${a.id}`,`MFA-RATE#${a.id}`]){
      let cursor;do{const r=await db.send(new QueryCommand({TableName:config.tableName,KeyConditionExpression:'pk = :pk',ExpressionAttributeValues:{':pk':pk},ExclusiveStartKey:cursor,ConsistentRead:true}));for(const item of r.Items||[])await db.send(new DeleteCommand({TableName:config.tableName,Key:{pk:item.pk,sk:item.sk}}));cursor=r.LastEvaluatedKey;}while(cursor);
    }
    await cognito.send(new AdminDeleteUserCommand({UserPoolId:config.userPoolId,Username:a.username}));
  }
}
function expectStatus(result,status){assert.equal(result.status,status,`Expected ${status}, received ${result.status}: ${result.data.error||'unexpected response'}`);}
async function enroll(a){
  const setup=await request('/mfa/setup',a.session,{});expectStatus(setup,200);
  assert.match(setup.data.uri,/^otpauth:\/\/totp\//);
  const totp=makeTotp(setup.data.secret,a.email),counter=Math.floor(Date.now()/30000),code=totp.generate({timestamp:counter*30000});
  expectStatus(await request('/mfa/verify',a.session,{code}),200);
  const me=await request('/me',a.session);assert.equal(me.data.mfa.enabled,true);assert.equal(me.data.mfa.verified,true);assert.equal(me.data.mfa.factor,undefined);
  return {totp,counter,code};
}
try{
  const member=await newAccount(false),owner=await newAccount(true);
  const status=await request('/me',member.session);assert.equal(status.data.mfa.required,false);assert.equal(status.data.mfa.verified,true);expectStatus(await request('/files',member.session),200);
  console.log('PASS members can access their workspace without an authenticator');
  expectStatus(await request('/files',owner.session),403);
  expectStatus(await request('/folders',owner.session,{name:'MFA must block this'}),403);
  expectStatus(await request('/admin/invite',owner.session,{email:'nobody@example.com'}),403);
  console.log('PASS unverified owner cannot access files or send invitations');
  const ownerFactor=await enroll(owner);expectStatus(await request('/files',owner.session),200);
  expectStatus(await request('/mfa/disable',owner.session,{code:ownerFactor.code}),403);
  const ownerSecond=await newSession(owner);expectStatus(await request('/files',ownerSecond),403);
  expectStatus(await request('/mfa/verify',ownerSecond,{code:ownerFactor.code}),400);
  const ownerNext=ownerFactor.totp.generate({timestamp:(ownerFactor.counter+1)*30000});expectStatus(await request('/mfa/verify',ownerSecond,{code:ownerNext}),200);expectStatus(await request('/files',ownerSecond),200);
  console.log('PASS owner enrollment, code replay prevention, new-session challenge, and disable protection');
  const memberSecond=await newSession(member),memberFactor=await enroll(member);
  expectStatus(await request('/files',memberSecond),403);
  const nextCounter=memberFactor.counter+1;
  expectStatus(await request('/mfa/verify',memberSecond,{code:memberFactor.totp.generate({timestamp:nextCounter*30000})}),200);
  expectStatus(await request('/files',memberSecond),200);
  console.log('PASS optional member enrollment protects all other sessions');
  const waitMs=Math.max(0,nextCounter*30000-Date.now()+1000);
  if(waitMs){console.log('Waiting for the next authenticator code interval to verify disabling.');await new Promise(resolve=>setTimeout(resolve,waitMs));}
  const disableCode=memberFactor.totp.generate({timestamp:(nextCounter+1)*30000});
  expectStatus(await request('/mfa/disable',memberSecond,{code:disableCode}),200);
  const disabled=await request('/me',memberSecond);assert.equal(disabled.data.mfa.enabled,false);assert.equal(disabled.data.mfa.required,false);
  expectStatus(await request('/files',member.session),200);
  expectStatus(await request('/files',await newSession(member)),200);
  console.log('PASS members can disable their optional authenticator with a fresh code');
  console.log('All deployed MFA checks passed.');
}finally{await cleanup();console.log('Removed temporary MFA test accounts, sessions, secrets, and attempt records.');}
