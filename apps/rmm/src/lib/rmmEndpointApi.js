const base = '/api/v1/rmm/endpoint-management'
const apiBase = window.__HI5_API_BASE__ || ''
async function request(path, options = {}) {
  const response = await fetch(apiBase + base + path, {
    credentials: 'include', cache: 'no-store', ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || 'Endpoint policy request failed.')
  return payload
}
export const endpointApi = {
  list: () => request(''),
  create: (profile) => request('/profiles', { method: 'POST', body: JSON.stringify(profile) }),
  update: (profile) => request('/profiles/' + encodeURIComponent(profile.id), { method: 'PUT', body: JSON.stringify(profile) }),
  removeProfile: (id,revision,reason,confirmName) => request('/profiles/' + encodeURIComponent(id), { method: 'DELETE', body: JSON.stringify({revision,reason,confirmName}) }),
  setException: (profileId, exception) => request('/profiles/' + encodeURIComponent(profileId) + '/exceptions', { method: 'POST', body: JSON.stringify(exception) }),
  removeException: (profileId, id) => request('/profiles/' + encodeURIComponent(profileId) + '/exceptions/' + encodeURIComponent(id), { method: 'DELETE' }),
  preview: (profileId, deviceId) => request('/profiles/' + encodeURIComponent(profileId) + '/effective/' + encodeURIComponent(deviceId)),
  run: (profileId, deviceId, action, settingKey = '') => request('/profiles/' + encodeURIComponent(profileId) + '/devices/' + encodeURIComponent(deviceId) + '/run', { method: 'POST', body: JSON.stringify({ action, settingKey }) }),
  runStatus: (jobId) => request('/runs/' + encodeURIComponent(jobId)),
}
