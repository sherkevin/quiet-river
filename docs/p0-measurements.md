# P0 实测记录：第一批真实运行数据

日期：2026-09-16
性质：**这是整个评审循环里第一份跑出来的数据**。前四轮（含外部评审人的实施方案 v1.0
与我们三份评审）全部是源码级与配置级结论，没有一条经过运行验证。
本文记录实测过程、原始输出，以及每条数据推翻了哪个原有假定。

**发布边界（2026-09-17 翻转）**：本文原先标为本机文档，理由是「写了本机私有 CLI
工具名与凭证文件的字段构成」。两条理由经核实都不成立，现已进 ALLOW 白名单随公开仓发布：
那个 CLI 是 npm 公开包 `@jackwener/opencli`（Apache-2.0），不是本机私有设施；
「凭证字段构成」指的是 cookie 里只有 `z_c0` 没有 `d_c0` 这件事——是字段名的有无，
不是字段的值，凭证真值从不在本文里。本文已过 `tools/scan-leaks.js`。
**仍然不外发的是 `docs/LOCAL.md`**（本机 git 身份、凭证值形态示例、公司安全代理域名）。

复现方式见每节末尾的命令。所有 ECS 侧命令通过阿里云 workbench CLI 执行，
不依赖 SSH 密钥。

---

## 0. 一句话结论

**方案的架构选型没有被动摇，但四个部署前提与实测不符，其中两个会让 P0 直接停住。**
知乎凭证已失效（不是限流），ECS 上没有容器运行时且 Docker Hub 直连不通，
可用内存比方案假定的少约 300MB 且没有 swap。
另外发现我们自己的凭证自检工具会把「凭证已作废」报成「稍后重试」，已修。

| # | 实测发现 | 推翻的假定 | 严重度 |
|---|---|---|---|
| M1 | 知乎 cookie 返回 401 `ERR_TICKET_NOT_EXIST`，连跑两次一致；缓存里 109 个源从 9-15 起就在报 401 | 「128 个登录态源只是停在快照，凭证还在」 | **P0 阻塞** |
| M2 | cookie 里只有 `z_c0` 一个字段，**没有 `d_c0`** | 方案与 ADR 假定 RSSHub 知乎路由可直接用现有凭证 | **P0 阻塞** |
| M3 | ECS 上没有 docker、podman、compose，也没有 postgres/caddy/redis | §13「采用现有 Ubuntu 24.04、Docker Engine 与 Compose 插件」当成既有条件 | **P0 阻塞** |
| M4 | ECS 不能直连 Docker Hub（`registry-1.docker.io` → 000），PostgreSQL 官方镜像只在 Docker Hub | §12.2 的服务清单默认镜像可拉 | **P0 阻塞**，有解（见 §4） |
| M5 | 内存实测 `total 1740MiB / available 1201MiB`，**无 swap** | 全文以「2C2G」为基线，§12.4 假定可用 swap 作应急缓冲 | **高风险**，影响 §12.4 验收能否通过 |
| M6 | 自检工具把知乎 401 报成「网络或风控页，稍后重试」 | B1 凭证健康检查「设计已定」（ADR 0015） | 已修，暴露 B1 尚未落地 |
| M7 | 小红书会话**是活的**（`whoami` → logged_in），但缓存里 13 个源仍带 9-13 的错误 | 「128 源全部失效」 | 好消息：失效面比估的小 |
| M8 | 条目字段只有 `guid/title/link/author/published/summary/image`，**无正文字段**；7474 条全无正文 | 迁移时「历史条目导入即完成」 | 工作量未计入方案 |
| M9 | 实测 `npm test` 是 66 个（公开形态 57），README 与现状文档写的是 65 / 56 | — | 文档漂移，已修 |

## 1. 凭证健康：知乎已失效，小红书还活着

### 1.1 原始输出

跑 `node tools/check-credentials.js`，修复分类逻辑后：

```text
知乎：凭证已失效（知乎明确拒绝这份凭证（AuthenticationInvalidRequest）。重贴 cookie，且这次要带 d_c0——只有 z_c0 不够）
小红书：活着（账号 ll）
退出码 1
```

直接打知乎单点端点 `/api/v4/me`，连跑两次（间隔 3 秒）结果一致：

```json
{"error":{"code":100,"name":"AuthenticationInvalidRequest","message":"ERR_TICKET_NOT_EXIST"}}
```

HTTP 401。**两次一致，且是「凭证不存在」语义而不是「请求太密」，
所以这不是限流，等不会好。**

### 1.2 缓存侧的交叉验证

读 `data/cache.json`（结构是 `{version, feeds}`，253 个 feed 键）：

```text
带 error 的源：146
条目总数：7474
错误分布（前几位）：
  知乎返回 HTTP 401                    109
  opencli 调用失败（小红书会话）        13
  fetch failed                          8
  知乎返回 403（限流）                  6
  请求超时（40 秒）                     4
  其他                                  6
```

知乎 401 的时间戳范围是 **2026-09-15 10:48 到 18:52**，
也就是说这批失效已经持续超过一天，缓存里 109 个源一直在报错。
小红书那 13 条的时间戳是 **2026-09-13 23:02**，
而刚才 `whoami` 是活的——**说明小红书的缓存错误是陈旧的**，
会话在 9-13 之后重新登录过，但那 13 个源没有被重新抓过。

**这条修正了第 2 轮的判断**：当时写「128 个登录态源全部失效 5 天」，
实测是**知乎 109 个失效（1 天多）、小红书 13 个凭证活着但数据陈旧（3 天没刷）**。
失效面比估的小，但知乎这一半是真死的。

### 1.3 `d_c0` 缺失

只读字段名不读值：

```text
cookie 字段数：1
字段名：z_c0
有 d_c0：false
文件 mtime：2026-09-11T08:00:13Z
```

**这是 B2「重贴凭证要带 `d_c0`」的实测确认**：现有凭证文件里根本没有这个字段。
RSSHub 的知乎路由需要 `d_c0`（设备标识），只贴 `z_c0` 大概率仍会被风控挡。
所以 B2 不是「重贴一次」那么简单，是「重贴并且换一种取法」。

### 1.4 顺手修掉的工具 bug（M6）

`tools/check-credentials.js` 原本只对 403 做分类，401 落进兜底分支被报成
「网络或风控页，稍后重试」。这是错的，而且错的方向很危险：
**403 等一会儿可能自己好，401 等多久都不会好**。
把一个必须重贴的故障说成可以等，和「128 个源静默失效 5 天没人发现」
是同一类错误，只是这次错在工具里。

已修：401 单独分支，state 为「凭证已失效」，hint 里带上 `d_c0` 的要求；
并解析 body 里的 `error.name` 一并显示。
`lib/adapters.private.js` 的知乎适配器同样补了 401 分支——
之前 109 个源的问题栏里只写着「知乎返回 HTTP 401」，看不出要重贴凭证。

**这件事对 B1 的意义**：ADR 0015 定的凭证健康设计（凭证组为故障单位、
`last_success_at` 为健康依据、巡检不额外打平台）目前**只有一个手工 CLI**，
没有调度、没有告警、没有凭证组概念，而且这个 CLI 的分类逻辑本身是错的。
「设计已定」不等于「已落地」。B1 的实际工作量要按「从零实现」估。

### 1.5 复现

```bash
node tools/check-credentials.js                    # 退出码 0 全活 / 1 有失效 / 2 未配置
node -e "const c=require('./data/cache.json').feeds; /* 见 §1.2 统计 */"
```

## 2. ECS 主机实况：没有容器运行时

### 2.1 原始输出

```text
=docker=      NO_DOCKER
=compose=     NO_COMPOSE
=mem=         total 1740  used 539  free 220  buff/cache 1155  available 1201
=disk=        /dev/vda3  40G  3.0G used  35G avail  8%
=arch=        x86_64
=os=          Ubuntu 24.04.4 LTS
=cpu=         nproc 2
=swap=        （swapon --show 输出为空，即无 swap）
```

逐个探测组件：

```text
docker: -     podman: -     postgres: -     psql: -
nginx: -      caddy: -      redis-server: -
node: v20.20.2    python3: 3.12.3
```

当前内存占用前几名：

```text
175540 KB  node        （现有 quiet-river 服务）
 47436 KB  fwupd
 38356 KB  cloudflared
 28620 KB  AliYunDun
 28444 KB  tuned
```

监听端口：80 与 4321（同一个 node 进程双监听）、22、cloudflared 的本地 20241。

### 2.2 与方案假定的差距

方案 §13 写「采用现有 Ubuntu 24.04、Docker Engine 与 Compose 插件」，
把 Docker 当成既有条件。**实测是零**：引擎、compose 插件、以及六个常驻服务里
除 Bridge（Node，已有 v20）之外的全部依赖都要从零装。
这不是阻塞，但是 P0 的第一项工作，方案里没给它排位置。

**内存这条更要紧（M5）**。全文反复以「2C2G」为基线，实测 `total` 只有
**1740MiB**（标称 2GB，内核保留与云监控 agent 吃掉约 300MB），
`available` **1201MiB**。而 §12.2 的阅读核心是六个常驻服务：
Miniflux、PostgreSQL、Karakeep 最小安装（web + worker 两个进程）、Bridge、Caddy、ntfy。
现有 node 服务已经占了 175MB。

§12.4 的验收目标是「稳定负载保留约 250MiB 以上可用内存」，
并写「Swap 可以用于应急缓冲」。**实测这台机器没有 swap**，
所以那条缓冲现在不存在——要么先建 swap，要么把验收目标改成「无 swap 下不 OOM」。

方案 §12.4 已经预留了「变更单优先讨论内存提升至 4GiB」这条路，
**这批数据是提那张变更单的第一份依据**。建议在装任何服务之前先做一次空载基线，
然后按 §12.4 的顺序逐层启用并记录，不要一次装完再看。

### 2.3 复现

```bash
workbench exec --instance-id <实例ID> --timeout 60 --command \
  'command -v docker; free -m; df -h /; swapon --show; ps -eo rss,comm --sort=-rss | head -6'
```

## 3. ECS 出网：Docker Hub 不通，ghcr.io 通

### 3.1 原始输出

```text
download.docker.com（apt 仓库，HTTPS）        -> 000  FAIL
mirrors.cloud.aliyuncs.com/docker-ce/.../Release -> 200     （内网 apt 镜像，可用）
mirrors.aliyun.com/docker-ce/.../Release        -> 200     （公网 apt 镜像，可用）
registry-1.docker.io/v2/                        -> 000  FAIL
ghcr.io/                                        -> 405     （可达，HEAD 不被接受）
ghcr.io token（miniflux/miniflux:pull）         -> 200
ghcr.io manifest（miniflux/miniflux:latest）    -> 200
```

### 3.2 这意味着什么

**好消息**：Miniflux 与 Karakeep 的官方镜像都在 `ghcr.io`，实测可达且能取到 manifest。
apt 装 Docker Engine 走阿里云内网镜像也可达。

**坏消息**：**PostgreSQL 官方镜像只在 Docker Hub**，而 Docker Hub 直连不通（000）。
方案 §12.2 的六个常驻服务里，PostgreSQL 是唯一的硬依赖
（Miniflux 与 Karakeep 都要它），所以这条不解决，部署第一步就停。

### 3.3 有解：镜像加速器实测可用

探测了几个常见加速器，返回 401 的是活的（registry 正常的认证质询），
000/超时的是死的：

```text
docker.m.daocloud.io -> 401   （活）
dockerproxy.net      -> 200   （活）
docker.1ms.run       -> 401   （活）
hub.rat.dev          -> 302   （活）
docker.xuanyuan.me   -> 401   （活）
```

对 `docker.m.daocloud.io` 走完整认证流程实测（取 `WWW-Authenticate` →
换 token → 带 token 取 manifest）：

```text
realm=https://m.daocloud.io/auth/token
token 长度=727
GET /v2/library/postgres/manifests/17-alpine （带 token）-> 200
```

**结论：PostgreSQL 镜像能通过加速器拉到。**
落地方式是在 `/etc/docker/daemon.json` 配 `registry-mirrors`，
这一条要写进部署脚本，不能留给实施者临场发现。

**一个必须记下的风险**：加速器是第三方服务，可用性与内容完整性都不由我们控制。
方案 §12.2 明确写了「必须固定镜像/源码，不使用未经核实的社区公共实例」，
这条原则对加速器同样适用——**拉到的镜像要按 digest 固定，并核对 digest
与 Docker Hub 官方一致**，不能只固定 tag。加速器返回 200 不等于返回的是官方镜像。
这一条建议进 P0 验收项。

### 3.4 复现

```bash
workbench exec --instance-id <实例ID> --timeout 80 --command '
  curl -sI -m 8 -o /dev/null -w "%{http_code}\n" https://registry-1.docker.io/v2/
  curl -sI -m 8 -o /dev/null -w "%{http_code}\n" https://ghcr.io/
  # 加速器完整认证流程见 §3.3
'
```

## 4. Karakeep 最小安装：不装 chrome 容器的真实后果

方案 §12.2 决定「不安装 Karakeep 的独立浏览器容器，上游取得的 HTML 通过归档导入」。
核了 v0.33.2 的 worker 代码，**这个决定成立，但有一处边界要写清楚**。

`apps/workers/workers/crawlerWorker.ts:80-107` 的 `prepareForAdhoc()`
在没有浏览器后端时**直接抛错拒绝运行**：

```text
[adhoc] No browser backend configured — refusing to run. crawlPage() would
silently fall back to a plain HTTP fetch. Set BROWSER_WEB_URL or
BROWSER_WEBSOCKET_URL to a reachable Chrome.
```

注释说明了为什么这样设计：adhoc CLI 的存在意义就是跑真实浏览器路径，
没有浏览器时 `crawlPage()` 会静默退化成普通 HTTP 抓取，
那会污染 A/B 结果，所以宁可大声失败。

**关键是这个强制检查只在 adhoc CLI 路径上**（`apps/workers/scripts/crawlAdhoc.ts`）。
正常的队列 worker 路径不会抛错，而是**静默退化成 `browserlessCrawlPage`**。

对我们的影响：

1. **最小安装可行**，因为我们的导入路径是「上游取得 HTML → 归档导入」，
   第 3 轮已核实有 precrawled 资产时 `crawlerWorker.ts:386` +
   `crawlAndParse.ts:223` 直接读上传的 HTML、不调 `crawlPage`
2. **但 `crawlAdhoc` 这个调试工具用不了**，别把它写进运维手册
3. **更要紧的是那条静默退化**：如果哪天 precrawled 资产没 attach 上
   （第 3 轮 P1-B 指出这个保证来自执行顺序而非设计），
   worker 不会报错，而是**悄悄去抓原文站**——对知乎/小红书这类反爬站
   等于拿机房 IP 去撞风控，且日志里看不出异常。
   这正是 A11「执行期间对原文域名零出向请求」那条断言存在的理由，
   **它不是可选项**。

另外 `MEILI_ADDR` 不配即停用（`packages/plugins/search-meilisearch/src/index.ts:138`
是 `return !!envConfig.MEILI_ADDR`），与方案「不启用搜索」一致，这条没问题。

## 5. 数据模型：7474 条历史条目全无正文

实测条目字段：

```text
guid, title, link, author, published, summary, image, categories
```

**没有正文字段**，`summary` 是截断过的摘要
（`lib/store.js:207` 只做 `summary: raw.summary` 透传，
适配器侧 `clamp(stripHTML(a.excerpt))` 截断）。

这与第 2 轮的发现一致（全库 7474 条无一条存正文），
但对**迁移**有一个方案没算的工作量：

- 历史条目导入 Miniflux 后，**只有摘要**，正文是空的
- ADR 0016 的补正文路径是 `PUT /v1/entries/{entryID}`，
  所以技术上可以补，但**要逐条补 7474 次**，且原文可能已经删了、
  知乎/小红书这类源还需要登录态（而 M1 说凭证已失效）
- 方案 §6 的五态内容模型有 `META` 态（拿不到正文也要有卡片和原文链接），
  **历史条目大概率全部落在 `META`**

**需要决策，不要默认**：历史 7474 条是「导入即 `META`，不补」，
还是「按 tag 优先级挑一批补」？方案没写。
倾向前者——历史条目的价值已经被三个月的人工筛选沉淀在 tag 与清单里了，
补全文的边际收益低，而代价是 7474 次带登录态的抓取。
**但这是个产品决定，不是技术决定，要显式定下来写进 ADR。**

## 6. 文档漂移：测试数字

实测：

```text
npm test（全仓发现）        -> 66 pass
test/*.test.js（窄 glob）   -> 57 pass
```

差的 9 个在 `tools/lib/library.test.js`（它不在 `test/` 下，
所以窄 glob 扫不到，而 `npm test` 走 `node --test` 的默认发现规则会带上）。
公开仓形态因为 `tools/lib/` 不在发布白名单里，是 57。

README 与 `docs/status-2026-09-16.md` 写的是 65 / 56，**各差 1**。
已修正为 66 / 57。

**这条本身是小事，但它说明一件事**：文档里的数字没有自动校验，
靠人手维护就会漂。P0 的验收清单如果要写「N 个测试全绿」，
应该写命令而不是写数字。

## 7. 对方案的影响：要改什么，不用改什么

### 不用改

- **架构选型全部成立**：Miniflux 做条目主库、Karakeep 做归档与批注、
  Bridge 做调度与排序、ADR 0016 的入向导入路径。这批实测没有触及任何一条。
- **Karakeep 最小安装成立**（§4），且第 3 轮核实的 precrawled 路径仍然对。
- **§14 凭证组健康设计成立**，而且 M1/M6 正好证明了它的必要性：
  一个失效凭证让 109 个源各自报错，工具还把 401 说成「稍后重试」。

### 要改

1. **P0 的第一项不是「生成 source-manifest」，是「装 Docker + 配镜像加速器」**。
   方案 §13 把它当成既有条件，实测是零。加速器要按 digest 固定（§3.3）。
2. **§12.4 的资源基线要改成实测值**：`total 1740MiB / available 1201MiB / 无 swap`。
   「2C2G」是标称，不是可用。要么先建 swap，要么把验收目标改成无 swap 下不 OOM。
   **这批数据足以支撑提那张「内存提升至 4GiB」的变更单**，
   建议在装服务之前先提，别等 OOM 了再提。
3. **B2 要改写**：不是「重贴凭证」，是「换一种取法重贴，且必须包含 `d_c0`」。
   现有凭证只有一个字段，按原样重贴大概率仍然失败。
4. **B1 的状态从「设计已定」改成「未实现」**：目前只有手工 CLI，
   没有调度、告警、凭证组，且分类逻辑刚修完一个错。工作量按从零估。
5. **新增一条产品决策**：历史 7474 条要不要补正文（§5）。倾向不补，
   全部落 `META` 态，但要显式定下来。
6. **A11「零出向请求」断言升为强制项**：§4 那条静默退化是它的直接理由。

### 待测（本轮没条件测）

- **B3 机房 IP 登录态**：仍然没测。这是最大未知数，
  而且 M1 让它的优先级更高了——如果机房 IP 上登录态本来就不可用，
  那「重贴凭证」这件事在 ECS 上是白做的。
  测法：在 ECS 上装好 opencli（`@jackwener/opencli` v1.8.7，Apache-2.0，
  npm 公开包，本机是 homebrew 装的），登录后打一次小红书 `whoami` 与
  知乎 `/api/v4/me`，与本机结果对比。
- **导入接口的契约验收**（ADR 0016 的六步）：需要 Docker + Miniflux 起来才能跑。
  M3/M4 解决后即可离线进行，不需要真实凭证。
- **WeRSS 实际浏览器引擎**（第 4 轮回复补充五）：需要 ECS 上有容器运行时。
- **真实体积分布**：方案估 3GB/月，我们粗估 73MB，差一个量级。
  M8 说历史 7474 条占 5.7MB 缓存（含摘要），
  这个数量级支持我们的估算，但**补正文之后会完全不同**，要在导入后重测。

## 8. 本轮改动的文件

- `tools/check-credentials.js`：401 单独分类为「凭证已失效」，
  解析 `error.name`，hint 里带 `d_c0` 要求（M6）
- `lib/adapters.private.js`：知乎适配器补 401 分支，
  错误信息从「知乎返回 HTTP 401」改成带处置指引的文案（M1）
- `README.md`、`docs/status-2026-09-16.md`：测试数 65/56 改为 66/57（M9）
- 本文

测试：`npm test` 66 个全绿（修改前后一致，本轮改动的是错误分类与文案，
没有改变任何被测行为）。
