#!/usr/bin/env bash
#
# 把中继函数（tools/relay-fc/index.js）部署到阿里云函数计算 FC。
#
# 为什么需要中继：这条河的网页托管在 GitHub Pages，数据在 ECS 上，两边跨域。
# FC 的默认域名（*.fcapp.run）走标准 HTTPS 且能被大多数网络放行，正好当中转。
# 中继只做一件事——把请求原样转给 ECS，再把响应原样带回来。
#
# 中继里那些看着别扭的处理都是 FC 默认域名的硬约束，改之前先读注释：
#   - FC 网关会自己注入一整套 CORS 头，所以后端那套必须丢掉，否则重复头
#     会被浏览器判非法（Access-Control-Allow-Origin 出现两次即失败）；
#   - 网关给每个响应加 Content-Disposition: attachment，所以中继不能当网页
#     直接打开（会变成下载），只能给 Pages 上的前端当数据接口；
#   - 任何 3xx 重定向被网关禁止，登录跳转要降级成 meta refresh；
#   - 空 body 不能标 isBase64Encoded，否则网关报 400。
#
# 用法：
#   tools/deploy-relay.sh                 # 部署 + 自检
#   QR_RELAY_TARGET=http://1.2.3.4:80 tools/deploy-relay.sh   # 换后端地址
#
# 依赖：阿里云 CLI（aliyun），AK 存在 ~/.aliyun/config.json，profile 名见
#   aliyun configure list。凭证只走 CLI 自己的配置，不进命令历史也不进仓库。
#
# 环境变量：
#   QR_RELAY_NAME     函数名，默认 qr-relay
#   QR_RELAY_REGION   地域，默认 cn-beijing（要与 ECS 同地域，内网直连更稳）
#   QR_RELAY_TARGET   后端地址，默认沿用函数上已配的值
#   QR_RELAY_ORIGIN   网页所在 origin（CORS 自检用）。网关按请求 Origin 回显，
#                     所以不填也能查「头是否重复」；填了自己的 Pages 地址则
#                     自检与真实浏览器场景完全一致。默认 https://example.org
#   QR_RELAY_TOKEN_FILE  本机可读的口令文件（纯口令一行）；给了才跑口令自检，
#                        不给则跳过——口令通常在后端机器上，不在跑脚本这台
set -euo pipefail

FN="${QR_RELAY_NAME:-qr-relay}"
REGION="${QR_RELAY_REGION:-cn-beijing}"
ORIGIN="${QR_RELAY_ORIGIN:-https://example.org}"
HANDLER="index.handler"
RUNTIME="nodejs20"

ALIYUN="$(command -v aliyun || echo "$HOME/.local/bin/aliyun")"
[ -x "$ALIYUN" ] || { echo "找不到 aliyun CLI，见脚本头部说明" >&2; exit 1; }

SRC="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$SRC/tools/relay-fc/index.js"
[ -f "$ENTRY" ] || { echo "缺少 $ENTRY" >&2; exit 1; }

# 语法先本地过一遍：FC 上的错误只在调用时才浮现，排查成本高一个量级。
node --check "$ENTRY" || { echo "$ENTRY 语法不过" >&2; exit 1; }

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/qr-relay-stage.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

cp "$ENTRY" "$STAGE/index.js"
# -X 去掉扩展属性，避免 macOS 塞进 __MACOSX/ 与 ._* 文件污染包内结构。
( cd "$STAGE" && zip -q -X code.zip index.js )

B64="$(base64 -i "$STAGE/code.zip" | tr -d '\n')"

# 后端地址：显式给了就用，否则保留函数上已配的值（避免误改生产指向）。
if [ -n "${QR_RELAY_TARGET:-}" ]; then
  ENV_JSON="$(printf '{"QR_TARGET":"%s"}' "$QR_RELAY_TARGET")"
else
  ENV_JSON="$("$ALIYUN" fc GET "/2023-03-30/functions/$FN" --region "$REGION" \
    | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin).get("environmentVariables") or {"QR_TARGET":"http://127.0.0.1:4321"}))')"
fi

PAYLOAD="$STAGE/put.json"
python3 - "$B64" "$ENV_JSON" "$HANDLER" "$RUNTIME" "$PAYLOAD" <<'PY'
import json, sys
b64, env, handler, runtime, out = sys.argv[1:6]
json.dump({
    "code": {"zipFile": b64},
    "handler": handler,
    "runtime": runtime,
    "environmentVariables": json.loads(env),
    "timeout": 60,
    "memorySize": 256,
}, open(out, "w"))
PY

echo "部署 $FN ($REGION) → 后端 $(printf '%s' "$ENV_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("QR_TARGET",""))')"
"$ALIYUN" fc PUT "/2023-03-30/functions/$FN" --region "$REGION" \
  --header "Content-Type=application/json;" --body "$(cat "$PAYLOAD")" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  已更新:", d.get("functionName"), "codeSize", d.get("codeSize"), "checksum", (d.get("codeChecksum") or "")[:12])'

URL="$("$ALIYUN" fc GET "/2023-03-30/functions/$FN/triggers" --region "$REGION" \
  | python3 -c 'import json,sys
ts=json.load(sys.stdin).get("triggers") or []
for t in ts:
    h=t.get("httpTrigger") or {}
    if h.get("urlInternet"): print(h["urlInternet"]); break')"
[ -n "$URL" ] || { echo "取不到中继公网地址，检查 http 触发器是否存在" >&2; exit 1; }

echo "中继地址: $URL"

# 自检：三件浏览器真正依赖的事——CORS 头不重复、口令放行、错口令拒绝。
echo "自检 1/3 预检（CORS 头必须各只出现一次）"
PF="$(curl -s -D - -o /dev/null -X OPTIONS "$URL/api/state" \
  -H "Origin: $ORIGIN" -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: x-qr-token")"
DUP="$(printf '%s' "$PF" | grep -ci '^access-control-allow-origin' || true)"
if [ "$DUP" != "1" ]; then
  echo "  ✗ Access-Control-Allow-Origin 出现 $DUP 次，浏览器会判非法" >&2
  printf '%s' "$PF" | grep -i '^access-control' >&2 || true
  exit 1
fi
echo "  ✓ 预检通过，CORS 头无重复"

TOKEN_FILE="${QR_RELAY_TOKEN_FILE:-}"
if [ -n "$TOKEN_FILE" ] && [ -r "$TOKEN_FILE" ]; then
  TK="$(tr -d '[:space:]' < "$TOKEN_FILE")"
  echo "自检 2/3 带口令取数据"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/state" -H "X-Qr-Token: $TK")"
  [ "$CODE" = "200" ] && echo "  ✓ 200" || { echo "  ✗ 期望 200，实得 $CODE" >&2; exit 1; }
  echo "自检 3/3 错口令必须 401"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/state" -H "X-Qr-Token: wrong")"
  [ "$CODE" = "401" ] && echo "  ✓ 401" || { echo "  ✗ 期望 401，实得 $CODE" >&2; exit 1; }
else
  echo "自检 2-3/3 跳过：未提供 QR_RELAY_TOKEN_FILE（口令通常在后端机器上）"
fi

echo "完成。网页入口仍是 GitHub Pages 那个地址，中继只做数据。"
