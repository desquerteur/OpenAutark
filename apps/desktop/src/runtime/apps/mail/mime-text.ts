// B-053 track D: the text pieces of mail – charsets (TextDecoder, Latin-1 fallback), RFC 2047 encoded words (B and Q,
// adjacent words joined), quoted-printable and base64 decoding, RFC 2231 parameters, header parameters
// (Content-Type / Content-Disposition), address lists, and HTML → plain text (tags stripped, entities decoded).
// Owns: these decoders (pure). Never: runs or keeps a piece of HTML, or follows a link in it.

export function decodeCharset(bytes: Uint8Array, charset = 'utf-8'): string {
  const label = charset.trim().toLowerCase().replace(/^"|"$/g, '') || 'utf-8';
  try {
    return new TextDecoder(label === 'us-ascii' || label === 'ascii' ? 'windows-1252' : label).decode(bytes);
  } catch {
    return Buffer.from(bytes).toString('latin1');
  }
}

export function decodeQuotedPrintable(text: string): Buffer {
  const out: number[] = [];
  const s = text.replace(/[ \t]+(\r?\n)/g, '$1').replace(/=\r?\n/g, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 61 /* = */ && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; continue; }
    if (ch < 256) out.push(ch);
    else for (const b of Buffer.from(s[i], 'utf8')) out.push(b);
  }
  return Buffer.from(out);
}

export const decodeBase64 = (text: string): Buffer => Buffer.from(text.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

/** RFC 2047 encoded words in a header value; whitespace between two encoded words goes away. */
export function decodeWords(value: string): string {
  if (!value.includes('=?')) return value;
  return value
    .replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)/g, '$1')
    .replace(/(?:=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=)+/g, (run) => {
      // Join adjacent words of one charset before decoding, so a multi-byte character split across words survives.
      const parts: Array<{ charset: string; bytes: Buffer }> = [];
      for (const m of run.matchAll(ENCODED_WORD)) {
        const charset = m[1].split('*')[0];
        const bytes = m[2].toUpperCase() === 'B' ? decodeBase64(m[3]) : decodeQuotedPrintable(m[3].replace(/_/g, ' '));
        const last = parts[parts.length - 1];
        if (last && last.charset.toLowerCase() === charset.toLowerCase()) last.bytes = Buffer.concat([last.bytes, bytes]);
        else parts.push({ charset, bytes });
      }
      return parts.map((p) => decodeCharset(p.bytes, p.charset)).join('');
    });
}

/** A structured header: its first value (lower case) and its parameters (RFC 2231 continuations and charsets). */
export function headerParams(value: string): { value: string; params: Record<string, string> } {
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"' && value[i - 1] !== '\\') quoted = !quoted;
    if (ch === ';' && !quoted) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  const raw: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"')) val = val.slice(1, val.endsWith('"') ? -1 : undefined).replace(/\\(.)/g, '$1');
    raw[key] = val;
  }
  const params: Record<string, string> = {};
  const extended = new Map<string, Array<{ n: number; v: string; enc: boolean }>>();
  for (const [key, val] of Object.entries(raw)) {
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(key);
    if (!m || (m[2] === undefined && !m[3])) { params[key] = decodeWords(val); continue; }
    const list = extended.get(m[1]) ?? [];
    list.push({ n: Number(m[2] ?? 0), v: val, enc: !!m[3] });
    extended.set(m[1], list);
  }
  for (const [name, list] of extended) {
    list.sort((a, b) => a.n - b.n);
    let charset = 'utf-8';
    const bytes: Buffer[] = [];
    for (const piece of list) {
      let v = piece.v;
      if (piece.enc && piece.n === 0) {
        const m = /^([^']*)'[^']*'(.*)$/.exec(v);
        if (m) { charset = m[1] || 'utf-8'; v = m[2]; }
      }
      bytes.push(piece.enc ? Buffer.from(v.replace(/%([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1') : Buffer.from(v, 'utf8'));
    }
    params[name] = decodeCharset(Buffer.concat(bytes), charset);
  }
  return { value: (parts[0] ?? '').trim().toLowerCase(), params };
}

export interface MailAddress { name?: string; address: string }

/** An address list header ("A <a@x>, \"B, C\" <b@y>, c@z (C)") – groups flattened, names decoded. */
export function parseAddressList(value: string | undefined): MailAddress[] {
  if (!value) return [];
  const items: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && quoted) { cur += ch + (value[++i] ?? ''); continue; }
    if (ch === '"' && !paren) quoted = !quoted;
    else if (!quoted && ch === '<') angle++;
    else if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    else if (!quoted && ch === '(') paren++;
    else if (!quoted && ch === ')') paren = Math.max(0, paren - 1);
    if (!quoted && !angle && !paren && (ch === ',' || ch === ';')) { items.push(cur); cur = ''; continue; }
    if (!quoted && !angle && !paren && ch === ':') { cur = ''; continue; } // group name
    cur += ch;
  }
  items.push(cur);
  const out: MailAddress[] = [];
  for (const item of items) {
    const text = item.trim();
    if (!text) continue;
    const angled = /^(.*)<([^<>]*)>\s*(?:\(.*\))?$/.exec(text);
    let address: string;
    let name: string | undefined;
    if (angled) {
      address = angled[2].trim();
      name = angled[1].trim().replace(/^"|"$/g, '').replace(/\\(.)/g, '$1').trim();
    } else {
      const m = /^([^\s()]+)\s*(?:\((.*)\))?$/.exec(text);
      address = m ? m[1] : text;
      name = m?.[2]?.trim();
    }
    if (!address.includes('@')) continue;
    out.push(name ? { name: decodeWords(name), address } : { address });
  }
  return out;
}

export const formatAddress = (a: MailAddress): string => a.name ? `${a.name} <${a.address}>` : a.address;

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—',
  ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', euro: '€',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', agrave: 'à',
  aacute: 'á', ccedil: 'ç', ntilde: 'ñ', oacute: 'ó', iacute: 'í', uacute: 'ú', deg: '°', zwnj: '', zwj: '', shy: '',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (all, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[body] ?? ENTITIES[body.toLowerCase()] ?? all;
  });
}

/** HTML mail → readable plain text: no script/style/head, line breaks for blocks, links as "text (url)". */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|template|svg)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b[^>]*?\bhref\s*=\s*["']?(https?:[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a\s*>/gi, (_all, url: string, inner: string) => {
      const text = inner.replace(/<[^>]*>/g, '').trim();
      return text && !url.includes(text) ? `${text} (${url})` : url;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|tr|h[1-6]|ul|ol|table|blockquote|section|article|header|footer)\s*>/gi, '\n')
    .replace(/<(p|div|tr|h[1-6]|table|blockquote|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  s = decodeEntities(s).replace(/\r/g, '').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
