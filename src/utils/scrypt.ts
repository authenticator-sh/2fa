// scrypt (RFC 7914), for the one format that needs it: Aegis's encrypted
// backup. WebCrypto has no scrypt, and a dependency would be one more party
// in the code every secret of an Aegis user passes through — so the two
// PBKDF2 steps are WebCrypto's, and only the memory-hard middle (Salsa20/8 in
// ROMix) is here. Checked against the RFC's test vectors (test/scrypt.test.ts).
//
// Synchronous between the two PBKDF2 calls: Aegis's own parameters (N = 2^15,
// r = 8) take 32 MB and under a tenth of a second, once the password dialog
// has closed.

/** The derived key, `length` bytes. The caller bounds N, r and p: memory is 128·r·N bytes. */
export async function scrypt(
  password: Uint8Array,
  salt: Uint8Array,
  N: number,
  r: number,
  p: number,
  length: number
): Promise<Uint8Array> {
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) throw new RangeError('scrypt: N must be a power of 2');
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) throw new RangeError('scrypt: bad r or p');

  const key = await crypto.subtle.importKey('raw', password as BufferSource, 'PBKDF2', false, ['deriveBits']);
  const pbkdf2 = async (input: Uint8Array, bytes: number) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: input as BufferSource, iterations: 1, hash: 'SHA-256' },
        key,
        bytes * 8
      )
    );

  const blockWords = 32 * r;
  const B = await pbkdf2(salt, p * 128 * r);
  const words = new Uint32Array(p * blockWords);
  const view = new DataView(B.buffer, B.byteOffset, B.byteLength);
  // Salsa20 is little-endian; read the words explicitly rather than trust the host.
  for (let i = 0; i < words.length; i++) words[i] = view.getUint32(i * 4, true);

  const V = new Uint32Array(N * blockWords);
  const X = new Uint32Array(blockWords);
  const Y = new Uint32Array(blockWords);
  const T = new Uint32Array(16);
  for (let i = 0; i < p; i++) {
    const block = words.subarray(i * blockWords, (i + 1) * blockWords);
    romix(block, N, r, V, X, Y, T);
  }

  for (let i = 0; i < words.length; i++) view.setUint32(i * 4, words[i], true);
  return pbkdf2(B, length);
}

/** scryptROMix, in place on `block`. */
function romix(
  block: Uint32Array,
  N: number,
  r: number,
  V: Uint32Array,
  X: Uint32Array,
  Y: Uint32Array,
  T: Uint32Array
): void {
  const blockWords = 32 * r;
  X.set(block);
  for (let i = 0; i < N; i++) {
    V.set(X, i * blockWords);
    blockMix(X, Y, r, T);
    X.set(Y);
  }
  for (let i = 0; i < N; i++) {
    // Integerify: the first word of the last 64-byte chunk; N is a power of 2.
    const j = X[(2 * r - 1) * 16] & (N - 1);
    const offset = j * blockWords;
    for (let k = 0; k < blockWords; k++) X[k] ^= V[offset + k];
    blockMix(X, Y, r, T);
    X.set(Y);
  }
  block.set(X);
}

/** scryptBlockMix: `B` into `Y`, even chunks to the first half, odd to the second. */
function blockMix(B: Uint32Array, Y: Uint32Array, r: number, T: Uint32Array): void {
  T.set(B.subarray((2 * r - 1) * 16, 2 * r * 16));
  for (let i = 0; i < 2 * r; i++) {
    for (let k = 0; k < 16; k++) T[k] ^= B[i * 16 + k];
    salsa8(T);
    Y.set(T, (i >> 1) * 16 + (i & 1) * r * 16);
  }
}

/** Salsa20/8 core, in place. */
function salsa8(b: Uint32Array): void {
  let x0 = b[0], x1 = b[1], x2 = b[2], x3 = b[3], x4 = b[4], x5 = b[5], x6 = b[6], x7 = b[7];
  let x8 = b[8], x9 = b[9], x10 = b[10], x11 = b[11], x12 = b[12], x13 = b[13], x14 = b[14], x15 = b[15];
  let u: number;
  for (let i = 0; i < 8; i += 2) {
    // Columns.
    u = (x0 + x12) | 0; x4 ^= (u << 7) | (u >>> 25);
    u = (x4 + x0) | 0; x8 ^= (u << 9) | (u >>> 23);
    u = (x8 + x4) | 0; x12 ^= (u << 13) | (u >>> 19);
    u = (x12 + x8) | 0; x0 ^= (u << 18) | (u >>> 14);
    u = (x5 + x1) | 0; x9 ^= (u << 7) | (u >>> 25);
    u = (x9 + x5) | 0; x13 ^= (u << 9) | (u >>> 23);
    u = (x13 + x9) | 0; x1 ^= (u << 13) | (u >>> 19);
    u = (x1 + x13) | 0; x5 ^= (u << 18) | (u >>> 14);
    u = (x10 + x6) | 0; x14 ^= (u << 7) | (u >>> 25);
    u = (x14 + x10) | 0; x2 ^= (u << 9) | (u >>> 23);
    u = (x2 + x14) | 0; x6 ^= (u << 13) | (u >>> 19);
    u = (x6 + x2) | 0; x10 ^= (u << 18) | (u >>> 14);
    u = (x15 + x11) | 0; x3 ^= (u << 7) | (u >>> 25);
    u = (x3 + x15) | 0; x7 ^= (u << 9) | (u >>> 23);
    u = (x7 + x3) | 0; x11 ^= (u << 13) | (u >>> 19);
    u = (x11 + x7) | 0; x15 ^= (u << 18) | (u >>> 14);
    // Rows.
    u = (x0 + x3) | 0; x1 ^= (u << 7) | (u >>> 25);
    u = (x1 + x0) | 0; x2 ^= (u << 9) | (u >>> 23);
    u = (x2 + x1) | 0; x3 ^= (u << 13) | (u >>> 19);
    u = (x3 + x2) | 0; x0 ^= (u << 18) | (u >>> 14);
    u = (x5 + x4) | 0; x6 ^= (u << 7) | (u >>> 25);
    u = (x6 + x5) | 0; x7 ^= (u << 9) | (u >>> 23);
    u = (x7 + x6) | 0; x4 ^= (u << 13) | (u >>> 19);
    u = (x4 + x7) | 0; x5 ^= (u << 18) | (u >>> 14);
    u = (x10 + x9) | 0; x11 ^= (u << 7) | (u >>> 25);
    u = (x11 + x10) | 0; x8 ^= (u << 9) | (u >>> 23);
    u = (x8 + x11) | 0; x9 ^= (u << 13) | (u >>> 19);
    u = (x9 + x8) | 0; x10 ^= (u << 18) | (u >>> 14);
    u = (x15 + x14) | 0; x12 ^= (u << 7) | (u >>> 25);
    u = (x12 + x15) | 0; x13 ^= (u << 9) | (u >>> 23);
    u = (x13 + x12) | 0; x14 ^= (u << 13) | (u >>> 19);
    u = (x14 + x13) | 0; x15 ^= (u << 18) | (u >>> 14);
  }
  b[0] += x0; b[1] += x1; b[2] += x2; b[3] += x3; b[4] += x4; b[5] += x5; b[6] += x6; b[7] += x7;
  b[8] += x8; b[9] += x9; b[10] += x10; b[11] += x11; b[12] += x12; b[13] += x13; b[14] += x14; b[15] += x15;
}
