// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMfa, ownerRequiresMfa, makeTotp } from '../server/mfa.mjs';
import { AppError } from '../server/api.mjs';

const NOW=1_800_000_000;const SECRET='JBSWY3DPEHPK3PXP';
function harness({owner=true,factor=null,verified=false,old=false,limited=false}={}){
  const calls=[];const session={pk:'SESSION#test',sk:'SESSION',user:{id:'u1',email:owner?'owner@example.com':'friend@example.com',admin:owner},authenticatedAt:old?NOW-700:NOW,expiresAt:NOW+28800,...(verified?{mfaVersion:'v1'}:{})};
  const db={async send(c){calls.push(c);if(c.constructor.name==='GetCommand')return {Item:factor};if(limited&&c.input.Key?.pk?.startsWith('MFA-RATE#')){const e=new Error();e.name='ConditionalCheckFailedException';throw e;}return {};}};
  return {mfa:createMfa({db,TableName:'test',AppError,now:()=>NOW}),session,calls};
}
test('owner email is protected even if the group claim is absent',()=>{assert.equal(ownerRequiresMfa({email:'OWNER@EXAMPLE.COM',admin:false},'owner@example.com'),true);assert.equal(!!ownerRequiresMfa({email:'friend@example.com',admin:false}),false);});
test('unenrolled owner must set up MFA while a regular member can skip it',async()=>{const a=harness();assert.equal((await a.mfa.policy(a.session)).verified,false);const b=harness({owner:false});assert.equal((await b.mfa.policy(b.session)).verified,true);});
test('enrolled members must verify MFA on every new app session',async()=>{const h=harness({owner:false,factor:{version:'v1',secret:SECRET,lastCounter:0}});assert.equal((await h.mfa.policy(h.session)).verified,false);});
test('reset or replacement factors invalidate previously verified sessions',async()=>{const h=harness({factor:{version:'v2'},verified:true});assert.equal((await h.mfa.policy(h.session)).verified,false);});
test('setup requires recent sign-in and does not replace an existing factor',async()=>{const a=harness({old:true});await assert.rejects(a.mfa.setup(a.session),e=>e.status===401);const b=harness({factor:{version:'v1'}});await assert.rejects(b.mfa.setup(b.session),e=>e.status===409);});
test('setup generates a unique secret and standard authenticator URI',async()=>{const h=harness();const d=await h.mfa.setup(h.session);assert.match(d.secret,/^[A-Z2-7]+$/);assert.match(d.uri,/^otpauth:\/\/totp\//);assert.equal(new URL(d.uri).searchParams.get('issuer'),'PickBits File Share');assert.ok(h.calls.some(c=>c.input.ExpressionAttributeValues?.[':secret']===d.secret));});
test('a valid code completes enrollment and records its consumed counter atomically',async()=>{const h=harness();Object.assign(h.session,{pendingMfaSecret:SECRET,pendingMfaExpires:NOW+600});const code=makeTotp(SECRET,h.session.user.email).generate({timestamp:NOW*1000});assert.deepEqual(await h.mfa.verify(h.session,code),{ok:true});const tx=h.calls.find(c=>c.constructor.name==='TransactWriteCommand');assert.equal(tx.input.TransactItems[0].Put.Item.lastCounter,Math.floor(NOW/30));assert.equal(tx.input.TransactItems[0].Put.ConditionExpression,'attribute_not_exists(pk)');});
test('incorrect and replayed codes do not authorize a session',async()=>{const f={version:'v1',secret:SECRET,lastCounter:Math.floor(NOW/30)};const h=harness({factor:f});const code=makeTotp(SECRET,h.session.user.email).generate({timestamp:NOW*1000});await assert.rejects(h.mfa.verify(h.session,code),e=>e.status===400);await assert.rejects(h.mfa.verify(h.session,'123'),e=>e.status===400);assert.ok(!h.calls.some(c=>c.constructor.name==='TransactWriteCommand'));});
test('attempt limits apply before authenticator validation',async()=>{const h=harness({factor:{version:'v1',secret:SECRET,lastCounter:0},limited:true});await assert.rejects(h.mfa.verify(h.session,'000000'),e=>e.status===429);});
test('owners cannot disable MFA even with a verified session',async()=>{const h=harness({factor:{version:'v1',secret:SECRET},verified:true});await assert.rejects(h.mfa.disable(h.session,'000000'),e=>e.status===403);});
test('members must present a fresh, unused code to disable their factor',async()=>{const h=harness({owner:false,factor:{version:'v1',secret:SECRET,lastCounter:0},verified:true});const code=makeTotp(SECRET,h.session.user.email).generate({timestamp:NOW*1000});assert.deepEqual(await h.mfa.disable(h.session,code),{ok:true});assert.ok(h.calls.find(c=>c.constructor.name==='TransactWriteCommand').input.TransactItems[0].Delete);});
