# 实施方案 v1.0 的源码级评审

评审对象：[`private-reader-platform-impl-v1.md`](private-reader-platform-impl-v1.md)
（外部评审人读完我们的[现状简报](current-state-brief.md)后给出的完整实施方案，1428 行，
自称「产品与架构冻结；待实现、部署与实测验收」）

评审日期：2026-09-16

> **第 4 轮更正横幅（2026-09-16，同日）**：本文 §2「P0-A」给的三条出路里，
> **出路一（受限来源不经 Miniflux，Bridge 自存条目）当时是我们的推荐，现已被推翻**，
> **出路三里那句「Miniflux 没有外部推送条目的 API」是错的**。
> 外部评审人指出 Miniflux 有入向导入接口 `POST /v1/feeds/{feedID}/entries/import`，
> 我们重核源码确认它是纯数据库写入、不碰抓取器，私网拦截不参与判断。
> **受限来源现在仍进 Miniflux，由 Bridge 主动推，全库单一文章主库。**
> 这条结论以 [ADR 0016](决议/0016-受限来源改用Bridge主动导入Miniflux单库.md) 为准，
> 本文 §2 保留作历史（它记录的是「只查出向、漏查入向」这个推理错误的形状）。
> **本文其余结论不受影响**：P0-A 的私网拦截约束本身真实（被 0016 继承为「开关保持关闭」），
> P0-B（WeRSS 采正文要起浏览器）成立，§4 的 Miniflux 原生全文能力成立，
> 七问七答的评价成立。下面正文不改，按本节横幅理解 §2 即可。

**评审方法**：方案里每条可验证的技术断言都拉到源码或上游仓库核对。本轮实际克隆并核对了
四个仓库的指定版本：

| 组件 | 核对版本 | commit / blob |
|---|---|---|
| Karakeep | **tag v0.33.2**（与他 §3.2 的锁定版本一致） | `98c0c789`，2026-08-11 |
| Miniflux | main | `76889f08`，2026-09-11 |
| we-mp-rss | main | `d8feb6a4`，2026-09-10；`config.example.yaml` blob `836183060b87b6ff24c57ff84dc5e36105ab553b` |
| 本项目 | `data/subscriptions.json` 实测 | 271 源 / 16 tag / 149 无 feed / 3 关闭展示 |

**未做的事**（与他方案自述的限制一致）：没有在真实 ECS、真实平台账号、真实博主列表上
做连通测试。所有结论都是源码级与配置级的，**不是运行结果**。

---

## 0. 总体判断

**这份方案可以实施，且明显优于上一版。** 证据纪律是真的：他给的三个 blob SHA 里
两个与我们独立核对的结果**逐字符相同**，第三个指向 main 分支而非锁定版本，
我们替他做了对照，差异无害（§5）。产品边界的修正（§1.2「自托管的是平台，不是互联网」、
§1.3 撤销六条旧判断）站得住。§3.4「只有一个刷新调度所有者」附带的那个发现
——关掉 Miniflux 内部调度会**连清理循环一起关掉**——是我们上一轮漏掉的，他抓到了。
§17 用三个覆盖指标替代单一成功率、以及「可使用」与「原始要求全部完成」是两个状态，
正好对上我们 128 个源静默失效 5 天的实际创伤。

但**有两处必须在 P1 开工前修掉**，其中一处是架构性的：

| 编号 | 问题 | 严重度 | 位置 |
|---|---|---|---|
| **P0-A** | §5.4 的「Miniflux 读 Bridge 内网缓存地址」被 Miniflux 的私网拦截**直接挡死**，且唯一的原生开关是全有全无的布尔值，打开它会在阿里云 ECS 上把**云元数据地址**一起放进来 | **阻塞** | 方案 §5.4、§15.3、§21.3 |
| **P0-B** | WeRSS 采公众号正文**也要起浏览器**（Playwright + Firefox），但他只给小红书/B站标了浏览器门槛，2C2G 的资源模型里**没有这一份开销** | **阻塞** | 方案 §4.4、§12.2、§12.3 |
| **P1-A** | Miniflux **自带**每源全文提取（readability + goquery 规则 + `fetch-content` 端点），方案完全没提，导致 §6.1 把本该白拿的能力算成 Bridge 的开发量 | 范围可缩 | 方案 §3.3、§6.1 |
| **P1-B** | §6.5 的 `append-recrawl` 那一行结论**是对的，但对得偶然**：它依赖「先 attach 再 recrawl」这个执行顺序，方案没把它写成不变量 | 隐患 | 方案 §6.5 |
| **P1-C** | §21.7 的 curl 示例会在 P1 契约测试里**直接 403**：singlefile 需要两个 API scope | 小坑 | 方案 §21.7 |
| **P1-D** | §18 的阶段顺序把「机房 IP 上登录态是否可用」放在 P2，但它失败会改变 P2~P5 的形状，应当前移 | 排序 | 方案 §18、§19.1 |

另外，他指出了**我们简报里的一个真实笔误**（17/18 口径不一致），已核实并修正（§6）。

---

## 1. 核实成立的断言（可以直接依赖）

| 方案位置 | 断言 | 核对结果 |
|---|---|---|
| §3.4 / [S09] | `DISABLE_SCHEDULER_SERVICE=1` 存在；关闭后**清理循环也一起停** | **成立，且是好发现**。`miniflux.1:299` 有该项；`internal/cli/scheduler.go` 的 `runScheduler` 里 `go feedScheduler(...)` 与 `go cleanupScheduler(...)` 是**并列**启动的，关掉调度器两个都没了。他给的 blob SHA `1cfad367…6f79` 与我们核对的**完全一致** |
| §3.2 / [S05] | `/bookmarks/singlefile` 存在，五种 `ifexists` 模式 | **成立**。v0.33.2 的 `packages/api/routes/bookmarks.ts:121`，`skip/overwrite/overwrite-recrawl/append/append-recrawl` 五个全在（`:127-135`） |
| §6.5 | `skip` 不会替已有链接对象自动补全文 | **成立**。`skip` 分支是空的 `break`（`:161-162`）；只有 `append*`/`overwrite*` 才 `attachAsset` |
| §12.2 / [S03][S10] | 不装 Karakeep 浏览器容器可行，因为有 precrawled 归档就不会去抓 | **成立，这是整个资源计划的承重墙，已验证**。`crawlerWorker.ts:386-401`：有 `precrawledArchiveAssetId` 时直接按 `TEXT_HTML` 处理，**跳过 content-type 探测**；`crawlAndParse.ts:223-237`：直接 `readAsset` 读上传的 HTML，**不调 `crawlPage`**；`:494` 还跳过整页归档 |
| §4.4 / [S11] | we-mp-rss 的配置键名与默认值 | **成立**。`gather.model`（默认 `web`）、`gather.content`（默认 `False`）、`gather.content_auto_check`（默认 `True`）、`rss.full_context`（默认 `True`）、`rss.local`（默认 `False`）、`proxy.enabled`、`cascade.enabled` 逐个对上。他还正确区分了 `gather.model` 与 `gather.content_mode`——这是**两个不同的键**，容易混 |
| §3.2 / [S21] | RSSHub = AGPL-3.0，we-mp-rss = MIT | **成立**，两个 LICENSE 文件都核了 |
| §16.1 | Miniflux 的 feed 分类是**单个** category，承载不了 16 个 tag 的多对多 | **成立**。`internal/model/feed.go:155` 是 `CategoryID int64`，单值 |
| §11.3 / [S01] | 单源刷新是同步执行语义 | **成立**。`internal/api/api.go:46` 注册 `PUT /v1/feeds/{feedID}/refresh`，handler 内**直接调用** `feedHandler.RefreshFeed(...)`（`feed_handlers.go:82`），不入队 |
| §10.3 / [S01] | `changed_after` 等增量筛选字段存在 | **成立**。`api.go:57-65` 有 `GET /v1/entries`、`GET /v1/entries/ids`、`PUT /v1/entries`；`entry_handlers.go:580/584/608` 分别处理 `before_entry_id`、`after_entry_id`、`changed_after` |
| §21.4 | 11 个 Karakeep 环境变量名 | **全部存在于 v0.33.2** 的 `packages/shared/config.ts`（逐个 grep 核过）。`MAX_ASSET_SIZE_MB` 默认 50，他设的 20 MiB 归档上限在范围内 |
| §2.1 / §2.2 | 271 源、13 类平台、16 tag、149 无 feed、3 关闭展示 | **与 `data/subscriptions.json` 逐项相同**。平台分布表 13 行**一个不差** |

**他自己标了「须验证」而我们替他验掉的两条**（可以从不確定清单里划掉）：

1. **§7.1 的「我的笔记」能不能做——能，而且有 spec 契约。** 他写「若该版本没有满足需要的
   跨文章列表，Bridge 通过官方 API 分页列出」，是把这条当不确定项处理的。
   实测 v0.33.2 的 `packages/open-api/lib/highlights.ts:31` 注册了 `GET /highlights`，
   官方描述就是 “Retrieve a paginated list of **all highlights across all bookmarks**
   for the authenticated user”。**A15 验收项有正式 API 支撑，不需要自己拼。**
2. **§21.7 的 `check-url` 在不在发布版——在。** `packages/open-api/lib/bookmarks.ts:131`
   有 `path: "/bookmarks/check-url"`，v0.33.2 即支持，可用于超时后的去重对账。

顺带确认：**我们上一轮建议的两步式导入路径在 v0.33.2 上成立**——`POST /assets` 在
spec 里（`assets.ts:24`，只接受 `file` 字段），`precrawledArchiveId` 在
`zNewBookmarkRequestSchema` 的 LINK 分支里（`packages/shared/types/bookmarks.ts:264`）。
singlefile 端点内部走的就是这两个调用（`bookmarks.ts:148-157`：`uploadAsset` →
`createBookmark({precrawledArchiveId})`）。**两条路都通**，选择见 §5。

还有一条我们担心会掐断正文链路的，**核实后是虚惊**，记录下来免得 P1 重复怀疑：
`uploadAsset`（`packages/api/utils/upload.ts`）有一段「嗅探不到类型就拒绝浏览器提供的
MIME」的安全检查，而 `file-type@21.2.0` 的 `supportedMimeTypes` 里**不含 `text/html`**
（只有 `text/calendar`、`text/vcard`、`text/vtt`）。但正因如此，
`supportedMimeTypes.has(fallbackType)` 为假，那个拒绝分支**不会触发**，
contentType 落回 `text/html`，而 `text/html` 在 `SUPPORTED_UPLOAD_ASSET_TYPES` 白名单里
（`packages/shared/assetdb.ts:54`）。e2e 测试 `packages/e2e_tests/tests/api/bookmarks.test.ts:649`
上传 `<html>HELLO WORLD</html>` 断言 201，与推理一致。**HTML 归档上传这条路是通的。**

---

## 2. P0-A：§5.4 的内网缓存设计被 Miniflux 挡死

### 他的设计

> 受限来源：Bridge 先通过同一账户/平台的限制器执行采集，将成功原始 Feed 缓存到本地，
> 再让 Miniflux 读取内部只读缓存地址。（§5.4）

配套接口是 §11.2 的 `GET /internal/feeds/{channel_id}`，§10.1 把「Feed 条目原始内容」
的唯一权威存储定在 Miniflux / PostgreSQL。也就是说：**知乎、小红书这类受限来源的条目
要经 Miniflux 入库**，而 Miniflux 取它们的唯一途径是访问 Bridge 的内网地址。

### 实测：Miniflux 默认拒绝一切非公网地址

`internal/reader/fetcher/request_builder.go:184-199`：

```go
allowPrivateNetworks := config.Opts == nil || config.Opts.FetcherAllowPrivateNetworks()
if !allowPrivateNetworks {
    directDialer.Control = func(network, address string, c syscall.RawConn) error {
        host, _, err := net.SplitHostPort(address)
        ...
        ip := net.ParseIP(host)
        if urllib.IsNonPublicIP(ip) {
            return fmt.Errorf("%w %q", ErrPrivateNetworkHost, host)
        }
        return nil
    }
}
```

注释说明这个检查放在 dialer 的 Control 回调里，**在 DNS 解析之后、建连之前**执行，
目的是消除 TOCTOU / DNS rebinding。设计是对的，但对我们的方案是硬墙。

`internal/urllib/url.go:191-206` 的 `IsNonPublicIP` 覆盖：

```go
ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified()
// 外加 rfc6598SharedAddressSpacePrefix = 100.64.0.0/10（url.go:15）
```

Docker 的 bridge 网络（`172.17.0.0/16`）、compose 自定义网络、`127.0.0.1`
**全部落在 `IsPrivate()` 或 `IsLoopback()` 里**。§21.3 的 Miniflux 配置样例
**没有** `FETCHER_ALLOW_PRIVATE_NETWORKS`，所以按方案照抄部署，
第一个受限来源就会失败，错误是 `fetcher: refusing to access private network host`。

`internal/http/client/client.go:45-70` 还有第二道：解析出的所有 IP 若全是非公网，
直接 `ErrPrivateNetwork`。**两道都得过。**

### 更麻烦的是：这个开关是全有全无的

我们把 `internal/config/options.go` 里所有 `ALLOW*` 配置项列了出来，只有三个：
`FETCHER_ALLOW_PRIVATE_NETWORKS`、`INTEGRATION_ALLOW_PRIVATE_NETWORKS`、
`METRICS_ALLOWED_NETWORKS`。**没有按主机名的白名单机制。**

而方案 §15.3 要的是：

> 内部缓存 Feed 需要显式允许访问指定服务，但不意味着给采集器开放全部私网地址。
> ……屏蔽云元数据、环回和无关内网。

**这个要求 Miniflux 原生做不到。** 要么全关（§5.4 不可用），要么全开（§15.3 不可用）。

### 全开的代价，在阿里云上比方案预想的严重

方案 §15.3 把「屏蔽云元数据」和「允许指定内部服务」当成可以同时满足的两件事。
实测它们**冲突**：

```text
阿里云元数据地址 100.100.100.200
  落在 100.64.0.0/10（RFC 6598 运营商级 NAT 段）内 → True
  而 Python 的 is_private 判定 → False（这就是为什么需要专门加 rfc6598 检查）
```

Miniflux 在 `url.go:15` **专门定义** `rfc6598SharedAddressSpacePrefix` 并在
`IsNonPublicIP` 里单独判它（`:196-198`），说明上游很清楚这个段的风险。
把 `FETCHER_ALLOW_PRIVATE_NETWORKS=1` 打开，等于**亲手拆掉这道专门针对云元数据的防护**，
而我们的部署目标正是阿里云 ECS（方案 §13）。

这不是理论风险：正文抓取链路会处理**不可信的外部 HTML**（他 §15.3 自己也这么定性），
一个被污染的 feed 条目 URL 或一次重定向就可能把 fetcher 引到 `100.100.100.200`。

### 三条出路（建议按顺序评估）

**出路一：受限来源不经 Miniflux。** ⚠️ **第 4 轮已推翻，见顶部横幅与 ADR 0016。**
当时我们推荐它，理由是「完全绕开私网问题」；但外部评审人指出还有入向路径
（导入接口），核实后受限来源仍进 Miniflux、单库不分家，不必走这条双库的路。
下面原文保留作历史。
Bridge 自己存知乎/小红书这类来源的条目，`/desk/api/items` 直接合并两个来源的列表。
代价是 §10.1 的数据归属表要改——「Feed 条目原始内容」不再是 Miniflux 单一权威，
已读状态也要在两边各存一份或只在 Bridge 存。
好处是**完全绕开私网问题**，且受限来源本来就需要 Bridge 的限制器、凭证组、
缺口记录这些 Miniflux 没有的概念。
**我们的判断：这条最干净**，因为它承认了一个事实——受限来源和原生 RSS 源
在数据模型上本来就不同类，硬塞进同一个 feed 表是为了架构整齐而付出的代价。

**出路二：开 `FETCHER_ALLOW_PRIVATE_NETWORKS=1`，同时在网络层封死元数据地址。**
具体要在安全组/iptables 上显式拒绝 Miniflux 容器出向访问 `100.100.100.200`
与 `169.254.169.254`，并把 Miniflux 放到一个**只能路由到 Bridge** 的独立 Docker 网络。
他 §13.5 已经提到「采集网络、应用网络和数据库网络分开」，方向对，
但**没有把元数据地址列为必须显式拒绝的目标**，而这正是开关打开后唯一的实质防线。
走这条路必须把这条规则写进 `versions.lock` 同级的部署配置，并加一个验收项
（建议 A23 扩展：从 Miniflux 容器内 curl 元数据地址必须失败）。

**出路三：Bridge 不走 HTTP，直接把条目写进 Miniflux。** ⚠️ **本条的论据「Miniflux 没有
外部推送条目的 API」是错的**，这正是第 4 轮被纠正的地方。Miniflux **有**入向导入接口
`POST /v1/feeds/{feedID}/entries/import`（`api.go:55`），Bridge 可以走 HTTP API 推条目，
既不需要私改数据库，也不触发抓取器。最终采纳的方案就是这条思路的「走 HTTP」版本（ADR 0016）。
下面原文保留作历史。
方案 §11.1 明确写了「不实现：私改上游数据库」，这条与他的边界冲突，
而且 Miniflux 没有「外部推送条目」的 API。**不建议，列在这里只为完整。**

---

## 3. P0-B：WeRSS 采正文也要起浏览器，资源模型里漏了

### 实测调用链

方案 §4.4 要求「启用时必须同时打开正文采集和 RSS 全文输出」，
§21.5 给的配置是 `gather.model: web` + `gather.content: true`。跟着这两个键走：

```text
gather.content: true
  → core/wx/base.py:116   self.Gather_Content = cfg.get('gather.content', False)
  → core/wx/model/web.py:29   Gather_Content = self.Gather_Content
  → core/wx/model/web.py:112  if Gather_Content: item["content"] = self.content_extract(item['link'])
  → core/wx/model/web.py:15   from driver.wxarticle import Web as App
  → driver/wxarticle.py:14    from .playwright_driver import PlaywrightController
  → driver/wxarticle.py:29    self.controller = PlaywrightController()   ← 构造函数里就实例化
  → driver/wxarticle.py:81    async with PlaywrightController(...)
```

`config.example.yaml` 的 `gather` 段里还有一项方案没提到的：
`browser_type: ${BROWSER_TYPE:-firefox}`。

**结论：`model: web` + `content: true` 会启动 Playwright 驱动的 Firefox。**
`web.py:30` 那行日志自己就写着「Web浏览器模式」。

### 为什么这是 P0

方案 §12.2 的分层表里，「浏览器采集」这一层只写了
「RSSHub 所需浏览器能力 / 小红书/B站适配实测通过后启用」，
WeRSS 被单独放在「缺失公众号采集」层，启用规则是「账号、依赖和资源通过后增加」。
§12.3 的限额表里 `浏览器任务并发 1` 的语境也是 RSSHub。

也就是说：**2C2G 的资源模型里只算了一份浏览器开销，实际可能是两份**
（RSSHub 的 Chromium + WeRSS 的 Firefox），而且这两份的运行时、
镜像体积、内存峰值都不一样。他 §12.4 的 72 小时验收如果只压 RSSHub 那一层，
会在启用 WeRSS 时才发现装不下——而那时 P2 已经做完了。

他确实留了口子（§4.4「`gather.model` 支持哪些能力、正文是否需要浏览器，
必须按选定模式实测，不能从配置枚举直接推断全部可用」），
**这句预警是对的**，但 §12 的资源表没有随之调整，两处不一致。

### 一个更隐蔽的耦合

`main.py:72` 的自动补抓任务是 `if cfg.get("gather.content_auto_check", False)` 把门的，
他设 `content_auto_check: false`（理由是与 Bridge 重复触发，**这个理由是对的**）。
但这样一来，正文采集**只能**由 `get_Articles` 这条路径触发，
而它需要一个「按公众号触发采集」的入口——正是他 §4.4 标注为
「不固定臆造的刷新 API 路径」、需要实施者从锁定版本取真实路径的那个东西。

**所以这两个配置项是通过一个尚未验证的 API 耦合在一起的**：
如果那个单公众号更新动作不存在或不可调用，
`content: true` + `content_auto_check: false` 的组合结果是
**17 个公众号的正文永远为空**，而且不会报错——正好是我们最害怕的静默失效形态。
建议把这条写成 P2 的显式 gate：先证明能调用单账号采集并拿到正文，再关自动检查。

### 建议

1. §12.2 的「浏览器采集」层改成同时涵盖 RSSHub 与 WeRSS，
   两者**共享** `browser_concurrency: 1`（不是各 1），并分别记录内存峰值。
2. 阶段 0 的实测清单里加上 WeRSS：`model: web` + `content: true` 采 3 篇真实公众号文章，
   记录 Firefox 冷启动内存、单篇耗时、并发 1 时的 CPU 占用。
3. 如果 2C2G 装不下两份浏览器，**优先级判断**：知乎 115 源 vs 公众号 17 源（其中 49 个
   已有第三方转发可用）。按覆盖源数，RSSHub 的浏览器优先级高于 WeRSS。
   但这属于资源变更单的讨论范围（他 §19.3），不是我们能替他定的。

---

## 4. P1-A：Miniflux 自带全文提取，方案没用上

### 实测存在的能力

Miniflux 仓库里有三个方案完全没提到的东西：

| 能力 | 位置 | 说明 |
|---|---|---|
| Readability 提取 | `internal/reader/readability/readability.go` | 通用的正文抽取 |
| 每源抓取规则 | `internal/reader/scraper/scraper.go:21` `ScrapeWebsite(requestBuilder, pageURL, rules)` | 用 goquery 按 CSS 选择器提取；`rules` 为空时回落到 `getPredefinedScraperRules(pageURL)`（`scraper.go:39,96`），内置了一批站点的预定义规则 |
| 每源规则字段 | `internal/model/feed.go:38,169,193` `ScraperRules string \`json:"scraper_rules"\`` | **是 feed 级配置**，建/改 feed 时可传 |
| 按需取全文端点 | `internal/api/api.go:65` `GET /v1/entries/{entryID}/fetch-content` | 单条目重新抓正文 |

关键是它**已经接在正常处理流程里**：`internal/reader/processor/processor.go:111`
在常规 feed 处理中就调用 `scraper.ScrapeWebsite(...)`，
走同一个 `requestBuilder`（因此享有同一套限流、超时、私网防护），
失败时只记日志、不替换原内容（`:123-138`：`We replace the entry content only if the
scraper doesn't return any error`）。

### 为什么这能缩小范围

我们上一轮评审把「全文获取」定为**最大的新增工作量**（依据是全库 7474 条无一条存正文）。
方案 §6.1 的处理顺序是「从 Miniflux 读原始 HTML → Feed 已给正文就直接用 →
部分正文时做必要的一次补抓」，其中「补抓」被默认成 Bridge 要写的代码。

但按平台分布，**32 个博客 + 6 个 GitHub + 1 个 CSDN + 1 个掘金 ≈ 40 个源**
属于「原站可匿名访问、页面结构规整」这一类，正是 readability/scraper 的目标场景。
这部分**可能一行 Bridge 代码都不用写**：建 feed 时打开抓取、必要时填 `scraper_rules`。

需要说清楚的边界（避免过度乐观）：

- **对知乎/小红书/公众号无效**。这些原站要么要登录态，要么有反爬，
  Miniflux 的匿名 fetcher 拿不到正文。这三类仍走 RSSHub / WeRSS 的既有设计。
- **同样受 §2 的私网问题影响**（如果用内网地址）。对公网原站不受影响。
- **必须在锁定的 Miniflux 发布版上重验**。我们核的是 main（`76889f08`）。
  main 用的是 `scraper_rules`（规则字符串），而历史版本用过 `scraper_enabled`（布尔）。
  这个字段名在不同版本间**变过**，方案 §13.2 要求把版本锁进 `versions.lock`，
  这条正好是必须按锁定版本核的典型例子。

### 建议

阶段 1 的 gate 判据里加一条：**先用 Miniflux 原生能力测 3 篇真实博客文章，
再决定 Bridge 要不要自己写抓取**。他 §17.1 的 A10 已经要求「中文长文、代码、表格、
图片、公式各有真实样本」，把原生能力作为第一个被测对象即可，不增加新验收项。

---

## 5. P1-B / P1-C / P1-D：三处要补的细节

### P1-B：`append-recrawl` 不回源，但这是执行顺序的副产品

方案 §6.5 的状态机写：

> 仅链接对象、尚未向用户提供可批注正文 → 保留备注；验证后可 `append-recrawl` 补正文

字面看这条很危险：`recrawl` 顾名思义是「让 Karakeep 回去抓原站」，
而方案 §3.3 的整个立论就是**不能让阅读器二次抓取反爬原站**。

实测代码，**他的结论是对的**，但对的原因值得写下来：

```text
bookmarks.ts:191-203  case "append-recrawl":
                        await attachAsset({assetType: "precrawledArchive"})   ← 先 attach
                        if (ifexists == "append-recrawl")
                          await recrawlBookmark({bookmarkId})                 ← 再 recrawl

crawlerWorker.ts:386  if (precrawledArchiveAssetId) → 跳过 content-type 探测
crawlAndParse.ts:223  if (precrawledArchiveAssetId) → readAsset 直接用上传的 HTML，不调 crawlPage
crawlAndParse.ts:494  !precrawledArchiveAssetId 才做整页归档
```

因为 attach 在 recrawl **之前**，recrawl 跑起来时 precrawled 资产已存在，
crawler 走的是「读已上传 HTML」分支，**不会向原站发请求**。

**但方案里没有把这个不变量写出来**，而它是脆弱的：

- 如果实现者理解成「先 recrawl 再补资产」，就变成真实回源。
- 如果上游某个版本改了 `crawlerWorker` 的判定（比如让它重新探测 content-type），
  行为会静默变化。
- `overwrite-recrawl` 分支（`:163-188`）在有既存 precrawled 资产时走 `replaceAsset`
  再 recrawl，顺序同样是先替换后 recrawl，结论相同——但这条路径方案没提。

**建议**：把「recrawl 前 precrawled 资产必须已 attach」写成显式不变量，
并给 A11 加一个断言：**执行 `append-recrawl` 期间，对原文域名不产生任何出向请求**
（用抓包或代理日志验证）。这是少数几个「测一次就能永久防住回归」的验收项。

顺带一个运维数字：`recrawlBookmark` 有限流，
`packages/trpc/routers/bookmarks.ts:816-820` 是 30 分钟 200 次。
批量补抓历史条目时会撞到，Bridge 的队列要把它算进冷却。

### P1-C：§21.7 的 curl 示例会 403

singlefile 端点挂了**两个** scope 中间件：

```text
packages/api/routes/bookmarks.ts:122-123
  apiKeyScopeMiddleware("assets", "readwrite"),
  apiKeyScopeMiddleware("bookmarks", "readwrite"),
```

e2e 测试直接钉住了这个行为：
`packages/e2e_tests/tests/api/bookmarks.test.ts:643`
「should require assets:readwrite to upload singlefile assets」——
只给 `bookmarks:readwrite` 的 key 上传，断言 **403**。

方案 §21.7 的示例只用了 `Authorization: Bearer ${KARAKEEP_API_KEY}`，没说要哪些 scope。
§15.2 提到「项目升级可能引入细粒度 API scope，启用时验证只给所需资源权限」，
方向对，但**这不是「可能引入」，v0.33.2 已经在用了**。
P1 契约测试第一步就会卡在这里，建议直接把两个 scope 写进 §21.7。

### P1-D：[S05] 的证据指向 main，不是锁定版本

他给的 `bookmarks.ts` blob SHA 是 `2918d827d5de85268d06eaa006f2200461bad5fd`，
我们核对：这是 **main 分支**的版本。v0.33.2 的同名文件是
`19897113dffce7123b6386b3703d44f5fe65d66e`。**两者不同。**

他自己在 §3.2 和 [S05] 都警告过这个坑（「主分支文档中出现但该版本没有的字段，
不能直接写入部署脚本」「主分支代码必须与部署发布版对照测试」），
但引用时还是用了 main 的 SHA。我们替他做了对照，**结果无害**：

```text
main 相对 v0.33.2 在 bookmarks.ts 的全部差异：
  + import { rejectMutationInReadOnlyMode } from "../middlewares/readOnlyMode";   (main:18)
  + rejectMutationInReadOnlyMode,                                                (main:123)
singlefile 的处理逻辑、五种 ifexists 分支：完全相同
```

另外：**v0.33.2 里根本没有 `readOnlyMode` 这个中间件**（全仓 grep 无结果）。
所以如果将来想要「只读模式」，那是一次版本升级决策，不是配置项。

这条不影响任何结论，但值得记下来，免得 P1 重新核一遍。
也提醒一件事：**他给的另外两个 SHA（Miniflux `scheduler.go`、we-mp-rss
`config.example.yaml`）都与我们独立核对的结果逐字符相同**，
说明证据是真去取的，不是编的。这个纪律值得保持。

### 阶段顺序：机房 IP 实测应当前移（P1-D 的第二层含义）

方案 §19.1 把「登录态在 ECS 机房出口无效」列为风险台账第一条，
应对是「用真实授权小样本验证；未通过不冒充自动更新」——**判断完全正确**。

但 §18 的阶段表里，P0 是「资产与版本」，P1 是「阅读核心」，
登录态实测要到 **P2「来源与更新」** 才发生。

问题在于：**如果机房 IP 上登录态不可用，P2~P5 的形状会变。**
知乎 115 源 + 小红书 13 源 = 128 源，占总数 47%。
这 128 个源如果只能是快照，那么：

- §5.4 的内网缓存设计（P0-A）的必要性大幅下降——没有实时采集就不需要缓存中转
- §12.2 的浏览器层可能整个不启用，2C2G 的压力判断随之改变
- §8 的排序候选集里近一半来源没有新增内容，日报的「今日新增」会长期偏少
- A27「自动采集真实覆盖」的验收分母要重新定义

**建议把这项实测提到 P0，或单列一个 P0.5**，与我们方案主文档 §4 的
「阶段 0：凭证与风控实测（gate）」对齐。这不是新增工作，只是换顺序，
而它决定了后面四个阶段的范围。

---

## 6. 他抓到我们简报的一个真实错误

方案 §2.4：

> 手记公众号在简报中同时出现 17 和 18 两种口径；实际迁移以完整配置逐条对账，
> 保留差异记录，不通过删除一条记录强行对齐。

**这个不一致是真的，而且 17 才对。** 实测 `data/subscriptions.json`：

```text
platform=wechat 共 66 个
  其中 feeds 为空（手动登记）= 17
  其中 feeds 非空（第三方转发）= 49
无 feed 的源总数 149 = 知乎 115 + 公众号 17 + 小红书 13 + 掘金 1 + 播客 1
                      + blog 1 + Semantic Scholar 1
关闭展示（disabled=true）= 3
```

简报 §4 那行「其中 18 个是手动登记的公众号」是**笔误**，
与同文档 §4 三档表（17）、§4 末尾的 149 完整算式自相矛盾。已修正。
**只有那一处数字错了**：149 那条算式七项相加正好 149，本身是对的，
不要顺手「修正」它。

**容易被混淆的地方**（这也是笔误的可能来源）：简报 §7 的健康状况表里有一行
「feed 类 | 18 | …」，那个 18 是**报错的 feed 源数量**，
和「手动登记的公众号数量」是两件完全无关的事。修正时把这个区分写进了文档。

他处理这件事的方式值得肯定：**没有擅自选一个数字，而是标记差异并要求逐条对账**。
这正是 §16.2 迁移对账表该有的态度。

另外他 §2.4 声明「本次只有脱敏简报，没有完整 `subscriptions.json`……
因此本文不编造逐博主路由、第三方目录域名、实例磁盘大小或账号权限」——
这条自律是对的，也意味着 **P0 的 `source-manifest.json` 必须由我们自己从真实配置生成**，
不能指望方案文档里已经有。

---

## 7. 对我们七个问题的回答质量

他 §19.2 说「不再询问是否需要推荐、是否允许第三方逐作者 Feed……这些已由对话确定」。
逐条对照我们简报 §10 的七个问题：

| # | 我们的问题 | 他的回答 | 评价 |
|---|---|---|---|
| 1 | 全文获取链路怎么建 | §6 整章：五态内容模型（`FULL/PARTIAL/META/PROCESSING/FAILED`）、处理顺序、状态机、媒体上限 | **答得好**。五态模型比「成功/失败」布尔值强得多，`META` 态明确了「拿不到正文也要有卡片和原文链接」。但漏了 Miniflux 原生能力（本文 §4），且 §5.4 的传输路径有 P0-A |
| 2 | 登录态凭证怎么运维 | §14 整章：**以凭证组而非来源数为单位**、15 分钟本地状态检查、6 小时认证结论上限、八类错误的分类与恢复、告警不含凭证 | **答得最好的一章**。「共享一组登录态的 115 个知乎来源，发生明确认证失效时只做必要确认，暂停关联组，发送一条聚合告警，不继续用其余来源重复验证到封禁」——这条直接解我们当前的故障形态。§14.3「没有新文章与没有检查成功必须分开」也是对的 |
| 3 | 小红书要不要在服务器上跑浏览器 | §4.3、§12.2：目标里保留，但「目标中包含浏览器来源」与「2C2G 已证明能跑浏览器」不是同一结论；按资源门槛启用，未通过则任务保持阻塞，**不把平台移出范围，也不默认把 Mac 变成生产节点** | **答得诚实**。他没有假装解决了，而是把三个选项变成「验收通过才启用」的门槛。但这等于把问题推迟到 P2，配合 P1-D 的阶段顺序问题，风险集中 |
| 4 | 2C2G 够不够 | §12 整章：五层服务分层、首轮限额表、72 小时验收、「变更单优先讨论内存提升至 4 GiB」 | **答得务实**。明确区分「架构已决定」和「现有预算已足以满足全部负载」，后者标注为未知。但漏了 WeRSS 的浏览器（本文 §3），且 §12.5 承认没有磁盘容量数据 |
| 5 | 排序怎么冷启动 | §8.2：16 个 tag 作**来源级先验**，与文章级特征分开；权重相同时中性；「标签下有更多作者不能自动获得更高偏好权重」；另建可编辑主题词表 | **答得好，且纠正了我们提问里的隐含错误**。我们问「怎么用它冷启动比从零填主题词有效」，他的回答是：tag 只能当**来源级**先验（权重 0.3），文章级匹配（权重 0.7）仍要主题词表——因为「某位作者属于 Agent 标签，不意味着他每篇文章都是 Agent 内容」。这个区分是对的。§8.3 明确标注权重是「本文初始参数，不是离线实验或 A/B 测试结果」 |
| 6 | 17 个公众号要不要上自建采集 | §4.4 + §3.2：固定 `rachelos/we-mp-rss`（明确区分于已死的 wewe-rss），不迁移已有 49 条转发，只为仍无出口的启用；要求验证授权模式、API、正文链路 | **方向对，但资源代价被低估**（本文 §3）。「不为统一技术栈而替换已有 49 条可用转发」这条判断是好的 |
| 7 | 时间轴 UI 保留还是替换 | §16.4：过渡期保留旧站点为**只读历史和迁移对照**，不给它加推荐/全文/批注/账号；「迁移不需要先给旧应用新写 RSS 出口」；每个源切换成功后停止旧侧采集 | **答得干净，并且直接否掉了我们上一轮的「第五条路」**。理由与我们 v2 自我纠错一致：旧 XML 模块只有解析能力，不假定它能生成 RSS。这条等于确认了我们把「第五条路」降级为备选是对的 |

**七问七答，没有回避。** 其中问题 2 的回答质量超出预期，
问题 5 的回答纠正了我们提问里的一个隐含假设。

---

## 8. 本轮未核实的部分（诚实清单）

以下断言我们**没有**逐条核对，按风险从低到高排列：

| 方案位置 | 断言 | 为什么没核 | 风险 |
|---|---|---|---|
| §21.6 / [S12] | ntfy 的 `auth-default-access: deny-all`、`cache-duration`、外部推送上游依赖边界 | 标准配置，且他明确标注了「iOS 后台即时通知可能依赖系统推送服务」这个限制 | 低 |
| §13.4 / [S13] | Caddy `basic_auth` 与 `reverse_proxy` 的鉴权头冲突 | 他识别到的冲突（Basic Auth 无差别套到 Bearer API 上）是真实存在的经典问题 | 低 |
| §13.5 / [S15] | Docker 端口发布绕过 UFW | 上游文档明确记载的已知行为 | 低 |
| §19.4 / [S17][S18] | `pg_dump` 单库一致性、SQLite 在线备份 API | 两者都是上游文档的标准结论；他的推论（跨应用不会自动形成同一时刻全栈快照）逻辑成立 | 低 |
| §13.2 / [S08] | PostgreSQL 18 与 17 及以前的镜像挂载目录不同 | 未核 | 中：选错主版本会导致数据目录不匹配，但启动就会报错，不会静默 |
| §4.2 | RSSHub 各路由在**锁定版本**上的实际返回 | 本轮未重新克隆 RSSHub。上一轮已核：知乎路由需 `z_c0` + `d_c0`（`mergeGeneratedCookies` 只剔除 `d_c0`/`__zse_ck`），小红书路由 `requirePuppeteer: true` 且无 cookie 时把封面图当 `link`。他 §4.3 正确继承了这些结论 | 中：**路由实现变动频繁**，必须在锁定 commit 上重验 |
| §12.4 | 2C2G 上六个常驻服务的实际内存占用 | 无实测。他也没声称有，明确写了「以上都是测试阈值，不是已经测得的结果」 | **高**：这是整个方案能否落地的最大物理约束 |
| §4.2 | 机房 IP 上登录态是否可用 | 无实测。他列为风险台账第一条 | **高**：见本文 §5 的 P1-D |

我们核实的部分集中在 Karakeep v0.33.2、Miniflux main、we-mp-rss main
与本项目 `data/subscriptions.json`。**所有结论都是源码级/配置级的，不是运行结果。**

---

## 9. 结论

### 可行性判断

**方案整体可行，可以进入实施，但 P1 开工前必须先解决 P0-A 和 P0-B。**

理由：

1. **架构分层是对的**，而且他补的两个设计（§3.4 单一调度所有者、§6.2 五态内容模型）
   比上一版更扎实。§3.4 附带的清理循环发现是我们漏掉的。
2. **证据纪律是真的**。三个 blob SHA 两个逐字符相同，第三个是 main-vs-tag
   且差异无害。这在外部方案里不常见。
3. **两处 P0 都是「按方案照抄部署就会失败」的类型**，不是风格分歧：
   P0-A 会在第一个受限来源上失败，P0-B 会在启用 WeRSS 时才发现装不下。
   两者都集中在 P2，而 P2 之前已经投入了 P0+P1 的工作量。
4. **两个高风险未知数（2C2G 容量、机房 IP 登录态）方案自己都标注为未测**，
   没有伪装成结论。这点诚实很重要——它意味着阶段 0 的实测无法跳过。

### 建议在回给他的意见里明确要求

1. **§5.4 二选一**：要么改成「受限来源不经 Miniflux，Bridge 自存条目」
   （我们倾向这条，并相应修改 §10.1 数据归属表），
   要么保留内网缓存但把 `FETCHER_ALLOW_PRIVATE_NETWORKS=1`
   **连同元数据地址的显式网络层拒绝**一起写进部署配置与验收项。
   不接受「两个都要」——Miniflux 原生做不到（无主机白名单）。
2. **§12.2/§12.3 补 WeRSS 的浏览器开销**，与 RSSHub 共享 `browser_concurrency: 1`，
   并在阶段 0 实测 Firefox 冷启动内存。
3. **§4.4 补一条 gate**：先证明能调用单公众号采集并拿到正文，
   再把 `content_auto_check` 设为 false。否则 17 个公众号会静默无正文。
4. **§18 把机房 IP 登录态实测提到 P0/P0.5**，它决定 P2~P5 的范围。
5. **§6.1 增加一条**：先用 Miniflux 原生 readability/`scraper_rules` 测 ~40 个
   博客类源，再决定 Bridge 是否自写抓取。字段名按锁定版本核（main 是 `scraper_rules`）。
6. **§6.5 把「recrawl 前 precrawled 资产必须已 attach」写成不变量**，
   A11 增加「执行期间对原文域名零出向请求」的断言。
7. **§21.7 补 singlefile 需要的两个 scope**（`assets:readwrite` + `bookmarks:readwrite`）。
8. **§7.1 可以把「我的笔记」从不确定项改为确定项**：v0.33.2 的 spec 里有
   `GET /highlights`，官方描述即「跨所有书签的分页列表」。

### 我们自己要做的

- [x] 修正简报 §4 的 17/18 笔误（本文 §6）
- [ ] 阶段 0 的凭证健康检查与告警（方案 §14 的设计可直接采用，**不必等他回复**）
- [ ] 重贴登录态凭证（这次要带 `d_c0`，为 RSSHub 路由做准备）
- [ ] 从真实 `data/subscriptions.json` 生成 P0 的 `source-manifest.json`
      （他 §2.4 明确说了他没有这份数据，不会编造）
- [ ] 在 ECS 上实测机房 IP 的登录态可用性（最大未知数）

---

## 附：核对用的精确版本信息

便于 P1 复现本评审的核对结果：

```text
Karakeep   tag v0.33.2   commit 98c0c7896e855a5f2104f89651bb7e1322712df4  2026-08-11
           packages/api/routes/bookmarks.ts  blob 19897113dffce7123b6386b3703d44f5fe65d66e
           （方案 [S05] 给的 2918d827… 是 main 分支版本，差异见本文 §5 P1-D）

Miniflux   main          commit 76889f08b12c2577b37e524e645afa5dd46ff050  2026-09-11
           internal/cli/scheduler.go         blob 1cfad36747a1742ce04d0525ba4e0f3aec566f79
           （与方案 [S09] 给的 SHA 一致）

we-mp-rss  main          commit d8feb6a42c6773d7374e03c487d3ae3426084af8  2026-09-10
           config.example.yaml               blob 836183060b87b6ff24c57ff84dc5e36105ab553b
           （与方案 [S11] 给的 SHA 一致）

file-type  21.2.0        supported.js 的 mimeTypes 不含 text/html（本文 §1 的虚惊一条）
```
