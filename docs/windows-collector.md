# Shervin Windows 采集节点：一键同步到 ECS

## 1. 这次连接的边界

用户明确授权在 Shervin 上工作，Windows 上已安装 OpenCLI 1.8.7、Node 24.13.0、Browser Bridge 扩展。
本方案使用本机已登录浏览器执行只读作者列表命令，不读取浏览器 Cookie 数据库，不导出浏览器会话。
项目现状简报已说明小红书旧通道依赖本机浏览器；不能承诺把 Cookie 写进 ECS 环境变量即可迁移该能力。
因此采用：Windows 采集元信息 → SSH 加密上传 → ECS 主动导入 Miniflux → 正常展示、继承标签与记录已读。
作者列表采集仍只负责发现条目；正文补全现在是独立的 `entry_body_v1` 低耦合任务，不把单篇正文失败放大成整个博主刷新失败。图片下载仍不做；高亮由 ECS/Karakeep 独立处理。

## 2. 运行方式

`tools/windows/Check-Connection.cmd`：检查本地 OpenCLI/扩展和受限 ECS 通道，不抓博主。
`tools/windows/Sync-Now.cmd`：一键执行，最多20个当前可运行的作者通道任务；受冷却影响可少于20。
`tools/windows/Start-Watch.cmd`：前台保持连接，领取网页刷新或服务器调度产生的任务；关闭窗口就停止。
一个知乎作者的回答、文章是两个通道，不把“20个任务”写成“20位博主已完整更新”。
单次查询最多20条；窗口之外的历史/漏更覆盖尚未证明，成功状态明确为部分列表。
没有原始日期的小红书条目保留“发布时间未知”，不从 note ID 猜发布时间。

## 3. 两端配置位置

Windows：`%LOCALAPPDATA%\QuietRiverCollector\config.json`、专用 SSH 私钥、固定主机公钥、待上传结果。
ECS：`/etc/quiet-river-collector/agent.env`，只保存本机接收鉴权和桌面采集平台配置。
ECS 写入 `QR_COLLECTOR_TOKEN`、`QR_DESKTOP_PLATFORMS`；不冒充上传了知乎或小红书 Cookie。
平台 Cookie 留在用户的浏览器中，也不通过 ChatGPT、GitHub 或日志传递。
Windows 当前系统自带 OpenSSH 执行未成功，已确认 Git 附带 OpenSSH 9.7 可用，配置指向该版本。

## 4. 安装

在 Windows PowerShell 运行 `Setup-Collector.ps1`，指定 ECS 地址和从可信管理连接核验的服务器公钥。
脚本只建立独立采集目录、生成专用密钥和固定 known_hosts；不改用户现有 .ssh/config 或 D:\quiet-river 工作区。
将 Windows 公钥（不是私钥）通过已有管理员通道放到 ECS，执行：

```bash
python3 tools/windows/install-ecs.py /path/to/collector-public-key.pub /path/to/proxy-tunnel-public-key.pub
```

它创建专用 `qr-collector` 用户，SSH key 带 restrict 和 forced-command：不能取得 shell、端口转发、TTY 或 sudo。
提供第二把公钥时另建 `qr-proxy-tunnel`；它只能在 ECS loopback 监听固定 17890 端口，不能取得 shell、sudo 或开放公网代理。
采集网关只接受 claim / submit / status / resume 四类受限 JSON，并经本机 API 调用 Bridge；不接受任意文件路径或命令。
服务配置的更新通过 systemd EnvironmentFile 生效；安装后仍须用精确提交测试和受控发布流程重启应用。
服务器公钥不符时必须重新核对，不使用 StrictHostKeyChecking=no。

## 5. 数据与任务语义

- 博主/标签以 ECS 为准，Windows不自行添加博主或传递第三方推荐列表。
- 网页刷新、自动更新、Windows一键执行共用 ECS 通道队列；普通 Feed 仍在服务器抓取。
- Windows每次只领取一个15分钟浏览器租约。作者列表仍只运行固定的四个只读命令；声明 `entry_body_v1` capability 后，还可运行三种固定正文命令：知乎 `answer-detail`、小红书 `note`、知乎文章 `web read --stdout`。服务端不能下发任意 shell、argv 或输出路径。
- 同一时间只允许一个浏览器任务；每个凭证组遵守至少8秒间隔、来源6小时重抓周期。
- 登录失败暂停整组，导航拒绝/平台限制与凭证失效分开；不自动绕过验证码或授权确认。
- 上传重试复用租约和相同消息；确认成功的消息不再次入库，不重置已读状态。
- 网络中断时结果保留在Windows；租约过期的结果另存本地并明确提示，不当作上传成功。
- 作者列表仍只上传规范化元信息。正文任务只上传已知 entry 的规范化文本正文（UTF-8 最多 1 MiB）；Cookie、任意浏览器 HTML、任意字段、命令参数和本机日志都不上传。ECS 将正文再次 HTML escape 后才写入 Miniflux。
- Windows关闭或休眠时只能展示已同步内容；打开阅读器并不能唤醒离线电脑。

## 6. 当前验证事实与待办

Shervin上 doctor 确认扩展 v1.0.21 在线；知乎所关注作者的回答列表首次实测返回2条。
小红书同一已登记作者首次实测返回 Navigation rejected；未判定为Cookie过期，也未绕过访问拒绝。
需要用户在Shervin确认小红书正常登录及扩展站点权限；有真实结果前不能标为该平台已接通。
测试代码覆盖租约、重试去重、非法URL、独立鉴权、日期来源、原服务器不执行桌面采集。
正式的 SSH、上传入库、版本和运行结果在发布后追加，不把本节当成已完成记录。

参考：OpenCLI 官方 Browser Bridge 文档 https://opencli.info/docs/guide/browser-bridge.html
固定契约：Shervin 已安装 OpenCLI 1.8.7 的 user-answers、user-articles、xiaohongshu user 帮助和实现。

## 7. 真实连接验收记录（2026-09-17）

Windows脚本已实际安装于 `D:\QuietRiverCollector`；原 `D:\quiet-river` 保持 main、无工作区改动。
专用私钥留在 Windows 本地权限目录；服务器仅登记公钥，并固定核对服务器主机公钥。
`collector.cjs --doctor` 在 Shervin 成功验证 OpenCLI 扩展与 ECS 受限 SSH 接收端。
使用该SSH身份请求非同步命令 `id` 被拒绝，没有获得普通 shell 或 root 权限。
ECS已写入接收配置与systemd覆盖文件，接收密钥没有发送到Windows或聊天中。

首次一键端到端试验领取了一个知乎文章通道：ECS接收结果为 ACCESS_BLOCKED、0条文章。
这是正确回传故障，不是知乎入库成功；本次不能从这个归类单独判断是站点403还是导航授权拒绝。
此前独立知乎回答读取返回2条，但不把它当成一键同步已经写入ECS的证据。
小红书独立检查的原始错误是 Navigation rejected，仍需用户确认站点登录与扩展权限。
失败后没有不断重试115位知乎作者，也没有去绕过访问拒绝。

脚本正常退出与采集成功分开：新版本对受限/失败任务返回非零退出码；短暂8秒组间隔会等待，不提前假报全批完成。
单次20条窗口不是完整历史回补；已有未读、标签和批注身份不因同步重试改变。
尚未验收的浏览器授权、知乎/小红书批量持续覆盖，不能用脚本已部署代替。
Windows持续模式未设置开机启动；用户双击后在前台运行，关闭窗口停止领取。

## 8. 认证抖动与自动恢复（2026-09-17）

生产观察证明单个 OpenCLI 请求可能短暂返回认证错误，而同一作者/同一路由立即只读复测又成功；因此单次错误不能再冻结全部115个知乎来源。
当前协议要求同一采集任务连续两次得到 `AUTH_REQUIRED` 才向 ECS 上报组级认证失效。
如果组已经冻结，ECS 只返回一个已登记作者的 bounded auth probe（platform/sourceId/authorId/kind/limit），不返回 Feed、Cookie 或任意命令。
Windows 最多每10分钟尝试恢复检查；同一 probe 连续两次 OpenCLI limit=1 成功后才发送受限 `resume`。
ECS 端 `resume` 只允许已配置 desktop 平台，并有10分钟服务端冷却；不接受任意 credential group 名称。

首次真实验收在不调用人工 resume 的前提下完成：服务端审计记录两次本地探针确认，Zhihu 组从 AUTH_REQUIRED 自动回到 OK，随后连续采集成功。
Windows 安装版本以 `D:\QuietRiverCollector\installed-revision.txt` 记录；本次为 `e80047e04897ecefba0d481b4fd9a4e804d48e1d`，collector SHA256 与 ECS release 中同一文件一致。


## 8. B站投稿通道并入桌面采集（2026-09-17）

现有4个B站订阅都对应 `/bilibili/user/video/:uid`，不新增作者、不改manifest。
当前 RSSHub `user/video` 路由虽然声明 `requirePuppeteer: false`，但 API 失败时会 fallback 到 Playwright；ECS 实测 B站空间/WBI 请求返回 412，因此普通镜像不能在本机稳定完成该路由。
隔离 RSSHub pilot 在 192 MiB 上限下无法 ready；提高到 256 MiB 后常驻约246 MiB。结合主机无 Swap 与现有 Karakeep/Miniflux，未将它纳入生产。

Shervin 的 OpenCLI 1.8.7 已提供只读 `bilibili user-videos <uid>`；对已订阅 UID 503316308 的 limit=2 实测成功，返回标题、日期和 `www.bilibili.com/video/BV...` 原链。
因此 B站复用同一 desktop collector：UID 从既有 RSSHub feed 路径解析，channel ID 使用原 suffix 计算方式保持不变；Windows 只上传规范化元信息，不上传 Cookie 或原始浏览器输出。
B站属于无需共享登录凭证的桌面来源：若某次命令误报 `AUTH_REQUIRED`，服务端降级为 `ACCESS_BLOCKED`，不会像知乎/小红书那样冻结凭证组。

新增 `Sync-Bilibili.cmd` 作为最多20个当前可运行任务的一键入口；持续 watcher 默认同时领取知乎、小红书和B站任务。
日期只接受 OpenCLI 明确返回的 `YYYY-MM-DD`，按 UTC 日精度保存；其他格式保持发布时间未知，不猜具体时刻。
原链只接受 `https://www.bilibili.com/video/BV...` 或 `av...`，lookalike host、明文 HTTP、嵌入凭证与非标准端口均拒绝。

## 9. ECS 本地选择性境外代理（2026-09-18）

ECS 并非无公网：GitHub、arXiv、PyPI、npm、知乎、小红书、B站等可直连；YouTube / Google Research 的 DNS 与国际直连路径异常。Shervin 的 Clash Party / Mihomo fake-IP 结果用于确认问题性质，但生产主路径不再依赖 Windows 长久在线。

ECS 锁定官方 Mihomo v1.19.31；Linux amd64 发布资产经 SHA256 校验后安装到 /usr/local/bin/mihomo。节点 provider 只保存在 /var/lib/mihomo/providers/bootstrap.yaml，权限 0600，不进入 GitHub、聊天或普通日志。首次节点集合通过一次性受限 SFTP 从 Shervin 当前已解析配置中引导，传输 key 与 drop 目录随后已删除。

Mihomo 仅监听 127.0.0.1:7890 和 Docker bridge 172.18.0.1:7891，公网网卡没有代理端口。Miniflux 的 HTTP_CLIENT_PROXY 指向 7891；每个 feed 仍必须显式 fetch_via_proxy=true 才使用代理。当前策略为 X / YouTube / Google Research 走 proxy，其余公开 Feed 默认 direct；Mihomo 内部仍有按域名规则，国内来源不强制绕境外节点。

真实验收：YouTube Feed 与 Google Research RSS 通过 Mihomo 返回 200；Miniflux parsing_error_count=0；Bridge 后续均为 SUCCEEDED_NO_NEW，分别已有15条与100条。X 先对高失败 feed 做 canary，真实 Miniflux 刷新成功后再给28个 X feed 开启 proxy，Bridge 按原调度/退避节奏逐步恢复。

旧的 Shervin 127.0.0.1:7890 → reverse SSH → ECS 17890/17891 保留为短期回滚路径，但 Miniflux 已不再指向17891。Mihomo 配置与私有 provider 会进入 root-only 本地恢复点；provider 内容绝不提交公开仓库。

Clash Party 当前订阅 URL 不能被普通 HTTP 客户端直接 GET，因此 ECS 不伪装成已完成订阅自动更新。当前节点集为已验证静态 bootstrap；后续节点变更需经受限同步流程更新，Shervin 离线不会影响 ECS 使用最后一次成功 provider。

## 10. 按需正文补全 `entry_body_v1`（2026-09-19）

站内文章页对仍是 `META/PARTIAL` 的知乎、小红书条目提供显式“让 Shervin 补正文”按钮。仅点击按钮才入队；打开文章页本身只读取任务状态，不暗中触发浏览器访问。Shervin 离线时任务保留，collector 再次运行后继续。

正文任务与博主列表任务分表、分状态：手动来源刷新优先级最高，其次是用户正在阅读时请求的单篇正文，最后才是批量/定时来源刷新。单篇正文的超时、导航拒绝不会改写博主通道的 `last_success/state`；只有重复确认的 `AUTH_REQUIRED` 才冻结共享凭证组。

固定只读命令为：知乎回答 `answer-detail`（完整纯文本）、小红书 `note`（正文描述文本）、知乎文章 `web read --stdout --download-images false`（Markdown 文本）。Windows 在启动 Browser Bridge 前再次校验服务端下发的已知原链；ECS 无法下发任意命令、参数数组或文件路径。

正文上传只包含 `entryId + content`，最大 1 MiB。ECS 不信任该文本为 HTML，而是统一 escape 后按段落写入 Miniflux；更新请求不发送 read/unread 状态。原 URL、发布时间、文章标签和已读状态保留，空正文、登录页、短验证码/风控页不会覆盖已经保存的文本。
