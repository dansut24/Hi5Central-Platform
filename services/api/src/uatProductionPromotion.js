import { APPLICATION_SHA_PATTERN } from './applicationDeployment.js'

/**
 * A shared Production API/ITSM upgrade affects every tenant on that runtime.
 * Only platform administrators can queue it, and only after a customer has
 * explicitly requested that SAME immutable UAT build through the approved
 * release-review flow. A UAT status badge or a manually typed SHA is not proof.
 */
export function assessUatProductionPromotion({review,uat,live,published=false}={}) {
  if (!review || review.status !== 'pending') {
    return {allowed:false,code:'REVIEW_NOT_PENDING',reason:'A pending, customer-requested UAT release review is required.'}
  }
  if (!APPLICATION_SHA_PATTERN.test(String(review.build_sha||''))) {
    return {allowed:false,code:'INVALID_REVISION',reason:'The reviewed UAT build does not have an immutable revision.'}
  }
  const notes=String(review.evidence||'').trim()
  if (notes.length<20 || notes.length>4000) {
    return {allowed:false,code:'MISSING_TEST_EVIDENCE',reason:'UAT test evidence must include at least 20 characters.'}
  }
  const approved=review.approved_change_shas
  if (!Array.isArray(approved) || approved.length>70
    || approved.some(sha=>!APPLICATION_SHA_PATTERN.test(String(sha||'')))
    || new Set(approved).size!==approved.length) {
    return {allowed:false,code:'INVALID_CHANGE_SELECTION',reason:'UAT-approved changes are invalid or duplicated.'}
  }
  if (!published) {
    return {allowed:false,code:'NOT_PUBLISHED',reason:'The tested application revision must have published release notes.'}
  }
  if (!uat?.verified || uat.apiSha!==review.build_sha || uat.itsmSha!==review.build_sha) {
    return {allowed:false,code:'UAT_MISMATCH',reason:'The host must verify that UAT still runs this exact API and ITSM build.'}
  }
  if (live?.verified && live.apiSha===review.build_sha && live.itsmSha===review.build_sha) {
    return {allowed:false,code:'ALREADY_INSTALLED',reason:'Production already runs the approved UAT build.'}
  }
  return {allowed:true,code:'READY_TO_QUEUE',reason:'Awaiting explicit platform administrator approval.'}
}
