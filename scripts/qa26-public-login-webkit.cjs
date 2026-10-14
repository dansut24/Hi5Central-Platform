const assert=require('node:assert/strict')
const {webkit}=require('./qa-mobile-playwright/node_modules/playwright')
// QA26 customer-facing scope: exactly two tenant hostnames.
// Legacy -admin subdomains are not part of the target two-host acceptance gate.
// Account admin must be tested on the same tenant origin once that route exists.
const urls=[
 'https://h5c-managed-qa26.hi5central.com/login',
 'https://h5c-custom-qa26.hi5central.com/login',
]
;(async()=>{
 const browser=await webkit.launch({headless:true})
 try{
  for(const url of urls){
   const page=await browser.newPage({viewport:{width:390,height:690},isMobile:true,hasTouch:true,deviceScaleFactor:2})
   try{
    const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:35000})
    assert.equal(response?.status(),200,'Login page must load: '+url)
    await page.locator('.production-auth-shell').waitFor({state:'visible',timeout:30000})
    await page.locator('.production-auth-card input[type="email"]').waitFor({state:'visible',timeout:15000})
    await page.waitForTimeout(350)
    let metrics=await page.evaluate(()=>{
     const doc=document.documentElement,card=document.querySelector('.production-auth-card')
     const style=Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(x=>x.href)
     return {height:innerHeight,scrollHeight:doc.scrollHeight,htmlOverflow:getComputedStyle(doc).overflowY,
       rootOverflow:getComputedStyle(document.getElementById('root')).overflow,
       cardBottom:card?.getBoundingClientRect().bottom,
       css:style,
     }
    })
    assert(metrics.css.some(x=>x.includes('index-authscroll-8df4f783aca1.css')),
     'Canonical QA CSS not served at '+url+' '+JSON.stringify(metrics))
    assert.equal(metrics.htmlOverflow,'auto','Document not scrollable in mobile Safari '+url)
    assert(metrics.rootOverflow.includes('visible'),'React root still locked '+url)
    const verifyReachable=async(label)=>{
      const before=await page.evaluate(()=>({
        height:innerHeight,scrollHeight:document.documentElement.scrollHeight,
      }))
      await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight))
      await page.waitForTimeout(150)
      const result=await page.evaluate(()=>({
        scroll:scrollY,height:innerHeight,cardBottom:document.querySelector('.production-auth-card')?.getBoundingClientRect().bottom,
        htmlOverflow:getComputedStyle(document.documentElement).overflowY,
      }))
      if(before.scrollHeight>before.height+10)
        assert(result.scroll>10,'Safari could not scroll overflowing '+label+' '+url+' '+JSON.stringify({before,result}))
      assert(result.cardBottom<=result.height+6,
        'Login form bottom is not reachable in '+label+' '+url+' '+JSON.stringify({before,result}))
      assert.equal(result.htmlOverflow,'auto','Document scrolling unexpectedly locked in '+label+' '+url)
    }
    await verifyReachable('portrait viewport')
    await page.setViewportSize({width:390,height:395})
    await verifyReachable('keyboard-size viewport')
    console.log('PASS live QA26 WebKit mobile scroll + keyboard-size viewport '+url)
   }finally{await page.close()}
  }
 }finally{await browser.close()}
})().catch(e=>{console.error(e.stack);process.exit(1)})
