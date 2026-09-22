# Wechat2RSS 私有部署、授权与 ECS 实测

核验日期：2026-09-22。当前状态：**官方镜像已成功拉取；完成两次隔离启动测试；授权未取得，未接入生产。**

本文件是专项技术报告；唯一交接入口仍为 `docs/project-todo.md`。

## 1. 已经证实的结论

Docker Hub 超时不是授权错误。官方已有备用镜像源，本轮通过该源成功下载 v1.4.9。此前反复等待 Docker Hub、试拼写不同的镜像名，没有推进到真正启动阶段。

实际镜像地址为 `ttttmr/wechat2rss`（四个 t），备用地址为 `docker.xlab.app/ttttmr/wechat2rss`。本轮没有使用非官方破解镜像、修改二进制、替换校验逻辑或调用授权重置接口。

两个干净容器都在提供可用服务前主动退出：缺失授权报告 `need license`；明确无效的占位授权报告 `许可证验证失败，请检查授权信息`。退出码均为 1，`OOMKilled=false`。因此本轮失败不是内存不足导致，也不能解释为可免费使用的演示模式。

**已确认的零现金授权候选不是“绕过变量”，而是官方贡献奖励。** 官方定价页明确写有有效 Bug Issue、文档 PR 奖励约一个月时长的活动；是否认可、奖励长度、首次授权发放方式由维护者决定。它不是永久免费个人版，也不能保证一提交就获批。[S1]

## 2. 官方授权如何获取

| 路径 | 已核实内容 | 尚不能承诺的内容 |
| --- | --- | --- |
| 购买 | 15 元/30 天，150 元/365 天；付款备注全小写邮箱；官方称激活码在 24 小时内发送到该邮箱。[S1] | 不能替用户付款，也不能保证邮件实际到达时间。 |
| 有效 Bug Issue | 官方公布可获约 1 个月，按问题严重程度调整。[S1] | 当前正常授权拒绝不是软件 Bug；不能以此提交伪造故障。 |
| 文档 PR | 官方公布可获约 1 个月，按文档量调整。[S1] | 是否接受以及如何领取首次激活码，需要维护者确认。 |
| 直接省略变量/填写示例 | 本轮实测均未获得服务。 | 不存在已证实的无授权社区模式；没有穷尽所有历史版本。 |

`LIC_EMAIL` 是授权绑定邮箱，不是微信登录信息；`LIC_CODE` 是服务方签发的激活码。付款邮箱、微信/微信读书账号、管理密码 `RSS_TOKEN` 是三种不同身份信息。[S1][S3][S5]

官方只允许一个设备上的单容器实例。激活状态在 `/wechat2rss/res.db` 中；第一次启动后可省略部分环境变量，是因为配置已经持久化，不代表以后不需要有效授权。[S3][S4]

授权及微信登录信息应仅由独立 provider 保存。不得进入 Quiet River 的 source catalog、Git、TODO 或聊天记录。本轮没有使用真实邮箱、激活码或微信会话。

## 3. 可复核的镜像与启动证据

| 项目 | 实际结果 |
| --- | --- |
| ECS | `iZ2ze30n28dhdca91zvge0Z` |
| 官方文档源码 revision | `0416ecfb73e42e98b88b70e530609c406d3e5e42` |
| 容器内版本日志 | `WECHAT2RSS-SERVER v1.4.9` |
| 平台 | `linux/amd64` |
| 镜像创建时间 | `2026-07-31T04:19:28Z` |
| Docker inspect Size | 39,824,803 字节；这是镜像大小，不是运行内存需求。 |
| 固定镜像 | `docker.xlab.app/ttttmr/wechat2rss@sha256:000c3243ebdc5d7edc30cb00e52981b600f02d11f85fefcec27e2226c208082f` |
| entry command / 工作目录 | `/server` / `/wechat2rss` |

镜像获取命令：

```bash
timeout --signal=TERM --kill-after=10s 180s \
  docker pull docker.xlab.app/ttttmr/wechat2rss:latest
```

返回码 0，随后固定 digest，不依赖可变 `latest` 做测试。

| 用例 | 时间（UTC+8） | 配置 | 结果 |
| --- | --- | --- | --- |
| `missing-license` | 12:27:37–12:27:39 | 不传 LIC_EMAIL/LIC_CODE；无网络；干净临时数据 | `need license`；exit 1；无 OOM |
| `invalid-placeholder` | 12:27:39–12:27:42 | 使用明确无效的测试邮箱和占位码；独立 bridge 网络 | `许可证验证失败，请检查授权信息`；exit 1；无 OOM；HTTP 不可用 |

测试隔离：每次新容器、新 tmpfs 数据；256 MiB 硬上限、禁止容器使用 swap、0.35 CPU、128 PID；只读根文件系统；drop ALL capabilities；no-new-privileges；第二次仅映射 `127.0.0.1:18080`；不挂载 Docker socket、生产配置或 Reader 数据；无自动重启。

两个容器均已删除，临时管理密码文件已删除，日志中的管理密码已脱敏。未留下常驻试验服务。第二次只做一次普通启动授权校验，未批量猜码。

ECS 证据目录（不在源仓库中）：

```text
/home/qr-dev/work/quiet-river-evidence/wechat2rss-20260922T0427Z/
  image-pull.log
  image-pull.exit
  image-inspect.json
  missing-license.log
  invalid-placeholder.log
  probe-summary.json
  production-pre-smoke.log
  production-pre-smoke.exit
  production-post-smoke.log
  production-post-smoke.exit
  production-post-state.json
  compose-validation.json
  upstream-patch-check.json
```

## 4. 资源结论与生产保护

启动前 ECS 为 1740 MiB 总内存、494 MiB available；结束后一个快照为 462 MiB available，2 GiB swap 未使用。官方推荐的是至少 512M 的服务器配置，不是已经测出的“程序必然需要 512M”。[S2]

此次 256 MiB 上限只证明“能执行到拒绝授权”，不能外推为微信登录、16 个订阅、正文解析或持续更新可以在该内存内运行。正式启动前仍需检查生产峰值余量，并完成小规模 canary 的 RSS/内存/账号状态验证。不得靠这次几秒钟的失败启动就判断 ECS 能稳定承载。

生产保护证据：实测 `current` 仍指向 `640eced314cfdf7af849757b48040c3d14a5288a`；隔离实验前私有 API、公开登录壳、268 源目录和原生笔记接口 smoke 通过；实验没有修改 Reader、生产 symlink、Docker daemon 配置、代理规则、源目录或已有服务。

## 5. 已准备但未启用的独立 provider 模板

- `deploy/providers/wechat2rss.compose.yml`：独立 Compose project，需显式启用 `manual-provider` profile；固定镜像摘要；只监听 loopback；缺失授权/管理密码/地址/数据目录时配置校验失败；不允许自动创建绑定目录。
- `deploy/providers/wechat2rss.env.example`：只有空字段，不含真实凭证。

模板没有被主部署脚本包含，也没有执行 `up`。在独立临时 project 中执行了一次 `create --no-build --pull never` 的缺失目录反例测试，创建被拒绝，没有启动服务；临时 network 已清理。512 MiB 是初始限制候选，不是压测结果；完整授权运行下的只读根文件系统等加固选项仍需复验。

获得授权后才在仓库外准备仅自己可读的 env 文件及独立数据目录，用以下方式做不打印凭证的校验：

```bash
docker compose \
  --env-file /absolute/private/path/wechat2rss.env \
  -f deploy/providers/wechat2rss.compose.yml \
  --profile manual-provider config --quiet
```

不要在聊天里粘贴 env，不要使用会展开并打印全部凭证的 `docker compose config` 输出作为验收日志。当前模板故意没有自动激活脚本；验证授权、资源与网络后再手动创建实例。

**网络仍是单独验收项**：宿主机的 `127.0.0.1:18080` 不能直接作为 Miniflux 容器的可用 RSS 地址；浏览器媒体地址也需与实际访问路径一致。不能通过全局关闭 Miniflux 私网请求保护来省略网络设计。正式接入时需验证受控的 provider → RSS → Reader 路径，并保留管理端鉴权。

## 6. 免费时长的实际推进

本次真实排查暴露了值得补充的官方文档内容：镜像下载和授权失败应分开诊断；使用镜像源时必须同时修改 Compose 的 `image`；第一次启动后的配置持久化不等于免授权；反馈日志前必须脱敏。

据此准备 `docs/upstream/wechat2rss-startup-troubleshooting.patch`，针对官方 `deploy/qa.md` 添加正常部署故障排查。仅包含通用命令、真实错误字符串和官方文档交叉链接，不包含本项目名称、设备、订阅列表、账号或凭证。

该补丁的目标是提供有用文档，不把正常 `need license` 错误冒充软件 Bug。仅准备候选并做本地 apply 检查；未代用户公开发 Issue/PR、联系作者或声称奖励获批。正式提交后，奖励仍需维护者确认。

## 7. 范围与交接纠正

当前任务是维护这 16 个用户指定的公众号，而不是再按名字或现有标签判断用户是否值得订阅它们。此前标签扫描不能证明内容质量、更新频率、跨站同步或可替代性，不能当作削减订阅的依据。

另发现 acquisition worktree 已有 `d1b2c9210d0b15fa65cea3862f27144b88944b37`，修正高德技术迁移后的账号身份。该分支在本轮检查时比其 cached origin ahead 1；主线和生产尚未包含此修改。本轮没有改动或推送该 worktree。后续 provider onboarding 需读取这一已存在的身份验证，不能重复使用主线中的旧 ID。

未完成：取得真实授权（购买或贡献奖励）；用户在 Shervin 完成微信/微信读书授权；完整服务启动与资源验证；对 16 源逐一验证真实 RSS 身份及更新；正式生产接入及用户验收。

## 8. 一手资料

- [S1 购买、定价与长期贡献奖励](https://wechat2rss.xlab.app/deploy/)
- [S2 官方部署与备用镜像源](https://wechat2rss.xlab.app/deploy/deploy)
- [S3 配置优先级与授权变量](https://wechat2rss.xlab.app/deploy/config)
- [S4 单设备单实例与激活数据](https://wechat2rss.xlab.app/deploy/active)
- [S5 微信读书授权与服务管理密码](https://wechat2rss.xlab.app/deploy/guide)
- [S6 使用限制与授权通信说明](https://wechat2rss.xlab.app/deploy/agreement)
- [S7 当前版本与历史变更](https://wechat2rss.xlab.app/deploy/changelog)

网页于 2026-09-22 核验；S6 同时核对了官方仓库同 revision 的 `deploy/agreement.md`。作者对稳定性、隐私及单账号覆盖的描述是其公开声明，并非本轮完成的长期运行验证。

## 9. 本轮验证结果

2026-09-22 12:32–12:33（UTC+8）完成以下验证，详见同一证据目录：

| 验证 | 结果 | 解释 |
| --- | --- | --- |
| 缺失 LIC_EMAIL、LIC_CODE、RSS_TOKEN、RSS_HOST、WECHAT2RSS_DATA_DIR | 5/5 通过 | 每次 `config --quiet` 应以非零码拒绝不完整配置，并点名缺失变量。 |
| 占位值的完整 Compose 配置 | 通过 | 只做配置解析，检查固定镜像、loopback、profile、内存上限及安全参数，不等于授权成功。 |
| 缺失绑定目录的 `compose create` | 通过 | 明确报告 `bind source path does not exist`，没有自动创建目录，没有运行容器。 |
| 临时 project 清理 | 通过 | 临时容器和网络均不存在。 |
| 官方文档补丁 apply-check | 通过 | `git apply --check --whitespace=error` 对指定上游 revision 的原文件返回 0。 |
| 实验后生产 HTTP smoke | 通过 | 私有 API、公开登录壳、268 源目录、原生笔记接口；只读测试，未触发 refresh。 |
| 生产 release、端口与试验容器复查 | 通过 | release 仍为 `640eced...`；bridge active；8001/18080 无监听；试验容器为零。 |

配置验证脚本最初对 Compose JSON 的序列化形式作了两个错误假设（false 字段会保留、内存一定输出为 JSON 数值），修正验证器后重跑通过。模板未为迎合验证器而改动；绑定目录行为另做了真实 Docker create 反例测试。

文档候选补丁 SHA-256：`a5af406b1d3a5fa3379be546470681878f443e3331fa8d47392441c80fb48c01`。补丁尚未公开提交，不表示已拿到免费时长。

本轮 Node 全量回归的精确 commit、计数、日志摘要与发布状态以 `docs/project-todo.md` 末尾验证记录及仓库外的 `tests.json` 为准；不得沿用历史 285/386 测试数字假称本轮通过。

### 提交、回归与远端状态

实测与模板提交为 `2c80aec0e0fd568a56bbdf0966c0c541ab0153ed`。2026-09-22 12:35:39–12:35:48（UTC+8），以 Node v22.23.2 执行精确提交串行回归，285/285 通过，无失败/跳过/取消，工作树未改变。测试日志 SHA-256 为 `84df669b7f1aae301df3a9d9f2080bfa0dbd666907a37ca8f0a42ce6b4dad067`。

该提交已经 push，并用 `git ls-remote` 验证远端 SHA 一致。随后仅补充本报告及唯一 TODO 的交接记录；最终文档 checkpoint 的独立精确测试证据位于同一证据目录 `final-head-regression/tests.json`，读取时需核对其中 commit，不能把旧提交的证据移用到新 HEAD。

生产仍为 `640eced...`；`implemented / committed / pushed / tested` 不代表 `deployed / RSS verified / user accepted`。免费时长目前只有可申请的官方路径，没有发放到本项目的激活码。

## 10. 后续实做：把免费时长申请准备到可审核状态

2026-09-22 12:40 起重新从唯一 TODO 恢复状态，发现实际 HEAD 已为 `c7114fe20cf5e8505dd6b3a0c51109ad0b12c910`，不是聊天中较旧的拉镜像阶段。已核对远端 SHA、285/285 精确提交报告及日志 SHA-256；因此没有重复拉镜像或再次用无效授权启动。

继续完成既有文档贡献补丁的验证，并补充 `docs/upstream/wechat2rss-startup-troubleshooting-pr.md`，用于申请官方活动中可能提供的免费时长。**没有公开提交、没有发放激活码，仍不能称为免费永久方案。**[S1]

本次证据目录：

```text
/home/qr-dev/work/quiet-river-evidence/wechat2rss-followup-20260922T0448Z/
```

用之前核实的官方文档 revision `0416ecf...` 做隔离验证。尝试以 `qr-dev` 从旧 root-owned 仓库直接 clone 时被 Git ownership 检查拒绝，没有添加 `safe.directory`；独立 HTTPS clone 在 60 秒上限退出 124。随后以源仓库实际 owner 导出指定 revision 的 `git archive`，由 `qr-dev` 解包到新的隔离目录，不修改原仓库和主工程权限。来源记录见 `source-provenance.txt`。

| 后续验证 | 结果与边界 | 证据 |
| --- | --- | --- |
| lockfile 依赖安装 | 139 packages；exit 0；`--ignore-scripts --no-audit --no-fund` | `npm-ci.log`、`npm-ci.exit` |
| 补丁后的完整 VitePress 构建 | exit 134，V8 heap 耗尽；未通过 | `docs-build.log`、`docs-build.exit` |
| 原始上游的同预算对照构建 | 同样 exit 134、V8 heap 耗尽；不能把本地预算不足直接当作补丁缺陷 | `docs-baseline-build.log`、`docs-baseline-build.exit` |
| 定向 VitePress 渲染与 Vue 模板编译 | 通过，不等同于完整构建 | `targeted-doc-validation.json`、`.log` |
| 新增文档引用 | 6 个目标页面、其中 3 个精确锚点通过；4 个关键文本检查通过 | 同上 |
| 线上只读公开检查 | `/desk/` 200、未授权 `/desk/api/state` 401、bridge active、release 未变化 | `production-public-smoke.json` |
| 认证态 smoke | 本轮没有重跑：工具安全检查拒绝读取受保护凭证；未换其他方式读取 | 同上；之前完整 smoke 仅为历史证据 |

文档构建使用独立临时 systemd 服务，以 `qr-dev` 运行、只可写本次证据目录，设置 256 MiB cgroup / 160 MiB V8 heap、0.5 CPU、禁 swap 与有限超时。不通过扩大内存预算影响线上服务。两个完整构建失败均已保留原始日志；正常资源环境中的完整站点构建仍待完成。官方软件的 Go 服务内存需求不能从文档构建失败推断。

网络 gate 也从实际容器配置确认：Miniflux 使用自己的 bridge network，`FETCHER_ALLOW_PRIVATE_NETWORKS=false`。因此 `127.0.0.1:18080` 仍仅适合宿主机本地验证，不能假装它已是 Miniflux 或用户浏览器可用的 RSS 地址。保留私网保护；没有修改 Docker daemon、网络、代理或 Reader 配置。官方配置依据：<https://miniflux.app/docs/configuration.html#fetcher-allow-private-networks>，现场证据见 `host-network-gates.json`。

12:50 的快照约有 489.7 MiB available，模板上限为 512 MiB。该快照不是长期峰值测试，也不代表已获准启动常驻 provider。下一步真实功能验证仍需有效官方授权、用户微信读书授权、资源 canary 和私有 RSS 连通验收。此前 16 个订阅均保留，不做主观减项。

本次没有重复无效授权实验，没有使用示例/他人激活码，也没有重新推进 WeRSS。阻塞状态已经明确；继续修改或反复启动同一无授权镜像不会解决它。

后续验证材料提交为 `c0e781a8577d1849e7a60e7c1aa8744da7b63afd`；12:55 的精确提交串行 Node 回归 285/285 通过、工作树不变，已 push 且远端 SHA 一致。日志 SHA-256 为 `e5df8950e79c2ff9896e5d6059ad0b890ab041d518c87f30864b9214d1f64f2c`。最终仅补充交接记录的 checkpoint 使用本节证据目录中的 `regression-final/tests.json`，必须核对其中 commit；对应 `final-verification.json` 记录远端与现场状态。构建依赖和下载缓存已经清理，验证脚本、源快照、渲染结果和日志保留。
