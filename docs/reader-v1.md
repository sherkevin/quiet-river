# Quiet River 阅读器 v1

状态：已部署首个真实可用版本；后续仍需浏览器视觉 E2E、移动端和长期运行验收。

## 产品行为

文章卡片始终保留准确的原文入口。阅读器是附加能力，不阻塞来源更新和未读列表。

- `reader`：Feed/采集已带可用文本，允许生成站内阅读版本。
- `fetchable`：公开网页只有元信息时，可由 Miniflux 匿名尝试补正文；失败退回原文。
- `original`：知乎、小红书等受限来源只有元信息时，ECS 不二次绕过平台抓取，直接读原文。

只有 Karakeep 确认归档成功后才宣称可高亮。`TEXT/PARTIAL` 只说明已有文本，不等于全文完整性证明。

## 2026-09-17 实际上线结果

运行应用：`d12e770021b22866b5d57e61c8f444136779e9d2`。
ECS Node 22 精确提交回归：227/227 通过；GitHub CI run `35219763799` success。
发布前恢复点：`/var/backups/quiet-river/platform-20260917T121228Z`。

真实未读样本只执行归档/status/reader launch，不调用 read：
- 博客 1 篇：`NONE → READY`，SSO launch 302 到 `/reader/<bookmark>`，最终 HTTP 200；仍为 unread。
- 公众号 1 篇：同样 `READY → reader 200`；仍为 unread。
- 知乎 1 篇：`ORIGINAL_ONLY`，不创建假 bookmark；仍为 unread。
- 小红书 1 篇：`ORIGINAL_ONLY`，不创建假 bookmark；仍为 unread。

## 同域阅读器认证

Karakeep 0.33.2 的独立阅读页是 `/reader/[bookmarkId]`；`/dashboard/preview/[bookmarkId]` 是 Dashboard modal，`/dashboard` 本身没有根页面。
旧版直接打开 preview 会在未登录时 307 到 `/`，又被 Caddy 送回 `/desk/`，因此不能作为稳定入口。

现在由 Bridge 提供受保护的 launch endpoint：
- `/desk/reader/<entryId>`：Quiet River 鉴权后，服务器端向 loopback Karakeep 换取 Web Session，再跳 `/reader/<bookmarkId>`。
- `/desk/reader-bookmark/<bookmarkId>`：从高亮/整篇备注回到对应记录。
- `/desk/reader-home?target=bookmarks|highlights`：目标为固定白名单，不能构造任意跳转。

浏览器只收到 `__Secure-next-auth.session-token`，实测为 Secure + HttpOnly；Karakeep 密码不进入前端、URL、仓库或日志。
匿名调用 launch 返回 401；高亮首页经 SSO 后 `/dashboard/highlights` 返回 200。
隔离 Karakeep 合同测试仍通过 HTML worker 解析、真实高亮持久化、跨文章列表及归档对象复用；夹具随后删除。

### 当前边界

知乎、小红书当前 Windows collector 只上传文章列表元信息，所以 v1 不声称站内全文可用。
若未来 Shervin 能稳定取得单篇正文，应作为独立“正文补取”能力接入；在此之前原文降级是正确行为。
真实鼠标拖选的视觉 E2E 尚未由自动化代替；API/worker 的高亮持久化合同已经真实验证。
