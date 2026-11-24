// The .NET Framework number text the desktop editors show and accept (en-US, as on Windows 10/11), so the web views
// print and parse the same values: int/uint/ushort/float TryParse, float custom formats ("0.######", "0.###e+00"),
// N0 thousands, String.Trim and Encoding.ASCII.GetBytes.

const WHITE = '[\\t\\n\\v\\f\\r ]*'; // NumberStyles leading/trailing white space
const INTEGER = new RegExp(`^${WHITE}([+-]?)(\\d+)${WHITE}\\0*$`);
const FLOAT = new RegExp(`^${WHITE}([+-]?)(?:(\\d[\\d,]*)(?:\\.(\\d*))?|\\.(\\d+))(?:[eE]([+-]?\\d+))?${WHITE}\\0*$`);
export const POSITIVE_INFINITY = '\u221e';
export const NEGATIVE_INFINITY = '-\u221e';
export const NAN = 'NaN';
const DOTNET_NAN_BITS = 0xffc00000; // float.NaN as .NET writes it

/** String.Trim(): strips Unicode white space (Char.IsWhiteSpace), not U+FEFF. */
const TRIM_CHARS = '[\t\n\v\f\r \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]+';
const TRIM = new RegExp(`^${TRIM_CHARS}|${TRIM_CHARS}$`, 'g');
export const netTrim = (s) => s.replace(TRIM, '');

/** int/uint/ushort TryParse (NumberStyles.Integer): white space around, one sign ("-0" fits unsigned), range check. */
export function netIntegerTryParse(s, min, max) {
  const m = INTEGER.exec(s ?? '');
  if (!m) return null;
  const v = Number(m[2]) * (m[1] === '-' ? -1 : 1);
  return v >= min && v <= max ? v + 0 : null; // + 0 turns -0 into 0
}
export const netIntTryParse = (s) => netIntegerTryParse(s, -2147483648, 2147483647);
export const netUIntTryParse = (s) => netIntegerTryParse(s, 0, 4294967295);
export const netUShortTryParse = (s) => netIntegerTryParse(s, 0, 65535);

/**
 * float.TryParse (NumberStyles.Float | AllowThousands): "," after a digit is skipped before the point, an all-zero
 * number is +0 ("-0" too), a result past float range fails, and on failure the trimmed text may be \u221e, -\u221e or NaN.
 * @returns {number | null} the float value (NaN for "NaN"), or null when the text doesn't parse
 */
export function netFloatTryParse(s) {
  s ??= '';
  const m = FLOAT.exec(s);
  if (m) {
    const intDigits = (m[2] ?? '').replace(/,/g, '');
    const fracDigits = m[3] ?? m[4] ?? '';
    if (/^0*$/.test(intDigits + fracDigits)) return 0;
    const v = Math.fround(Number(`${m[1]}${intDigits || '0'}.${fracDigits || '0'}e${m[5] ?? '0'}`));
    if (Number.isFinite(v)) return v;
  }
  const t = netTrim(s);
  if (t === POSITIVE_INFINITY) return Infinity;
  if (t === NEGATIVE_INFINITY) return -Infinity;
  if (t === NAN) return NaN;
  return null;
}

/** Writes a float the way BitConverter.GetBytes does (little-endian; NaN as .NET's 0xFFC00000). */
export function setNetFloat(dv, off, f) {
  if (Number.isNaN(f)) dv.setUint32(off, DOTNET_NAN_BITS, true);
  else dv.setFloat32(off, f, true);
}

/** float.ToString(format) for "0.", "0.#…#" and "0.#…#e+00" style formats (one integer digit placeholder). */
export function netFormatFloat(f, format) {
  if (Number.isNaN(f)) return NAN;
  if (f === Infinity) return POSITIVE_INFINITY;
  if (f === -Infinity) return NEGATIVE_INFINITY;
  const m = /^0(?:\.(#*))?(?:(e)\+00)?$/.exec(format);
  if (!m) throw new Error('Unsupported format: ' + format);
  const decimals = (m[1] ?? '').length;
  const scientific = !!m[2];
  // Float → 7 significant digits (rounded half up), then .NET's RoundNumber at the format's last digit.
  let sign = f < 0 || Object.is(f, -0);
  let digits = [];
  let scale = 0;
  if (f !== 0) {
    const [mant, exp] = Math.abs(f).toExponential(6).split('e');
    digits = mant.replace('.', '').split('').map(Number);
    scale = Number(exp) + 1;
    while (digits.length && digits[digits.length - 1] === 0) digits.pop();
  }
  const pos = scientific ? 1 + decimals : scale + decimals;
  let i = 0;
  while (i < pos && i < digits.length) i++;
  if (i === pos && i < digits.length && digits[i] >= 5) {
    while (i > 0 && digits[i - 1] === 9) i--;
    if (i > 0) digits[i - 1]++;
    else {
      scale++;
      digits[0] = 1;
      i = 1;
    }
  } else while (i > 0 && digits[i - 1] === 0) i--;
  if (i === 0) {
    scale = 0;
    sign = false;
  }
  digits.length = i;
  const at = (k) => (k >= 0 && k < digits.length ? digits[k] : 0);
  let intPart;
  let frac = '';
  let expText = '';
  if (scientific) {
    intPart = String(at(0));
    for (let k = 1; k <= decimals; k++) frac += at(k);
    const e = digits.length ? scale - 1 : 0;
    expText = 'e' + (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(2, '0');
  } else {
    intPart = '';
    for (let k = 0; k < scale; k++) intPart += at(k);
    intPart ||= '0';
    for (let k = 0; k < decimals; k++) frac += at(scale + k);
  }
  frac = frac.replace(/0+$/, '');
  return (sign ? '-' : '') + intPart + (frac ? '.' + frac : '') + expText;
}

/** n.ToString("N0") for integers. */
export const netN0 = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Encoding.ASCII.GetBytes: each UTF-16 unit above 0x7F becomes '?'. */
export function netAsciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c > 0x7f ? 0x3f : c;
  }
  return out;
}

/** Encoding.ASCII.GetString: bytes above 0x7F read as '?'. */
export function netAsciiString(bytes) {
  let s = '';
  for (const b of bytes) s += b > 0x7f ? '?' : String.fromCharCode(b);
  return s;
}
