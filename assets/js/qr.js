/* ═══════════════════════════════════════════════════════════════════════
   qr.js — a QR code encoder, written out because the project vendors no
   library for it and artifacts/pages here must stay self-contained.

   Scope: byte mode (so any UTF-8 URL works), error correction level M,
   versions 1–20. That tops out at 666 bytes, which is far more than any
   invite link needs.

   Reference: ISO/IEC 18004. The two lookup tables below are cross-checked
   against each other at run time — see `selfCheck()` — so a typo in either
   one is caught rather than quietly producing an unscannable code.
   ═══════════════════════════════════════════════════════════════════════ */

/* Error-correction level M, per version:
   [ec codewords per block, blocks in group 1, data codewords in a group-1
   block, blocks in group 2, data codewords in a group-2 block] */
const EC_M = {
  1:  [10, 1, 16, 0, 0],
  2:  [16, 1, 28, 0, 0],
  3:  [26, 1, 44, 0, 0],
  4:  [18, 2, 32, 0, 0],
  5:  [24, 2, 43, 0, 0],
  6:  [16, 4, 27, 0, 0],
  7:  [18, 4, 31, 0, 0],
  8:  [22, 2, 38, 2, 39],
  9:  [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
  11: [30, 1, 50, 4, 51],
  12: [22, 6, 36, 2, 37],
  13: [22, 8, 37, 1, 38],
  14: [24, 4, 40, 5, 41],
  15: [24, 5, 41, 5, 42],
  16: [28, 7, 45, 3, 46],
  17: [28, 10, 46, 1, 47],
  18: [26, 9, 43, 4, 44],
  19: [26, 3, 44, 11, 45],
  20: [26, 3, 41, 13, 42]
};

/* Row/column centres of the alignment patterns, per version. */
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62],
  14: [6, 26, 46, 66], 15: [6, 26, 48, 70], 16: [6, 26, 50, 74],
  17: [6, 30, 54, 78], 18: [6, 30, 56, 82], 19: [6, 30, 58, 86],
  20: [6, 34, 62, 90]
};

const EC_BITS_M = 0b00;          // level M's two-bit indicator
const MAX_VERSION = 20;

/* ── GF(256) arithmetic, the field QR's Reed–Solomon lives in ───────── */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function buildTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;   // the primitive polynomial QR uses
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/* The generator polynomial for `n` error-correction codewords:
   (x - α^0)(x - α^1)…(x - α^(n-1)) */
function generator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/* Polynomial long division; the remainder is the error-correction block. */
export function ecCodewords(data, n) {
  const gen = generator(n);
  const rem = new Array(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < n; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

/* ── bit buffer ────────────────────────────────────────────────────── */

class Bits {
  constructor() { this.bits = []; }
  push(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
}

/* ── version choice and the data codeword stream ───────────────────── */

const capacityOf = (v) => {
  const [ec, g1, d1, g2, d2] = EC_M[v];
  return g1 * d1 + g2 * d2;
};

export function chooseVersion(byteLength) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const countBits = v < 10 ? 8 : 16;
    // 4 mode bits + the character count + the payload itself
    if (4 + countBits + byteLength * 8 <= capacityOf(v) * 8) return v;
  }
  throw new Error('That text is too long for a QR code (max ' + MAX_VERSION + ' versions).');
}

function dataCodewords(bytes, version) {
  const total = capacityOf(version);
  const bits = new Bits();
  bits.push(0b0100, 4);                                   // byte mode
  bits.push(bytes.length, version < 10 ? 8 : 16);
  bytes.forEach((b) => bits.push(b, 8));

  // terminator, then pad to a byte boundary
  const room = total * 8 - bits.length;
  bits.push(0, Math.min(4, room));
  while (bits.length % 8) bits.push(0, 1);

  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits.bits[i + j];
    words.push(byte);
  }
  // the two alternating pad codewords the spec specifies
  const PAD = [0xec, 0x11];
  for (let i = 0; words.length < total; i++) words.push(PAD[i % 2]);
  return words;
}

/* Data blocks and their EC blocks are interleaved, not concatenated. */
function interleave(words, version) {
  const [ecCount, g1, d1, g2, d2] = EC_M[version];
  const blocks = [];
  let at = 0;
  for (let i = 0; i < g1; i++) { blocks.push(words.slice(at, at + d1)); at += d1; }
  for (let i = 0; i < g2; i++) { blocks.push(words.slice(at, at + d2)); at += d2; }

  const ecBlocks = blocks.map((b) => ecCodewords(b, ecCount));
  const out = [];
  const longest = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) {
    for (const b of blocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecCount; i++) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return out;
}

/* ── the matrix ────────────────────────────────────────────────────── */

/* `reserved` marks every module that belongs to a function pattern, so the
   data stream knows to skip it. */
function blankMatrix(version) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const put = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    m[r][c] = dark;
    reserved[r][c] = true;
  };

  const finder = (top, left) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        put(top + r, left + c, inRing);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // timing patterns
  for (let i = 8; i < size - 8; i++) {
    put(6, i, i % 2 === 0);
    put(i, 6, i % 2 === 0);
  }

  // alignment patterns, skipping the three finder corners
  const centres = ALIGN[version];
  for (const r of centres) {
    for (const c of centres) {
      const corner = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (corner) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          put(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  put(size - 8, 8, true);                       // the always-dark module

  // Format information areas — filled in later, reserved now. Index 6 is
  // skipped in both directions: those two modules belong to the timing
  // patterns, and blanking them here would break the boundaries a scanner
  // uses to find the module grid.
  for (let i = 0; i < 9; i++) {
    if (i === 6) continue;
    put(8, i, false);
    put(i, 8, false);
  }
  for (let i = 0; i < 8; i++) { put(8, size - 1 - i, false); put(size - 1 - i, 8, false); }

  // version information blocks, versions 7 and up
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = Math.floor(i / 3);
      const b = i % 3;
      put(size - 11 + b, a, false);
      put(a, size - 11 + b, false);
    }
  }

  return { m, reserved, size };
}

/* Two modules wide, bottom-right to top-left, snaking upward then down. */
export function placementOrder(reserved, size) {
  const order = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--;                 // the vertical timing column is skipped
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const col of [right, right - 1]) {
        if (!reserved[row][col]) order.push([row, col]);
      }
    }
    upward = !upward;
  }
  return order;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

/* BCH(15,5), then XORed with the spec's fixed pattern. */
export function formatBits(ecBits, mask) {
  const data = (ecBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412;
}

/* BCH(18,6) for the version blocks. */
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | (rem & 0xfff);
}

function writeFormat(m, size, mask) {
  const bits = formatBits(EC_BITS_M, mask);
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) m[8][i] = bit(i);
  m[8][7] = bit(6);
  m[8][8] = bit(7);
  m[7][8] = bit(8);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(i);

  for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = bit(i);
  for (let i = 8; i <= 14; i++) m[8][size - 15 + i] = bit(i);
  m[size - 8][8] = true;                      // dark module, never overwritten
}

function writeVersion(m, size, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const on = ((bits >>> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const b = i % 3;
    m[size - 11 + b][a] = on;
    m[a][size - 11 + b] = on;
  }
}

/* ── mask scoring, so the chosen pattern is the spec's ──────────────── */

function penalty(m, size) {
  let score = 0;

  const runScore = (line) => {
    let total = 0;
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (line[i] === line[i - 1]) run++;
      else { if (run >= 5) total += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };
  for (let i = 0; i < size; i++) {
    score += runScore(m[i]);
    score += runScore(m.map((row) => row[i]));
  }

  // rule 2: every 2×2 block of one colour
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // rule 3: the finder-like 1:1:3:1:1 sequence, with four light modules beside it
  const PATTERN = [true, false, true, true, true, false, true];
  const hasAt = (line, i) => {
    for (let k = 0; k < 7; k++) if (line[i + k] !== PATTERN[k]) return false;
    const before = line.slice(Math.max(0, i - 4), i);
    const after = line.slice(i + 7, i + 11);
    const clear = (arr) => arr.length >= 4 && arr.every((x) => x === false);
    return clear(before) || clear(after);
  };
  for (let i = 0; i < size; i++) {
    const row = m[i];
    const col = m.map((r) => r[i]);
    for (let j = 0; j + 7 <= size; j++) {
      if (hasAt(row, j)) score += 40;
      if (hasAt(col, j)) score += 40;
    }
  }

  // rule 4: how far the dark/light balance strays from half
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/* ── the public entry point ────────────────────────────────────────── */

const toBytes = (text) => Array.from(new TextEncoder().encode(text));

/**
 * Encode text as a QR matrix.
 * @returns {{ modules: boolean[][], size: number, version: number, mask: number }}
 */
export function encode(text, opts = {}) {
  const bytes = toBytes(String(text));
  const version = opts.version || chooseVersion(bytes.length);
  const codewords = interleave(dataCodewords(bytes, version), version);

  const { m, reserved, size } = blankMatrix(version);
  const order = placementOrder(reserved, size);

  // any modules past the end of the stream are remainder bits, left light
  order.forEach(([r, c], i) => {
    const byte = codewords[i >> 3];
    m[r][c] = byte === undefined ? false : ((byte >>> (7 - (i & 7))) & 1) === 1;
  });

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = m.map((row) => row.slice());
    for (const [r, c] of order) {
      if (MASKS[mask](r, c)) candidate[r][c] = !candidate[r][c];
    }
    writeFormat(candidate, size, mask);
    writeVersion(candidate, size, version);
    const score = penalty(candidate, size);
    if (!best || score < best.score) best = { score, mask, modules: candidate };
  }

  return { modules: best.modules, size, version, mask: best.mask };
}

/* ── rendering ─────────────────────────────────────────────────────── */

/**
 * An SVG string. Scales to whatever box it is put in, and stays crisp.
 * `dark`/`light` accept any CSS colour, including a var().
 */
export function toSVG(text, opts = {}) {
  const { modules, size } = encode(text, opts);
  const margin = opts.margin == null ? 4 : opts.margin;   // the spec's quiet zone
  const total = size + margin * 2;

  // one path for every dark module keeps the file small and the edges sharp
  let d = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${total}" height="${total}" fill="${opts.light || '#ffffff'}"/>` +
    `<path d="${d}" fill="${opts.dark || '#101c24'}"/></svg>`;
}

/** A PNG data URL, for downloading. `scale` is pixels per module. */
export function toPNG(text, opts = {}) {
  const { modules, size } = encode(text, opts);
  const margin = opts.margin == null ? 4 : opts.margin;
  const scale = opts.scale || 10;
  const total = (size + margin * 2) * scale;

  const canvas = document.createElement('canvas');
  canvas.width = total;
  canvas.height = total;
  const g = canvas.getContext('2d');
  g.fillStyle = opts.light || '#ffffff';
  g.fillRect(0, 0, total, total);
  g.fillStyle = opts.dark || '#101c24';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) g.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
    }
  }
  return canvas.toDataURL('image/png');
}

/* ── self-check ────────────────────────────────────────────────────────
   The two tables above come from the spec and are easy to mistype, so they
   are checked against each other: the number of free modules in a built
   matrix, divided by eight, has to equal the codeword total the EC table
   implies. A wrong alignment row or a wrong block count breaks that.
   ─────────────────────────────────────────────────────────────────── */

export function selfCheck() {
  const problems = [];
  for (let v = 1; v <= MAX_VERSION; v++) {
    const { reserved, size } = blankMatrix(v);
    let free = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!reserved[r][c]) free++;

    const [ec, g1, d1, g2, d2] = EC_M[v];
    const fromTable = (g1 * (d1 + ec)) + (g2 * (d2 + ec));
    const fromMatrix = Math.floor(free / 8);
    if (fromTable !== fromMatrix) {
      problems.push(`v${v}: EC table says ${fromTable} codewords, the matrix has room for ${fromMatrix}`);
    }
    if (g2 && d2 !== d1 + 1) problems.push(`v${v}: group 2 blocks should hold one more codeword than group 1`);
  }
  return problems;
}
