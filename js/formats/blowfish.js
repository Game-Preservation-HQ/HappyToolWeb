// Blowfish-ECB as Happy Wars uses it (port of HappyTool/Formats/Blowfish.cs): each 8-byte block is two
// little-endian u32 halves, the first ("low") half entering the rounds as the left word. The key schedule is the
// standard one, with key bytes packed big-endian into 32-bit words.
import { P_INIT, S_INIT } from './blowfish-tables.js';

export class Blowfish {
  /** @param {string|Uint8Array} key */
  constructor(key) {
    const k = typeof key === 'string' ? new TextEncoder().encode(key) : key;
    this.P = new Uint32Array(P_INIT);
    this.S = S_INIT.map((box) => new Uint32Array(box));
    for (let i = 0, j = 0; i < 18; i++) {
      let data = 0;
      for (let b = 0; b < 4; b++) data = ((data << 8) | k[j++ % k.length]) >>> 0;
      this.P[i] = (this.P[i] ^ data) >>> 0;
    }
    const block = new Uint32Array(2); // [low, high]
    for (let i = 0; i < 18; i += 2) {
      this.encryptBlock(block);
      this.P[i] = block[0];
      this.P[i + 1] = block[1];
    }
    for (let s = 0; s < 4; s++) {
      for (let j = 0; j < 256; j += 2) {
        this.encryptBlock(block);
        this.S[s][j] = block[0];
        this.S[s][j + 1] = block[1];
      }
    }
  }

  f(x) {
    const S = this.S;
    return ((((S[0][x >>> 24] + S[1][(x >>> 16) & 0xff]) >>> 0) ^ S[2][(x >>> 8) & 0xff]) + S[3][x & 0xff]) >>> 0;
  }

  encryptBlock(block) {
    const P = this.P;
    let low = block[0];
    let high = block[1];
    for (let i = 0; i < 16; i++) {
      low = (low ^ P[i]) >>> 0;
      high = (high ^ this.f(low)) >>> 0;
      const t = low;
      low = high;
      high = t;
    }
    const t = low;
    low = high;
    high = t;
    high = (high ^ P[16]) >>> 0;
    low = (low ^ P[17]) >>> 0;
    block[0] = low;
    block[1] = high;
  }

  decryptBlock(block) {
    const P = this.P;
    let low = block[0];
    let high = block[1];
    for (let i = 17; i > 1; i--) {
      low = (low ^ P[i]) >>> 0;
      high = (high ^ this.f(low)) >>> 0;
      const t = low;
      low = high;
      high = t;
    }
    const t = low;
    low = high;
    high = t;
    high = (high ^ P[1]) >>> 0;
    low = (low ^ P[0]) >>> 0;
    block[0] = low;
    block[1] = high;
  }

  /** Encrypt or decrypt whole 8-byte blocks of `u8` in place (length must be a multiple of 8). */
  process(u8, encrypt) {
    if (u8.length % 8 !== 0) throw new Error('Blowfish: length is not a multiple of 8');
    // Work on an aligned copy so a Uint32Array view is legal; browsers are little-endian, as the format is.
    const aligned = u8.byteOffset % 4 === 0 ? u8 : u8.slice();
    const words = new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.length / 4);
    const block = new Uint32Array(2);
    for (let i = 0; i < words.length; i += 2) {
      block[0] = words[i];
      block[1] = words[i + 1];
      if (encrypt) this.encryptBlock(block);
      else this.decryptBlock(block);
      words[i] = block[0];
      words[i + 1] = block[1];
    }
    if (aligned !== u8) u8.set(aligned);
    return u8;
  }

  encrypt(u8) {
    return this.process(u8, true);
  }

  decrypt(u8) {
    return this.process(u8, false);
  }
}
