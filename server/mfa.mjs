// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import * as OTPAuth from 'otpauth';
import { randomUUID } from 'node:crypto';
import { GetCommand, UpdateCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

export const ownerRequiresMfa = (user, ownerEmail = '') => !!user.admin || !!(ownerEmail && user.email?.toLowerCase() === ownerEmail.toLowerCase());
export function makeTotp(secret,email){return new OTPAuth.TOTP({issuer:'PickBits File Share',label:email,algorithm:'SHA1',digits:6,period:30,secret:OTPAuth.Secret.fromBase32(secret)});}

export function createMfa({db,TableName,AppError,ownerEmail='',membersRequired=false,now=()=>Math.floor(Date.now()/1000)}){
  const key=user=>({pk:`USER#${user.id}`,sk:'MFA'});
  async function policy(session){
    const factor=(await db.send(new GetCommand({TableName,Key:key(session.user),ConsistentRead:true}))).Item;
    const required=!!ownerRequiresMfa(session.user,ownerEmail)||membersRequired||!!factor;
    const verified=!required||!!(factor&&session.mfaVersion===factor.version);
    return {factor,required,verified,enabled:!!factor,ownerRequired:!!ownerRequiresMfa(session.user,ownerEmail)||membersRequired,needsSignIn:!session.authenticatedAt||now()-session.authenticatedAt>600};
  }
  function fresh(session){if(!session.authenticatedAt||now()-session.authenticatedAt>600)throw new AppError(401,'Please sign in again before changing or verifying your authenticator.');}
  async function setup(session){
    fresh(session);const p=await policy(session);if(p.factor)throw new AppError(409,'An authenticator is already enabled.');
    let secret=session.pendingMfaSecret;
    if(!secret||session.pendingMfaExpires<=now()){
      secret=new OTPAuth.Secret({size:20}).base32;
      await db.send(new UpdateCommand({TableName,Key:{pk:session.pk,sk:session.sk},UpdateExpression:'SET pendingMfaSecret = :secret, pendingMfaExpires = :expires',ExpressionAttributeValues:{':secret':secret,':expires':now()+600},ConditionExpression:'attribute_exists(pk)'}));
    }
    return {secret,uri:makeTotp(secret,session.user.email).toString()};
  }
  async function checkCode(session,secret,code,lastCounter=-1){
    if(typeof code!=='string'||!/^\d{6}$/.test(code))throw new AppError(400,'Enter the six-digit code from your authenticator.');
    // Attempts are limited per account, including across new browser sessions.
    try{await db.send(new UpdateCommand({TableName,Key:{pk:`MFA-RATE#${session.user.id}`,sk:String(Math.floor(now()/300))},UpdateExpression:'SET expiresAt = :expiry ADD attempts :one',ConditionExpression:'attribute_not_exists(attempts) OR attempts < :limit',ExpressionAttributeValues:{':expiry':now()+600,':one':1,':limit':5}}));}catch(e){if(e.name==='ConditionalCheckFailedException')throw new AppError(429,'Too many attempts. Please wait five minutes before trying again.');throw e;}
    const delta=makeTotp(secret,session.user.email).validate({token:code,window:1,timestamp:now()*1000});
    const counter=Math.floor(now()/30)+(delta??0);
    if(delta===null||counter<=lastCounter)throw new AppError(400,'That code is invalid or has already been used. Wait for a new code and try again.');
    return counter;
  }
  async function verify(session,code){
    fresh(session);const p=await policy(session);let factor=p.factor;
    if(!factor){if(!session.pendingMfaSecret||session.pendingMfaExpires<=now())throw new AppError(400,'Start authenticator setup again.');factor={...key(session.user),secret:session.pendingMfaSecret,version:randomUUID()};}
    const counter=await checkCode(session,factor.secret,code,factor.lastCounter??-1);
    const factorWrite=p.factor?{Update:{TableName,Key:key(session.user),UpdateExpression:'SET lastCounter = :counter',ConditionExpression:'#version = :version AND lastCounter < :counter',ExpressionAttributeNames:{'#version':'version'},ExpressionAttributeValues:{':counter':counter,':version':factor.version}}}:{Put:{TableName,Item:{...factor,lastCounter:counter,createdAt:now()},ConditionExpression:'attribute_not_exists(pk)'}};
    try{await db.send(new TransactWriteCommand({TransactItems:[factorWrite,{Update:{TableName,Key:{pk:session.pk,sk:session.sk},UpdateExpression:'SET mfaVersion = :version REMOVE pendingMfaSecret, pendingMfaExpires',ConditionExpression:'attribute_exists(pk)',ExpressionAttributeValues:{':version':factor.version}}}]}));}catch(e){if(e.name==='TransactionCanceledException')throw new AppError(409,'This code was already used or setup changed. Please try a new code.');throw e;}
    return {ok:true};
  }
  async function disable(session,code){
    if(ownerRequiresMfa(session.user,ownerEmail)||membersRequired)throw new AppError(403,'An authenticator is required by your account policy.');
    fresh(session);const p=await policy(session);if(!p.factor)return {ok:true};
    if(!p.verified)throw new AppError(403,'Verify your authenticator before changing it.');
    const counter=await checkCode(session,p.factor.secret,code,p.factor.lastCounter);
    try{await db.send(new TransactWriteCommand({TransactItems:[{Delete:{TableName,Key:key(session.user),ConditionExpression:'#version = :version AND lastCounter < :counter',ExpressionAttributeNames:{'#version':'version'},ExpressionAttributeValues:{':counter':counter,':version':p.factor.version}}},{Update:{TableName,Key:{pk:session.pk,sk:session.sk},UpdateExpression:'REMOVE mfaVersion',ConditionExpression:'attribute_exists(pk)'}}]}));}catch(e){if(e.name==='TransactionCanceledException')throw new AppError(409,'Security settings changed. Please try again.');throw e;}
    return {ok:true};
  }
  return {policy,setup,verify,disable};
}
