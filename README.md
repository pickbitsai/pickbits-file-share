How do I replace Dropbox for my team with file storage my business owns? PickBits File Share puts your files in an S3 bucket in your own AWS account. You pay AWS directly for storage and transfer; team members sign in with MFA, and you can send documents for signature. Owner MFA is mandatory; members can enable it themselves, or you can require it for everyone in configuration.

# PickBits File Share 0.1.0

Open-source software under Apache-2.0 for one small business operating its own file workspace. You administer the AWS account, identities, backups, and bills.

## What it does

- Signed direct S3 uploads with progress and configurable per-file and per-member quotas. Defaults are 1 GiB per file and 100 GiB per member.
- Folders, rename, move, search, recent files, stars, list/grid views, and recoverable trash. Multi-select moves show progress and keep unfinished items selected for retry. Selecting a folder preserves its contents; the list header selects up to 100 items on the current page.
- Image, text, audio, and video previews. HTML, SVG, and other active content download as attachments.
- A team workspace defined by immutable Cognito account IDs. Members can browse, download, rename, move, star, trash, and restore each other's files. Upload attribution and quotas remain with the original uploader. Lists refresh every 30 seconds while visible and on focus, with uploader filtering and pagination.
- Expiring, revocable file links that require an active signed-in account. Team workspace links also require team membership. Accounts outside that workspace have separate private collections.
- Cognito invitations, initial password setup, password recovery, and server-side authenticator (TOTP) MFA.
- Documents: owners send PDF agreements, receipts, or invoices by private 30-day links. Customers need no account for these specific document links. Agreements collect typed and drawn signatures, append a signatures page to the PDF, and email the signed copy to both parties through SES. Receipts and invoices record the first view. Links can be replaced or voided.

## What it does not do

This is not end-to-end encrypted. There is no desktop sync, anonymous public file sharing, malware scanning, file version-restore UI, payment processing, or contractual uptime guarantee. Private bearer links for Documents are a deliberate exception to file sign-in requirements: anyone holding one can view that document and, for an agreement, sign it. These are simple electronic signatures, not identity-verified or certificate-backed signatures.

This is not a HIPAA/SOC 2 compliance product. Lost-MFA recovery requires an AWS operator. There is no self-service factor recovery. Trash retention is indefinite and trashed files still count toward quotas; permanent deletion is not exposed in this release. Document storage is separate from file quotas, with a 20 MiB limit per PDF. No telemetry, analytics, tracking pixels, or runtime CDN/font loads are included.

## Five-minute start

Install Node 22.13 or newer, download this repository, and open a terminal in its folder:

```sh
npm ci
npm run demo
```

Open **http://127.0.0.1:4202**. You will see a yellow demo banner and buttons to use either of two fictional team members. Choose **Use Avery Rowan** to see a Mesa landscaping company's 20 generated files: customer job folders, notes and materials lists, estimates, invoices, six before/after yard illustrations, a signed agreement, and crew and plant-care guides. All people, businesses, street addresses, job details, and signatures are invented; contacts use example.com and a 555-01xx phone number. The paperwork itself looks like normal business documents. No AWS account, credentials, or real sign-in is needed. Installation downloads dependencies; running the demo makes no provider calls.

The demo builds the frontend and serves it and the API in one Node process. Files and JSON metadata stay in `.demo-data/`; email appears as `.eml` files in `.demo-data/outbox/`. The banner links to an agreement awaiting signature. See [DEMO.md](DEMO.md) for a 60-second walkthrough.

Press Ctrl+C to stop. To delete this repository's local demo data and start again:

```sh
npm run demo -- --reset
```

The demo refuses `NODE_ENV=production` and any host other than `127.0.0.1`. Do not expose it through a tunnel or reverse proxy. It has fixed synthetic identities and preverified demo sessions, not real authentication or an AWS emulator. The demo always uses the fictional business and identities; a local config can supply its file quotas.

## Configuration reference

Copy `file-share.config.example.json` to `file-share.config.json`, edit it, then run `npm run configure`. The local config is gitignored. Do not put AWS credentials in it. No config is needed for demo or a clean build.

| Field | Meaning |
| --- | --- |
| `businessName` | Business label, at most 100 characters. The UI displays `<businessName> files`; an unconfigured development server displays `PickBits File Share`. |
| `domain` | DNS hostname, such as `files.example.com`, without a scheme or path. |
| `hostedZoneId` | Your public Route 53 hosted zone containing that domain. Replace the example placeholder. |
| `region` | AWS region for storage, Cognito, Lambda, DynamoDB, and SES. |
| `certificateRegion` | Must be `us-east-1` for the CloudFront certificate. |
| `stackName` | Defaults to `pickbits-file-share`; lowercase letters, digits, and hyphens, starting with a letter, at most 40 characters. |
| `ownerEmail` | Your owner account and signed-document copy destination. That account must enroll in MFA even without the owners group claim. |
| `sesFromAddress` | Plain sender address you control and verify with SES; no display-name wrapper. |
| `teamWorkspace.members` | Array of `{id, email, name}`. Use the immutable Cognito `sub` for `id`; email and name are display labels. IDs must be unique. An empty array gives each account a private collection. |
| `quotas.perFileBytes` | Positive integer byte limit, default 1 GiB, at most 5 GiB and no larger than the member limit. |
| `quotas.perMemberBytes` | Positive integer byte allowance per original uploader, default 100 GiB. Includes trashed files and reserved uploads. |
| `mfa.owners` | Must be `required`. |
| `mfa.members` | `optional` by default; use `required` to enforce MFA for every member. |

The template injects `BUSINESS_NAME`, `APP_ORIGIN`, `OWNER_EMAIL`, `MAIL_FROM`, `MAIL_REPLY_TO`, `TEAM_WORKSPACE_MEMBERS`, `QUOTAS`, and `MFA_POLICY`, plus generated resource identifiers, into Lambda. The server validates its runtime settings. Only the business label and quotas are publicly exposed through `/api/config`; membership is returned only to a signed-in member of that workspace. AWS credentials use the Lambda execution role or the operator's AWS credential chain.

Changing team membership changes access to existing uploads without moving or copying objects. Folder relationships may span member accounts. Review those relationships before removing a member or reverting to private collections. An invitation or owner role never automatically grants team membership.

## Deploy to your own AWS account

These commands are opt-in and create billable resources or send invitations. None runs during tests or preflight. Install and authenticate the AWS CLI to the account you intend to use. Use a public Route 53 zone for a domain you control.

1. Create and validate the local config as described above. Keep the team member array empty until Cognito accounts exist. Run `npm run preflight` locally.
2. Generate and inspect the CloudFormation templates with `node infra/template.mjs`. Generated templates contain your settings and stay in gitignored `infra/generated/`. Run `node scripts/deploy-infra.mjs --apply` to deploy the certificate stack in the certificate region, read its certificate output, and deploy the application stack in the configured region with IAM capability acknowledged. DNS validation may take time.
3. Run `npm run build`, then `node scripts/deploy-api.mjs --publish` and `node scripts/deploy-web.mjs --publish`. The API script packages the built Lambda entry point; the frontend script uploads hashed assets with immutable caching, sets the HTML to no-cache, and invalidates CloudFront. On updates it saves the previous HTML under `.tmp/web-releases/` for rollback.
4. Verify the configured SES sender using the verification message. Arrange SES production access in your region before emailing unverified recipients; sandbox delivery restrictions still apply. Confirm sending and receiving with accounts you control.
5. Run `node scripts/provision-owner.mjs --send-invitation`. It provisions the configured owner and owners-group membership without sending duplicate invitations to an existing account. The owner sets a password and enrolls an authenticator before accessing files. Invite members from the app or run `node scripts/invite-member.mjs <authorized-member-address>` for a specific intended recipient.
6. Obtain each member's immutable `sub` from Cognito, place their IDs and display labels in `teamWorkspace.members`, and rerun the infrastructure deployment. Keep the config private. Verify that the intended members can see the team workspace and outsiders cannot. If MFA is optional for members, have each member enable it in Account security.
7. Run `node scripts/verify-deployment.mjs --run` to compare the deployed frontend and headers with your local build. Optional deeper checks are `node scripts/integration-test.mjs --run` and `node scripts/integration-mfa.mjs --run`. They create isolated temporary accounts, sessions, and test records and clean up in `finally`; they send no invitation emails. Interrupted runs can require operator cleanup. They do not automate the browser OAuth journey.
8. Establish AWS budgets, monitoring, account-disable procedures, MFA recovery, backups, restore drills, and an incident response process before using real business files. Test invitations, password recovery, MFA, uploads, downloads, and document delivery yourself in the deployed environment.

CloudFormation manages private S3 buckets, DynamoDB, Cognito, Lambda, logs, scoped IAM permissions, CloudFront, DNS, the certificate, and an SES identity. Data resources are retained when the stack is removed. Removing a stack does not erase retained data or stop its storage charges. Use the configured stack's outputs to find resources; no deployment IDs are checked into this repository.

### What AWS will bill you for

Expect charges for S3 stored objects, versions, and requests; data transfer and CloudFront requests; Lambda execution and requests; DynamoDB storage, requests, and recovery features; Cognito usage under your account's plan; Route 53 zones and DNS queries; CloudWatch log ingestion and retention; and SES messages and attachments. Domain registration, backups, support plans, or other account services can add charges. Review AWS billing for your own usage and region. No vendor subscription is collected by this software.

## Security and operational boundaries

- CloudFront authenticates to the private S3 frontend and Lambda URL using origin access control. Direct Lambda URL requests are denied by IAM. The response policy includes CSP, no-sniff, frame denial, referrer controls, and HSTS.
- Cognito authorization-code login uses PKCE, state, and nonce. Session IDs are random, hashed in DynamoDB, and stored in Secure/HttpOnly/SameSite cookies in HTTPS deployments. Sessions expire after eight hours; account-enabled status is checked on every authenticated request.
- Cognito permits password-only sign-in. The application then enforces TOTP for owners, required members, or members who enabled an authenticator. Owners must enroll before accessing files or inviting people and cannot disable the factor. Every new session requires a new code for enrolled accounts; existing owner sessions must sign in again to enroll. Setup, verification, and disabling require sign-in within ten minutes. Attempts are limited per account, consumed codes cannot be reused, and factor changes invalidate previous verification. Secrets stay in AWS-encrypted DynamoDB; setup keys and QR codes are returned only during authenticated enrollment. Protect your authenticator backup. Lost-factor recovery needs an AWS operator.
- Every file operation is scoped to the authenticated account's explicitly configured workspace. File links require an active account, an unexpired link, and team membership for team files. Download URLs expire in 60 seconds; already issued URLs may remain usable for those seconds after link revocation. Downloads in progress and saved copies cannot be recalled.
- Writes require the configured same-origin `Origin` and JSON requests. Exact upload sizes are enforced in signed S3 POST policies. File uploads land in staging and are copied to separate final keys, so reusing an upload URL cannot overwrite a completed file. Uploaded HTML/SVG and other active content are forced to download, never executed as same-origin HTML.
- File quota reservations are transactional. Abandoned pending file uploads are cleaned up during later listing requests after 15 minutes. Staging objects expire through the bucket lifecycle. Document PDFs use their own upload path; signing checks the original SHA-256, and rejects changed originals. Document recipient tokens use the URL fragment to keep them out of the frontend request path; API log errors redact document tokens. Treat recipient links as confidential bearer credentials.
- Encryption is TLS in transit and AWS-managed encryption at rest. This is **not end-to-end encryption**: sufficiently privileged AWS operators can access files and MFA records.
- S3 versioning and DynamoDB point-in-time recovery are enabled. They are not a separately tested disaster-recovery service. Trash retention is indefinite. Document email failures may be recorded after a signature is saved; monitor delivery and download the saved signed copy when needed.
- No malware scanning, desktop sync, anonymous public file links, version restoration UI, commercial billing, or availability guarantee is included. Do not describe this software as HIPAA/SOC 2 compliant.
- Monitor AWS charges and service errors. Lambda concurrency is capped at five. Set budget alerts and establish restore, account-revocation, and incident-response procedures. Disable a member through Cognito AdminDisableUser to block their next authenticated request. Member-facing invitation authority does not grant AWS operator access or access to another workspace.

## Development and release checks

`npm run dev` serves Vite on `127.0.0.1:4202` with strict port allocation and proxies `/api` to the loopback API on `127.0.0.1:4203`. Vite preview also uses 4202. Stop demo before starting development. Without AWS resource environment variables, development shows the sign-in surface; use demo for local data. With deliberate AWS resource configuration, development uses your AWS credential chain and may contact those resources.

`npm run preflight` runs typecheck, lint, unit tests, web/Lambda build, publication leakscan, and a clean-consumer test. The consumer copies only files Git tracks or would track (including untracked release files), installs with `npm ci --offline`, builds, and invokes demo handlers in-process without binding a port. Run `npm ci` or `npm install` once to warm the npm cache first. Live integration scripts remain excluded.

The adapter seam uses the existing SDK command interface for storage, metadata, identity, and email. Lambda supplies AWS adapters; demo supplies disk storage, a transactional JSON table, fixed synthetic identities, and an email outbox. The local table supports only expressions used by this API. Tests call handlers directly; they neither contact AWS nor bind ports.

Questions and bugs: open a GitHub issue.
