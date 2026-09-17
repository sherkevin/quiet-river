# Reader v1.1：发布与证据操作手册

本手册替代旧版单参数发布用法，不改动历史运行记录。
适用：专用开发分支；业务服务仍以 qr 用户运行，root 仅执行系统发布。

## 1. 提交前

核对分支、主分支变化和工作区，不覆盖其他人的改动。
执行 Node 22+ 串行回归、Shell/Python 语法检查和 git diff --check。
只暂存本批代码与文档；不得提交数据库、环境文件、Cookie 或完整正文。
提交后工作区必须干净。GitHub CI 对 main、chatgpt/** 和 PR 运行。
Node 20 只运行旧版应用测试；Node 22/24 运行全套，不能用跳过冒充全部兼容。

## 2. 精确提交的测试证据

以下命令在 qr-dev 用户下运行，证据存放在仓库之外：

```bash
REV=$(git rev-parse HEAD)
python3 tools/record-test-run.py --node /usr/local/bin/qr-node \
  --output-dir "$HOME/reader-evidence/$REV"
```

工具记录 commit、tree、Node 版本、命令、起止时间、测试总数和日志 SHA256。
若工作区不干净、测试期间提交变化、出现失败或输出目录已有证据，会拒绝通过。
同一提交重新执行时使用另一个证据目录，不能覆盖已有记录。

## 3. 备份与发布

先生成一致性恢复点；它会短暂停止/恢复写入服务，不代表异机恢复已验证。
```bash
python3 deploy/backup-platform.py
bash deploy/install-release.sh "$REV" "/home/qr-dev/reader-evidence/$REV/tests.json"
```

发布使用单机排他锁；按指定提交构造 release，而不是复制工作区。
切换前核验所有 tracked 文件内容/执行权限，以及测试报告的 commit/tree/日志哈希。
核验清单保存在 release 的 `.release-manifest.json` 和 root-only 发布证据目录。
文件漂移、测试提交不一致或失败测试会阻止切换。
切换后检查 Bridge 健康与未授权数据接口 401，失败恢复先前应用链接和 unit。
数据库改动必须保持向后兼容；脚本回退代码不等于自动回退数据库迁移。

## 4. 发布后

```bash
node --env-file=/etc/quiet-river-platform/bridge.env tools/platform-smoke.js
```

默认冒烟不触发外部平台刷新；真实来源、浏览器点击和手机通知另行标注证据等级。
记录实际 release、服务 PID/重启变化和恢复点，不把最新文档提交称为运行版本。
CI完成状态另行读取；本机测试成功不能代替 GitHub CI 成功。

## 5. 本批数据迁移

本批只新增来源依据/哈希/同步时间列和索引，不删除正文、来源、已读或批注映射。
历史记录缺少来源依据时仍标记未核验，不反向猜测过去原始发布时间。
第一次哈希基线只校准记录；未变化正文不因重新同步被视为新版本。
部分正文保留 PARTIAL，不能因非空文本就升级为已确认全文。
来源策略值为 feed_full/fetch_public_html/adapter_full/metadata_only；未明确指定时保留已有公开 Feed 提取设置。
本批未自动开启所有博客补抓，不改写平台授权，也不自动新增浏览器任务。

## 受限 Windows collector gateway 也是 release 组件

如果 ECS 已存在 `/etc/quiet-river-collector/agent.env`，`deploy/install-release.sh` 会把该提交的 `tools/windows/collector-gateway.py` 原子安装到 `/usr/local/lib/quiet-river-collector/gateway.py`。
安装前旧 gateway 以 root-only 0600 备份到 `/var/backups/quiet-river/gateway-*.py`；若 release 后续 health gate 失败，rollback 同时恢复旧 gateway 和旧 application symlink/unit。
这样 Bridge 的 collector 协议与 forced-command gateway 不会长期跨版本漂移。
Windows 的 `collector.cjs` 仍需在 Shervin 上单独对齐到同一已测试 commit，并核验 SHA256；更新前必须确认没有待上传结果和 active lease。
