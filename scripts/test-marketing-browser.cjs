// Actual desktop/mobile Chromium smoke: marketing, interactions and original signup.
// This script runs only against a locally served built Vite bundle in CI.
// Never submits a customer signup or contacts the live Hi5Central website.
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const fs = require('node:fs')
const BASE = 'http://hi5central.com:4173'
const dir = '/tmp/hi5-marketing-screens'
fs.mkdirSync(dir, { recursive: true })
const log = (...parts) => console.log(...parts)
;(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--host-resolver-rules=MAP hi5central.com 127.0.0.1', '--no-sandbox'],
  })
  try {
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
    await desktop.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 })
    await desktop.getByRole('heading', { name: /IT works better/i }).waitFor()
    assert.equal(await desktop.locator('a[href="/signup"]').count() >= 3, true)
    const overflows = async (page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2)
    assert.equal(await overflows(desktop), false, 'Desktop horizontal scrolling detected')
    // Real captured ITSM/RMM Platform imagery, not illustrative dashboard tiles.
    const itsmShot=desktop.getByRole('img', {name:/Hi5Central ITSM incidents workspace/})
    await itsmShot.waitFor()
    assert.equal(await itsmShot.evaluate(async img=>{await img.decode();return img.naturalWidth>300}),true,'Real ITSM image missing')
    await desktop.getByRole('tab', {name: 'RMM workspace'}).click()
    const rmmShot=desktop.getByRole('img',{name:/Hi5Central RMM dashboard/})
    await rmmShot.waitFor()
    assert.equal(await rmmShot.evaluate(async img=>{await img.decode();return img.naturalWidth>300}),true,'Real RMM image missing')
    await desktop.getByRole('tab', {name: 'ITSM workspace'}).click()
    await desktop.getByRole('tab', { name: /Endpoint operations/ }).click()
    await desktop.getByRole('heading', { name: /Understand your endpoints/ }).waitFor()
    await desktop.getByRole('tab', { name: /Self-service/ }).focus()
    await desktop.keyboard.press('ArrowRight')
    assert.equal(await desktop.getByRole('tab', { name: /Connected workflows/ }).getAttribute('aria-selected'), 'true')
    await desktop.screenshot({ path: dir + '/desktop.png', fullPage: true })
    log('PASS desktop: rendered, navigation links, interactive tabs, keyboard and horizontal overflow')

    const mobile = await browser.newPage({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      isMobile: true,
      hasTouch: true,
    })
    await mobile.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 })
    await mobile.getByRole('heading', { name: /IT works better/i }).waitFor()
    assert.equal(await overflows(mobile), false, 'Mobile horizontal scrolling detected')
    const toggle = mobile.getByRole('button', { name: 'Open navigation' })
    await toggle.click()
    assert.equal(await mobile.getByRole('button', { name: 'Close navigation' }).getAttribute('aria-expanded'), 'true')
    await mobile.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Capabilities' }).click()
    assert.equal(await mobile.getByRole('button', { name: 'Open navigation' }).getAttribute('aria-expanded'), 'false')
    assert.equal(await overflows(mobile), false, 'Mobile overflow after navigation')
    await mobile.screenshot({ path: dir + '/mobile.png', fullPage: true })
    log('PASS mobile: rendered, drawer opened and closed, section navigation and overflow')

    // Critical regression contract: the dedicated existing SignupPage is
    // still used, not the older embedded legacy marketing SignupPage.
    await mobile.goto(BASE + '/signup', { waitUntil: 'networkidle', timeout: 30000 })
    await mobile.getByRole('heading', { name: /Start with the products you need/i }).waitFor()
    await mobile.getByLabel('Organisation name').waitFor()
    await mobile.getByLabel('Email', { exact: true }).waitFor()
    await mobile.getByRole('button', { name: /Create workspace/ }).waitFor()
    assert.equal(await overflows(mobile), false, 'Existing signup mobile overflow detected')
    await mobile.screenshot({ path: dir + '/signup-mobile.png', fullPage: true })
    log('PASS signup: existing form preserved on mobile without sending customer data')
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
