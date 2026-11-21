// Squirrel script (.nut) text: tokens for highlighting, the functions and classes it defines (outline, go to
// definition), and what sits under the caret (code assist). Squirrel 2/3 syntax as the game's scripts use it.

export const KEYWORDS = new Set(
  ('base break case catch class clone const continue default delete else enum extends for foreach function if in ' +
    'instanceof local null resume return static switch this throw try typeof while yield constructor true false ' +
    '__LINE__ __FILE__').split(' '),
);

/**
 * Splits the text into tokens: {t: type, s: start, e: end}. Types: 'comment', 'string', 'number', 'keyword', 'ident',
 * 'op', 'space'. Every character belongs to one token, so joining them gives the text back.
 */
export function tokenize(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  const push = (t, s, e) => out.push({ t, s, e });
  while (i < n) {
    const c = text[i];
    const s = i;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      while (i < n && /[ \t\r\n]/.test(text[i])) i++;
      push('space', s, i);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      push('comment', s, i);
    } else if (c === '#') {
      while (i < n && text[i] !== '\n') i++;
      push('comment', s, i);
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      push('comment', s, i);
    } else if (c === '@' && text[i + 1] === '"') {
      // Verbatim string: no escapes, "" is a quote, may span lines.
      i += 2;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      push('string', s, i);
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
      if (text[i] === c) i++;
      push('string', s, Math.min(i, n));
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
      if (c === '0' && /[xX]/.test(text[i + 1] || '')) {
        i += 2;
        while (i < n && /[0-9a-fA-F]/.test(text[i])) i++;
      } else {
        while (i < n && /[0-9.]/.test(text[i])) i++;
        if (/[eE]/.test(text[i] || '')) {
          i++;
          if (/[+-]/.test(text[i] || '')) i++;
          while (i < n && /[0-9]/.test(text[i])) i++;
        }
      }
      push('number', s, i);
    } else if (/[A-Za-z_]/.test(c)) {
      while (i < n && /[A-Za-z0-9_]/.test(text[i])) i++;
      push(KEYWORDS.has(text.slice(s, i)) ? 'keyword' : 'ident', s, i);
    } else {
      i++;
      push('op', s, i);
    }
  }
  return out;
}

/**
 * The functions and classes the script defines, in order: {kind: 'function'|'class'|'method'|'enum'|'const'|'global',
 * name, owner?, params?, line (0-based), pos}. Found from the tokens, so names inside comments and strings don't count.
 */
export function outline(text, tokens = tokenize(text)) {
  const code = tokens.filter((t) => t.t !== 'space' && t.t !== 'comment');
  const word = (k) => (code[k] ? text.slice(code[k].s, code[k].e) : '');
  const lineAt = lineIndex(text);
  const items = [];
  const classes = []; // [{name, depth}] open class bodies
  let depth = 0;
  for (let k = 0; k < code.length; k++) {
    const w = word(k);
    if (code[k].t === 'op') {
      if (w === '{') depth++;
      else if (w === '}') {
        depth--;
        if (classes.length && classes.at(-1).depth === depth) classes.pop();
      }
      continue;
    }
    const owner = classes.at(-1)?.depth === depth - 1 ? classes.at(-1).name : null;
    if (w === 'function' && code[k + 1]?.t === 'ident') {
      // function Name(...)  or  function Class::Name(...)
      let j = k + 1;
      let name = word(j);
      let cls = owner;
      while (word(j + 1) === ':' && word(j + 2) === ':' && code[j + 3]?.t === 'ident') {
        cls = name;
        j += 3;
        name = word(j);
      }
      const params = word(j + 1) === '(' ? paramsAt(j + 1) : '';
      items.push({ kind: cls ? 'method' : 'function', name, owner: cls || undefined, params, line: lineAt(code[j].s), pos: code[j].s });
    } else if (w === 'constructor' && owner && word(k + 1) === '(') {
      items.push({ kind: 'method', name: 'constructor', owner, params: paramsAt(k + 1), line: lineAt(code[k].s), pos: code[k].s });
    } else if (w === 'class' && code[k + 1]?.t === 'ident') {
      const name = word(k + 1);
      items.push({ kind: 'class', name, line: lineAt(code[k + 1].s), pos: code[k + 1].s });
      let j = k + 2;
      while (j < code.length && word(j) !== '{' && word(j) !== ';') j++;
      if (word(j) === '{') {
        classes.push({ name, depth });
        depth++;
        k = j;
      }
    } else if ((w === 'enum' || w === 'const') && code[k + 1]?.t === 'ident' && depth === 0) {
      items.push({ kind: w, name: word(k + 1), line: lineAt(code[k + 1].s), pos: code[k + 1].s });
    } else if (depth === 0 && code[k].t === 'ident' && word(k + 1) === '<' && word(k + 2) === '-' && word(k - 1) !== '.') {
      // Name <- value  (a new slot in the root table: the scripts' globals)
      const fn = word(k + 3) === 'function';
      items.push({ kind: fn ? 'function' : 'global', name: w, params: fn && word(k + 4) === '(' ? paramsAt(k + 4) : undefined, line: lineAt(code[k].s), pos: code[k].s });
    }
  }
  return items;

  function paramsAt(open) {
    let j = open + 1;
    const names = [];
    while (j < code.length && word(j) !== ')') {
      if (code[j].t === 'ident' || word(j) === '...') names.push(word(j));
      if (word(j) === '=') {
        // skip a default value up to the next comma at this level
        let d = 0;
        while (j + 1 < code.length && !(d === 0 && (word(j + 1) === ',' || word(j + 1) === ')'))) {
          j++;
          if (word(j) === '(' || word(j) === '[') d++;
          else if (word(j) === ')' || word(j) === ']') d--;
        }
      }
      j++;
    }
    return names.join(', ');
  }
}

/** A function from a character position to its 0-based line. */
export function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (pos) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
}

/** The identifier around this position (letters, digits, _), with its start and end; null when there is none. */
export function wordAt(text, pos) {
  let s = pos, e = pos;
  while (s > 0 && /[A-Za-z0-9_]/.test(text[s - 1])) s--;
  while (e < text.length && /[A-Za-z0-9_]/.test(text[e])) e++;
  return s < e && /[A-Za-z_]/.test(text[s]) ? { word: text.slice(s, e), s, e } : null;
}

/** The call the caret sits inside: {name, arg (0-based index of the argument), open (position of the '(')}, or null. */
export function callAt(text, pos) {
  // Walks back over the tokens of the last 2,000 characters, so commas and brackets in strings and comments don't count.
  const from = Math.max(0, pos - 2000);
  const toks = tokenize(text.slice(from, pos)).filter((t) => t.t === 'op' || t.t === 'ident');
  let depth = 0, arg = 0;
  for (let k = toks.length - 1; k >= 0; k--) {
    if (toks[k].t !== 'op') continue;
    const c = text[from + toks[k].s];
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') {
      if (depth === 0) {
        const prev = toks[k - 1];
        if (c === '[' || prev?.t !== 'ident') return null;
        const name = text.slice(from + prev.s, from + prev.e);
        return KEYWORDS.has(name) ? null : { name, arg, open: from + toks[k].s };
      }
      depth--;
    } else if (c === ',' && depth === 0) arg++;
    else if ((c === ';' || c === '{' || c === '}') && depth === 0) return null;
  }
  return null;
}
