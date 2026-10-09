// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { useState } from "react";
import QRCode from "qrcode";
import { ArrowLeft, Check, Copy, Loader2, ShieldCheck } from "lucide-react";
import { api, type User } from "@/lib/files";

export type MfaPolicy = { required:boolean; verified:boolean; enabled:boolean; ownerRequired:boolean; needsSignIn:boolean };
export default function Security({user,policy}:{user:User;policy:MfaPolicy}){
  const [setup,setSetup]=useState<{secret:string;qr:string}|null>(null);
  const [code,setCode]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [disabling,setDisabling]=useState(false);
  const pending=policy.required&&!policy.verified;
  async function begin(){setBusy(true);setError("");try{const d=await api<{secret:string;uri:string}>("/mfa/setup",{method:"POST",body:"{}"});setSetup({secret:d.secret,qr:await QRCode.toDataURL(d.uri,{width:230,margin:2,errorCorrectionLevel:"M"})});}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function verify(){setBusy(true);setError("");try{await api(disabling?"/mfa/disable":"/mfa/verify",{method:"POST",body:JSON.stringify({code})});if(new URLSearchParams(location.search).has("security"))location.assign("/");else location.reload();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <div className="login-page"><header className="login-top"><a href="/" className="brand"><img src="/favicon.svg" alt=""/>PickBits File Share</a><span className="private-badge"><ShieldCheck size={15}/>Account security</span></header><main className="login-card" style={{margin:"32px auto",maxWidth:490}}><div className="login-icon"><ShieldCheck/></div><h1>{pending?(policy.enabled?"Verify your sign-in":"Protect your account"):"Your account security"}</h1><p className="mb-4">{user.email}</p><p>{policy.ownerRequired?"An authenticator is required for this account before you can access files or invite people.":policy.enabled?"Your authenticator is enabled. You’ll enter a code when you sign in.":"An authenticator is optional for your account. You can use your password alone or add an extra sign-in step."}</p>
    {error&&<div className="error-banner mt-4" role="alert">{error}</div>}
    {policy.needsSignIn?<><p className="notice mt-5">Sign in again to manage your authenticator securely.</p><a href="/api/auth/login" className="btn btn-primary">Continue to sign in</a></>:<>
      {!policy.enabled&&!setup&&<button className="btn btn-primary" onClick={begin} disabled={busy}>{busy?<Loader2 className="loading-spinner"/>:<ShieldCheck/>}Set up authenticator</button>}
      {setup&&<div className="mt-5"><p>Scan this code in your authenticator app.</p><img src={setup.qr} alt="Authenticator setup QR code" className="mx-auto my-3" width={230} height={230}/><details className="text-left text-sm"><summary className="cursor-pointer text-slate-600">Enter a setup key instead</summary><div className="mt-3 break-all rounded-lg border bg-slate-50 p-3 font-mono text-xs">{setup.secret}</div><button className="mt-2 inline-flex items-center gap-2 text-blue-600" onClick={()=>navigator.clipboard.writeText(setup.secret).catch(()=>setError("Select and copy the setup key above."))}><Copy size={14}/>Copy key</button></details></div>}
      {(setup||(pending&&policy.enabled)||disabling)&&<form className="mt-5 text-left" onSubmit={e=>{e.preventDefault();verify();}}><label className="field-label" htmlFor="auth-code">{disabling?"Enter a new code to turn off your authenticator":"Code from your authenticator"}</label><input id="auth-code" value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" required className="text-input text-center tracking-[0.45em]" placeholder="000000" autoFocus/><button className={`btn ${disabling?"btn-secondary":"btn-primary"}`} disabled={busy||code.length!==6}>{busy?<Loader2 className="loading-spinner"/>:<Check/>}{disabling?"Turn off authenticator":"Verify and continue"}</button></form>}
      {policy.enabled&&policy.verified&&!policy.ownerRequired&&!disabling&&<button className="btn btn-secondary" onClick={()=>setDisabling(true)}>Turn off authenticator</button>}
      {policy.enabled&&policy.verified&&policy.ownerRequired&&<p className="notice mt-5"><Check className="inline mr-2" size={16}/>Your required authenticator is enabled.</p>}
    </>}
    {!pending&&<a href="/" className="mt-6 inline-flex items-center gap-2 text-sm text-slate-600"><ArrowLeft size={15}/>{!policy.enabled?"Continue without authenticator":"Back to files"}</a>}
    <button className="mt-5 block w-full text-sm text-slate-500" onClick={async()=>{try{const d=await api<{logoutUrl:string}>("/auth/logout",{method:"POST",body:"{}"});location.assign(d.logoutUrl);}catch(e){setError((e as Error).message);}}}>Sign out</button>
  </main><footer className="login-footer">Your files. Your people. Your space.</footer></div>;
}
