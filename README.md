# quiet river

把你在各平台关注的博主汇成一条**按 tag 分组、按时间倒序**的内容河。

没有推荐算法，没有「猜你喜欢」，没有信息流广告。你关注谁，就看到谁；点了某个 tag，就只看那一类；什么都不点，就是全部混排。

```
git clone https://github.com/sherkevin/quiet-river && cd quiet-river
node server.js            # 零依赖，不需要 npm install
open http://127.0.0.1:4321
```

需要 Node.js ≥ 20（用到内置 `fetch` 与 `node:test`）。没有运行时依赖，没有构建步骤。

**clone 下来就是满的。** 仓库里带一份订阅清单（`data/subscriptions.json`，271 个源）和一份缓存快照（`data/cache.seed.json`，每源最近 20 条）：第一次启动不用等抓取，页面立刻有内容。能匿名抓的源（博客、GitHub、arXiv、CSDN、公众号与 X 的转发地址等）会在第一次自动刷新后换成实时内容；需要登录态的源（知乎、小红书）在你没有凭证的机器上停在快照时刻——它们是「读档」，不是「活的」。想清空重来：删掉 `data/` 下两个 json，或点页面上的删除逐个清。

**在新机器上对齐到「全部活源」的配置清单见 [`docs/deploy-parity.md`](docs/deploy-parity.md)**：要拷哪个适配器文件、知乎 cookie 怎么取怎么放、小红书为什么不走 cookie、B站 RSSHub 怎么起。

## 它解决什么问题

你关注的博主散在知乎、B站、YouTube、GitHub、公众号、个人博客、Newsletter 上。每个平台都想用推荐算法决定你下一条看什么，而你想看的是**你选的人按时间顺序发了什么**。这个工具把「平台决定你看什么」换回「你自己决定关注谁」。

## 添加一个博主

在页面上点「添加博主」，贴主页链接，点「识别」。它会当场识别平台、找到 feed、**实际抓一次验证**，然后告诉你结果。能用的直接加，不能用的会直说原因，不会假装成功。

平台分三档，识别结果里会标明：

| 档 | 含义 | 例子 |
|---|---|---|
| 1 | 平台有原生 feed，或站点带标准 autodiscovery，或有免凭证匿名接口，开箱即用 | YouTube、GitHub、Substack、Medium、Reddit、Mastodon、Bluesky、arXiv、CSDN、掘金、少数派、即刻、HN、Semantic Scholar、绝大多数博客 |
| 2 | 平台没有公开 feed，需要你自己跑一个 RSSHub 实例 | B站 |
| 3 | 平台需要登录态凭证，或根本没有可抓的出口 | 知乎、小红书（本仓库不提供适配器，见下）；微信公众号（手动登记，或走 wechat2rss 目录）；X/Twitter（走 api.xgo.ing 转发）；微博（无路可走） |

第 3 档不等于「抓不到」。它的意思是平台本身没有给匿名读者出口，能抓到的都是别人代为转发出来的：公众号有两个 wechat2rss 公开目录，X 有 api.xgo.ing。**转发地址贴进来就能抓，本项目认这些域名**，会把它们归回原平台（「微信公众号」「X / Twitter」）而不是「博客」。代价是同一条命脉在别人手里——转发服务下线，这些源跟着断（WeWe RSS 就是这么死的，见下）。

第 2 档在「设置」里填 `rsshubBase`（比如 `http://127.0.0.1:1200`）后生效。**公共实例不要指望**：2026-09-10 实测 8 个社区镜像 0 个可用（2 个 503、2 个被域名拦截、4 个连不通），唯一返回 RSSHub 错误页的那个还暴露了它没装 Playwright chromium——B站视频路由在匿名被风控时正是要靠 chromium 回退。自托管是唯一选项。

自托管有两条路，**RSSHub 本身是 Node 项目，不一定要 Docker**：官方 compose 是 rsshub + redis + browserless/chrome 三容器；也可以直接 `git clone` 后 `pnpm install && pnpm build && pnpm start`。2026-09-11 走 Node 直跑这条路踩到四个坑，记下来省得再撞：

1. RSSHub 声明 `engines: ^22.22.2 || ^24.15.0`，更新的 Node 会让 pnpm 直接拒装。在它的 `.npmrc` 里加 `engine-strict=false`，顺带加 `verify-deps-before-run=false`，否则每次 `pnpm run` 都会重新触发一次失败的装包。
2. **pnpm 10 起不再读 `package.json` 的 `pnpm` 字段**，RSSHub 的 13 条 `overrides` 和 3 个 `patchedDependencies` 会静默失效，装出来的是「非官方期望状态」。把那三块照抄进 `pnpm-workspace.yaml` 再装才对，验证方式是看 `node_modules/.pnpm` 下的目录名有没有 `_patch_hash=`。
3. `pnpm start` 需要 `dist/`，所以先 `pnpm build`。
4. **B站路由（视频与专栏都一样）现在强制走浏览器，chromium 是硬依赖而不是风控时的回退**，缺了直接 503。它要的版本跨境下载可能极慢，出路是设 `CHROMIUM_EXECUTABLE_PATH` 指向本机已有的 Chrome/Chromium：

```bash
CHROMIUM_EXECUTABLE_PATH="/path/to/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
HOST=127.0.0.1 PORT=1200 pnpm start
```

版本号与 RSSHub 声明的 revision 不完全一致也能跑通。每个 B站请求都会起一次浏览器，连续添加多个源容易撞 503，隔几秒单独重抓即可。

**第 3 档的登录态适配器，本仓库不提供**——把某个平台的反爬绕过写成公开代码，等于发布一个绕过工具集，那有 ToS 与下架风险，也不是这个项目想成为的东西。知乎对匿名请求全程拦截（`zse-ck` JS 挑战、`x-zse-96` 签名、40362 风控），小红书没有公开 feed；微博匿名 432。X 的官方 API 收费、Nitter 公共实例在 2026-08-24 收到停止函后系统性死亡，所以贴 `x.com` 主页抓不到——但 `api.xgo.ing` 仍在提供免费转发（见下）。要在自己的机器上补，有一个插件位：

```js
// lib/adapters.private.js —— 这个路径已被 .gitignore 排除，存在即自动挂载
module.exports = [
  {
    platform: 'example',
    label: '某平台',
    tier: 3,
    match(url) { const m = /example\.com\/u\/([\w-]+)/.exec(url); return m ? { id: m[1] } : null; },
    async fetchItems(id) {
      // 你自己的登录态取数；凭证放 secrets/ 或环境变量，用 lib/secrets.js 的 readSecret 读
      return { name: '某人', items: [{ guid, title, link, author, published, summary, image, categories }] };
    },
  },
];
```

条目形状与 feed 解析器一致，`published` 是毫秒时间戳——**拿不到发布时间的平台不要写适配器**，没有时间就进不了时间倒序的河。挂载后添加页会自动多出这张来源卡（服务端 `/api/state` 的 `capabilities.adapterPlatforms` 驱动），没挂载时不显示，也就不会出现「点了才报错」。抓取失败读 403 直接停手不重试，连续失败 3 次自动刷新会跳过它，免得对着一个正在限流你的源反复敲门。

**完整配置指南见 [`docs/private-adapters.md`](docs/private-adapters.md)**：文件放哪、怎么写、凭证怎么存、登录态怎么从浏览器取（含「403 不等于 cookie 失效」的判别法）、写完怎么验证挂载成功。

公众号**本项目自己不抓**，但有外部目录能补上一部分。默认做法是手动登记：添加页选「微信公众号（手动登记）」，只填名字，这个号有自己的专属页，内容为空，卡片与专属页都提示去微信里搜这个名字读。以后从任何渠道拿到 RSS 地址，在编辑弹窗的 feed 栏补上即开始抓取——补上之后 `manual` 标记会自动摘掉，归类也会跟着 feed 地址重算。

免费外部渠道现在有**两个 wechat2rss 公开目录实例**，都是免登录、免部署、免付费，每个号直接给标准 RSS 地址，贴回来就能抓（`lib/resolve.js` 认这两个域名，会正确归到「微信公众号」而不是「博客」）：

| 目录 | 收录 | 特点 |
|---|---|---|
| [wechat2rss.xlab.app/list/all/](https://wechat2rss.xlab.app/list/all/) | 395 个号 | 每源返回 20 条 |
| [BestBlogs 的 OPML](https://github.com/ginobefun/BestBlogs/blob/main/opml/bestblogs_wechat2rss_opml_all.opml)（`wechat2rss.bestblogs.dev`） | 375 个号 | 每源返回 10 条；**大厂技术号基本只在这里**：快手技术、大淘宝技术、小红书技术REDtech、百度Geek说、蚂蚁技术、京东技术、腾讯技术工程、滴滴技术、vivo互联网技术 |

两个目录**只重叠 23 个名字**，是互补关系不是替代关系——只查一个会漏掉一半。都不收录的号只能手动登记，或自行部署付费服务。

### X / Twitter：api.xgo.ing 转发

X 官方 API 收费，Nitter 公共实例在 2026-08-24 收到停止函后系统性死亡，所以**贴 `x.com` 主页抓不到**。但 `api.xgo.ing` 仍提供免费的 X→RSS 转发，2026-09-14 实测 22/22 个账号可用，每源 50 条，`pubDate` 完整。地址形如：

```
https://api.xgo.ing/rss/user/<32位哈希>
```

哈希**不可由 handle 推导**（试过 md5 与大小写变体，都不是），只能从现成目录里取——[BestBlogs 的 Twitters OPML](https://github.com/ginobefun/BestBlogs/blob/main/opml/BestBlogs_RSS_Twitters.opml) 收录 160 个账号。把地址贴进「X / Twitter」来源卡即可：源名自动取频道标题里的 `显示名（X @handle）`，主页链接存 `x.com/<handle>`（卡片上的「去主页」跳作者，不跳转发服务）。

**这条路的寿命取决于服务方**，和 WeWe RSS 当初一样是闭源单点。`lib/refresh.js` 因此给它单独设了温和的请求间隔与半小时重抓周期：一轮刷新里几十个源连续砸同一个第三方不礼貌，也没必要——推文不按分钟变，转发服务自己也带缓存。手动「刷新」同样尊重这个周期（和知乎那条规则一致）。

**WeWe RSS 已于 2026-07 失效，别再照旧教程部署**：它的登录与抓取全部托管在闭源转发服务上，那个服务随 Deno Deploy Classic 平台下线一起消失了，部署能起但扫码登录必然失败，且没有 fork 修得了。方案对比与完整实测记录见 `docs/wechat.md`。

## 配置

只有一个文件：`data/subscriptions.json`。小、可手改、可 diff。

```json
{
  "version": 1,
  "settings": { "rsshubBase": "", "refreshMinutes": 60 },
  "subscriptions": [
    {
      "id": "a1b2c3d4e5f6",
      "name": "Recsys Frontier（九老师）",
      "url": "https://blog.recsys-frontier.com/",
      "platform": "blog",
      "platformLabel": "博客",
      "tier": 1,
      "tags": ["生成式推荐", "日报周报"],
      "feeds": ["https://blog.recsys-frontier.com/feed"],
      "addedAt": "2026-09-10T14:00:00.000Z"
    }
  ]
}
```

抓取结果缓存在 `data/cache.json`，已 gitignore——它可再生，而且是你自己的阅读内容。随仓库发布的是它的裁剪快照 `data/cache.seed.json`（每源 20 条、摘要截断、过脱敏闸），只在本机还没有 `cache.json` 时垫底用，第一次保存缓存后就不再读它。

**这个仓库默认发布作者的阅读清单**：清单本身就是产品的一部分，「clone 即我的河」是设计目标。如果你 fork 出去不想带自己的清单，`.gitignore` 里留了一行注释，取消注释即可把 `subscriptions.json` 排除；快照同理，删掉 `data/cache.seed.json` 或直接用你本机 `cache.json` 的裁剪版覆盖它（每源留最近 20 条、摘要截到 400 字，并确认正文里没有凭证与本机路径——抓来的正文里真的可能埋着这些）。

想一次性导入一批 starter 源（演示用，也是各档识别路径的活例子）：

```
node seed.js
```

## 网络与代理

抓取走 Node 内置 `fetch`。如果你的网络需要代理才能访问 YouTube、Reddit、Medium 这类站点：

```
NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 node server.js
```

`NODE_USE_ENV_PROXY=1` 是 Node 24+ 让内置 fetch 读取代理环境变量的开关。不加这个变量，内置 fetch 会无视 `HTTPS_PROXY`。

## 在别的设备上看这条河

服务默认只听 `127.0.0.1`，所以手机在同一个 Wi-Fi 下也打不开。三种走法，按你想要的「活」的程度选：

**同一局域网：把监听地址放开。** 服务跑在 `HOST=0.0.0.0 node server.js`，手机访问 `http://<这台机器的局域网 IP>:4321`。注意这等于把河对局域网里所有设备开放，它没有账号体系，谁打开都能看、都能改（添加、删除、打 tag 都是写操作）。家里 Wi-Fi 可以接受，公共网络不要这么跑。

**不在同一局域网：内网穿透。** 服务保持只听回环，用一条隧道把端口递出去，例如 `ssh -R 80:127.0.0.1:4321 你的公网机` 或 tailscale / frp。好处是河仍然是活的（能刷新、能添加），且只有拿到隧道地址的人能进；坏处是要有一台能常驻的机器或一个隧道账号。

**公网：部署到一台自己的服务器。** 想要手机在任何网络下都打开同一条活的河，最稳的是把服务本身放到一台有公网 IP 的机器上（本项目实测阿里云 ECS 2C2G 足够）。一条命令完成：

```
QR_ECS_INSTANCE=i-xxxx tools/deploy-ecs.sh --provision   # 首次：装 Node、建专用用户、systemd unit、生成口令
QR_ECS_INSTANCE=i-xxxx tools/deploy-ecs.sh               # 之后：只更新代码并重启
```

脚本走阿里云 workbench CLI（免 SSH 密钥直连 ECS：`curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh | bash -s -- -d ~/.local/bin`，再 `workbench config` 填 AccessKey，AK 只落在 `~/.workbench/config.json`，0600）。它只带公开件——私有适配器、`secrets/`、全量缓存一律留在原机，与 `tools/publish.sh` 同一套白名单思路。

部署后的形态与边界：

- 服务以专用用户 `qr` 跑，`systemd` 托管（开机自启、崩溃拉起），监听 80 端口靠 `CAP_NET_BIND_SERVICE` 而不是 root。
- **公网暴露前必须有访问口令**（`lib/access.js`）：这个应用没有账号体系，谁连上都能改。口令在远端 `/etc/quiet-river/env`（0600），浏览器打开首页输入一次存成一年期 cookie；`?token=` 方式也保留，用完即 302 掉。
- 抓取出口变成服务器的 IP。需要登录态的源（知乎、小红书）在服务器上**没有**凭证与私有适配器，它们停在随包带去的快照时刻并进问题栏，旧内容保留（`mergeIntoCache` 的既有行为）；匿名源全部是活的。要全活，把 `docs/deploy-parity.md` 的三步在服务器上补一遍——但先想清楚：机房 IP 段更容易触发平台风控。
- 安全组/防火墙要真的放通你用的端口。阿里云 ECS 默认安全组常常只开 22/3389；端口没放通时，从带透明代理的网络看是「握手成功但响应为空」，从干净网络看是超时，都极易误判成服务没起。验证连通性要用干净出口（例如在 ECS 上 curl 自己的公网 IP），本机办公网的 200 可能是代理代答的假象。
- 大陆地域的 ECS 用 80/443 对外提供网页服务需要 ICP 备案。未备案时公网直连 80 的实测表现是**超时丢包**（手机 `ERR_TIMED_OUT`），不是可见的拦截页；而办公网代理出口却能拿到 200，两种观测互相矛盾。反过来办公网代理又不放非标准端口。所以脚本默认**同时监听 80 与 4321**（`PORT` 支持逗号列表，`QR_ECS_PORT` 可改）：每种网络各取能通的那个，某个端口被拦只影响那条路径。
- 还有一层兜底：在 ECS 上跑 cloudflared 隧道（`systemd` unit 名 `qr-tunnel`，把 127.0.0.1:4321 递到 `*.trycloudflare.com` 的 HTTPS 地址）。它走 Cloudflare 边缘的 443，不碰备案问题，任何网络都能开；代价是 quick tunnel 的地址在服务重启后会变。直连 IP 与隧道地址二选一，或都留着。

**GitHub Pages：两种形态，共用一套前端。** Pages 只托管静态文件，跑不了 `node server.js`，也拿不到你的登录态，所以网页与数据必须分家。分家有两条路：

*活中继（当前线上形态）：网页在 Pages，数据实时回源。* 浏览器打开 Pages 链接后，`app.js` 看到注入的 `window.QR_LIVE_BASE`，就把所有 `/api/*` 请求发往中继 origin，口令放请求头 `x-qr-token`（跨域带不了 cookie，口令存浏览器 localStorage，第一次打开弹框输一次）。中继是阿里云函数计算上的一个小 Node 函数（`tools/relay-fc/index.js`），把请求原样转给跑着 `node server.js` 的后端。这条河是**全活**的：能刷新、能添加、能改 tag。生成与部署：

```bash
node tools/make-live-pages.js --live https://<你的中继地址> --out pages-out
# 把 pages-out/ 推到仓库 gh-pages 分支；中继用 tools/deploy-relay.sh 部署
```

中继的三个硬约束（都在 `tools/relay-fc/index.js` 注释里）：FC 网关自己会注入一整套 CORS 头，所以后端那套 `access-control-*` 必须在中继里丢掉，否则重复头让浏览器拒绝所有跨域请求；FC 默认域给每个响应加 `Content-Disposition: attachment`，所以**中继地址不能当网页直接打开**（会变成下载文件），网页入口永远是 Pages 链接；FC 默认域禁止任何 3xx 重定向，登录跳转降级成 meta refresh。

*只读快照：某一刻的河，谁都能看。* 不依赖任何后端：

```
node tools/make-pages.js --out pages-out   # 生成快照站：state.json + 静态 OPML + 只读开关
```

生成器复用 `tools/make-seed.js` 的脱敏闸（每源截 20 条、摘要截断、命中 `tools/scan-leaks.js` 模式表的串换占位符），生成后再用扫描器扫一遍产物，不干净就退出非零。把 `pages-out/` 推到仓库的 `gh-pages` 分支、在仓库设置里把 Pages 源指到该分支即可。快照站复用同一套前端：`app.js` 检测到 `window.QR_READONLY` 就改读同目录的 `state.json`，并隐藏刷新、添加、设置、开关这些写操作——页脚会写明这是哪一刻的快照、写操作去哪做。

`tools/make-pages.js`（快照生成器）与 `tools/publish.sh`、`tools/scan-leaks.js` 一样是**本机工具，不进公开仓**：它依赖的脱敏模式表写明了「这台机器上哪些串不能外流」，发布出去等于公开一份索引。活中继生成器 `tools/make-live-pages.js` 不含任何数据、不碰脱敏表，所以**在公开仓里**，别人 clone 后能自己生成活站；中继代码 `tools/relay-fc/` 与部署脚本 `tools/deploy-relay.sh` 同样在公开仓。

## 它刻意不做的事

- **不做推荐排序**。时间倒序是唯一排序。没有「热门」「相似」「可能感兴趣」。
- **不做全文抓取**。只取 feed 提供的标题、摘要、链接、时间、作者、封面。要看全文点进原文。
- **不做账号体系**。数据全在本地文件里，没有服务端状态，没有登录。
- **不做移动端推送**。它是一个你主动打开的页面，不是一个追着你跑的 App。

## 接口

页面用到的接口，也可以直接 curl：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/state` | 订阅、tag、混排后的条目、问题清单、上次抓取时间 |
| POST | `/api/resolve` | 只识别不保存：`{"url": "..."}`，返回平台、档位、验证过的 feed |
| POST | `/api/subscriptions` | 识别 + 保存 + 立即抓一次 |
| PATCH | `/api/subscriptions/:id` | 改名字、tag、feed 地址；`{"disabled": true}` 关闭展示（`false` 恢复） |
| DELETE | `/api/subscriptions/:id` | 删除订阅 |
| POST | `/api/subscriptions/:id` | 只刷新这一个订阅 |
| POST | `/api/refresh` | 刷新全部（并发 4）。带 `{"force": true}` 可绕过失败退避，页面上的「刷新」按钮就是这么发的 |
| PATCH | `/api/settings` | 改 `rsshubBase` 与 `refreshMinutes` |
| GET | `/api/export` | 导出 OPML，可以搬去任何 RSS 阅读器 |

## 几个实现上的取舍

**XML 解析是自己写的。** `lib/xml.js` 是一个约 150 行的降级式解析器，不是符合规范的 XML 处理器。真实世界的 feed 带着未闭合标签、游离的 `&`、错配的嵌套，严格解析器会整篇拒收，而这个会保留它能读到的部分。CDATA 按原样保留不再解一次实体；属性值里的 `>` 不会提前结束标签。

**中文摘要不留多余空格。** 剥 HTML 标签时，标签两侧若任一边是中日韩字符就不补空格，否则补一个——英文里 `word<b>bold</b>` 需要词间空格，中文不需要。

**失败的抓取不清空已有内容。** 网络抖动一次，上一次抓到的条目保留在河里，只在问题栏记一条错误。

**连续失败三次就退避。** 自动刷新（进页面时的后台刷新与定时器）会跳过已经连着失败 3 次的 feed：对着一个正在限流你或者已经死掉的源反复敲门，只会把封禁拖长。手动点「刷新」永远强制全量重试，成功一次计数归零。

**GitHub 仓库只订 release。** commit 流是开发记录不是文章：`Merge pull request #5 from …`、`Update README.md` 这种卡片进了河就是纯噪音，所以仓库没有 release 时直接拒绝并说明原因，而不是悄悄降级到 commit 流。真要跟提交——比如某个 GitHub Pages 博客仓，commit 就是他的文章——把 `…/commits.atom` 整条地址贴进来：**地址本身是 feed 文件时按直连验证，平台规则不覆盖你明确给出的地址**。另外 GitHub 用户动态（`{user}.atom`）是 `X pushed Y` 的推送日志，同样不是文章，加之前先看样本。

**识别结果带最新三条标题。** `/api/resolve` 与添加接口的返回里都有 `sample`，添加成功的提示、`tools/import-feeds.js` 的每行输出都会打出来。光看「20 条」分不清文章和 changelog，看标题一眼就知道。

**关闭一个博主不等于删掉他。** 博主卡与博主详情页各有一个开关。关掉以后：文章不进河、tag 栏不再算他、抓不到也不报警、连抓都不抓（省下的请求留给真要看的源）。但博主页仍然列出他，灰显，随时点开就恢复；重新开启会单独补抓一次，不会让你看到关闭前的旧内容。

**tag 分两级，博主的 tag 由文章继承。** 博主级 tag 存在订阅清单里（`tags` 字段），文章级人工 tag 单独存（`itemTags`），平台自带的分类（feed 里的 category）是第三路来源。卡片上显示的 tag 是三者并集，文章级在前因为更细。博主页的「管理 tag」改博主级——他名下每篇文章自动带上；卡片右下角的「+」改文章级——只影响这一篇。给博主打「数学」就不用逐篇打，给某篇补「复分析」也不会污染他其余文章。

**tag 筛选是多选，AND 关系；「未读」是独立一档筛选。** 点多个 tag 时文章必须每个都带才留下——「数学 + 复分析」看的是同时谈这两者的文章，不是两者的并集。tag 栏「全部」旁边的「未读」只看没点开的文章，数字是当前未读总数；未读判定和卡片右上角的蓝点同源（localStorage 里的已读集合，点过一篇它在任何视图都不再算未读），所以在未读视图里点开一篇，它会当场从列表里消失。

**没有发布时间的条目排到最后**，而不是当成「现在」跳到最前。

## 免凭证适配器：已内置五个，排除一个

2026-09-10 在本机对 26 个平台入口做了真实请求实测。以下五个中文/学术平台**不需要 RSSHub、不需要登录态**，适配器已内置，贴主页链接即可识别：

| 平台 | 通道 | 实测 |
|---|---|---|
| 掘金 | `api.juejin.cn/content_api/v1/article/query_list`（POST） | 10 条，字段在 `article_info` 里嵌套，ctime 为秒级时间戳 |
| 少数派 | `sspai.com/api/v1/articles?author_ids={id}` | 9 条，含 released_at。另一个端点 `article/user/page/get` 返回 3004 要登录，别用。**限制**：`/u/<slug>` 形态若 slug 查不到数字 ID 会报错，改贴 `/u/<数字 ID>` |
| 即刻 | `m.okjike.com/users/{uuid}` 移动页的 `__NEXT_DATA__` | 10 条。REPOST 与 ORIGINAL_POST 的网页地址不同，已分别处理 |
| Hacker News | `hn.algolia.com/api/v1/search_by_date?tags=author_{user}` | 20 条。坑：`tags=author,pg` 逗号写法返回 0 hits，必须下划线 |
| Semantic Scholar | Graph API `author/{id}/papers` | 20 条，含 publicationDate。匿名共享池偶发 429，已做一次重试 |

**B站专栏被排除**，虽然它的匿名 opus 接口（`x/polymer/web-dynamic/v1/opus/feed/space`）能返回 20 条真实内容：所有条目的 `pub_time` 都是空字符串，而补时间的详情接口返回 -352 风控。没有发布时间就没法进时间倒序的河，所以不做。B站投稿视频同理交给自托管 RSSHub。

抓取并发按**同域串行、跨域并发**组织：Reddit 自 2026-06 起对全部 RSS 做约每 IP 每分钟 1 次的全局限流，订 10 个 Reddit 博主意味着每个博主 10 分钟才能轮一次，这个降级是平台侧的，不是本项目的 bug。

**同域串行还不够，还要限密度。** 串行只保证不并发，不保证不打得太密：2026-09-11 实测某个登录态平台约 17 次请求 / 15 秒就吃 403。所以有一张按宿主的最小请求间隔表（`lib/refresh.js` 的 `HOST_MIN_GAP_MS`），key 可以是域名，也可以是 `adapter:<platform>` 形式的适配器宿主名——自己写的私有适配器天然继承这套节流。一个适配器的多次请求（比如先拉文章再拉回答）之间也要自己留间隔，1.5 秒是实测出来的安全值。

**但光调间隔治不了根，所以还有第二把旋钮：最小重抓周期。** 源一多，间隔调到不触限流就慢得没法用——实测 22 个源的全量强制刷新要 139 秒，其中还有 2 个撞上 403。而文章类内容不是按分钟变的，一天抓几次足够，所以 `HOST_MIN_RECHECK_MS` 让还新鲜的源直接不抓（登录态适配器 6 小时、Reddit 30 分钟）。改完同一批源刷一轮 **49 秒、跳过 13 个、零 403**。

两条跳过规则对「刷新」按钮的态度**故意不一样**：失败退避的含义是「它坏了」，而点刷新就是要重试坏的，所以 force 忽略它；重抓周期的含义是「这个平台没必要抓这么勤」，跟谁触发无关，所以 force 也照样尊重。要单独立刻拉某一个源，用 `POST /api/subscriptions/:id`——它不走这套过滤。

**跨境源会零星失败，这是本机网络不是 bug。** 一轮全量刷新里 Meta Engineering、airbnb.tech、NVIDIA、YouTube 这类源偶发 `fetch failed`，单独重抓就好。因为失败不清空内容，河里一条不少，问题栏也会写明「上次的 N 条还在河里」——所以看到几条问题不等于坏了几个源。

## 开发

```
node --test          # 测试：XML 边界、三种 feed 格式、平台识别与转发归类、适配器匹配、改 feed 地址的回归、__NEXT_DATA__ 提取、摘要数学分段与截断修复、博主 tag 继承、来源分组、访问口令闸（含登录页与 /login 表单）
                     # 源码仓 66 个（含 tools/lib/library.test.js 的 9 个），公开仓形态 57 个。
                     # 这里刻意不写死数字：它会漂（曾写成 65/56）。以命令输出为准。
PORT=8080 node server.js
```

## License

MIT
