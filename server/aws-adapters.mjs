// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

// The API uses the SDK command protocol; local adapters implement only its used subset.
// Construction performs no I/O. Credentials remain in the normal AWS provider chain.
export function createAwsAdapters(env = process.env, overrides = {}) {
  const region = env.AWS_REGION;
  return {
    db: overrides.db || DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } }),
    s3: overrides.s3 || new S3Client({ region }),
    cognito: overrides.cognito || new CognitoIdentityProviderClient({ region }),
    ses: overrides.ses || new SESv2Client({ region }),
    verifier: overrides.verifier || (env.USER_POOL_ID && env.CLIENT_ID ? CognitoJwtVerifier.create({ userPoolId: env.USER_POOL_ID, tokenUse: 'id', clientId: env.CLIENT_ID }) : null),
    signPost: overrides.signPost || createPresignedPost,
    signUrl: overrides.signUrl || getSignedUrl,
  };
}
