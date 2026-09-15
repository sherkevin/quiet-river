'use strict';

/**
 * 摘要数学分段器的回归测试。
 *
 * 分段器住在 public/math-seg.js（浏览器 <script> + Node 双用），这里用真实摘要
 * 样本钉住三种形态的边界：带 $ 分隔符的、知乎/科学空间那种没有 $ 的裸命令段、
 * 以及必须放弃的整篇 LaTeX 文档 preamble。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const katex = require('../public/vendor/katex/katex.min.js');
const { mathSegments, renderMathHtml } = require('../public/math-seg.js');

const texOf = (text) => mathSegments(text).map((s) => s.tex);

test('带分隔符：行内 $...$ 与块级 $$...$$ 都认', () => {
  assert.deepEqual(texOf('能量 $E=mc^2$ 守恒'), ['E=mc^2']);
  const segs = mathSegments('公式 $$\\int_0^1 x\\,dx$$ 结束');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].display, true);
});

test('不配对的美元符号不渲染', () => {
  assert.deepEqual(mathSegments('这本书卖 $100，另一本 $50'), []);
  assert.deepEqual(mathSegments('$abc$ 只是变量对，没有命令也没有上下标'), []);
});

test('裸命令段：知乎复幂积分那条真实摘要', () => {
  const text = '从 \\int_{-\\pi}^{\\pi}[i^{\\tan x}-(\\cot x)^i]dx 到一族漂亮的恒等式严格来说， (\\cot x)^i 不是普通实幂，而是复幂。';
  const segs = mathSegments(text);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].tex, '\\int_{-\\pi}^{\\pi}[i^{\\tan x}-(\\cot x)^i]dx');
  assert.equal(segs[1].tex, '(\\cot x)^i');
  // 段互不重叠且升序
  assert.ok(segs[0].end <= segs[1].start);
});

test('裸命令段：段尾在中文处切断，不把正文拖进公式', () => {
  const segs = mathSegments('学习策略函数 \\pi(a|s) ，用策略 \\pi 来控制 agent 做动作。');
  assert.equal(segs.length, 2);
  assert.equal(segs[0].tex, '\\pi(a|s)');
  assert.equal(segs[1].tex, '\\pi');
});

test('裸命令段：段头回扩吃左括号与带算符的前缀', () => {
  assert.equal(texOf('主值约定： z^w:=e^{w\\operatorname{Log} z},\\qquad -\\pi<x')[0], 'z^w:=e^{w\\operatorname{Log} z},\\qquad -\\pi<x');
  assert.equal(texOf('即 (\\cot x)^i 是复幂')[0], '(\\cot x)^i');
});

test('纯英文单词挨着命令不吃进公式', () => {
  assert.deepEqual(texOf('word\\alpha 不是公式开头'), ['\\alpha']);
});

test('环境块整段认成块级公式', () => {
  const text = '基本形式如下：\\begin{equation}\\begin{aligned}M_t =&\\, \\beta M_{t-1}\\end{aligned}\\end{equation} 其中';
  const segs = mathSegments(text);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].display, true);
  assert.ok(segs[0].tex.startsWith('\\begin{equation}'));
});

test('整篇 LaTeX 文档 preamble 放弃渲染', () => {
  const text = '一类重要的极限求解问题：\\documentclass{article} \\usepackage{amsmath} \\usepackage{geometry} \\geometry{a4paper}';
  assert.deepEqual(mathSegments(text), []);
});

test('纯中文句子不被误抓', () => {
  assert.deepEqual(mathSegments('这道题的关键在主值支路，复幂必须说明对数支路。'), []);
});

test('段与段永不重叠：$...$ 夹在裸命令之间也各归各', () => {
  const text = '\\alpha 然后 $x^2$ 然后 \\beta';
  const segs = mathSegments(text);
  for (let i = 1; i < segs.length; i += 1) assert.ok(segs[i - 1].end <= segs[i].start);
});

test('clamp 截断残尾：孤立反斜杠与省略号不进公式', () => {
  const segs = mathSegments('主值约定： z^w:=e^{w\\operatorname{Log} z},\\qquad -\\…');
  assert.equal(segs.length, 1);
  assert.equal(segs[segs.length - 1].tex.endsWith('\\'), false);
  assert.ok(!segs[0].tex.includes('…'));
});

test('修复层：实体还原、补环境、补花括号、配对 left/right', () => {
  const ok = (tex, display = false) => renderMathHtml(katex, tex, display);
  assert.ok(ok('\\sum_{k=&lt;N&gt;}^{M} a_k'));
  assert.ok(ok('\\begin{aligned}x =&\\, y', true));
  assert.ok(ok('||u||=\\sqrt{\\langle \\bol'));
  assert.ok(ok('\\left( a + b'));
  assert.ok(ok('a + b \\right)'));
  assert.ok(ok('\\boldsymbol{M}_t =\\, \\beta \\boldsymbol{M}_{t-1}'));
});

test('修复层：真解析不了的返回 null，不回退成红色报错', () => {
  assert.equal(renderMathHtml(katex, '\\enclose{horizontalstrike}{\\text{', false), null);
  assert.equal(renderMathHtml(katex, '\\s', false), null);
});

test('空输入与无公式输入返回空数组', () => {
  assert.deepEqual(mathSegments(''), []);
  assert.deepEqual(mathSegments(null), []);
  assert.deepEqual(mathSegments('普通摘要，没有任何数学标记。'), []);
});
