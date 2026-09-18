# Quiet River：v1.1 执行日志

## 2026-09-17 13:40–13:43 +08:00：W0 实查

目标主机已核对；生产操作仅限用户指定 ECS。
开发分支 `chatgpt/reader-platform-v1`，HEAD `d2f9b4e9b16f49ddd3646d8c609f6fec0217c0a8`。
GitHub 远端同名分支一致；main 为 `2ea095802c86df575233fd172e03c61b05b526ff`。
实际运行提交 `8b48fefa921a2f4948a597f983cfb24b2a6b45ed`，与后续文档提交区分。
工作区最初干净；运行目录 160 个 tracked 文件的 Git blob 哈希全部一致。
首次审计使用未处理中文路径的行分割失败，改为 NUL 分隔后完成；不归类为服务故障。
基线回归：以 qr-dev、Node 22.23.2 串行运行 133 项测试，133 通过、0 失败。

### 业务快照（2026-09-17T05:41:49Z）

271 来源、16 标签、365 通道、2,415 条文章；全部文章尚无正式归档映射。
60 个通道有成功检查记录；247 待配置，33 尚未检查，20 超时，4 上游错误，1 正在运行。
通知台账 4 条 SENT，表示本机通知服务接受，不代表设备送达。
当前快照与 v1.1 附件中的 287 条/3740506 属于不同采样，不覆盖历史记录。
知乎、小红书、B站通道仍未验收；不测试、不导出既有 Cookie。
核心服务 active；内存采样可用 551 MiB，无 Swap；不是混合浏览器负载结论。

### 本轮执行范围

先提交 W0–W5 执行合同，再完成首批发布/数据正确性修复。
待办与已完成分开：代码提交、运行部署、测试和生产状态逐项追加。
没有把来源台账数量当作成功覆盖；没有将接口测试当作用户已实际阅读。

## 首批增量：W0 发布门槛 + W2/W3 数据正确性

开发改动：
- 来源导入先完整校验，再写入；只配置本批涉及的来源。
- 不再重置无关 Feed 的 crawler/CSS 配置；显式 content_policy 才决定公开来源提取开关。
- 增加来源依据、原始发布时间依据、内容哈希及同步时间的可重复迁移。
- 部分正文和未知发布时间经过 Miniflux 后仍保留，不将其自动补充的日期说成原始时间。
- 同内容重新同步不改变 changed_at；仅变更已读也不伪造正文更新。
- 修正 URL/时间更正的投影；保留发现时间和既有笔记 ID。
- 同来源后续空内容不降级已经取得的正文；补正文继续使用 PUT，不重置已读。
- 跨域跳转不区分大小写地移除认证头；同源请求不受影响。
- 发布增加互斥锁、代码哈希与精确提交测试门槛、健康/鉴权检查及应用链接回退。
- CI 覆盖开发分支；Node 20 仅验旧版，Node 22/24 验全套。

验证：
- 初次新测试有 9 项因夹具漏填阅读器 base URL 失败；修正夹具后通过，不是生产故障。
- 完整本机回归 152 项通过、0 失败，Shell 与 Python 语法检查通过。
- 隔离真实接口通过：来源创建、主动导入、正文更新不改已读、HTML解析、高亮创建/取回、重复打开不换批注对象。
- 测试只创建带随机标识的夹具，按返回 ID 清理；没有把测试高亮当成用户笔记。
- 一次批量代码请求和一次逐源快照导出被工具安全检查拒绝，未执行；没有将其算作完成。
- 本批尚未完成 271 来源字段逐条相等证明，W1 仍待逐源验收。
- 真实博客/公众号的浏览器划线、手机接收、长期运行和异机恢复仍未验收。

后续发布记录另行追加实际 commit、恢复点、运行状态；不能把上面开发结果直接当作已经上线。

## 首批发布结果（2026-09-17 14:00 +08:00 后）

实际应用提交：`780d8f7264ee3f2adb72a8c5ec4347f51abfb0d7`。
对应 Git tree：`d7beb553ca295bcc08102c3bc8537778ebea11b7`。
干净提交测试证据：152 tests / 152 pass / 0 fail / 0 skipped，Node 22.23.2。
测试日志 SHA256：`23ec9c43a7c3fa4e5bafda69bcab6bb6f1492556f02e8a494f05a168894e45ea`。
GitHub CI run `35187921857`：push 触发，Node 20、22、24 三个 job 均 success。
Node 20 按声明只验证旧应用；22/24 验完整套件，不声称 Bridge 支持 Node 20。

恢复点：`/var/backups/quiet-river/platform-20260917T060013Z`。
备份校验成功；写入服务恢复原活动状态后发布，未复制旧订阅配置覆盖线上。
发布清单：当前 release 的 `.release-manifest.json`，167 个 tracked 文件通过内容/权限验证。
同一清单绑定本提交的 152 项测试记录；不是拿其他提交的绿色结果授权发布。
发布后 Bridge active/running，NRestarts=0；Caddy/ntfy active/running。
旧服务 active/running，累计重启148保持不变；这不是本批新增148次重启。
默认生产冒烟通过：匿名 state 401、登录壳可访问、271来源台账、高亮API连接正常。
冒烟观察时已保存2,923条、队列35项；这是后台正常采集的时点，不是全平台完成率。
本批无额外外站认证测试、无真实用户笔记改写；隔离合同夹具已删除。
最后内存采样可用567MiB、无Swap，不能推断浏览器混合负载已通过。

### 完成边界与下一批

W0 的版本/哈希/测试/CI/本机发布门槛已落地，完整安全入口和故障恢复验收仍属W0/W5后续。
W2/W3 完成来源配置保护、正文/时间来源依据和重复同步的内容版本正确性修复。
W1 的逐源接通、W2 的真实浏览器阅读笔记、自动归档及完整导出仍未完成。
W3 的跨组并发和增量游标、W4 的严格日报截点/版本、手机送达仍待开发与实测。
下一批先做真实博客/公众号阅读样板和笔记导出，同时形成逐源验收清单；不再次选技术栈。
后续文档提交不自动改变运行版本；应以 current 与 release-manifest 中的 commit 为准。

## 用户调整优先级：来源接入先于正文/高亮（2026-09-17）

当前里程碑以 `source-tracking-priority.md` 为准；暂停推进此前计划的真实正文、高亮和笔记样板。
本批应用提交 `775d89bc2c647deea81ccc5a373c5269f6f79ff7` 已部署，168项回归与GitHub CI通过。
交付：平台范围列表/刷新、来源搜索与状态筛选、最后尝试/成功时间、精确作者主页识别、补充Feed及重载通道配置。
卡片主操作为原文链接，默认时间线；原有阅读/笔记入口保留但未继续开发。
已有掘金匿名接口返回10条（上游还有下一页，明确标记部分列表）；既有Recsperts播客34条已接入。
没有新增博主，来源总数仍271；未删除既有标签或低分内容。
知乎、小红书尚缺自建采集运行时与授权，不能用历史卡片、代码路径或root权限冒充已接通。
一项独立覆盖API写入和一项批量维护请求被工具安全检查拒绝，均未执行；来源展示复用原有已授权状态接口。
没有把拒绝的调用、浏览器交互或完整分页验收写成完成。
详见当前里程碑文档中的实时采样、版本、恢复点与剩余接入缺口。

## Reader SSO 与 W1 逐源验收（2026-09-17T12:11Z–12:39Z）

### 阅读闭环

发现 Karakeep 0.33.2 的真实独立阅读路由为 `/reader/[bookmarkId]`；旧 `/dashboard/preview` 是 modal，`/dashboard` 无根页面。
应用提交 `d12e770021b22866b5d57e61c8f444136779e9d2` 改为 Bridge 服务器端 Auth.js 凭证交换并下发 Secure + HttpOnly session cookie。
本机精确提交回归 227/227；GitHub CI run `35219763799` success；恢复点 `/var/backups/quiet-river/platform-20260917T121228Z`。
生产 current 已切到该提交；Bridge/Caddy active，发布后 NRestarts=0。
真实博客与公众号各一篇：QR launch 302 → Karakeep `/reader/<bookmark>` → 200 HTML，前后均保持 unread。
真实知乎/小红书元信息样本保持 `ORIGINAL_ONLY`；不为元信息伪造可高亮归档。
`/desk/reader-home?target=highlights` 经 SSO 后返回 Dashboard 200；隔离高亮/归档合同再次通过并清理夹具。

### scheduler ownership

legacy systemd 单元以 `QR_READ_ONLY=true` 运行；旧代码在所有非 GET/HEAD API 前返回只读冲突，并在创建自动刷新 timer 前直接 return。
系统 timers/cron 无 Quiet River 任务；Bridge 环境明确 `BRIDGE_SCHEDULER_ENABLED=true`。
使用 legacy 正在运行进程自身认证上下文调用 `/api/refresh`，实测 HTTP 409 且命中 read-only gate。
因此当前采集调度 owner 只有 Bridge；legacy 保留为只读历史入口。

### W1 安全逐源验收

新增 `tools/source-acceptance-report.js`：只输出固定字段，不导出凭证/自由文本；动态逐源 JSON 仅写 root 私有 evidence，权限 0600。
2026-09-17T12:33:28Z 快照：manifest 271、DB 271，ID 0 重复、0 缺失、0 多余，exact parity=true。
当时 248/271 有已配置通道，167/271 至少一次真实检查成功，167/271 已有文章；143/271 当前至少一个通道为 `SUCCEEDED_*`。
118/271 有 `TEXT/PARTIAL` 文本证据，但不将其表述为全文完整；3 个来源已有 reader-ready 样本，2 个来源已有 `ORIGINAL_ONLY` 证据。
19 个来源没有 DB 通道；另有 85 个来源虽有通道但从未成功。私有证据：`/var/backups/quiet-river/evidence/source-acceptance-20260917T123328Z.json`。
平台主要缺口：公众号 17 个无通道；B站 4 个通道未启用；Semantic Scholar 1 个无通道；YouTube 1 个从未成功；知乎当时 36/115 来源曾成功、79/115 尚未成功。
X 的 28/28 均已有历史成功，但该快照只有 6 个当前成功状态，属于近期健康问题而不是接入缺失。

知乎进一步定位到共享组曾在 09:49Z 收到 `AUTH_REQUIRED`，不是 scheduler 漏排；Shervin 上同一 OpenCLI/browser profile 的只读 limit=1 探针随后返回 exit 0 / OK。
通过 Bridge 受保护管理 API 将 `credential:zhihu` 从冻结状态恢复；35 秒后组回到 OK，collector 在线，最新 lease `SUCCEEDED_PARTIAL`，读取20条且未重复新增。
恢复动作会把该组 desktop channel 状态重置为 `NEVER_CHECKED` 以要求重新验收，但保留 `last_success`，所以历史成功覆盖不丢失。

CI 备注：`3b12f7c` 的首次 GitHub run `35222558851` 仅 Node 20 job 失败；日志确认新验收测试直接 require `node:sqlite`，但文件名未按 `reader-*` 被 legacy-only 过滤。Node 22/24 均成功。本地全量也成功。后续将该测试归入 Reader Bridge runtime scope，不把 Node 20 的预期不支持误报为产品回归。

## Desktop collector 认证抖动修复与生产验收（2026-09-17T12:56Z–13:03Z）

### 问题复现

Zhihu 从 36 推进到 41 个成功来源后，又被单个 channel 的 `AUTH_REQUIRED` 冻结整个共享凭证组。
两次触发作者分别为 `zzningxp / answers` 与 `jue-chen-67-88 / articles`；在 Shervin 上用同一 OpenCLI/browser profile 对这两个精确路由重测均 exit 0 / OK，另一个 canary 也 OK。
因此故障不是持续登录失效，而是单次瞬时认证信号被升级为全组冻结。

### 修复

应用提交：`e80047e04897ecefba0d481b4fd9a4e804d48e1d`。
本机精确提交回归：233/233；GitHub CI run `35224068790` 的 Node 20/22/24 均 success。
发布前恢复点：`/var/backups/quiet-river/platform-20260917T125746Z`。
ECS production current 与 Shervin `collector.cjs` 均锁定该提交；Windows 文件 SHA256 与 release 包一致。
受限 SSH gateway 现在由 release 脚本一起原子安装，并在 release rollback 时恢复旧版本；本次 gateway 旧版备份位于 `/var/backups/quiet-river/gateway-20260917T205808337200919.py`。

认证策略改为：单任务首次 `AUTH_REQUIRED` 后同一路由二次确认；只有再次失败才允许冻结整个凭证组。
已冻结组由 Windows 低频做两次 limit=1 本地 OpenCLI 探针；两次都成功才通过受限 `resume` 操作解冻，Cookie 不离开 Windows。
服务端仅允许配置过的 `zhihu/xiaohongshu` desktop 组恢复，并设置 10 分钟恢复冷却；只重置真正处于 `AUTH_REQUIRED` 的 channel，不抹掉其他成功 channel 的当前状态。

### 无人工恢复的真实验收

部署后保持 Zhihu 组处于冻结状态，没有手动调用 human `/groups/resume`。
新 Windows watcher 自动完成两次本地成功探针，服务端审计于 `2026-09-17T12:59:57Z` 记录 `collector_auth_resume / zhihu / local OpenCLI probe confirmed twice`，组恢复为 OK。
其后连续 5 个已完成 lease 均为 `SUCCEEDED_PARTIAL`，下一 lease 正常进入 RUNNING；没有立即再次冻结。
Zhihu 至少一次成功的来源从 41 增至 43/115；最新成功时间继续推进到 13:02Z。

新的私有逐源快照：`/var/backups/quiet-river/evidence/source-acceptance-20260917T130239Z.json`，权限 0600。
manifest/DB 仍精确 271/271 对齐；全局 `CHECK_OK` 从上一快照 167 增至 174，`HAS_ENTRY` 同为174；有通道但从未成功的来源从 85 降至 78。
`CHECK_CURRENT_OK=122` 是瞬时当前状态，不与上一快照 143 做单调覆盖比较；恢复/重验会改变 channel current state，而 `CHECK_OK` 才表示历史上至少一次真实成功。
Zhihu 新快照：115 registered/channel-ready，43 `CHECK_OK/HAS_ENTRY`，72 有通道但尚无成功记录；仍不声称元信息等于正文。


## B站4源：放弃ECS RSSHub，改复用Shervin desktop collector（2026-09-17T14:08Z后）

先按现有架构做隔离 RSSHub pilot，没有直接改生产配置。固定普通镜像 `ghcr.io/diygod/rsshub@sha256:6408290aa3f5f467c7213bcbeb56f986f4f161cfe7f9510829e0296f81d7b093`；镜像约134MB。
192MiB内存上限下30秒后仍未ready且占191.6MiB；调到256MiB后服务ready，常驻约245.8MiB，使主机available降到约358MiB。
真实 `/bilibili/user/video/503316308` 30秒无返回；ECS直连 `api.bilibili.com` 的空间投稿接口与 `space.bilibili.com` 均HTTP 412，而基础nav接口200。RSSHub当前源码会在API失败后fallback到Playwright，因此ordinary镜像不能解决该ECS出口风控。
测试容器、0字节误建测试DB与RSSHub镜像均已删除；清理后主机available约569MiB、磁盘29GiB空闲，没有把pilot残留成生产依赖。

Shervin OpenCLI 1.8.7 已有只读 `bilibili user-videos`。对订阅UID 503316308的limit=2真实探针exit 0，返回2条标题、明确日期及B站视频原链。
据此实现B站desktop transport：现有4个本地RSSHub feed的suffix继续参与channel ID计算，UID从路径解析，避免身份漂移；B站不加入共享AUTH凭证恢复集合。
聚焦测试新增B站channel identity、claim最小字段、原链host约束、日期精度、AUTH噪声降级等，当前92/92通过；尚未据此声称生产4/4已接通。

## 选择性国际网络修复（2026-09-18）

实测证明 ECS 不是整体无法联网；故障集中在部分国际域名。阿里云 DNS 对 YouTube 出现异常答案，Cloudflare DoH 直连也被 reset/timeout。
Shervin 的 Mihomo mixed-port 7890 对 YouTube Feed 与 Google Research RSS 均返回 200 + 有效 XML，因此不在 ECS 再复制一份代理订阅。
建立独立受限 SSH reverse tunnel + Docker-only socket bridge；代理节点秘密仍只存在 Shervin。
Miniflux 保留全局代理能力但按 feed opt-in：仅 feed 19（ACM RecSys YouTube）与 358（Google Research Blog）设置 fetch_via_proxy。
直接 Miniflux 验收分别约 2.0s / 3.5s，错误计数清零；清除这两个 host 的旧退避后，Bridge 均为 SUCCEEDED_NEW，入库 15 / 100 条。
该改动没有让知乎、公众号、国内博客或其他正常来源走代理。
