// Game JSON. Every .json file in the game's Data folder has // and /* */ comments, so strict JSON.parse rejects
// all of them. HappyTool reads them with Json.NET's CommentHandling.Ignore; this does the same.

const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13;

/** Blank out comments with spaces (line breaks kept), so the text keeps its length and parse errors point at the right place. */
export function stripJsonComments(text) {
  const parts = [];
  let i = 0;
  let last = 0;
  let comments = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 34) {
      // string: skip to the closing quote, stepping over escapes
      i++;
      while (i < n && text.charCodeAt(i) !== 34) i += text.charCodeAt(i) === 92 ? 2 : 1;
      i++;
    } else if (c === 47 && (text[i + 1] === '/' || text[i + 1] === '*')) {
      let end;
      if (text[i + 1] === '/') {
        end = text.indexOf('\n', i);
        if (end < 0) end = n;
      } else {
        end = text.indexOf('*/', i + 2);
        end = end < 0 ? n : end + 2;
      }
      parts.push(text.slice(last, i), text.slice(i, end).replace(/[^\r\n]/g, ' '));
      comments++;
      i = last = end;
    } else i++;
  }
  parts.push(text.slice(last));
  return { text: parts.join(''), comments };
}

/** Parse game JSON. Returns the value, the comment count and the comment-free text; throws SyntaxError like JSON.parse. */
export function parseGameJson(text) {
  const { text: clean, comments } = stripJsonComments(text);
  return { value: JSON.parse(clean), comments, clean };
}

/**
 * Re-indent valid, comment-free JSON token by token (indent 0 minifies). Strings and numbers are copied exactly as
 * written, so 1.0 stays 1.0 and long integers keep every digit, which a JSON.parse / JSON.stringify round trip would not.
 */
export function reindentJson(clean, indent = 2, eol = '\n') {
  const out = [];
  const n = clean.length;
  let depth = 0;
  let i = 0;
  const br = () => (indent ? eol + ' '.repeat(indent * depth) : '');
  while (i < n) {
    const c = clean.charCodeAt(i);
    const ch = clean[i];
    if (isWs(c)) {
      i++;
    } else if (c === 34) {
      let j = i + 1;
      while (j < n && clean.charCodeAt(j) !== 34) j += clean.charCodeAt(j) === 92 ? 2 : 1;
      out.push(clean.slice(i, j + 1));
      i = j + 1;
    } else if (ch === '{' || ch === '[') {
      let j = i + 1;
      while (j < n && isWs(clean.charCodeAt(j))) j++;
      if (clean[j] === (ch === '{' ? '}' : ']')) {
        out.push(ch + clean[j]); // empty container stays on one line
        i = j + 1;
      } else {
        depth++;
        out.push(ch + br());
        i++;
      }
    } else if (ch === '}' || ch === ']') {
      depth--;
      out.push(br() + ch);
      i++;
    } else if (ch === ',') {
      out.push(',' + br());
      i++;
    } else if (ch === ':') {
      out.push(indent ? ': ' : ':');
      i++;
    } else {
      // number, true, false or null
      let j = i;
      while (j < n && !isWs(clean.charCodeAt(j)) && !',:]}'.includes(clean[j])) j++;
      out.push(clean.slice(i, j));
      i = j;
    }
  }
  return out.join('');
}
