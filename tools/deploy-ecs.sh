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
#   QR_ECS_INSTANCE=i-xxxx tools/deploy-ecs.sh               # 之后：更新代码，保留线上订阅配置
#   QR_ECS_INSTANCE=i-xxxx tools/deploy-ecs.sh --sync-subscriptions # 明确同步仓库订阅配置
#   tools/deploy-ecs.sh --dry-run                           # 只检查并打包，不连接 ECS
#
# 依赖：阿里云 workbench CLI（免公网 SSH 凭据直连 ECS）：
#   curl -fsSL https://workbench-cli.oss-cn-hangzhou.aliyuncs.com/install.sh | bash -s -- -d ~/.local/bin
#   workbench config   # 填 AccessKey；AK 只存在 ~/.workbench/config.json (0600)
#
# 环境变量：
#   QR_ECS_INSTANCE   ECS 实例 ID（必填）
#   QR_ECS_REGION     地域，默认从实例 ID 推断（workbench 自己会推）
#   QR_ECS_PORT       监听端口，默认 80,4321；逗号分隔，逐端口校验
#
# 安全模型：服务以专用用户 qr 跑，口令在 /etc/quiet-river/env (0600)，
# 浏览器第一次打开站点输入一次即存 cookie。公网暴露前必须有这道闸——
# 见 lib/access.js 顶部注释。
set -euo pipefail

INSTANCE="${QR_ECS_INSTANCE:-}"
REGION="${QR_ECS_REGION:-}"
# 默认同时监听 80 与 4321：不同网络对端口的放行策略互相矛盾——办公网代理只放
# 80、运营商网对未备案 80 丢包但放非标准端口、境外两者都通。服务端同时监听，
# 每种网络各取能通的那个。80 被某网络拦时服务端只是收不到包，不影响 4321。
PORT="${QR_ECS_PORT:-80,4321}"
PROVISION=""
DRY_RUN=false
SYNC_SUBSCRIPTIONS=false
for arg in "$@"; do
  case "$arg" in
    --provision) PROVISION=--provision; SYNC_SUBSCRIPTIONS=true ;;
    --sync-subscriptions) SYNC_SUBSCRIPTIONS=true ;;
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      echo "用法：QR_ECS_INSTANCE=i-xxxx $0 [--provision] [--sync-subscriptions] [--dry-run]"
      exit 0 ;;
    *) echo "未知参数：$arg" >&2; exit 2 ;;
  esac
done

# PORT 也会写入远端 shell / systemd，必须先校验而不是原样插值。
[[ "$PORT" =~ ^[0-9]+(,[0-9]+)*$ ]] || { echo "端口格式错误" >&2; exit 2; }
IFS=',' read -r -a PORTS <<< "$PORT"
for port in "${PORTS[@]}"; do
  # 长度与前导零限制也避免 Bash 八进制解释和整数溢出。
  [[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && (( port <= 65535 )) || {
    echo "端口必须为 1..65535 的十进制整数：$port" >&2; exit 2;
  }
done
if [ "$DRY_RUN" != true ]; then
  [[ "$INSTANCE" =~ ^i-[A-Za-z0-9]+$ ]] || { echo "需要合法 QR_ECS_INSTANCE" >&2; exit 2; }
fi

WB="$(command -v workbench || echo "$HOME/.local/bin/workbench")"
if [ "$DRY_RUN" != true ]; then
  [ -x "$WB" ] || { echo "找不到 workbench CLI，见脚本头部安装说明" >&2; exit 1; }
fi

SRC="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/qr-ecs-stage.XXXXXX")"
trap 'rm -rf -- "$STAGE"' EXIT
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
cp "$SRC/data/cache.seed.json" "$APP/data/"
if [ "$SYNC_SUBSCRIPTIONS" = true ]; then
  cp "$SRC/data/subscriptions.json" "$APP/data/"
else
  echo "    保留线上 data/subscriptions.json（要同步请显式加 --sync-subscriptions）"
fi
# macOS tar 会塞 ._* AppleDouble 元数据文件，Linux 端解出来是垃圾；禁掉。
COPYFILE_DISABLE=1 tar czf "$STAGE/deploy.tar.gz" -C "$STAGE" quiet-river
echo "    $(du -h "$STAGE/deploy.tar.gz" | cut -f1)  $(tar tzf "$STAGE/deploy.tar.gz" | wc -l | tr -d ' ') 个文件"

if [ "$DRY_RUN" = true ]; then
  echo "==> DRY RUN：未调用 workbench、未上传、未修改 ECS"
  echo "==> 打包清单（不包含运行时缓存和私有适配器）"
  tar tzf "$STAGE/deploy.tar.gz"
  exit 0
fi

# 更新与首次配置区分：没有现存订阅配置时，不静默以种子或空配置启动。
if [ "$PROVISION" != "--provision" ] && [ "$SYNC_SUBSCRIPTIONS" != true ]; then
  run 'test -s /opt/quiet-river/data/subscriptions.json || { echo "线上订阅配置缺失；中止代码更新，请先完成首次配置" >&2; exit 1; }'
fi

if [ "$PROVISION" = "--provision" ]; then
  echo "==> 首次配置：Node / 用户 / systemd unit / 口令"
  run 'command -v node >/dev/null || { cd /tmp && curl -fsSL -o n.tar.xz https://cdn.npmmirror.com/binaries/node/v20.20.2/node-v20.20.2-linux-x64.tar.xz && tar xf n.tar.xz && install -m 755 node-v20.20.2-linux-x64/bin/node /usr/local/bin/node; }; node -v' 180
  run 'id qr >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/qr --shell /usr/sbin/nologin qr; mkdir -p /etc/quiet-river /opt/quiet-river' 60
  # 口令只在远端不存在时生成一次，避免每次部署换口令把手机上的 cookie 打失效。
  run 'if [ ! -s /etc/quiet-river/env ]; then printf "QR_ACCESS_TOKEN=%s\n" "$(openssl rand -hex 16)" > /etc/quiet-river/env; chmod 600 /etc/quiet-river/env; echo "口令已生成：cat /etc/quiet-river/env"; else echo "口令已存在，保留"; fi' 60
fi

# 同步配置前保留旧版本。不是全量备份；上线前仍须做代码/数据恢复点。
if [ "$SYNC_SUBSCRIPTIONS" = true ]; then
  run 'set -eu; if [ -f /opt/quiet-river/data/subscriptions.json ]; then umask 077; mkdir -p /var/backups/quiet-river; chmod 700 /var/backups/quiet-river; backup=$(mktemp /var/backups/quiet-river/subscriptions.XXXXXXXX); cp /opt/quiet-river/data/subscriptions.json "$backup"; echo "订阅配置备份已保留"; fi' 60
fi

echo "==> 上传并解包"
"$WB" upload "$STAGE/deploy.tar.gz" /tmp/ -i "$INSTANCE" ${REGION_ARGS[@]+"${REGION_ARGS[@]}"} -f >/dev/null
# tar 里带 quiet-river/ 前缀，解到 /opt 即原地覆盖代码；data/cache.json 不在包里，
# 所以远端已抓的缓存不会被部署冲掉。默认不打包 subscriptions.json；
# 只有 --provision 或 --sync-subscriptions 会显式同步这份配置。
run "set -eu; tar xzf /tmp/deploy.tar.gz -C /opt; find /opt/quiet-river -name '._*' -delete; chown -R qr:qr /opt/quiet-river; ls /opt/quiet-river" 120

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

# 此检查只验证服务可达且未授权访问仍被拒绝，不宣称采集/正文功能已验收。
for port in "${PORTS[@]}"; do
  run "set -eu
code=000
for attempt in 1 2 3 4 5; do
  code=\$(curl --noproxy '*' --connect-timeout 2 --max-time 5 -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:$port/api/state') || code=000
  if [ \"\$code\" = 401 ]; then
    printf '本机自检 $port /api/state -> 401\n'
    exit 0
  fi
  # 任意非401 HTTP响应直接失败；仅连接失败重试，避免掩盖口令闸失效。
  [ \"\$code\" = 000 ] || break
  sleep 1
done
printf '本机自检失败：端口 $port，HTTP %s，要求401\n' \"\$code\" >&2
exit 1" 45
done
echo "==> 完成。公网地址：http://<实例公网IP>/"
echo "    口令在远端 /etc/quiet-river/env；浏览器打开首页输入一次即可。"
