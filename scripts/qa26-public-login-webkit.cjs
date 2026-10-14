const assert=require('node:assert/strict')
const {webkit}=require('./qa-mobile-playwright/node_modules/playwright')
const urls=[
 'https://h5c-managed-qa26.hi5central.com/login',
 'https://h5c-custom-qa26.hi5central.com/login',
 'https://h5c-managed-qa26-admin.hi5central.com/login',
 'https://h5c-custom-qa26-admin.hi5central.com/login',
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
    assert(metrics.scrollHeight>metrics.height+40,'Login content does not overflow '+url+' '+JSON.stringify(metrics))
    assert.equal(metrics.htmlOverflow,'auto','Document not scrollable in mobile Safari '+url)
    assert(metrics.rootOverflow.includes('visible'),'React root still locked '+url)
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight))
    await page.waitForTimeout(140)
    let result=await page.evaluate(()=>({scroll:scrollY,height:innerHeight,
      cardBottom:document.querySelector('.production-auth-card')?.getBoundingClientRect().bottom}))
    assert(result.scroll>30,'Safari did not scroll at '+url+' '+JSON.stringify(result))
    assert(result.cardBottom<=result.height+6,'Bottom of login card is not reachable '+url+' '+JSON.stringify(result))
    await page.setViewportSize({width:390,height:395})
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight))
    await page.waitForTimeout(120)
    result=await page.evaluate(()=>({scroll:scrollY,height:innerHeight,
      cardBottom:document.querySelector('.production-auth-card')?.getBoundingClientRect().bottom}))
    assert(result.cardBottom<=result.height+6,'Keyboard-size viewport cuts off login '+url+' '+JSON.stringify(result))
    console.log('PASS live QA26 WebKit mobile scroll + keyboard-size viewport '+url)
   }finally{await page.close()}
  }
 }finally{await browser.close()}
})().catch(e=>{console.error(e.stack);process.exit(1)})
