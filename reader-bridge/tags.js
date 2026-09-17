'use strict';
// Shared tag contract: preserve spelling, trim whitespace, normalize Unicode, deduplicate.
// An empty array deliberately clears tags; never fall back to the blogger in that case.
function normalizeTags(value) {
  const invalid = () => Object.assign(new Error('invalid tags: expected up to 50 nonempty strings, each at most 80 characters'), {status:400});
  if (!Array.isArray(value) || value.length > 50) throw invalid();
  const result = [];
  for (const raw of value) {
    if (typeof raw !== 'string') throw invalid();
    const tag = raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
    if (!tag || [...tag].length > 80 || /[\u0000-\u001f\u007f]/u.test(raw)) throw invalid();
    if (!result.includes(tag)) result.push(tag);
  }
  return result;
}
function containsAllTags(available, required) {
  const set = new Set(available || []);
  return required.every(tag => set.has(tag));
}
function requestedTags(tags, tag) {
  return normalizeTags(tags !== undefined ? tags : tag ? [tag] : []);
}
module.exports = {normalizeTags, containsAllTags, requestedTags};
