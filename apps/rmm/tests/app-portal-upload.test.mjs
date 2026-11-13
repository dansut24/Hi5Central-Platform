import assert from 'node:assert/strict'
import test from 'node:test'

globalThis.window = { __HI5_API_BASE__: 'https://rmm.hi5central.com' }

const { uploadAppPortalPackage } = await import('../src/lib/rmmAppPortalApi.js')

class FakeXHR {
  constructor() { this.upload = {}; this.headers = {}; FakeXHR.latest = this }
  open(method, url) { this.method = method; this.url = url }
  setRequestHeader(k, v) { this.headers[k.toLowerCase()] = v }
  send(file) {
    this.file = file
    queueMicrotask(() => {
      if (FakeXHR.networkFailure) return this.onerror()
      this.upload.onprogress?.({ lengthComputable: true, loaded: file.size / 2, total: file.size })
      this.status = FakeXHR.status
      this.responseText = FakeXHR.body
      this.onload()
    })
  }
}

test('uploads installer with credentialed binary request and progress', async () => {
  globalThis.XMLHttpRequest = FakeXHR
  FakeXHR.status = 200
  FakeXHR.body = JSON.stringify({ success: true, byteSize: 4096, sha256: 'abcdef' })
  FakeXHR.networkFailure = false
  const updates = []
  const result = await uploadAppPortalPackage('draft-id', { name: 'app.msi', size: 4096 }, n => updates.push(n))
  assert.equal(result.byteSize, 4096)
  assert.equal(FakeXHR.latest.method, 'PUT')
  assert.equal(FakeXHR.latest.url, 'https://rmm.hi5central.com/api/v1/rmm/app-portal/revisions/draft-id/package')
  assert.equal(FakeXHR.latest.withCredentials, true)
  assert.equal(FakeXHR.latest.headers['x-hi5-filename'], 'app.msi')
  assert.deepEqual(updates, [50,100])
})

test('shows the exact server reason and status for a rejected installer', async () => {
  globalThis.XMLHttpRequest = FakeXHR
  FakeXHR.status = 400
  FakeXHR.body = JSON.stringify({ error: 'Uploaded filename must end in .msi.' })
  await assert.rejects(
    uploadAppPortalPackage('draft-id', { name:'app.exe', size:100 }),
    /Uploaded filename must end in \.msi\./)
})

test('rejects ZIP and empty files before transfer', async () => {
  await assert.rejects(uploadAppPortalPackage('id', { name:'app.zip', size:512 }), /MSI or EXE/)
  await assert.rejects(uploadAppPortalPackage('id', { name:'app.msi', size:0 }), /empty/)
})

test('distinguishes a network failure from a server rejection', async () => {
  globalThis.XMLHttpRequest = FakeXHR
  FakeXHR.networkFailure = true
  await assert.rejects(uploadAppPortalPackage('id', { name:'app.msi', size:500 }), /could not reach Hi5Central/)
  FakeXHR.networkFailure = false
})
