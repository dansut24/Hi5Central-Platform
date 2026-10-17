import {automaticDevPublicationEnabled} from './releasePublicationCredential.js'
import {listOfficialReleaseCandidates,verifyOfficialReleaseRun,verifyDevReleaseSmoke} from './officialReleaseCertification.js'

const SHA=/^[a-f0-9]{40}$/

/**
 * Independent Live-side gate for the trusted publication-only relay.
 * A caller cannot submit its own CI proof or force customer deployment.
 * No database update or host command is performed by this verifier.
 */
export async function verifyAutomaticDevPublication({
  sha,settings=process.env,
  listCandidates=listOfficialReleaseCandidates,
  verifyRun=verifyOfficialReleaseRun,
  verifyDev=verifyDevReleaseSmoke,
}={}){
  if(!automaticDevPublicationEnabled(settings))
    throw Error('Central verified-Dev publication mode is not enabled.')
  if(!SHA.test(String(sha||'')))throw Error('Immutable SHA40 required.')
  const token=settings.GITHUB_RELEASE_READ_TOKEN
  const found=await listCandidates({token})
  if(!Array.isArray(found))throw Error('Official GitHub candidates were unavailable.')
  const matches=found.filter(item=>item?.buildSha===sha
    &&/^https:\/\/github\.com\/dansut24\/Hi5Central-Platform\/actions\/runs\/[0-9]+$/.test(
      String(item?.ciRunUrl||'')))
  if(matches.length===0)throw Error('Official release candidate workflow is incomplete or missing.')
  const exact=matches[0]
  const ci=await verifyRun({sha,runUrl:exact.ciRunUrl,token})
  if(ci?.buildSha!==sha||ci?.evidence?.ci!==true
    ||ci?.evidence?.security!==true||ci?.evidence?.migrations!==true)
    throw Error('Official CI proof did not match the immutable candidate.')
  const smoke=await verifyDev({sha})
  if(smoke?.smoke!==true)
    throw Error('Actual Dev API/frontend proof did not match candidate.')
  return {sha,ciRunUrl:exact.ciRunUrl,verifiedAt:new Date().toISOString()}
}
