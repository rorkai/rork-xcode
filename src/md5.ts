/**
 * Embedded MD5, implemented from RFC 1321.
 *
 * Deterministic object ids hash their seed text (see `uuid.ts`), and the
 * library runs in every JavaScript runtime without depending on a crypto
 * module, so the digest is implemented here. MD5 is used strictly as a
 * stable text-to-bits mapping for identifier generation, and nothing
 * security relevant derives from it.
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
 * Step constants for the 64 steps, which are the integer parts of
 * `abs(sin(i + 1)) * 2^32`, as RFC 1321 section 3.4 tabulates them. The
 * values are fixed by the specification rather than derived through
 * `Math.sin` at load, because the digest feeds deterministic identifiers
 * and floating-point transcendentals are the one spot where runtimes could
 * legally disagree.
 */
// prettier-ignore
const SINES = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);

/**
 * Encodes text as UTF-8 bytes with RFC 1321 padding applied, meaning a
 * `0x80` terminator, zero fill to 56 bytes mod 64, then the bit length as
 * a little-endian 64-bit integer.
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
 * a substitute here, because the bitwise coercion is what performs the
 * modular wrap the algorithm requires.
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
    // The digest serializes little-endian, least significant byte first.
    for (let shift = 0; shift < 32; shift += 8) {
      hex += ((word >>> shift) & 0xff).toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return hex;
}
