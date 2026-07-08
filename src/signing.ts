// HMAC-SHA256 request signing.
//
// Clients sign each request with a shared 64-byte (128 hex char) secret and
// send the result in the `X-Request-Signature` header. The canonical message
// is `${METHOD}\n${PATH + QUERY}\n${RAW_BODY}` so both the route/params and the
// exact request body are covered.

const encoder = new TextEncoder()

function hexToBytes(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error('Invalid hex string')
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

async function importKey(hexSecret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    hexToBytes(hexSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

function canonicalMessage(method: string, pathWithQuery: string, body: string): Uint8Array {
  return encoder.encode(`${method}\n${pathWithQuery}\n${body}`)
}

/** Compute the hex-encoded signature for a request (useful for clients/tests). */
export async function computeSignature(
  hexSecret: string,
  method: string,
  pathWithQuery: string,
  body: string,
): Promise<string> {
  const key = await importKey(hexSecret)
  const sig = await crypto.subtle.sign('HMAC', key, canonicalMessage(method, pathWithQuery, body))
  return bytesToHex(new Uint8Array(sig))
}

/**
 * Constant-time verification of a provided hex signature. Returns false on any
 * malformed input rather than throwing.
 */
export async function verifySignature(
  hexSecret: string,
  provided: string,
  method: string,
  pathWithQuery: string,
  body: string,
): Promise<boolean> {
  try {
    const key = await importKey(hexSecret)
    return await crypto.subtle.verify(
      'HMAC',
      key,
      hexToBytes(provided),
      canonicalMessage(method, pathWithQuery, body),
    )
  } catch {
    return false
  }
}
