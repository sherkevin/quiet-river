'use strict';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00a0', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', middot: '\u00b7',
  laquo: '\u00ab', raquo: '\u00bb', bull: '\u2022', dagger: '\u2020',
};

function decodeEntities(input) {
  if (input.indexOf('&') === -1) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9.]*);/g, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const code = parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const key = entity.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
  });
}

// A `>` inside an attribute value must not end the tag.
function findTagEnd(src, from) {
  let quote = null;
  for (let i = from + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function parseOpenTag(body) {
  const attrs = {};
  const nameMatch = /^([^\s/>]+)([\s\S]*)$/.exec(body);
  if (!nameMatch) return { name: body.trim(), attrs };
  const name = nameMatch[1];
  const rest = nameMatch[2];
  const attrRe = /([^\s=/>]+)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = attrRe.exec(rest)) !== null) {
    const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : '';
    attrs[m[1]] = decodeEntities(value);
  }
  return { name, attrs };
}

function appendText(node, chunk, decode) {
  if (!chunk) return;
  node.text += decode ? decodeEntities(chunk) : chunk;
}

/**
 * Parse RSS/Atom-grade XML into a tree. Deliberately not a conforming XML
 * processor: real-world feeds carry unclosed tags, stray `&`, and mismatched
 * nesting, and a strict parser would reject the whole document. This one
 * degrades to whatever it could read instead.
 */
function parseXML(source) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const len = source.length;
  let i = 0;

  while (i < len) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      appendText(stack[stack.length - 1], source.slice(i), true);
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1], source.slice(i, lt), true);

    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      const stop = end === -1 ? len : end;
      appendText(stack[stack.length - 1], source.slice(lt + 9, stop), false);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const end = findTagEnd(source, lt);
      i = end === -1 ? len : end + 1;
      continue;
    }

    const gt = findTagEnd(source, lt);
    if (gt === -1) break;
    const raw = source.slice(lt + 1, gt);
    i = gt + 1;

    if (raw[0] === '/') {
      const closing = raw.slice(1).trim().split(/\s/)[0];
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === closing) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const selfClosing = /\/$/.test(raw.trim());
    const { name, attrs } = parseOpenTag(selfClosing ? raw.replace(/\/\s*$/, '') : raw);
    const node = { name, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

const localName = (name) => (name.indexOf(':') === -1 ? name : name.slice(name.indexOf(':') + 1));

/** Direct children matching a local name, namespace prefix ignored. */
function children(node, name) {
  if (!node || !node.children) return [];
  return node.children.filter((child) => localName(child.name) === name);
}

function child(node, name) {
  return children(node, name)[0] || null;
}

/** First descendant at any depth matching a local name. */
function descendant(node, name) {
  if (!node || !node.children) return null;
  for (const c of node.children) {
    if (localName(c.name) === name) return c;
    const found = descendant(c, name);
    if (found) return found;
  }
  return null;
}

function textOf(node) {
  return node ? node.text.trim() : '';
}

function attr(node, name) {
  if (!node || !node.attrs) return undefined;
  if (node.attrs[name] !== undefined) return node.attrs[name];
  for (const key of Object.keys(node.attrs)) {
    if (localName(key) === name) return node.attrs[key];
  }
  return undefined;
}

module.exports = { parseXML, children, child, descendant, textOf, attr, localName, decodeEntities };
