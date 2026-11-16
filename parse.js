// markfast — a fast drop-in for marked 18.1.3 (default options: gfm on,
// breaks off, pedantic off, async off). Single-pass design: the block
// parser works over line views with virtual columns, then an inline scanner
// with a delimiter stack turns paragraph text straight into HTML. No token
// tree, no dependencies, Node built-ins only.

// ---------------------------------------------------------------------------
// Character codes and small predicates
// ---------------------------------------------------------------------------

const C_SP = 32;
const C_TAB = 9;
const C_LF = 10;
const C_CR = 13;
const C_BANG = 33;
const C_DQ = 34;
const C_HASH = 35;
const C_AMP = 38;
const C_SQ = 39;
const C_LP = 40;
const C_RP = 41;
const C_STAR = 42;
const C_PLUS = 43;
const C_MINUS = 45;
const C_DOT = 46;
const C_SLASH = 47;
const C_COLON = 58;
const C_LT = 60;
const C_EQ = 61;
const C_GT = 62;
const C_AT = 64;
const C_LB = 91;
const C_BS = 92;
const C_RB = 93;
const C_UNDER = 95;
const C_BT = 96;
const C_PIPE = 124;
const C_TILDE = 126;

function isSpTab(c) {
  return c === C_SP || c === C_TAB;
}

// ASCII punctuation (CommonMark set): !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

const PUNCT_RE = /[\p{P}\p{S}]/u;
const WS_RE = /\s/;
function isPunctCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isAsciiPunct(c);
  return PUNCT_RE.test(ch);
}
function isWsCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
  return WS_RE.test(ch);
}

// ---------------------------------------------------------------------------
// Escaping. marked's escape(html, encode):
//  encode=true  -> escape & < > " ' always.
//  encode=false -> escape < > " ' always; escape & only when it does NOT
//                  start a valid entity reference (&#digits; | &#xhex; | &word;).
// Numeric character references are decoded first: &#35; -> '#', &#0; / out
// of range / surrogate -> U+FFFD, &#38; -> '&amp;'.
// ---------------------------------------------------------------------------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_NOENC_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;

function decodeNumRefsFull(s) {
  if (s.indexOf('&#') === -1) return s;
  return s.replace(/&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/g, (_m, dec, hex) => {
    const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

function escapeEncode(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);
}

function escapeText(s) {
  s = decodeNumRefsFull(s);
  if (!ESC_NOENC_TEST.test(s)) return s;
  return s.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (ch) => ESC_MAP[ch]);
}

// cleanUrl: encodeURI, then %25 -> % (marked's cleanUrl). Null on failure.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Line views. A view is { s, col, ind, cs, term }:
//   s    - the line's raw text (without the trailing '\n')
//   col  - the virtual column of s[0] in the original document line
//   ind  - virtual columns of leading whitespace (tabs expanded), -1 = unknown
//   cs   - index of the first non-whitespace char in s (s.length if blank)
//   term - true when the line is terminated by '\n' in the source
// Tabs expand to the next multiple of 4 columns, counted from the line's
// column origin; a partially consumed tab materialises as spaces, which keeps
// every later tab's width identical to the original line's.
// ---------------------------------------------------------------------------

function measure(v) {
  if (v.ind !== -1) return v;
  const s = v.s;
  let col = v.col;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === C_SP) {
      col++;
      i++;
    } else if (c === C_TAB) {
      col += 4 - (col & 3);
      i++;
    } else break;
  }
  v.ind = col - v.col;
  v.cs = i;
  return v;
}

// Cut n columns of leading whitespace (spaces/tabs, expanded by column).
// Returns a fresh view. If the line has fewer than n whitespace columns, the
// result starts at the first non-whitespace char (or the end).
function cutCols(v, n, expandTabs = true) {
  const s = v.s;
  let col = v.col;
  let i = 0;
  let m = n;
  while (m > 0 && i < s.length) {
    const c = s.charCodeAt(i);
    if (c === C_SP) {
      i++;
      col++;
      m--;
    } else if (c === C_TAB) {
      const w = 4 - (col & 3);
      if (w <= m) {
        i++;
        col += w;
        m -= w;
      } else {
        const rem = w - m;
        return { s: ' '.repeat(rem) + s.slice(i + 1), col: col + m, ind: -1, cs: -1, term: v.term };
      }
    } else break;
  }
  // A tab at the cut boundary becomes content now: expand it to spaces from
  // its absolute column — but only when something was actually cut (n > 0)
  // and the caller wants it. A top-level fence (cut 0) keeps a literal tab;
  // a list-item fence (cut > 0) expands the tab at its column to spaces.
  // Indented code keeps a literal tab after the 4-column cut.
  if (n > 0 && expandTabs) {
    let out = s.slice(i);
    let c2 = col;
    let j = 0;
    while (j < out.length && out.charCodeAt(j) === C_TAB) {
      const w = 4 - (c2 & 3);
      out = out.slice(0, j) + ' '.repeat(w) + out.slice(j + 1);
      j += w;
      c2 += w;
    }
    return { s: out, col, ind: -1, cs: -1, term: v.term };
  }
  return { s: s.slice(i), col, ind: -1, cs: -1, term: v.term };
}

// Cut n raw characters (a marker such as '>' or '-').
function cutChars(v, n) {
  return { s: v.s.slice(n), col: v.col + n, ind: -1, cs: -1, term: v.term };
}

// Expand the leading whitespace of a view to spaces (tab stops from v.col).
function expandLead(v) {
  measure(v);
  if (v.cs === 0) return v;
  const s = v.s;
  let col = v.col;
  let out = '';
  for (let i = 0; i < v.cs; i++) {
    const c = s.charCodeAt(i);
    if (c === C_SP) {
      out += ' ';
      col++;
    } else {
      const w = 4 - (col & 3);
      out += ' '.repeat(w);
      col += w;
    }
  }
  return { s: out + s.slice(v.cs), col: v.col, ind: v.ind, cs: out.length, term: v.term };
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

function normLabel(label) {
  // Unicode case folding: 'ß'/'ẞ' fold to 'ss' (cm-540: [ẞ] matches [SS]).
  return label.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss').replace(/ẞ/g, 'ss');
}

// Resolve backslash escapes in a link destination / title: \ + ASCII punct -> punct.
function unescBs(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === C_BS && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i += 2;
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

function skipSpcNl(txt, p) {
  while (p < txt.length && (txt.charCodeAt(p) === C_SP || txt.charCodeAt(p) === C_TAB)) p++;
  if (p < txt.length && txt.charCodeAt(p) === C_LF) {
    p++;
    while (p < txt.length && (txt.charCodeAt(p) === C_SP || txt.charCodeAt(p) === C_TAB)) p++;
  }
  return p;
}

// Try to parse a link reference definition starting at line i.
// Returns the number of lines consumed (1+), or 0 when it is not a definition.
function tryRefDef(views, i, to, ctx) {
  const v = measure(views[i]);
  if (v.ind > 3) return 0;
  const s0 = v.s;
  const cs = v.cs;
  if (s0.charCodeAt(cs) !== C_LB) return 0;
  // A definition may span several lines (a multi-line title); gather the
  // following non-blank lines (up to 9 more).
  let txt = s0.slice(cs);
  for (let k = 1; k <= 9 && i + k < to; k++) {
    const vk = views[i + k];
    let blank = true;
    for (let j = 0; j < vk.s.length; j++) {
      const c = vk.s.charCodeAt(j);
      if (c !== C_SP && c !== C_TAB) { blank = false; break; }
    }
    if (blank) break;
    txt += '\n' + vk.s;
  }
  // Label: '[' balanced brackets, escapes, 1..999 chars, not blank.
  let p = 1;
  let depth = 1;
  const labelStart = 1;
  while (p < txt.length) {
    const c = txt.charCodeAt(p);
    if (c === C_BS) { p += 2; continue; }
    // A link label cannot contain an unescaped '[' (cm-547).
    if (c === C_LB) return 0;
    if (c === C_RB) {
      depth--;
      if (depth === 0) break;
      p++;
      continue;
    }
    p++;
  }
  if (depth !== 0) return 0;
  const labelRaw = txt.slice(labelStart, p);
  if (labelRaw.length === 0 || labelRaw.length > 999) return 0;
  if (/^\s*$/.test(labelRaw)) return 0;
  p++; // skip ']'
  while (p < txt.length && (txt.charCodeAt(p) === C_SP || txt.charCodeAt(p) === C_TAB)) p++;
  if (txt.charCodeAt(p) !== C_COLON) return 0;
  p++;
  p = skipSpcNl(txt, p);
  // Destination.
  let href;
  let destEnd;
  if (txt.charCodeAt(p) === C_LT) {
    let q = p + 1;
    let ok = false;
    while (q < txt.length) {
      const c = txt.charCodeAt(q);
      if (c === C_LF || c === C_LT) break;
      if (c === C_BS) { q += 2; continue; }
      if (c === C_GT) { ok = true; break; }
      q++;
    }
    if (!ok) return 0;
    href = txt.slice(p + 1, q);
    destEnd = q + 1;
  } else {
    let q = p;
    let d = 0;
    while (q < txt.length) {
      const c = txt.charCodeAt(q);
      if (c <= 32) break;
      if (c === C_BS) { q += 2; continue; }
      if (c === C_LP) { d++; q++; continue; }
      if (c === C_RP) {
        if (d === 0) break;
        d--;
        q++;
        continue;
      }
      q++;
    }
    if (q === p) return 0;
    href = txt.slice(p, q);
    destEnd = q;
  }
  // Optional title. A title on the SAME line as the destination must be
  // separated from it by whitespace and must be followed by only whitespace
  // up to the end of the line; otherwise the definition is invalid. A title
  // on the NEXT line is optional: if it does not parse cleanly, the
  // definition is still valid without a title.
  let title = null;
  let endP = destEnd;
  let q = destEnd;
  while (q < txt.length && (txt.charCodeAt(q) === C_SP || txt.charCodeAt(q) === C_TAB)) q++;
  if (q < txt.length && txt.charCodeAt(q) !== C_LF) {
    // Non-whitespace on the destination's line: it must be a title, and it
    // must have been separated from the destination by whitespace.
    if (q === destEnd) return 0;
    const tc = txt.charCodeAt(q);
    if (tc !== C_DQ && tc !== C_SQ && tc !== C_LP) return 0;
    const close = tc === C_LP ? C_RP : tc;
    let r = q + 1;
    let ok = false;
    while (r < txt.length) {
      const c = txt.charCodeAt(r);
      if (c === C_BS) { r += 2; continue; }
      if (c === close) { ok = true; break; }
      r++;
    }
    if (!ok) return 0;
    title = txt.slice(q + 1, r);
    endP = r + 1;
    while (endP < txt.length && (txt.charCodeAt(endP) === C_SP || txt.charCodeAt(endP) === C_TAB)) endP++;
    if (endP < txt.length && txt.charCodeAt(endP) !== C_LF) return 0;
  } else {
    // The rest of the destination's line is whitespace: look for a title on
    // the next line; if it does not parse cleanly, keep no title.
    const tq = skipSpcNl(txt, q);
    const tc = txt.charCodeAt(tq);
    if (tc === C_DQ || tc === C_SQ || tc === C_LP) {
      const close = tc === C_LP ? C_RP : tc;
      let r = tq + 1;
      let ok = false;
      while (r < txt.length) {
        const c = txt.charCodeAt(r);
        if (c === C_BS) { r += 2; continue; }
        if (c === close) { ok = true; break; }
        r++;
      }
      if (ok) {
        let p2 = r + 1;
        while (p2 < txt.length && (txt.charCodeAt(p2) === C_SP || txt.charCodeAt(p2) === C_TAB)) p2++;
        if (p2 >= txt.length || txt.charCodeAt(p2) === C_LF) {
          title = txt.slice(tq + 1, r);
          endP = p2;
        }
      }
    }
    if (title === null) endP = q;
  }
  const label = normLabel(labelRaw);
  if (!ctx.refs.has(label)) {
    ctx.refs.set(label, { href: unescBs(href), title: title === null ? null : unescBs(title) });
  }
  let consumed = 1;
  for (let k = 0; k < endP; k++) if (txt.charCodeAt(k) === C_LF) consumed++;
  return consumed;
}

// ---------------------------------------------------------------------------
// Tables (GFM): split a row into cells, marked's `de`.
// ---------------------------------------------------------------------------

function splitRow(row, expected) {
  // Replace each unescaped '|' with ' |' (escaped ones stay '|'), then split on ' |'.
  let t = '';
  for (let i = 0; i < row.length; i++) {
    const c = row.charCodeAt(i);
    if (c === C_PIPE) {
      let escaped = false;
      let j = i - 1;
      while (j >= 0 && row.charCodeAt(j) === C_BS) {
        escaped = !escaped;
        j--;
      }
      t += escaped ? '|' : ' |';
    } else {
      t += row[i];
    }
  }
  const parts = t.split(' |');
  if (parts.length === 0) return [];
  if (!parts[0].trim()) parts.shift();
  if (parts.length > 0 && !parts[parts.length - 1].trim()) parts.pop();
  if (expected !== undefined) {
    if (parts.length > expected) parts.length = expected;
    while (parts.length < expected) parts.push('');
  }
  for (let s = 0; s < parts.length; s++) {
    parts[s] = parts[s].trim().replace(/\\\|/g, '|');
  }
  return parts;
}

// If the view is a table delimiter row, return the alignments array, else null.
function delimRow(v) {
  measure(v);
  if (v.ind > 3) return null;
  const s = v.s;
  let i = v.cs;
  const n = s.length;
  const aligns = [];
  while (i < n && (s.charCodeAt(i) === C_SP || s.charCodeAt(i) === C_TAB)) i++;
  if (i < n && s.charCodeAt(i) === C_PIPE) i++;
  while (true) {
    while (i < n && (s.charCodeAt(i) === C_SP || s.charCodeAt(i) === C_TAB)) i++;
    let left = false;
    let right = false;
    if (i < n && s.charCodeAt(i) === C_COLON) { left = true; i++; }
    let dashes = 0;
    while (i < n && s.charCodeAt(i) === C_MINUS) { dashes++; i++; }
    if (dashes === 0) return null;
    if (i < n && s.charCodeAt(i) === C_COLON) { right = true; i++; }
    while (i < n && (s.charCodeAt(i) === C_SP || s.charCodeAt(i) === C_TAB)) i++;
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
    if (i >= n) break;
    if (s.charCodeAt(i) !== C_PIPE) return null;
    i++;
    if (i >= n) break; // trailing '|' is fine
  }
  return aligns.length > 0 ? aligns : null;
}

// ---------------------------------------------------------------------------
// Block-start recognisers (all require indent <= 3 unless noted)
// ---------------------------------------------------------------------------

function setextLevel(v) {
  measure(v);
  if (v.ind > 3) return 0;
  const s = v.s;
  let i = v.cs;
  if (i >= s.length) return 0;
  const c = s.charCodeAt(i);
  if (c !== C_EQ && c !== C_MINUS) return 0;
  let j = i;
  while (j < s.length && s.charCodeAt(j) === c) j++;
  while (j < s.length && (s.charCodeAt(j) === C_SP || s.charCodeAt(j) === C_TAB)) j++;
  if (j !== s.length) return 0;
  return c === C_EQ ? 1 : 2;
}

function fenceHead(v) {
  measure(v);
  if (v.ind > 3) return null;
  const s = v.s;
  let i = v.cs;
  if (i >= s.length) return null;
  const ch = s.charCodeAt(i);
  if (ch !== C_BT && ch !== C_TILDE) return null;
  let j = i;
  while (j < s.length && s.charCodeAt(j) === ch) j++;
  const len = j - i;
  if (len < 3) return null;
  const info = s.slice(j);
  if (ch === C_BT && info.indexOf('`') !== -1) return null;
  const lang = unescBs(info.trim().split(/[ \t]+/, 1)[0] || '');
  return { ch, len, lang, ind: v.ind };
}

function atxHead(v) {
  measure(v);
  if (v.ind > 3) return null;
  const s = v.s;
  let i = v.cs;
  if (i >= s.length || s.charCodeAt(i) !== C_HASH) return null;
  let j = i;
  while (j < s.length && s.charCodeAt(j) === C_HASH) j++;
  const level = j - i;
  if (level > 6) return null;
  if (j < s.length && s.charCodeAt(j) !== C_SP && s.charCodeAt(j) !== C_TAB) return null;
  // Content: skip spaces/tabs, strip trailing spaces and a trailing '#' run.
  let k = j;
  while (k < s.length && (s.charCodeAt(k) === C_SP || s.charCodeAt(k) === C_TAB)) k++;
  let end = s.length;
  while (end > k && (s.charCodeAt(end - 1) === C_SP || s.charCodeAt(end - 1) === C_TAB)) end--;
  let e2 = end;
  while (e2 > k && s.charCodeAt(e2 - 1) === C_HASH) e2--;
  if (e2 < end && e2 >= k && (s.charCodeAt(e2 - 1) === C_SP || s.charCodeAt(e2 - 1) === C_TAB)) {
    end = e2;
    while (end > k && (s.charCodeAt(end - 1) === C_SP || s.charCodeAt(end - 1) === C_TAB)) end--;
  }
  return { level, text: s.slice(k, end) };
}

function isRule(v) {
  measure(v);
  if (v.ind > 3) return false;
  const s = v.s;
  let i = v.cs;
  if (i >= s.length) return false;
  const ch = s.charCodeAt(i);
  if (ch !== C_MINUS && ch !== C_UNDER && ch !== C_STAR) return false;
  let count = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === ch) {
      count++;
      i++;
    } else if (c === C_SP || c === C_TAB) {
      i++;
    } else return false;
  }
  return count >= 3;
}

function isQuote(v) {
  measure(v);
  if (v.ind > 3) return false;
  return v.s.charCodeAt(v.cs) === C_GT;
}

// List marker info, or null. markerEnd = raw index just after the marker.
function listMark(v) {
  measure(v);
  if (v.ind > 3) return null;
  const s = v.s;
  const cs = v.cs;
  if (cs >= s.length) return null;
  const c = s.charCodeAt(cs);
  if (c === C_MINUS || c === C_PLUS || c === C_STAR) {
    if (cs + 1 < s.length && s.charCodeAt(cs + 1) !== C_SP && s.charCodeAt(cs + 1) !== C_TAB) return null;
    return { ordered: false, bullet: c, delim: 0, start: 0, markerEnd: cs + 1, markerCol: v.col + v.ind + 1 };
  }
  if (c >= 48 && c <= 57) {
    let j = cs;
    while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    if (j - cs > 9) return null;
    if (j >= s.length) return null;
    const d = s.charCodeAt(j);
    if (d !== C_DOT && d !== C_RP) return null;
    if (j + 1 < s.length && s.charCodeAt(j + 1) !== C_SP && s.charCodeAt(j + 1) !== C_TAB) return null;
    return { ordered: true, bullet: 0, delim: d, start: parseInt(s.slice(cs, j), 10), markerEnd: j + 1, markerCol: v.col + v.ind + (j + 1 - cs) };
  }
  return null;
}

// Content indent of a list item + the content view of its first line.
function itemBody(v, lm) {
  // Strip leading indent, then the marker.
  let w = cutCols(v, v.ind);
  w = cutChars(w, lm.markerEnd - v.cs);
  // Expanded separator width from the marker column.
  const s = w.s;
  let i = 0;
  let col = w.col;
  let sepW = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === C_SP) { sepW++; col++; i++; }
    else if (c === C_TAB) { const tw = 4 - (col & 3); sepW += tw; col += tw; i++; }
    else break;
  }
  let contentIndent;
  let stripN;
  if (sepW === 0) {
    contentIndent = lm.markerCol + 1;
    stripN = 0;
  } else if (sepW <= 4) {
    contentIndent = lm.markerCol + sepW;
    stripN = sepW;
  } else {
    contentIndent = lm.markerCol + 1;
    stripN = 1;
  }
  // An empty item's content indent is the marker column + 1, regardless of
  // how much trailing whitespace follows the marker (cm-279: '-   ' has
  // content indent 2, so '  foo' is its content and '   foo' loses 2).
  // Its content line is empty.
  if (i >= s.length) {
    return { contentIndent: lm.markerCol + 1, content: { s: '', col: w.col, ind: 0, cs: 0, term: w.term }, empty: true };
  }
  const content = cutCols(w, stripN);
  return { contentIndent, content, empty: false };
}

// HTML block types. Returns { type, tag } or null.
const BLOCK_TAGS = new Set(
  ('address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul').split('|'),
);

function htmlKind(v) {
  measure(v);
  if (v.ind > 3) return null;
  const s = v.s;
  const i = v.cs;
  if (i >= s.length || s.charCodeAt(i) !== C_LT) return null;
  const rest = s.slice(i);
  let m = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(rest);
  if (m) return { type: 1, tag: m[1].toLowerCase() };
  if (rest.startsWith('<!--')) return { type: 2, tag: '' };
  if (rest.startsWith('<?')) return { type: 3, tag: '' };
  if (/^<![A-Za-z]/.test(rest)) return { type: 4, tag: '' };
  if (rest.startsWith('<![CDATA[')) return { type: 5, tag: '' };
  m = /^\/?([A-Za-z][A-Za-z0-9-]*)(\s|\/?>|$)/.exec(rest.slice(1));
  if (m) {
    const name = m[1].toLowerCase();
    const isClose = rest.charCodeAt(1) === C_SLASH;
    const after = rest.charCodeAt(1 + (isClose ? 1 : 0) + m[1].length);
    const afterOk = after === C_GT || after === C_SP || after === C_TAB || after === C_SLASH || Number.isNaN(after);
    // Type 6: block-level tag. The tag itself must be syntactically valid
    // (cm-619 '<a h*#ref="hi">', cm-622 "<a href='bar'title=title>" and
    // cm-624 '</a href="foo">' are NOT tags): when the tag closes on this
    // line, validate it with the raw-HTML scanner. A tag that spans lines
    // (no '>' on this line, cm-642/643) is accepted on the name.
    if (BLOCK_TAGS.has(name) && afterOk) {
      const gt = rest.indexOf('>');
      if (gt === -1) return { type: 6, tag: name };
      if (rawTag(rest, 0) !== -1) return { type: 6, tag: name };
    }
    // Type 7: a complete open/close tag alone on the line. The tag must be
    // syntactically valid too (rawTag), not just lone on the line.
    if (!isClose) {
      const gt = rest.indexOf('>');
      if (gt !== -1) {
        let ok = true;
        for (let k = gt + 1; k < rest.length; k++) {
          const c = rest.charCodeAt(k);
          if (c !== C_SP && c !== C_TAB) { ok = false; break; }
        }
        if (ok) {
          const inner = rest.slice(0, gt);
          if (inner.indexOf('<', 1) === -1 && rawTag(rest, 0) !== -1) return { type: 7, tag: name };
        }
      }
    } else {
      const gt = rest.indexOf('>');
      if (gt !== -1) {
        let ok = true;
        for (let k = gt + 1; k < rest.length; k++) {
          const c = rest.charCodeAt(k);
          if (c !== C_SP && c !== C_TAB) { ok = false; break; }
        }
        if (ok && rawTag(rest, 0) !== -1) return { type: 7, tag: name };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

// Absolute column where a view's content starts (leading whitespace included).
function contentCol(v) {
  measure(v);
  return v.col + v.ind;
}

// Cut a view up to absolute column `col` (no-op past the first non-ws char).
function cutToCol(v, col) {
  if (col <= v.col) return v;
  return cutCols(v, col - v.col);
}

function isBlank(v) {
  measure(v);
  return v.cs === v.s.length;
}

// Does this line start a block that can interrupt a paragraph?
function interruptsPara(views, i, to, v, top) {
  if (fenceHead(v)) return true;
  if (atxHead(v)) return true;
  if (isRule(v)) return true;
  if (isQuote(v)) return true;
  const lm = listMark(v);
  if (lm && listInterrupts(views, i, to, v, lm, top)) return true;
  const hb = htmlKind(v);
  if (hb && hb.type <= 6) return true;
  return false;
}

function listInterrupts(views, i, to, v, lm, top) {
  // An ordered list may interrupt a paragraph only if it starts with 1 —
  // but ONLY at the top level (marked's paragraph regex for state.top
  // allows '1[.)]' while the nested one allows any '\d{1,9}[.)]').
  // Inside a list item / blockquote, '505791.' DOES interrupt (doc-01).
  if (top !== false && lm.ordered && lm.start !== 1) return false;
  const ic = itemBody(v, lm);
  if (!ic.empty) return true;
  if (i + 1 < to) {
    const nv = measure(views[i + 1]);
    if (!isBlank(nv) && contentCol(nv) >= ic.contentIndent) return true;
  }
  return false;
}

// A line that may lazily continue an open paragraph inside a container:
// non-blank, starts no interrupting block. A setext underline IS a lazy
// candidate (it is appended as paragraph text, indented in a blockquote so
// it cannot become a heading).
function lazyOK(views, i, to, v) {
  if (isBlank(v)) return false;
  // Lazy candidates are inside a container (top = false), so any ordered
  // list may interrupt the paragraph there.
  if (interruptsPara(views, i, to, v, false)) return false;
  return true;
}

function indentedCode(views, i, to, out) {
  const parts = [];
  let j = i;
  while (j < to) {
    const v = measure(views[j]);
    if (isBlank(v)) {
      // A blank line keeps its whitespace beyond the 4-column indent.
      parts.push({ s: cutCols(v, 4, false).s, term: v.term });
      j++;
      continue;
    }
    if (v.ind >= 4) {
      // A tab after the 4-column cut stays a literal tab (doc-02/06).
      parts.push({ s: cutCols(v, 4, false).s, term: v.term });
      j++;
      continue;
    }
    break;
  }
  while (parts.length > 0 && parts[parts.length - 1].s.trim() === '') parts.pop();
  let text = '';
  for (const p of parts) text += p.s + (p.term ? '\n' : '');
  if (text && text.charCodeAt(text.length - 1) !== C_LF) text += '\n';
  out.push({ t: 'icode', text });
  return j;
}

// Expand tabs in s to spaces, where s starts at absolute column startCol
// (tab stops every 4 columns). Code block content keeps tabs expanded.
function expandTabs(s, startCol) {
  if (s.indexOf('\t') === -1) return s;
  let out = '';
  let col = startCol;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === C_TAB) {
      const w = 4 - (col & 3);
      out += ' '.repeat(w);
      col += w;
    } else {
      out += s[i];
      col++;
    }
  }
  return out;
}

function fencedCode(views, i, to, f, out) {
  const parts = [];
  // Marked's indentCodeCompensation (Dt): the opening fence line's own
  // leading whitespace (counted in CHARACTERS, not columns) is stripped
  // from the front of every content line that starts with whitespace.
  // Tabs are NOT expanded — a tab in the content stays a literal tab
  // unless it is inside the stripped prefix. This replaces the old
  // column-based cut, which mis-handled tabs in containers (doc-02/06/
  // 11/13/15/17/21/22/29/38).
  //
  // Dt applies ONLY to backtick fences: its pattern is /^(\s+)(?:```)/,
  // so a tilde fence (~~~) matches nothing and its content keeps its
  // full indent (doc-22: a ~~~typescript fence inside a quote keeps the
  // 3 spaces on every content line).
  const fenceWs = f.ch === C_BT ? measure(views[i]).cs : 0;
  let j = i + 1;
  while (j < to) {
    const v = measure(views[j]);
    if (v.ind <= 3) {
      const s = v.s;
      let k = v.cs;
      let run = 0;
      while (k < s.length && s.charCodeAt(k) === f.ch) { run++; k++; }
      if (run >= f.len) {
        let ok = true;
        for (; k < s.length; k++) {
          const c = s.charCodeAt(k);
          if (c !== C_SP && c !== C_TAB) { ok = false; break; }
        }
        if (ok) { j++; break; }
      }
    }
    const m = v.cs;
    parts.push({ s: v.s.slice(Math.min(m, fenceWs)), term: v.term });
    j++;
  }
  // The content is the lines joined with '\n', ending with exactly one
  // trailing '\n' (cm-318: a fence whose content is 'b' + two blank lines
  // yields 'b\n\n', not 'b\n\n\n' — the newline before the closing fence
  // is the separator, not extra content).
  let text = parts.map((p) => p.s).join('\n');
  if (text !== '' && text.charCodeAt(text.length - 1) !== C_LF) text += '\n';
  out.push({ t: 'code', lang: f.lang, text });
  return j;
}

function htmlBlock(views, i, to, hb, out, ctx) {
  let j = i;
  const first = views[i];
  if (hb.type === 1) {
    const closeTag = '</' + hb.tag + '>';
    let found = false;
    while (j < to) {
      if (views[j].s.toLowerCase().indexOf(closeTag) !== -1) { found = true; j++; break; }
      j++;
    }
    if (!found) j = to;
  } else if (hb.type === 2) {
    let found = false;
    while (j < to) {
      if (views[j].s.indexOf('-->') !== -1) { found = true; j++; break; }
      j++;
    }
    if (!found) j = to;
  } else if (hb.type === 3) {
    let found = false;
    while (j < to) {
      if (views[j].s.indexOf('?>') !== -1) { found = true; j++; break; }
      j++;
    }
    if (!found) j = to;
  } else if (hb.type === 4) {
    let found = false;
    while (j < to) {
      const s = views[j].s;
      const from = j === i ? first.cs + 2 : 0;
      if (s.indexOf('>', from) !== -1) { found = true; j++; break; }
      j++;
    }
    if (!found) j = to;
  } else if (hb.type === 5) {
    let found = false;
    while (j < to) {
      if (views[j].s.indexOf(']]>') !== -1) { found = true; j++; break; }
      j++;
    }
    if (!found) j = to;
  } else {
    // Types 6-7: end at the first blank line.
    j = i + 1;
    while (j < to && !isBlank(views[j])) j++;
  }
  // An HTML block's text has NO trailing newline, EXCEPT:
  //  - types 1-5 (script/pre/style/textarea, comment, PI, declaration, CDATA):
  //    the last line's terminator is kept whenever another line follows the
  //    block in this range, or (top level) the block runs to the document's
  //    last terminated line;
  //  - types 6-7: only (top level) when the block runs to the document's
  //    last terminated line.
  let text = '';
  for (let k = i; k < j; k++) {
    if (k > i) text += '\n';
    text += views[k].s;
  }
  let trailingNl = false;
  // Types 1-5 get a trailing newline when another line follows and it is
  // non-EMPTY — a whitespace-only line ('\t') counts (marked3: '<!-- foo
  // -->\n\t\nbar' keeps the '\n'), only a truly empty line does not
  // (marked2: '<!-- foo -->\n\nbar' has none).
  if (j < to && hb.type <= 5 && views[j].s.length > 0) trailingNl = true;
  else if (j === to && ctx.isTop && j > i && views[j - 1].term) trailingNl = true;
  if (trailingNl) text += '\n';
  out.push({ t: 'html', text });
  return j;
}

function tableBlock(views, i, to, ctx, out, header, aligns) {
  const rows = [];
  let j = i + 1;
  while (j < to) {
    const v = measure(views[j]);
    if (isBlank(v)) {
      // A line of only spaces (or empty) ends the table. A line containing
      // a tab does NOT: marked's table row pattern excludes only ' *\n'
      // (spaces), so a tab-only line is a row of empty cells (doc-02/05/
      // 26/33: a trailing '\t' line renders a row of empty <td>s).
      if (v.s.indexOf('\t') === -1) break;
      rows.push(splitRow(v.s, header.length));
      j++;
      continue;
    }
    if (v.ind >= 4) break; // indented code ends the table
    if (fenceHead(v) || atxHead(v) || isRule(v) || isQuote(v) || listMark(v) || htmlKind(v)) break;
    rows.push(splitRow(v.s, header.length));
    j++;
  }
  out.push({ t: 'table', align: aligns, header, rows });
  return j;
}

// Strip the '>' marker (and one optional space) from a quote line.
function quoteLine(v) {
  // Strip the leading indent, then re-base the column to 0: lines in the
  // same quote may have different leading indents in the source
  // ('   > > 1. one' vs '>>     two'), but their content columns must
  // align, because marked re-lexes quote content with fresh columns
  // (cm-259). Re-basing before the '>' (not after) keeps tab expansion
  // correct (cm-006 '>\t\tfoo' -> code '  foo').
  //
  // Marked expands the whitespace AFTER the '>' marker with J(m, b.length)
  // — tabs become spaces from the column right after the marker — before
  // removing the marker plus one optional space. A literal tab after '>'
  // would otherwise survive into a fenced-code line (doc-02: '>   \tfoo'
  // must become '    foo', not '  \tfoo'). Do the same here: the '>' sits
  // at column v.ind within this view, because marked re-lexes the quote
  // content with fresh columns (the view's own col is the original
  // document column, not the re-lexed one — using it over-expands tabs
  // in nested quotes, doc-14/17/19/40).
  const markerCol = v.ind;
  let w = cutCols(v, v.ind);
  w = { s: w.s, col: 0, ind: -1, cs: -1, term: w.term };
  w = cutChars(w, 1); // the '>'
  let k = 0;
  while (k < w.s.length && (w.s.charCodeAt(k) === C_SP || w.s.charCodeAt(k) === C_TAB)) k++;
  if (k > 0) {
    const expanded = expandTabs(w.s.slice(0, k), markerCol + 1);
    w = { s: expanded + w.s.slice(k), col: w.col, ind: -1, cs: -1, term: w.term };
    if (w.s.charCodeAt(0) === C_SP) {
      w = { s: w.s.slice(1), col: w.col + 1, ind: -1, cs: -1, term: w.term };
    }
  } else if (w.s.length > 0 && w.s.charCodeAt(0) === C_GT) {
    // A '>>' marker (no space between the two '>') must behave like
    // '> >' column-wise: the inner content's column is off by 1
    // otherwise, and a list item inside the inner quote misses its
    // indented continuation (cm-259: '>>     two' — the 'two' must be
    // a paragraph in the '1. one' item, not indented code). Advance the
    // column by 1 as if the space were present.
    w = { s: w.s, col: w.col + 1, ind: -1, cs: -1, term: w.term };
  }
  // After the J expansion no leading tab remains, so re-basing the column
  // to 0 is safe: lines in the same quote must align in content-relative
  // columns (a '16.' marker with no space after '>' and a '   First' line
  // with a space after '>' otherwise differ by 1 column and a list item
  // wrongly absorbs the continuation — doc-22).
  w = { s: w.s, col: 0, ind: -1, cs: -1, term: w.term };
  return w;
}

function quoteBlock(views, i, to, ctx, out) {
  const savedTop = ctx.isTop;
  ctx.isTop = false;
  const lines = [];
  let j = i;
  let blocks = [];
  // Whether the last '>' line collected had empty content (a blank line
  // inside the quote closes the paragraph, so no lazy continuation may
  // follow it — cm-249). Tracked separately because reparse() trims the
  // trailing blanks off `lines`.
  let lastCollectedBlank = false;
  const reparse = () => {
    while (lines.length > 0 && lines[lines.length - 1].s === '') lines.pop();
    blocks = [];
    blockParse(lines, 0, lines.length, ctx, blocks);
  };
  while (true) {
    // Consume '>' lines; a truly blank line ends the quote.
    let gotQuote = false;
    while (j < to) {
      const v = measure(views[j]);
      if (!isQuote(v)) break;
      const cv = quoteLine(v);
      lines.push(cv);
      lastCollectedBlank = (cv.s === '');
      j++;
      gotQuote = true;
    }
    if (gotQuote) reparse();
    // Lazy continuation lines for the quote's last paragraph — or for a
    // paragraph nested inside the quote's last blockquote or list item
    // (cm-250/251, cm-292: '> 1. > Blockquote\ncontinued here.' — the
    // lazy line propagates quote -> list -> quote).
    let gotLazy = false;
    while (j < to) {
      if (blocks.length === 0) break;
      const lastT = blocks[blocks.length - 1].t;
      if (lastT !== 'p' && lastT !== 'q' && lastT !== 'list') break;
      // A blank line (empty '>' line) inside the quote closes the
      // paragraph: no lazy continuation may follow it (cm-249).
      if (lastCollectedBlank) break;
      const v = measure(views[j]);
      if (!lazyOK(views, j, to, v)) break;
      const savedLen = lines.length;
      if (setextLevel(v)) {
        // A lazy setext underline is indented by 4 spaces so it stays
        // paragraph text instead of becoming a heading.
        lines.push({ s: '    ' + v.s, col: v.col, ind: -1, cs: -1, term: v.term, lazyLine: true });
      } else if (v.ind >= 4) {
        // A lazy line indented by 4+ columns loses 4 columns (marked's
        // blockquote lazy-line outdent); the stripped line is always
        // paragraph text, even if it now looks like a block start.
        const st = cutCols(v, 4);
        st.lazyLine = true;
        lines.push(st);
      } else {
        lines.push(views[j]);
      }
      reparse();
      // If the quote's last block was a blockquote or list and the lazy
      // line became a top-level block in the quote's content instead of
      // being consumed inside, it is not a lazy continuation of anything:
      // undo the append and stop.
      if ((lastT === 'q' || lastT === 'list') && (blocks.length === 0 || blocks[blocks.length - 1].t !== lastT)) {
        lines.length = savedLen;
        reparse();
        break;
      }
      lastCollectedBlank = false;
      j++;
      gotLazy = true;
    }
    // A '>' line after lazy lines continues the same quote.
    if (j < to && isQuote(measure(views[j]))) continue;
    break;
  }
  out.push({ t: 'q', blocks });
  ctx.isTop = savedTop;
  return j;
}

// Is the string s a closing fence for a fence of char ch and length len?
// (up to 3 columns of indent, a run of ch of length >= len, then only
// whitespace). Used for fence tracking inside list items.
function closingFence(s, ch, len) {
  let i = 0;
  let col = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === C_SP) { col++; i++; }
    else if (c === C_TAB) { col += 4 - (col & 3); i++; }
    else break;
    if (col > 3) return false;
  }
  let run = 0;
  while (i < s.length && s.charCodeAt(i) === ch) { run++; i++; }
  if (run < len) return false;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== C_SP && c !== C_TAB) return false;
    i++;
  }
  return true;
}

function listBlock(views, i, to, ctx, out, firstLm) {
  const savedTop = ctx.isTop;
  ctx.isTop = false;
  const items = [];
  let j = i;
  let loose = false;
  let curLm = firstLm;
  let curR = 0;
  // Whether the previous item's collected lines ended with a blank line
  // (the continuation loop consumes inter-item blank lines into the item,
  // so the blankRun loop below would miss them).
  let prevEndedWithBlank = false;
  while (j < to) {
    const v = measure(views[j]);
    if (isBlank(v)) break;
    const lm = listMark(v);
    if (!lm) break;
    if (isRule(v)) break; // '* * *' / '- - -' is a thematic break, not an item
    if (lm.ordered !== curLm.ordered) break;
    if (!lm.ordered && lm.bullet !== curLm.bullet) break;
    if (lm.ordered && lm.delim !== curLm.delim) break;
    // Marker indent must be within the previous item's content indent.
    if (items.length > 0 && contentCol(v) > curR) break;
    const ic = itemBody(v, lm);
    curR = ic.contentIndent;
    const lines = [ic.content];
    let k = j + 1;
    // Fence tracking: a fenced code block inside a list item keeps its
    // content lines (even ones indented below the item's content indent)
    // until its closing fence (doc-02: a '```css' fence whose content
    // includes 'function f(a, b) {' at indent 0). Track the open fence
    // so those lines are collected instead of ending the item.
    let fence = null;
    const firstFence = fenceHead(ic.content);
    if (firstFence) fence = { ch: firstFence.ch, len: firstFence.len };
    // Whether the item has any non-blank content yet, and whether a blank
    // line has been seen: an EMPTY item is closed by a blank line, so no
    // line after it can belong to the item (cm-280: '-\n\n  foo' -> the
    // '  foo' line is a paragraph outside the list).
    let hasContent = ic.content.s !== '';
    let sawBlank = false;
    while (k < to) {
      const w = measure(views[k]);
      if (isBlank(w)) {
        sawBlank = true;
        lines.push({ s: '', col: w.col, ind: 0, cs: 0, term: w.term });
        k++;
        continue;
      }
      // Inside a fenced code block: every line is fence content until the
      // closing fence, whatever its indent. Collect it (stripped by the
      // content indent when indented that far, else as-is) and check for
      // the closing fence on the collected text.
      if (fence) {
        let collected;
        if (contentCol(w) >= curR) {
          collected = cutToCol(w, curR);
        } else {
          collected = { s: w.s, col: w.col, ind: -1, cs: -1, term: w.term };
        }
        lines.push(collected);
        hasContent = true;
        if (closingFence(collected.s, fence.ch, fence.len)) fence = null;
        k++;
        continue;
      }
      // A new item marker at this level? (its column must be strictly less
      // than this item's content indent; a marker at the content indent is
      // part of this item, i.e. a nested list)
      const nm = listMark(w);
      if (nm && !isRule(w) && nm.ordered === curLm.ordered && (!nm.ordered ? nm.bullet === curLm.bullet : nm.delim === curLm.delim) && contentCol(w) < curR) break;
      if (!hasContent && sawBlank) break;
      if (contentCol(w) >= curR) {
        hasContent = true;
        const stripped = cutToCol(w, curR);
        lines.push(stripped);
        const f2 = fenceHead(stripped);
        if (f2) {
          // A fenced code block inside a list item is only established
          // if its FIRST content line belongs to the item. If the first
          // non-blank line after the opening is outside the item
          // (indent < curR), the fence is EMPTY and the item ends here
          // (doc-17: '   ```toml' followed by 'if my-package previous'
          // at indent 0 — the fence renders empty, the line is a
          // paragraph outside the list). If the first content line is
          // inside the item, the fence is established and later lines
          // are collected even at indent 0 (doc-02: 'function f(a, b) {'
          // mid-fence at indent 0 stays in the code block).
          let firstContentOutside = false;
          if (k + 1 < to) {
            const nw = measure(views[k + 1]);
            if (!isBlank(nw) && contentCol(nw) < curR) firstContentOutside = true;
          }
          if (firstContentOutside) {
            // Do not enter fence-mode; end the item after this line.
            // The fence opening stays in the item's lines and re-parses
            // as an empty (unclosed) code block.
            k++;
            break;
          }
          fence = { ch: f2.ch, len: f2.len };
        }
        k++;
        continue;
      }
      // A block that interrupts at the outer level ends the item.
      if (fenceHead(w) || atxHead(w) || isRule(w) || isQuote(w) || htmlKind(w) || listMark(w)) break;
      // Otherwise: a lazy continuation line. Collect it as paragraph text
      // (flagged so the re-parse does not treat it as a block start) and
      // KEEP collecting — a blank line + indented content after it still
      // belongs to the item (cm-290: '  1.  A paragraph\nwith two
      // lines.\n\n          indented code\n\n      > A block quote.' — the
      // lazy 'with two lines.' must not close the item before the
      // indented code and blockquote). Only collect when the item already
      // has content (an empty item has no paragraph to continue) AND no
      // blank line has been seen (a blank closes the paragraph: cm-255
      // '- one\n\n two' — the ' two' is outside the list; cm-325 the
      // 'baz' after a blank belongs to the outer item, not the nested
      // list).
      if (hasContent && !sawBlank) {
        lines.push({ s: w.s, col: w.col, ind: -1, cs: -1, term: w.term, lazyLine: true, listLazy: true });
        k++;
        continue;
      }
      break;
    }
    // Trim trailing blank lines (record whether the item's lines ended
    // with a blank first: a lazy continuation may not follow a blank).
    // The first entry is the item's own content view, which is empty for
    // an empty item — that is NOT a trailing blank (cm-281/282/283: an
    // empty middle item must not loosen the list); only a blank line
    // collected after the content counts.
    const endedWithBlank = lines.length > 1 && lines[lines.length - 1].s === '';
    let trailingBlanks = 0;
    while (lines.length > 1 && lines[lines.length - 1].s === '') { lines.pop(); trailingBlanks++; }
    // If the item ended with blank line(s) and there is more content after
    // the list in the outer range, those blanks are separators at the OUTER
    // level, not part of this item — back up so the outer blockParse sees
    // them (cm-325: '* foo\n  * bar\n\n  baz' — the blank between the
    // nested list and 'baz' makes the outer list loose; the nested
    // listBlock must not swallow it).
    if (endedWithBlank && trailingBlanks > 0 && k < to) k -= trailingBlanks;
    // Looseness is decided by the PARSED blocks, not the raw lines: a
    // blank line between two blocks at the item's level makes the list
    // loose, but a blank line inside a nested list/quote/code does not
    // (doc-02: blank lines between nested-list items must not loosen the
    // outer list). blockParse reports it via info.blankSep.
    const itemInfo = {};
    // Task list marker on the first line.
    let task = false;
    let checked = false;
    const first = lines[0];
    if (first) {
      const m = /^\[([ xX])\][ \t]+(?=\S)/.exec(first.s);
      if (m) {
        task = true;
        checked = m[1] === 'x' || m[1] === 'X';
        const s2 = first.s.slice(m[0].length);
        lines[0] = { s: s2, col: first.col + m[0].length, ind: -1, cs: -1, term: first.term };
      }
    }
    const blocks = [];
    blockParse(lines, 0, lines.length, ctx, blocks, itemInfo);
    // Lazy continuation lines for this item — for the item's last
    // paragraph, or for a paragraph nested inside its last blockquote or
    // list (cm-292/293: '> 1. > Blockquote\ncontinued here.' — the lazy
    // line propagates list -> quote into the innermost paragraph).
    while (k < to) {
      if (blocks.length === 0) break;
      const lastT = blocks[blocks.length - 1].t;
      if (lastT !== 'p' && lastT !== 'q' && lastT !== 'list') break;
      // A blank line inside the item closes the paragraph: no lazy
      // continuation may follow it (cm-255: '- one\n\n two' -> the
      // ' two' line is a separate paragraph outside the list).
      if (endedWithBlank) break;
      const w = measure(views[k]);
      // A new item marker of this same list is the next item, not a lazy
      // continuation (cm-281: '- foo\n-\n- bar' — the bare '-' is an
      // empty item even though an empty item cannot interrupt a paragraph).
      const nm2 = listMark(w);
      if (nm2 && !isRule(w) && nm2.ordered === curLm.ordered && (!nm2.ordered ? nm2.bullet === curLm.bullet : nm2.delim === curLm.delim) && contentCol(w) < curR) break;
      // Any other list marker also ends the item: it starts a new list at
      // the outer level (cm-302: '1. foo\n2. bar\n3) baz' — the '3)' is
      // a new list, not a lazy continuation of 'bar', even though a
      // '3)' list cannot interrupt a paragraph).
      if (nm2 && contentCol(w) < curR) break;
      if (!lazyOK(views, k, to, w)) break;
      // A lazy setext underline stays literal paragraph text (marked does
      // not turn it into a heading inside a list item); flag it so the
      // re-parse does not treat it as a setext underline.
      const savedLen = lines.length;
      if (setextLevel(w)) {
        lines.push({ s: w.s, col: w.col, ind: -1, cs: -1, term: w.term, lazySetext: true });
      } else {
        lines.push(views[k]);
      }
      blocks.length = 0;
      blockParse(lines, 0, lines.length, ctx, blocks, itemInfo);
      // If the item's last block was a blockquote or list and the lazy
      // line became a top-level block in the item instead of being
      // consumed inside, it is not a lazy continuation: undo and stop.
      if ((lastT === 'q' || lastT === 'list') && (blocks.length === 0 || blocks[blocks.length - 1].t !== lastT)) {
        lines.length = savedLen;
        blocks.length = 0;
        blockParse(lines, 0, lines.length, ctx, blocks, itemInfo);
        break;
      }
      k++;
    }
    if (itemInfo.blankSep) loose = true;
    items.push({ task, checked, blocks });
    prevEndedWithBlank = endedWithBlank;
    j = k;
    // Blank lines between items.
    const blankStart = j;
    let blankRun = 0;
    while (j < to && isBlank(views[j])) {
      blankRun++;
      j++;
    }
    if (j >= to) break;
    const nv = measure(views[j]);
    const nm3 = listMark(nv);
    if (nm3 && !isRule(nv) && nm3.ordered === curLm.ordered && (!nm3.ordered ? nm3.bullet === curLm.bullet : nm3.delim === curLm.delim) && contentCol(nv) < curR) {
      // A blank line between this item and the next (whether skipped here
      // or consumed into the previous item's lines) makes the list loose.
      if (blankRun > 0 || prevEndedWithBlank) loose = true;
      continue; // next item
    }
    // Not a new item: the list is over. The blank line(s) just skipped
    // are separators at the OUTER level, not part of this list — back up
    // so the outer blockParse sees them (cm-325: the blank between the
    // nested list and 'baz' makes the outer list loose).
    j = blankStart;
    break; // the list is over
  }
  if (items.length === 0) {
    ctx.isTop = savedTop;
    return i + 1;
  }
  out.push({ t: 'list', ordered: curLm.ordered, start: curLm.start, loose, items });
  ctx.isTop = savedTop;
  return j;
}

function blockParse(views, from, to, ctx, out, info) {
  let i = from;
  let para = null;
  const flushPara = () => {
    if (para) {
      out.push({ t: 'p', text: para.join('\n') });
      para = null;
    }
  };
  while (i < to) {
    const v = measure(views[i]);
    // A whitespace-only line that is the LAST line of this range is a
    // paragraph continuation (not a blank line) when it is unterminated in
    // the source being parsed: at the top level that means its term flag is
    // false; inside a container the range's last line is never terminated.
    const trailingWsLine =
      para !== null &&
      i === to - 1 &&
      v.cs === v.s.length &&
      v.s.length > 0 &&
      (!ctx.isTop || !v.term);
    if (trailingWsLine) {
      para.push(v.s);
      i++;
      continue;
    }
    if (isBlank(v)) {
      // A blank line after content that is followed by more content
      // separates two blocks at this level (a "space" token). Blank lines
      // inside a nested list/quote/code are consumed by the nested parse
      // call and never reach this point, so they do not count.
      if (info && (para !== null || out.length > 0) && !info.blankSep) {
        for (let s = i + 1; s < to; s++) {
          if (!isBlank(measure(views[s]))) { info.blankSep = true; break; }
        }
      }
      flushPara();
      i++;
      continue;
    }
    // A line flagged as a lazy continuation (a blockquote lazy line that
    // was outdented by 4 columns) is always paragraph text, even if it
    // now looks like a block start (cm-238: '    - bar' -> '- bar').
    // A LIST lazy line (collected by listBlock, not pre-stripped) still
    // gets the container paragraph-continuation outdent: inside a
    // container, a continuation indented by 4+ columns loses 4 columns
    // (cm-291: '  1.  A paragraph' + '    with two lines.' -> the
    // continuation loses 4 columns).
    if (para && v.lazyLine) {
      if (v.listLazy && !ctx.isTop && v.ind >= 4) {
        para.push(cutCols(v, 4).s);
      } else {
        para.push(v.s);
      }
      i++;
      continue;
    }
    if (para) {
      const st = setextLevel(v);
      if (st && !v.lazySetext) {
        // A setext heading's content is the paragraph with leading and
        // trailing whitespace stripped.
        const htext = para.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        out.push({ t: 'h', level: st, text: htext });
        para = null;
        i++;
        continue;
      }
      if (para.length === 1) {
        const al = delimRow(v);
        if (al) {
          const header = splitRow(para[0]);
          if (header.length === al.length && header.length > 0) {
            i = tableBlock(views, i, to, ctx, out, header, al);
            para = null;
            continue;
          }
        }
      }
      if (interruptsPara(views, i, to, v, ctx.isTop)) {
        flushPara();
        continue;
      }
      // A paragraph continuation line keeps its leading spaces: the
      // container (list/quote) already stripped its own indent before
      // re-lexing, so what remains is paragraph text (doc-21: a nested
      // quote's '    indented four' keeps all 4 spaces). The 4-column
      // outdent for list lazy lines lives in the lazyLine branch above
      // (cm-291), not here.
      para.push(v.s);
      i++;
      continue;
    }
    if (v.ind >= 4) {
      i = indentedCode(views, i, to, out);
      continue;
    }
    const f = fenceHead(v);
    if (f) {
      i = fencedCode(views, i, to, f, out);
      continue;
    }
    const a = atxHead(v);
    if (a) {
      out.push({ t: 'h', level: a.level, text: a.text });
      i++;
      continue;
    }
    if (isRule(v)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (isQuote(v)) {
      i = quoteBlock(views, i, to, ctx, out);
      continue;
    }
    const lm = listMark(v);
    if (lm) {
      i = listBlock(views, i, to, ctx, out, lm);
      continue;
    }
    const hb = htmlKind(v);
    if (hb) {
      i = htmlBlock(views, i, to, hb, out, ctx);
      continue;
    }
    let defsConsumed = false;
    let consumed = 0;
    while (i < to) {
      consumed = tryRefDef(views, i, to, ctx);
      if (consumed <= 0) break;
      i += consumed;
      defsConsumed = true;
    }
    if (i >= to) break;
    const v2 = measure(views[i]);
    if (isBlank(v2)) {
      i++;
      continue;
    }
    if (defsConsumed && (v2.ind >= 4 || fenceHead(v2) || atxHead(v2) || isRule(v2) || isQuote(v2) || listMark(v2) || htmlKind(v2))) {
      continue; // a block start after the definitions: handle it from the top
    }
    para = [v2.s];
    i++;
  }
  flushPara();
}

// ---------------------------------------------------------------------------
// Inline parsing. Scanner with a delimiter stack (CommonMark emphasis
// algorithm), bracket stack for links/images, and an extended-autolink post
// pass that splits text nodes.
// ---------------------------------------------------------------------------

const ENTITY_RE = /&(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);/;

// A text segment of a paragraph: { t: 'text', s } | { t: 'html', s } |
// { t: 'code', s } | { t: 'link', href, title, children } |
// { t: 'image', href, title, alt, children } | { t: 'del', children } |
// { t: 'em', children } | { t: 'strong', children } | { t: 'br' } |
// { t: 'raw', s } (raw HTML block content: no escaping, no entity decoding)

// Try to parse a link/image destination + optional title at position p.
// Returns { href, title, end } (end = index just past the title, or past the
// destination when there is no title) or null.
function linkDest(text, p) {
  const n = text.length;
  let i = p;
  let href = null;
  let end = -1;
  if (text.charCodeAt(i) === C_LT) {
    let j = i + 1;
    let ok = false;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === C_LF || c === C_LT) break;
      if (c === C_BS) { j += 2; continue; }
      if (c === C_GT) { ok = true; break; }
      j++;
    }
    if (!ok) return null;
    href = text.slice(i + 1, j);
    end = j + 1;
  } else {
    let j = i;
    let depth = 0;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === C_SP || c === C_TAB || c === C_LF) break;
      if (c === C_BS) { j += 2; continue; }
      if (c === C_LP) { depth++; j++; continue; }
      if (c === C_RP) {
        if (depth === 0) break;
        depth--;
        j++;
        continue;
      }
      j++;
    }
    if (j === i) return null;
    href = text.slice(i, j);
    end = j;
  }
  // Optional title after whitespace (newlines allowed).
  let k = end;
  while (k < n && (text.charCodeAt(k) === C_SP || text.charCodeAt(k) === C_TAB || text.charCodeAt(k) === C_LF)) k++;
  const tc = text.charCodeAt(k);
  let title = null;
  if (tc === C_DQ || tc === C_SQ || tc === C_LP) {
    const close = tc === C_LP ? C_RP : tc;
    let q = k + 1;
    let ok = false;
    while (q < n) {
      const c = text.charCodeAt(q);
      if (c === C_BS) { q += 2; continue; }
      if (c === close) { ok = true; break; }
      q++;
    }
    if (ok) {
      title = text.slice(k + 1, q);
      end = q + 1;
    }
  }
  return { href: unescBs(href), title: title === null ? null : unescBs(title), end };
}

// An emphasis delimiter's run info.
function delimRun(text, i) {
  const c = text.charCodeAt(i);
  let j = i;
  while (j < text.length && text.charCodeAt(j) === c) j++;
  const run = j - i;
  const prev = i > 0 ? text[i - 1] : '';
  const next = j < text.length ? text[j] : '';
  const beforeWs = prev === '' || isWsCh(prev);
  const afterWs = next === '' || isWsCh(next);
  const beforePunct = prev !== '' && isPunctCh(prev);
  const afterPunct = next !== '' && isPunctCh(next);
  const canOpen = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const canClose = !beforeWs && (!beforePunct || afterWs || afterPunct);
  const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
  let open = false;
  let close = false;
  if (c === C_UNDER) {
    open = leftFlanking && (!rightFlanking || beforePunct);
    close = rightFlanking && (!leftFlanking || afterPunct);
  } else {
    open = canOpen;
    close = canClose;
  }
  return { run, open, close };
}

// Find the end of a code span starting at i (text[i] === '`'). Returns the
// index just after the closing run, or null when there is no match. The content
// between the runs is returned via the out object.
function codeSpan(text, i) {
  const n = text.length;
  let j = i;
  while (j < n && text.charCodeAt(j) === C_BT) j++;
  const openLen = j - i;
  let k = j;
  while (k < n) {
    if (text.charCodeAt(k) === C_BT) {
      let m = k;
      while (m < n && text.charCodeAt(m) === C_BT) m++;
      if (m - k === openLen) {
        let content = text.slice(j, k);
        // Collapse newlines to spaces, strip one leading + trailing space
        // (only when the content is not entirely spaces).
        if (content.indexOf('\n') !== -1) content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === C_SP && content.charCodeAt(content.length - 1) === C_SP && !/^[ ]+$/.test(content)) {
          content = content.slice(1, -1);
        }
        return { end: m, content };
      }
      k = m;
    } else {
      k++;
    }
  }
  return null;
}

// A raw HTML tag scanner: returns the index just past the tag, or -1.
// Matches the CommonMark open/close tags, comments, PIs, declarations, CDATA.
function rawTag(text, i) {
  const n = text.length;
  if (text.charCodeAt(i) !== C_LT) return -1;
  const next = text.charCodeAt(i + 1);
  // Comment: '<!-->' and '<!--->' are complete comments on their own
  // (cm-626: 'foo <!--> foo -->' -> the comment is '<!-->', ' foo -->'
  // is text with '-->' escaped).
  if (text.startsWith('<!--', i)) {
    if (text.charCodeAt(i + 4) === C_GT) return i + 5;
    if (text.startsWith('->', i + 4)) return i + 6;
    const e = text.indexOf('-->', i + 4);
    if (e === -1) return -1;
    return e + 3;
  }
  if (text.startsWith('<?', i)) {
    const e = text.indexOf('?>', i + 2);
    if (e === -1) return -1;
    return e + 2;
  }
  if (text.startsWith('<!', i)) {
    if (i + 2 < n && /[A-Za-z]/.test(text[i + 2])) {
      const e = text.indexOf('>', i + 2);
      if (e === -1) return -1;
      return e + 1;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const e = text.indexOf(']]>', i + 9);
      if (e === -1) return -1;
      return e + 3;
    }
    return -1;
  }
  // Tag: </name or <name (letter, digit, '-', or '/' after the name).
  let j = i + 1;
  let closing = false;
  if (text.charCodeAt(j) === C_SLASH) {
    closing = true;
    j++;
  }
  if (j >= n || !/[A-Za-z]/.test(text[j])) return -1;
  while (j < n && /[A-Za-z0-9-]/.test(text[j])) j++;
  // A closing tag takes no attributes (cm-624: '</a href="foo">' is not
  // a tag) — only whitespace then '>' may follow the name.
  if (closing) {
    while (j < n && (text.charCodeAt(j) === C_SP || text.charCodeAt(j) === C_TAB || text.charCodeAt(j) === C_LF)) j++;
    if (j < n && text.charCodeAt(j) === C_GT) return j + 1;
    return -1;
  }
  // Attribute list: (ws+ name (= value)?)* ws* /?
  // An attribute name must be preceded by whitespace (cm-609: '<m:abc>'
  // is not a tag — the ':' after the name 'm' is not an attribute).
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === C_GT) return j + 1;
    if (c === C_SLASH && j + 1 < n && text.charCodeAt(j + 1) === C_GT) return j + 2;
    if (c !== C_SP && c !== C_TAB && c !== C_LF) return -1;
    while (j < n && (text.charCodeAt(j) === C_SP || text.charCodeAt(j) === C_TAB || text.charCodeAt(j) === C_LF)) j++;
    if (j >= n) return -1;
    const c2 = text.charCodeAt(j);
    if (c2 === C_GT) return j + 1;
    if (c2 === C_SLASH && j + 1 < n && text.charCodeAt(j + 1) === C_GT) return j + 2;
    // Attribute name.
    if (!/[A-Za-z_:]/.test(text[j])) return -1;
    while (j < n && /[A-Za-z0-9_.:-]/.test(text[j])) j++;
    // Optional '= value': look ahead past whitespace WITHOUT consuming it
    // unless an '=' follows (cm-616: a valueless attribute '_boolean'
    // must leave the following space for the loop-top whitespace check,
    // or the next attribute 'zoop:33=zoop:33' is rejected).
    let k = j;
    while (k < n && (text.charCodeAt(k) === C_SP || text.charCodeAt(k) === C_TAB || text.charCodeAt(k) === C_LF)) k++;
    if (k < n && text.charCodeAt(k) === C_EQ) {
      j = k + 1;
      while (j < n && (text.charCodeAt(j) === C_SP || text.charCodeAt(j) === C_TAB || text.charCodeAt(j) === C_LF)) j++;
      if (j >= n) return -1;
      const qc = text.charCodeAt(j);
      if (qc === C_DQ || qc === C_SQ) {
        // A quoted attribute value may span lines (cm-642/643: the tag
        // '<a href="foo  \nbar">' is valid HTML, the newline is inside
        // the value).
        let q = j + 1;
        let ok = false;
        while (q < n) {
          const cc = text.charCodeAt(q);
          if (cc === qc) { ok = true; break; }
          q++;
        }
        if (!ok) return -1;
        j = q + 1;
      } else {
        let q = j;
        while (q < n) {
          const cc = text.charCodeAt(q);
          if (cc === C_SP || cc === C_TAB || cc === C_LF || cc === C_GT || cc === C_DQ || cc === C_SQ || cc === C_EQ || cc === C_LT || cc === C_BT) break;
          q++;
        }
        if (q === j) return -1;
        j = q;
      }
    }
  }
  return -1;
}

// Scan an autolink <...> starting at i. Returns { end, href, text, kind } or null.
function angleLink(text, i) {
  const n = text.length;
  if (text.charCodeAt(i) !== C_LT) return null;
  // Email autolink.
  let j = i + 1;
  let k = j;
  while (k < n) {
    const c = text.charCodeAt(k);
    if (c === C_GT || c === C_SP || c === C_TAB || c === C_LF || c === C_LT) break;
    k++;
  }
  if (k < n && text.charCodeAt(k) === C_GT && k > j) {
    const inner = text.slice(j, k);
    if (/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(inner)) {
      return { end: k + 1, href: 'mailto:' + inner, text: inner, kind: 'email' };
    }
    // Scheme autolink.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(inner) && !/[ \t\n<>]/.test(inner)) {
      return { end: k + 1, href: inner, text: inner, kind: 'scheme' };
    }
  }
  return null;
}

// Is the backslash at position i (followed by a newline) the tail of an
// extended-autolink URL starting in [from, i)? Scan back over URL
// characters, then test each www./scheme candidate in the run against the
// same rules the autolink pass uses; the match must reach the backslash.
const URL_TAIL_CH = /[A-Za-z0-9._~:/?#@!$&'()*+,;=%\\-]/;
function urlTailBackslash(text, from, i) {
  let j = i;
  while (j > from && URL_TAIL_CH.test(text[j - 1])) j--;
  if (j === i) return false;
  const run = text.slice(j, i);
  for (let k = 0; k < run.length; k++) {
    if (run.startsWith('www.', k)) {
      const cand = run.slice(k) + '\\';
      const m = WWW_RE.exec(cand);
      if (m && m[0].length === cand.length) return true;
    }
    if (/[a-zA-Z]/.test(run[k])) {
      const cand = run.slice(k) + '\\';
      const m = SCHEME_RE.exec(cand);
      if (m && m[0].length === cand.length) {
        const ci = cand.indexOf(':');
        if (cand.slice(ci + 1).startsWith('//')) return true;
      }
    }
  }
  return false;
}

// The main inline parser. Returns an array of segments.
function inlineParse(text, ctx) {
  const segs = []; // output segments
  // Delimiter stack: { ch, seg (the delim segment object), pos, run, open, close, active }
  const delims = [];
  // Bracket stack: { segIdx, srcPos, labelText, image, active }
  const brackets = [];
  // Regions masked from the emphasis scan (see maskedLinkRegions).
  const maskedRegions = maskedLinkRegions(text);
  let inRaw = null; // 'pre' | 'code' | 'kbd' | 'script' | null
  const n = text.length;
  let i = 0;
  let textStart = 0; // start of the current pending text run

  // Flush pending text [textStart, end) as a segment (merged with the previous
  // text segment when possible). Records ctx.inLink (persistent across
  // blocks: an unclosed '<a>' from an earlier paragraph suppresses
  // extended autolinks in later text) so extAutolinks can skip segments
  // that sit inside an unclosed link.
  function flushText(end) {
    if (end <= textStart) return;
    const s = text.slice(textStart, end);
    if (inRaw) {
      segs.push({ t: 'raw', s });
    } else {
      const last = segs[segs.length - 1];
      if (last && last.t === 'text' && last.inLink === ctx.inLink) last.s += s;
      else segs.push({ t: 'text', s, inLink: ctx.inLink });
    }
  }

  // Wrap segments [o.pos, d.pos] into an em/strong/del node. The opener's and
  // closer's remaining runs stay as literal delim segments around the node.
  function wrapEmphasis(o, d, use) {
    const oPos = o.pos;
    const dPos = d.pos;
    const oRem = o.run - use;
    const dRem = d.run - use;
    const children = segs.slice(oPos + 1, dPos);
    const node = {
      t: d.ch === C_TILDE ? 'del' : use === 2 ? 'strong' : 'em',
      children,
    };
    const replacement = [];
    if (oRem > 0) {
      o.seg.run = oRem;
      replacement.push(o.seg);
    }
    replacement.push(node);
    if (dRem > 0) {
      d.seg.run = dRem;
      replacement.push(d.seg);
    }
    segs.splice(oPos, dPos - oPos + 1, ...replacement);
    const delta = dPos - oPos + 1 - replacement.length;
    for (const dd of delims) {
      if (dd === o) {
        dd.pos = oPos;
        dd.run = oRem;
        if (oRem === 0) dd.active = false;
        continue;
      }
      if (dd === d) {
        dd.pos = oPos + replacement.length - 1;
        dd.run = dRem;
        if (dRem === 0) dd.active = false;
        continue;
      }
      if (!dd.active) continue;
      if (dd.pos > oPos && dd.pos < dPos) dd.active = false;
      else if (dd.pos > dPos) dd.pos -= delta;
    }
    // Brackets inside the wrapped range are now nested inside the em/strong
    // node and can no longer form a link at the top level; brackets after
    // the range shift by the splice delta (cm-474: a stale segIdx made
    // tryLink set segs.length beyond the array, creating holes that
    // crashed the cleanup loop).
    for (const bb of brackets) {
      if (!bb.active) continue;
      if (bb.segIdx > oPos && bb.segIdx < dPos) bb.active = false;
      else if (bb.segIdx > dPos) bb.segIdx -= delta;
    }
  }

  // Process a closer delimiter: repeatedly find the nearest matching opener
  // (scanning backwards), wrap, and re-scan from the beginning while the
  // closer still has a run.
  function processEmphasis(dIdx) {
    const d = delims[dIdx];
    while (d.active && d.run > 0 && d.close) {
      let oIdx = -1;
      for (let k = dIdx - 1; k >= 0; k--) {
        const o = delims[k];
        if (!o.active || o.run === 0 || !o.open || o.ch !== d.ch) continue;
        // The odd-match rule of 3 (for * and _ only).
        if (d.ch !== C_TILDE && (o.open && o.close || d.open && d.close)) {
          if ((o.run + d.run) % 3 === 0 && o.run % 3 !== 0) continue;
        }
        // Link precedence: if the closer is inside an unclosed bracket
        // and the opener is before that bracket, the opener must NOT pair
        // with the closer — the link forms first and the closer becomes
        // literal text inside it ('*[foo*](/uri)' -> '*<a>foo*</a>',
        // '_foo [bar_](/url)' -> '_foo <a>bar_</a>', cm-473/474/521/534).
        // But only when the bracket will actually form a link: a '](' or
        // '][' follows it, or it is a shortcut reference whose label is
        // defined (cm-564: '*[foo*]' + '[foo*]: /url'). In '*foo [bar*
        // baz]' (cm-523) there is no destination, so the emphasis DOES
        // pair across the bare bracket. The opener is then literal.
        let spansBracket = false;
        for (const bb of brackets) {
          if (bb.active && bb.segIdx > o.pos && bb.segIdx < d.pos) {
            const rest = text.slice(bb.srcPos + 1);
            if (rest.includes('](') || rest.includes('][')) { spansBracket = true; break; }
            // Shortcut reference: the label between '[' and the next ']'.
            let r = bb.srcPos + 1;
            while (r < n) {
              const c = text.charCodeAt(r);
              if (c === C_BS) { r += 2; continue; }
              if (c === C_RB) break;
              if (c === C_LB) break;
              r++;
            }
            if (r < n && text.charCodeAt(r) === C_RB) {
              const lbl = text.slice(bb.srcPos + 1, r);
              if (ctx.refs.has(normLabel(lbl))) { spansBracket = true; break; }
            }
          }
        }
        if (spansBracket) continue;
        // Masked region: an opener and a closer both inside the same
        // masked '[label](dest)' region cannot pair — marked's emStrong
        // masking hides the whole region from the closer scan (doc-16/20/
        // 23: the '_..._' inside '[at _node `` a ` b ``_](...)' stays
        // literal).
        let inMasked = false;
        for (const rg of maskedRegions) {
          if (o.srcPos >= rg[0] && o.srcPos < rg[1] && d.srcPos >= rg[0] && d.srcPos < rg[1]) { inMasked = true; break; }
        }
        if (inMasked) continue;
        oIdx = k;
        break;
      }
      if (oIdx === -1) break;
      const o = delims[oIdx];
      const use = o.run >= 2 && d.run >= 2 ? 2 : 1;
      wrapEmphasis(o, d, use);
    }
  }

  // Does a segment list contain a (non-autolink) link node (recursively)?
  // Used to enforce "a link's text may not contain a link". An
  // autolink ('<https://...>' or an extended autolink) DOES NOT count —
  // it may appear inside a link's text (doc-03: '[examples heading new
  // <https://img.shields.io/note/quartz>](https://docs.example.dev/the/kite)'
  // forms the outer link around the autolink).
  function containsLink(segs) {
    for (const s of segs) {
      if (!s) continue;
      if (s.t === 'link' && !s.autolink) return true;
      if (s.children && containsLink(s.children)) return true;
    }
    return false;
  }

  // A link/image label must match marked's label pattern (re): each
  // character is an escaped char, a nested bracket (no backticks inside),
  // a code span (`...` with a closing run), backticks right before ']',
  // or a plain char. A BARE backtick — one that is not part of a code
  // span and not right before ']' — makes the whole label unmatchable,
  // so no link forms (doc-09/16/18/20/23: '[empty test `a ` b` output]'
  // has the code span '`a `' then a bare '`' before '_', so the URL in
  // '(...)' is only an autolink, not a link destination).
  function validLabelText(s) {
    let i = 0;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '[') {
        let depth = 1;
        let j = i + 1;
        while (j < n) {
          const d = s[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '`') return false;
          if (d === '[') depth++;
          else if (d === ']') { depth--; if (depth === 0) break; }
          j++;
        }
        if (depth !== 0) return false;
        i = j + 1;
        continue;
      }
      if (c === ']') return false;
      if (c === '`') {
        let j = i;
        while (j < n && s[j] === '`') j++;
        if (j === n) { i = j; continue; } // backticks right before ']'
        let k = j;
        while (k < n && s[k] !== '`') k++;
        if (k === n) return false; // no closing backtick run
        let m = k;
        while (m < n && s[m] === '`') m++;
        i = m;
        continue;
      }
      i++;
    }
    return true;
  }

  // The masked-label variant of validLabelText: marked's emStrong masking
  // (#n) first replaces backticks inside code spans with '+', so a code
  // span whose content contains a backtick (`` `` a ` b `` ``) becomes a
  // plain code span (equal runs, no backtick in the content) for the
  // blockSkip link pattern. So the masked check allows backticks inside a
  // code span (with equal opening/closing runs) but still rejects a bare
  // backtick and backticks inside nested brackets.
  function validLabelTextMasked(s) {
    let i = 0;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '[') {
        let depth = 1;
        let j = i + 1;
        while (j < n) {
          const d = s[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '`') return false;
          if (d === '[') depth++;
          else if (d === ']') { depth--; if (depth === 0) break; }
          j++;
        }
        if (depth !== 0) return false;
        i = j + 1;
        continue;
      }
      if (c === ']') return false;
      if (c === '`') {
        let j = i;
        while (j < n && s[j] === '`') j++;
        const run = j - i;
        if (j === n) { i = j; continue; }
        // Find the closing run of the SAME length; the content may contain
        // backticks (they are masked to '+' before the check).
        let k = j;
        let found = -1;
        while (k < n) {
          if (s[k] === '`') {
            let m = k;
            while (m < n && s[m] === '`') m++;
            if (m - k === run && (m === n || s[m] !== '`')) { found = m; break; }
            k = m;
          } else k++;
        }
        if (found === -1) return false;
        i = found;
        continue;
      }
      i++;
    }
    return true;
  }

  // Regions of the text that marked's emStrong masking (#n/blockSkip)
  // hides from the emphasis-closer scan: a '[label](dest)' whose label is
  // invalid per the unmasked label pattern (so no link forms) but valid
  // after code-span masking, with a valid inline destination. Emphasis
  // delimiters inside such a region cannot pair (doc-16/20/23: '[at
  // _node `` a ` b ``_](...)' — the '_..._' stays literal, only the code
  // span and the autolinked URL render).
  function maskedLinkRegions(text) {
    const regions = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
      if (text.charCodeAt(i) !== C_LB) { i++; continue; }
      // Find the closing ']' (skip escapes, code spans, nested brackets).
      let depth = 1;
      let j = i + 1;
      let close = -1;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (c === C_BS) { j += 2; continue; }
        if (c === C_BT) {
          let k = j;
          while (k < n && text.charCodeAt(k) === C_BT) k++;
          const run = k - j;
          let m = k;
          let found = -1;
          while (m < n) {
            if (text.charCodeAt(m) === C_BT) {
              let q = m;
              while (q < n && text.charCodeAt(q) === C_BT) q++;
              if (q - m === run) { found = q; break; }
              m = q;
            } else m++;
          }
          if (found === -1) { j = n; break; }
          j = found;
          continue;
        }
        if (c === C_LB) depth++;
        else if (c === C_RB) { depth--; if (depth === 0) { close = j; break; } }
        j++;
      }
      if (close === -1) { i++; continue; }
      const label = text.slice(i + 1, close);
      // A '(' destination right after ']'?
      let p = close + 1;
      if (text.charCodeAt(p) !== C_LP) { i++; continue; }
      let q = p + 1;
      while (q < n && (text.charCodeAt(q) === C_SP || text.charCodeAt(q) === C_TAB || text.charCodeAt(q) === C_LF)) q++;
      let end = -1;
      if (q < n) {
        if (text.charCodeAt(q) === C_RP) end = q + 1;
        else {
          const ld = linkDest(text, q);
          if (ld) {
            let r = ld.end;
            while (r < n && (text.charCodeAt(r) === C_SP || text.charCodeAt(r) === C_TAB || text.charCodeAt(r) === C_LF)) r++;
            if (text.charCodeAt(r) === C_RP) end = r + 1;
          }
        }
      }
      if (end !== -1 && !validLabelText(label) && validLabelTextMasked(label)) {
        regions.push([i, end]);
        i = end;
        continue;
      }
      i++;
    }
    return regions;
  }

  // Try to form a link/image from the bracket at bIdx. Returns the index just
  // past the link, or -1.
  function tryLink(bIdx, linkStart) {
    const b = brackets[bIdx];
    if (!b || !b.active) return -1;
    if (!validLabelText(b.labelText)) return -1;
    // Defensive: the bracket's segment index must still point at a bracket
    // segment (stale indices after emphasis splices would corrupt segs).
    if (b.segIdx >= segs.length || !segs[b.segIdx] || segs[b.segIdx].t !== 'bracket') return -1;
    let p = linkStart; // index just past ']'
    let href = null;
    let title = null;
    // An inline '(...)' that fails to parse as a destination falls back to
    // a shortcut reference link (cm-568: '[foo](not a link)' + '[foo]:
    // /url1' -> '<a href="/url1">foo</a>(not a link)').
    let inlineOk = false;
    if (text.charCodeAt(p) === C_LP) {
      let q = p + 1;
      while (q < n && (text.charCodeAt(q) === C_SP || text.charCodeAt(q) === C_TAB || text.charCodeAt(q) === C_LF)) q++;
      if (q < n) {
        if (text.charCodeAt(q) === C_RP) {
          href = '';
          p = q + 1;
          inlineOk = true;
        } else {
          const ld = linkDest(text, q);
          if (ld) {
            href = ld.href;
            title = ld.title;
            let r = ld.end;
            while (r < n && (text.charCodeAt(r) === C_SP || text.charCodeAt(r) === C_TAB || text.charCodeAt(r) === C_LF)) r++;
            if (text.charCodeAt(r) === C_RP) {
              p = r + 1;
              inlineOk = true;
            }
          }
        }
      }
    }
    if (!inlineOk) {
      // Reference form (full / collapsed / shortcut), or the fallback
      // when an inline '(...)' failed to parse.
      let label = null;
      if (text.charCodeAt(p) === C_LB) {
        let depth = 1;
        let r = p + 1;
        while (r < n) {
          const c = text.charCodeAt(r);
          if (c === C_BS) { r += 2; continue; }
          // A link label cannot contain an unescaped '[' (cm-547:
          // '[foo][ref[bar]]' is not a link, and '[ref[bar]]: /uri'
          // is not a definition).
          if (c === C_LB) return -1;
          if (c === C_RB) {
            depth--;
            if (depth === 0) break;
            r++;
            continue;
          }
          r++;
        }
        if (depth !== 0) return -1;
        label = text.slice(p + 1, r);
        // An empty second bracket is a collapsed reference: the label is
        // the link text itself ('[foo][]' == '[foo]').
        if (label === '') label = b.labelText;
        p = r + 1;
      } else {
        label = b.labelText;
      }
      if (label === null || label === undefined) return -1;
      // Labels match RAW (backslashes kept, case-folded, whitespace
      // collapsed) on both sides: '[bar][foo\!]' does NOT match a
      // '[foo!]' definition (cm-545), but identical raw labels do
      // (cm-194 def 'Foo*bar\]' == link 'Foo*bar\]'; cm-549).
      const ref = ctx.refs.get(normLabel(label));
      if (!ref) return -1;
      href = ref.href;
      title = ref.title;
    }
    const oldLen = segs.length;
    const children = segs.slice(b.segIdx + 1);
    // A link's text may not contain a link (cm-520: the middle '[' in
    // '![[[foo](uri1)](uri2)](uri3)' cannot form a link at '](uri2)'
    // because its text already holds '[foo](uri1)'). An image's alt
    // text MAY contain a link (it renders as plain text), so this check
    // applies to links only. Return -1 so the caller pops this bracket
    // and treats the ']' as literal text.
    if (!b.image && containsLink(children)) return -1;
    // Delimiters inside the link/image text are no longer usable.
    for (const dd of delims) {
      if (dd.active && dd.pos > b.segIdx && dd.pos < oldLen) dd.active = false;
    }
    // A link's text may not contain a link: forming a link deactivates
    // only the brackets at/inside it (the opening bracket itself and any
    // opened inside its text — they are consumed). Brackets opened BEFORE
    // it stay active; a later ']' that tries one of them will fail the
    // contains-a-link check below (cm-520: '![[[foo](uri1)](uri2)](uri3)'
    // must NOT form the image at '](uri2)' — that ']' tries the middle
    // '[' first, fails, pops it, and only '](uri3)' reaches the '![ ').
    // An image's alt text MAY contain a link (renders as plain text).
    for (let k = bIdx; k < brackets.length; k++) brackets[k].active = false;
    if (b.image) {
      const alt = altText(children);
      segs.length = b.segIdx;
      segs.push({ t: 'image', href, title, alt });
    } else {
      segs.length = b.segIdx;
      segs.push({ t: 'link', href, title, children });
    }
    return p;
  }

  while (i < n) {
    const c = text.charCodeAt(i);
    // --- backslash escape / line ending ---
    if (c === C_BS) {
      if (i + 1 < n && text.charCodeAt(i + 1) === C_LF) {
        // A backslash at the tail of an extended-autolink URL belongs to
        // the URL (marked's url rule consumes it before the br rule), so
        // it stays literal text: 'https://www.example.com/of.\' + newline
        // links the '.\' (doc-10/37) and 'www.flux.com\' + newline links
        // the '\' (doc-40). Otherwise '\' + newline is a hard break.
        if (urlTailBackslash(text, textStart, i)) {
          i++;
          continue;
        }
        flushText(i);
        segs.push({ t: 'br' });
        i += 2;
        // A hard break strips the next line's leading whitespace
        // (cm-637: 'foo\\\n     bar' -> 'foo<br>bar').
        while (i < n && (text.charCodeAt(i) === C_SP || text.charCodeAt(i) === C_TAB)) i++;
        textStart = i;
        continue;
      }
      if (i + 1 < n && isAsciiPunct(text.charCodeAt(i + 1))) {
        flushText(i);
        // An escaped character is a literal: it must not merge with the
        // following text (an escaped '&' must not start an entity reference).
        segs.push({ t: 'esc', s: text[i + 1] });
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === C_LF) {
      // Hard break: two or more spaces immediately before the newline.
      let sp = 0;
      let k = i - 1;
      while (k >= textStart && text.charCodeAt(k) === C_SP) {
        sp++;
        k--;
      }
      if (sp >= 2) {
        flushText(i - sp);
        segs.push({ t: 'br' });
        i++;
        // A hard break strips the next line's leading whitespace
        // (cm-636: 'foo  \n     bar' -> 'foo<br>bar').
        while (i < n && (text.charCodeAt(i) === C_SP || text.charCodeAt(i) === C_TAB)) i++;
        textStart = i;
        continue;
      }
      flushText(i);
      const last = segs[segs.length - 1];
      if (last && last.t === 'text') last.s += '\n';
      else segs.push({ t: 'text', s: '\n' });
      i++;
      textStart = i;
      continue;
    }
    // --- code span ---
    if (c === C_BT) {
      const cs = codeSpan(text, i);
      if (cs) {
        flushText(i);
        segs.push({ t: 'code', s: cs.content });
        i = cs.end;
        textStart = i;
        continue;
      }
      // No closing run of the same length: the WHOLE opening run is
      // literal text. Advance past all of it, so a double backtick is not
      // retried as a single-backtick opener (doc-01: '``default`...' —
      // the '``' is literal and the '`' after 'default' opens the span).
      while (i < n && text.charCodeAt(i) === C_BT) i++;
      continue;
    }
    // --- emphasis delimiters ---
    if (c === C_STAR || c === C_UNDER || c === C_TILDE) {
      const r = delimRun(text, i);
      if (c === C_TILDE && r.run > 2) {
        // Runs of 3+ tildes are literal.
        i += r.run;
        continue;
      }
      if (!r.open && !r.close) {
        // Intra-word '_' (and similar): can neither open nor close, so it
        // is literal text — do NOT split the text segment here (gfm-632:
        // 'a.b-c_d@a.b' must stay one segment so the email autolink
        // matches the whole address).
        i += r.run;
        continue;
      }
      flushText(i);
      const seg = { t: 'delim', ch: c, run: r.run };
      segs.push(seg);
      const delim = {
        ch: c,
        seg,
        pos: segs.length - 1,
        run: r.run,
        open: r.open,
        close: r.close,
        active: true,
        srcPos: i,
      };
      delims.push(delim);
      if (r.close) processEmphasis(delims.length - 1);
      i += r.run;
      textStart = i;
      continue;
    }
    // --- links / images ---
    if (c === C_LB) {
      flushText(i);
      segs.push({ t: 'bracket', s: '[' });
      brackets.push({ segIdx: segs.length - 1, srcPos: i, labelText: null, image: false, active: true });
      i++;
      textStart = i;
      continue;
    }
    if (c === C_BANG && i + 1 < n && text.charCodeAt(i + 1) === C_LB) {
      flushText(i);
      segs.push({ t: 'bracket', s: '![' });
      brackets.push({ segIdx: segs.length - 1, srcPos: i, labelText: null, image: true, active: true });
      i += 2;
      textStart = i;
      continue;
    }
    if (c === C_RB) {
      let bIdx = -1;
      for (let k = brackets.length - 1; k >= 0; k--) {
        if (brackets[k].active) { bIdx = k; break; }
      }
      if (bIdx === -1) {
        i++;
        continue;
      }
      // Flush the pending text first: it is part of the link text.
      flushText(i);
      const b = brackets[bIdx];
      // The label for a shortcut reference is the RAW source text between
      // the brackets (cm-554/558/573: '*foo* bar' must match the def
      // label '*foo* bar' — the rendered segments lose the asterisks).
      b.labelText = b.image ? text.slice(b.srcPos + 2, i) : text.slice(b.srcPos + 1, i);
      const end = tryLink(bIdx, i + 1);
      if (end !== -1) {
        i = end;
        textStart = i;
        continue;
      }
      // Not a link: the bracket stays literal.
      b.active = false;
      textStart = i; // the ']' starts a new pending run (the text before it
      // was already flushed)
      i++;
      continue;
    }
    // --- autolinks / raw HTML ---
    if (c === C_LT) {
      const al = angleLink(text, i);
      if (al) {
        flushText(i);
        segs.push({ t: 'link', href: al.href, title: null, children: [{ t: 'text', s: al.text }], autolink: true });
        i = al.end;
        textStart = i;
        continue;
      }
      const h = rawTag(text, i);
      if (h !== -1) {
        const tagText = text.slice(i, h);
        flushText(i);
        segs.push({ t: 'html', s: tagText });
        // Track inRaw state for <pre|code|kbd|script> (marked's
        // startPreScriptTag/endPreScriptTag: the name must be followed by
        // whitespace or '>' — a self-closing '<pre/>' does NOT set it).
        // Any of the four closing tags clears it.
        const m = /^<\/?(pre|code|kbd|script)(?:[\s>]|$)/i.exec(tagText);
        if (m) {
          if (tagText.charCodeAt(1) === C_SLASH) inRaw = null;
          else inRaw = m[1].toLowerCase();
        }
        // Persistent inLink: only an opening '<a ' tag (marked's
        // startATag /^<a /i — '<a>' and '<a/>' do NOT set it) sets it,
        // '</a>' clears it. It persists across blocks: a multi-line '<a>'
        // tag is a paragraph, so the '<a>' opens a link context that is
        // never closed, and extended autolinks (email/www/scheme) in later
        // paragraphs are suppressed (doc-03 'Callback@moss.example.com').
        // Angle-bracket autolinks and explicit links are NOT suppressed.
        if (/^<a /i.test(tagText)) ctx.inLink = true;
        else if (/^<\/a>/i.test(tagText)) ctx.inLink = false;
        i = h;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  flushText(n);
  // Remaining delimiter segments are literal text.
  const out = [];
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    if (!s) continue;
    if (s.t === 'delim') {
      if (s.run > 0) {
        out.push({ t: 'text', s: (s.ch === C_TILDE ? '~' : s.ch === C_STAR ? '*' : '_').repeat(s.run) });
      }
      continue;
    }
    out.push(s);
  }
  return out;
}

// Render the plain-text alternative of a segment list (for image alt text).
function altText(children) {
  let out = '';
  for (const c of children) {
    if (c.t === 'text') out += c.s;
    else if (c.t === 'esc') out += c.s;
    else if (c.t === 'delim') out += (c.ch === C_TILDE ? '~' : c.ch === C_STAR ? '*' : '_').repeat(c.run);
    else if (c.t === 'raw') out += c.s;
    else if (c.t === 'html') out += c.s;
    else if (c.t === 'code') out += c.s;
    else if (c.t === 'image') out += c.alt;
    else if (c.t === 'bracket') out += c.s; // a literal '[' (or '![') that
    // never formed a link/image renders as-is in alt text (cm-520:
    // the middle '[' of '![[[foo](uri1)](uri2)](uri3)' is part of the
    // alt '[foo](uri2)')
    else if (c.children) out += altText(c.children);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extended autolinks (GFM): a post-pass that splits text nodes.
// ---------------------------------------------------------------------------

const WWW_RE = /^(www\.)(?:[a-zA-Z0-9-]+\.?)+[^\s<]*/;
const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]{1,31}):[^\s<]*/;
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+/;

function trailPunct(ch) {
  return ch === '?' || ch === '!' || ch === '.' || ch === ',' || ch === ':' || ch === ';' || ch === '*' || ch === '_' || ch === '~' || ch === "'" || ch === '"' || ch === '(';
}

// Marked's _backpedal, applied until stable: strip trailing punctuation
// ('?' '!' '.' ',' ':' ';' '*' '_' '~' "'" '"' '(') and a trailing ')'
// ONLY when it is not the close of a balanced '(...)' group (the group
// '\([^)]*\)' is kept whole). A trailing '&...;' that looks like an entity
// reference is not part of the autolink either.
function trimAutoEnd(s) {
  let end = s.length;
  // A trailing '&...;' that looks like an entity reference is not part of
  // the autolink (gfm-627: 'www.google.com/search?q=commonmark&hl;' links
  // only up to 'commonmark'; '&hl;' stays literal).
  const amp = s.lastIndexOf('&', end - 1);
  if (amp >= 0) {
    const tail = s.slice(amp + 1, end);
    if (/^[a-zA-Z0-9]+;$/.test(tail)) end = amp;
  }
  let changed = true;
  while (changed) {
    changed = false;
    while (end > 0 && trailPunct(s[end - 1])) { end--; changed = true; }
    if (end > 0 && s[end - 1] === ')') {
      // Protected when it closes a balanced group: scan back for the
      // nearest '(' or ')'; '(' first (nothing between) means balanced.
      let j = end - 2;
      while (j >= 0 && s[j] !== '(' && s[j] !== ')') j--;
      if (j < 0 || s[j] === ')') { end--; changed = true; }
    }
  }
  return end;
}

// Apply extended autolinks to a segment list (recursively into children).
function extAutolinks(segs) {
  const out = [];
  for (let segIdx = 0; segIdx < segs.length; segIdx++) {
    const seg = segs[segIdx];
    if (seg.t === 'text') {
      // Inside an unclosed '<a>' (ctx.inLink, set while scanning this or
      // an earlier paragraph's inline text) extended autolinks do not
      // form — the text is already inside a link.
      if (seg.inLink) { out.push(seg); continue; }
      const s = seg.s;
      let i = 0;
      let buf = '';
      while (i < s.length) {
        // A candidate must be preceded by start-of-text, whitespace, '*', '_',
        // '~', '(', or '<' (cm-602: the scheme autolink in
        // '<https://foo.bar/baz bim>' follows a literal '<').
        const prev = i === 0 ? '' : s[i - 1];
        const prevOk = i === 0 || prev === ' ' || prev === '\t' || prev === '\n' || prev === '*' || prev === '_' || prev === '~' || prev === '(' || prev === '<';
        let m = null;
        let href = null;
        let kind = null;
        if (prevOk) {
          const rest = s.slice(i);
          if (rest.startsWith('www.')) {
            m = WWW_RE.exec(rest);
            if (m) { kind = 'www'; }
          } else if (/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(rest)) {
            m = SCHEME_RE.exec(rest);
            if (m) { kind = 'scheme'; }
          }
        }
        if (!m) {
          // A bare email may start after any character that cannot continue
          // an email address (marked's text rule stops before it): 'foo:'
          // is text, then 'bar@baz.com' links (the scheme 'foo:' is not
          // mailto/xmpp, so it is not an autolink itself).
          const prevEmailOk = i === 0 || !/[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(prev);
          if (prevEmailOk) {
            const em = EMAIL_RE.exec(s.slice(i));
            if (em) { m = em; kind = 'email'; }
          }
        }
        if (m) {
          let raw = m[0];
          // A scheme autolink needs '://' OR an email ('@') after the
          // scheme, and the email case allows at most ONE '/segment'
          // (gfm-635: 'xmpp:foo@bar.baz/txt/bin' links only '/txt';
          // 'foo:bar/baz' and 'http:foo/bar/baz' are not links at all).
          // A trailing '/' after the email is not part of the link
          // (gfm-633: 'mailto:a.b-c_d@a.b/' links only the email).
          if (kind === 'scheme') {
            const ci = raw.indexOf(':');
            const scheme = raw.slice(0, ci).toLowerCase();
            const after = raw.slice(ci + 1);
            // Marked's url rule only takes http/https/ftp for '://' and
            // mailto/xmpp for the email form; any other scheme is not an
            // autolink (a bare email inside it may still link on its own).
            if (after.startsWith('//')) {
              if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ftp') {
                buf += s[i];
                i++;
                continue;
              }
              // :// autolink — keep the full match.
            } else if (after.includes('@')) {
              if (scheme !== 'mailto' && scheme !== 'xmpp') {
                buf += s[i];
                i++;
                continue;
              }
              const atIdx = after.indexOf('@');
              const slashIdx = after.indexOf('/', atIdx);
              let effEnd;
              if (slashIdx === -1) {
                effEnd = after.length;
              } else {
                // One segment: up to the next '/', '?', '#', or end.
                let segEnd = slashIdx + 1;
                while (segEnd < after.length) {
                  const c = after[segEnd];
                  if (c === '/' || c === '?' || c === '#') break;
                  segEnd++;
                }
                // An empty segment ('mailto:a.b-c_d@a.b/') is not part of
                // the link — the '/' stays outside.
                effEnd = segEnd === slashIdx + 1 ? slashIdx : segEnd;
              }
              raw = raw.slice(0, ci + 1 + effEnd);
              // The email part must be valid: its domain must not end
              // with '-' or '_' (gfm-633: 'mailto:a.b-c_d@a.b-' and
              // 'mailto:a.b-c_d@a.b_' are not links at all).
              const emailPart = after.slice(0, slashIdx === -1 ? after.length : slashIdx);
              const lastCh = emailPart[emailPart.length - 1];
              if (lastCh === '-' || lastCh === '_') {
                buf += s[i];
                i++;
                continue;
              }
              // And the char after the (truncated) match must not be
              // '-', '_' or alphanumeric (it would continue the email).
              // It may be in the NEXT segment (a trailing '_' is its own
              // delim segment), so check there too.
              let nextCh = s[i + raw.length];
              if (nextCh === undefined && i + raw.length >= s.length && segIdx + 1 < segs.length) {
                const nx = segs[segIdx + 1];
                if (nx.t === 'delim') nextCh = nx.s[0];
                else if (nx.t === 'text') nextCh = nx.s[0];
                else if (nx.t === 'esc') nextCh = nx.s[0];
              }
              if (nextCh === '-' || nextCh === '_' || (nextCh >= '0' && nextCh <= '9') || (nextCh >= 'a' && nextCh <= 'z') || (nextCh >= 'A' && nextCh <= 'Z')) {
                buf += s[i];
                i++;
                continue;
              }
            } else {
              // No '://' and no '@' — not a scheme autolink.
              buf += s[i];
              i++;
              continue;
            }
          }
          const end = trimAutoEnd(raw);
          const linkText = raw.slice(0, end);
          if (end > 0) {
            // A scheme autolink must keep ':' + at least one real path
            // character after trimming: 'inline:.' matches SCHEME_RE as
            // 'inline' + ':' + '.', but the '.' is trailing punctuation,
            // so trimming leaves just 'inline' — a bare word, not a
            // link. Reject it (do NOT link a word merely followed by
            // ':' and punctuation). Same for 'data:.' etc.
            if (kind === 'scheme') {
              const ci = linkText.indexOf(':');
              if (ci === -1 || !/[A-Za-z0-9]/.test(linkText.slice(ci + 1))) {
                buf += s[i];
                i++;
                continue;
              }
            }
            // An email followed by '-', '_' or an alphanumeric is part of
            // a longer (invalid) word, not an autolink (gfm-632:
            // 'a.b-c_d@a.b-' and 'a.b-c_d@a.b_' are not links, but
            // 'a.b-c_d@a.b.' is — the '.' is trailing punctuation).
            // The following char may be in the NEXT segment (a trailing
            // '_' is its own delim segment), so check there too when the
            // match ends at this segment's boundary.
            if (kind === 'email') {
              let after = s[i + end];
              if (after === undefined && i + end >= s.length && segIdx + 1 < segs.length) {
                const nx = segs[segIdx + 1];
                if (nx.t === 'delim') after = nx.s[0];
                else if (nx.t === 'text') after = nx.s[0];
                else if (nx.t === 'esc') after = nx.s[0];
              }
              if (after === '-' || after === '_' || (after >= '0' && after <= '9') || (after >= 'a' && after <= 'z') || (after >= 'A' && after <= 'Z')) {
                buf += s[i];
                i++;
                continue;
              }
            }
            // The href is the TRIMMED url (trailing punctuation and
            // unbalanced ')' are not part of the link).
            href = kind === 'www' ? 'http://' + linkText : kind === 'email' ? 'mailto:' + linkText : linkText;
            if (buf) { out.push({ t: 'text', s: buf }); buf = ''; }
            out.push({ t: 'link', href, title: null, children: [{ t: 'text', s: linkText }], autolink: true });
            i += end;
            continue;
          }
        }
        buf += s[i];
        i++;
      }
      if (buf) out.push({ t: 'text', s: buf });
    } else if (seg.children) {
      // Never create an autolink inside a link's text.
      if (seg.t === 'link') {
        out.push(seg);
      } else {
        const copy = { ...seg, children: extAutolinks(seg.children) };
        out.push(copy);
      }
    } else {
      out.push(seg);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderSegs(segs, ctx, out) {
  for (const seg of segs) {
    switch (seg.t) {
      case 'text':
        out.push(escapeText(seg.s));
        break;
      case 'esc':
        out.push(escapeEncode(seg.s));
        break;
      case 'bracket':
        out.push(seg.s);
        break;
      case 'delim':
        // A delimiter that survived inside link/em children (the top-level
        // cleanup does not recurse) renders as its literal run.
        if (seg.run > 0) out.push((seg.ch === C_TILDE ? '~' : seg.ch === C_STAR ? '*' : '_').repeat(seg.run));
        break;
      case 'raw':
        out.push(seg.s);
        break;
      case 'html':
        out.push(seg.s);
        break;
      case 'code':
        out.push('<code>');
        out.push(escapeEncode(seg.s));
        out.push('</code>');
        break;
      case 'br':
        out.push('<br>');
        break;
      case 'em':
        out.push('<em>');
        renderSegs(seg.children, ctx, out);
        out.push('</em>');
        break;
      case 'strong':
        out.push('<strong>');
        renderSegs(seg.children, ctx, out);
        out.push('</strong>');
        break;
      case 'del':
        out.push('<del>');
        renderSegs(seg.children, ctx, out);
        out.push('</del>');
        break;
      case 'link': {
        const href = cleanUrl(seg.href);
        if (href === null) {
          // Invalid URL: render as literal text (the children).
          renderSegs(seg.children, ctx, out);
          break;
        }
        out.push('<a href="');
        out.push(seg.autolink ? escapeEncode(href) : escapeText(href));
        out.push('"');
        if (seg.title !== null && seg.title !== undefined) {
          out.push(' title="');
          out.push(escapeText(seg.title));
          out.push('"');
        }
        out.push('>');
        // An autolink's text is the URL itself, escaped with encode=true.
        if (seg.autolink && seg.children.length === 1 && seg.children[0].t === 'text') {
          out.push(escapeEncode(seg.children[0].s));
        } else {
          renderSegs(seg.children, ctx, out);
        }
        out.push('</a>');
        break;
      }
      case 'image': {
        const href = cleanUrl(seg.href);
        if (href === null) {
          out.push(escapeText(seg.alt));
          break;
        }
        out.push('<img src="');
        out.push(escapeText(href));
        out.push('" alt="');
        out.push(escapeText(seg.alt));
        out.push('"');
        if (seg.title !== null && seg.title !== undefined) {
          out.push(' title="');
          out.push(escapeText(seg.title));
          out.push('"');
        }
        out.push('>');
        break;
      }
    }
  }
}

// Render one block's inline text to HTML.
function inlineHtml(text, ctx) {
  let segs = inlineParse(text, ctx);
  segs = extAutolinks(segs);
  const out = [];
  renderSegs(segs, ctx, out);
  return out.join('');
}

function blocksHtml(blocks, ctx, out) {
  for (const b of blocks) {
    switch (b.t) {
      case 'p': {
        out.push('<p>');
        out.push(inlineHtml(b.text, ctx));
        out.push('</p>\n');
        break;
      }
      case 'h': {
        out.push('<h');
        out.push(String(b.level));
        out.push('>');
        out.push(inlineHtml(b.text, ctx));
        out.push('</h');
        out.push(String(b.level));
        out.push('>\n');
        break;
      }
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'icode': {
        out.push('<pre><code>');
        out.push(escapeEncode(b.text));
        out.push('</code></pre>\n');
        break;
      }
      case 'code': {
        out.push('<pre><code');
        if (b.lang) {
          out.push(' class="language-');
          out.push(escapeText(b.lang));
          out.push('"');
        }
        out.push('>');
        out.push(escapeEncode(b.text));
        out.push('</code></pre>\n');
        break;
      }
      case 'html':
        out.push(b.text);
        break;
      case 'q': {
        out.push('<blockquote>\n');
        blocksHtml(b.blocks, ctx, out);
        out.push('</blockquote>\n');
        break;
      }
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out.push('<');
        out.push(tag);
        if (b.ordered && b.start !== 1) {
          out.push(' start="');
          out.push(String(b.start));
          out.push('"');
        }
        out.push('>\n');
        for (const item of b.items) {
          const checkbox = item.task
            ? (item.checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ')
            : '';
          out.push('<li>');
          if (item.blocks.length === 0) {
            out.push('</li>\n');
            continue;
          }
          // In a tight list every paragraph of an item is a "text" token
          // (top=false skips the paragraph tokenizer) and renders bare
          // (no <p> wrapper, no trailing newline); in a loose list the
          // text tokens were converted back to paragraphs and wrap.
          for (let bi = 0; bi < item.blocks.length; bi++) {
            const ib = item.blocks[bi];
            if (ib.t === 'p' && !b.loose) {
              if (bi === 0) out.push(checkbox);
              out.push(inlineHtml(ib.text, ctx));
            } else if (ib.t === 'p') {
              out.push('<p>');
              if (bi === 0) out.push(checkbox);
              out.push(inlineHtml(ib.text, ctx));
              out.push('</p>\n');
            } else {
              if (bi === 0) out.push(checkbox);
              blocksHtml([ib], ctx, out);
            }
          }
          out.push('</li>\n');
        }
        out.push('</');
        out.push(tag);
        out.push('>\n');
        break;
      }
      case 'table': {
        out.push('<table>\n<thead>\n<tr>\n');
        for (let ci = 0; ci < b.header.length; ci++) {
          const a = b.align[ci];
          out.push('<th');
          if (a) { out.push(' align="'); out.push(a); out.push('"'); }
          out.push('>');
          out.push(inlineHtml(b.header[ci], ctx));
          out.push('</th>\n');
        }
        out.push('</tr>\n</thead>\n');
        if (b.rows.length > 0) {
          out.push('<tbody>');
          for (const row of b.rows) {
            out.push('<tr>\n');
            for (let ci = 0; ci < row.length; ci++) {
              const a = b.align[ci];
              out.push('<td');
              if (a) { out.push(' align="'); out.push(a); out.push('"'); }
              out.push('>');
              out.push(inlineHtml(row[ci], ctx));
              out.push('</td>\n');
            }
            out.push('</tr>\n');
          }
          out.push('</tbody>');
        }
        out.push('</table>\n');
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parse(src) {
  if (src.length === 0) return '';
  // Split into lines, tracking termination.
  const rawLines = src.split('\n');
  const views = [];
  for (let i = 0; i < rawLines.length; i++) {
    const term = i < rawLines.length - 1 || src.endsWith('\n');
    // Drop a trailing '\r' (CRLF).
    let s = rawLines[i];
    if (s.endsWith('\r')) s = s.slice(0, -1);
    views.push({ s, col: 0, ind: -1, cs: -1, term });
  }
  // A final empty line produced by a trailing newline is not a real line.
  if (src.endsWith('\n')) views.pop();
  const ctx = { refs: new Map(), isTop: true, inLink: false };
  const blocks = [];
  blockParse(views, 0, views.length, ctx, blocks);
  const out = [];
  blocksHtml(blocks, ctx, out);
  return out.join('');
}
