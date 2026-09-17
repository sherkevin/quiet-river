# Shervin Windows 采集节点：一键同步到 ECS

## 1. 这次连接的边界

用户明确授权在 Shervin 上工作，Windows 上已安装 OpenCLI 1.8.7、Node 24.13.0、Browser Bridge 扩展。
本方案使用本机已登录浏览器执行只读作者列表命令，不读取浏览器 Cookie 数据库，不导出浏览器会话。
项目现状简报已说明小红书旧通道依赖本机浏览器；不能承诺把 Cookie 写进 ECS 环境变量即可迁移该能力。
因此采用：Windows 采集元信息 → SSH 加密上传 → ECS 主动导入 Miniflux → 正常展示、继承标签与记录已读。
正文抓取、图片下载、高亮开发不属于这批工作；现有阅读数据不修改。

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
python3 tools/windows/install-ecs.py /path/to/windows-public-key.pub
```

它创建专用 `qr-collector` 用户，SSH key 带 restrict 和 forced-command：不能取得 shell、端口转发、TTY 或 sudo。
网关只接受 claim / submit / status 三类 JSON，并经本机受限 API 调用 Bridge；不接受任意文件路径或命令。
服务配置的更新通过 systemd EnvironmentFile 生效；安装后仍须用精确提交测试和受控发布流程重启应用。
服务器公钥不符时必须重新核对，不使用 StrictHostKeyChecking=no。

## 5. 数据与任务语义

- 博主/标签以 ECS 为准，Windows不自行添加博主或传递第三方推荐列表。
- 网页刷新、自动更新、Windows一键执行共用 ECS 通道队列；普通 Feed 仍在服务器抓取。
- Windows每次领取一个15分钟租约，只运行固定的三个只读命令，不从服务端接收任意 shell。
- 同一时间只允许一个浏览器任务；每个凭证组遵守至少8秒间隔、来源6小时重抓周期。
- 登录失败暂停整组，导航拒绝/平台限制与凭证失效分开；不自动绕过验证码或授权确认。
- 上传重试复用租约和相同消息；确认成功的消息不再次入库，不重置已读状态。
- 网络中断时结果保留在Windows；租约过期的结果另存本地并明确提示，不当作上传成功。
- ECS只接收规范化元信息，不接收原始浏览器输出、Cookie、任意HTML或本机日志。
- Windows关闭或休眠时只能展示已同步内容；打开阅读器并不能唤醒离线电脑。

## 6. 当前验证事实与待办

Shervin上 doctor 确认扩展 v1.0.21 在线；知乎所关注作者的回答列表首次实测返回2条。
小红书同一已登记作者首次实测返回 Navigation rejected；未判定为Cookie过期，也未绕过访问拒绝。
需要用户在Shervin确认小红书正常登录及扩展站点权限；有真实结果前不能标为该平台已接通。
测试代码覆盖租约、重试去重、非法URL、独立鉴权、日期来源、原服务器不执行桌面采集。
正式的 SSH、上传入库、版本和运行结果在发布后追加，不把本节当成已完成记录。

参考：OpenCLI 官方 Browser Bridge 文档 https://opencli.info/docs/guide/browser-bridge.html
固定契约：Shervin 已安装 OpenCLI 1.8.7 的 user-answers、user-articles、xiaohongshu user 帮助和实现。
