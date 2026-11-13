import { useEffect, useState } from 'react'
import { CheckCircle2, ChevronRight, Globe2, PackagePlus, Pencil, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react'
import {
  assignAppPortalApp,
  createAppPortalApp,
  createAppPortalRevision,
  decideAppPortalRequest,
  loadAppPortal,
  publishAppPortalRevision,
  removeAppPortalAssignment,
  uploadAppPortalPackage,
  uploadAppPortalLogo,
  updateAppPortalDraft,
} from '../../lib/rmmAppPortalApi.js'
import { emptyCustom, formFromDraft, customRevisionPayload, revisionFingerprint, draftHasUploadedPackage, inventoryDisplayName } from '../../lib/appPortalDraft.js'
import './RmmAppPortal.css'

const emptyAssignment = { appId: '', scopeType: 'Estate', scopeId: '*', scopeName: 'Entire estate', intent: 'available', priority: 0 }

function stateLabel(app) {
  if (app.status !== 'published') return 'Draft'
  if (app.publish_state !== 'published') return 'Revision pending'
  return 'Published'
}

export function RmmAppPortal() {
  const [bundle, setBundle] = useState({ apps: [], revisions: [], assignments: [], requests: [], catalogue: [] })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [catalogueId, setCatalogueId] = useState('')
  const [custom, setCustom] = useState(emptyCustom)
  const [uploadFile, setUploadFile] = useState(null)
  const [logoFile, setLogoFile] = useState(null)
  const [editingDraft, setEditingDraft] = useState(null)
  const [assignment, setAssignment] = useState(emptyAssignment)

  const refresh = async () => {
    setError('')
    try { setBundle(await loadAppPortal()) } catch (err) { setError(err.message) }
  }
  useEffect(() => { refresh() }, [])

  const run = async (action, successMessage) => {
    setBusy(true); setError(''); setMessage('')
    try {
      await action()
      setMessage(successMessage)
      await refresh()
    } catch (err) {
      // A failed package upload still creates a resumable server-side draft.
      // Refresh the visible list without hiding the real error from the user.
      try { setBundle(await loadAppPortal()) } catch {}
      setError(err.data?.errors?.join(' ') || err.message)
    } finally { setBusy(false) }
  }
  const addCatalogue = () => {
    const item = (bundle.catalogue || []).find((row) => row.id === catalogueId)
    if (!item) return setError('Choose a qualified catalogue application.')
    run(async () => {
      const created = await createAppPortalApp({ sourceType: 'catalogue', catalogueId, name: item.canonical_name })
      const appId = created.app.id
      const fresh = await loadAppPortal()
      const revision = fresh.revisions.find((row) => row.app_id === appId)
      if (!revision) throw new Error('The catalogue revision was not created.')
      await publishAppPortalRevision(revision.id)
      setCatalogueId('')
    }, item.canonical_name + ' published to App Portal.')
  }

  const editExistingDraft = (app) => {
    const revision = bundle.revisions.find((row) => row.id === app.current_revision_id
      && row.app_id === app.id && row.publish_state === 'draft')
      || bundle.revisions.find((row) => row.app_id === app.id && row.publish_state === 'draft')
    const form = formFromDraft(app, revision)
    setCustom(form)
    setUploadFile(null)
    setLogoFile(null)
    setEditingDraft({
      appId: app.id,
      revisionId: revision?.id || null,
      fingerprint: revision ? revisionFingerprint(form) : null,
      hasPackage: draftHasUploadedPackage(revision),
    })
    setError('')
    setMessage('Editing ' + app.name + '. Changes to installer settings save as a new revision of this application, not a duplicate app.')
    document.getElementById('app-portal-custom-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const cancelEditing = () => {
    setEditingDraft(null)
    setCustom(emptyCustom)
    setUploadFile(null)
    setLogoFile(null)
    setError('')
    setMessage('')
  }

  const saveCustom = (publish = false) => {
    if (!custom.name.trim()) return setError('Enter an application name.')
    if (publish && !String(custom.expectedSigner || custom.publisher || '').trim()) {
      return setError('Provide the Publisher or the installer signing name under Advanced options.')
    }
    if (logoFile && (logoFile.type !== 'image/png' || logoFile.size > 512 * 1024)) {
      return setError('Choose a PNG logo smaller than 512 KB.')
    }
    const payload = customRevisionPayload(custom)
    // Never overwrite a previously uploaded package while it is still the
    // package recorded for a draft. A replacement upload gets a new revision
    // in the SAME app, preserving the old file if the new transfer fails.
    const replacingPackage = Boolean(editingDraft?.hasPackage && uploadFile && custom.sourceKind === 'upload')
    const unchanged = Boolean(!replacingPackage && editingDraft?.revisionId && editingDraft.fingerprint === revisionFingerprint(custom))
    const packageAlreadyStored = unchanged && editingDraft?.hasPackage && custom.sourceKind === 'upload'
    if (publish && custom.sourceKind === 'upload' && !uploadFile && !packageAlreadyStored) {
      return setError('Choose an MSI or EXE package before publishing this draft.')
    }
    // A draft may be saved before the installer is ready. Publishing still
    // requires the signed/hash-pinned installer and server-side validation.
    run(async () => {
      let appId = editingDraft?.appId
      let revisionId = unchanged ? editingDraft.revisionId : null
      if (!appId) {
        const created = await createAppPortalApp({
          sourceType: 'custom', name: custom.name, publisher: custom.publisher,
          description: custom.description, category: custom.category,
        })
        appId = created.app.id
        setEditingDraft({ appId, revisionId: null, fingerprint: null, hasPackage: false })
      } else {
        await updateAppPortalDraft(appId, {
          name: custom.name, publisher: custom.publisher,
          description: custom.description, category: custom.category,
        })
      }
      if (logoFile) {
        await uploadAppPortalLogo(appId, logoFile)
        setLogoFile(null)
      }
      if (!revisionId) {
        const createdRevision = await createAppPortalRevision(appId, payload)
        revisionId = createdRevision.revision.id
      }
      // Persist the app/revision IDs BEFORE the network upload so a failed
      // attempt can be retried without making another application/revision.
      setEditingDraft({
        appId, revisionId, fingerprint: revisionFingerprint(custom),
        hasPackage: Boolean(packageAlreadyStored),
      })
      if (custom.sourceKind === 'upload' && uploadFile) {
        await uploadAppPortalPackage(revisionId, uploadFile)
        setUploadFile(null)
        setEditingDraft({
          appId, revisionId, fingerprint: revisionFingerprint(custom), hasPackage: true,
        })
      }
      if (publish) {
        await publishAppPortalRevision(revisionId)
        setCustom(emptyCustom)
        setEditingDraft(null)
        setLogoFile(null)
      }
    }, publish ? custom.name + ' published to App Portal.' : custom.name + ' draft saved. You can resume it later.')
  }

  const replaceLogo = (app, file) => {
    if (!file) return
    if (file.type !== 'image/png' || file.size > 512 * 1024) {
      return setError('Choose a PNG logo smaller than 512 KB.')
    }
    run(() => uploadAppPortalLogo(app.id, file), app.name + ' logo updated.')
  }

  const addAssignment = () => {
    if (!assignment.appId) return setError('Choose an application to assign.')
    const payload = {
      ...assignment,
      scopeId: assignment.scopeType === 'Estate' ? '*' : assignment.scopeId,
      scopeName: assignment.scopeType === 'Estate' ? 'Entire estate' : assignment.scopeName,
      priority: Number(assignment.priority || 0),
    }
    if (payload.scopeType !== 'Estate' && !payload.scopeId.trim()) return setError('Enter the scope identifier.')
    run(() => assignAppPortalApp(assignment.appId, payload), 'Assignment saved.')
  }

  return <div className="app-portal-admin">
    <header className="app-portal-hero">
      <div><span className="rmm-eyebrow">Self-service software</span><h2>App Portal</h2>
        <p>Publish approved software to end users. The desktop portal remains unprivileged; Agent and PatchHost perform verified installs.</p></div>
      <button className="rmm-secondary" type="button" onClick={refresh} disabled={busy}><RefreshCw size={15} /> Refresh</button>
    </header>
    {(message || error) && <div className={'app-portal-notice ' + (error ? 'error' : 'success')}>
      {error || message}
    </div>}
    <section className="app-portal-stats">
      <article><strong>{bundle.apps.length}</strong><span>Portal applications</span></article>
      <article><strong>{bundle.apps.filter((app) => app.status === 'published').length}</strong><span>Published</span></article>
      <article><strong>{bundle.assignments.length}</strong><span>Assignments</span></article>
      <article><strong>{bundle.requests.filter((request) => request.status === 'pending').length}</strong><span>Approval requests</span></article>
    </section>

    <div className="app-portal-grid">
      <section className="app-portal-card app-portal-wide">
        <div className="app-portal-card-title"><div><h3>Published applications</h3><p>Immutable revisions with server-side assignment enforcement.</p></div></div>
        <div className="app-portal-app-list">
          {bundle.apps.map((app) => <article className="app-portal-app-row" key={app.id}>
            <span className="app-portal-app-icon"><PackagePlus size={19} /></span>
            <span className="app-portal-app-main"><strong>{app.name}</strong>
              <small>{app.publisher || 'Company application'} · {app.source_type === 'catalogue' ? 'Hi5Central catalogue' : 'Custom'} · v{app.version || 'draft'}</small></span>
            <span className={'app-portal-state ' + (app.status === 'published' ? 'good' : '')}>{stateLabel(app)}</span>
            <span className="app-portal-count">{bundle.assignments.filter((row) => row.app_id === app.id).length} assignments</span>
            {app.source_type === 'custom' && app.publish_state === 'draft' &&
              <button className="app-portal-edit-action" type="button" disabled={busy}
                aria-label={'Edit draft ' + app.name} onClick={() => editExistingDraft(app)}><Pencil size={14} /> Edit draft</button>}
          </article>)}
          {!bundle.apps.length && <div className="app-portal-empty">No applications have been published yet.</div>}
        </div>
      </section>

      <section className="app-portal-card">
        <div className="app-portal-card-title"><div><h3>Publish from catalogue</h3><p>Only qualified catalogue entries are offered.</p></div><ShieldCheck size={20} /></div>
        <label>Application<select value={catalogueId} onChange={(e) => setCatalogueId(e.target.value)}>
          <option value="">Choose software…</option>
          {bundle.catalogue.map((item) => <option key={item.id} value={item.id}>{item.canonical_name} · {item.target_version}</option>)}
        </select></label>
        <button className="rmm-primary" disabled={busy || !catalogueId} onClick={addCatalogue} type="button"><PackagePlus size={15} /> Publish application</button>
      </section>

      <section className="app-portal-card app-portal-custom" id="app-portal-custom-form">
        <div className="app-portal-card-title"><div>
          <h3>{editingDraft ? 'Edit existing draft' : 'Custom application'}</h3>
          <p>{editingDraft ? 'Resume the saved draft. A changed installer configuration creates a new revision of the same application.' : 'Direct HTTPS source with pinned hash, signer and independent detection.'}</p>
        </div>{editingDraft
          ? <button className="app-portal-edit-action" type="button" onClick={cancelEditing} disabled={busy}><X size={14} /> Cancel</button>
          : <Globe2 size={20} />}</div>
        {editingDraft && <p className="app-portal-draft-hint">Editing an existing application. Its name, publisher, category and description are retained. Installer options can be changed; a replacement package is required when creating a new upload revision.</p>}
        <div className="app-portal-form-grid">
          <label>Name<input value={custom.name} disabled={Boolean(editingDraft)} onChange={(e) => setCustom({ ...custom, name: e.target.value })} /></label>
          <label>Publisher<input value={custom.publisher} disabled={Boolean(editingDraft)} onChange={(e) => setCustom({ ...custom, publisher: e.target.value })} /></label>
          <label>Version<input value={custom.version} onChange={(e) => setCustom({ ...custom, version: e.target.value })} /></label>
          <label>Installer<select value={custom.installerType} onChange={(e) => { setCustom({ ...custom, installerType: e.target.value }); setUploadFile(null) }}><option value="msi">MSI</option><option value="exe">EXE</option></select></label>
        </div>
        <label>Description<textarea rows="3" value={custom.description} disabled={Boolean(editingDraft)} onChange={(e) => setCustom({ ...custom, description: e.target.value })} /></label>
        <div className="app-portal-form-grid">
          <label>Package source<select value={custom.sourceKind} onChange={(e) => { setCustom({ ...custom, sourceKind: e.target.value }); setUploadFile(null) }}>
            <option value="direct_url">Direct HTTPS URL</option><option value="upload">Private upload</option>
          </select></label>
          <label>Category<input value={custom.category} disabled={Boolean(editingDraft)} onChange={(e) => setCustom({ ...custom, category: e.target.value })} /></label>
        </div>
        {custom.sourceKind === 'direct_url'
          ? <>
              <label>Direct download URL<input placeholder="https://vendor.example/app.msi" value={custom.url} onChange={(e) => setCustom({ ...custom, url: e.target.value })} /></label>
              <label>SHA-256<input placeholder="64-character hash" value={custom.sha256} onChange={(e) => setCustom({ ...custom, sha256: e.target.value })} /></label>
            </>
          : <label>Installer package<input type="file" accept={custom.installerType === 'msi' ? '.msi' : '.exe'} onChange={(e) => setUploadFile(e.target.files?.[0] || null)} />
              <small>{uploadFile ? uploadFile.name + ' · ' + Math.ceil(uploadFile.size / 1024 / 1024) + ' MB' : 'Stored privately by Hi5Central. SHA-256 is calculated server-side.'}</small>
            </label>}
        <label>Expected Authenticode signer<input value={custom.expectedSigner} onChange={(e) => setCustom({ ...custom, expectedSigner: e.target.value })} /></label>
        <div className="app-portal-form-grid">
          <label>Execution<select value={custom.executionMode} onChange={(e) => setCustom({ ...custom, executionMode: e.target.value })}>
            <option value="arguments">Installer arguments</option><option value="powershell">PowerShell script</option><option value="batch">Batch script</option>
          </select></label>
          <label>Timeout (seconds)<input type="number" min="30" max="3600" value={custom.timeoutSeconds} onChange={(e) => setCustom({ ...custom, timeoutSeconds: e.target.value })} /></label>
        </div>
        {custom.executionMode === 'arguments'
          ? <label>Silent install arguments<input placeholder="/qn /norestart" value={custom.installArguments} onChange={(e) => setCustom({ ...custom, installArguments: e.target.value })} /></label>
          : <label>Install script<textarea rows="7" placeholder={custom.executionMode === 'powershell' ? 'Use $env:HI5_INSTALLER and $env:HI5_WORKDIR' : 'Use %HI5_INSTALLER% and %HI5_WORKDIR%'} value={custom.script} onChange={(e) => setCustom({ ...custom, script: e.target.value })} /></label>}
        <div className="app-portal-form-grid">
          <label>Verification<select value={custom.verificationMethod} onChange={(e) => setCustom({ ...custom, verificationMethod: e.target.value })}>
            <option value="uninstall_registry">Uninstall registry</option><option value="file_version">File version</option>
          </select></label>
          {custom.verificationMethod === 'file_version'
            ? <label>Verification file<input placeholder="C:\Program Files\Company\App.exe" value={custom.filePath} onChange={(e) => setCustom({ ...custom, filePath: e.target.value })} /></label>
            : <label>Display name contains<input value={custom.displayNameContains} onChange={(e) => setCustom({ ...custom, displayNameContains: e.target.value })} /></label>}
        </div>
        {custom.verificationMethod === 'uninstall_registry' && <label>MSI product code (optional)<input value={custom.productCode} onChange={(e) => setCustom({ ...custom, productCode: e.target.value })} /></label>}
        <div className="app-portal-draft-actions">
          <button className="rmm-secondary" disabled={busy} onClick={() => saveCustom(false)} type="button"><PackagePlus size={15} /> {editingDraft ? 'Save / retry upload' : 'Save draft'}</button>
          <button className="rmm-primary" disabled={busy} onClick={() => saveCustom(true)} type="button"><CheckCircle2 size={15} /> {editingDraft ? 'Publish this application' : 'Create & publish revision'}</button>
        </div>
      </section>
      <section className="app-portal-card">
        <div className="app-portal-card-title"><div><h3>Assignment</h3><p>Most-specific scope wins: Device → User → Group → Site → Estate.</p></div><ChevronRight size={20} /></div>
        <label>Application<select value={assignment.appId} onChange={(e) => setAssignment({ ...assignment, appId: e.target.value })}>
          <option value="">Choose application…</option>{bundle.apps.filter((app) => app.status === 'published').map((app) => <option key={app.id} value={app.id}>{app.name}</option>)}
        </select></label>
        <div className="app-portal-form-grid">
          <label>Scope<select value={assignment.scopeType} onChange={(e) => setAssignment({
            ...assignment, scopeType: e.target.value,
            scopeId: e.target.value === 'Estate' ? '*' : '', scopeName: e.target.value === 'Estate' ? 'Entire estate' : '',
          })}>{['Estate','Site','Group','User','Device'].map((value) => <option key={value}>{value}</option>)}</select></label>
          <label>Behaviour<select value={assignment.intent} onChange={(e) => setAssignment({ ...assignment, intent: e.target.value })}>
            <option value="available">Available</option><option value="approval_required">Approval required</option><option value="hidden">Hidden</option>
          </select></label>
        </div>
        {assignment.scopeType !== 'Estate' && <><label>Scope identifier<input placeholder={assignment.scopeType === 'User' ? 'user@company.com or SID' : assignment.scopeType + ' id / reference'} value={assignment.scopeId} onChange={(e) => setAssignment({ ...assignment, scopeId: e.target.value })} /></label>
          <label>Display name<input value={assignment.scopeName} onChange={(e) => setAssignment({ ...assignment, scopeName: e.target.value })} /></label></>}
        <button className="rmm-primary" disabled={busy} onClick={addAssignment} type="button">Save assignment</button>
      </section>
    </div>

    <section className="app-portal-card app-portal-wide">
      <div className="app-portal-card-title"><div><h3>Approval requests</h3><p>Approval revalidates the current assignment and exact published revision before installation is dispatched.</p></div></div>
      <div className="app-portal-approval-list">
        {bundle.requests.filter((row) => row.status === 'pending').map((row) => <div key={row.id}>
          <span><strong>{row.app_name}</strong><small>{row.requested_by_upn || row.requested_by_sid || 'Endpoint user'} · {new Date(row.created_at).toLocaleString()}</small></span>
          <span className="app-portal-state">Pending</span>
          <span className="app-portal-request-actions">
            <button className="app-portal-text-action approve" disabled={busy} type="button" onClick={() => run(() => decideAppPortalRequest(row.id, 'approved'), row.app_name + ' approved and dispatched.')}>Approve</button>
            <button className="app-portal-text-action" disabled={busy} type="button" onClick={() => run(() => decideAppPortalRequest(row.id, 'rejected'), row.app_name + ' request rejected.')}>Reject</button>
          </span>
        </div>)}
        {!bundle.requests.some((row) => row.status === 'pending') && <div className="app-portal-empty">No approval requests are waiting.</div>}
      </div>
    </section>

    <section className="app-portal-card app-portal-wide">
      <div className="app-portal-card-title"><div><h3>Active assignments</h3><p>Scope is always revalidated by the API when an endpoint requests an install.</p></div></div>
      <div className="app-portal-assignment-list">{bundle.assignments.map((row) => {
        const app = bundle.apps.find((item) => item.id === row.app_id)
        return <div key={row.id}><span><strong>{app?.name || 'Application'}</strong><small>{row.scope_type} · {row.scope_name || row.scope_id}</small></span>
          <span className="app-portal-state">{row.intent.replaceAll('_',' ')}</span>
          <button type="button" aria-label="Remove assignment" onClick={() => run(() => removeAppPortalAssignment(row.id), 'Assignment removed.')}><Trash2 size={15} /></button></div>
      })}{!bundle.assignments.length && <div className="app-portal-empty">No assignments configured.</div>}</div>
    </section>
  </div>
}
