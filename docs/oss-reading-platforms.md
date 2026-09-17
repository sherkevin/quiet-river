# 开源阅读平台调研：能当底座的、只能借零件的

调研日期：2026-09-16。星数、license、最后推送时间均来自当日 GitHub API 实测；
能力判断来自读源码，不只是读 README（README 会撒谎，见 Folo 那条）。

## 需求（用户口述，2026-09-16）

一个**对内开放**的自用平台：没有其他人参与，没有广场，展示的全是自己关注的。
七项能力：

1. 抓取不同信息源
2. 可以有自己的推荐算法，但**只决定什么排在最前面**，不决定看不看得见
3. 站内直接阅读外部内容，不跳到外部网站
4. 阅读时划线高亮、写笔记
5. 能回看自己的笔记
6. 灵活自定义信息源
7. 日报推送

## 结论先行

- **BestBlogs 不开源**，不能当底座。仓库 `ginobefun/BestBlogs`（4026★）无 license
  （`/license` 接口 404，法律上未授权修改），整棵树里**没有一行应用代码**：只有 OPML
  清单、`docs/` 十二篇产品文档、`changelog/`、`cli/`（调自家 API 的客户端）、
  `skills/`、`flows/`（Dify 工作流 YAML）。它的核心资产是 600+ 源的质量池、
  AI 初评 + 编辑精审的运营流程、2 万用户的行为数据——三样都开源不了。
- **NewsBlur 是唯一七项全中的项目**，MIT，可改可商用。
- **Folo 不能自托管**，尽管它 38967★ 且自称「AI RSS Reader」。

## 一、NewsBlur：唯一全中（MIT，7620★，2026-09-16 仍在推）

`samuelclay/NewsBlur`，Django + Backbone.js，技术栈偏老但活跃。

| 需求 | 实现位置 | 证据 |
|---|---|---|
| 1 抓取 | `apps/rss_feeds`、Celery + PubSubHubbub（`apps/push`） | README「Real-time RSS」 |
| 2 推荐算法 | `apps/analyzer/models.py` 的 `compute_story_score()`；`apps/briefing/scoring.py`（29KB） | 见下 |
| 3 站内阅读 | `node/original_page.coffee` + `@jocmp/mercury-parser`；`MStory.original_text_z`（zlib 压缩缓存） | 全文抽取后存自己的库 |
| 4 划线 + 笔记 | `apps/rss_feeds/models.py` `MStarredStory.highlights = ListField(StringField(max_length=16384))` + `user_notes = StringField()` | 字段真实存在 |
| 5 回看笔记 | `starred_stories` collection，按 `(user_id, -starred_date)` 建索引 | 有专门的 Saved/Starred 视图 |
| 6 自定义源 | OPML 导入、`apps/webfeed`、YouTube 频道、Email Newsletter 收件 | README |
| 7 日报推送 | `apps/briefing/`（`summary.py` 48KB、`tasks.py`）；Celery Beat 定时；email 送达 | 见下 |

### 推荐算法的形态正好是用户要的那种

NewsBlur 的 classifier 不删内容，只把故事分成 **focus / unread / hidden** 三档。
这和「推荐只决定什么放最前面，所有展示的都是我关注的」是同一个哲学。

`compute_story_score()` 的输入维度：feed、author、author_regex、tags、title、
title_regex、url、full-text，外加一个 `prompt_score`（AI 打分位）。
`scoring.py` 里的日报选片权重（可直接抄）：

```python
CLASSIFIER_WEIGHTS = {"title": 0.10, "author": 0.08, "tag": 0.06, "feed": 0.03}
# 1. 全局 trending 阅读时长 + 读者数  40%
# 2. feed engagement（trending feed data） 20%
# 3. 用户亲密度 UserSubscription.feed_opens 20%
# 4. 故事新鲜度                        10%
# 5. classifier 分数                   10%
```

注意第 1、2 项依赖**全站聚合数据**，单用户自托管时这两项没有意义（没有别人可读），
要重写成纯个人信号。这是移植时的第一件事。

### 日报模块的可配置程度

`MBriefingPreferences`：frequency（daily / twice_daily / thrice_daily / weekly）、
preferred_time、`story_sources`（`"all"` 或 `"folder:FolderName"`，**可以只给某个 tag
出日报**）、read_filter（unread / focus）、summary_length、
summary_style（editorial / bullets / headlines）、`custom_section_prompts`
（最多 5 条自定义 prompt）、`section_order`。

模型走 BYOK：`BRIEFING_MODEL` / `ASK_AI_MODEL` / `WEBFEED_MODEL` 各可设
anthropic / openai / google / xai。

### 代价

- **重栈六件套**：PostgreSQL（feeds/subscriptions/accounts）+ MongoDB（stories 与已读态）
  + Redis（story assembly 与缓存）+ Elasticsearch（搜索，可选）+ Celery（抓取）
  + Node 服务（文本抽取与图片处理）。`make` 一条命令起，但 2C2G 的 ECS 要掂量。
- **社交是核心模块不是插件**：`apps/social`（MSharedStory / blurblog / comments / follows）、
  `apps/discover`、`apps/recommendations`（带人工审批工作流的 RecommendedFeed）。
  单用户形态要把这些关掉：改 `HOMEPAGE_USERNAME`、不启用 social。剥离是工作量。
- Backbone.js 前端，改 UI 不如现代框架顺手。

## 二、Folo：星最高但不能自托管（AGPL-3.0，38967★）

**README 完全没提 self-host**，这不是遗漏。实测 `apps/` 目录只有：
`cli`、`desktop`、`landing`、`mobile`、`ota`、`ssr`——**没有 server**。
后端是闭源云服务（issue #4301 有用户抓包发现「没有请求发向我自己的 rsshub 实例，
folo 后端 api 返回 `is_new: false`」）。开源的是客户端外壳，账号、同步、AI 都在他们云上。

所以 Folo 与 BestBlogs 是同一类东西的两种包装：闭源服务 + 开源壳。

## 三、可当备选底座的（都缺至少两项）

| 项目 | 星 | License | 站内阅读 | 划线/笔记 | 推荐算法 | 日报 | 定位 |
|---|---|---|---|---|---|---|---|
| `omnivore-app/omnivore` | 16251 | AGPL-3.0 | 有 | 有 highlights/notes | 无 | 无 | read-it-later；云已于 2024-11 废弃，现纯自托管 |
| `linkwarden/linkwarden` | 19771 | AGPL-3.0 | 有 reader view | 有 highlight + annotate | 仅 AI 打标 | 无 | bookmark + 网页存档（截图/PDF/单 html）；有 RSS 订阅 |
| `wallabag/wallabag` | 12967 | MIT | 有 | 有 annotation | 无 | 无 | read-it-later 老牌，PHP |
| `karakeep-app/karakeep` | 29067 | AGPL-3.0 | 有 | 笔记有 | AI 打标 | 无 | bookmark-everything，不是 feed 主导 |
| `samuelclay/NewsBlur` | 7620 | MIT | 有 | 有 | 有 | 有 | **唯一全中** |
| `LeslieLeung/glean` | 866 | AGPL-3.0 | 有 | 无 | WIP | 无 | README 自述「not ready for production use」；AI 推荐、规则引擎、全文抓取全在 Planned |
| `DevXDojo/MrRSS` | 2536 | GPL-3.0 | 有 | 无 | 无 | 无 | Go + Wails 桌面端，中文，AI 翻译摘要 |
| `FreshRSS/FreshRSS` | 16034 | AGPL-3.0 | 部分 | 无 | 无 | 无 | 老牌自托管，无 AI 层 |
| `miniflux/v2` | 9700 | Apache-2.0 | 部分 | 无 | 无 | 无 | 极简，哲学上离 quiet-river 最近 |
| `fossar/selfoss` | 2470 | GPL-3.0 | 有 | 无 | 无 | 无 | 轻量聚合 |
| `Athou/commafeed` | 3620 | Apache-2.0 | 部分 | 无 | 无 | 无 | Java，Google Reader 风 |
| `feedbin/feedbin` | 3776 | MIT | 有 | 无 | 无 | 有 newsletter 收件 | Ruby，商业服务的代码 |
| readeck（Codeberg，非 GitHub） | — | GPL-3.0 | 有 | 划线有，**笔记不支持** | 无 | 无 | 第三方评测明确指出不能给 highlight 加笔记 |

## 四、可借的零件（不整体换底座时用）

| 零件 | 来源 | 用途 |
|---|---|---|
| 全文抽取 | `adbar/trafilatura`（6824★，Apache-2.0）；`@jocmp/mercury-parser`（NewsBlur 在用） | 站内阅读的技术基础 |
| 无 feed 站点转 RSS | `RSS-Bridge/rss-bridge`（9236★，Unlicense） | 补第 3 档平台 |
| 公众号自部署 | `rachelos/we-mp-rss`（4640★，**LICENSE 文件确认 MIT**，2026-09-10 推） | 解 ADR 0011 遗留的 17 个手记号；Docker 一行起；带 Webhook/API/Agent 接入。风险同源：靠微信扫码授权，与已死的 wewe-rss、被排除的 zlzchat 同机制家族，但**抓取在自己手里**，比那两个强 |
| AI 评分 prompt | `ginobefun/BestBlogs` 的 `flows/Dify/dsl/v4/*.yml` | 已存到 `data/experiments/bestblogs/`（gitignore 内）。**公开的分析 prompt 与官网宣传的「六维评分」对不上**：DSL 里实际是内容深度 40 + 相关性 30 + 实用性 20 + 创新性 10 + 减分项；README 说的选题/内容/深度/实用/创新/表达是后来的迭代，没跟着开源。它明确写了反通胀规则（「宁可偏低 2-3 分」「90+ 应极其稀有」），这套校准比 rubric 本身更值钱 |
| 划线/笔记的前端实现 | `omnivore` 的 highlights 服务（`NEXT_PUBLIC_HIGHLIGHTS_BASE_URL`，独立微服务） | 只借标注层时的参考 |

死路两条，别再走：`cooderl/wewe-rss`（9667★，MIT，**archived 2026-03-20**，
抓取托管在已物理消失的闭源单点）；`hellodword/wechat-feeds`（archived 2021）。

## 五、与 quiet-river 的关系

本项目已经解决了最难的那一块：多平台抓取，含知乎内部 API 与小红书浏览器会话两条
登录态通道（`lib/adapters.private.js`，115 + 13 源）。NewsBlur 对中文平台的抓取能力
远不如我们——它没有知乎/小红书/公众号的任何通道。

所以三条路：

- **A. NewsBlur 当底座**，把我们的抓取适配器移植进去，关掉 social/discover。
  得到的是七项能力开箱即用，代价是六件套依赖 + Django/Backbone 栈 + 剥离社交的工作量。
- **B. 在 quiet-river 上自建**，从 NewsBlur 借三样：`MStarredStory` 的
  highlights/user_notes 数据形状、`scoring.py` 的权重结构（去掉依赖全站数据的两项）、
  `briefing/` 的日报分区与 prompt 组织方式。保持零依赖单文件的现有形态。
- **C. 混合**：quiet-river 继续当抓取与时间轴层，划线/笔记与日报单独起一个
  omnivore 或 linkwarden，两边靠链接互通。集成成本最低，体验最割裂。

B 与 README 第一段的立场最一致（「没有推荐算法，你关注谁就看到谁」——NewsBlur 的
三档 classifier 恰好是「不删只排序」，可以兼容；但 BestBlogs 式的公共质量池不行）。
选型未定，先记录调研事实。
