// Simple Helpers für Commit/Reveal
export async function sha256Hex(input) {
  const enc = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function randomSalt(len = 16) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  // Base64url ohne Padding
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
}
