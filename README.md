# Backlink Gap Analyzer

一个基于 Chrome Extension MV3 的外链发现与发布系统。

它的目标不是单纯“自动发评论”，而是把 **竞品外链挖掘、评论区递归扩散、浏览器执行、经验沉淀、本地数据库记忆** 串成一套能持续进化的闭环。

## 项目定位

这套项目当前主要服务 5 件事：

1. 从 `Ahrefs / Semrush / Similarweb` 等来源收集竞品外链线索
2. 识别哪些资源是真正可发布的评论页 / 资料页 / 目录页
3. 在浏览器真实页面里完成表单定位、评论生成、字段填写、提交流程
4. 把成功/失败、站点模板、审核策略、来源证据沉淀到本地数据库
5. 用资源分层、模板记忆和自动调度，让系统越跑越准

## 核心思路

这套系统遵循的不是“AI 看 HTML 猜表单”，而是更接近下面这条路线：

- 先从竞品外链出发，找到高证据来源
- 再识别可评论/可留链的资源页
- 再通过评论区里的评论者网站做递归扩散
- 浏览器插件负责真实打开页面、滚动、定位评论区、填写、提交、验证
- 每次发布都会沉淀到模板和本地库里，反哺下一轮排序和执行

一句话总结：

> 竞品外链挖掘 + 评论区递归扩散 + 浏览器执行 + 模板/数据库沉淀

## 当前已落地能力

### 发现层

- `Ahrefs / Semrush / Similarweb` 采集入口
- 连续发现与递归域名扩散
- 来源证据记录
- 发现池 / frontier 调度

### 识别层

- 资源类型分类：`blog-comment / profile / inline-comment / weak`
- 留链能力分类：
  - `website-field`
  - `raw-html-anchor`
  - `rich-editor-anchor`
  - `markdown-link`
  - `bbcode-link`
  - `plain-url`
  - `profile-link`
- 低摩擦资源优先级评估

### 执行层

- 标准评论页独立快链
- 通用评论页执行器
- `fast / hybrid / ai` 三档执行策略
- `anchor-prefer / anchor-html(strict)` 两种锚文本策略
- 自动提交、待审核识别、回页复查定位

### 沉淀层

- IndexedDB / LocalDB 主存储
- 站点模板记忆：`host + form signature + editor type + link mode`
- 发布尝试记录
- 域名级发布策略与冷却

### 调度层

- 自动发布队列
- 批量任务顺序执行
- 来源分层与资源排序
- 失败跳过 / 冷却重试 / 审核中挂起

## 技术链

### 运行形态

- Chrome Extension Manifest V3
- Background Service Worker
- Content Scripts
- Side Panel UI

### 前端与运行时

- 原生 JavaScript
- Chrome APIs
  - `tabs`
  - `scripting`
  - `storage`
  - `alarms`
  - `sidePanel`
  - `identity`

### 数据层

- IndexedDB 封装：本地主数据库
- Chrome Storage：兼容迁移与部分状态存储
- Google Sheets：可选外部同步接口

### 智能层

- AI 表单识别
- AI 评论生成
- 规则优先、AI 补位

### 外部来源

- Ahrefs 页面采集
- Semrush 页面采集
- Similarweb 页面采集

## 目录结构

```text
background/
  background.js                  # 主后台服务、消息路由、调度与注入
  core/
    collector-runtime.js         # 外链采集运行时
    continuous-discovery-engine.js
    frontier-scheduler.js        # 递归扩散/发现池调度
    publish-runtime.js           # 发布会话与队列执行
    publish-memory.js            # 站点模板/发布尝试沉淀
    resource-store.js            # 资源存储封装
    state-store.js               # 状态存储封装
    task-manager.js              # 任务状态机
    task-runner.js               # 工作流执行器
    task-store.js                # 任务存储
  tasks/
    discover-workflow.js
    publish-workflow.js

content/
  ahrefs-collector.js
  semrush-collector.js
  similarweb-collector.js
  page-analyzer.js
  comment-preflight.js           # 评论区预处理
  comment-standard-flow.js       # 标准评论页快链
  comment-executor.js            # comment 专用执行器
  comment-publisher.js           # 评论发布主执行器

popup/
  popup.html
  popup.css
  popup.js
  resource-panel.js

utils/
  workflows.js
  resource-rules.js
  local-db.js
  ai-engine.js
  google-sheets.js
  backlink-merger.js
  logger.js
```

## 本地运行

当前项目没有构建步骤，直接以 Chrome 扩展形式运行。

### 1. 加载扩展

1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 指向当前仓库根目录

### 2. 基础配置

- 在扩展设置里填入评论人名称、邮箱、网站
- 如果需要 Google Sheets，同步前先替换 `manifest.json` 里的 OAuth Client ID

## 当前工程判断

这套代码已经不再是最初那种纯补丁式插件，但还在持续演进中。

目前最明确的工程方向是：

- 标准评论页继续走独立快链
- 通用评论页保留规则 + AI 的混合执行
- 继续把大文件逻辑外提为独立模块，避免回到屎山

## 文档

- 架构与方法论说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

# ⚙️ 当前开发进度（给下一个对话的接力说明）

> 这段是给下一个 Claude Code 对话看的，方便它直接接上当前的开发状态。
> **上一轮对话上下文已满**，主要工作是修复发布流程中的大量 bug 和性能问题。

## 整体架构改造（已完成）

1. **本地 SQLite 数据服务** — `~/claude/backlink-analyzer/server/`
   - Node.js + Express + better-sqlite3
   - 监听 `127.0.0.1:21891`
   - 数据库文件：`~/backlink-analyzer-data/backlink-analyzer.db`
   - 通过 `launchctl` 开机自启动（`~/Library/LaunchAgents/com.backlink-analyzer.server.plist`)

2. **`local-db.js` 改造** — 从 IndexedDB 切换到 HTTP API 调用本地 SQLite 服务

3. **从 Autolink 项目移植的增强**（已完成）：
   - 网络响应拦截器（`content/network-inspector.js` + `network-inspector-bridge.js`）
   - 多语言表单字段关键词（`content/comment-form-detection.js` 的 `ML_KEYWORDS`）
   - AI 模型双支持（Gemini + 通义千问 Qwen-Plus，OpenAI 兼容模式）

## 采集质量优化（已完成）

设计文档：`~/.gstack/projects/japser/japser-unknown-design-20260403-193225.md`

- **URL 特征前置过滤**（`background/background.js` 的 `isLowQualityCollectUrl`）
  - 过滤 `/category/`、`/tag/`、`/author/`、`/search/` 等非文章页
  - 过滤 `.gov`/`.edu`/`.mil` 域名
  - 过滤社交媒体域名
  - 过滤非 HTML 文件扩展名

- **连续失败域名跳过**（`background/core/frontier-scheduler.js`）
  - `shouldSkipDomain()`:blocked ≥3 且 success=0 且 analyzed ≥3 则跳过
  - `isUnwantedDomain()`:.edu/.gov/.mil 和社交媒体域名直接跳过

- **哥飞标准第 3 条：评论区带链接的评论数量**
  - `utils/html-comment-detection.js` 的 `analyze()` 返回 `commentAnchorCount`
  - `background/core/resource-store.js` 的 `sanitizeResourceForStorage` 已加入存储
  - `background/core/bg-utils.js` 的 `getResourcePublishRankingScore`:≥3 条 +3200 分, 1-2 条 +1200 分
  - `background/background.js` 的 `fetchAnalyzeAll`:有评论区但 0 条带链接 → 不入库

## 发布流程改造（已完成）

### UI 修复
- 大方框"已发布"数量绑定"已提交锚文本"（`popup/task-panel.js`）
- "今日成功发布"改为"今日成功锚文本"，用后端按日期重置的 `currentLimitCount`
- `anchor-prefer` 模式也按 anchor success 计数（`background/core/publish-flow.js`）

### AI 表单识别
- 提交按钮查找：规则找不到时调 AI 识别（`findSubmitButtonWithAI`）
- 单按钮兜底：表单内只有一个可见按钮时直接用

### 防超时机制
- 阶段超时时间大幅增加（`WORKFLOW_STAGE_TIMEOUTS`):
  - `filling_form: 45-65 秒`
  - 后台 `PUBLISH_STAGE_WATCHDOG_MS.filling_form: 50 秒`
  - `PUBLISH_WATCHDOG.DISPATCH_MS: 35 秒`
- `pokeWorkflowStallTimer()` 活动心跳：打字每 10 字符重置一次超时
- ⚠️ **已废弃 pause/resume 机制**（改用 poke，因为 pause 后如果异常永远不恢复）

### Service Worker 休眠兜底
- **`chrome.alarms` 双重看门狗**（`background/background.js` 的 `handlePublishWatchdogAlarm`）
  - `setTimeout` 看门狗为主（快速响应）
  - `chrome.alarms` 为辅（Service Worker 休眠时兜底，延迟 setTimeout + 15 秒）
  - alarm 元数据存在 `chrome.storage.session`
- 超时失败不再重试（`publish-flow.js` 的 `getPublishFailureRecoveryPolicy`):
  - `publish-runtime-timeout` / `submit-confirm-timeout` → `retryable: false`

### 表单识别加固
- **订阅/搜索/登录表单排除**（`content/comment-form-detection.js` 的 `scoreCommentForm`):
  - signature/className/action 含 subscribe/newsletter/mailchimp/login/search → 返回 -100
  - 没有 textarea + 有 email 字段 → 返回 -100
  - 文字含 "Send now"/"Download"/"Get the link" → 返回 -100
  - 没有 textarea 且输入框 ≤2 且 id 不含 comment → 返回 -100
  - **`findRuleBasedCommentForm` 过滤掉 score > 0 的表单才能被选中**

### 网络拦截双重验证
- `comment-publisher.js` 提交后监听 `__bla_network_signal`
- network-inspector 拦截 Fetch/XHR POST 分析响应
- moderation/confirmed/rejected 三种信号分别处理

### 中文错误提示弹窗
- `showFailureToast()` 页面正中央红色大弹窗
- 后台跳过时通过 `chrome.scripting.executeScript` 注入弹窗代码
- 各阶段具体原因映射（`FAILURE_REASON_CN`）

### Alert 拦截（最新改动）
- **已改成注入到页面上下文（main world）** 而不是 content script 上下文
- 通过 `<script>` 标签注入 `window.alert` / `window.confirm` 覆盖
- 防止网站 JS 的 alert 阻塞页面

### 多语言隐私/反垃圾复选框（已加强）
- `checkAntiSpamBoxes` 加入 30+ 语言的隐私条款关键词
- 德语 Datenschutz、法语 confidentialité、西语 privacidad 等

### 自动调度修复
- **一次只启动一个任务**（`background/core/auto-publish-dispatch.js`）
- `activeTaskIdSet.size > 0` 时不启动新任务
- 循环里 `break`，只启动最高分候选

### 白屏页面检测
- `publish-runtime.js` 的 `dispatchQueue` 注入脚本前检查 Tab URL
- `about:blank` / `chrome-error://` 直接跳过

## 持续发现逻辑修复

- **seedInitialized 不再因 pendingFrontierDomains=0 被重置**（`task-manager.js`）
- **`runSeedInitialization` 加 frontier 检查**：已有待处理域名时跳过种子采集（`continuous-discovery-engine.js`）
- **修复 Service Worker 消息超 64MB 限制**：`getDomainIntelView` 只传前 200 个给 popup

## 已知问题（下一轮对话需要处理）

### 🔴 严重：发布卡死问题仍未完全解决

虽然加了 `chrome.alarms` 兜底，但用户反馈**还是会卡住很久**。根因可能是：

1. **Service Worker 休眠后 alarm 触发但处理逻辑卡住** — `handlePublishWatchdogAlarm` 可能被 `chrome.storage.session.get` 阻塞
2. **content script 的 `executeFillFieldsStep` 内部某个 await 永不返回**
3. **`fillResolvedField` 里 `applyFieldValue` 里的验证循环可能死循环**

**下一步排查方向：**
- 在 `chrome://extensions` 打开 Service Worker 控制台，查看具体卡在哪一行的日志
- 给 `applyFieldValue` 加外层 Promise.race 超时
- `dispatchQueue` 主循环加硬性 60 秒兜底（即使 content script 完全没响应也能强制跳下一个）

### 🟡 中等：部分发布成功但锚文本计数为 0

数据统计：91 条 published 但今日成功锚文本 = 0。
原因：`anchorVisible` 验证失效，评论发出去了但回页复查没找到锚点。
需要查看：`publish-flow.js` 的 `updateResourceStatus` 和 `anchor-verifier.js`

### 🟡 中等：提交按钮文字匹配不够全面

当前 `findSubmitButton` 第 2072 行的关键词还缺少：
- 葡萄牙语 `publicar comentário`
- 意大利语 `invia commento`
- 其他非英语 submit 文本
虽然有 AI 兜底，但规则层应该尽量覆盖。

### 🟢 轻微：`commentAnchorCount` 历史数据缺失

之前采集的资源没有这个字段，需要重新分析才能补全。但这个不影响新采集的资源。

## 项目文件位置

- **项目代码**：`/Users/japser/claude/backlink-analyzer/`
- **数据库**：`/Users/japser/backlink-analyzer-data/backlink-analyzer.db`
- **本地服务**：`/Users/japser/claude/backlink-analyzer/server/index.js`（端口 21891）
- **LaunchAgent**：`/Users/japser/Library/LaunchAgents/com.backlink-analyzer.server.plist`
- **设计文档**：`/Users/japser/.gstack/projects/japser/japser-unknown-design-20260403-193225.md`

## 用户偏好提醒

- **沟通用中文**
- **不要频繁弹权限确认框**（已在 `.claude/settings.local.json` 里配置 `Bash(*)`、`Read(*)` 等通配符）
- **用户是技术小白**，解释时用大白话，不要堆专业名词
- **先讨论再改代码**，用户明确说"讨论"时不要直接动手

## 建议的下一步操作顺序

1. 打开 `chrome://extensions` → Backlink Analyzer → 检查 Service Worker 控制台日志
2. 找出具体哪一步卡住了（是 content script 还是 background？）
3. 在卡住的位置加 Promise.race 硬性超时
4. 测试一批资源，验证发布成功率是否回升
5. 如果还有问题，考虑把 `dispatchQueue` 整个包一层 60 秒硬超时

