#!/usr/bin/env bash
#
# 把这条河部署到一台阿里云 ECS（或任何 systemd + 公网 IP 的 Linux 盒子）。
#
# 为什么有这个脚本：手工部署踩过的坑值得固化——macOS 的 tar 会塞 ._* AppleDouble
# 文件、安全组默认不放 80、非 root 监听 80 需要 capability、凭证不能进命令历史。
# 脚本把这几件事一次做对，且**只带公开件**：私有适配器、secrets/、全量缓存、
# 本机工具一律留在 Mac 上（与 tools/publish.sh 同一套白名单思路）。
#
# 用法：
#   QR_ECS_INSTANCE=i-xxxx tools/deploy-ecs.sh --provision   # 首次：装 Node、建用户、unit、口令
#   QR_ECS_INSTANCE=i-xxxx tools/deploy-ecs.sh               # 之后：只更新代码并重启
#
# 依赖：阿里云 workbench CLI（免公网 SSH 凭据直连 ECS）：
#   curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh | bash -s -- -d ~/.local/bin
#   workbench config   # 填 AccessKey；AK 只存在 ~/.workbench/config.json (0600)
#
# 环境变量：
#   QR_ECS_INSTANCE   ECS 实例 ID（必填）
#   QR_ECS_REGION     地域，默认从实例 ID 推断（workbench 自己会推）
#   QR_ECS_PORT       监听端口，默认 80
#
# 安全模型：服务以专用用户 qr 跑，口令在 /etc/quiet-river/env (0600)，
# 浏览器第一次打开站点输入一次即存 cookie。公网暴露前必须有这道闸——
# 见 lib/access.js 顶部注释。
set -euo pipefail

INSTANCE="${QR_ECS_INSTANCE:?需要 QR_ECS_INSTANCE，例如 i-2ze30n28dhdca91zvge0}"
REGION="${QR_ECS_REGION:-}"
# 默认 4321 而不是 80：大陆地域 ECS 的 80/443 受 ICP 备案约束，未备案时公网直连
# 的典型表现是超时丢包（手机端 ERR_TIMED_OUT），而非可见的拦截页。非标准端口
# 实测可通。真要上 80，先完成备案或确认拦截不存在。
PORT="${QR_ECS_PORT:-4321}"
PROVISION="${1:-}"

WB="$(command -v workbench || echo "$HOME/.local/bin/workbench")"
[ -x "$WB" ] || { echo "找不到 workbench CLI，见脚本头部安装说明" >&2; exit 1; }

SRC="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/qr-ecs-stage.XXXXXX")"
APP="$STAGE/quiet-river"

REGION_ARGS=()
[ -n "$REGION" ] && REGION_ARGS=(-r "$REGION")

# macOS 自带 bash 3.2 在 set -u 下展开空数组会报 unbound variable，用 + 守卫。
run() { "$WB" exec -i "$INSTANCE" ${REGION_ARGS[@]+"${REGION_ARGS[@]}"} --timeout "${2:-60}" -c "$1" | sed 's/^/    /'; }

echo "==> 打包（只带公开件）"
mkdir -p "$APP/lib" "$APP/public" "$APP/data"
cp "$SRC/server.js" "$SRC/seed.js" "$SRC/package.json" "$APP/"
# 私有适配器永不离开本机：拷贝时就跳过，再自检一次双保险。
for f in "$SRC"/lib/*.js; do
  case "$(basename "$f")" in
    adapters.private.js) continue ;;
  esac
  cp "$f" "$APP/lib/"
done
if [ -e "$APP/lib/adapters.private.js" ]; then
  echo "!! 打包件里出现了 adapters.private.js，中止" >&2; exit 1
fi
cp -R "$SRC/public/." "$APP/public/"
cp "$SRC/data/subscriptions.json" "$SRC/data/cache.seed.json" "$APP/data/"
# macOS tar 会塞 ._* AppleDouble 元数据文件，Linux 端解出来是垃圾；禁掉。
COPYFILE_DISABLE=1 tar czf "$STAGE/deploy.tar.gz" -C "$STAGE" quiet-river
echo "    $(du -h "$STAGE/deploy.tar.gz" | cut -f1)  $(tar tzf "$STAGE/deploy.tar.gz" | wc -l | tr -d ' ') 个文件"

if [ "$PROVISION" = "--provision" ]; then
  echo "==> 首次配置：Node / 用户 / systemd unit / 口令"
  run 'command -v node >/dev/null || { cd /tmp && curl -fsSL -o n.tar.xz https://cdn.npmmirror.com/binaries/node/v20.20.2/node-v20.20.2-linux-x64.tar.xz && tar xf n.tar.xz && install -m 755 node-v20.20.2-linux-x64/bin/node /usr/local/bin/node; }; node -v' 180
  run 'id qr >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/qr --shell /usr/sbin/nologin qr; mkdir -p /etc/quiet-river /opt/quiet-river' 60
  # 口令只在远端不存在时生成一次，避免每次部署换口令把手机上的 cookie 打失效。
  run 'if [ ! -s /etc/quiet-river/env ]; then printf "QR_ACCESS_TOKEN=%s\n" "$(openssl rand -hex 16)" > /etc/quiet-river/env; chmod 600 /etc/quiet-river/env; echo "口令已生成：cat /etc/quiet-river/env"; else echo "口令已存在，保留"; fi' 60
fi

echo "==> 上传并解包"
"$WB" upload "$STAGE/deploy.tar.gz" /tmp/ -i "$INSTANCE" ${REGION_ARGS[@]+"${REGION_ARGS[@]}"} -f >/dev/null
# tar 里带 quiet-river/ 前缀，解到 /opt 即原地覆盖代码；data/cache.json 不在包里，
# 所以远端已抓的缓存不会被部署冲掉。subscriptions.json 会被覆盖——它是配置本体，
# 以仓库为准是有意为之。
run "tar xzf /tmp/deploy.tar.gz -C /opt; find /opt/quiet-river -name '._*' -delete; chown -R qr:qr /opt/quiet-river; ls /opt/quiet-river" 120

if [ "$PROVISION" = "--provision" ]; then
  echo "==> 写 systemd unit"
  run "cat > /etc/systemd/system/quiet-river.service <<'UNIT'
[Unit]
Description=quiet river feed reader
After=network.target

[Service]
User=qr
Group=qr
WorkingDirectory=/opt/quiet-river
EnvironmentFile=/etc/quiet-river/env
Environment=PORT=$PORT
Environment=HOST=0.0.0.0
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
ExecStart=/usr/local/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/quiet-river/data

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now quiet-river && sleep 2 && systemctl is-active quiet-river" 90
else
  echo "==> 重启服务"
  run 'systemctl restart quiet-river && sleep 2 && systemctl is-active quiet-river' 60
fi

run "curl -s -o /dev/null -w '本机自检 /api/state -> %{http_code}（应为 401）\n' http://127.0.0.1:$PORT/api/state" 30
echo "==> 完成。公网地址：http://<实例公网IP>/"
echo "    口令在远端 /etc/quiet-river/env；浏览器打开首页输入一次即可。"
