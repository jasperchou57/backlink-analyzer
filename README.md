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
