/**
 * Embedded MD5, implemented from RFC 1321.
 *
 * Deterministic object ids hash their seed text (see `uuid.ts`), and the
 * library runs in every JavaScript runtime without depending on a crypto
 * module, so the digest is implemented here. MD5 is used strictly as a
 * stable text-to-bits mapping for identifier generation; nothing security
 * relevant derives from it.
 *
 * @module
 */

/**
 * Per-round left-rotation amounts, in the order the 64 steps apply them
 * (RFC 1321 section 3.4).
 */
// prettier-ignore
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/**
 * Step constants: the integer parts of `abs(sin(i + 1)) * 2^32` for step
 * `i`, as RFC 1321 defines them. Computed once at module load; hardcoding
 * 64 magic numbers would only obscure their derivation.
 */
const SINES = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  SINES[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);
}

/**
 * Encodes text as UTF-8 bytes with RFC 1321 padding applied: a `0x80`
 * terminator, zero fill to 56 bytes mod 64, then the bit length as a
 * little-endian 64-bit integer.
 */
function paddedUtf8(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const paddedLength = (Math.floor((bytes.length + 8) / 64) + 1) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  // The message bit length occupies the final 8 bytes, little-endian. Seed
  // strings are far below 2^32 bits, so the high half stays zero.
  const bitLength = bytes.length * 8;
  padded[paddedLength - 8] = bitLength & 0xff;
  padded[paddedLength - 7] = (bitLength >>> 8) & 0xff;
  padded[paddedLength - 6] = (bitLength >>> 16) & 0xff;
  padded[paddedLength - 5] = (bitLength >>> 24) & 0xff;
  return padded;
}

/**
 * Adds two 32-bit values with wraparound, keeping intermediates inside the
 * 32-bit range JavaScript bitwise operators preserve. `Math.trunc` is not
 * a substitute here: the bitwise coercion is what performs the modular
 * wrap the algorithm requires.
 */
function add32(a: number, b: number): number {
  // oxlint-disable-next-line unicorn/prefer-math-trunc
  return (a + b) | 0;
}

/**
 * Computes the MD5 digest of the text (as UTF-8) and returns it as 32
 * uppercase hexadecimal characters.
 *
 * Uppercase matches the identifier alphabet Xcode uses, which is what the
 * digest feeds (see `uuid.ts`).
 */
export function md5Hex(text: string): string {
  const message = paddedUtf8(text);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const words = new Uint32Array(16);
  for (let offset = 0; offset < message.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const base = offset + i * 4;
      words[i] = message[base]! | (message[base + 1]! << 8) | (message[base + 2]! << 16) | (message[base + 3]! << 24);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let step = 0; step < 64; step++) {
      let mix: number;
      let wordIndex: number;
      if (step < 16) {
        mix = (b & c) | (~b & d);
        wordIndex = step;
      } else if (step < 32) {
        mix = (d & b) | (~d & c);
        wordIndex = (5 * step + 1) % 16;
      } else if (step < 48) {
        mix = b ^ c ^ d;
        wordIndex = (3 * step + 5) % 16;
      } else {
        mix = c ^ (b | ~d);
        wordIndex = (7 * step) % 16;
      }

      const rotated = add32(add32(a, mix), add32(SINES[step]!, words[wordIndex]!));
      const shift = SHIFTS[step]!;
      const next = add32(b, (rotated << shift) | (rotated >>> (32 - shift)));

      a = d;
      d = c;
      c = b;
      b = next;
    }

    a0 = add32(a0, a);
    b0 = add32(b0, b);
    c0 = add32(c0, c);
    d0 = add32(d0, d);
  }

  let hex = "";
  for (const word of [a0, b0, c0, d0]) {
    // The digest serializes little-endian: least significant byte first.
    for (let shift = 0; shift < 32; shift += 8) {
      hex += ((word >>> shift) & 0xff).toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return hex;
}
