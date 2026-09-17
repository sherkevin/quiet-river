# Quiet River 私人阅读平台：实施记录与运行边界

本目录实现路线 A：Miniflux 为文章与已读状态主库，Karakeep 为正文阅读版本与批注主库，Bridge 为来源台账、任务、推荐和日报。
需求依据包括用户最终修正：可以使用第三方逐博主转发；选择博主由用户完成；推荐与日报在本平台计算。
历史简报中的“无正文、无推荐、不推送”是旧产品定位，不约束新平台。

## 代码与入口

- `reader-bridge/server.js`：独立 HTTP 入口，默认只监听 `127.0.0.1:4380`。
- `reader-bridge/service.js`：统一刷新调度、Miniflux 导入、正文归档、日报、通知。
- `reader-bridge/database.js`：Node 22 自带 SQLite；WAL、任务恢复、来源映射、投递台账。
- `reader-bridge/network.js`：可信内部 API 与不可信 URL 获取分离；后者建连时校验 DNS 结果并逐跳验证。
- `reader-bridge/core.js`：完整来源迁移、Feed 正文保留、稳定 ID、规则推荐。
- `reader-bridge/public/`：移动端自适应卡片界面；不包含另一套文字高亮编辑器。
- `test/reader-platform.test.js`：隔离用例，不调用真实博主或云账户。

## 已固定的接口合同

首次主动导入文章必须显式 `status=unread`；重复导入可能改写已读且不会更新正文，因此不作为补正文方法。
记录返回的文章 ID，后续使用 `PUT /v1/entries/{id}` 更新正文。请求结果不明时先查存量条目，不盲目重发。
完整来源台账经 Miniflux OPML 创建来源。受限通道用禁用调度的身份记录，由 Bridge 调度并主动导入，不让 Miniflux 回拉私网。
`FETCHER_ALLOW_PRIVATE_NETWORKS=false` 不改变。普通来源与受限来源都不配置兴趣型入库屏蔽规则。

## 运行方法

要求 Node 22.13+（使用 `node:sqlite`），Ubuntu PostgreSQL 16 和官方 Miniflux/Karakeep 镜像。
数据库原生安装是目标 ECS 无法直连 Docker Hub 时的部署适配；不改变 Miniflux 使用 PostgreSQL 的数据归属。
数据库通过受认证 UNIX socket 提供给 Miniflux，不开放新的公网数据库端口。

1. 建立现有生产代码、数据、环境配置与 unit 的恢复点。
2. 管理员执行 `python3 deploy/bootstrap-platform.py`。脚本不回显凭证，也不覆盖已存在环境文件。
3. 核对镜像摘要，填写 Compose 插值文件，以 `deploy/platform-core.compose.yml` 启动应用。
4. 运行 `python3 deploy/configure-bridge.py` 创建本地 API 身份；它从已有安全配置读取站点口令，不改变口令。
5. 在本机配置 Karakeep 账户和 API key 后，将 `KARAKEEP_TOKEN` 写入 Bridge 环境文件；注册完成后关闭 `DISABLE_SIGNUPS`。
6. 使用 systemd 以普通服务用户运行 Bridge；通过现有受控入口暴露 `/desk/`。不要公网开放 3061/3062。

相关文件均在 `/etc/quiet-river-platform/`；实际数据在 `/var/lib/quiet-river-platform/`。
运行时 SQLite、环境文件、完整正文、私有凭证不得提交到 GitHub。

## 来源接入与刷新

原生 RSS 和现有逐博主转发可以直接进入 Miniflux。
知乎的文章/回答、小红书及 B站路由通过已有 RSSHub 适配，不在项目中实现反爬绕过。
WeRSS 只为有明确授权和公众号映射的来源接入；其正文依赖浏览器，不能当作纯 HTTP 服务估算资源。
对应环境开关默认为未验收：没有账号凭证、路由或浏览器资源测试时显示“待配置”，不能假装实时更新。
每次页面加载或点击刷新创建一个 run ID；活跃任务按通道合并。同组凭证失败后暂停整组。
限流时间对所有入口生效，不提供绕过冷却的“强制”按钮。
健康巡检只读取本地队列与时间戳；它不额外发平台请求。

## 内容和笔记

Miniflux 原有 Readability / CSS 提取可以复用。Bridge 不另写通用网页提取器。
归档对象通过 Karakeep SingleFile API 创建；保存后保留最初可供批注的正文版本，不无提示覆盖。
没有正文的条目可以建立带原文地址的整篇备注对象，不声称能在本站高亮尚未取得的文字。
`TEXT` 表示有文本可供保存，并非算法证明“完整原文”。完整性仍需来源级验收。
无 Meilisearch 时可读、可批注、可列高亮；不承诺全文搜索。
高亮接口与整篇备注是不同对象；“我的笔记”不能将无高亮但有整篇备注的文章漏报为无笔记。

## 推荐与日报

候选来自当前订阅，算法不新增来源、不丢弃未入选文章。
规则 v1 使用显式主题权重、关键词、作者权重、时效性及反馈，并进行软多样性调整。
不会将一个标签拥有更多博主理解成用户更喜欢它；也不会将划线直接视为点赞。
日报记录全部候选数量、算法版本、偏好快照、文章得分和来源缺口；未入选内容仍在全量列表。
默认时区 Asia/Shanghai、15 篇、每天当地时间08点后生成一次；均应在用户可见设置中说明。
日报内容是原有摘要/摘录，不进行外部大模型改写。

## 验证等级

单元测试、模拟接口测试、真实 API 合同测试、实际账号与站点测试、72 小时运行观察是不同等级。
本文件不是声称全部来源与负载已通过。每次交付需要附实际命令、版本、结果和未完成项。
不会因为 root 权限存在就声称已获得外站账号授权。

## 安全与回滚

升级不覆盖旧站 `data/` 和 `/etc/quiet-river/env`。先在独立端口验收，再发布入口。
服务以普通用户运行；root 只用于系统依赖、权限、备份和服务管理。
敏感日志不能收集环境变量全量输出。WeRSS 原入口有此问题，真实凭证接入前必须修正并验证。
上传正文必须是可信管道取得的内容，禁止 shell 执行和任意内网 URL 请求。
备份同时覆盖 Miniflux 数据库、Karakeep 数据与附件、Bridge SQLite、环境文件和版本锁；配置备份不能替代内容备份。
文章归档、实时网页和跨平台图片的稳定性须逐项验收；不以 HTTP 200 代替正文有效性判断。

## 参考接口

- Miniflux API：https://miniflux.app/docs/api.html
- Miniflux 配置：https://miniflux.app/docs/configuration.html
- Karakeep 最小安装：https://docs.karakeep.app/installation/minimal-install/
- Karakeep SingleFile：https://docs.karakeep.app/integrations/singlefile/
- 项目采纳记录：`docs/private-reader-platform-reply-r4.md`。
