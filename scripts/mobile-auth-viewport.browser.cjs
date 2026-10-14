const assert = require('node:assert/strict')
const fs=require('node:fs')
const {webkit}=require('./qa-mobile-playwright/node_modules/playwright')
const css=fs.readFileSync('scripts/mobile-auth-viewport.canonical.css','utf8')
const baseline='html,body,#root{height:100%;width:100%;overflow:hidden}body{margin:0;background:#edf3fb}*{box-sizing:border-box}'
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const fixture=(mode)=>`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${baseline}</style><style>${css}</style></head><body><div id="root">
<main ${mode==='future'?'data-hi5-auth-screen="true"':'class="production-auth-shell"'}>
<div class="production-auth-layout" style="max-width:650px;display:grid;gap:22px;padding:0">
<section class="production-auth-copy" style="min-height:470px;display:grid;align-content:start;gap:18px"><div>Hi5Central Secure Tenant Sign-in</div>
<h1 style="font-size:48px;line-height:1.08">Welcome back to Hi5Central Managed QA</h1>
<p style="font-size:22px">Enter your email address and Hi5Central will use your organisation sign-in method</p>
<p style="font-size:22px">Tenant-isolated session</p><p style="font-size:22px">HttpOnly secure cookie</p></section>
<form class="production-auth-card" style="display:grid;gap:18px;padding:22px;background:white;border-radius:18px;border:1px solid #dce4ee">
<strong>Sign in</strong><label>Email<input id="email" type="email" value="test@example.invalid" style="display:block;width:100%;height:52px"/></label>
<label>Password<input id="password" type="password" style="display:block;width:100%;height:52px"/></label>
<button type="button" style="height:54px">Sign in</button>
<button id="last" type="button" style="height:54px">Forgotten password</button>
<a id="footer" href="#help">Get sign-in help</a></form></div></main></div></body></html>`
;(async()=>{
const browser=await webkit.launch({headless:true})
try{
for(const width of [390,360]){
const page=await browser.newPage({viewport:{width,height:620},isMobile:true,hasTouch:true,deviceScaleFactor:2})
for(const mode of ['current','future']){
 await page.setContent(fixture(mode))
 const before=await page.evaluate(()=>({
  doc:document.documentElement.scrollHeight,visible:innerHeight,
  overflow: getComputedStyle(document.documentElement).overflowY,
  root: getComputedStyle(document.getElementById('root')).overflow
 }))
 assert(before.doc>before.visible+300,mode+' should overflow mobile viewport: '+JSON.stringify(before))
 assert(before.overflow==='auto',mode+' must make the document scrollable')
 assert(before.root.includes('visible'),mode+' must release the locked React root')
 await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight))
 await sleep(60)
 let end=await page.evaluate(()=>({scroll:window.scrollY,footer:document.querySelector('#footer').getBoundingClientRect().bottom,height:innerHeight}))
 assert(end.scroll>100,mode+' cannot scroll on Safari at '+width+': '+JSON.stringify(end))
 assert(end.footer<=end.height+2,mode+' footer unreachable: '+JSON.stringify(end))
 await page.setViewportSize({width,height:380}) // virtual-keyboard-sized visual viewport
 await page.locator('#password').focus()
 await page.locator('#last').scrollIntoViewIfNeeded()
 const keyboard=await page.evaluate(()=>({scroll:window.scrollY,last:document.querySelector('#last').getBoundingClientRect().bottom,height:innerHeight}))
 assert(keyboard.last<=keyboard.height+2,mode+' keyboard-sized viewport hides submit/help actions '+JSON.stringify(keyboard))
 console.log('PASS WebKit mobile '+width+' / '+mode+' / keyboard-height scroll')
}
await page.setContent('<html><head><style>'+baseline+'</style><style>'+css+'</style></head><body><div id="root"><div class="app-shell">Authenticated workspace</div></div></body></html>')
const signedIn=await page.evaluate(()=>({html:getComputedStyle(document.documentElement).overflowY,root:getComputedStyle(document.getElementById('root')).overflow}))
assert.equal(signedIn.html,'hidden','Signed-in workspaces must retain scroll lock')
assert.equal(signedIn.root,'hidden','Signed-in root must remain locked')
await page.close()
}
console.log('PASS all WebKit mobile auth viewport / signed-in shell checks')
}finally{await browser.close()}
})().catch(e=>{console.error(e.stack);process.exit(1)})
