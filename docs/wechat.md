# 微信公众号接入方案

> **2026-09-14 更新（结论翻转，先读这段）**：wewe-rss 这条路已经**死了**，不要再试。
> 它的全部登录与抓取能力都托管在作者的闭源转发服务 `weread.111965.xyz` 上，
> 而那个服务跑在 Deno Deploy Classic，平台已于 **2026-07-20 整体下线**，4 个 Cloudflare edge 全返回 502，
> 官方镜像域名 `weread.965111.xyz` 返回 `DEPLOYMENT_NOT_FOUND`。
> 部署本身能成（服务能起、`/feeds/all.atom` 能出合法 Atom），但扫码登录必然失败，
> 而没有任何 fork 修得了——要修就得重写那个闭源转发服务。完整实测记录见
> 完整实测记录在本仓 `docs/决议/0010`（决议目录不随开源版发布，因为它记的是本机阅读清单的取舍理由）。
>
> 现在实际在用的是 **wechat2rss 免费公开目录**：`https://wechat2rss.xlab.app/list/all/`，
> 395 个公众号，直接给标准 RSS 地址，无需登录、无需部署、无需付费。
> （**同一天又发现第二个实例** `https://wechat2rss.bestblogs.dev/`，375 个号，取向不同，
> 两边并集约 748 个；详见下面「wechat2rss 免费公开目录」一节的补记。）
> 覆盖率低（我们 18 个只命中 1 个，目录以安全类为主），但里面有大厂研发号，
> 2026-09-14 用它把公众号从 18 个做到 26 个、其中 9 个有内容。
> 下面原文保留作历史记录，**其中「建议先试 wewe-rss」的推荐作废**。

**两条外部服务路线（2026-09-11 调研）**：wechat2rss 私有部署（150 元/年，闭源）；wewe-rss 自部署（免费，开源可审计，但上游已归档 —— 已于 2026-09-14 实测证死，见上方更新）。
理由：公众号是所有平台里唯一**没有读者侧登录态抓取通道**的——知乎和小红书好歹有 Web 登录态可借，公众号的登录态只在微信客户端和微信读书里。RSSHub 自带公众号路由覆盖率低且验证码重灾，不当主路。

**源码可见性（2026-09-11 实测，2026-09-14 修正）**：wechat2rss 的公开仓库 `ttttmr/Wechat2RSS`（1588★）当初记为「代码读不到」，**这半句是错的**：GitHub API 正常返回文件树，raw 也通，404 只因默认分支上文件名是 `readme.md`（全小写）而当时按 `README.md` 取，raw.githubusercontent 大小写敏感。但**实质结论不变**：仓库里只有 VitePress 站点文档（`deploy/*.md`、`list/*.md`）、一个 `public/scripts/cf-worker.js` 和 `docker-compose.yml`，**采集端实现不在其中**，license 字段为空。对照之下 wewe-rss（`cooderl/wewe-rss`，9675★，MIT，2026-03-20 归档）源码完全公开可读，根目录含 apps/、Dockerfile、LICENSE、pnpm workspace，原理可审计。
这意味着 wechat2rss 私有部署的真实成本不只是 150 元：采集端是**你自己的微信扫码登录**，而实现未开源不可审计——等于把微信登录态交给一个无法审计的服务。当初据此把顺序反转成「先试开源的 wewe-rss」；2026-09-14 实测证明 wewe-rss 已死，**这个反转不成立了**：免费路线只有 wechat2rss 公开目录（覆盖率低），要全覆盖就只能接受 wechat2rss 私有部署的上述信任成本。

**zlzchat 评估（2026-09-11，不采用为底座）**：`565800105/zlzchat`（284★，2026-09-07 推送）根目录只有 README、images、lib 和一个编译好的 `website.jar`——**闭源 JAR，没有源码**，license 字段为空（法律上未授权修改）。部署要 mysql + redis + jar 三件套，文档挂在裸 IP `111.229.83.152:805` 上（单点个人基础设施）。机制与 wewe-rss 同族：靠**微信读书登录态**拉文章，其用户协议自述「使用本工具可能导致微信读书账号（非微信号）被限制或封禁」。比 wewe-rss 多的是按名称/文章地址添加公众号的 API 与分类 atom 输出；这些能力可以在自己的 fork 里用微信读书搜索接口补，不构成换底座的理由。
**2026-09-14 补记**：zlzchat 与 wewe-rss 同样依赖微信读书登录态。wewe-rss 死于闭源转发服务消失，zlzchat 的同类风险更高——它的「转发服务」是一个裸 IP 上的个人实例。这条路同样不再考虑。

**quiet-river 自己的做法（2026-09-11 定）：不直接爬微信**，做**手动登记**——添加页选「微信公众号（手动登记）」，只填公众号名字；该源有自己的专属页（`#/author/<id>`），内容为空，卡片与专属页都提示「去微信里搜这个名字」；以后拿到 RSS 地址（无论来自 wewe-rss、wechat2rss 还是别处）在编辑弹窗的 feed 地址栏补上即开始抓取。已实现并实测。
wewe-rss 上游仓库**仍可访问**（2026-03-20 归档但没下架，源码要自己 clone 一份留着）。归档 ≠ 下架，别再把「拿不到源码」当结论——真正的问题是它的转发服务没了，详见本仓 `docs/决议/0010`。稳定化清单（低频 cron、专用读书号、失败退避、只在本地跑、不发布）适用于任何登录态抓取方案。

## wechat2rss 私有部署（付费 150 元/年，闭源不可审计）

1. 购买私有部署授权（150 元/年），拿到部署包与许可。官方自述：单微信号支撑 400+ 公众号、平均 6 小时时延、不限订阅数量、支持任意公众号。
2. 按官方文档起服务（Docker），用**你自己的一个微信号**扫码登录作为采集端。
3. 在 wechat2rss 里订阅目标公众号，拿到每个号的 RSS URL。
4. 把 RSS URL 写成文本文件（每行 `名字<TAB>url<TAB>tag`）或导出 OPML，跑：
   `node tools/import-feeds.js feeds.txt --tags 生成式推荐`
   一次性灌进 quiet-river；重复的自动跳过，失败的逐行报错不中断。

**合规边界**：授权写明「仅允许个人学习和研究使用，禁止商用和内容分发」。自己读没问题；quiet-river **不内置它、不当默认组件推荐**，只把它写成「你自购自建的外部服务」，产出 RSS 后用 `tools/import-feeds.js` 导入。

**预期校准**：平均 6 小时时延意味着公众号卡片的新鲜度圆点会经常是灰的、内容比别的源晚半天到一天，属正常，不是抓取坏了。

## wechat2rss 免费公开目录（2026-09-14 起实际在用）

目录地址 `https://wechat2rss.xlab.app/list/all/`，收录 395 个公众号，每个直接给标准 RSS 地址
（形如 `https://wechat2rss.xlab.app/feed/<sha1>.xml`）。无需登录、无需部署、无需付费，`curl` 就能拿。
项目从 2021.9 运行至今，自述更新周期在 24 小时内，所以卡片新鲜度圆点经常是灰的，属正常。

**2026-09-14 补：不止一个实例，覆盖率被低估了。** 同一天发现 BestBlogs 也自建了一个
`https://wechat2rss.bestblogs.dev/`，跑的是同一套代码（它的 feed 自述里就写着
`wechat feed made by @ttttmr https://wechat2rss.xlab.app`），收录 375 个公众号，
取向完全不同：xlab.app 以安全类为主，bestblogs 这个以 AI、大厂研发、商业科技为主。
两个实例的 **feed hash 零重叠**（同一个号在两边是不同 URL，hash 不通用），
而公众号**名字只重叠 23 个**，所以**并集约 748 个**，不是 395 个。
注意 bestblogs 那个实例**没有目录页**（`/list/all/` 返回 404），只能按 feed 地址直连，
地址要从它公开的 OPML 里取（上游 `ginobefun/BestBlogs` 仓库根目录，该仓库无 license，
我们只在本机留副本、不随本项目发布）。

用法：在目录页里搜公众号名字，拿到 feed 地址，然后

```bash
# 单个：走 API，resolve 会自己认出平台是公众号并把标题当名字
curl -X PATCH http://127.0.0.1:4321/api/subscriptions/<id> \
  -H 'Content-Type: application/json' \
  -d '{"feedUrl":"https://wechat2rss.xlab.app/feed/<sha1>.xml"}'

# 批量：名字<TAB>地址<TAB>tag
node tools/import-feeds.js feeds.txt --tags 搜广推
```

覆盖率是它的短板：目录以安全类为主，我们 18 个公众号只命中 1 个（机器之心）。
但里面有**大厂研发号**，正好补上「大公司技术公众号」这一块——2026-09-14 据此入库 9 个：
机器之心、得物技术、字节跳动技术团队、阿里技术、千问AI平台（原「阿里云开发者」，账号已改名）、
哔哩哔哩技术、小米技术、爱奇艺技术产品团队、夕小瑶科技说。
每个都实测过 HTTP 200 + 20 篇文章 + 发布日期在两周内。
查过但没收的两个：`机器学习初学者`（最新文章停在 2025-08，已死）、
`Android 开发者`（内容与兴趣域不搭）。

公众号名字改了要按 feed 自报的标题入库，别用目录页上的旧名——`resolve` 已经这么做，
`lib/resolve.js` 里也加了 `host.endsWith('wechat2rss.xlab.app') → wechat` 的识别，
否则这些源会被误判成 `blog`。

## wewe-rss 自部署（2026-09-14 实测证死，不要再试）

原理：扫码登录微信读书，借微信读书的公众号通道拉文章，输出 atom/rss/json；MIT 协议。

**死因不是「上游归档」，而是「抓取能力全在一个已经物理消失的闭源单点上」。**
wewe-rss 自己不碰微信读书，`apps/server/src/configuration.ts` 里写死
`PLATFORM_URL = https://weread.111965.xyz`，只调它的 4 个接口：
`/api/v2/login/platform`（出二维码）、`/api/v2/login/platform/:id`（等扫码）、
`/api/v2/platform/wxs2mp`（文章链接反查号）、`/api/v2/platform/mps/:mpId/articles`（拉文章）。
这个转发服务**闭源**，作者只开源了外壳（issue #11 原话：「token 是从这个服务生成的，只做请求转发」）。
而它跑在 Deno Deploy Classic 上，该平台 **2026-07-20 整体下线**：

- 4 个 Cloudflare edge（`104.21.47.228`、`172.67.173.210`、`172.64.80.1`、`104.18.32.7`）全部 `error code: 502`，
  说明源站没了，不是 DNS 污染；issue #223 教的「绑 hosts」和「换镜像域名」两条都试过，都 502。
- 镜像域名 `weread.965111.xyz` 返回 `DEPLOYMENT_NOT_FOUND`，正文明写
  「Deno Deploy Classic was sunset on July 20, 2026」。这是不可逆的。
- 微信读书官方 API 替代不了：`weread.qq.com/api/v2/login/platform` 和 `/web/login/getqrcode` 都是 404，
  这些路径只存在于作者的转发服务上。
- 微信读书**确有**官方 Agent API（`POST https://i.weread.qq.com/api/agent/gateway`，Bearer `wrk-` key，
  经 `GET /api/skills/apikeyGet` 获取），实测端点是活的（无 token 返回 `errcode -2010`，假 token 返回 `-2013`）。
  但只有 18 个接口，全是书/笔记/划线/书评/书架维度，**没有任何公众号能力**。

所有 fork 沿用同一个 `PLATFORM_URL` 默认值，没有一个绕开转发服务
（`johamwon/we2rss`，19★，只加了账号失效告警）。上游 issue #463（2026-03-24「好像都失效了」）至今 open。

**部署过程留档**（万一将来转发服务复活，按 v2.6.1 源码记）：
三处要修才能起来——① `pnpm-workspace.yaml`：pnpm 11 不再读 package.json 的 `pnpm` 字段，
`allowBuilds` 占位符要改成 `true`（`@nestjs/core`、`@prisma/client`、`@prisma/engines`、`esbuild`、`prisma`），
并加 `verifyDepsBeforeRun: false`；② `start.sh`：`DATABASE_URL` 用绝对路径，prisma 把相对 sqlite 路径按 schema 目录解析；
③ `prisma migrate deploy` 报空 "Schema engine error"（引擎二进制问题，未查清），绕过办法是直接建表：
`sqlite3 data/wewe-rss.db < .../20240301104100_init/migration.sql` 再 `< .../20241214172323_has_history/migration.sql`。
起来之后 `/` 200、`/feeds` 返回 `[]`、`/feeds/all.atom` 出合法 Atom。
另外**`/feeds/*` 不需要鉴权**（`AUTH_CODE` 只管 `/trpc`），
所以「quiet-river 能不能拉带鉴权的 feed」这个顾虑不存在，`lib/refresh.js` 不用改。
卡死在最后一步：`platform.createLoginUrl` → `Request failed with status code 502`。

## 不推荐的四条路

- **RSSHub 搜狗路由**：验证码重灾区，2026-04 仍有「同一文章重复抓取」的 open issue。
- **RSSHub `/mp/homepage/:biz/:hid`**：只覆盖开了主页模板的号，覆盖率低。
- **feeddd 来源**：上游仓库 2023-07 停更，死路。
- **data258 / cimidata 等第三方付费镜像**：活着，但可用性完全取决于对方营业状态，等于把订阅托管给别人。

## quiet-river 已支持的部分

- 添加页「微信公众号」表单：贴外部 RSS 地址即可，服务端当场验证能不能抓到。
- `tools/import-feeds.js`：OPML 或 `名字<TAB>url<TAB>tag` 文本批量导入；重复自动跳过（409），失败逐行报错不中断；`--base` 可指到别的实例。

## 一个已知限制

公众号名字**无法从文章链接可靠反查**（WebFetch 撞环境异常墙，biz 也不一定出现在 /s/ 链接里）。添加时你得知道号的名字或拿到它的主页/名片链接，不能贴一篇文章链接指望系统认出来。
