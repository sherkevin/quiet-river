'use strict';

/**
 * 摘要数学分段器：把一段纯文本摘要切成互不重叠的数学段。
 *
 * 为什么单独一个文件：app.js 尾部有自启动 IIFE，Node 里 require 它会炸；分段判据
 * 又是这次修复里最容易错的部分（真实摘要有三种数学形态），必须能被 node:test
 * 直接单测。浏览器里它是普通 <script>（先于 app.js 加载），Node 里走末尾的
 * module 守卫导出。
 *
 * 三种形态（2026-09-15 全库 7084 条摘要实测）：
 *   1. 带分隔符：$...$ 与 $$...$$，60 条；
 *   2. 裸命令段：知乎与科学空间把公式剥成了没有 $ 的源文，如
 *      「从 \int_{-\pi}^{\pi}[...]dx 到一族恒等式」，236 条——只认分隔符会一条都漏；
 *   3. 整篇 LaTeX 文档 preamble（\documentclass + \usepackage）：没有可渲染边界，放弃。
 *
 * 裸命令段的边界判据：连续的 \cmd 之间若只隔着 ASCII（括号、上下标、变量名、
 * 空格）就算同一段；一旦隔出中文或句读（。，；！？、换行）就切断。所以
 * 「(\cot x)^i 不是普通实幂」这种纯中文句子不会被误抓——它里面没有反斜杠命令；
 * 而 z^w:=e^{w\operatorname{Log} z} 里有 \operatorname，就能被抓住。
 *
 * 保守边界：
 * - `$100`、美元价格这类不配对的 $ 不渲染；只有成对的 $...$（行内不跨行）才算。
 * - 分隔符内部必须含 LaTeX 命令（反斜杠）或上下标（^ _）才认是公式。
 */

const MATH_DOLLAR_RE = /\$\$([\s\S]+?)\$\$|\$([^\n$]+?)\$/g;
const MATH_ENV_RE = /\\begin\{([a-zA-Z*]+)\}[\s\S]*?\\end\{\1\}/g;
const MATH_CMD_RE = /\\[A-Za-z]+/g;
// 数学段的停止符：中文、句读与省略号一到，公式就结束。省略号必须停：摘要被
// clamp 截断时截点常落在命令中间，留下「-\…」这种残尾，把 … 拖进公式会让
// KaTeX 解析失败、整段退回源文。
const MATH_GAP_OK_RE = /^[^。！？；，、…\n一-鿿]{0,40}$/;
const MATH_TRAIL_RE = /[^。！？；，、…\n一-鿿]*/y;
const MATH_PREAMBLE_RE = /\\documentclass|\\usepackage/;

/**
 * 把一段纯文本摘要切成数学段。
 * 返回 [{ start, end, tex, display }]，按 start 升序、互不重叠。
 * 纯函数，不碰 DOM。
 */
function mathSegments(text) {
  if (!text) return [];
  const spans = [];
  const inside = (start, end) => spans.some((s) => start < s.end && s.start < end);
  let m;

  MATH_DOLLAR_RE.lastIndex = 0;
  while ((m = MATH_DOLLAR_RE.exec(text))) {
    const tex = (m[1] ?? m[2]).trim();
    // 只把「像公式」的段落交给 KaTeX：必须含命令（\frac）或上下标（x_i^2）。
    if (!/\\[A-Za-z]|[\^_]/.test(tex)) continue;
    spans.push({ start: m.index, end: m.index + m[0].length, tex, display: m[1] !== undefined });
  }

  // 整篇是 LaTeX 文档 preamble 的摘要没有可渲染边界，环境块与裸命令段都放弃。
  if (!MATH_PREAMBLE_RE.test(text)) {
    MATH_ENV_RE.lastIndex = 0;
    while ((m = MATH_ENV_RE.exec(text))) {
      if (inside(m.index, m.index + m[0].length)) continue;
      spans.push({ start: m.index, end: m.index + m[0].length, tex: m[0], display: true });
    }

    MATH_CMD_RE.lastIndex = 0;
    let runStart = -1;
    let runEnd = -1;
    // 段入栈前做两端延伸。中途被切断的段与最后一段走同一条路——之前延伸逻辑
    // 只挂在循环外，中途 flush 的段（被中文切断的那些，恰恰是多数）拿不到延伸，
    // \pi(a|s) 会被截成 \pi。
    const pushRun = (rs, re, clampEnd) => {
      // 段尾延伸到中文或句读为止：\cot 后面的「 x)^i]dx」属于公式，「到一族」不属于。
      MATH_TRAIL_RE.lastIndex = re;
      let end = re + MATH_TRAIL_RE.exec(text)[0].length;
      // 两个夹：不能越过已认定段的起点（否则与 $...$ 段重叠，DOM 切片错乱）；
      // 中途段还不能越过切断它的那个 token（间隔是超长 ASCII 时，尾延伸会吞正文）。
      if (end > clampEnd) end = clampEnd;
      const nextStart = spans.reduce((acc, s) => (s.start >= re ? Math.min(acc, s.start) : acc), Infinity);
      if (end > nextStart) end = nextStart;
      // 截断残尾：clamp 把摘要截在命令中间时会留下孤立反斜杠（「-\…」的 \），
      // KaTeX 解析不了，切掉它让前面的完整部分照常渲染。
      if (end > rs && text[end - 1] === '\\') end -= 1;
      while (end > rs && /\s/.test(text[end - 1])) end -= 1;
      // 段头回扩：先吃连续左括号（「(\cot x)^i」的 ( 是公式的一部分），再吃带数学
      // 算符的前缀 ASCII 块（z^w:=e^{w\operatorname{Log} z} 里的 z^w:=e^{w）。
      // 前缀必须含 = ^ _ { } ( ) : 这类算符才吃——纯英文单词挨着命令（word\alpha）
      // 不吃，否则会把正文单词拖进公式。回扩同样不能越过前面已认定段的结尾。
      const prevEnd = spans.reduce((acc, s) => (s.end <= rs ? Math.max(acc, s.end) : acc), 0);
      while (rs > prevEnd && '([{'.includes(text[rs - 1])) rs -= 1;
      let p = rs;
      while (p > prevEnd && !/[\s。！？；，、一-鿿]/.test(text[p - 1])) p -= 1;
      if (/[=^_{}():]/.test(text.slice(p, rs))) rs = Math.max(p, prevEnd);
      if (end <= rs) return;
      const tex = text.slice(rs, end);
      spans.push({ start: rs, end, tex, display: /\\begin\{/.test(tex) });
    };
    while ((m = MATH_CMD_RE.exec(text))) {
      const tokStart = m.index;
      const tokEnd = m.index + m[0].length;
      if (inside(tokStart, tokEnd)) continue; // 已在 $...$ 或环境块里
      if (runStart < 0) {
        runStart = tokStart;
        runEnd = tokEnd;
        continue;
      }
      const gap = text.slice(runEnd, tokStart);
      // 间隔里出现中文或句读 = 公式结束、正文开始；间隔太长也不信它是同一段。
      // 间隔里若整个包着已认定的段（$...$ 夹在两个裸命令之间），也切断。
      if (MATH_GAP_OK_RE.test(gap) && !spans.some((s) => s.start >= runEnd && s.end <= tokStart)) {
        runEnd = tokEnd;
      } else {
        pushRun(runStart, runEnd, tokStart);
        runStart = tokStart;
        runEnd = tokEnd;
      }
    }
    if (runStart >= 0) pushRun(runStart, runEnd, Infinity);
  }

  spans.sort((a, b) => a.start - b.start);
  return spans;
}

// HTML 实体还原：摘要在抓取层剥过标签但实体原样留着（&amp; &lt; &gt; &quot;），
// 交给 KaTeX 前必须还原，否则 \sum_{k=&lt;N&gt;} 解析不了。
const MATH_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/**
 * 把一段数学源文渲染成 HTML 字符串；解析不了返回 null（调用方回退原文）。
 * katex 由调用方传入，Node 单测与浏览器共用这一份修复逻辑。
 *
 * 摘要被 clamp 截断时截点常落在公式中间，留下四类残伤，逐个修：
 *   1. 实体未还原（&amp;）——先还原；
 *   2. 环境不闭合（\begin{aligned} 有开无闭）——按开序补 \end；
 *   3. 花括号不闭合（\sqrt{ 截半）——数未闭合的 { 补 }；
 *   4. \left 没有配对 \right——补 \right.；
 *   5. 命令截半（\boldsymbol 剩 \bol）——从尾部砍到该反斜杠之前再试。
 * 2-4 是「补」，5 是「砍」，交替进行最多三轮；都失败就放弃，页面上保留源文，
 * 不画红色报错。补花括号时排除 \left\{ 与 \right\}：那里的花括号是定界符不是分组。
 */
function renderMathHtml(katex, tex, display) {
  const cleaned = tex.replace(/&(amp|lt|gt|quot|#39);/g, (m) => MATH_ENTITIES[m] || m);
  const tryRender = (t) => {
    try {
      return katex.renderToString(t, { throwOnError: true, displayMode: display });
    } catch {
      return null;
    }
  };

  const balance = (t) => {
    let out = t;
    const opens = [];
    const envRe = /\\(begin|end)\{([a-zA-Z*]+)\}/g;
    let m;
    while ((m = envRe.exec(out))) {
      if (m[1] === 'begin') opens.push(m[2]);
      else opens.pop();
    }
    if (opens.length) out += opens.reverse().map((n) => `\\end{${n}}`).join('');
    const stripped = out.replace(/\\[{}]/g, '').replace(/\\(left|right)[{}]/g, '');
    let depth = 0;
    for (const ch of stripped) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth > 0) out += '}'.repeat(depth);
    const lefts = (out.match(/\\left(?![a-zA-Z])/g) || []).length;
    const rights = (out.match(/\\right(?![a-zA-Z])/g) || []).length;
    if (lefts > rights) out += '\\right.'.repeat(lefts - rights);
    if (rights > lefts) out = `\\left.${'\\left.'.repeat(rights - lefts - 1)}${out}`;
    return out;
  };

  let html = tryRender(balance(cleaned));
  if (html) return html;

  // 砍尾部截半命令再补结构，交替最多三轮。
  let t = cleaned;
  for (let round = 0; round < 3; round += 1) {
    const lastBs = t.lastIndexOf('\\');
    if (lastBs < 0) break;
    t = t.slice(0, lastBs).replace(/[\s,;]+$/, '');
    if (!t) break;
    html = tryRender(balance(t));
    if (html) return html;
  }
  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mathSegments, renderMathHtml };
}
