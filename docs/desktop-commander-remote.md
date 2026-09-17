# ECS Desktop Commander Remote 运维记录

日期：2026-09-17。
目标设备：`iZ2ze30n28dhdca91zvge0Z`。

## 当前运行方式

- systemd 单元：`desktop-commander-remote.service`
- 固定版本：Desktop Commander `0.2.50`
- 固定 Node：`/root/.nvm/versions/node/v22.23.2/bin/node`
- 固定运行目录：`/opt/desktop-commander-remote-0.2.50-patched`
- session 文件：`/root/.desktop-commander-device/device.json`，权限 0600
- systemd 已 enable，`Restart=always`

不再使用 `npx @latest` 作为长期运行入口，也不依赖 npm 临时 cache。
## 0.2.50 已知问题与本地补丁

实测旧 service 在读取磁盘 session 后报 `Invalid Refresh Token: Already Used`，随后进入无人值守无法完成的浏览器授权循环。
根因与上游 issue #695 一致：运行中 TOKEN_REFRESHED 更新了内存 session，但没有把轮换后的 refresh token 持久化。

本地补丁包含两层保护：

1. `TOKEN_REFRESHED` 后立即调用持久化逻辑；
2. graceful shutdown 在关闭 realtime/auth 前再保存一次当前 session。

上游正式版本包含等价修复后，应优先迁回官方发行版，不长期维护私有 patch。
升级前必须先验证“token 已轮换后进程重启仍无需人工配对”。

## 已执行验收

从临时 tmux 进程切换到 systemd 后，同一 device ID 直接 `Session restored → Device ready`。
随后调用 Remote 自带 graceful shutdown：设备短暂 offline，systemd 自动拉起，`NRestarts=1`，再次直接恢复同一 session，无授权流程、无 Invalid Refresh Token。
session 文件权限保持 0600，重启时 mtime 更新。
