// Company-managed custom-app logos are ordinary raster images only.
// Deliberately reject SVG/HTML, broken PNGs, animations and oversized artwork.
export const MAX_APP_PORTAL_ICON_BYTES = 512 * 1024
const PNG_SIGNATURE = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])

function crc32(bytes, begin, end) {
  let crc = 0xFFFFFFFF
  for (let i = begin; i < end; i += 1) {
    crc ^= bytes[i]
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0)
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

export function inspectAppPortalIcon(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 57 || bytes.length > MAX_APP_PORTAL_ICON_BYTES) {
    return { error: 'Choose a PNG logo smaller than 512 KB.' }
  }
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { error: 'Use a PNG logo (JPG, SVG and animated images are not supported yet).' }
  }
  let position = 8
  let first = true
  let hasImageData = false
  let hasEnd = false
  let width = 0
  let height = 0
  while (position + 12 <= bytes.length) {
    const chunkLength = bytes.readUInt32BE(position)
    const next = position + chunkLength + 12
    if (chunkLength > MAX_APP_PORTAL_ICON_BYTES || next > bytes.length) {
      return { error: 'The PNG logo is damaged or truncated.' }
    }
    const type = bytes.toString('ascii', position + 4, position + 8)
    const expectedCrc = bytes.readUInt32BE(next - 4)
    if (crc32(bytes, position + 4, next - 4) !== expectedCrc) {
      return { error: 'The PNG logo checksum is invalid.' }
    }
    if (first) {
      if (type !== 'IHDR' || chunkLength !== 13) {
        return { error: 'The PNG logo header is invalid.' }
      }
      width = bytes.readUInt32BE(position + 8)
      height = bytes.readUInt32BE(position + 12)
      if (width < 16 || height < 16 || width > 1024 || height > 1024
          || width / height > 5 || height / width > 5) {
        return { error: 'Use a logo between 16 and 1024 pixels, with maximum aspect ratio 5:1.' }
      }
      if (bytes[position + 16] !== 8 || ![0,2,4,6].includes(bytes[position + 17])) {
        return { error: 'Use an ordinary 8-bit PNG logo.' }
      }
      first = false
    } else if (type === 'IHDR' || type === 'acTL' || type === 'fcTL' || type === 'fdAT') {
      return { error: 'Animated or malformed PNG logos are not supported.' }
    }
    if (type === 'IDAT') hasImageData = true
    if (type === 'IEND') {
      if (chunkLength !== 0 || next !== bytes.length) {
        return { error: 'The PNG logo footer is invalid.' }
      }
      hasEnd = true
      break
    }
    position = next
  }
  if (!hasImageData || !hasEnd) {
    return { error: 'The PNG logo has no complete image data.' }
  }
  return { mime: 'image/png', extension: '.png', width, height }
}
