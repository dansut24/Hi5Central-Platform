// Company-managed custom-app logos are ordinary raster images only.
// Deliberately reject SVG/HTML and suspiciously large or oversized images.
export const MAX_APP_PORTAL_ICON_BYTES = 512 * 1024
const PNG_SIGNATURE = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])

export function inspectAppPortalIcon(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > MAX_APP_PORTAL_ICON_BYTES) {
    return { error: 'Choose an image smaller than 512 KB.' }
  }
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    return { error: 'Use a PNG logo (JPG, SVG and animated images are not supported yet).' }
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (width < 16 || height < 16 || width > 1024 || height > 1024) {
    return { error: 'Logo dimensions must be between 16 and 1024 pixels.' }
  }
  if (width / height > 5 || height / width > 5) {
    return { error: 'Use a reasonably square or horizontal logo (maximum 5:1 ratio).' }
  }
  return { mime: 'image/png', extension: '.png', width, height }
}
