import { execFile as run } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(run)
const CODES = new Set(['ProductName', 'Manufacturer', 'ProductVersion', 'ProductCode'])

const string = (value) => String(value ?? '').trim().slice(0, 255)
const version = (value) => {
  const input = string(value)
  return /^\d+(?:\.\d+){0,4}$/.test(input) ? input : ''
}

export function parseMsiProperties(output) {
  const parsed = {}
  for (const row of String(output || '').split(/\r?\n/)) {
    const [key, ...values] = row.split('\t')
    if (CODES.has(key)) parsed[key] = string(values.join('\t'))
  }
  return { name: parsed.ProductName || '', publisher: parsed.Manufacturer || '',
    version: version(parsed.ProductVersion), productCode: parsed.ProductCode || '' }
}

export function parseExeProperties(output) {
  try {
    const json = JSON.parse(output)
    const info = Array.isArray(json) ? json[0] : {}
    return { name: string(info?.ProductName || info?.FileDescription),
      publisher: string(info?.CompanyName),
      version: version(info?.ProductVersion || info?.FileVersion), productCode: '' }
  } catch {
    return { name: '', publisher: '', version: '', productCode: '' }
  }
}

export function parseAuthenticode(output) {
  const text = String(output || '')
  if (/MSI file has no signature|PE file has no signature|no signature|unable to extract existing signature/i.test(text)
      && !/Signer's certificate:\s*[\s\S]*?Signer #0:/i.test(text)) {
    return { status: 'unsigned', signer: '', digestMatched: false }
  }
  const subject = text.match(/Signer's certificate:\s*[\s\S]*?Signer #0:\s*Subject:\s*([^\r\n]+)/i)?.[1] || ''
  // The first signer's CN corresponds to Windows CERT_NAME_SIMPLE_DISPLAY_TYPE;
  // never select the timestamp signer or trust a filename as a signer.
  const cn = subject.match(/(?:^|,)CN=("[^"]+"|[^,]+)/i)?.[1]?.replace(/^"|"$/g, '') || ''
  const current = text.match(/Current message digest\s*:\s*([A-Fa-f0-9]{64})/i)?.[1]?.toUpperCase() || ''
  const calculated = text.match(/Calculated message digest\s*:\s*([A-Fa-f0-9]{64})/i)?.[1]?.toUpperCase() || ''
  if (cn && current && current === calculated) {
    return { status: 'pending_windows_trust', signer: string(cn), digestMatched: true }
  }
  return { status: 'invalid_or_unrecognised', signer: '', digestMatched: false }
}

async function runTool(bin, args) {
  try {
    const { stdout, stderr } = await execFile(bin, args, {
      timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true,
    })
    return String(stdout || '') + '\n' + String(stderr || '')
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ETIMEDOUT' || error.killed) {
      throw new Error('Package inspection tool unavailable or timed out: ' + bin)
    }
    // osslsigncode returns nonzero for unsigned files and for signatures whose
    // Windows CA chain is not in the Linux store. Keep its output for parsing.
    if (error.stdout || error.stderr) {
      return String(error.stdout || '') + '\n' + String(error.stderr || '')
    }
    throw error
  }
}

export async function inspectUploadedPackage(filePath, installerType) {
  if (!['msi', 'exe'].includes(installerType)) throw new Error('Invalid installer type')
  const [metadata, signature] = await Promise.all([
    installerType === 'msi'
      ? runTool('msiinfo', ['export', filePath, 'Property']).then(parseMsiProperties)
      : runTool('exiftool', ['-j', '-ProductName', '-FileDescription', '-CompanyName', '-ProductVersion', '-FileVersion', filePath]).then(parseExeProperties),
    runTool('osslsigncode', ['verify', '-in', filePath]).then(parseAuthenticode),
  ])
  return { ...signature, metadata }
}
