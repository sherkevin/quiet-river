# Quiet River 阅读器 v1

状态：开发实现，部署前须通过 ECS Node 22 完整回归与真实文章验收。

## 产品行为

文章卡片始终保留准确的原文入口。阅读器是附加能力，不阻塞来源更新和未读列表。

- `reader`：Feed/采集已带可用文本，允许生成站内阅读版本。
- `fetchable`：公开网页只有元信息时，可由 Miniflux 匿名尝试补正文；失败退回原文。
- `original`：知乎、小红书等受限来源只有元信息时，ECS 不二次绕过平台抓取，直接读原文。

只有 Karakeep 确认归档成功后才宣称可高亮。归档处理、失败和仅原文均是显式状态。
## 2026-09-17 实际上线结果

运行应用：`ed002cd53afbbc273630bb118298f1a2cd8eab60`。
ECS Node 22 精确提交回归：225/225 通过；GitHub CI run 35213959456 success。
发布前恢复点：`/var/backups/quiet-river/platform-20260917T110704Z`。

真实未读样本只执行归档/status，不调用 open/read：

- 博客 1 篇：`NONE → READY`，`canHighlight=true`；仍为 unread。
- 公众号 1 篇：`NONE → READY`，`canHighlight=true`；仍为 unread。
- 知乎 1 篇：`ORIGINAL_ONLY`，不创建假 bookmark；仍为 unread。
- 小红书 1 篇：`ORIGINAL_ONLY`，不创建假 bookmark；仍为 unread。

隔离 Karakeep 合同测试通过：HTML 归档、真实 worker 解析、持久化高亮、跨文章高亮列表、重复打开不替换已批注归档；测试夹具随后删除。
首次进入阅读器时，前端查询同域 `/api/auth/session`：已有 Karakeep session 直接进入 preview；未登录则去 `/signin?callbackUrl=<preview>`。
Caddy 实测 `/signin` 与 `/api/auth/session` 均返回 200，避免未登录 preview 经 `/` 被送回 `/desk/`。
阅读器账号为 `reader@quiet-river.local`，密码沿用本站访问口令；密码不写入前端、URL、仓库或日志。

### 当前边界

知乎、小红书当前 Windows collector 只上传文章列表元信息，所以 v1 不声称站内全文可用。
若未来 Shervin 能稳定取得单篇正文，应作为独立“正文补取”能力接入；在此之前原文降级是正确行为。
浏览器真实鼠标划线的视觉 E2E 尚未由自动化代替；API/worker 的高亮持久化合同已真实验证。
