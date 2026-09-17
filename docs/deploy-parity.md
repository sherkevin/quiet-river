# 新机器对齐配置：要让效果和原机一致，配哪些登录态

一句话核心：**严格说只有知乎需要配 cookie**（其中核心字段是 `z_c0`）；小红书不走 cookie 而是本机浏览器会话；B站要的是自托管 RSSHub，不是凭证。此外还有一个比 cookie 更靠前的前提——私有适配器文件本身不在仓库里，得先从原机拷过去。

clone 之后 `node server.js`，河已经九成满：所有一档源（博客、GitHub、arXiv 等）和公众号/X 的转发源第一次刷新就是活的，知乎与小红书停在随仓库带的快照时刻。要让这两家也活起来、B站能刷，按下面的顺序补。

## 总览

| 内容源 | 要配什么 | 不配的后果 |
|---|---|---|
| 一档源（博客、GitHub、arXiv、CSDN、YouTube 等） | 什么都不用 | —（开箱即活） |
| 微信公众号、X / Twitter | 什么都不用（贴公开转发地址） | —（命脉在转发服务，见 README） |
| 知乎 | 适配器文件 + 自己的知乎 cookie | 停在快照，「读档」不更新 |
| 小红书 | 适配器文件 + 本机 CLI 登录会话（不是 cookie） | 同上 |
| B站 | 自托管 RSSHub + 设置里的 `rsshubBase` | B站源进问题栏，旧内容保留 |

## 第 1 步（前提）：私有适配器文件

没有适配器，cookie 无处可用：公开仓库刻意不带登录态适配器的实现（原因与插件位机制见 [`docs/private-adapters.md`](private-adapters.md) 第一、二节）。新机器要把这个文件补上：

- **从原机拷 `lib/adapters.private.js` 到新机器的同一相对路径**。它被 `.gitignore` 排除，不会随 `git clone` 过来，只能自己传（scp / AirDrop / U 盘均可）。
- 不建议照插件位文档重写一份——原机有现成实现，重写只会引入偏差。

拷完重启服务并验证挂载（`require` 有缓存，必须重启）：

```bash
node server.js
curl -s http://127.0.0.1:4321/api/state | grep -o '"adapterPlatforms":\[[^]]*\]'
```

输出里出现 `zhihu` 和 `xiaohongshu` 即挂载成功。没出现就是文件路径不对或语法有误，看启动报错。

## 第 2 步：知乎 cookie

**取法——必须走 Network 面板：**

1. 浏览器登录知乎。
2. 开发者工具 → **Network** 面板 → 刷新页面。
3. 点第一条发往 `zhihu.com` 的请求，右侧 **Request Headers** 里找到 `Cookie:` 一行，复制整行的值。
4. 核心字段是 `z_c0`：它是 HttpOnly 的，控制台里 `document.cookie` 读不到，只有实际请求头里有。整行照抄最省事；想精简就只保留 `z_c0` 那一个字段。

**放到哪——让报错信息告诉你确切位置。** 适配器缺凭证时抛的错误消息里写明了凭证文件名和等效的环境变量名，二者任选其一：

- 在页面上对任一知乎源点一次「刷新」，问题栏会显示形如「把整段 Cookie 贴进 secrets/<文件名>（单行），或设环境变量 <名字>」的提示，照做即可。文件内容就一行，是粘贴的 cookie 值本身，不带引号。
- 存好后收紧权限，并确认它真的进不了仓库：

```bash
chmod 600 secrets/*.txt
git check-ignore -v secrets/   # 必须打印忽略规则
```

**失效与限流的判别：** 403 ≠ cookie 失效。关注列表翻页太快、逐人探测太密都会 403，退避一两分钟就恢复。判据：403 之后先做一次单点健康检查，**单点也 403 才是真失效**，那时再重贴。频繁重登会作废旧 cookie，别轻易重登。详见 [`docs/private-adapters.md`](private-adapters.md) 第四节。

## 第 3 步：小红书——不是 cookie

小红书的登录态绑在浏览器会话上，cookie 寿命极短且导不出来，所以适配器不读凭证文件，而是调用一个能驱动本机已登录浏览器的命令行工具取数。新机器需要：

1. 装上与原机同一套浏览器驱动 CLI 工具链。**工具名不用猜**：对任一小红书源点一次「刷新」，问题栏的报错会直接告诉你先跑哪条登录命令。
2. 在该机器的浏览器里登录小红书网页版，然后跑一次报错里给出的 login 命令，工具会驱动浏览器并存下会话。
3. 之后适配器自动通过它取数。换网络可能触发风控，重新 login 一次即可。

已知局限：该通道只返回标题、封面、赞数，**没有昵称**，所以添加新的小红书博主时要自己填名字。

**坑：服务进程的 PATH 不等于你终端的 PATH。** 这个 CLI 工具通常装在 `/opt/homebrew/bin`
（Apple Silicon Homebrew）或 `/usr/local/bin`，你在终端手敲能跑通，但 launchd/systemd 给
服务进程的 PATH 是精简的（实测 Mac 上 launchd 给的是 `/usr/bin:/bin:/usr/sbin:/sbin`），
不含那两个目录，于是适配器 `execFile` 这个工具时报 `ENOENT`。更隐蔽的是第二层：这个 CLI
自己是个 node 脚本，shebang 还要靠 PATH 找 `node`，所以就算用绝对路径找到了它，它内部还会
报 `env: node: No such file or directory`。

适配器自己处理了这两层（绝对路径解析 + 给子进程补上当前 node 所在目录），所以第 1 步拷过来的
文件在标准安装位置下不用你管。**如果你拷的是旧版本、或者 CLI 装在非标准位置，就要出手**：
问题栏会明确报「找不到 <工具名> 可执行文件（PATH=...）」，这时设一个环境变量 `QR_OPENCLI_BIN`
指向它的绝对路径即可。这个变量由服务进程读取，所以要设在服务托管的配置里而不是 shell 里：
launchd 在 plist 加 `EnvironmentVariables` 字典，systemd 在 unit 加 `Environment=` 或写进
`EnvironmentFile` 指的那个文件。判别方法：在终端跑 `which <工具名>` 看它到底在哪，再对照报错
里打出来的 PATH 缺了哪个目录。

这个坑只发生在**装了私有适配器的那台机器**上。ECS 那份刻意不带 `adapters.private.js`（见第 1 步），
所以当前不会触发——它报的是「未知适配器 xiaohongshu」，那是另一回事（缺文件，不是缺路径）。
但你若哪天真把适配器装上 ECS，这一条同样要查。两边的默认 PATH 实测不一样，这正是要分清的地方：

| 服务托管 | 给服务进程的 PATH（实测） |
|---|---|
| launchd（Mac） | `/usr/bin:/bin:/usr/sbin:/sbin` |
| systemd（Ubuntu 24.04 ECS） | `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/snap/bin` |

systemd 那份含 `/usr/local/bin`，所以 `npm i -g` 装的东西在 ECS 上能直接找到，launchd 那份连
Homebrew 目录都没有。判别方法两边一样：报错里会打出当时的 PATH，对照 `which <工具名>` 的结果看
缺了哪个目录。

## 第 4 步（B站）：RSSHub，不是 cookie 但对齐必需

仓库自带设置 `rsshubBase=http://127.0.0.1:1200`（随 `data/subscriptions.json` 发布），所以新机器只需要真的把一个 RSSHub 跑在 1200 端口：clone → `pnpm install` → `pnpm build` → 带 `CHROMIUM_EXECUTABLE_PATH` 启动。四个实测坑（Node 版本、pnpm 10 配置迁移、先 build、chromium 硬依赖）全部写在 README 的「添加博主」第 2 档段落，照做即可。

RSSHub 没起时，B站源会进问题栏，但上次抓到的内容保留，不影响其他源。

## 不用配的部分

博客、GitHub、arXiv、CSDN、掘金、少数派、即刻、Hacker News、Semantic Scholar、播客，以及公众号（wechat2rss 公开目录）与 X（api.xgo.ing 转发）——全是匿名通道，clone 后第一次自动刷新即活。

## 红线

- 凭证与适配器实现**永不进仓库**：`secrets/`（除 README）与 `lib/adapters.private.js` 都在 `.gitignore` 里，放完文件用 `git check-ignore -v` 验一遍。
- cookie 是登录态的等价物，泄露等于交出账号；只放自己的。
- 低频抓取：登录态通道普遍限流，读到 403 就停手退避，不要轮询。
