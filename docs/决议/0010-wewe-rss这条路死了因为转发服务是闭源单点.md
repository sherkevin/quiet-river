# 0010 · wewe-rss 这条路死了，因为转发服务是闭源单点

状态：Accepted（2026-09-14 实测）

## 背景

公众号是所有平台里唯一没有读者侧登录态抓取通道的（见 [0009] 与 `docs/wechat.md`）。
quiet-river 因此对 18 个公众号只做「手动登记」：存名字、不抓内容。
用户问：能不能自建 wewe-rss 产出 RSS，再把 feed 地址补回清单？

`docs/wechat.md` 里原来写的是「wewe-rss 上游仓库已下架、公开渠道拿不到」。
这句在 2026-09-14 已经不准确：仓库能访问、源码能 clone、本地也已经部署起来了。
所以重新实测了一遍，结论比原文更糟，也更具体。

## 实测过程

部署本身是通的。源码 clone 到本机的 `wewe-rss/` 目录（v2.6.1，MIT；本机绝对路径
不外发，下同），三处修好后服务能起：

1. `pnpm-workspace.yaml`：pnpm 11 不再读 package.json 的 `pnpm` 字段，`allowBuilds` 占位符要改成 `true`
   （`@nestjs/core`、`@prisma/client`、`@prisma/engines`、`esbuild`、`prisma`），并加 `verifyDepsBeforeRun: false`。
2. `start.sh`：`DATABASE_URL` 要用绝对路径，prisma 把相对 sqlite 路径按 schema 目录解析。
3. `prisma migrate deploy` 报空 "Schema engine error"（引擎二进制问题，未查清）。
   绕过办法：直接建表 —— `sqlite3 data/wewe-rss.db < .../20240301104100_init/migration.sql`
   再 `< .../20241214172323_has_history/migration.sql`。

服务起来后 `/` 返回 200，`/feeds` 返回 `[]`，`/feeds/all.atom` 返回合法 Atom。
`/feeds/*` 路径**不需要鉴权**（`AUTH_CODE` 只管 `/trpc` 管理接口），
所以「quiet-river 能不能拉带鉴权的 feed」这个顾虑不存在，不用改 `lib/refresh.js`。

**卡在扫码登录这一步，而且是死路。** `platform.createLoginUrl` 返回：

```
{"error":{"message":"Request failed with status code 502","code":-32603,...}}
```

## 根因

wewe-rss 的架构里，**登录和抓取都不在自己代码里**。`apps/server/src/configuration.ts` 有：

```
const platformUrl = process.env.PLATFORM_URL || 'https://weread.111965.xyz';
```

wewe-rss 只调 `https://weread.111965.xyz` 的 4 个接口：
`/api/v2/login/platform`（出二维码）、`/api/v2/login/platform/:id`（等扫码结果）、
`/api/v2/platform/wxs2mp`（文章链接反查公众号）、`/api/v2/platform/mps/:mpId/articles`（拉文章）。
这个转发服务**闭源**，作者只开源了外壳。issue #11 里作者原话：「token 是从这个服务生成的，只做请求转发。」

**转发服务已经死了，而且死因是基础设施层面的，不是墙：**

- `weread.111965.xyz` 挂在 Cloudflare 后面，4 个不同 edge IP（`104.21.47.228`、`172.67.173.210`、
  `172.64.80.1`、`104.18.32.7`）全部返回 `error code: 502` —— 源站挂了，不是 DNS 污染。
  issue #223 教人「绑 hosts 到 172.64.80.1」和「换镜像域名」，两条都试过，都 502。
- 镜像域名 `weread.965111.xyz` 返回 `DEPLOYMENT_NOT_FOUND`，正文写明：
  **「Deno Deploy Classic was sunset on July 20, 2026」**。转发服务是跑在 Deno Deploy Classic 上的，
  2026-07-20 平台整体下线，它就一起没了。这是不可逆的。
- 微信读书官方 API **不能**替代：`https://weread.qq.com/api/v2/login/platform` 返回 404，
  `/web/login/getqrcode` 也 404 —— 这些路径只存在于作者的转发服务上，不是微信读书的真实接口。
- 微信读书确实有官方 Agent API（`POST https://i.weread.qq.com/api/agent/gateway`，Bearer `wrk-` key，
  经 `GET /api/skills/apikeyGet` 获取）。实测端点是活的（无 token 返回 `errcode -2010 用户不存在`，
  假 token 返回 `-2013 鉴权失败`）。但它只有 18 个接口，全是书/笔记/划线/书评/书架维度，
  **没有任何公众号（mp）相关能力**，替代不了。

上游 `cooderl/wewe-rss` 2026-03-20 归档，作者不再维护。
issue #463（2026-03-24，「还有更新吗？好像都失效了」）至今 open，
评论里已经有人说「作者都把微信图删了跑路了」。fork 全部沿用同一个 `PLATFORM_URL` 默认值，
`johamwon/we2rss`（19★）也只是加了账号失效告警，没有绕开转发服务。
**没有任何一个 fork 修得了这个问题**，因为要修就得重写那个闭源转发服务，而它依赖的
微信读书登录签名逻辑没有公开实现。

## 决议

wewe-rss 这条路**不再尝试**。不部署、不扫码、不保留服务。
`docs/wechat.md` 里「建议先试 wewe-rss」的推荐**作废**，改写成本决议的结论。

理由不是「上游归档」这种间接信号，而是「它的全部抓取能力都托管在一个已经物理消失的闭源单点上」。
这类方案即使作者复活转发服务，可用性也完全取决于对方是否继续免费营业，
把订阅建在它上面等于把基础设施外包给陌生人。

## 实际采用的替代路线

`wechat2rss.xlab.app` 的**免费公开目录**。它从 2021.9 运行至今，收录 395 个公众号，
直接给标准 RSS 地址，无需登录、无需部署、无需付费。

代价是覆盖率：目录以安全类为主，我们 18 个公众号里只命中 1 个（机器之心）。
但目录里有大厂研发号，正好补上用户最关心的「大公司技术公众号」：

本轮实际入库 9 个公众号（全部实测 HTTP 200 + 20 篇文章 + 发布日期在两周内）：
机器之心、得物技术（补空 feed）、字节跳动技术团队、阿里技术、千问AI平台（原名「阿里云开发者」，
账号已改名，按 feed 自报名字入库）、哔哩哔哩技术、小米技术、爱奇艺技术产品团队、夕小瑶科技说。
`机器学习初学者` 和 `Android 开发者` 查过但没收：前者最新文章停在 2025-08，已死；
后者内容与我们兴趣域不搭。

覆盖率 1/18 说明这条路**不能替代** wechat2rss 私有部署，只是零成本的补充。
剩下 17 个公众号里 12 个是个人学习笔记号（如「秋枫学习笔记」「阿尘学习笔记」），
公开目录不可能收，要么继续手动登记，要么将来接受 150 元/年 的私有部署
（其采集端是自己扫码 + 闭源不可审计，信任成本见 `docs/wechat.md`）。

**顺手纠正一处旧结论**：`docs/wechat.md`（2026-09-11）写过「wechat2rss 的代码读不到，
GitHub API 与 raw 两个通道都返回 404」。前半句错，后半句是真：
GitHub API 正常返回文件树，raw 也通 —— 404 是因为默认分支上的文件名是 `readme.md`（全小写），
而当时按 `README.md` 去取，raw.githubusercontent 对大小写敏感。
但**实质结论不变**：仓库里只有 VitePress 站点文档（`deploy/*.md`、`list/*.md`）、
一个 `public/scripts/cf-worker.js` 和 `docker-compose.yml`，**采集端实现不在其中**，
license 字段为空。所以「私有部署闭源不可审计」这句仍然成立，只是理由要改成
「仓库可读但只放文档和站点，采集端未开源」，而不是「仓库读不到」。

## 后果

- `lib/resolve.js` 加了一条平台识别：`host.endsWith('wechat2rss.xlab.app')` → `wechat`。
  否则这些源会被误判成 `blog`。
- `server.js` 的 PATCH 分支补了两处：拿到可用 feed 后 `delete sub.manual`
  （否则 UI 还显示「手动登记，去微信里搜」），并按 `resolve` 结果重算 `platform`/`platformLabel`
  （和 POST 行为对齐）。
- 公众号从 18 个变成 26 个，其中 9 个有内容、17 个仍是手动登记空壳。
- 时延预期要校准：wechat2rss 官方自述更新周期在 24 小时内，
  所以公众号卡片的新鲜度圆点会经常是灰的，这是正常的，不是抓取坏了。
- 本机那份 `wewe-rss/` 源码保留当参考，LaunchAgent 已卸载
  （plist 改名 `.disabled` 留在仓库里，需要时可恢复）。
- 下次再有人提「自建 wewe-rss」，先读本文件，别重复部署一遍。
