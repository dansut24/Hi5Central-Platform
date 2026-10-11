export function updatePublicationStatus({installedSha,releases}={}){
  const list=Array.isArray(releases)?releases:[]
  if(!list.length)return {kind:'none',label:'No published update',description:'No published releases are available to compare.'}
  const index=list.findIndex(item=>item?.buildSha===installedSha)
  if(index<0)return {kind:'unlisted',label:'Pilot / unpublished build',description:'This installed build is outside the published release catalogue. A newer update is not confirmed.'}
  if(index===0)return {kind:'current',label:'Up to date',description:'You are running the latest release in the published catalogue.'}
  return {kind:'newer-published',label:'Newer release published',description:'A newer release is published. Installation depends on your environment update policy.'}
}
