# 私有适配器配置指南

一句话核心：**本仓库默认不带登录态适配器**。想抓需要登录的平台（知乎、小红书这类），
在你自己的机器上写一个适配器文件、放一份凭证即可。这篇文档讲四件事：文件放哪、
怎么写、凭证怎么存、怎么验证挂载成功。

公开版不读这篇也能完整跑起来——能匿名抓的平台（博客、GitHub、arXiv、CSDN 等）
开箱即用。这篇只服务于想抓「平台没给匿名读者出口」那一档的人。

## 一、为什么不内置登录态适配器

知乎对匿名请求全程拦截，小红书没有公开 feed，能抓到的都靠登录态（等价于你浏览器里
那份已登录的凭证）。把某个平台的反爬绕过写成公开代码，等于发布一个绕过工具集，
既有 ToS 与下架风险，也不是这个项目想成为的东西。所以仓库留的是一个**插件位**：
实现留在你自己机器上，位子是公开的。

## 二、插件位：lib/adapters.private.js

这个路径被 `.gitignore` 排除，**存在即自动挂载，不存在静默跳过**。挂载后添加页会
自动多出一张该平台的来源卡（由服务端 `/api/state` 的 `capabilities.adapterPlatforms`
驱动）；没挂载时不显示，也就不会出现「点了才报错」。

文件形状是一个数组，每个元素是一个适配器：

```js
// lib/adapters.private.js
const { readSecret } = require('./secrets');

module.exports = [
  {
    platform: 'example',      // 唯一标识，用于归类与节流 key
    label: '某平台',           // 来源卡上显示的名字
    tier: 3,                  // 第 3 档 = 需要登录态或没有可抓出口
    match(url) {
      // 从用户贴的主页链接里认出自己，认不出返回 null
      const m = /example\.com\/u\/([\w-]+)/.exec(String(url));
      return m ? { id: m[1] } : null;
    },
    async fetchItems(id) {
      const cookie = readSecret('example-cookie.txt', 'EXAMPLE_COOKIE');
      if (!cookie) {
        throw new Error('缺登录态：把整段 Cookie 贴进 secrets/example-cookie.txt（单行），或设环境变量 EXAMPLE_COOKIE');
      }
      const res = await fetch(`https://example.com/api/u/${id}/posts`, { headers: { Cookie: cookie } });
      if (res.status === 403) throw new Error('某平台返回 403：多半是请求太密被限流，等一两分钟再刷一次');
      const data = await res.json();
      return {
        name: data.nickname,
        items: data.posts.map((p) => ({
          guid: `p-${p.id}`,
          title: p.title,
          link: p.url,
          author: data.nickname,
          published: p.created_at * 1000, // 毫秒时间戳
          summary: p.excerpt,
          image: p.cover,
          categories: p.tags || [],
        })),
      };
    },
  },
];
```

三条硬约束：

- **条目形状与 feed 解析器一致**：`{ guid, title, link, author, published, summary, image, categories }`。
- **`published` 是毫秒时间戳。拿不到发布时间的平台不要写适配器**——没有时间就进不了时间倒序的河。
- **你抛的 Error 消息就是问题栏里显示的内容**，写可读的：说清发生了什么、该怎么办，别只抛一个状态码。

两条行为约定（内置适配器都遵守，自写时建议照做）：

- **读 403 直接停手不重试**。连续失败 3 次后自动刷新会跳过它，免得对着一个正在限流你的源反复敲门；手动点「刷新」永远强制重试，成功一次计数归零。
- **自己的多次请求之间留间隔**。登录态通道普遍对突发请求限流（实测某平台约 17 次请求 / 15 秒就 403），两次请求之间隔 1.5 秒是实测安全值。

## 三、凭证存放：secrets/ 加 readSecret

凭证放 `secrets/` 目录或环境变量，**不要写进代码，也不要写进 `data/subscriptions.json`**
（后者是要提交的文件）。`lib/secrets.js` 给了统一读取入口：

```js
const { readSecret } = require('./secrets');
// 先读环境变量，再读 secrets/<文件名>，两者都没有返回空串，由适配器自己抛缺凭证提示
const cookie = readSecret('example-cookie.txt', 'EXAMPLE_COOKIE');
```

存放步骤：

```bash
printf '%s' '<这里贴整段 Cookie>' > secrets/example-cookie.txt
chmod 600 secrets/example-cookie.txt
git check-ignore -v secrets/example-cookie.txt   # 必须打印一条忽略规则，确认它真不会进仓库
```

`secrets/README.md` 里的三条底线同样适用：只放自己的凭证；别写进代码或配置；
低频使用，读到 403 就停手退避，不要轮询，不要频繁重登（重登会作废旧 cookie）。

## 四、登录态怎么取

以最常见的一类——Cookie 型平台（知乎是这类）——为例：

1. 浏览器登录该平台。
2. 打开开发者工具，切到 **Network（网络）** 面板，刷新页面。
3. 点第一条发往该域名的请求，在右侧 **Request Headers** 里找到 `Cookie:` 一行，复制整行的值。
4. 贴进上一节的文件里。

两个坑：

- **必须从 Network 面板复制**。核心凭证字段通常带 HttpOnly 标记，控制台里的 `document.cookie` 读不到它，只有浏览器实际发出的请求头里有。
- **403 不等于 cookie 失效**。登录态通道普遍限流：翻页太快、探测太密都会 403，退避一两分钟就恢复。判别方法是 403 之后先做一次单点健康检查——**单点也 403 才是 cookie 坏了**，那时再重贴。频繁重登会作废旧 cookie，别轻易动。

另一类平台不走 cookie 路：它的登录态绑在浏览器会话上，cookie 寿命极短或导不出来。
思路是**让适配器 shell 出去调一个能驱动本机已登录浏览器的命令行工具，解析它的 JSON
输出**（小红书在这台机器上就是这类）。这类通道返回的字段常常不全（只有标题、封面、
赞数，没有昵称），所以添加时要自己填博主名字；换网络可能触发验证，重新登录一次即可。

## 五、验证挂载

写完文件后**重启服务**（`require` 有缓存，热加载不会拾到新文件）：

```bash
node server.js
curl -s http://127.0.0.1:4321/api/state | grep -o '"adapterPlatforms":\[[^]]*\]'
```

输出里应该出现你的 `platform` 名。然后：

1. 打开添加页，应该多出一张来源卡。
2. 贴一个主页链接点「识别」：应返回第 3 档和你的平台名，并实际抓一次验证。
3. 添加成功后，抓取失败时问题栏显示你抛的那句可读原因；成功则条目进河。

## 六、动手前先确认你真的需要写适配器

很多「看起来要登录」的平台其实有匿名出口，先查再动手：

| 情况 | 走法 | 详见 |
|---|---|---|
| 平台有原生 feed、autodiscovery 或匿名接口 | 贴主页链接即识别，开箱即用 | README「添加博主」的档位表 |
| 掘金、少数派、即刻、Hacker News、Semantic Scholar | 免凭证适配器已内置 | README「免凭证适配器」一节 |
| B站 | 自托管 RSSHub，设置里填 `rsshubBase` | README「添加博主」第 2 档段落 |
| 微信公众号、X / Twitter | 公开转发目录，贴转发地址即可抓 | README 的 wechat2rss 表格与 X 转发小节 |

四条都不通，才需要本篇的插件位。

## 七、红线汇总

- `lib/adapters.private.js` 与 `secrets/` 下除 README 外的所有文件**永不进仓库**；写完用 `git check-ignore` 验一遍。
- 凭证不进 `data/subscriptions.json`、不进代码。
- **反爬绕过实现不发布到公开仓库**：转发服务与登录态工具历次下架的诱因都是「公开仓库 + 高频抓取」，不是本地使用。
- 低频抓取。登录态通道的命脉在平台手里，敲得越狠封得越快。
