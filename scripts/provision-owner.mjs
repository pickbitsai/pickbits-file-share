// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { loadConfig } from './config.mjs';
const settings=loadConfig();
import { execFileSync } from 'node:child_process';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminGetUserCommand, AdminAddUserToGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
if(!process.argv.includes('--send-invitation'))throw new Error('Pass --send-invitation only after the owner authorizes the invitation email.');
const data=JSON.parse(execFileSync('aws',['cloudformation','describe-stacks','--stack-name',settings.stackName,'--region',settings.region,'--output','json','--no-cli-pager'],{encoding:'utf8'}));
const pool=data.Stacks[0].Outputs.find(o=>o.OutputKey==='UserPoolId').OutputValue;
const cognito=new CognitoIdentityProviderClient({region:settings.region});
const Username=settings.ownerEmail;let created=false;
try{await cognito.send(new AdminGetUserCommand({UserPoolId:pool,Username}));}catch(e){if(e.name!=='UserNotFoundException')throw e;await cognito.send(new AdminCreateUserCommand({UserPoolId:pool,Username,MessageAction:'SUPPRESS',UserAttributes:[{Name:'email',Value:Username},{Name:'email_verified',Value:'true'}]}));created=true;}
await cognito.send(new AdminAddUserToGroupCommand({UserPoolId:pool,Username,GroupName:'owners'}));
if(created){await cognito.send(new AdminCreateUserCommand({UserPoolId:pool,Username,MessageAction:'RESEND',DesiredDeliveryMediums:['EMAIL']}));console.log('Owner account created and sign-in invitation sent.');}else{console.log('Owner account already exists. Owner permission verified; no duplicate invitation sent.');}
