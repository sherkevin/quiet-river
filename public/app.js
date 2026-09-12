'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const READ_KEY = 'quiet-river:read';
const SORT_KEY = 'quiet-river:sort';
const THEME_KEY = 'quiet-river:theme';

const state = {
  data: null,
  activeTag: null,
  query: '',
  editingId: null,
  autoTimer: null,
  viewAdd: false,
  viewSources: false,
  viewSubId: null,
  sortMode: ['time', 'title', 'author'].includes(localStorage.getItem(SORT_KEY)) ? localStorage.getItem(SORT_KEY) : 'time',
};

let readSet = new Set(JSON.parse(localStorage.getItem(READ_KEY) || 'null') || []);

function saveRead() {
  localStorage.setItem(READ_KEY, JSON.stringify([...readSet].slice(-6000)));
}

/* ---------- formatting ---------- */

function relTime(ms) {
  if (!ms) return '无更新';
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.round(hr / 24);
  if (day === 1) return '昨天';
  if (day < 30) return `${day} 天前`;
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function absTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const HOURS_FRESH = 48;
const DAYS_RECENT = 14;

function freshness(ms) {
  if (!ms) return 'dead';
  const hours = (Date.now() - ms) / 3600000;
  if (hours <= HOURS_FRESH) return 'fresh';
  if (hours <= DAYS_RECENT * 24) return 'recent';
  return 'stale';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- data ---------- */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }
  if (!res.ok) {
    const err = new Error(payload?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

async function loadState() {
  state.data = await api('/api/state');
  render();
}

/* ---------- render ---------- */

// A card's tags are the union of what the platform attached to the article
// (categories) and what you attached to the blogger (tags). Article-level
// comes first because it is finer-grained.
function itemTags(it) {
  return [...(it.manualTags || []), ...(it.categories || []), ...(it.tags || [])];
}

const uniq = (arr) => [...new Set(arr.map(String))];

function matchesTag(it, tag) {
  const want = String(tag).toLowerCase();
  return itemTags(it).some((t) => String(t).toLowerCase() === want);
}

function itemsOf(sub) {
  const q = state.query.trim().toLowerCase();
  return state.data.items.filter((it) => {
    if (it.subId !== sub.id) return false;
    if (state.activeTag && !matchesTag(it, state.activeTag)) return false;
    if (!q) return true;
    return (
      it.title.toLowerCase().includes(q) ||
      it.subName.toLowerCase().includes(q) ||
      (it.author || '').toLowerCase().includes(q)
    );
  });
}

function queryActive() {
  return state.query.trim().length > 0;
}

function applyHash() {
  const m = /^#\/author\/([\w-]+)/.exec(location.hash);
  state.viewSubId = m ? m[1] : null;
  state.viewAdd = location.hash === '#/add';
  state.viewSources = location.hash === '#/sources';
}

function currentViewSub() {
  if (!state.viewSubId || !state.data) return null;
  return state.data.subscriptions.find((s) => s.id === state.viewSubId) || null;
}

function authorOf(card) {
  return card.latest?.author || card.sub.name;
}

function compareCards(a, b) {
  if (state.sortMode === 'title') {
    return (
      (a.latest?.title || '').localeCompare(b.latest?.title || '', 'zh-Hans-CN') ||
      (b.latest?.published || 0) - (a.latest?.published || 0)
    );
  }
  if (state.sortMode === 'author') {
    return (
      authorOf(a).localeCompare(authorOf(b), 'zh-Hans-CN') ||
      (b.latest?.published || 0) - (a.latest?.published || 0)
    );
  }
  return (
    (b.latest?.published || 0) - (a.latest?.published || 0) ||
    authorOf(a).localeCompare(authorOf(b), 'zh-Hans-CN')
  );
}

// 文章流是默认视图：每篇文章一张卡，tag 与搜索同时生效。
function articleCards() {
  const q = state.query.trim().toLowerCase();
  const out = [];
  for (const sub of state.data.subscriptions) {
    for (const it of itemsOf(sub)) {
      if (state.activeTag && !matchesTag(it, state.activeTag)) continue;
      if (
        q &&
        !(
          it.title.toLowerCase().includes(q) ||
          (it.summary || '').toLowerCase().includes(q) ||
          it.subName.toLowerCase().includes(q) ||
          (it.author || '').toLowerCase().includes(q)
        )
      ) {
        continue;
      }
      out.push({ sub, items: [it], latest: it, single: true });
    }
  }
  return out.sort(compareCards);
}

function renderCounts() {
  const scope = state.activeTag ? `「${state.activeTag}」` : '全部';
  const viewSub = currentViewSub();
  if (viewSub) {
    $('#counts').textContent = viewSub.disabled
      ? `${viewSub.name} · 已关闭展示`
      : `${viewSub.name} · ${itemsOf(viewSub).length} 条`;
    return;
  }
  if (state.viewSources) {
    const list = sourceCards();
    const off = list.filter((s) => s.disabled).length;
    $('#counts').textContent = `${scope} ${list.length} 个博主${off ? `（${off} 个已关闭）` : ''}`;
    return;
  }
  if (queryActive()) {
    $('#counts').textContent = `${scope} 搜「${state.query.trim()}」 ${articleCards().length} 条`;
    return;
  }
  const subs = state.data.subscriptions;
  const off = subs.filter((s) => s.disabled).length;
  $('#counts').textContent = `${scope} ${articleCards().length} 篇文章 · ${subs.length - off} 个博主${off ? `（另有 ${off} 个已关闭）` : ''}`;
}

function renderTagbar() {
  const bar = $('#tagbar');
  bar.innerHTML = '';

  const all = document.createElement('button');
  all.className = 'tag';
  all.type = 'button';
  all.setAttribute('aria-pressed', String(!state.activeTag));
  all.textContent = '全部';
  all.onclick = () => { state.activeTag = null; render(); };
  bar.appendChild(all);

  // Union of your author-level tags and the article-level categories the
  // feeds carry, so a tag can be as fine-grained as the platform allows.
  const counts = new Map();
  for (const sub of state.data.subscriptions) {
    if (sub.disabled) continue;
    for (const t of sub.tags || []) if (!counts.has(t)) counts.set(t, 0);
  }
  for (const it of state.data.items) {
    for (const t of new Set(itemTags(it).map(String))) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const tags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
    .slice(0, 60);

  if (!tags.length) {
    const hint = document.createElement('span');
    hint.className = 'tagbar-empty';
    hint.textContent = '还没有 tag —— 添加博主时打上 tag，这里就能按 tag 切换';
    bar.appendChild(hint);
    return;
  }
  for (const [tag, n] of tags) {
    const btn = document.createElement('button');
    btn.className = 'tag';
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(state.activeTag === tag));
    btn.innerHTML = `${esc(tag)}<span class="n">${n}</span>`;
    btn.onclick = () => {
      state.activeTag = state.activeTag === tag ? null : tag;
      render();
    };
    bar.appendChild(btn);
  }
}

function cardNode({ sub, items, latest, single }) {
  const li = document.createElement('li');
  li.className = 'card';

  const problem = state.data.problems.find((p) => p.id === sub.id);
  const level = freshness(latest?.published);

  // Manual tags and the article's own categories win; author-level tags are
  // only a fallback for sources that carry neither.
  const own = latest ? uniq([...(latest.manualTags || []), ...(latest.categories || [])]) : [];
  const chipSource = latest ? (own.length ? own : latest.tags || []) : sub.tags || [];
  const chips = [...new Set(chipSource.map(String))]
    .slice(0, 4)
    .map((t) => `<button class="chip" type="button" data-tag="${esc(t)}">${esc(t)}</button>`)
    .join('');

  const when = latest
    ? `<span class="card-when" title="${esc(absTime(latest.published))}">${esc(relTime(latest.published))}</span>`
    : sub.manual
      ? '<span class="card-when">手动登记</span>'
      : `<span class="card-when dead">${problem ? '抓取失败' : '无更新'}</span>`;

  const body = latest
    ? `<a class="card-title" href="${esc(latest.link || sub.url)}" target="_blank" rel="noopener noreferrer" data-item="${esc(latest.id)}">${esc(latest.title)}</a>
       <p class="card-sum${latest.summary ? '' : ' none'}">${latest.summary ? esc(latest.summary) : '（该源只提供标题）'}</p>`
    : sub.manual
      ? `<p class="card-sum none">手动登记：去微信里搜「${esc(sub.name)}」。以后拿到 RSS 地址可在编辑里补上。</p>`
      : `<p class="card-sum none">${esc(problem ? `抓取失败：${problem.reason}（点刷新重试）` : '还没有抓到内容')}</p>`;

  const dotClass = sub.manual && !latest ? 'manual' : level;
  const plat = sub.url
    ? `<a class="card-plat" href="${esc(sub.url)}" target="_blank" rel="noopener noreferrer" title="去主页">${esc(sub.platformLabel || sub.platform)}</a>`
    : `<span class="card-plat">${esc(sub.platformLabel || sub.platform)}</span>`;

  li.innerHTML = `
    ${latest && !readSet.has(latest.id) ? '<span class="badge" title="没点过"></span>' : ''}
    <div class="card-top">
      <span class="dot ${dotClass}" title="${dotClass === 'manual' ? '手动登记，不抓取' : level === 'fresh' ? '48 小时内有更新' : level === 'recent' ? '两周内有更新' : level === 'stale' ? '超过两周没更新' : '抓不到'}"></span>
      <a class="card-src" href="#/author/${esc(sub.id)}" title="看这个作者的全部内容">${esc(sub.name)}</a>
      ${plat}
      <span class="spacer"></span>
      ${when}
    </div>
    ${body}
    <div class="card-foot">
      <span class="card-tags">${chips}${latest ? `<button class="chip chip-add" type="button" data-tagitem="${esc(latest.id)}" title="给这篇打 tag">+</button>` : ''}</span>
      <span class="spacer"></span>
      ${!single && items.length > 1 ? `<span class="card-more" title="该博主在此筛选下还有 ${items.length - 1} 条">+${items.length - 1}</span>` : ''}
    </div>
  `;

  for (const chip of $$('.chip:not(.chip-add)', li)) {
    chip.onclick = (e) => {
      e.preventDefault();
      state.activeTag = chip.dataset.tag;
      render();
    };
  }
  const link = $('.card-title[data-item]', li);
  if (link) {
    const markRead = () => {
      readSet.add(link.dataset.item);
      saveRead();
      li.querySelector('.badge')?.remove();
    };
    link.addEventListener('click', markRead);
    // Clicking anywhere on the card body behaves like clicking the title.
    li.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      markRead();
      window.open(link.href, '_blank', 'noopener,noreferrer');
    });
  }
  const addTagBtn = $('.chip-add', li);
  if (addTagBtn) {
    addTagBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const item = state.data.items.find((i) => i.id === addTagBtn.dataset.tagitem);
      if (item) openTagEditor(item);
    };
  }
  return li;
}

function authorCards(sub) {
  return itemsOf(sub)
    .map((it) => ({ sub, items: [it], latest: it, single: true }))
    .sort(compareCards);
}

// 博主页：每个博主一张卡。tag 筛选同时认作者级 tag 与其文章带的 tag。
function sourceCards() {
  const q = state.query.trim().toLowerCase();
  const want = state.activeTag ? String(state.activeTag).toLowerCase() : null;
  return state.data.subscriptions
    .filter((s) => {
      if (want) {
        const byAuthor = (s.tags || []).some((t) => String(t).toLowerCase() === want);
        const byArticle = itemsOf(s).some((it) => matchesTag(it, state.activeTag));
        if (!byAuthor && !byArticle) return false;
      }
      if (q && !s.name.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => (itemsOf(b)[0]?.published || 0) - (itemsOf(a)[0]?.published || 0) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

function sourceNode(sub) {
  const items = itemsOf(sub);
  const latest = items[0] || null;
  const li = document.createElement('li');
  li.className = `card source-card${sub.disabled ? ' off' : ''}`;
  const host = sub.url ? String(sub.url).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
  const tags = (sub.tags || [])
    .map((t) => `<button class="chip" type="button" data-tag="${esc(t)}">${esc(t)}</button>`)
    .join('');
  const when = latest
    ? `<span class="card-when" title="${esc(absTime(latest.published))}">${esc(relTime(latest.published))}</span>`
    : sub.manual
      ? '<span class="card-when">手动登记</span>'
      : '<span class="card-when dead">无更新</span>';
  const where = `${esc(sub.platformLabel || sub.platform)}${host ? ` · ${esc(host)}` : ''}`;
  li.innerHTML = `
    <div class="card-top">
      <span class="dot ${sub.manual && !latest ? 'manual' : freshness(latest?.published)}"></span>
      <a class="card-title" href="#/author/${esc(sub.id)}">${esc(sub.name)}</a>
      <span class="spacer"></span>
      ${when}
    </div>
    <p class="card-sum none">${where} · ${sub.disabled ? '已关闭，文章不展示' : `${items.length} 条`}</p>
    <div class="card-foot">
      <span class="card-tags">${tags}</span>
      <button class="toggle" type="button" aria-pressed="${String(!sub.disabled)}">${sub.disabled ? '已关闭' : '展示中'}</button>
    </div>
  `;
  for (const chip of $$('.chip', li)) {
    chip.onclick = (e) => {
      e.preventDefault();
      state.activeTag = chip.dataset.tag;
      render();
    };
  }
  $('.toggle', li).onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleSub(sub.id);
  };
  return li;
}

function renderCards() {
  const list = $('#river');
  const empty = $('#empty');
  const viewSub = currentViewSub();
  list.innerHTML = '';

  if (state.viewSources && !viewSub) {
    const subs = sourceCards();
    if (!subs.length) {
      empty.hidden = false;
      empty.textContent = state.activeTag ? `没有打「${state.activeTag}」tag 的博主。` : '还没有博主，点右上角添加。';
      return;
    }
    empty.hidden = true;
    for (const s of subs) list.appendChild(sourceNode(s));
    return;
  }

  const cards = viewSub ? authorCards(viewSub) : articleCards();
  if (!cards.length) {
    empty.hidden = false;
    if (viewSub && !queryActive()) {
      if (viewSub.disabled) {
        empty.textContent = `「${viewSub.name}」已关闭展示，文章不进河。点上面的「开启展示」就恢复。`;
      } else if (viewSub.manual) {
        empty.textContent = `「${viewSub.name}」是手动登记的公众号，quiet-river 不抓微信。去微信里搜这个名字；以后拿到 RSS 地址可在编辑里补上。`;
      } else {
        empty.textContent = `「${viewSub.name}」还没有抓到内容。`;
      }
    } else if (queryActive()) {
      empty.textContent = `没有匹配「${state.query.trim()}」的文章。搜的是题目和作者名。`;
    } else if (!state.data.subscriptions.length) {
      empty.innerHTML = '清单是空的。点右上角 <b>添加博主</b>，贴一个主页链接进来。';
    } else {
      empty.textContent = '还没有抓到内容。点刷新，或去添加页加源。';
    }
    return;
  }
  empty.hidden = true;
  for (const card of cards) list.appendChild(cardNode(card));
}

function renderProblems() {
  const problems = state.data.problems || [];
  const box = $('#problems');
  box.hidden = problems.length === 0;
  if (!problems.length) return;
  const empty = problems.filter((p) => !p.kept).length;
  const kept = problems.length - empty;
  const parts = [];
  if (empty) parts.push(`${empty} 个博主抓不到`);
  if (kept) parts.push(`${kept} 个没刷上（上次内容还在）`);
  $('#problems-summary').textContent = parts.join('，');
  $('#problems-list').innerHTML = problems
    .map((p) => {
      const tail = p.kept ? `<span class="kept">上次的 ${p.kept} 条还在河里</span>` : '';
      return `<li><span class="who">${esc(p.name)}</span><span class="why">${esc(p.reason)}</span>${tail}</li>`;
    })
    .join('');
}

function renderFooter() {
  const at = state.data.lastRefresh;
  $('#last-refresh').textContent = at ? `上次抓取 ${absTime(at)}` : '还没抓取过';
  const gh = $('#foot-github');
  const url = state.data.settings?.githubUrl || '';
  if (url) {
    gh.hidden = false;
    gh.href = url;
    gh.textContent = `GitHub · ${url.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  } else {
    gh.hidden = true;
  }
}

function syncThemeSegs() {
  const cur = document.documentElement.dataset.theme;
  for (const btn of $$('[data-theme-set]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeSet === cur));
  }
}

function render() {
  for (const btn of $$('.viewnav .seg')) {
    btn.setAttribute('aria-pressed', String((btn.dataset.view === 'sources') === state.viewSources));
  }
  for (const btn of $$('.seg[data-sort]')) btn.setAttribute('aria-pressed', String(btn.dataset.sort === state.sortMode));
  syncThemeSegs();
  const addPage = $('#addpage');
  if (state.viewAdd) {
    addPage.hidden = false;
    $('.tagbar').hidden = true;
    $('main').hidden = true;
    $('.problems').hidden = true;
    $('#counts').textContent = '添加博主';
    renderAddPage();
    renderFooter();
    return;
  }
  addPage.hidden = true;
  $('.tagbar').hidden = false;
  $('main').hidden = false;
  $('.problems').hidden = false;
  const viewSub = currentViewSub();
  const head = $('#authorhead');
  if (viewSub) {
    head.hidden = false;
    head.classList.toggle('off', Boolean(viewSub.disabled));
    $('#author-name').textContent = viewSub.name;
    $('#author-meta').textContent = viewSub.disabled
      ? `${viewSub.platformLabel || viewSub.platform} · 已关闭展示 · ${String(viewSub.url).replace(/^https?:\/\//, '')}`
      : `${viewSub.platformLabel || viewSub.platform} · ${itemsOf(viewSub).length} 条 · ${String(viewSub.url).replace(/^https?:\/\//, '')}`;
    const toggle = $('#btn-toggle-author');
    toggle.textContent = viewSub.disabled ? '开启展示' : '关闭展示';
    toggle.setAttribute('aria-pressed', String(!viewSub.disabled));
  } else {
    head.hidden = true;
  }
  renderCounts();
  renderTagbar();
  renderCards();
  renderProblems();
  renderFooter();
}

/* ---------- manual per-article tags ---------- */

let tagEdit = null;

function knownTags() {
  const set = new Set();
  for (const s of state.data.subscriptions) for (const t of s.tags || []) set.add(String(t));
  for (const it of state.data.items) for (const t of itemTags(it)) set.add(String(t));
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function openTagEditor(item) {
  tagEdit = { id: item.id, selected: new Set(item.manualTags || []) };
  $('#tag-target').textContent = item.title;
  $('#tag-new').value = '';
  renderTagPick();
  openModal('modal-tag');
  setTimeout(() => $('#tag-new').focus(), 30);
}

function renderTagPick() {
  const box = $('#tag-pick');
  box.innerHTML = '';
  const all = uniq([...knownTags(), ...tagEdit.selected]).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  if (!all.length) {
    box.innerHTML = '<span class="tagbar-empty">还没有任何 tag，先在下面新建一个</span>';
    return;
  }
  for (const t of all) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip pick${tagEdit.selected.has(t) ? ' on' : ''}`;
    b.textContent = t;
    b.onclick = () => {
      if (tagEdit.selected.has(t)) tagEdit.selected.delete(t);
      else tagEdit.selected.add(t);
      renderTagPick();
    };
    box.appendChild(b);
  }
}

function addNewTag() {
  const input = $('#tag-new');
  const value = input.value.trim().replace(/^#/, '');
  if (!value || !tagEdit) return;
  tagEdit.selected.add(value);
  input.value = '';
  renderTagPick();
  input.focus();
}

async function saveTagEdit() {
  if (!tagEdit) return;
  const tags = [...tagEdit.selected];
  try {
    await api(`/api/items/${tagEdit.id}/tags`, { method: 'PATCH', body: { tags } });
    closeModal('modal-tag');
    await loadState();
    toast(tags.length ? `已打 tag：${tags.join('、')}` : '已清除这篇的人工 tag');
  } catch (err) {
    toast(err.message, 5000);
  }
}

/* ---------- toast ---------- */

let toastTimer = null;
function toast(message, ms = 3200) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ---------- modals ---------- */

function openModal(id) {
  $(`#${id}`).hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeModal(id) {
  $(`#${id}`).hidden = true;
  document.body.style.overflow = '';
}
function closeAllModals() {
  for (const m of $$('.modal')) m.hidden = true;
  document.body.style.overflow = '';
}

/* ---------- add page ---------- */

// Every source gets the import shape that actually fits it. `build` returns
// {url} for resolver-driven sources, {feeds} when the feed address is already
// known, or {block} when the platform needs credentials we do not have.
const need = (v, key, label) => {
  const s = String(v[key] || '').trim();
  return s || { block: `请填写${label}` };
};

const PLATFORM_FORMS = [
  { group: '免凭证直接抓', key: 'auto', label: '自动识别', note: '不确定来源时用它：贴链接，服务端逐个通道试。', fields: [{ id: 'url', label: '主页或 feed 链接', placeholder: 'https://…' }], build: (v) => { const url = need(v, 'url', '链接'); return url.block ? url : { url }; } },
  { group: '免凭证直接抓', key: 'blog', label: '独立博客 / RSS', note: 'WordPress / Ghost / Hugo / Jekyll 等，主页或 feed 地址都行。', fields: [{ id: 'url', label: '主页或 feed 地址', placeholder: 'https://blog.example.com 或 …/feed' }], build: (v) => { const url = need(v, 'url', '地址'); return url.block ? url : { url }; } },
  { group: '免凭证直接抓', key: 'github', label: 'GitHub', note: '用户动态，或仓库的 release。仓库没有 release 就不订——commit 流是开发记录不是文章；真要跟提交，把 …/commits.atom 整条地址贴进来。', fields: [{ id: 'who', label: '用户名或仓库', placeholder: 'torvalds 或 torvalds/linux' }], build: (v) => { const who = need(v, 'who', '用户名或仓库'); return who.block ? who : { url: `https://github.com/${who.replace(/^\/+|\/+$/g, '')}` }; } },
  { group: '免凭证直接抓', key: 'substack', label: 'Substack', note: '给子域名或完整链接都行。', fields: [{ id: 'who', label: '子域名或链接', placeholder: 'pragmaticengineer 或 pragmaticengineer.substack.com' }], build: (v) => { const who = need(v, 'who', '子域名'); return who.block ? who : { url: `https://${who.replace(/^https?:\/\//, '').replace(/\.substack\.com.*$/, '').replace(/\/+$/, '')}.substack.com` }; } },
  { group: '免凭证直接抓', key: 'youtube', label: 'YouTube', note: '频道链接或 @handle；handle 会解析成 channel_id 后缓存。', fields: [{ id: 'who', label: '频道链接或 @handle', placeholder: '@acmrecsys 或 https://www.youtube.com/@acmrecsys' }], build: (v) => { const who = need(v, 'who', '频道'); return who.block ? who : { url: /^https?:\/\//.test(who) ? who : `https://www.youtube.com/${who.startsWith('@') ? who : `@${who}`}` }; } },
  { group: '免凭证直接抓', key: 'csdn', label: 'CSDN', note: '原生 RSS，给博客用户名即可。', fields: [{ id: 'who', label: '博客用户名', placeholder: 'blog.csdn.net/ 后面那段' }], build: (v) => { const who = need(v, 'who', '用户名'); return who.block ? who : { url: `https://blog.csdn.net/${who.replace(/^\/+|\/+$/g, '')}` }; } },
  { group: '免凭证直接抓', key: 'juejin', label: '掘金', note: '匿名接口实测可用。', fields: [{ id: 'url', label: '主页链接', placeholder: 'https://juejin.cn/user/…' }], build: (v) => { const url = need(v, 'url', '主页链接'); return url.block ? url : { url }; } },
  { group: '免凭证直接抓', key: 'sspai', label: '少数派', note: '作者数字 ID 或 /u/ 链接都行。', fields: [{ id: 'who', label: '作者 ID 或链接', placeholder: '796518 或 https://sspai.com/u/796518' }], build: (v) => { const who = need(v, 'who', '作者 ID'); return who.block ? who : { url: /^\d+$/.test(who) ? `https://sspai.com/u/${who}` : who }; } },
  { group: '免凭证直接抓', key: 'jike', label: '即刻', note: '主页链接里的 UUID 就是 ID。', fields: [{ id: 'url', label: '主页链接', placeholder: 'https://web.okjike.com/u/…' }], build: (v) => { const url = need(v, 'url', '主页链接'); return url.block ? url : { url }; } },
  { group: '免凭证直接抓', key: 'hn', label: 'Hacker News', note: '走 Algolia 接口，按作者名抓发帖与评论。', fields: [{ id: 'who', label: 'HN 用户名', placeholder: 'pg' }], build: (v) => { const who = need(v, 'who', '用户名'); return who.block ? who : { url: `https://news.ycombinator.com/user?id=${encodeURIComponent(who)}` }; } },
  { group: '免凭证直接抓', key: 's2', label: 'Semantic Scholar', note: '作者页链接；按作者追论文，带学科分类。', fields: [{ id: 'url', label: '作者页链接', placeholder: 'https://www.semanticscholar.org/author/…/…' }], build: (v) => { const url = need(v, 'url', '作者页链接'); return url.block ? url : { url }; } },
  { group: '免凭证直接抓', key: 'arxiv', label: 'arXiv 分类', note: '按分类抓每日新论文，每篇带 cs.* 领域 tag。', fields: [{ id: 'cat', label: '分类代码', placeholder: 'cs.IR / cs.LG / stat.ML' }], build: (v) => { const cat = need(v, 'cat', '分类代码'); return cat.block ? cat : { url: `https://arxiv.org/list/${cat.replace(/\/+$/g, '')}/recent` }; } },
  { group: '免凭证直接抓', key: 'reddit', label: 'Reddit', note: '版块或用户都行；2026-06 起全局限流每分钟 1 次。', fields: [{ id: 'who', label: 'r/版块 或 用户名', placeholder: 'r/recommendersystems 或 spez' }], build: (v) => { const who = need(v, 'who', '版块或用户名'); return who.block ? who : { url: who.startsWith('r/') ? `https://www.reddit.com/${who}/` : `https://www.reddit.com/user/${who}/` }; } },
  { group: '免凭证直接抓', key: 'mastodon', label: 'Mastodon', note: '联邦制，实例域名和用户名两段都要。', fields: [{ id: 'instance', label: '实例域名', placeholder: 'mastodon.social' }, { id: 'user', label: '用户名（不带 @）', placeholder: 'Gargron' }], build: (v) => { const i = need(v, 'instance', '实例域名'); if (i.block) return i; const u = need(v, 'user', '用户名'); return u.block ? u : { url: `https://${i.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/@${u.replace(/^@/, '')}` }; } },
  { group: '免凭证直接抓', key: 'bsky', label: 'Bluesky', note: '官方 RSS，给 handle 即可。', fields: [{ id: 'handle', label: 'handle', placeholder: 'name.bsky.social' }], build: (v) => { const h = need(v, 'handle', 'handle'); return h.block ? h : { url: `https://bsky.app/profile/${h.replace(/^@/, '')}` }; } },
  { group: '免凭证直接抓', key: 'podcast', label: '播客', note: 'Apple Podcasts 链接会自动反查 feed；直接给 feed 地址也行。', fields: [{ id: 'url', label: 'Apple Podcasts 链接或 feed 地址', placeholder: 'https://podcasts.apple.com/…/id… 或 https://…/feed.xml' }], build: (v) => { const url = need(v, 'url', '链接'); return url.block ? url : { url }; } },
  {
    group: '需要额外条件', key: 'bilibili', label: 'B站', note: '专栏匿名可抓但没有发布时间；视频与动态要自托管 RSSHub。',
    fields: [{ id: 'uid', label: '数字 UID', placeholder: 'space.bilibili.com/ 后面那段' }, { id: 'kind', label: '内容类型', options: ['视频', '动态', '专栏'] }],
    build: (v, settings) => {
      const uid = need(v, 'uid', 'UID');
      if (uid.block) return uid;
      const base = (settings.rsshubBase || '').replace(/\/+$/, '');
      if (!base) return { block: 'B站视频与动态需要自托管 RSSHub：先在「设置」里填 rsshubBase，再回来添加。' };
      const route = { 视频: 'video', 动态: 'dynamic', 专栏: 'article' }[v.kind] || 'video';
      return { feeds: [`${base}/bilibili/user/${route}/${uid}`] };
    },
  },
  {
    group: '需要额外条件', key: 'zhihu', label: '知乎',
    // 只有本机装了登录态适配器（lib/adapters.private.js，不随开源版发布）才显示这张卡。
    requires: 'zhihu',
    // 具体凭证文件名由你自己的适配器决定；它缺凭证时会自己抛出可读提示。
    note: '走本地登录态适配器：凭证放 secrets/ 或环境变量（约定见 secrets/README.md），不要写进代码。',
    fields: [{ id: 'who', label: '主页链接或 url_token', placeholder: 'https://www.zhihu.com/people/… 或 people/ 后面那段' }],
    build: (v) => {
      const who = need(v, 'who', '主页链接');
      if (who.block) return who;
      const s = who.replace(/^\/+|\/+$/g, '');
      if (/zhihu\.com\//.test(s)) return { url: /^https?:\/\//.test(s) ? s : `https://${s}` };
      return { url: `https://www.zhihu.com/people/${s}` };
    },
  },
  {
    group: '需要额外条件', key: 'xiaohongshu', label: '小红书',
    requires: 'xiaohongshu',
    note: '走本地登录态适配器：登录态怎么维持由你自己的适配器决定。通道只给标题/封面/赞数，不返回昵称，所以上面要自己填博主名字。',
    fields: [{ id: 'who', label: '主页链接或 24 位用户 ID', placeholder: 'https://www.xiaohongshu.com/user/profile/… 或 5f…（24 位 hex）' }],
    build: (v) => {
      const who = need(v, 'who', '用户 ID');
      if (who.block) return who;
      const s = who.replace(/^\/+|\/+$/g, '');
      if (/^[0-9a-f]{24}$/i.test(s)) return { url: `https://www.xiaohongshu.com/user/profile/${s}` };
      if (/xiaohongshu\.com\//.test(s)) return { url: /^https?:\/\//.test(s) ? s : `https://${s}` };
      return { block: '小红书用户 ID 是 24 位十六进制串：从主页链接 /user/profile/ 后面那段复制。' };
    },
  },
  { group: '需要额外条件', key: 'wechat', label: '微信公众号（手动登记）', note: '不抓微信。登记名字后有自己的专属页，内容暂时为空；去微信里搜这个名字读。以后拿到 RSS（如 wewe-rss 输出）可在编辑里补。', fields: [{ id: 'rss', label: 'RSS 地址（可留空，以后拿到再补）', placeholder: 'https://…/feed.xml' }], build: (v) => ({ manual: true, url: v.rss || undefined }) },
];

let addFormKey = null;

function renderAddPage() {
  const grid = $('#platform-grid');
  grid.innerHTML = '';
  let lastGroup = null;
  const available = state.data?.capabilities?.adapterPlatforms || [];
  for (const f of PLATFORM_FORMS) {
    // 声明了 requires 的来源卡，只有对应适配器真的存在时才出现。
    if (f.requires && !available.includes(f.requires)) continue;
    if (f.group !== lastGroup) {
      lastGroup = f.group;
      const h = document.createElement('h3');
      h.className = 'addgroup';
      h.textContent = f.group;
      grid.appendChild(h);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `platcard${addFormKey === f.key ? ' on' : ''}`;
    b.innerHTML = `<span class="platcard-name">${esc(f.label)}</span><span class="platcard-note">${esc(f.note)}</span>`;
    b.onclick = () => { addFormKey = f.key; renderAddPage(); };
    grid.appendChild(b);
  }

  const form = PLATFORM_FORMS.find((f) => f.key === addFormKey);
  const box = $('#platform-form');
  $('#add-msg').textContent = '';
  $('#add-msg').className = 'addmsg';
  if (!form) {
    box.innerHTML = '<p class="addhint">先在上面选一个来源。</p>';
    $('#btn-add-submit').disabled = true;
    return;
  }
  $('#btn-add-submit').disabled = false;
  const nameLabel = document.querySelector('label[for="add-name"]');
  const requiredName = { wechat: '公众号名字（必填）', xiaohongshu: '博主名字（必填，小红书通道不返回昵称）' };
  if (nameLabel) nameLabel.textContent = requiredName[form.key] || '显示名（可留空，自动取）';
  box.innerHTML = form.fields.length
    ? form.fields.map((f) => `
        <div class="field">
          <label for="addf-${f.id}">${esc(f.label)}</label>
          ${f.options
            ? `<select id="addf-${f.id}" data-field="${f.id}">${f.options.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`
            : `<input id="addf-${f.id}" data-field="${f.id}" type="text" placeholder="${esc(f.placeholder || '')}" autocomplete="off" spellcheck="false">`}
        </div>`).join('')
    : '<p class="addhint">这个来源当前没有可填的通道。</p>';
}

async function submitAdd() {
  const form = PLATFORM_FORMS.find((f) => f.key === addFormKey);
  if (!form) return;
  const values = {};
  for (const el of $$('#platform-form [data-field]')) values[el.dataset.field] = el.value.trim();
  const built = form.build(values, state.data.settings || {});
  const msg = $('#add-msg');
  if (built.block) {
    msg.className = 'addmsg bad';
    msg.textContent = built.block;
    return;
  }
  const btn = $('#btn-add-submit');
  btn.disabled = true;
  btn.textContent = '验证并添加…';
  msg.className = 'addmsg busy';
  msg.textContent = '正在验证这个来源能不能抓到…';
  try {
    const created = await api('/api/subscriptions', {
      method: 'POST',
      body: {
        name: $('#add-name').value.trim(),
        tags: $('#add-tags').value,
        ...(built.manual ? { manual: true } : {}),
        ...(built.url ? { url: built.url } : {}),
        ...(built.feeds ? { feeds: built.feeds } : {}),
      },
    });
    for (const it of state.data.items) if (it.subId === created.subscription.id) readSet.add(it.id);
    location.hash = '#/';
    await loadState();
    const sample = (created.fetched || [])
      .flatMap((f) => f.sample || [])
      .slice(0, 2)
      .map((t) => (String(t).length > 34 ? `${String(t).slice(0, 34)}…` : String(t)));
    toast(created.warning || `已添加「${created.subscription.name}」${sample.length ? ` · 最新：${sample.join(' / ')}` : ''}`, 6000);
  } catch (err) {
    msg.className = 'addmsg bad';
    msg.textContent = err.payload?.error || err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '验证并添加';
  }
}

/* ---------- edit ---------- */

function openEdit(subId) {
  const sub = state.data.subscriptions.find((s) => s.id === subId);
  if (!sub) return;
  state.editingId = subId;
  state.editFeedOriginal = (sub.feeds || [])[0] || '';
  $('#edit-title').textContent = `编辑 · ${sub.name}`;
  $('#edit-name').value = sub.name;
  $('#edit-tags').value = (sub.tags || []).join(', ');
  $('#edit-feed').value = state.editFeedOriginal;
  const feedLines = sub.adapter
    ? `<li>适配器：${esc(sub.adapter.platform)} / ${esc(sub.adapter.id)}</li>`
    : (sub.feeds || []).map((f) => `<li>${esc(f)}</li>`).join('') || '<li>无（手动登记或还没配 feed）</li>';
  $('#edit-feeds').innerHTML = feedLines;
  openModal('modal-edit');
}

async function saveEdit() {
  if (!state.editingId) return;
  const feedInput = $('#edit-feed').value.trim();
  const body = { name: $('#edit-name').value.trim(), tags: $('#edit-tags').value };
  if (feedInput !== state.editFeedOriginal) body.feedUrl = feedInput;
  try {
    await api(`/api/subscriptions/${state.editingId}`, {
      method: 'PATCH',
      body,
    });
    closeModal('modal-edit');
    await loadState();
    toast('已保存');
  } catch (err) {
    toast(err.message);
  }
}

async function deleteSub() {
  if (!state.editingId) return;
  const sub = state.data.subscriptions.find((s) => s.id === state.editingId);
  if (!confirm(`删除「${sub?.name}」？只删这个订阅，不影响别的。`)) return;
  try {
    await api(`/api/subscriptions/${state.editingId}`, { method: 'DELETE' });
    closeModal('modal-edit');
    await loadState();
    toast('已删除');
  } catch (err) {
    toast(err.message);
  }
}

// 关闭的博主整体不抓，所以重新开启时单独补抓一次，否则看到的是关闭前的旧内容。
async function toggleSub(subId) {
  const sub = state.data.subscriptions.find((s) => s.id === subId);
  if (!sub) return;
  const enable = Boolean(sub.disabled);
  try {
    await api(`/api/subscriptions/${subId}`, { method: 'PATCH', body: { disabled: !enable } });
    await loadState();
    if (enable && (sub.adapter || (sub.feeds || []).length)) {
      await api(`/api/subscriptions/${subId}`, { method: 'POST' });
      await loadState();
    }
    toast(enable ? `已开启「${sub.name}」` : `已关闭「${sub.name}」，文章不再展示`);
  } catch (err) {
    toast(err.message);
  }
}

/* ---------- refresh ---------- */

async function refresh(silent = false, force = false) {
  const btn = $('#btn-refresh');
  btn.disabled = true;
  btn.textContent = '抓取中…';
  try {
    const r = await api('/api/refresh', { method: 'POST', body: force ? { force: true } : {} });
    await loadState();
    if (!silent) {
      const skipped = r.skipped ? `，跳过连续失败的 ${r.skipped} 个` : '';
      toast(`抓完 ${r.total} 个 feed，成功 ${r.ok} 个${skipped}`);
    }
  } catch (err) {
    toast(`刷新失败：${err.message}`, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = '刷新';
  }
}

function scheduleAuto() {
  clearInterval(state.autoTimer);
  const minutes = Number(state.data?.settings?.refreshMinutes || 0);
  if (!minutes || minutes < 1) return;
  state.autoTimer = setInterval(() => refresh(true), minutes * 60000);
}

// Entering the page should surface new content, but rendering must not wait
// for the network: paint from cache first, refresh behind it. The gap guard
// keeps repeated reloads from hammering rate-limited sources (Reddit is
// ~1 request/min per IP since 2026-06).
const AUTO_REFRESH_MIN_GAP_MS = 120000;

function maybeAutoRefresh() {
  const at = state.data?.lastRefresh || 0;
  if (Date.now() - at < AUTO_REFRESH_MIN_GAP_MS) return;
  refresh(true);
}

/* ---------- settings ---------- */

function openSettings() {
  $('#set-rsshub').value = state.data.settings?.rsshubBase || '';
  $('#set-interval').value = state.data.settings?.refreshMinutes ?? 60;
  $('#set-github').value = state.data.settings?.githubUrl || '';
  openModal('modal-settings');
}

async function saveSettings() {
  try {
    await api('/api/settings', {
      method: 'PATCH',
      body: {
        rsshubBase: $('#set-rsshub').value.trim(),
        refreshMinutes: Number($('#set-interval').value || 0),
        githubUrl: $('#set-github').value.trim(),
      },
    });
    closeModal('modal-settings');
    await loadState();
    scheduleAuto();
    toast('已保存。改了 RSSHub 地址后，之前被挡住的平台要重新添加一次。');
  } catch (err) {
    toast(err.message);
  }
}

/* ---------- boot ---------- */

function bind() {
  // 视图切换用事件委托：不依赖逐按钮绑定时机，节点重建也不丢。
  document.addEventListener('click', (e) => {
    const v = e.target.closest('[data-view]');
    if (!v) return;
    e.preventDefault();
    location.hash = v.dataset.view === 'sources' ? '#/sources' : '#/';
    applyHash();
    render();
  });

  $('#btn-add').onclick = () => { location.hash = '#/add'; };
  $('#btn-add-submit').onclick = submitAdd;

  $('#btn-refresh').onclick = () => refresh(false, true);
  $('#btn-settings').onclick = openSettings;
  $('#btn-save-settings').onclick = saveSettings;
  $('#btn-save-edit').onclick = saveEdit;
  $('#btn-delete-sub').onclick = deleteSub;

  $('#search').addEventListener('input', (e) => { state.query = e.target.value; renderCounts(); renderCards(); });

  for (const btn of $$('.seg')) {
    btn.onclick = () => {
      state.sortMode = btn.dataset.sort;
      localStorage.setItem(SORT_KEY, state.sortMode);
      render();
    };
  }

  $('#btn-edit-author').onclick = () => { if (state.viewSubId) openEdit(state.viewSubId); };
  $('#btn-toggle-author').onclick = () => { if (state.viewSubId) toggleSub(state.viewSubId); };
  window.addEventListener('hashchange', () => { applyHash(); render(); });

  $('#btn-tag-save').onclick = saveTagEdit;
  $('#btn-tag-add').onclick = addNewTag;
  $('#tag-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addNewTag(); } });

  for (const btn of $$('[data-theme-set]')) {
    btn.onclick = () => {
      const mode = btn.dataset.themeSet;
      document.documentElement.dataset.theme = mode;
      localStorage.setItem(THEME_KEY, mode);
      syncThemeSegs();
    };
  }

  $('#problems-toggle').onclick = () => {
    const list = $('#problems-list');
    const open = list.hidden;
    list.hidden = !open;
    $('#problems-toggle').setAttribute('aria-expanded', String(open));
  };

  for (const btn of $$('[data-close]')) btn.onclick = () => closeModal(btn.dataset.close);
  for (const modal of $$('.modal')) {
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(modal.id); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllModals();
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); $('#search').focus(); }
  });
}

(async function boot() {
  bind();
  applyHash();
  try {
    await loadState();
    scheduleAuto();
    if (!state.data.subscriptions.length) {
      location.hash = '#/add';
    } else if (!new URLSearchParams(location.search).has('noauto')) {
      maybeAutoRefresh();
    }
  } catch (err) {
    $('#counts').textContent = '连不上后端';
    toast(`加载失败：${err.message}`, 6000);
  }
})();
