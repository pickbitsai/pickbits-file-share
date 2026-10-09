// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
export const DEFAULT_QUOTAS = Object.freeze({ perFileBytes: 1024 ** 3, perMemberBytes: 100 * 1024 ** 3 });
export const DEFAULT_MFA = Object.freeze({ owners: 'required', members: 'optional' });
const fail = (field, message) => { throw new Error(`Invalid file-share configuration: ${field} ${message}`); };
const text = (value, field, max = 255) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(field, `must be nonempty text (at most ${max} characters, no control characters).`);
  return value.trim();
};
const email = (value, field) => {
  const result = text(value, field, 254).toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(result)) fail(field, 'must be a plain email address.');
  return result;
};
function quotas(value = DEFAULT_QUOTAS) {
  for (const key of ['perFileBytes', 'perMemberBytes']) if (!Number.isSafeInteger(value?.[key]) || value[key] <= 0) fail(`quotas.${key}`, 'must be a positive safe integer in bytes.');
  if (value.perFileBytes > 5 * 1024 ** 3) fail('quotas.perFileBytes', 'cannot exceed the 5 GiB single-upload limit.');
  if (value.perFileBytes > value.perMemberBytes) fail('quotas.perFileBytes', 'cannot exceed quotas.perMemberBytes.');
  return { perFileBytes: value.perFileBytes, perMemberBytes: value.perMemberBytes };
}
function mfa(value = DEFAULT_MFA) {
  if (value?.owners !== 'required') fail('mfa.owners', 'must be "required"; owner MFA cannot be disabled.');
  if (!['optional', 'required'].includes(value.members)) fail('mfa.members', 'must be "optional" or "required".');
  return { owners: value.owners, members: value.members };
}
export function validateMembers(value) {
  if (!Array.isArray(value)) fail('teamWorkspace.members', 'must be an array.');
  const members = value.map((member, i) => ({ id: text(member?.id, `teamWorkspace.members[${i}].id`, 128), email: email(member?.email, `teamWorkspace.members[${i}].email`), name: text(member?.name, `teamWorkspace.members[${i}].name`, 100) }));
  if (members.some(member => /\s|[#|]/.test(member.id))) fail('teamWorkspace.members[].id', 'must be an immutable Cognito account ID without spaces or separators.');
  if (new Set(members.map(member => member.id)).size !== members.length) fail('teamWorkspace.members[].id', 'must be unique.');
  return members;
}
export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('root', 'must be an object.');
  const businessName = text(input.businessName, 'businessName', 100);
  const domain = text(input.domain, 'domain').toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) fail('domain', 'must be a DNS hostname such as files.example.com, without a scheme or path.');
  const hostedZoneId = text(input.hostedZoneId, 'hostedZoneId');
  if (!/^Z[A-Z0-9]+$/.test(hostedZoneId)) fail('hostedZoneId', 'must be a Route 53 zone ID beginning with Z.');
  const region = text(input.region, 'region');
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) fail('region', 'must be an AWS region name.');
  const certificateRegion = input.certificateRegion ?? 'us-east-1';
  if (certificateRegion !== 'us-east-1') fail('certificateRegion', 'must be us-east-1 for CloudFront.');
  const stackName = input.stackName ?? 'pickbits-file-share';
  if (typeof stackName !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(stackName)) fail('stackName', 'must start with a lowercase letter and contain at most 40 lowercase letters, digits, or hyphens.');
  return { businessName, domain, hostedZoneId, region, certificateRegion, stackName, ownerEmail: email(input.ownerEmail, 'ownerEmail'), sesFromAddress: email(input.sesFromAddress, 'sesFromAddress'), teamWorkspace: { members: validateMembers(input.teamWorkspace?.members ?? []) }, quotas: quotas(input.quotas), mfa: mfa(input.mfa) };
}
export function runtimeConfig(env) {
  const parse = (name, fallback) => { try { return env[name] ? JSON.parse(env[name]) : fallback; } catch { fail(name, 'must contain valid JSON.'); } };
  return { businessName: env.BUSINESS_NAME ? text(env.BUSINESS_NAME, 'BUSINESS_NAME', 100) : '', ownerEmail: env.OWNER_EMAIL ? email(env.OWNER_EMAIL, 'OWNER_EMAIL') : '', teamWorkspace: { members: validateMembers(parse('TEAM_WORKSPACE_MEMBERS', [])) }, quotas: quotas(parse('QUOTAS', DEFAULT_QUOTAS)), mfa: mfa(parse('MFA_POLICY', DEFAULT_MFA)) };
}
export function configEnvironment(config) {
  return { BUSINESS_NAME: config.businessName, APP_ORIGIN: `https://${config.domain}`, OWNER_EMAIL: config.ownerEmail, MAIL_FROM: config.sesFromAddress, MAIL_REPLY_TO: config.ownerEmail, TEAM_WORKSPACE_MEMBERS: JSON.stringify(config.teamWorkspace.members), QUOTAS: JSON.stringify(config.quotas), MFA_POLICY: JSON.stringify(config.mfa) };
}
