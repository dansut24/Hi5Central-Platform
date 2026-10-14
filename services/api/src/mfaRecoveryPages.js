// Self-contained central account-recovery UI. No external scripts, trackers or QR URLs.
const css=[
'*{box-sizing:border-box}body{margin:0;min-height:100dvh;background:linear-gradient(135deg,#0d2549,#0d425e);color:#183252;display:grid;place-items:center;font:15px/1.55 system-ui,sans-serif;padding:20px}',
'main{width:min(100%,490px);background:white;padding:30px;border-radius:22px;box-shadow:0 24px 66px #030a1c55}',
'h1{font-size:25px;line-height:1.22;margin:3px 0 10px;color:#112c4e}p{color:#596880}',
'.logo{font-size:20px;font-weight:800;color:#088fb3}.eyebrow{font-size:12px;font-weight:750;letter-spacing:.08em;color:#088caa;text-transform:uppercase;margin-top:20px}',
'label{display:block;font-weight:650;margin-top:17px}input{display:block;width:100%;min-height:45px;margin-top:6px;border:1px solid #afc0d1;border-radius:10px;padding:10px 13px;font:inherit}',
'button{width:100%;padding:13px 15px;border:0;border-radius:10px;background:#123c7e;color:white;font:inherit;font-weight:750;cursor:pointer;margin-top:23px}',
'button:disabled{opacity:.55;cursor:wait}#status{margin-top:18px;border-radius:10px;padding:12px;background:#f1f6fb;color:#315373;display:none}',
'a{color:#147ba5}footer{font-size:12px;color:#69798b;margin-top:18px}.success{color:#155d43!important;background:#e8f8f1!important}.warning{color:#8b3240!important;background:#fff1f3!important}'
].join('');
const commonJs=[
'const form=document.getElementById("recovery"),status=document.getElementById("status"),submit=document.getElementById("submit");',
'function notice(message,ok){status.style.display="block";status.className=ok?"success":"warning";status.textContent=message}',
'async function send(path,payload){submit.disabled=true;try{const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),credentials:"omit",cache:"no-store"});const j=await r.json().catch(()=>({}));return{r,j}}finally{submit.disabled=false}}'
].join('\n');
function shell(title,description,fields,js) {
 return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+' · Hi5Central</title><style>'+css+'</style></head><body><main><div class="logo">Hi5Central</div><div class="eyebrow">Account recovery</div><h1>'+title+'</h1><p>'+description+'</p><form id="recovery">'+fields+'<button id="submit" type="submit">Continue securely</button></form><div id="status" role="status" aria-live="polite"></div><footer>Multi-factor authentication remains required. Never share your password or a recovery link with anyone.</footer></main><script>'+commonJs+'\n'+js+'</script></body></html>';
}
export const mfaRecoveryStartHtml=shell('Recover your authenticator',
 'To replace a lost authenticator, enter your verified login email and current password. We will send a single-use recovery link to your registered inbox.',
 '<label>Email address<input name="email" type="email" autocomplete="username" required maxlength="254"></label><label>Current password<input name="password" type="password" autocomplete="current-password" required></label>',
 'form.addEventListener("submit",async e=>{e.preventDefault();const email=form.elements.email.value.trim(),password=form.elements.password.value;try{await send("/api/v1/auth/mfa-recovery/request",{email,password});form.elements.password.value="";notice("If the details match the active pilot account, a recovery email will arrive shortly. Check the spam folder if necessary.",true)}catch{notice("Recovery is temporarily unavailable. Please try again.",false)}})'
);
export const mfaRecoveryConfirmHtml=shell('Confirm authenticator replacement',
 'Enter your current password again to confirm the single-use link. Your old authenticator and current sessions will then be invalidated. You must sign in and scan a new QR code.',
 '<label>Current password<input name="password" type="password" autocomplete="current-password" required></label>',
 [
 'const token=new URLSearchParams(location.hash.slice(1)).get("token")||"";',
 'history.replaceState({}, "", location.pathname);',
 'if(!/^[a-zA-Z0-9_-]{35,100}$/.test(token)){form.style.display="none";notice("This recovery link is invalid or incomplete.",false)}',
 'form.addEventListener("submit",async e=>{e.preventDefault();try{const {r,j}=await send("/api/v1/auth/mfa-recovery/complete",{token,password:form.elements.password.value});form.elements.password.value="";if(!r.ok){notice(j.error||"This link has expired or could not be verified.",false);return}form.style.display="none";notice("Authenticator reset confirmed. Your old authenticator and sessions are invalid. Sign in again to enrol your new authenticator.",true);const a=document.createElement("a");a.href="https://testing-test.hi5central.com/login";a.textContent="Return to Test sign-in";a.style.display="block";a.style.marginTop="16px";status.appendChild(a)}catch{notice("Recovery is temporarily unavailable. Please try again.",false)}})'
 ].join('\n')
);
