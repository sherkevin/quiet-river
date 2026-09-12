'use strict';

const { parseXML, children, child, descendant, textOf, attr } = require('./xml');
const { absolute } = require('./http');

const SUMMARY_LIMIT = 400;

// CJK text has no inter-word spaces, so stripping a tag must not inject one.
const CJK = /[\u2E80-\u9FFF\u3000-\u303F\u3040-\u30FF\u3130-\u318F\uAC00-\uD7AF\uFF00-\uFFEF]/;
const TAG_GAP = '\u0000';

function stripHTML(html) {
  if (!html) return '';
  return html
    .replace(/<\s*(script|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr|td|th|blockquote|pre|section|article|ul|ol|table|figure|figcaption|dd|dt)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, TAG_GAP)
    .replace(/\u0000/g, (_marker, offset, str) => {
      const before = str[offset - 1] || '';
      const after = str[offset + 1] || '';
      return CJK.test(before) || CJK.test(after) ? '' : ' ';
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clamp(text, limit = SUMMARY_LIMIT) {
  if (!text) return '';
  if (text.length <= limit) return text;
  return text.slice(0, limit).replace(/\s+\S*$/, '') + '…';
}

function parseDate(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  let ms = Date.parse(trimmed);
  if (Number.isFinite(ms)) return ms;
  // RFC 822 with a numeric offset written without a colon, e.g. +0800
  const fixed = trimmed.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  ms = Date.parse(fixed);
  if (Number.isFinite(ms)) return ms;
  // "Sat, 6 Sep 2026 12:00:00 GMT" variants with extra whitespace
  ms = Date.parse(trimmed.replace(/\s+/g, ' '));
  return Number.isFinite(ms) ? ms : null;
}

function firstImageFromHTML(html, baseUrl) {
  if (!html) return null;
  const m = /<img\b[^>]*?\bsrc\s*=\s*("([^"]+)"|'([^']+)')/i.exec(html);
  const src = m ? m[2] || m[3] : null;
  return src ? absolute(baseUrl, src) : null;
}

function pickLink(entry, baseUrl) {
  const links = children(entry, 'link');
  if (links.length === 0) return textOf(entry) ? absolute(baseUrl, textOf(child(entry, 'link'))) : null;
  // Atom: prefer rel="alternate", then no rel, then anything with href.
  const alternate = links.find((l) => (attr(l, 'rel') || 'alternate') === 'alternate' && attr(l, 'href'));
  const anyHref = links.find((l) => attr(l, 'href'));
  const chosen = alternate || anyHref;
  if (chosen && attr(chosen, 'href')) return absolute(baseUrl, attr(chosen, 'href'));
  // RSS: <link> carries the URL as text.
  const asText = textOf(links[0]);
  return asText ? absolute(baseUrl, asText) : null;
}

function pickImage(entry, baseUrl) {
  for (const name of ['thumbnail', 'content', 'group']) {
    for (const node of children(entry, name)) {
      const localUrl = attr(node, 'url');
      const medium = attr(node, 'medium');
      if (localUrl && (name === 'thumbnail' || medium === 'image' || !medium)) {
        const resolved = absolute(baseUrl, localUrl);
        if (resolved) return resolved;
      }
      if (name === 'group') {
        const nested = pickImage(node, baseUrl);
        if (nested) return nested;
      }
    }
  }
  const enclosure = children(entry, 'enclosure').find((e) => /^image\//i.test(attr(e, 'type') || ''));
  if (enclosure && attr(enclosure, 'url')) return absolute(baseUrl, attr(enclosure, 'url'));
  return null;
}

function cleanAuthorName(raw) {
  if (!raw) return '';
  const trimmed = raw.trim();
  // RSS <author> is often "mail@example.com (Display Name)".
  const paren = /\(([^)]+)\)/.exec(trimmed);
  if (paren && paren[1].trim()) return paren[1].trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return trimmed.split('@')[0];
  return trimmed;
}

function pickAuthor(entry) {
  const authorNode = child(entry, 'author');
  if (authorNode) {
    const name = cleanAuthorName(textOf(child(authorNode, 'name')) || textOf(authorNode));
    if (name) return name;
  }
  for (const name of ['creator', 'writer', 'publisher', 'contributor']) {
    const value = cleanAuthorName(textOf(child(entry, name)));
    if (value) return value;
  }
  return '';
}

function normalizeItem(raw, baseUrl, feedTitle) {
  const title = stripHTML(textOf(child(raw, 'title'))) || '(无标题)';
  const link = pickLink(raw, baseUrl);
  const guidNode = child(raw, 'guid') || child(raw, 'id');
  const guid = textOf(guidNode) || link || title;
  const dateText =
    textOf(child(raw, 'pubDate')) ||
    textOf(child(raw, 'published')) ||
    textOf(child(raw, 'updated')) ||
    textOf(child(raw, 'date')) ||
    textOf(child(raw, 'modified')) ||
    textOf(child(raw, 'issued'));
  const published = parseDate(dateText);
  const contentNode = child(raw, 'encoded') || child(raw, 'content');
  const summaryNode = child(raw, 'summary') || child(raw, 'description') || child(raw, 'subtitle');
  const contentHTML = contentNode ? contentNode.text : '';
  let summaryHTML = summaryNode ? summaryNode.text : '';
  // arXiv RSS wraps the abstract in "arXiv:2609.05637v2 Announce Type: cross Abstract: ..."
  summaryHTML = summaryHTML.replace(/^\s*arXiv:\d{4}\.\d{4,5}(v\d+)?\s+Announce Type:\s*[\w-]+\s+Abstract:\s*/i, '');
  let summary = clamp(stripHTML(summaryHTML) || stripHTML(contentHTML));
  // GitHub commit feeds repeat the commit message as the description.
  if (summary === title) summary = '';
  // Article-level tags the author or platform attached: RSS <category>,
  // Atom <category term>, dc:subject.
  const categories = [
    ...children(raw, 'category').map((c) => (attr(c, 'term') || textOf(c)).trim()),
    ...children(raw, 'subject').map((c) => textOf(c).trim()),
  ].filter((t, i, arr) => t && arr.indexOf(t) === i);
  const image = pickImage(raw, baseUrl) || firstImageFromHTML(contentHTML || summaryHTML, baseUrl);
  return {
    guid: String(guid),
    title,
    link: link || '',
    author: pickAuthor(raw) || feedTitle || '',
    published,
    summary,
    image,
    categories,
  };
}

function isJsonFeed(body) {
  const head = body.slice(0, 4096).trimStart();
  if (!head.startsWith('{')) return false;
  try {
    const data = JSON.parse(body);
    return typeof data === 'object' && data !== null && (Array.isArray(data.items) || /jsonfeed/i.test(String(data.version || '')));
  } catch {
    return false;
  }
}

function parseJsonFeed(body, baseUrl) {
  const data = JSON.parse(body);
  const feedTitle = data.title || '';
  const items = (data.items || []).map((it) => {
    const published = parseDate(it.date_published || it.date_modified);
    const html = it.content_html || '';
    const text = it.content_text || stripHTML(html);
    return {
      guid: String(it.id || it.url || it.title || ''),
      title: stripHTML(it.title || '') || '(无标题)',
      link: it.url ? absolute(baseUrl, it.url) || it.url : '',
      author: it.author?.name || data.author?.name || feedTitle,
      published,
      summary: clamp(text),
      image: (it.image && absolute(baseUrl, it.image)) || (it.banner_image && absolute(baseUrl, it.banner_image)) || firstImageFromHTML(html, baseUrl),
      categories: [...new Set([...(it.tags || []), ...(it.categories || [])].map(String).filter(Boolean))],
    };
  });
  return { feedTitle, items };
}

function parseXMLFeed(body, baseUrl) {
  const doc = parseXML(body);

  const atomRoot = child(doc, 'feed') || (doc.children.find((c) => c.name === 'feed') ?? null);
  if (atomRoot) {
    const feedTitle = stripHTML(textOf(child(atomRoot, 'title')));
    const items = children(atomRoot, 'entry').map((e) => normalizeItem(e, baseUrl, feedTitle));
    return { feedTitle, items };
  }

  const rssRoot = child(doc, 'rss') || child(doc, 'RDF') || doc.children.find((c) => ['rss', 'RDF'].includes(c.name)) || null;
  if (rssRoot) {
    const channel = child(rssRoot, 'channel') || rssRoot;
    const feedTitle = stripHTML(textOf(child(channel, 'title')));
    const entries = [...children(channel, 'item'), ...children(rssRoot, 'item')];
    const items = entries.map((e) => normalizeItem(e, baseUrl, feedTitle));
    if (items.length === 0) {
      // Some feeds nest items deeper than the spec allows.
      const stray = descendant(rssRoot, 'item');
      if (stray) items.push(normalizeItem(stray, baseUrl, feedTitle));
    }
    return { feedTitle, items };
  }

  // Atom/RSS root not found: some feeds wrap everything in an unexpected element.
  const anyEntry = descendant(doc, 'entry') || descendant(doc, 'item');
  if (anyEntry) {
    const parent = doc.children[0] || doc;
    const feedTitle = stripHTML(textOf(descendant(parent, 'title')));
    const all = [];
    (function walk(node) {
      for (const c of node.children || []) {
        if (['entry', 'item'].includes(c.name.split(':').pop())) all.push(c);
        else walk(c);
      }
    })(doc);
    return { feedTitle, items: all.map((e) => normalizeItem(e, baseUrl, feedTitle)) };
  }

  throw new Error('not a recognised feed format (no <feed>, <rss>, <rdf:RDF>, entry or item)');
}

/**
 * Turn any supported feed body into `{ feedTitle, items }` with a single shape.
 * `baseUrl` is the final URL after redirects, needed to resolve relative links.
 */
function parseFeed(body, baseUrl) {
  if (isJsonFeed(body)) return parseJsonFeed(body, baseUrl);
  return parseXMLFeed(body, baseUrl);
}

function looksLikeFeed(body, contentType = '') {
  if (/rss|atom|xml|json/i.test(contentType)) return true;
  const head = body.slice(0, 2048).replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<rss') || head.startsWith('<feed') || head.startsWith('<rdf')) return true;
  if (head.startsWith('{')) {
    try {
      const data = JSON.parse(body);
      return Array.isArray(data.items) || /jsonfeed/i.test(String(data.version || ''));
    } catch {
      return false;
    }
  }
  return false;
}

module.exports = { parseFeed, looksLikeFeed, stripHTML, clamp, parseDate, SUMMARY_LIMIT };
