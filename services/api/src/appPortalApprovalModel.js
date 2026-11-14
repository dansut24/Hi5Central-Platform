// Endpoint privilege elevation requests are tied to a published, tenant-scoped
// application revision. Validation runs before creating any privileged job.
export const REQUEST_MIN_LENGTH = 20
export const DECISION_MIN_LENGTH = 10
export const REASON_MAX_LENGTH = 2000

export function checkBusinessReason(reason) {
  const text=String(reason??'').trim()
  if(text.length<REQUEST_MIN_LENGTH||text.length>REASON_MAX_LENGTH)
    return 'Explain why the application is needed (20–2000 characters).'
  return null
}
export function checkDecisionReason(reason) {
  const text=String(reason??'').trim()
  if(text.length<DECISION_MIN_LENGTH||text.length>REASON_MAX_LENGTH)
    return 'A decision reason of 10–2000 characters is required.'
  return null
}
export function approvalNeedsManualReview(status) {
  return status==='approved'
}
