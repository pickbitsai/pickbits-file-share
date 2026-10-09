// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { GetCommand, QueryCommand, PutCommand, DeleteCommand, UpdateCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { AdminGetUserCommand, AdminCreateUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createMfa } from './mfa.mjs';
import { createAwsAdapters } from './aws-adapters.mjs';
import { runtimeConfig } from '../lib/config.mjs';

export const MAX_FILE_SIZE = 1024 ** 3;
export const MAX_DOCUMENT_SIZE = 20 * 1024 ** 2;
export const MAX_SIGNATURE_SIZE = 200 * 1024;
export const QUOTA = 100 * 1024 ** 3;
export const hash = value => createHash('sha256').update(value).digest('hex');
export function validateName(value) { if (typeof value !== 'string' || !value.trim() || value.trim().length > 255 || /[\x00-\x1f\x7f/\\]/.test(value)) throw new AppError(400, 'Use a name between 1 and 255 characters, without slashes or control characters.'); return value.trim(); }
export function validateEmail(value) { const email = typeof value === 'string' ? value.trim().toLowerCase() : ''; if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new AppError(400, 'Enter a valid email address.'); return email; }
export class AppError extends Error { constructor(status, message) { super(message); this.status = status; } }
export function createApi(overrides = {}) {
  const env = overrides.env || process.env;
  const config = runtimeConfig(env);
  const defaults = overrides.adapters || createAwsAdapters(env, overrides);
  const { db, s3, cognito, ses, verifier, signPost, signUrl } = { ...defaults, ...overrides };
  const MAX_FILE_SIZE = config.quotas.perFileBytes, QUOTA = config.quotas.perMemberBytes;
  const businessName = config.businessName || 'PickBits File Share';
  const origin = env.APP_ORIGIN || 'http://127.0.0.1:4202';
  const secure = origin.startsWith('https:');
  const cookieName = secure ? '__Host-pickbits-file-share_session' : 'pickbits-file-share_session';
  const stateCookie = secure ? '__Host-pickbits-file-share_state' : 'pickbits-file-share_state';
  const TableName = env.TABLE_NAME;
  // Explicit account IDs define the team workspace; invitations never add access.
  const sharedMembers = config.teamWorkspace.members;
  const sharedIds = sharedMembers.map(m => m.id);
  const ownersFor = owner => sharedIds.includes(owner) ? [owner, ...sharedIds.filter(id => id !== owner)] : [owner];
  const workspaceFor = user => ({shared:sharedIds.includes(user.id),name:sharedIds.includes(user.id)?'Team workspace':'Personal workspace',members:sharedIds.includes(user.id)?sharedMembers:[]});
  const now = () => Math.floor(Date.now()/1000);
  const mfa = createMfa({db,TableName,AppError,now,ownerEmail:config.ownerEmail,membersRequired:config.mfa.members==='required'});
  const token = () => randomBytes(32).toString('base64url');
  const cookie = (name, value, seconds) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure?'; Secure':''}`;
  const get = async (pk, sk) => (await db.send(new GetCommand({TableName,Key:{pk,sk},ConsistentRead:true}))).Item;
  const put = item => db.send(new PutCommand({TableName,Item:item}));
  const del = (pk,sk) => db.send(new DeleteCommand({TableName,Key:{pk,sk}}));
  const itemKey = (owner,id) => ({pk:`USER#${owner}`,sk:`FILE#${id}`});
  const publicFile = ({pk,sk,key,stagingKey,ownerId,...file}) => ({...file,uploadedById:pk.slice(5),uploadedByName:sharedMembers.find(m=>m.id===pk.slice(5))?.name||'You'});
  const list = async owner => {const items=[];let start;do{const d=await db.send(new QueryCommand({TableName,KeyConditionExpression:'pk = :pk AND begins_with(sk, :prefix)',ExpressionAttributeValues:{':pk':`USER#${owner}`,':prefix':'FILE#'},ExclusiveStartKey:start,ConsistentRead:true}));items.push(...(d.Items||[]));start=d.LastEvaluatedKey;}while(start);return items;};
  const listPartition = async pk => {const items=[];let start;do{const d=await db.send(new QueryCommand({TableName,KeyConditionExpression:'pk = :pk AND begins_with(sk, :prefix)',ExpressionAttributeValues:{':pk':pk,':prefix':'DOC#'},ExclusiveStartKey:start,ConsistentRead:true}));items.push(...(d.Items||[]));start=d.LastEvaluatedKey;}while(start);return items;};
  async function findFile(owner,id) {const matches=await Promise.all(ownersFor(owner).map(idOwner=>get(`USER#${idOwner}`,`FILE#${id}`)));return matches.find(Boolean);}
  async function fileFor(owner,id,includeTrash=false) {if(!/^[a-f0-9-]{36}$/.test(id))throw new AppError(404,'File not found.');const f=await findFile(owner,id);if(!f||f.status==='pending'||(!includeTrash&&f.deletedAt))throw new AppError(404,'File not found.');if(!includeTrash)await checkParent(owner,f.parentId);return f;}
  async function checkParent(owner,id,exclude='') {const seen=new Set();while(id){if(id===exclude||seen.has(id))throw new AppError(400,'A folder cannot be moved inside itself.');seen.add(id);if(seen.size>50)throw new AppError(400,'Folders can be nested up to 50 levels.');const p=await findFile(owner,id);if(!p||p.kind!=='folder'||p.deletedAt)throw new AppError(400,'The destination folder is unavailable. Restore its parent first.');id=p.parentId;}}
  async function session(cookies) {const raw=cookies[cookieName];if(!raw)return null;const s=await get(`SESSION#${hash(raw)}`,'SESSION');if(!s||s.expiresAt<=now())return null;try{const u=await cognito.send(new AdminGetUserCommand({UserPoolId:env.USER_POOL_ID,Username:s.username}));if(!u.Enabled)return null;}catch(e){if(['UserNotFoundException','NotAuthorizedException'].includes(e.name))return null;throw e;}return s;}
  async function download(f,preview=false){const safePreview=/^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm)|audio\/[a-z0-9.+-]+|text\/plain)$/.test(f.mime);const disposition=`${preview&&safePreview?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`;return {url:await signUrl(s3,new GetObjectCommand({Bucket:env.FILES_BUCKET,Key:f.key,ResponseContentDisposition:disposition,ResponseContentType:preview&&safePreview?f.mime:'application/octet-stream'}),{expiresIn:60}),previewable:safePreview,name:f.name};}
  const documentId = id => typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
  const documentPublic = ({pk,sk,signatures=[],originalKey,signedKey,linkHash,recipientUrl,...d}) => ({...d,id:d.id||pk?.slice(4),signatures:signatures.map(({userId=null,role,email,typedName,signedAt})=>({userId,role,email,typedName,signedAt})),...(recipientUrl?{recipientUrl}:{})});
  const documentList = async pk => {const refs=await listPartition(pk);const docs=await Promise.all(refs.map(r=>get(`DOC#${r.documentId}`, 'DOC')));return docs.filter(Boolean).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).map(documentPublic);};
  const bodyBytes = async body => {if(!body)return Buffer.alloc(0);if(typeof body.transformToByteArray==='function')return Buffer.from(await body.transformToByteArray());if(body instanceof Uint8Array||Buffer.isBuffer(body))return Buffer.from(body);const chunks=[];for await(const chunk of body)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);};
  const objectBytes = async key => bodyBytes((await s3.send(new GetObjectCommand({Bucket:env.FILES_BUCKET,Key:key}))).Body);
  const signatureValue = value => {if(typeof value!=='string')throw new AppError(400,'Draw your signature before signing.');const match=value.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);if(!match)throw new AppError(400,'Signature must be a PNG image.');const bytes=Buffer.from(match[1],'base64');if(bytes.length<8||bytes.length>MAX_SIGNATURE_SIZE||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new AppError(400,'Signature must be a PNG image no larger than 200 KB.');return value;};
  const signerTime = iso => {const date=new Date(iso);return {utc:`${date.toISOString().replace('T',' ').replace('.000Z',' UTC')}`,phoenix:new Intl.DateTimeFormat('en-US',{timeZone:'America/Phoenix',dateStyle:'medium',timeStyle:'short'}).format(date)};};
  async function signedPdf(original,doc,signatures){const pdf=await PDFDocument.load(original);const page=pdf.addPage([612,792]);const font=await pdf.embedFont(StandardFonts.Helvetica);const bold=await pdf.embedFont(StandardFonts.HelveticaBold);page.drawText('Signatures',{x:48,y:742,size:23,font:bold,color:rgb(.1,.16,.25)});page.drawText('This page records the signatures added in PickBits File Share.',{x:48,y:715,size:10,font,color:rgb(.35,.4,.48)});let y=650;for(const signer of signatures){const image=await pdf.embedPng(Buffer.from(signer.signature.split(',')[1],'base64'));page.drawImage(image,{x:48,y:y-12,width:170,height:58});page.drawText(signer.typedName,{x:240,y:y+25,size:13,font:bold});page.drawText(`${signer.role==='recipient'?'Sent to: ':''}${signer.email}`,{x:240,y:y+8,size:10,font});const t=signerTime(signer.signedAt);page.drawText(`${t.utc} - ${t.phoenix} America/Phoenix`,{x:240,y:y-9,size:9,font,color:rgb(.35,.4,.48)});page.drawText(`IP: ${signer.ip||'Unavailable'}`,{x:240,y:y-24,size:9,font,color:rgb(.35,.4,.48)});y-=125;}const footer=`Document: ${doc.title}\nDocument ID: ${doc.id}\nOriginal document SHA-256: ${doc.originalHash}\nThe sender signed in their PickBits File Share account. The recipient signed using a private link sent to the email address shown.`;footer.split('\n').forEach((line,i)=>page.drawText(line,{x:48,y:105-i*15,size:8,font,color:rgb(.35,.4,.48)}));page.drawText('Made with PickBits File Share',{x:48,y:30,size:8,font,color:rgb(.35,.4,.48)});return Buffer.from(await pdf.save());}
  const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const mailHeader = value => String(value).replace(/[\r\n]/g,'');
  const emailDescription = type => type==='agreement'?'a document to sign':type==='receipt'?'a receipt':'an invoice';
  const emailAction = type => type==='agreement'?'Open and sign it':'Open it';
  function documentEmailContent(d, link) {
    const description=emailDescription(d.type), action=emailAction(d.type);
    const text=`Hi ${d.recipientName},\n\n${businessName} has sent you ${description}: ${d.title}.\n\n${action} here:\n${link}\n\nThis link is just for you and works for 30 days. No account needed.\n\nMade with PickBits File Share`;
    const html=`<p>Hi ${escapeHtml(d.recipientName)},</p><p>${escapeHtml(businessName)} has sent you ${escapeHtml(description)}: ${escapeHtml(d.title)}.</p><p>${escapeHtml(action)} here:</p><p><a href="${escapeHtml(link)}" style="display:inline-block;background:#165dff;color:#ffffff;padding:12px 18px;border-radius:6px;text-decoration:none">${escapeHtml(action)}</a></p><p>${escapeHtml(link)}</p><p>This link is just for you and works for 30 days. No account needed.</p><p>Made with PickBits File Share</p>`;
    return {subject:d.type==='agreement'?`Please sign: ${d.title}`:`Your ${d.type} from ${businessName}: ${d.title}`,text,html};
  }
  async function sendDocumentEmail(d, link) {
    const content=documentEmailContent(d,link);
    await ses.send(new SendEmailCommand({FromEmailAddress:env.MAIL_FROM,Destination:{ToAddresses:[d.recipientEmail]},ReplyToAddresses:env.MAIL_REPLY_TO?[env.MAIL_REPLY_TO]:undefined,Content:{Simple:{Subject:{Data:content.subject,Charset:'UTF-8'},Body:{Text:{Data:content.text,Charset:'UTF-8'},Html:{Data:content.html,Charset:'UTF-8'}}}}}));
  }
  const base64Lines = bytes => bytes.toString('base64').match(/.{1,76}/g)?.join('\r\n')||'';
  function completionMime(d, signed) {
    const boundary=`pickbits-file-share-${randomBytes(12).toString('hex')}`;
    const safeTitle=d.title.replace(/["\\/<>:*?|\r\n]/g,'_').slice(0,180);
    const filename=`${safeTitle} - signed.pdf`;
    return [`From: ${mailHeader(env.MAIL_FROM)}`,`To: ${d.recipientEmail}, ${mailHeader(env.MAIL_REPLY_TO)}`,`Reply-To: ${mailHeader(env.MAIL_REPLY_TO)}`,'MIME-Version: 1.0',`Subject: Signed: ${mailHeader(d.title)}`,`Content-Type: multipart/mixed; boundary="${boundary}"`,'','--'+boundary,'Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: 8bit','','Here\'s the signed copy of '+d.title+' for your records.','Made with PickBits File Share','', '--'+boundary,'Content-Type: application/pdf','Content-Transfer-Encoding: base64',`Content-Disposition: attachment; filename="${filename}"`,'',base64Lines(signed),'','--'+boundary+'--',''].join('\r\n');
  }
  async function sendCompletionEmail(d, signed) {
    if(!env.MAIL_FROM||!env.MAIL_REPLY_TO)throw new Error('Email sending is not set up yet.');
    await ses.send(new SendEmailCommand({FromEmailAddress:env.MAIL_FROM,Destination:{ToAddresses:[d.recipientEmail,env.MAIL_REPLY_TO]},ReplyToAddresses:[env.MAIL_REPLY_TO],Content:{Raw:{Data:Buffer.from(completionMime(d,signed),'utf8')}}}));
  }
  async function documentFor(user,id){if(!documentId(id))throw new AppError(404,'Document not found.');const d=await get(`DOC#${id}`,'DOC');if(!d||d.ownerId!==user.id)throw new AppError(404,'Document not found.');return d;}
  async function documentDownload(d,preview=false){const key=d.status==='completed'?d.signedKey:d.originalKey;const name=`${d.title}.pdf`;return {url:await signUrl(s3,new GetObjectCommand({Bucket:env.FILES_BUCKET,Key:key,ResponseContentDisposition:`${preview?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,ResponseContentType:'application/pdf'}),{expiresIn:60}),previewable:true,name};}
  const publicLinkError = () => new AppError(404,'This link has expired or is no longer available.');
  async function publicLink(raw){const link=await get(`DOCLINK#${hash(raw)}`,'DOCLINK');if(!link||link.expiresAt<=now())throw publicLinkError();const d=await get(`DOC#${link.docId}`,'DOC');if(!d||d.status==='void'||d.linkHash!==hash(raw))throw publicLinkError();return {link,d};}
  async function issueDocumentLink(d){const raw=token(),linkHash=hash(raw),expiresAt=now()+30*86400;const next={...d,linkHash,updatedAt:new Date().toISOString()};const items=[];if(d.linkHash)items.push({Delete:{TableName,Key:{pk:`DOCLINK#${d.linkHash}`,sk:'DOCLINK'}}});items.push({Put:{TableName,Item:{pk:`DOCLINK#${linkHash}`,sk:'DOCLINK',docId:d.id,expiresAt}}});items.push({Put:{TableName,Item:next,ConditionExpression:'attribute_exists(pk)'}});await db.send(new TransactWriteCommand({TransactItems:items}));return {doc:next,url:`${origin}/#d=${raw}`};}
  async function voidDocument(d){const next={...d,status:'void',linkHash:undefined,updatedAt:new Date().toISOString()};const items=[];if(d.linkHash)items.push({Delete:{TableName,Key:{pk:`DOCLINK#${d.linkHash}`,sk:'DOCLINK'}}});items.push({Put:{TableName,Item:next,ConditionExpression:'attribute_exists(pk)'}});await db.send(new TransactWriteCommand({TransactItems:items}));return next;}
  const publicSummary = d => ({businessName,title:d.title,type:d.type,status:d.status,recipientName:d.recipientName,ownerSignatureName:d.signatures?.find(s=>s.role==='owner')?.typedName,ownerSignatureDate:d.signatures?.find(s=>s.role==='owner')?.signedAt,completedAt:d.completedAt,viewedAt:d.viewedAt});
  async function dispatch(request){
    const url=new URL(request.url);const path=url.pathname.replace(/\/$/,'');const method=request.method;const cookies=Object.fromEntries((request.headers.get('cookie')||'').split(';').map(s=>s.trim().split('=')).filter(p=>p.length===2));
    const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
    const redirect=(to,setCookies=[])=>{const headers=new Headers({Location:to});setCookies.forEach(c=>headers.append('Set-Cookie',c));return new Response(null,{status:302,headers});};
    if(path==='/api/health')return json({ok:true});
    if(path==='/api/config'&&method==='GET')return json({businessName:config.businessName,quotas:config.quotas,demo:false});
    if(!env.TABLE_NAME||!env.USER_POOL_ID){if(path==='/api/me')return json({user:null});throw new AppError(503,'Your workspace is being connected. Please try again shortly.');}
    if(!['GET','HEAD'].includes(method)){if(request.headers.get('origin')!==origin)throw new AppError(403,'Request origin is not allowed.');if(!request.headers.get('content-type')?.startsWith('application/json'))throw new AppError(415,'Expected a JSON request.');}
    let body={};if(!['GET','HEAD'].includes(method)){const raw=await request.text();if(raw.length>(path.endsWith('/sign')?300*1024:16384))throw new AppError(413,'Request is too large.');try{body=JSON.parse(raw||'{}');}catch{throw new AppError(400,'Invalid request.');}if(!body||typeof body!=='object'||Array.isArray(body))throw new AppError(400,'Invalid request.');}
    if(path==='/api/auth/login'&&method==='GET'){
      const state=token(),verifierValue=token(),nonce=token();const share=url.searchParams.get('share');const returnTo=share&&/^[A-Za-z0-9_-]{43}$/.test(share)?`/?share=${share}`:'/';await put({pk:`OAUTH#${hash(state)}`,sk:'OAUTH',verifier:verifierValue,nonce,returnTo,expiresAt:now()+600});
      const auth=new URL(`https://${env.COGNITO_DOMAIN}/oauth2/authorize`);auth.search=new URLSearchParams({client_id:env.CLIENT_ID,response_type:'code',scope:'openid email profile',redirect_uri:`${origin}/api/auth/callback`,state,nonce,code_challenge:createHash('sha256').update(verifierValue).digest('base64url'),code_challenge_method:'S256'}).toString();return redirect(auth.toString(),[cookie(stateCookie,state,600)]);
    }
    if(path==='/api/auth/callback'&&method==='GET'){
      const state=url.searchParams.get('state'),code=url.searchParams.get('code');const cookieState=cookies[stateCookie];
      if(!state||!code||!cookieState||state.length!==cookieState.length||!timingSafeEqual(Buffer.from(state),Buffer.from(cookieState)))throw new AppError(400,'Your sign-in session expired. Please sign in again.');
      const auth=await get(`OAUTH#${hash(state)}`,'OAUTH');if(!auth||auth.expiresAt<=now())throw new AppError(400,'Your sign-in session expired.');
      await db.send(new DeleteCommand({TableName,Key:{pk:auth.pk,sk:auth.sk},ConditionExpression:'attribute_exists(pk)'}));
      const exchange=await fetch(`https://${env.COGNITO_DOMAIN}/oauth2/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:env.CLIENT_ID,redirect_uri:`${origin}/api/auth/callback`,code,code_verifier:auth.verifier})});
      if(!exchange.ok)throw new AppError(401,'Sign-in could not be completed. Please try again.');const tokens=await exchange.json();const claims=await verifier.verify(tokens.id_token);if(claims.nonce!==auth.nonce)throw new AppError(401,'Sign-in could not be verified.');
      const user={id:claims.sub,email:claims.email,name:claims.name||claims.email.split('@')[0],admin:(claims['cognito:groups']||[]).includes('owners')};const raw=token();await put({pk:`SESSION#${hash(raw)}`,sk:'SESSION',username:claims['cognito:username'],user,authenticatedAt:now(),expiresAt:now()+28800});return redirect(`${origin}${auth.returnTo||'/'}`,[cookie(cookieName,raw,28800),cookie(stateCookie,'',0)]);
    }
    const sess=await session(cookies);
    const mfaPolicy=sess?await mfa.policy(sess):null;
    if(path==='/api/me'&&method==='GET'){const {factor,...publicPolicy}=mfaPolicy||{};return json({user:sess?{...sess.user,workspace:workspaceFor(sess.user)}:null,mfa:mfaPolicy?publicPolicy:null});}
    const publicDocumentPath=path.match(/^\/api\/public\/documents\/([^/]+)(?:\/(pdf|sign))?$/);
    if(publicDocumentPath){
      const raw=publicDocumentPath[1];
      const action=publicDocumentPath[2];
      const {d}=await publicLink(raw);
      if(method==='GET'&&!action){if(!d.viewedAt){const viewedAt=new Date().toISOString();await db.send(new UpdateCommand({TableName,Key:{pk:d.pk,sk:d.sk},UpdateExpression:'SET viewedAt = if_not_exists(viewedAt, :viewedAt)',ExpressionAttributeValues:{':viewedAt':viewedAt}}));d.viewedAt=viewedAt;}return json(publicSummary(d));}
      if(method==='GET'&&action==='pdf')return json(await documentDownload(d,false));
      if(method==='POST'&&action==='sign'){
        if(d.type!=='agreement')throw new AppError(400,'Only agreements need signatures.');
        if(d.status==='completed')throw new AppError(409,'This document is already complete.');
        if(d.status!=='awaiting_signature')throw new AppError(409,'This document is not ready for recipient signature.');
        if(body.consent!==true)throw new AppError(400,'You must agree to sign electronically.');
        const typedName=typeof body.typedName==='string'?body.typedName.trim():'';if(!typedName||typedName.length>200)throw new AppError(400,'Enter your full name.');
        const signature=signatureValue(body.signature);const original=await objectBytes(d.originalKey);if(hash(original)!==d.originalHash)throw new AppError(409,'The original document has changed.');
        const signedAt=new Date().toISOString(),forwarded=(request.headers.get('cloudfront-viewer-address')?.replace(/:\d+$/,'')||(request.headers.get('x-forwarded-for')||'').split(',')[0]).trim();
        const signer={role:'recipient',email:d.recipientEmail,typedName,signature,signedAt,ip:forwarded,userAgent:(request.headers.get('user-agent')||'').slice(0,300)};
        const signatures=[...(d.signatures||[]),signer],signed=await signedPdf(original,d,signatures),signedKey=`docs/${d.id}/signed.pdf`;
        await s3.send(new PutObjectCommand({Bucket:env.FILES_BUCKET,Key:signedKey,Body:signed,ContentType:'application/pdf',CacheControl:'private, no-store'}));
        const next={...d,signatures,signedKey,signedHash:hash(signed),status:'completed',completedAt:signedAt,updatedAt:signedAt};await db.send(new PutCommand({TableName,Item:next,ConditionExpression:'#status = :awaiting',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':awaiting':'awaiting_signature'}}));let completed=next;try{await sendCompletionEmail(next,signed);}catch(error){completed={...next,completionEmailError:error.message||error.name||'Email delivery failed.'};await db.send(new PutCommand({TableName,Item:completed,ConditionExpression:'#status = :completed',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':completed':'completed'}}));console.error(JSON.stringify({event:'completion_email_failed',documentId:d.id,name:error.name||'Error'}));}return json(publicSummary(completed));
      }
    }
    if(!sess)throw new AppError(401,'Please sign in to continue.');const user=sess.user;
    if(path==='/api/auth/logout'&&method==='POST'){await del(sess.pk,sess.sk);const logout=new URL(`https://${env.COGNITO_DOMAIN}/logout`);logout.search=new URLSearchParams({client_id:env.CLIENT_ID,logout_uri:origin}).toString();const res=json({ok:true,logoutUrl:logout.toString()});res.headers.append('Set-Cookie',cookie(cookieName,'',0));return res;}
    if(path==='/api/mfa/setup'&&method==='POST')return json(await mfa.setup(sess));
    if(path==='/api/mfa/verify'&&method==='POST')return json(await mfa.verify(sess,body.code));
    if(path==='/api/mfa/disable'&&method==='POST')return json(await mfa.disable(sess,body.code));
    if(!mfaPolicy.verified)throw new AppError(403,'Verify your authenticator to access your workspace.');
    if((path==='/api/documents/upload'||path==='/api/documents/uploads')&&method==='POST'){
      if(!user.admin)throw new AppError(403,'Only the workspace owner can create documents.');const title=validateName(body.title);const type=body.type;if(!['agreement','receipt','invoice'].includes(type))throw new AppError(400,'Choose an agreement, receipt, or invoice.');const recipientName=validateName(body.recipientName);const recipientEmail=validateEmail(body.recipientEmail);if(!Number.isSafeInteger(body.size)||body.size<=0||body.size>MAX_DOCUMENT_SIZE)throw new AppError(400,'Documents must be PDFs no larger than 20 MB.');if(body.mime!=='application/pdf')throw new AppError(400,'Documents must be PDF files.');const id=crypto.randomUUID(),createdAt=new Date().toISOString(),originalKey=`docs/${id}/original.pdf`;const d={pk:`DOC#${id}`,sk:'DOC',id,title,type,ownerId:user.id,ownerEmail:user.email,recipientEmail,recipientName,originalKey,uploadSize:body.size,status:'pending',createdAt,updatedAt:createdAt,signatures:[]};await db.send(new TransactWriteCommand({TransactItems:[{Put:{TableName,Item:d,ConditionExpression:'attribute_not_exists(pk)'}},{Put:{TableName,Item:{pk:`OWNER#${user.id}`,sk:`DOC#${createdAt}#${id}`,documentId:id,createdAt},ConditionExpression:'attribute_not_exists(pk)'}}]}));try{const signed=await signPost(s3,{Bucket:env.FILES_BUCKET,Key:originalKey,Fields:{'Content-Type':'application/pdf'},Conditions:[['content-length-range',body.size,body.size],['eq','$Content-Type','application/pdf']],Expires:300});return json({id,...signed},201);}catch(e){await del(d.pk,d.sk);throw e;}
    }
    const documentComplete=path.match(/^\/api\/documents\/([a-f0-9-]{36})\/complete$/);
    if(documentComplete&&method==='POST'){
      if(!user.admin)throw new AppError(403,'Only the workspace owner can complete document uploads.');let d=await get(`DOC#${documentComplete[1]}`,'DOC');if(!d||d.ownerId!==user.id)throw new AppError(404,'Document not found.');if(d.status!=='pending')return json(documentPublic(d));let object;try{object=await s3.send(new HeadObjectCommand({Bucket:env.FILES_BUCKET,Key:d.originalKey}));}catch(e){if(e.name==='NotFound')throw new AppError(409,'The document upload has not finished. Please retry.');throw e;}if(object.ContentLength!==d.uploadSize)throw new AppError(400,'The uploaded document size does not match.');const bytes=await objectBytes(d.originalKey);if(bytes.length!==object.ContentLength||bytes.subarray(0,5).toString()!=='%PDF-'){await s3.send(new DeleteObjectCommand({Bucket:env.FILES_BUCKET,Key:d.originalKey}));throw new AppError(400,'The uploaded file is not a valid PDF.');}const time=new Date().toISOString();d={...d,status:d.type==='agreement'?'awaiting_signature':'published',originalHash:hash(bytes),size:bytes.length,updatedAt:time};await db.send(new PutCommand({TableName,Item:d,ConditionExpression:'#status = :pending',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':pending':'pending'}}));if(d.type!=='agreement'){const issued=await issueDocumentLink(d);return json({...documentPublic(issued.doc),recipientUrl:issued.url});}return json(documentPublic(d));
    }
    if(path==='/api/documents'&&method==='GET'){if(!user.admin)throw new AppError(403,'Only the workspace owner can list sent documents.');return json({documents:await documentList(`OWNER#${user.id}`)});}
    if(path==='/api/admin/documents'&&method==='GET'){if(!user.admin)throw new AppError(403,'Only the workspace owner can list sent documents.');return json({documents:await documentList(`OWNER#${user.id}`)});}
    const emailDocumentPath=path.match(/^\/api\/admin\/documents\/([a-f0-9-]{36})\/email$/);
    if(emailDocumentPath&&method==='POST'){
      if(!user.admin)throw new AppError(403,'Only the workspace owner can email documents.');
      if(!env.MAIL_FROM)throw new AppError(503,'Email sending is not set up yet.');
      const d=await documentFor(user,emailDocumentPath[1]);
      if(!['awaiting_signature','published'].includes(d.status))throw new AppError(409,'This document is not ready to email.');
      const issued=await issueDocumentLink(d);try{await sendDocumentEmail(issued.doc,issued.url);}catch(error){throw new AppError(502,'We could not send that email. Please try again.');}
      const emailedAt=new Date().toISOString(),updated={...issued.doc,emailedAt,emailCount:(d.emailCount||0)+1,updatedAt:emailedAt};await db.send(new PutCommand({TableName,Item:updated,ConditionExpression:'attribute_exists(pk)'}));return json({...documentPublic(updated),recipientUrl:issued.url});
    }
    const documentPath=path.match(/^\/api\/documents\/([a-f0-9-]{36})(?:\/(download|sign|void|relink))?$/);
    if(documentPath){const [,id,action]=documentPath;if(!user.admin)throw new AppError(403,'Only the workspace owner can access documents.');const d=await documentFor(user,id);if(action==='void'&&method==='POST')return json(documentPublic(await voidDocument(d)));
      if(action==='relink'&&method==='POST'){if(d.status==='void'||d.status==='pending'||(d.type==='agreement'&&!(d.signatures||[]).some(s=>s.role==='owner')))throw new AppError(409,'This document cannot be linked yet.');const issued=await issueDocumentLink(d);return json({document:documentPublic(issued.doc),recipientUrl:issued.url});}
      if(action==='sign'&&method==='POST'){if(d.type!=='agreement')throw new AppError(400,'Only agreements need signatures.');if(d.status==='void')throw new AppError(409,'This document has been voided.');if(d.status==='completed')throw new AppError(409,'This document is already complete.');if(d.status!=='awaiting_signature')throw new AppError(409,'The document is not ready for signing.');if(d.signatures.some(s=>s.role==='owner'))throw new AppError(409,'You have already signed this document.');if(body.consent!==true)throw new AppError(400,'You must agree to sign electronically.');const typedName=typeof body.typedName==='string'?body.typedName.trim():'';if(!typedName||typedName.length>200)throw new AppError(400,'Enter your full name.');const signature=signatureValue(body.signature);const original=await objectBytes(d.originalKey);if(hash(original)!==d.originalHash)throw new AppError(409,'The original document has changed.');const signedAt=new Date().toISOString(),forwarded=(request.headers.get('cloudfront-viewer-address')?.replace(/:\d+$/,'')||(request.headers.get('x-forwarded-for')||'').split(',')[0]).trim();const signer={role:'owner',userId:user.id,email:user.email,typedName,signature,signedAt,ip:forwarded,userAgent:(request.headers.get('user-agent')||'').slice(0,300)};const next={...d,signatures:[...d.signatures,signer],status:'awaiting_signature',updatedAt:signedAt};await db.send(new PutCommand({TableName,Item:next,ConditionExpression:'#status = :awaiting',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':awaiting':'awaiting_signature'}}));const issued=await issueDocumentLink(next);return json({...documentPublic(issued.doc),recipientUrl:issued.url});}
      if(action==='download'&&method==='GET')return json(await documentDownload(d,url.searchParams.get('preview')==='1'));
      if(!action&&method==='GET')return json(documentPublic(d));
    }
    if(path==='/api/files'&&method==='GET'){const all=(await Promise.all(ownersFor(user.id).map(list))).flat();for(const f of all.filter(f=>f.pk===`USER#${user.id}`&&f.status==='pending'&&Date.now()-Date.parse(f.createdAt)>900000).slice(0,20)){try{await cancelPending(f);await s3.send(new DeleteObjectCommand({Bucket:env.FILES_BUCKET,Key:f.stagingKey}));}catch(e){console.error(JSON.stringify({event:'cleanup_failed',name:e.name}));}}return json({files:all.filter(f=>f.status!=='pending').map(publicFile)});}
    if(path==='/api/folders'&&method==='POST'){
      const name=validateName(body.name);const parentId=body.parentId||'';await checkParent(user.id,parentId);const id=crypto.randomUUID(),time=new Date().toISOString();const f={...itemKey(user.id,id),id,name,parentId,kind:'folder',mime:'',size:0,starred:false,createdAt:time,updatedAt:time};await put(f);return json({file:publicFile(f)},201);
    }
    if(path==='/api/uploads'&&method==='POST'){
      const name=validateName(body.name);if(!Number.isSafeInteger(body.size)||body.size<0||body.size>MAX_FILE_SIZE)throw new AppError(400,`Files must be no larger than ${MAX_FILE_SIZE} bytes.`);const mime=typeof body.mime==='string'&&/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(body.mime)?body.mime:'application/octet-stream';const parentId=body.parentId||'';await checkParent(user.id,parentId);
      const id=crypto.randomUUID(),time=new Date().toISOString(),stagingKey=`staging/${user.id}/${id}`;const f={...itemKey(user.id,id),id,name,parentId,mime,size:body.size,kind:'file',starred:false,status:'pending',stagingKey,key:`files/${user.id}/${id}`,createdAt:time,updatedAt:time};
      try{await db.send(new TransactWriteCommand({TransactItems:[{Update:{TableName,Key:{pk:`USER#${user.id}`,sk:'USAGE'},UpdateExpression:'ADD bytesUsed :size',ConditionExpression:'attribute_not_exists(bytesUsed) OR bytesUsed <= :available',ExpressionAttributeValues:{':size':body.size,':available':QUOTA-body.size}}},{Put:{TableName,Item:f,ConditionExpression:'attribute_not_exists(pk)'}}]}));}catch(e){if(e.name==='TransactionCanceledException')throw new AppError(409,'Your configured storage limit has been reached.');throw e;}
      try{const signed=await signPost(s3,{Bucket:env.FILES_BUCKET,Key:stagingKey,Fields:{'Content-Type':mime},Conditions:[['content-length-range',body.size,body.size],['eq','$Content-Type',mime]],Expires:300});return json({id,...signed},201);}catch(e){await cancelPending(f);throw e;}
    }
    const complete=path.match(/^\/api\/uploads\/([a-f0-9-]{36})\/complete$/);
    if(complete&&method==='POST'){
      const f=await get(`USER#${user.id}`,`FILE#${complete[1]}`);if(!f)throw new AppError(404,'Upload not found.');if(f.status!=='pending')return json({file:publicFile(f)});await checkParent(user.id,f.parentId);
      let object;try{object=await s3.send(new HeadObjectCommand({Bucket:env.FILES_BUCKET,Key:f.stagingKey}));}catch(e){if(e.name==='NotFound')throw new AppError(409,'The upload has not finished. Please retry.');throw e;}
      if(object.ContentLength!==f.size)throw new AppError(400,'The uploaded file size does not match.');
      await s3.send(new CopyObjectCommand({Bucket:env.FILES_BUCKET,Key:f.key,CopySource:`${env.FILES_BUCKET}/${f.stagingKey}`,CopySourceIfMatch:object.ETag,MetadataDirective:'REPLACE',ContentType:f.mime,CacheControl:'private, no-store'}));
      await db.send(new UpdateCommand({TableName,Key:itemKey(user.id,f.id),UpdateExpression:'SET #status = :ready, updatedAt = :time',ConditionExpression:'#status = :pending',ExpressionAttributeNames:{'#status':'status'},ExpressionAttributeValues:{':ready':'ready',':pending':'pending',':time':new Date().toISOString()}}));await s3.send(new DeleteObjectCommand({Bucket:env.FILES_BUCKET,Key:f.stagingKey}));return json({ok:true});
    }
    const filePath=path.match(/^\/api\/files\/([a-f0-9-]{36})(?:\/(download|share))?$/);
    if(filePath){const [,id,action]=filePath;const f=await fileFor(user.id,id,method==='PATCH');
      if(action==='download'&&method==='GET'){if(f.kind!=='file')throw new AppError(400,'Select a file to download.');return json(await download(f,url.searchParams.get('preview')==='1'));}
      if(action==='share'&&['POST','DELETE'].includes(method)){
        if(f.kind!=='file')throw new AppError(400,'Share individual files.');const ops=[];if(f.shareToken)ops.push({Delete:{TableName,Key:{pk:`SHARE#${hash(f.shareToken)}`,sk:'SHARE'}}});
        let shareToken,shareExpires;if(method==='POST'){if(![1,7,30].includes(body.days))throw new AppError(400,'Choose an expiry of 1, 7, or 30 days.');shareToken=token();shareExpires=now()+body.days*86400;ops.push({Put:{TableName,Item:{pk:`SHARE#${hash(shareToken)}`,sk:'SHARE',ownerId:f.pk.slice(5),fileId:f.id,expiresAt:shareExpires}}});}
        ops.push({Update:{TableName,Key:{pk:f.pk,sk:f.sk},UpdateExpression:'SET shareToken = :token, shareExpires = :expires',ConditionExpression:'attribute_exists(pk) AND (attribute_not_exists(deletedAt) OR attribute_type(deletedAt, :nullType))',ExpressionAttributeValues:{':token':shareToken||null,':expires':shareExpires||null,':nullType':'NULL'}}});await db.send(new TransactWriteCommand({TransactItems:ops}));return json({token:shareToken||null});
      }
      if(!action&&method==='PATCH'){
        const changes=[];const names={};const values={};const set=(key,val)=>{changes.push(`#${key} = :${key}`);names[`#${key}`]=key;values[`:${key}`]=val;};
        if(body.name!==undefined)set('name',validateName(body.name));if(body.starred!==undefined){if(typeof body.starred!=='boolean')throw new AppError(400,'Invalid star value.');set('starred',body.starred);}
        if(body.parentId!==undefined){if(f.deletedAt)throw new AppError(400,'Restore this item before moving it.');if(typeof body.parentId!=='string')throw new AppError(400,'Invalid folder.');await checkParent(user.id,body.parentId,id);set('parentId',body.parentId);}
        if(body.action==='trash')set('deletedAt',new Date().toISOString());if(body.action==='restore'){await checkParent(user.id,f.parentId);set('deletedAt',null);}if(!changes.length)throw new AppError(400,'No valid changes supplied.');set('updatedAt',new Date().toISOString());await db.send(new UpdateCommand({TableName,Key:{pk:f.pk,sk:f.sk},UpdateExpression:`SET ${changes.join(', ')}`,ExpressionAttributeNames:names,ExpressionAttributeValues:values,ConditionExpression:'attribute_exists(pk)'}));return json({ok:true});
      }
    }
    const shared=path.match(/^\/api\/share\/([A-Za-z0-9_-]{43})$/);if(shared&&method==='GET'){const link=await get(`SHARE#${hash(shared[1])}`,'SHARE');if(!link||link.expiresAt<=now()||(sharedIds.includes(link.ownerId)&&!sharedIds.includes(user.id)))throw new AppError(404,'This link has expired or is unavailable to this account.');const f=await fileFor(link.ownerId,link.fileId);if(f.shareToken!==shared[1])throw new AppError(404,'This link was revoked.');return json(await download(f));}
    if(path==='/api/admin/invite'&&method==='POST'){if(!user.admin)throw new AppError(403,'Only the workspace owner can send invitations.');const email=validateEmail(body.email);try{await cognito.send(new AdminCreateUserCommand({UserPoolId:env.USER_POOL_ID,Username:email,UserAttributes:[{Name:'email',Value:email},{Name:'email_verified',Value:'true'}],DesiredDeliveryMediums:['EMAIL']}));}catch(e){if(e.name==='UsernameExistsException')throw new AppError(409,'This person already has an invitation or account.');throw e;}return json({ok:true},201);}
    throw new AppError(404,'This page could not be found.');
  }
  async function cancelPending(f){await db.send(new TransactWriteCommand({TransactItems:[{Delete:{TableName,Key:{pk:f.pk,sk:f.sk},ConditionExpression:'#s = :pending',ExpressionAttributeNames:{'#s':'status'},ExpressionAttributeValues:{':pending':'pending'}}},{Update:{TableName,Key:{pk:f.pk,sk:'USAGE'},UpdateExpression:'ADD bytesUsed :negative',ExpressionAttributeValues:{':negative':-f.size}}}]}));}
  return async request=>{let response;try{response=await dispatch(request);}catch(error){const known=error instanceof AppError;const logPath=new URL(request.url).pathname.replace(/^\/api\/public\/documents\/[^/]+/,'/api/public/documents/[token]');console.error(JSON.stringify({event:'api_error',path:logPath,status:known?error.status:500,name:error.name}));response=new Response(JSON.stringify({error:known?error.message:'We could not complete that request. Please try again.'}),{status:known?error.status:500,headers:{'Content-Type':'application/json'}});}response.headers.set('Cache-Control','no-store');response.headers.set('X-Content-Type-Options','nosniff');response.headers.set('Referrer-Policy','no-referrer');return response;};
}
