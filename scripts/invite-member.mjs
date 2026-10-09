// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { loadConfig } from './config.mjs';
const settings=loadConfig();
import { execFileSync } from 'node:child_process';
import { CognitoIdentityProviderClient, AdminGetUserCommand, AdminCreateUserCommand } from '@aws-sdk/client-cognito-identity-provider';
const email=process.argv[2]?.trim().toLowerCase();
if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Provide the explicitly authorized invitation email.');
const data=JSON.parse(execFileSync('aws',['cloudformation','describe-stacks','--stack-name',settings.stackName,'--region',settings.region,'--output','json','--no-cli-pager'],{encoding:'utf8'}));
const pool=data.Stacks[0].Outputs.find(o=>o.OutputKey==='UserPoolId').OutputValue;
const cognito=new CognitoIdentityProviderClient({region:settings.region});
let exists=true;try{await cognito.send(new AdminGetUserCommand({UserPoolId:pool,Username:email}));}catch(e){if(e.name!=='UserNotFoundException')throw e;exists=false;}
if(exists){console.log(`An account or invitation already exists for ${email}. No duplicate email sent.`);}else{await cognito.send(new AdminCreateUserCommand({UserPoolId:pool,Username:email,UserAttributes:[{Name:'email',Value:email},{Name:'email_verified',Value:'true'}],DesiredDeliveryMediums:['EMAIL']}));console.log(`Member invitation sent to ${email}.`);}
