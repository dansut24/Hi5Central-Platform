/** Match the central API's published Hi5Central version syntax. */
const VALID_RELEASE_VERSION=/^v?\d+(?:\.\d+){1,3}(?:-(?:alpha|beta|rc)(?:[.-]?\d+)?)?$/i
export function validHi5CentralReleaseNumber(value){
 return typeof value==='string'
   &&value.trim().length<=32
   &&VALID_RELEASE_VERSION.test(value.trim())
}
