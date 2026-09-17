# 0016 受限来源改用 Bridge 主动导入 Miniflux，单库不分家

状态：Accepted（2026-09-16）
取代：[0014](0014-Miniflux默认拒绝私网所以受限来源不经它入库.md)

## 背景

0014 核实了一条硬约束：Miniflux 的抓取器在 DNS 解析后、TCP 建连前检查目标 IP，
默认拒绝一切非公网地址（`internal/reader/fetcher/request_builder.go:184-199`，
判定函数 `IsNonPublicIP` 在 `internal/urllib/url.go:191-206`）。Docker 网段与
`127.0.0.1` 都在范围内。唯一的原生开关 `FETCHER_ALLOW_PRIVATE_NETWORKS` 是全有全无
的布尔值，上游只有三个 `ALLOW*` 配置项，没有按主机名放行的白名单。

这条约束推翻了实施方案 §5.4 的「Bridge 缓存内部 Feed → Miniflux 回拉」设计，
0014 据此得出「受限来源的文章由 Bridge 自己存」的结论。

外部评审人在复核中指出了 0014 的推理漏洞：**「Miniflux 不能拉内网」只否定了
出向路径，不等于「Miniflux 不能持有这些文章」**。还存在一条入向路径。
本轮核到了它的源码，结论成立。

## 决策

**受限来源（知乎 115 源、小红书 13 源，以及任何必须由 Bridge 代理采集的来源）的
文章仍然存进 Miniflux，由 Bridge 主动调用导入接口推入，不让 Miniflux 回拉。**

```text
普通来源：Miniflux 主动拉取公网 Feed → Miniflux 入库
受限来源：Bridge 调度采集 → Bridge 调 POST /v1/feeds/{feedID}/entries/import → Miniflux 入库
```

配套三条：

1. **`FETCHER_ALLOW_PRIVATE_NETWORKS` 保持 `false`**（继承 0014 的安全决定，不改）
2. **来源记录用 OPML 导入创建**，并带 `miniflux:disabled="true"` 属性，
   让 Miniflux 的调度器不去轮询这些通道
3. **全库单一文章主库**：条目、已读状态、分页、去重、日报候选集、备份恢复
   都按实施方案 §10.1 原样执行，不做双库合并

## 理由

### 一、导入接口是纯数据库写入，完全不碰抓取器

端点注册在 `internal/api/api.go:55`，handler 在
`internal/api/entry_handlers.go:354`。请求体结构 `entryImportRequest`
（`internal/api/messages.go:39-50`）接受：

```text
url（必填）、title、content、author、comments_url、
published_at（Unix 秒）、status、starred、tags、external_id
```

落库走 `internal/storage/entry.go:252` 的 `InsertEntryForFeed`，
整个函数只有 `Begin` / `getEntryIDByHash` / `createEntry` / `Commit`，
**没有任何 fetcher、scraper 或网络调用**（已核实函数体内 `updateEntry` 出现 0 次）。
正文在 handler 内就地清洗（`entry_handlers.go:429`：`sanitizer.SanitizeHTML`），
不经过抓取链路。

所以私网拦截在这条路径上根本不参与判断。**0014 的约束依然真实，只是不适用于它。**

### 二、OPML 导入创建来源记录也不碰抓取器，且支持禁用轮询

`internal/reader/opml/handler.go:60` 的 `Import` 是
「解析 → 查重 → 校验 → `store.CreateFeed`」，调的是 **storage 层**的 `CreateFeed`，
不是 `internal/reader/handler/handler.go:108` 那个会调抓取器的同名函数。

属性支持在 `internal/reader/opml/opml.go:47,50`：`miniflux:crawler`、
`miniflux:disabled` 等，映射在 `handler.go:125,133`
（`feed.ScraperRules = s.ScraperRules`、`feed.Crawler = s.Crawler`）。

`disabled` 的效果已核实：调度器取任务时带 `WithoutDisabledFeeds()`
（`internal/storage/batch.go:61-64`，条件是 `disabled IS false`），
**被禁用的通道不会进入轮询批次**。

**注意区分**：这里用的是 Miniflux 自己的 OPML 创建能力，
不是项目里那个会静默漏掉 149 个源的旧导出（`lib/opml.js` 只遍历 `sub.feeds`）。
迁移依据仍是完整的 `data/subscriptions.json` 台账，OPML 只是调用上游接口的载体。

### 三、双库的代价是真实的，不只是「多写点代码」

实施方案 §10.1 把全部条目与已读状态定为 Miniflux 单一权威。改双库要同时动：
数据归属表、全局条目 ID、跨库分页、跨库去重、已读状态的双写、
日报候选集的合并、备份与恢复的一致性。

最容易出错的是**推荐候选集**：不能「两边各取一页再拼接」当作完整候选，
那样排序会在两个局部有序集上算分，结果不可复现。
也不能继续把 Bridge 里的受限文章称作「随时可丢弃的缓存」——
128 源占总数 47%，那是要长期保存的知识资产。

**在有一条现成入向路径的情况下，先验证它，再决定是否承担这些成本。**

## 两个必须写进契约测试的副作用

核实源码时发现两处行为，与直觉相反，**必须在 P0 的接口验收里固定下来**，
不能只测一次返回 201 就算过。

### 一、不传 `status` 时默认是 `read`

`entry_handlers.go:384-386`：

```go
if importRequest.Status == "" {
    importRequest.Status = model.EntryStatusRead
}
```

首次导入如果忘了显式传 `unread`，文章会**直接以已读状态入库**，
在「未读」视图里永远看不到。日报的候选集定义是「最近 7 天发现、尚未标记已读」
（实施方案 §8.1），这批文章会**整批消失**，且不报错。

### 二、重复导入不更新正文，但**无条件重写已读状态**

`InsertEntryForFeed`（`entry.go:262-274`）先按 hash 查是否已存在：

```go
entryID, err := s.getEntryIDByHash(tx, entry.FeedID, entry.Hash)
alreadyExistingEntry := entryID > 0
if alreadyExistingEntry {
    entry.ID = entryID          // 只赋 ID，不写任何字段
} else {
    s.createEntry(tx, entry)
}
```

已存在时**不调用 `updateEntry`**（该函数内 `updateEntry` 出现 0 次），
所以标题、正文、作者、时间一律不变。

但 handler 在落库之后**无条件**执行
`SetEntriesStatus(userID, []int64{entry.ID}, importRequest.Status)`
（`entry_handlers.go:446`），而 `SetEntriesStatus`（`entry.go:412-428`）是一条
裸 `UPDATE entries SET status=$1`，没有任何「仅当未读时」的保护。

**合起来的后果**：把重新导入当作「补正文」的手段是无效的（正文不会变），
而每次重试都会把已读状态刷成请求里带的那个值。
如果 Bridge 的重试逻辑统一带 `unread`，用户读过的文章会被**反复重置为未读**。

### 因此对接约定固定为

1. 首次导入**必须**显式传 `status: "unread"`
2. 保存 `external_id`（用作 hash 输入，`entry_handlers.go:411-414`：
   `external_id` 为空时才退回用 URL 算 hash）与返回的 entry ID
3. **补正文走 `PUT /v1/entries/{entryID}`，不走重新导入**。
   该接口的请求体 `EntryUpdateRequest`（`internal/model/entry.go:88-91`）
   只有 `title` 和 `content` 两个指针字段，`Patch` 方法在值非空时才覆盖
   （`:93-101`），正好适合「先有摘要、后补全文」的场景。
   **这条路径同样会清洗正文**（`entry_handlers.go:337` 也调 `SanitizeHTML`），
   且**不触碰已读状态**。这一点核到了 SQL 层：
   `updateEntryHandler`（`entry_handlers.go:292-353`）全函数没有
   `SetEntriesStatus` 调用，落库走 `UpdateEntryTitleAndContent`
   （`internal/storage/entry.go:51-63`），那条 `UPDATE entries SET` 只写
   `title`、`content`、`reading_time` 与 `document_vectors` 四个字段，
   **`status` 不在其中**。两个要求一次满足，这是它优于「重新导入」的根本原因。

   一个会让实施者困惑的细节：**这个接口成功时返回 201 而不是 200**
   （`entry_handlers.go:351`：`response.JSONCreated`），
   哪怕它是更新语义。契约测试不要按 200 断言。
4. 请求超时后先按 `external_id` 或 URL 查询是否已写入，再决定重试，
   不靠标题去重

## 后果

- **0014 标记为 Superseded，但它的安全决定被完整继承**：私网开关保持关闭，
  不让 Miniflux 回拉内网地址。变的只是文章的归属位置。
- **实施方案 §10.1 的数据归属表不需要改**，这是采纳这条路径的主要收益。
  Bridge 的台账只存映射与健康状态，不存文章主库。
- **§5.4 的「内部只读缓存地址」设计作废**，`GET /internal/feeds/{channel_id}`
  这个接口不再需要。Bridge 的缓存仍然存在，但它的用途变成
  「采集结果的暂存与重试队列」，而不是「给 Miniflux 读的 Feed 端点」。
- **P0 新增一项接口验收**（在锁定版本上做，不在主分支上做）：
  创建来源 → 导入条目 → 查询 → 重复提交 → 补正文 → 重启恢复，
  外加一条**确认没有发生意外回源**（用代理日志或抓包验证
  Miniflux 对受限来源的原站域名零出向请求）。
- **`disabled` 通道不会自动获得任何更新**，Bridge 必须自己调度，
  这与实施方案 §3.4「只有一个刷新调度所有者」一致。
- **仍要在真实凭证接入前做的一次实测**：OPML 导入 271 个源后，
  Miniflux 的 feed 列表里 `disabled` 是否为真、`next_check_at` 是否不会被调度。
  源码层面的结论不等于部署层面的结论。

## 一个由本决议带出的不对称：屏蔽规则只作用于抓取路径

核实导入接口时顺带查了 Miniflux 的条目过滤规则（`block_filter_entry_rules` /
`keep_filter_entry_rules`，可按用户或按 feed 配置），发现两条路径行为不同：

| 路径 | 是否应用过滤规则 | 后果 |
|---|---|---|
| 常规抓取（`internal/reader/processor/processor.go`） | **应用两次**：`:75` 在抓取正文前，`:147` 在正文替换内容后 | 命中规则的条目走 `continue`，**根本不入库**，不报错 |
| 导入接口（`entry_handlers.go:354-466`） | **完全不应用**（该区间 `IsBlockedEntry` / `filter.` 出现 0 次） | 传进来就存，无视规则 |

这带来一个必须在实施时统一的行为差异：**同一套规则对普通来源生效、
对受限来源不生效**。如果我们将来配了任何屏蔽规则，普通来源的文章会被静默丢弃，
而 Bridge 导入的文章不会。

实施方案 §8.1 的要求是「源端发现、Feed 保存和元信息同步**不按推荐分过滤**」，
且 §4.5 要求「采集不预先按兴趣删除」。外部评审人也专门提醒
「不要拿 Miniflux 的保留/屏蔽规则来做兴趣推荐」。

**本决议采纳这条，并把它写成一条更硬的规定：第一版不配置任何
`block_filter_entry_rules` / `keep_filter_entry_rules`**，理由有两个：
一是它会静默丢条目，与「已发现内容全部保存」的产品要求冲突；
二是它在两条路径上行为不一致，排查时极难定位。
如果将来确实需要屏蔽（例如过滤某个源的推广条目），应当**在 Bridge 侧做**，
让规则对两类来源一致生效，并且被屏蔽的条目要留在台账里标记状态，而不是消失。
## 这次错误的方法论教训

0014 的推理是：「A 路径被源码证明不通 → 目标不可达 → 换架构」。
漏掉的一步是**穷举到达同一目标的其他路径**。

核实时只查了出向（Miniflux 能不能拉内网），没查入向（外部能不能推进去）。
一个系统的网络限制通常是不对称的：出向严格、入向宽松是常见设计，
因为出向代表「这个服务会主动连到不可信的地方」，入向代表
「可信的调用方通过认证接口写数据」。**看到「出向被拦」时，
应当立刻问一句「那入向呢」，而不是直接改架构。**

这条教训适用于后续所有「上游做不到 X」的判断：
先确认是「做不到」还是「这条路做不到」。
