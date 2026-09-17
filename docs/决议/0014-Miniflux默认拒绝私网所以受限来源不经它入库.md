# 0014 Miniflux 默认拒绝私网地址，所以受限来源不经它入库

状态：**Superseded by [0016](0016-受限来源改用Bridge主动导入Miniflux单库.md)（2026-09-16，同日推翻）**

> **本决议的安全判断仍然成立并被 0016 继承**：不开 `FETCHER_ALLOW_PRIVATE_NETWORKS`，
> 不让 Miniflux 回拉内网地址。
> **被推翻的是它的推论**：「受限来源的文章必须由 Bridge 另建主库」。
> 推翻理由是漏查了 Miniflux 的**入站导入接口**
> `POST /v1/feeds/{feedID}/entries/import`——Bridge 主动推条目给 Miniflux
> 走的是 API 认证与可信内部通信，**不经过抓取器**，因此不受私网拦截约束。
> 「采集调度归 Bridge」与「文章必须存 Bridge」之间没有必然绑定，
> 本决议错误地把后者当成前者的唯一推论。
>
> 保留本文是为了记录这个推理错误的形状：
> **把「A 路径不通」直接当成「目标不可达」，而没有穷举到达同一目标的其他路径。**
> 核实时只查了「Miniflux 能不能拉内网」（出向），
> 没查「Bridge 能不能推进去」（入向）。

## 背景

外部评审人的实施方案 v1.0（`docs/private-reader-platform-impl-v1.md`）§5.4 给了
「受限来源」这样一条数据通路：

> Bridge 先通过同一账户/平台的限制器执行采集，将成功原始 Feed 缓存到本地，
> 再让 Miniflux 读取内部只读缓存地址。缓存地址只返回内容，不再次触发爬虫。

配套接口是他 §11.2 的 `GET /internal/feeds/{channel_id}`，§10.1 又把
「Feed 条目原始内容」的唯一权威存储定在 Miniflux / PostgreSQL。
合起来就是：**知乎 115 源 + 小红书 13 源（共 128 源，占 271 源的 47%）的条目
要经 Miniflux 入库**，而 Miniflux 取它们的唯一途径是访问 Bridge 的容器内网地址。

这条通路成立与否，决定 P2 之后四个阶段的形状，所以在开工前先核了源码。

## 决策

**受限来源（知乎、小红书，以及任何必须由 Bridge 代理采集的来源）不经 Miniflux，
由 Bridge 自己存条目。** `GET /desk/api/items` 合并两个来源的列表返回给前端。

相应地，实施方案 §10.1 的数据归属表要改：「Feed 条目原始内容」不再是
Miniflux 单一权威——**原生 RSS 类来源的权威在 Miniflux，受限来源的权威在 Bridge**。
已读状态在两边各存一份，或统一只在 Bridge 存（实施时定，倾向前者，
因为 Miniflux 的已读 API 是现成的）。

**不采用**「打开 `FETCHER_ALLOW_PRIVATE_NETWORKS=1` + 网络层封堵」这条路，
理由见下。

## 理由

### 一、Miniflux 默认在 dial 阶段拒绝一切非公网地址

核对 Miniflux main（commit `76889f08b12c2577b37e524e645afa5dd46ff050`，2026-09-11）。

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

上游注释说明这个检查放在 dialer 的 `Control` 回调里、**在 DNS 解析之后建连之前**执行，
目的是消除 TOCTOU / DNS rebinding（「the resolved IP that is checked is exactly
the IP that will be connected to」）。**这个设计是对的，但对我们的方案是硬墙。**

`internal/urllib/url.go:191-206` 的 `IsNonPublicIP` 覆盖
`IsPrivate() || IsLoopback() || IsLinkLocalUnicast() || IsLinkLocalMulticast() ||
IsMulticast() || IsUnspecified()`，外加 `url.go:15` 专门定义的
`rfc6598SharedAddressSpacePrefix = 100.64.0.0/10`。

Docker 的 bridge 网络（`172.17.0.0/16`）、compose 自定义网络、`127.0.0.1`
**全部落在 `IsPrivate()` 或 `IsLoopback()` 里**。实施方案 §21.3 的 Miniflux 配置样例
没有这一项，所以按方案照抄部署，**第一个受限来源就会失败**，
错误是 `fetcher: refusing to access private network host`。

`internal/http/client/client.go:45-70` 还有第二道：解析出的所有 IP 若全是非公网，
直接 `ErrPrivateNetwork`。**两道都得过。**

### 二、这个开关是全有全无的，而方案想要的是白名单

列出 `internal/config/options.go` 里所有 `ALLOW*` 配置项，只有三个：
`FETCHER_ALLOW_PRIVATE_NETWORKS`、`INTEGRATION_ALLOW_PRIVATE_NETWORKS`、
`METRICS_ALLOWED_NETWORKS`。**没有按主机名的白名单机制。**

而实施方案 §15.3 要的是：

> 内部缓存 Feed 需要显式允许访问指定服务，但不意味着给采集器开放全部私网地址。
> ……屏蔽云元数据、环回和无关内网。

**这个要求 Miniflux 原生做不到**：要么全关（§5.4 不可用），要么全开（§15.3 不可用）。

### 三、在阿里云上「全开」的代价比方案预想的严重

方案 §15.3 把「屏蔽云元数据」和「允许指定内部服务」当成可以同时满足的两件事，
实测它们冲突：

```text
阿里云元数据地址 100.100.100.200
  落在 100.64.0.0/10（RFC 6598 运营商级 NAT 段）内 → True
  而常规 is_private 判定 → False（这正是需要专门加 rfc6598 检查的原因）
```

Miniflux 专门定义这个前缀并单独判它，说明上游很清楚这个段的风险。
把 `FETCHER_ALLOW_PRIVATE_NETWORKS=1` 打开，等于**亲手拆掉一道专门针对云元数据的
SSRF 防护**，而我们的部署目标正是阿里云 ECS（方案 §13、ADR 0013）。

这不是理论风险：正文抓取链路要处理**不可信的外部 HTML**（方案 §15.3 自己也这么定性），
一个被污染的 feed 条目 URL 或一次重定向就可能把 fetcher 引到 `100.100.100.200`。

### 四、为什么选「不经 Miniflux」而不是「全开 + 封堵」

「全开 + 在安全组/iptables 上显式拒绝出向访问 `100.100.100.200` 与 `169.254.169.254`」
技术上可行，方案 §13.5 的「采集网络、应用网络和数据库网络分开」方向也对。
不选它的原因是**它把一道上游写死的安全默认值换成了我们自己维护的网络规则**，
而这条规则一旦在后续变更里被漏掉（换镜像、改 compose 网络、加服务），
失效是静默的，且后果是凭证与元数据外泄级别。

「不经 Miniflux」则**完全绕开问题**，而且它承认了一个事实：
受限来源和原生 RSS 源在数据模型上本来就不同类——受限来源需要 Bridge 的
限制器、凭证组（见 0015）、`rate_limit_group`、`gap_suspected` 缺口记录这些
Miniflux 没有的概念。硬塞进同一个 feed 表是为了架构整齐而付出的代价。

## 后果

- **好处**：P0-A 这个阻塞项消解；不依赖 Miniflux 的私网策略变化；
  受限来源的健康状态、缺口记录、凭证组都能放在 Bridge 台账里统一表达，
  不必在两个系统之间来回映射。
- **代价**：Bridge 的 `registry` + `sync` 模块工作量上升（要自己存条目、
  自己做去重与分页），§10.2 的 `items` / `item_sources` 表要真的实现而不只是合同。
  列表接口要合并两个数据源，排序（§8）的候选集也要跨两边取。
- **仍然成立的部分**：原生 RSS 类来源（122 个有 feed 的源）照原方案走 Miniflux，
  §3.3「保留 Miniflux」的核心理由不变——已核实 Karakeep 的 `feedParser.ts`
  只取 `id/link/guid/title/categories`，创建书签时只传 `url/title/source`，
  **RSS 里已有的正文被丢弃**，所以仍需 Miniflux 这一层接住正文。
- **验收新增一条**：从 Bridge 容器内 curl 云元数据地址必须失败
  （即便我们不打开那个开关，也要验证网络层本身是封闭的）。
- **如果将来 Miniflux 加了主机白名单**，本决议可以重开——那时「经 Miniflux」
  会重新变成更省事的选项，且不需要牺牲 SSRF 防护。
