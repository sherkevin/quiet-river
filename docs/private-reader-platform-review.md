# 私有阅读平台方案评审

评审对象：[`private-reader-platform.md`](private-reader-platform.md)
评审日期：2026-09-16（**v2，含对 v1 的自我纠错，见 §0**）
评审方法：方案里每条可验证的技术断言都拉到源码级别核对（RSSHub 路由实现、
Karakeep 的 `feedParser.ts` / `bookmarks.ts` / OpenAPI spec / highlight schema、
Miniflux 官方 API 文档、we-mp-rss 的 `config.example.yaml` 与 `docs/weread-mp.md`）。
**未**在真实 ECS、真实平台账号、真实博主列表上做连通测试——这一点与方案自述一致。

## 0. v1 评审的两处错误（自查后纠正）

v1 把「保留本项目现有适配器」当成结论，理由是「登录态资产更难、更好」。
复查源码与数据后，这个论证有两处站不住：

### 错误一：把「条数更多」当成了「资产更好」，忽略了正文这个维度

v1 只对比了条数（我们 20 vs RSSHub 7），没对比**正文**。实测两者的 API 请求参数：

```text
本项目 lib/adapters.private.js:56
  answers?limit=20&offset=0&include=data[*].excerpt,created_time,question
  -> summary: clamp(stripHTML(a.excerpt))     只要摘要

RSSHub lib/routes/zhihu/answers.ts:39
  answers?limit=7&include=data[*].is_normal,content
  -> description: processImage(item.content)  要完整正文，并处理图片
```

`processImage` 还做了正文清洗：移除 `noscript` 与 mcn-link-card、
解开 `link.zhihu.com/?target=` 跳转、修正图片的 `data-actualsrc` 懒加载属性。

**在「拿到可阅读正文」这个维度上，RSSHub 的实现优于本项目现有适配器。**
本项目全库 7474 条实测**无一条存正文**：

| 平台 | 条目 | 平均 summary | 带正文字段 |
|---|---|---|---|
| 知乎 | 4176 | 166 字 | 0 |
| feed 类 | 2981 | 225 字 | 0 |
| 小红书 | 253 | 0 字（通道只给标题封面） | 0 |
| 播客 | 34 | 376 字 | 0 |
| 掘金 | 10 | 83 字 | 0 |

`summary` 被 `SUMMARY_LIMIT = 400` 硬截断，数据模型里**根本没有 `content` 字段**。
这不是疏漏，是 README「它刻意不做的事」里明写的产品边界：

> **不做全文抓取。**只取 feed 提供的标题、摘要、链接、时间、作者、封面。
> 要看全文点进原文。

前端行为印证：`app.js:723` 点卡片就是 `window.open(link.href, '_blank')`。

**结论修正**：本项目现有架构是为「时间轴 + 摘要 + 跳原文」设计的，
而目标平台需要「全文存档 + 站内阅读 + 划线」。两者数据模型不同。
所以知乎通道的真问题不是「RSSHub 不如我们」，而是
**「全文获取这件事本项目从来没做过，谁来做都是新增工作」**——
而 RSSHub 在这件事上已经有现成且带清洗的实现。

### 错误二：把「登录态资产」当成已建成的，而它当下是停摆的

v1 说「115 个知乎源现在正在跑」。实测当日 `data/cache.json` 的错误状态：

| 源 | 数量 | 当前状态 |
|---|---|---|
| 知乎 | 115 | **115 个全部报错**（109 个 HTTP 401，6 个 403） |
| 小红书 | 13 | **13 个全部报错**（浏览器会话需重新登录） |

单点健康检查（`/api/v4/me`，即 RSSHub `check-cookie.ts` 用的同一端点）也返回
`401 ERR_TICKET_NOT_EXIST`。按本项目自己的判别法
（`docs/deploy-parity.md`：「单点也 403 才是真失效」），**这是真失效，不是限流**。
凭证文件最后修改于 9 月 11 日，已失效约 5 天。

**结论修正**：登录态不是「已建成、换架构就会失去的资产」，
而是**一个需要持续人工维护、且已经断了 5 天没人发现的脆弱凭证**。
全库 253 个缓存键里 146 个带 error。这反而支持方案的一个隐含判断：
把抓取押在单一登录态凭证上，运维上是脆弱的。

### 这两处纠正后，评审的立场变化

| 议题 | v1 结论 | v2 结论 |
|---|---|---|
| 知乎走 RSSHub | 不成立，会丢登录态 | **方向可行**，但需补 `d_c0`+`__zse_ck` 才有登录态；条数从 20 降到 7 是真实代价 |
| 保留本项目适配器 | 强烈建议 | 建议**保留清单与 tag 体系**（115 个源的 url_token、16 个 tag 的人工判定），**不保留抓取实现** |
| 全文抓取 | 未识别为缺口 | **这是最大的新增工作量**，方案里被「RSSHub 转换」四个字带过了 |

v1 仍然成立的部分：小红书 `guid` 用标题当 ID（P1-1）、高亮是字符偏移（P1-2）、
备案与端口（P1-3）、singlefile 不在 OpenAPI spec（P2-1）、
OPML 导出带不走适配器源（P0-2 的实测证据）、以及下面新增的 P0-3。


> **发布状态（2026-09-17 翻转）**：本文原先标为「本机文档，不进发布白名单」，
> 理由是它提到登录态凭证文件的路径与一个本机 CLI 工具名。这两条理由经核实都不再成立：
> 凭证值从来不在本文里（本文只出现过文件名，已改为泛指），而那个 CLI 实测是
> npm 公开包 `@jackwener/opencli`（Apache-2.0），不是本机私有设施——
> 扫描器里那条规则的理由当时写错了，已按「误报进豁免清单并留理由」的既定原则处理。
> **本文现已进 `tools/publish.sh` 的 ALLOW 白名单**，随公开仓发布。
>
> 仍然不发布的是：登录态适配器源码、全量缓存、凭证本体、`docs/LOCAL.md`，
> 以及 `tools/publish.sh` 与 `tools/scan-leaks.js` 自己——后两者的脱敏模式表
> 写明了「这台机器上哪些串算痕迹」，发布它们等于公开一份绕过指南，这条理由没变。
>
> 实扫核实（2026-09-16，结论仍有效）：`node tools/scan-leaks.js` 扫 docs/ 时，
> 同目录的方案文档、现状简报、外部方案三份报 0 处。外部方案那两处
> `SCHEDULER_ROUND_ROBIN_MIN_INTERVAL=15` 的误报已按惯例写进 `EXEMPT` 并留了理由
> （上游项目的公开环境变量名）。scan-leaks 的真实扫描对象是发布暂存区，不是 `docs/`。

## 总体判断

**方案设计质量高，绝大多数技术断言核实为真，但它绕开了本项目已经建成且更难的那一层，
并且在知乎这条最关键的通道上做了错误的技术假设。**

不建议照方案直接开工。建议先解决下面两个 P0，再决定要不要这套架构。

## 一、核实为真的断言（方案这部分做得扎实）

这些我都拉到源码确认过，不是读 README 得出的：

| 方案断言 | 核实结果 | 证据 |
|---|---|---|
| Karakeep 的 RSS 导入丢弃正文，只传链接与标题 | **成立** | `apps/workers/workers/utils/feedParser.ts` 的 schema 只取 `id/link/guid/title/categories`；`feedWorker.ts:304` 的 `createBookmark` 只传 `type/url/title/source` |
| Karakeep 原生刷新按小时执行 | **成立** | `feedWorker.ts` 里 `cron.schedule("0 * * * *", ...)`，且用 `hourlyWindow` 做幂等键 |
| 小红书路由的回退分支把**封面图地址**当条目 `link` | **成立，且比方案说的更糟** | `lib/routes/xiaohongshu/user.ts:105` `link: coverUrl`。同时 `guid: noteCard.displayTitle`——**用标题当唯一 ID** |
| Miniflux 的 `GET /v1/entries`、`PUT /v1/feeds/{id}/refresh`、`fetch-content` 存在 | **成立** | 官方 API 文档逐个列出，含 `GET /v1/entries/{entryID}/fetch-content` |
| Karakeep 的 singlefile 导入端点与五种 `ifexists` 模式 | **成立** | `packages/api/routes/bookmarks.ts:122`；`skip/overwrite/overwrite-recrawl/append/append-recrawl` 全部对得上 |
| Karakeep 支持划线并带笔记 | **成立（术语要纠正）** | `packages/shared/types/highlights.ts` 的 `zHighlightBaseSchema` 有 `text` 与 `note` 字段；REST 侧 `GET/POST /highlights`、`PATCH /highlights/{id}` 都在 spec 里 |
| 文本书签有 `sourceUrl`，可承载文章级笔记 | **成立** | OpenAPI spec 里 `POST /bookmarks` 的 `type:"text"` 分支含 `text` + `sourceUrl`；bookmark 本体另有 `note` 字段 |
| RSSHub 有知乎回答与文章路由 | **成立** | `/zhihu/people/answers/:id`（`answers.ts`）、`/zhihu/posts/:usertype/:id`（`posts.ts`） |
| we-mp-rss 是 MIT、`gather.content` 默认关、weread_mp 只取最新一篇 | **三条全部成立** | `LICENSE` 文件确认 MIT；`config.example.yaml` 里 `content: ${GATHER.CONTENT:-False}`；`docs/weread-mp.md` 第 41 行明写「拿不到历史文章列表」 |
| Meilisearch 只取 MIT 社区版 | **成立** | `LICENSE` 是 `MIT AND BUSL-1.1`，EE 部分单独走 BUSL |
| Basic Auth 会和 SingleFile 的 Bearer 认证冲突 | **成立**，方案自己识别出这个坑，判断正确 |
| 有批注后不能自动覆盖正文 | **成立，但理由比方案说的更硬**，见 P1-3 |

方案最值得肯定的一点是它的**降级哲学**：全文/部分/元信息/失败四态显式建模，
「连发布列表都拿不到必须显示来源异常，不能显示为没有更新」——
这条和本项目 ADR 0010 的教训（wewe-rss 死于把失败藏起来）同源，方向是对的。

## 二、P0：两个会让方案失败的前提问题

### P0-1 知乎走 RSSHub 的登录态条件，方案没写，但可满足（v2 已修正 v1 的过度悲观）

方案把知乎归到「RSSHub 转换」这一档，没提它需要什么样的凭证。实测这条通道**可用**，
但有两个前置条件必须写进部署清单，否则会静默退化成匿名抓取。
（知乎凭证按 `secrets/README.md` 的约定存放，路径与文件名见该文档。）

**条件一：`ZHIHU_COOKIES` 里必须含 `d_c0`，否则 `z_c0` 被丢弃。**

`lib/routes/zhihu/utils.ts` 的 `withZhihuClient` 判定：

```ts
const dc0 = getCookieValueFrom(configured, 'd_c0');
const hasConfiguredSession = !!dc0 && !!getCookieValueFrom(configured, '__zse_ck');
```

本项目现有的凭证文件**只有 `z_c0` 一个字段**（实测确认）。只有 `z_c0` 时
`configuredDc0` 为空，走进这个分支：

```ts
cookie: configuredDc0 ? mergeGeneratedCookies(configured, dc0, zseCk)
                      : `__zse_ck=${zseCk}; d_c0=${dc0}`   // <- z_c0 在这里被完全丢掉
```

**但只要补一个 `d_c0`，`mergeGeneratedCookies` 会保留 `z_c0`**——它只剔除
`d_c0` 与 `__zse_ck` 两项，其余字段原样拼回：

```ts
const mergeGeneratedCookies = (configured, dc0, zseCk) => {
  const remaining = configured.split(';').map(p => p.trim())
    .filter((pair) => {
      const name = pair.split('=', 1)[0];
      return name && name !== 'd_c0' && name !== '__zse_ck';   // z_c0 通过
    });
  return [`__zse_ck=${zseCk}`, `d_c0=${dc0}`, ...remaining].join('; ');
};
```

所以**正确配置是 `z_c0` + `d_c0` 两个字段**，`__zse_ck` 不用管
（RSSHub 会用 JSDOM 现场生成，那套 `x-zse-96` 签名与 WASM VM 它已经实现了）。
本项目现有适配器只需要 `z_c0` 是因为它直连 API 不走签名挑战；RSSHub 走挑战，
所以要 `d_c0` 当身份锚点。这不是缺陷，是两条路各自的凭证需求。

**条件二：必须配 `XIAOHONGSHU_COOKIE`，否则拿到的是坏数据**（详见 P1-1）。

**v1 在这里判断错了**：v1 说「换成 RSSHub 等于丢掉登录态」，
实际上补一个 `d_c0` 就保住了。v1 也没意识到 RSSHub 的知乎实现**返回完整正文**
而本项目只返回摘要——见 §0 错误一。

**仍然成立的代价**：

1. **条数从 20 降到 7**：`answers.ts` 写死 `limit=7`（`posts.ts` 是 20）。
   本项目是 articles 20 + answers 20 合流排序。回答深度砍到 7 条是真实损失，
   要接受或给 RSSHub 提 patch（那就违反「不改现成项目」的前提）。
2. **两路分开订阅，合流排序要在 Bridge 里重做**：本项目已经做掉了这件事
   （`adapters.private.js` 里 articles + answers 按 `published` 合流），
   新架构要再做一次。
3. **`d_c0` 与 `z_c0` 都要维护**：`z_c0` 已经在维护了（且已失效，见 P0-3），
   `d_c0` 是新增的一个。

**所以知乎这条不是「方案选型错误」，而是「方案漏写了两个必需的凭证条件」。**
评级从 v1 的「不成立」改为「可行，但需补部署细节」。

### P0-2 请求量级与迁移路径


三个叠加的问题：

**条数砍半还多。**`answers.ts` 写死 `limit=7`：

```ts
const apiPath = `/api/v4/members/${id}/answers?limit=7&include=data[*].is_normal,content`;
```

`posts.ts` 是 `limit: '20'`。本项目现有适配器是 articles 20 + answers 20 合流排序。
换 RSSHub 后回答深度从 20 掉到 7，而且**两路分开订阅，合流排序要在 Bridge 里重做一遍**
——正是本项目已经做掉的事。

**请求量翻倍撞风控。**分开订阅回答与文章 = 每个博主两路请求。
115 个知乎源 × 2 = 230 个请求/轮。本项目 `lib/refresh.js` 里记着实测数据：

```js
// 知乎 2026-09-11 实测约 17 次请求 / 15 秒就 403
'adapter:zhihu': 8000,          // 同宿主最小间隔 8 秒
'adapter:zhihu': 6*60*60*1000,  // 最小重抓周期 6 小时
```

230 个请求按 8 秒间隔是 30 分钟一轮。方案里 RSSHub 那一行只写了
「使用缓存，限制同平台并发，失败后退避」，**没有量化**。
而这是在机房 IP 上，比本机的家庭宽带更容易触发风控。

**迁移路径完全缺失。**方案通篇没提本项目已有的 271 个源。按迁移难度分四类：

| 现有源 | 源数 | 现有通道 | 迁到 Miniflux 要做什么 | 难度 |
|---|---|---|---|---|
| 博客/GitHub/arXiv/CSDN/B站等 | 45 | 原生 feed 或 RSSHub | 直接订 URL，无需改 | 低 |
| X（api.xgo.ing 转发） | 28 | 第三方转发地址 | 直接订转发地址 | 低 |
| 公众号 | 66 | 两个 wechat2rss 公开目录（49）+ 手动登记（17） | 49 个可直接订；17 个手记号才需要 we-mp-rss | 中 |
| 知乎 | 115 | 私有适配器（登录态直连 API） | 重配成 115 个 RSSHub 路由 + 补 `d_c0` | 高 |
| 小红书 | 13 | 私有适配器（驱动本机浏览器） | 重配成 13 个 RSSHub 路由 + Puppeteer + Cookie | 高 |

**Miniflux 只能订 RSS URL，订不了「适配器」。**128 个源在新架构里没有位置，
除非重配成 RSSHub 路由。方案把这 128 个源的处理成本写成了「RSSHub 转换」四个字。

**真正值钱、必须迁移的是清单而不是抓取实现**：115 个知乎 `url_token`、
16 个 tag 的人工判定（ADR 0001-0007、0012 累积的成果）、
271 个源的收录判据。这些是三个月人工筛选的结果，抓取实现反而是可替换的。
`data/subscriptions.json` 导出成 Miniflux 能吃的 OPML 需要补 §五 说的 RSS 出口。

### P0-3 全文抓取是整个方案最大的新增工作量，方案用四个字带过了

目标平台的第 3 项需求是「站内直接阅读全文，不跳转」。实测本项目**从未存过正文**：
全库 7474 条，`content` 字段命中 0，`summary` 平均 184 字、最长 400（被
`SUMMARY_LIMIT` 硬截断）。README 明写「**不做全文抓取**……要看全文点进原文」。

这意味着方案里「Miniflux 取得正文 -> Bridge 转存 -> Karakeep 站内阅读」这条链路的
**第一环在我们这里根本不存在**，要新建。按来源分：

| 来源 | 全文从哪来 | 状态 |
|---|---|---|
| 知乎 | RSSHub 路由已带 `content` + `processImage` 清洗 | **现成**，这是走 RSSHub 的真实理由 |
| 公众号 | we-mp-rss 的 `gather.content: true` | **现成**，需扫码授权 |
| 博客（49 个源） | 部分 feed 自带全文；其余要 Miniflux 的 Readability 提取 | 部分现成 |
| X（28 个） | 转发地址给的是推文正文 | 现成但短 |
| 小红书（13 个） | RSSHub 有 cookie 时走 `renderNotesFulltext`，逐条二次请求笔记详情 | 现成但每篇多一次请求 |
| B站/播客/掘金等 | 视频与音频没有「正文」概念 | 不适用 |

**结论**：全文这件事 RSSHub + we-mp-rss + Miniflux Readability 组合起来覆盖率不低，
但它是**新增的一整套正文生命周期**：存储（本项目现在 5.7MB，全存正文按 10KB/条估算
是 73MB）、图片本地化、清洗规则、版本冻结（P1-2）。方案 §6 写了流程，
但没写这套东西第一次建起来的成本，也没写它和本项目现有数据模型的不兼容。

### P0-4 登录态通道当前已失效 5 天，这本身就是要解决的运维问题

实测当日 `data/cache.json`：253 个缓存键里 **146 个带 error**。

| 源 | 数量 | 错误 |
|---|---|---|
| 知乎 | 115 | **全部报错**：109 个 `HTTP 401`，6 个 `403` |
| 小红书 | 13 | **全部报错**：浏览器会话需重新登录 |
| feed 类 | 18 | `fetch failed` 8、超时 4、非 feed 2、503 2、403 1、429 1 |

单点健康检查（`/api/v4/me`，即 RSSHub `check-cookie.ts` 用的同一端点）返回
`401 ERR_TICKET_NOT_EXIST`。按本项目自己的判别法
（`docs/deploy-parity.md`：「单点也 403 才是真失效」），**这是真失效**。
凭证文件最后修改于 9 月 11 日。

**这件事对新架构的意义**：128 个源静默停摆 5 天没人发现，说明现有形态缺
**凭证健康监控**，而不是缺抓取能力。方案 §3「来源状态必须可见、更新失败不能显示为
没有新文章」正好解这个问题——这是方案比现状强的地方，应当采纳。

反过来说：新架构如果仍然押在 `z_c0` 单点凭证上，同样会静默失效。
所以无论走哪条路，**凭证健康检查 + 失效告警**都是第一优先级，
比推荐算法和日报都优先。

## 三、P1：需要改设计的三个问题

### P1-1 小红书的 `guid` 是标题，Bridge 的去重会直接失效

方案说「不要靠文章标题去重」，但 RSSHub 给的就是标题当 guid：

```ts
// lib/routes/xiaohongshu/user.ts 的 renderNote
return {
  title: noteCard.displayTitle,
  link: coverUrl,                        // 封面图，不是笔记地址
  guid: noteCard.displayTitle,           // 标题当唯一 ID
  ...
};
```

三个后果：同一作者两篇同名笔记会撞成一条；改标题会被当成新条目重新入库；
Miniflux 的 GUID 去重直接失效。

**修法**：Bridge 必须自己重建稳定 ID。本项目已有现成经验——
小红书 note id 前 8 位 hex 就是 Unix 秒（`lib/adapters.private.js` 里已解码验证）：

```js
const ts = parseInt(nid.slice(0, 8), 16) * 1000;
```

但**有 cookie 时走的是另一条分支**（`renderNotesFulltext`），那条分支的
`link` 与 `guid` 都是正确的 `explore/<noteId>`：

```ts
const link = `${urlPrex}/${id}`;
const guid = `${urlPrex}/${noteCard.noteId}`;
```

所以小红书**必须配 `XIAOHONGSHU_COOKIE`**，否则拿到的就是坏数据。
方案把 Cookie 写成「可选配置」，实际是**必需**。

另外该路由 `requirePuppeteer: true`，每个请求起一次浏览器。
本项目在 B 站路由上实测过这个模式：
「每个 B站请求都会起一次浏览器，连续添加多个源容易撞 503，隔几秒单独重抓即可」。
13 个小红书源 = 13 次浏览器启动/轮，4核8G 上要和 Meilisearch、Postgres、
Chromium 抢内存。

### P1-2 高亮定位是字符偏移，正文冻结这条比方案说的更不可妥协

方案说「保留多个 HTML 文件不等于高亮会自动迁移」，判断对，但没说清机制。
Karakeep 的高亮用**纯字符偏移**定位：

```ts
// packages/shared/types/highlights.ts
startOffset: z.number(),
endOffset: z.number(),
text: z.string().nullable(),
note: z.string().nullable(),
```

没有 DOM 路径、没有锚点、没有指纹。这意味着正文文本**任何一个字符的变化**
（清洗规则微调、空格差异、图片标签顺序变化）都会让所有高亮整体错位，
而且是静默错位——不会报错，只会划到错误的句子上。

方案提到「保存内容哈希」，但哈希只能**检测**变化，不能**修复**偏移。

**结论**：`ifexists=skip` + 已批注即冻结，不是「第一版的简化取舍」，
而是这套数据模型下唯一正确的选择。代价要写进文档：**被批注的文章永久停止内容更新。**
如果以后要支持更新，得自己做高亮迁移（fuzzy anchoring，类似 Hypothesis 的做法），
那是一个独立项目，不在 Bridge 的四模块范围内。

### P1-3 备案与端口：方案的第一版入口在大陆 ECS 上走不通

方案规划 `reader.example.com/desk/`，并在 §12 提了一句备案。
但本项目 ADR 0013 已经踩过这个坑并固化了解法：

> 大陆地域 ECS 的 80/443 受 ICP 备案约束，未备案可能被边缘拦截；
> 脚本支持 `QR_ECS_PORT` 换非标准端口规避。

`tools/deploy-ecs.sh` 里还有第三个坑方案没提：

> 安全组默认不放 80 时表现为「握手成功但响应为空」，极易误判成服务没起。

8 个容器的栈里，这个误判会浪费很久。**第一版入口应该是 IP + 非标准端口**，
域名等备案下来再换。Caddy 的自动 HTTPS 在无域名阶段要显式关掉。

## 四、P2：细节纠正

1. **`/bookmarks/singlefile` 不在 Karakeep 的 OpenAPI spec 里。**
   spec 有 35 个端点，singlefile 不在其中——它在 `packages/api/routes/bookmarks.ts:122`
   用 hono 直接注册，只出现在文档和浏览器扩展的用法里。
   端点真实存在且可用，但**不能用 spec 做契约测试**，
   方案 §11 说「前面核实的 API 要在锁定版本上做实际请求测试」这条因此更重要。

2. **术语：Karakeep 没有 `annotation`。**全仓 `annotation` 零命中。
   实际是两个东西：highlight 上的 `note` 字段（段落级），
   和 bookmark 本体的 `note` 字段（文章级）。方案里「批注」一词混用了这两层，
   实现时会找错 API。

3. **`precrawledArchiveId` 是比 singlefile 更稳的路径。**
   `POST /assets`（在 spec 里，有完整契约）上传文件拿到 `assetId`，
   再 `POST /bookmarks` 传 `type:"link"` + `url` + `precrawledArchiveId`。
   singlefile 端点内部就是这么做的（`uploadAsset` → `createBookmark`）。
   拆成两步的好处：第一步失败不会留下半个书签，
   且两步都在 spec 里有契约。建议 Bridge 用两步式。

4. **Karakeep 版本 v0.33.2 未在评审中核实**（GitHub API 中途限流）。
   方案自己说了「尤其要区分主分支代码与发布版」，这条要执行。

5. **we-mp-rss 的采集模式有 8 种**，不是方案说的两种：
   `web | api | app | free_publish | playwright | weread | weread_mp | auto`。
   方案只讨论了 web 与 weread_mp。`auto` 模式与 `content_mode` 回退开关
   （`首选模式失败后是否回退到另一模式`）值得一并评估。
   另外 `content_auto_interval` 默认 59 分钟、`content_batch_size` 默认 5、
   `content_max_failures` 默认 3——**这已经是一套完整的补抓与退避机制**，
   Bridge 不要重复实现，直接读它的状态。

## 五、第五条路：保留 quiet-river 当抓取层（v2 大幅修正，力度下调）

方案给了四条路（改 Karakeep / 只用 Karakeep / 加 Miniflux / 混合），
漏了一条：**保留 quiet-river 当抓取层，给它加 RSS 出口让 Miniflux 订阅。**

v1 把这条路评为「建议采纳、净效果容器 +1 复杂度 -1」。**v2 下调这个结论**：
v1 没意识到我们根本不存正文（P0-3），而出口能吐的只有摘要，
于是这条路的收益远小于 v1 说的。

### 仍然成立的部分：现成 OPML 导出带不走适配器源

实测 `/api/export` 输出的 OPML 只有 **122 个 outline，而库里有 271 个源**——
因为 `toOpml()` 遍历的是 `sub.feeds`，而适配器源的 `feeds` 是空数组：

```text
有 feeds 的源：122
空 feeds 的源：149
  知乎 115 / 小红书 13 / 公众号手记 17 / 掘金 1 / 播客 1 /
  Semantic Scholar 1 / blog 1
```

**就算把现有 OPML 导进 Miniflux，128 个适配器源会直接消失，连报错都不会有**
（`toOpml` 对空 feeds 是静默跳过，不写占位）。这是 P0-2 的可执行层证据。

修法：加 `GET /api/feed/:id`，把 `cache.json` 里该源的条目按 RSS 2.0 吐出来，
约 50 行、零新依赖（`lib/xml.js` 是**解析器**不是生成器，但 `lib/opml.js` 的
`escapeXml()` 与字符串拼接模式可以直接照搬）。

### 不成立的部分：出口只有摘要，撑不起「站内阅读全文」

加完出口，Miniflux 拿到的是这样的 RSS：

```text
<item>
  <title>某篇知乎回答</title>
  <link>https://www.zhihu.com/question/.../answer/...</link>
  <pubDate>...</pubDate>
  <description>前 400 字的摘要…</description>   <- 只有这个
</item>
```

目标平台第 3 项需求是「站内直接阅读全文，不跳转」。用这条出口，
Miniflux 拿不到正文，只能靠自己的 Readability 去抓原站——
而原站正是知乎/小红书，**于是绕回了方案 §3.2 想避免的那个死循环**：

```text
适配器已经拿到内容 -> 出口只吐摘要 -> Miniflux 重新访问知乎原站
   -> 机房 IP 撞风控 -> 正文丢了
```

这正是方案给 Karakeep 挑出的毛病。**v1 提的第五条路会原样复现它。**

### 修正后的版本：先让适配器存正文，再加出口

这条路要成立，前提是把适配器从「只要摘要」改成「要正文」：

```js
// lib/adapters.private.js:56 现在
answers?limit=20&offset=0&include=data[*].excerpt,created_time,question

// 改成
answers?limit=20&offset=0&include=data[*].content,excerpt,created_time,question
```

代价是连锁的，不是改一行的事：

1. **缓存体积**：现在 5.7MB（7474 条 × 平均 184 字）。存正文按 10KB/条估算是
   **73MB**，涨 13 倍。`/api/state` 单次响应已约 4.9MB、蜂窝网络首屏偏慢
   （`docs/status-2026-09-16.md` 已记录这个问题），加正文会把它推到不可用。
   必须先把 `/api/state` 改成分页或按视图裁剪，且正文不进 state。
2. **数据模型**：要加 `content` 字段，`lib/feeds.js`、`lib/refresh.js`、
   `lib/store.js`、前端渲染都要动。
3. **发布物脱敏**：`cache.seed.json` 与 GitHub Pages 快照都基于缓存生成，
   正文进缓存意味着 `tools/make-seed.js` 的脱敏闸要处理 13 倍大的文本，
   且抓来的正文里埋本机痕迹的风险面同步放大（`make-seed.js` 注释里记着
   「实测有过：某条知乎回答正文含公司域名邮箱」）。
4. **图片**：正文里的知乎图片是外链，要么本地化要么接受失效。

**所以 v1 说的「50 行代码」严重低估了。**真实工作量是「给一个按摘要设计的产品
加全文存档能力」，这和方案 §6 要 Bridge 做的事情量级相当。

### v2 的建议：这条路只在一种情况下值得走

**如果最终决定保留 quiet-river 的时间轴 UI**（它现在的形态：按 tag 分组、
时间倒序、KaTeX、博主视图、来源分组），那么加 RSS 出口有价值——
让 quiet-river 继续当「看最新」的入口，Miniflux + Karakeep 当「读全文 + 划线」的入口，
两者并存。这本质上是方案里的「C 混合」路线，体验割裂但改造最小。

**如果新平台要取代 quiet-river 成为日常唯一入口**，那么加出口没有意义：
正文无论如何都要新建一条获取链路，而 RSSHub 在这条链路上已经现成
（知乎带 `content` + `processImage` 清洗，小红书带 `renderNotesFulltext`）。
这种情况下应该按方案的架构走，把我们的**清单与 tag 体系**迁过去，
而不是把抓取实现迁过去。

### 迁移时真正要保住的东西

不是适配器代码，是三个月人工筛选的结果：

```text
115 个知乎 url_token          <- ADR 0001-0007 从 905 人关注列表里筛出来的
13 个小红书 user id           <- ADR 0008 从 134 个搜索候选里筛出来的
16 个 tag 与 271 个源的归属    <- ADR 0007、0012 人工复核的结果
收录判据本身                  <- 「在做 vs 在说」、覆盖率对账方法
```

这些在 `data/subscriptions.json` 里，是可导出的结构化数据。
抓取实现（`adapters.private.js` 那 134 行）反而是最容易替换的部分——
而且如 P0-3 所示，它在正文这个关键维度上还不如 RSSHub。

**v1 的架构图保留在此仅作对照，它的前提（登录态资产更优）已被 §0 推翻：**

```text
quiet-river（保留）         Miniflux（新增）        Karakeep（新增）
  抓取层：271 个源              订阅 quiet-river        站内阅读
  含知乎登录态适配器    --->    的 RSS 出口      --->   划线与笔记
  含小红书浏览器会话            + 直接订博客/X/公众号
        |
        +--> 自己的河（时间轴 UI，保留）
```

其中仍然成立、且与全文问题无关的两条收益：

- **小红书不需要在 ECS 上跑 Puppeteer**：现有适配器驱动的是本机已登录浏览器
  （`opencli xiaohongshu login`），而 RSSHub 的小红书路由 `requirePuppeteer: true`，
  每个请求起一次浏览器。本项目在 B 站路由上实测过这个模式的代价
  （「连续添加多个源容易撞 503，隔几秒单独重抓」）。
- **we-mp-rss 可以先不部署**：49 个公众号继续走两个 wechat2rss 公开目录，
  we-mp-rss 的真实用例是 ADR 0011 遗留的那 17 个手记号，不是替换 66 个。
  省掉 66 次扫码授权与一个要长期维护的凭证。

## 六、结论与建议

### 方案可行性评级

v2 修正后的评级（v1 的两处评级已被 §0 推翻）：

| 维度 | 评级 | 说明 |
|---|---|---|
| 技术断言准确性 | **高** | 抽查的 12 条断言 12 条成立，含 3 条到源码行级 |
| 降级与故障建模 | **高** | 四态模型、四类故障分显、「更新失败不能显示为没有新文章」都对，且正好解我们 P0-4 的静默失效 |
| 安全边界 | **高** | SSRF、HTML 清洗、Basic Auth 与 Bearer 冲突、Docker 绕过 UFW 都识别到了 |
| 知乎通道选型 | **可行，但漏写凭证条件** | P0-1（v2 修正）：补 `d_c0` 即可保住 `z_c0`；且 RSSHub 返回**完整正文**，在这件事上优于我们现有的摘要实现。代价是回答条数 20→7 |
| 小红书通道选型 | **需改** | P1-1，Cookie 是必需不是可选，`guid` 用标题当 ID 要自己重建；`requirePuppeteer` 的资源代价没量化 |
| 迁移路径 | **缺失** | P0-2，271 个源没有去处。但真正要迁的是清单与 tag 体系，不是抓取实现 |
| 全文获取 | **严重低估** | P0-3，这是最大的新增工作量。我们全库 7474 条**无一条存正文**，README 明写「不做全文抓取」 |
| 高亮持久化 | **判断对但理由不足** | P1-2，字符偏移模型决定冻结不可妥协，代价（被批注的文章永久停更）要写进文档 |
| 大陆部署入口 | **需改** | P1-3，第一版走 IP + 非标端口，Caddy 自动 HTTPS 要显式关 |
| 硬件预算 | **偏乐观** | 4核8G 方向对，但小红书路由每请求起一次浏览器（13 源 = 13 次 Chromium 启动/轮），要和 Meilisearch、Postgres 抢内存 |
| 凭证运维 | **未覆盖** | P0-4，我们 128 个源已静默失效 5 天。方案的「来源状态可见」是对的，但缺**主动告警**——靠人打开页面才看得见 |

### 建议

**采纳方案的整体架构，但把优先级调过来。**

方案的顺序是「来源 -> 阅读批注 -> Bridge -> 日报」。按我们的实际现状应该是
「凭证健康 -> 全文获取实测 -> 清单迁移 -> 阅读批注 -> 排序与日报」。
理由：P0-4 说明我们连「来源是活的」现在都不成立，P0-3 说明全文这条链路从零开始，
这两件不解决，后面的排序与日报都是空中楼阁。

具体五步：

1. **先修凭证，再谈架构。**重贴知乎 cookie（这次要带 `d_c0`）、重跑
   `opencli xiaohongshu login`，把 146 个 error 降下来。同时做一个**凭证健康检查**：
   定时打单点端点（知乎 `/api/v4/me`、小红书 `whoami`），失败即告警。
   这件事独立于任何架构选型，现在就该做，而且新架构同样需要它。
2. **实测 RSSHub 的知乎与小红书路由**，用真实凭证、真实博主，验三件事：
   能不能拿到正文（P0-3 的关键）、机房 IP 上会不会撞风控（ADR 0013 的遗留疑问）、
   13 个小红书源的浏览器开销实测多少（决定硬件规格）。
   **这一步不通过，整个方案的采集层就要换设计。**
3. **迁移清单而不是迁移代码。**把 271 个源与 16 个 tag 从 `data/subscriptions.json`
   导成 Miniflux 能吃的形态。45 + 28 + 49 = 122 个源本来就是 URL，现成可导；
   128 个适配器源按第 2 步的结果决定走 RSSHub 还是保留适配器。
4. **阅读与批注照方案做**，但用两步式导入（`POST /assets` → `precrawledArchiveId`）
   而不是 singlefile 端点——后者不在 OpenAPI spec 里（P2-1），两步式的两步都有完整契约。
   重点验收 P1-2：改一次清洗规则，看已有高亮是否错位。
5. **排序与日报照方案做**，Bridge 的四模块设计不用改。
   评分公式的冷启动可以用我们已有的 tag 体系——16 个 tag、271 个源的归属
   就是现成的「兴趣匹配」标注数据，起点比方案说的「你明确填写的主题」高得多。

**we-mp-rss 单独评估**，只针对 ADR 0011 遗留的那 17 个手记公众号，
不作为 49 个现有转发源的替换。

**第五条路（保留 quiet-river 当抓取层）降级为备选**，只在
「决定保留现有时间轴 UI 作为并存入口」时才值得做，详见 §五。

### 还没解决、方案也没解决的

- **知乎/小红书在机房 IP 上的风控表现未知。**本项目所有实测数据都来自家庭宽带。
  ADR 0013 已经写明「登录态源在机房 IP 上更容易触发平台风控，所以它们不上服务器」。
  如果这条结论依然成立，那么**新平台上的知乎与小红书也只能是快照**，
  和现在的 ECS 部署形态一样。这一点必须在阶段 A 实测，
  不能假设「换了架构就能在机房跑登录态」。
  **而且现在连家庭宽带上的登录态都失效 5 天了**，机房上只会更难。
- **Karakeep v0.33.2 的实际 API 行为未核实**（GitHub API 中途限流）。
  `/bookmarks/singlefile` 已确认不在 OpenAPI spec 里，只能在锁定版本上实测。
- **8~9 个容器的长期运维成本没有量化**：备份、升级、迁移回退，
  方案 §13 写了原则但没写频率与耗时。
  对照本项目现在的形态（零依赖单文件 + 一个 JSON），这是量级变化。
- **全文存档的体积增长曲线没人估过。**P0-3 给的 73MB 是粗估
  （7474 条 × 10KB），但技术长文正文常远超 10KB，带图片的话方案自己估的是
  「每天 100 篇 × 1MB ≈ 3GB/月」。两个估算差一个量级，
  要在第 2 步实测出真实分布再定磁盘规格。
- **`/api/state` 已是 4.9MB 单响应**，加正文后彻底不可用。
  这是现有架构的技术债，新架构绕开了它（Miniflux 分页），
  但如果走第五条路就必须先还这笔债。
