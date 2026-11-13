const API_BASE = window.__HI5_API_BASE__

async function request(path, options = {}) {
  const response = await fetch(API_BASE + path, {
    credentials: 'include',
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.error || 'App Portal request failed.')
    error.status = response.status
    error.data = payload
    throw error
  }
  return payload
}

export const loadAppPortal = () => request('/api/v1/rmm/app-portal')
export const createAppPortalApp = (payload) => request('/api/v1/rmm/app-portal/apps', {
  method: 'POST', body: JSON.stringify(payload),
})
export const createAppPortalRevision = (appId, payload) => request('/api/v1/rmm/app-portal/apps/' + encodeURIComponent(appId) + '/revisions', {
  method: 'POST', body: JSON.stringify(payload),
})
export const publishAppPortalRevision = (revisionId) => request('/api/v1/rmm/app-portal/revisions/' + encodeURIComponent(revisionId) + '/publish', {
  method: 'POST',
})
export const assignAppPortalApp = (appId, payload) => request('/api/v1/rmm/app-portal/apps/' + encodeURIComponent(appId) + '/assignments', {
  method: 'POST', body: JSON.stringify(payload),
})
export const removeAppPortalAssignment = (assignmentId) => request('/api/v1/rmm/app-portal/assignments/' + encodeURIComponent(assignmentId), {
  method: 'DELETE',
})
export const decideAppPortalRequest = (requestId, decision, note = '') => request('/api/v1/rmm/app-portal/requests/' + encodeURIComponent(requestId) + '/decision', {
  method: 'POST', body: JSON.stringify({ decision, note }),
})

// A file upload is separate from a JSON API request. XHR provides upload
// progress and precise HTTP/network errors instead of a generic "upload failed".
export function uploadAppPortalPackage(revisionId, file, onProgress = () => {}) {
  const name = String(file?.name || '')
  const installerType = name.toLowerCase().endsWith('.msi') ? 'msi'
    : name.toLowerCase().endsWith('.exe') ? 'exe' : ''
  if (!installerType) return Promise.reject(new Error('Choose a Windows MSI or EXE installer, not a ZIP or another file type.'))
  if (!file?.size) return Promise.reject(new Error('The selected installer is empty. Choose the original MSI or EXE file.'))
  if (file.size > 2 * 1024 * 1024 * 1024) return Promise.reject(new Error('Installer exceeds the 2 GB upload limit.'))

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', API_BASE + '/api/v1/rmm/app-portal/revisions/' + encodeURIComponent(revisionId) + '/package', true)
    xhr.withCredentials = true
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('X-Hi5-Filename', encodeURIComponent(name))
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.round(event.loaded / event.total * 100)))
      }
    }
    xhr.onload = () => {
      let payload = {}
      try { payload = JSON.parse(xhr.responseText || '{}') } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && payload.success) {
        onProgress(100)
        resolve(payload)
        return
      }
      const explanation = payload.error || (Array.isArray(payload.errors) ? payload.errors.join(' ') : '')
      const error = new Error(explanation || 'Installer upload was rejected by the server (HTTP ' + xhr.status + ').')
      error.status = xhr.status
      error.data = payload
      reject(error)
    }
    xhr.onerror = () => reject(new Error('The installer could not reach Hi5Central. Check your network and retry; your draft has been kept.'))
    xhr.onabort = () => reject(new Error('Installer upload was cancelled. Your draft has been kept.'))
    try { xhr.send(file) } catch (error) {
      reject(new Error('Browser could not send the installer: ' + (error?.message || 'Unknown error')))
    }
  })
}


export const updateAppPortalDraft = (appId, payload) => request('/api/v1/rmm/app-portal/apps/' + encodeURIComponent(appId), {
  method: 'PATCH', body: JSON.stringify(payload),
})

export async function uploadAppPortalLogo(appId, file) {
  if (!file || file.type !== 'image/png' || file.size > 512 * 1024) {
    throw new Error('Choose a PNG logo smaller than 512 KB.')
  }
  const response = await fetch(API_BASE + '/api/v1/rmm/app-portal/apps/' + encodeURIComponent(appId) + '/icon', {
    method: 'PUT', credentials: 'include', cache: 'no-store',
    headers: { 'Content-Type': 'image/png' },
    body: file,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.error || 'Logo upload failed.')
    error.status = response.status
    error.data = payload
    throw error
  }
  return payload
}
