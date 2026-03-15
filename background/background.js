/**
 * Background Service Worker - V3
 * AI 驱动 + 递归发现 + 多任务发布 + 日志 + Google Sheets
 */

// 导入模块
importScripts('../utils/ai-engine.js', '../utils/logger.js', '../utils/google-sheets.js');

// === 状态 ===
let collectState = {
    isCollecting: false,
    domain: '',
    myDomain: '',
    sources: [],
    backlinks: { ahrefs: [], semrush: [], similarweb: [] },
    myBacklinks: [],
    stats: { backlinksFound: 0, analyzed: 0, blogResources: 0, inQueue: 0 },
    // 递归发现
    discoveredDomains: new Set(),
    discoveryQueue: [],
    discoveryDepth: 0,
    maxDiscoveryDepth: 3,
    maxDiscoveryQueue: 500
};

let publishState = {
    isPublishing: false,
    currentTask: null,
    currentIndex: 0
};

let panelWindowId = null;
let collectTabId = null;

// === 点击图标 → 打开/聚焦悬浮窗口 ===
chrome.action.onClicked.addListener(async () => {
    if (panelWindowId !== null) {
        try {
            await chrome.windows.update(panelWindowId, { focused: true });
            return;
        } catch {
            panelWindowId = null;
        }
    }

    const win = await chrome.windows.create({
        url: 'popup/popup.html',
        type: 'popup',
        width: 420,
        height: 680,
        top: 80,
        left: 50
    });
    panelWindowId = win.id;
});

chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === panelWindowId) panelWindowId = null;
});

// === 消息处理 ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.action) {
        case 'startCollect':
            startCollect(msg.domain, msg.myDomain, msg.sources);
            break;
        case 'stopCollect':
            stopCollect();
            break;
        case 'startPublish':
            startPublish(msg.task);
            break;
        case 'stopPublish':
            stopPublish();
            break;
        case 'backlinkData':
            handleBacklinkData(msg.source, msg.urls);
            break;
        case 'commentAction':
            handleCommentAction(msg.resourceId, msg.result, msg.taskId);
            break;
        case 'getStats':
            sendResponse({ stats: collectState.stats, isCollecting: collectState.isCollecting });
            return false;
        case 'getResources':
            chrome.storage.local.get('resources', (data) => {
                sendResponse({ resources: data.resources || [] });
            });
            return true;
        case 'getTasks':
            chrome.storage.local.get('publishTasks', (data) => {
                sendResponse({ tasks: data.publishTasks || [] });
            });
            return true;
        case 'saveTask':
            savePublishTask(msg.task).then(() => sendResponse({ success: true }));
            return true;
        case 'deleteTask':
            deletePublishTask(msg.taskId).then(() => sendResponse({ success: true }));
            return true;
        case 'getLogs':
            Logger.getAll().then(logs => sendResponse({ logs }));
            return true;
        case 'clearLogs':
            Logger.clear().then(() => sendResponse({ success: true }));
            return true;
        case 'testAiConnection':
            AIEngine.testConnection().then(result => sendResponse(result));
            return true;
        case 'syncToSheets':
            syncToGoogleSheets().then(result => sendResponse(result));
            return true;
        case 'republish':
            republishResource(msg.resourceId, msg.taskId);
            break;
        case 'resetStatus':
            updateResourceStatus(msg.resourceId, 'pending');
            break;
        // Agent UI 事件
        case 'agent:userClose':
            stopPublish();
            break;
    }
});

// ============================================================
// 收集流程 — 单 Tab 复用 + 递归发现
// ============================================================

async function startCollect(domain, myDomain, sources) {
    collectState = {
        isCollecting: true,
        domain,
        myDomain,
        sources,
        backlinks: { ahrefs: [], semrush: [], similarweb: [] },
        myBacklinks: [],
        stats: { backlinksFound: 0, analyzed: 0, blogResources: 0, inQueue: 0 },
        discoveredDomains: new Set(),
        discoveryQueue: [],
        discoveryDepth: 0,
        maxDiscoveryDepth: 3,
        maxDiscoveryQueue: 500
    };

    await chrome.storage.local.set({ collectState: { isCollecting: true, domain, myDomain } });
    broadcastStats();
    await Logger.collect(`开始收集: ${domain}`, { sources });

    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    collectTabId = tab.id;

    // 1. 依次用每个数据源查竞争对手外链
    for (const source of sources) {
        if (!collectState.isCollecting) break;
        const url = getSourceUrl(source, domain);
        if (url) {
            await navigateAndCollect(collectTabId, url, source);
        }
    }

    // 2. 查自己域名用于 Gap 对比
    if (myDomain && collectState.isCollecting) {
        for (const source of sources) {
            if (!collectState.isCollecting) break;
            const url = getSourceUrl(source, myDomain);
            if (url) {
                await navigateAndCollect(collectTabId, url, `my-${source}`);
            }
        }
    }

    try { await chrome.tabs.remove(collectTabId); } catch {}
    collectTabId = null;

    // 3. 合并三源数据
    if (collectState.isCollecting) {
        const merged = mergeBacklinks();
        collectState.stats.backlinksFound = merged.length;
        collectState.stats.inQueue = merged.length;
        broadcastStats();
        await Logger.collect(`合并完成: ${merged.length} 条外链`);

        // 4. Fetch 批量分析
        await fetchAnalyzeAll(merged);

        // 5. 递归发现
        await recursiveDiscovery();
    }

    collectState.isCollecting = false;
    await chrome.storage.local.set({ collectState: { isCollecting: false, domain, myDomain } });
    broadcastToPopup({ action: 'collectDone' });
    await Logger.collect('收集完成');
}

async function navigateAndCollect(tabId, url, source) {
    try {
        await chrome.tabs.update(tabId, { url });
        await waitForTabLoad(tabId);
        await delay(4000);

        const collectorFile = source.replace('my-', '') + '-collector.js';
        await chrome.scripting.executeScript({
            target: { tabId },
            files: [`content/${collectorFile}`]
        });

        if (source.startsWith('my-')) {
            try {
                await chrome.tabs.sendMessage(tabId, { action: 'collectAsMyDomain' });
            } catch {}
        }

        await waitForData(source, 45000);
    } catch (e) {
        await Logger.error(`收集失败 (${source}): ${e.message}`);
    }
}

function getSourceUrl(source, domain) {
    switch (source) {
        case 'ahrefs':
            return `https://ahrefs.com/backlink-checker/?input=${domain}&mode=subdomains`;
        case 'semrush':
            return `https://sem.3ue.co/analytics/backlinks/overview/?q=${domain}&searchType=domain`;
        case 'similarweb':
            return `https://sim.3ue.co/#/digitalsuite/acquisition/backlinks/table/999/?duration=28d&key=${domain}&sort=DomainScore`;
        default:
            return null;
    }
}

function handleBacklinkData(source, urls) {
    if (source.startsWith('my-')) {
        collectState.myBacklinks.push(...urls);
    } else {
        collectState.backlinks[source] = urls;
        collectState.stats.backlinksFound += urls.length;
    }
    collectState[`${source}_done`] = true;
    broadcastStats();
}

async function waitForData(source, timeout) {
    const start = Date.now();
    while (!collectState[`${source}_done`] && Date.now() - start < timeout) {
        await delay(1000);
    }
}

// ============================================================
// 三源合并 + Link Gap
// ============================================================

function mergeBacklinks() {
    const urlMap = new Map();

    for (const [source, urls] of Object.entries(collectState.backlinks)) {
        if (!urls) continue;
        const key = source.charAt(0).toUpperCase();

        for (const url of urls) {
            const norm = normalizeUrlBg(url);
            if (!norm || norm === '/') continue;

            if (urlMap.has(norm)) {
                const entry = urlMap.get(norm);
                if (!entry.sources.includes(key)) entry.sources.push(key);
            } else {
                urlMap.set(norm, { url, normalizedUrl: norm, sources: [key], domain: getDomainBg(url) });
            }
        }
    }

    let merged = Array.from(urlMap.values());

    // Link Gap
    if (collectState.myBacklinks.length > 0) {
        const myDomains = new Set(collectState.myBacklinks.map(u => getDomainBg(u)).filter(Boolean));
        merged = merged.filter(link => !myDomains.has(link.domain));
    }

    merged.sort((a, b) => b.sources.length - a.sources.length);
    return merged;
}

// ============================================================
// Fetch 批量分析
// ============================================================

async function fetchAnalyzeAll(links) {
    const CONCURRENCY = 8;
    const queue = [...links];
    let analyzed = 0;

    async function worker() {
        while (queue.length > 0 && collectState.isCollecting) {
            const link = queue.shift();
            if (!link) break;

            try {
                const result = await fetchAnalyzePage(link);
                if (result && result.opportunities.length > 0) {
                    await saveResource(result);
                }
            } catch {}

            analyzed++;
            collectState.stats.analyzed = analyzed;
            collectState.stats.inQueue = queue.length;
            broadcastStats();
        }
    }

    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
}

async function fetchAnalyzePage(link) {
    let url = link.url;
    if (!url.startsWith('http')) url = 'https://' + url;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
        });
        clearTimeout(timeout);

        if (!response.ok) return null;
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/html')) return null;

        const html = await response.text();

        // 尝试 AI 分类
        let aiResult = null;
        try {
            aiResult = await AIEngine.classifyLink(url, html);
            await Logger.ai(`AI 分类: ${url}`, aiResult);
        } catch {
            // AI 不可用时回退到规则分析
        }

        // 规则分析
        const ruleResult = analyzeHtml(html, url, link);

        // AI 结果增强
        if (aiResult && aiResult.canLeaveLink && !ruleResult) {
            return {
                url,
                pageTitle: html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.trim()?.substring(0, 100) || '',
                opportunities: [aiResult.siteType || 'comment'],
                details: [aiResult.reason || ''],
                sources: link.sources || [],
                linkMethod: 'website-field',
                aiClassified: true
            };
        }

        // 提取评论中的其他网站（为递归发现做准备）
        if (ruleResult && ruleResult.opportunities.includes('comment')) {
            extractCommenterDomains(html);
        }

        return ruleResult;
    } catch {
        clearTimeout(timeout);
        return null;
    }
}

function analyzeHtml(html, url, link) {
    const htmlLower = html.toLowerCase();
    const opportunities = [];
    const details = [];

    // 1. 博客评论表单
    if (htmlLower.includes('commentform') ||
        htmlLower.includes('comment-form') ||
        htmlLower.includes('id="respond"') ||
        htmlLower.includes('wp-comments-post') ||
        htmlLower.includes('leave a reply') ||
        htmlLower.includes('leave a comment') ||
        htmlLower.includes('发表评论') ||
        htmlLower.includes('留下评论')) {
        opportunities.push('comment');
        if (htmlLower.includes('name="url"') || htmlLower.includes('id="url"') ||
            htmlLower.includes('type="url"') || htmlLower.includes('name="website"')) {
            details.push('website-field');
        }
        if (htmlLower.includes('wordpress') || htmlLower.includes('wp-content')) {
            details.push('wordpress');
        }
    }

    // 2. Disqus
    if (htmlLower.includes('disqus_thread') || htmlLower.includes('disqus.com')) {
        opportunities.push('disqus');
    }

    // 3. 论坛
    if (htmlLower.includes('phpbb') || htmlLower.includes('vbulletin') ||
        htmlLower.includes('discourse') || htmlLower.includes('xenforo') ||
        htmlLower.includes('class="forum"') || htmlLower.includes('id="forum"') ||
        htmlLower.includes('new-topic') || htmlLower.includes('create-topic') ||
        htmlLower.includes('reply to thread') || htmlLower.includes('post reply')) {
        opportunities.push('forum');
    }

    // 4. 注册/Profile
    if ((htmlLower.includes('sign up') || htmlLower.includes('register') ||
        htmlLower.includes('create account') || htmlLower.includes('注册')) &&
        (htmlLower.includes('website') || htmlLower.includes('url') ||
            htmlLower.includes('homepage') || htmlLower.includes('profile'))) {
        opportunities.push('register');
        details.push('profile-link');
    }

    // 5. 提交网站
    if (htmlLower.includes('submit your site') || htmlLower.includes('submit a site') ||
        htmlLower.includes('add your site') || htmlLower.includes('submit website') ||
        htmlLower.includes('submit url') || htmlLower.includes('提交网站') ||
        htmlLower.includes('add your link') || htmlLower.includes('submit listing')) {
        opportunities.push('submit-site');
    }

    // 6. Guest Post
    if (htmlLower.includes('write for us') || htmlLower.includes('guest post') ||
        htmlLower.includes('guest article') || htmlLower.includes('contribute') ||
        htmlLower.includes('submit a post') || htmlLower.includes('投稿')) {
        opportunities.push('guest-post');
    }

    // 7. Listing
    if (htmlLower.includes('list your') || htmlLower.includes('submit your startup') ||
        htmlLower.includes('submit your product') || htmlLower.includes('发布网站')) {
        opportunities.push('listing');
    }

    // 8. 富文本编辑器
    if (htmlLower.includes('tinymce') || htmlLower.includes('ckeditor') ||
        htmlLower.includes('quill') || htmlLower.includes('contenteditable="true"')) {
        opportunities.push('rich-editor');
        details.push('可插入链接');
    }

    // 9. Wiki
    if (htmlLower.includes('mediawiki') || htmlLower.includes('action=edit')) {
        opportunities.push('wiki');
    }

    // 10. 通用表单
    if (opportunities.length === 0) {
        const hasTextarea = htmlLower.includes('<textarea');
        const hasUrlInput = htmlLower.includes('type="url"') || htmlLower.includes('name="url"') ||
            htmlLower.includes('name="website"') || htmlLower.includes('name="link"');
        const hasSubmit = htmlLower.includes('type="submit"') || htmlLower.includes('button');

        if (hasTextarea && hasUrlInput && hasSubmit) {
            opportunities.push('form');
            details.push('textarea+url+submit');
        }
    }

    if (opportunities.length === 0) return null;

    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].trim().substring(0, 100) : '';

    return {
        url,
        pageTitle,
        opportunities,
        details,
        sources: link.sources || [],
        linkMethod: details.includes('website-field') ? 'website-field' :
            details.includes('可插入链接') ? 'html' : 'text'
    };
}

// ============================================================
// 递归外链发现
// ============================================================

function extractCommenterDomains(html) {
    const commentSectionPatterns = [
        /<ol class="comment-list">([\s\S]*?)<\/ol>/i,
        /<div id="comments">([\s\S]*?)<\/div>\s*<\/div>/i,
        /<section class="comments">([\s\S]*?)<\/section>/i,
    ];

    let commentsHtml = '';
    for (const pattern of commentSectionPatterns) {
        const match = html.match(pattern);
        if (match) {
            commentsHtml = match[1];
            break;
        }
    }

    if (!commentsHtml) return;

    const linkRegex = /href=["'](https?:\/\/[^"']+)["']/gi;
    let match;
    while ((match = linkRegex.exec(commentsHtml)) !== null) {
        const href = match[1];
        const domain = getDomainBg(href);
        if (domain &&
            !domain.includes('wordpress.com') &&
            !domain.includes('blogger.com') &&
            !domain.includes('gravatar.com') &&
            !domain.includes('google.com') &&
            !domain.includes('facebook.com') &&
            !domain.includes('twitter.com') &&
            !collectState.discoveredDomains.has(domain)) {
            collectState.discoveredDomains.add(domain);
            if (collectState.discoveryQueue.length < collectState.maxDiscoveryQueue) {
                collectState.discoveryQueue.push(domain);
            }
        }
    }
}

async function recursiveDiscovery() {
    if (collectState.discoveryQueue.length === 0) return;
    if (collectState.discoveryDepth >= collectState.maxDiscoveryDepth) return;

    await Logger.collect(`递归发现: 发现 ${collectState.discoveryQueue.length} 个新域名，深度 ${collectState.discoveryDepth + 1}`);

    collectState.discoveryDepth++;
    const domainsToProcess = [...collectState.discoveryQueue];
    collectState.discoveryQueue = [];

    const links = domainsToProcess.map(domain => ({
        url: `https://${domain}`,
        normalizedUrl: domain,
        sources: ['D'],
        domain
    }));

    collectState.stats.inQueue += links.length;
    broadcastStats();

    await fetchAnalyzeAll(links);

    if (collectState.isCollecting && collectState.discoveryQueue.length > 0) {
        await recursiveDiscovery();
    }
}

// ============================================================
// 资源保存
// ============================================================

async function saveResource(result) {
    const data = await chrome.storage.local.get('resources');
    const resources = data.resources || [];
    const normalized = normalizeUrlBg(result.url);
    const exists = resources.some(r => normalizeUrlBg(r.url) === normalized);

    if (!exists) {
        resources.push({
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            url: result.url,
            pageTitle: result.pageTitle,
            type: result.opportunities.join('+'),
            opportunities: result.opportunities,
            details: result.details,
            linkMethod: result.linkMethod,
            sources: result.sources,
            discoveredAt: new Date().toISOString(),
            status: 'pending'
        });
        await chrome.storage.local.set({ resources });

        collectState.stats.blogResources = resources.filter(r => r.status === 'pending').length;
        broadcastStats();
    }
}

// ============================================================
// 多网站发布任务
// ============================================================

async function savePublishTask(task) {
    const data = await chrome.storage.local.get('publishTasks');
    const tasks = data.publishTasks || [];

    if (task.id) {
        const idx = tasks.findIndex(t => t.id === task.id);
        if (idx !== -1) tasks[idx] = { ...tasks[idx], ...task };
    } else {
        task.id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
        task.createdAt = new Date().toISOString();
        task.stats = { total: 0, success: 0, pending: 0, failed: 0 };
        tasks.push(task);
    }

    await chrome.storage.local.set({ publishTasks: tasks });
    await Logger.publish(`保存任务: ${task.name || task.website}`);
}

async function deletePublishTask(taskId) {
    const data = await chrome.storage.local.get('publishTasks');
    const tasks = (data.publishTasks || []).filter(t => t.id !== taskId);
    await chrome.storage.local.set({ publishTasks: tasks });
}

async function startPublish(task) {
    const data = await chrome.storage.local.get('resources');
    const resources = data.resources || [];
    const pending = resources.filter(r =>
        r.status === 'pending' &&
        (r.opportunities?.includes('comment') || r.type?.includes('comment'))
    );

    if (pending.length === 0) return;

    publishState = {
        isPublishing: true,
        currentTask: task,
        queue: pending,
        currentIndex: 0
    };

    await Logger.publish(`开始发布: ${task.name || task.website}`, { total: pending.length });
    await publishNext();
}

async function publishNext() {
    if (!publishState.isPublishing) return;
    if (publishState.currentIndex >= publishState.queue.length) {
        publishState.isPublishing = false;
        broadcastToPopup({ action: 'publishDone' });
        await Logger.publish('发布完成');
        return;
    }

    const resource = publishState.queue[publishState.currentIndex];
    const task = publishState.currentTask;
    let url = resource.url;
    if (!url.startsWith('http')) url = 'https://' + url;

    broadcastToPopup({
        action: 'publishProgress',
        currentUrl: resource.url,
        current: publishState.currentIndex + 1,
        total: publishState.queue.length,
        taskId: task.id
    });

    try {
        // 1. 打开页面
        const tab = await chrome.tabs.create({ url, active: true });
        await waitForTabLoad(tab.id);
        await delay(2000);

        // 2. 注入 page-agent（DOM 操作层）和 comment-publisher（UI 层）
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/page-agent.js']
        });
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/comment-publisher.js']
        });

        // 3. 运行 Agent 循环
        const result = await runAgentLoop(tab.id, task, resource);

        // 4. 处理结果
        if (result.success) {
            if (task.mode === 'full-auto') {
                // 全自动：直接提交
                await sendToTab(tab.id, { action: 'agent:done', success: true, text: '自动提交中...' });
                await submitViaAgent(tab.id);
                await handlePublishResult(resource.id, 'submitted', task.id);
            } else {
                // 半自动：询问用户
                const response = await sendToTab(tab.id, { action: 'agent:confirmSubmit' });
                if (response?.confirmed) {
                    await submitViaAgent(tab.id);
                    await handlePublishResult(resource.id, 'submitted', task.id);
                } else {
                    await sendToTab(tab.id, { action: 'agent:hide' });
                    await handlePublishResult(resource.id, 'skipped', task.id);
                }
            }
        } else {
            await sendToTab(tab.id, { action: 'agent:done', success: false, text: result.reason || '未找到评论表单' });
            await handlePublishResult(resource.id, 'failed', task.id);
        }
    } catch (e) {
        await Logger.error(`发布失败: ${resource.url}`, { error: e.message });
        await updateResourceStatus(resource.id, 'failed');
    }

    publishState.currentIndex++;
    await delay(1000);
    await publishNext();
}

// ============================================================
// Agent 循环 — 核心发布引擎
// ============================================================

const AGENT_MAX_STEPS = 20;

async function runAgentLoop(tabId, task, resource) {
    const history = [];
    const taskDescription = buildTaskDescription(task, resource);

    for (let step = 1; step <= AGENT_MAX_STEPS; step++) {
        if (!publishState.isPublishing) {
            return { success: false, reason: '用户停止发布' };
        }

        try {
            // 1. 扫描页面元素
            const scanResult = await sendToTab(tabId, {
                type: 'PAGE_AGENT', action: 'scan', payload: {}
            });

            if (!scanResult?.success) {
                return { success: false, reason: '页面扫描失败' };
            }

            // 2. 显示状态
            await sendToTab(tabId, {
                action: 'agent:showStatus',
                step, maxSteps: AGENT_MAX_STEPS,
                text: history.length > 0 ? history[history.length - 1].nextGoal || '分析中...' : '正在分析页面...'
            });

            // 3. 调用 AI 决策
            const aiResult = await AIEngine.agentStep({
                elements: scanResult.elements,
                url: scanResult.url,
                title: scanResult.title,
                task: taskDescription,
                history,
                step,
                maxSteps: AGENT_MAX_STEPS
            });

            await Logger.ai(`Agent Step ${step}: ${aiResult.action}`, {
                params: aiResult.params,
                evaluation: aiResult.evaluation
            });

            // 4. 完成？
            if (aiResult.done) {
                return { success: aiResult.success, reason: aiResult.doneText };
            }

            // 5. ask_user？
            if (aiResult.action === 'ask_user') {
                const response = await sendToTab(tabId, {
                    action: 'agent:askUser',
                    question: aiResult.params.question || '请输入验证码'
                });
                history.push({
                    step, action: 'ask_user',
                    params: aiResult.params,
                    result: response?.answer || '(用户未回答)',
                    nextGoal: aiResult.nextGoal
                });
                // 如果用户给了答案，下一步 AI 会用它来填入
                continue;
            }

            // 6. 执行工具
            const execResult = await sendToTab(tabId, {
                type: 'PAGE_AGENT',
                action: aiResult.action,
                payload: aiResult.params
            });

            history.push({
                step,
                action: aiResult.action,
                params: aiResult.params,
                result: execResult?.message || execResult?.error || 'ok',
                nextGoal: aiResult.nextGoal
            });

            // 7. 步间延迟
            await delay(400);

        } catch (e) {
            await Logger.error(`Agent Step ${step} 失败: ${e.message}`);
            history.push({
                step, action: 'error', params: {},
                result: e.message, nextGoal: '重试'
            });
            // 出错后继续尝试
        }
    }

    return { success: false, reason: '超过最大步骤数' };
}

function buildTaskDescription(task, resource) {
    return `Fill the comment form on this blog page.

Commenter info:
- Name: ${task.name || 'Anonymous'}
- Email: ${task.email || ''}
- Website: ${task.website || ''}

Instructions:
1. Find the comment form on this page (scroll down if needed)
2. Generate a genuine, relevant comment based on the page content (2-4 sentences, in the same language as the article)
3. Fill in: comment text, name, email, and website URL
4. Uncheck any notification/subscription checkboxes
5. Check anti-spam checkboxes if present
6. Solve simple math captchas if present
7. Do NOT click the submit button
8. When all fields are filled, call done with success=true`;
}

async function submitViaAgent(tabId) {
    // 扫描页面找到提交按钮
    const scanResult = await sendToTab(tabId, {
        type: 'PAGE_AGENT', action: 'scan', payload: {}
    });
    if (!scanResult?.success) return;

    // 在元素列表中找提交按钮
    const lines = scanResult.elements.split('\n');
    for (const line of lines) {
        const lower = line.toLowerCase();
        if ((lower.includes('type="submit"') || lower.includes('>submit') ||
             lower.includes('>post comment') || lower.includes('>发表评论') ||
             lower.includes('>post ') || lower.includes('>发布')) &&
            (lower.includes('<button') || lower.includes('<input'))) {
            const indexMatch = line.match(/^\[(\d+)\]/);
            if (indexMatch) {
                await sendToTab(tabId, {
                    type: 'PAGE_AGENT',
                    action: 'click_element_by_index',
                    payload: { index: parseInt(indexMatch[1]) }
                });
                await delay(2000);
                return;
            }
        }
    }
}

// 发送消息给 tab 的辅助函数
function sendToTab(tabId, msg) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, msg, (response) => {
            if (chrome.runtime.lastError) {
                resolve(null);
            } else {
                resolve(response);
            }
        });
    });
}

async function handlePublishResult(resourceId, result, taskId) {
    const statusMap = { submitted: 'published', skipped: 'skipped', failed: 'failed' };
    const status = statusMap[result] || result;

    await updateResourceStatus(resourceId, status);
    await Logger.publish(`评论${result}: ${resourceId}`);

    // 更新任务统计
    if (taskId) {
        const data = await chrome.storage.local.get('publishTasks');
        const tasks = data.publishTasks || [];
        const task = tasks.find(t => t.id === taskId);
        if (task) {
            task.stats = task.stats || { total: 0, success: 0, pending: 0, failed: 0 };
            task.stats.total++;
            if (status === 'published') task.stats.success++;
            else if (status === 'failed') task.stats.failed++;
            await chrome.storage.local.set({ publishTasks: tasks });
        }
    }

    // Google Sheets 同步
    try {
        const settings = await getSettings();
        if (settings.googleSheetId) {
            const resData = await chrome.storage.local.get('resources');
            const resource = (resData.resources || []).find(r => r.id === resourceId);
            if (resource) {
                await GoogleSheets.syncPublishLog(settings.googleSheetId, {
                    timestamp: new Date().toISOString(),
                    url: resource.url,
                    status,
                    taskName: publishState.currentTask?.name || ''
                });
            }
        }
    } catch {}
}

// 兼容旧的 commentAction 消息（来自旧版 comment-publisher）
async function handleCommentAction(resourceId, result, taskId) {
    await handlePublishResult(resourceId, result, taskId);
    publishState.currentIndex++;
    await publishNext();
}

async function updateResourceStatus(id, status) {
    const data = await chrome.storage.local.get('resources');
    const resources = data.resources || [];
    const idx = resources.findIndex(r => r.id === id);
    if (idx !== -1) {
        resources[idx].status = status;
        resources[idx].publishedAt = new Date().toISOString();
        await chrome.storage.local.set({ resources });
    }
}

function stopCollect() {
    collectState.isCollecting = false;
    broadcastToPopup({ action: 'collectDone' });
    Logger.collect('手动停止收集');
}

function stopPublish() {
    publishState.isPublishing = false;
    broadcastToPopup({ action: 'publishDone' });
    Logger.publish('手动停止发布');
}

async function republishResource(resourceId, taskId) {
    const data = await chrome.storage.local.get(['resources', 'publishTasks']);
    const resources = data.resources || [];
    const resource = resources.find(r => r.id === resourceId);
    if (!resource) return;

    await updateResourceStatus(resourceId, 'pending');

    const tasks = data.publishTasks || [];
    const task = taskId ? tasks.find(t => t.id === taskId) : tasks[0];
    if (!task) return;

    publishState = {
        isPublishing: true,
        currentTask: task,
        queue: [resource],
        currentIndex: 0
    };
    await publishNext();
}

// ============================================================
// Google Sheets 全量同步
// ============================================================

async function syncToGoogleSheets() {
    try {
        const settings = await getSettings();
        if (!settings.googleSheetId) {
            return { success: false, message: 'Google Sheet ID 未配置' };
        }
        const data = await chrome.storage.local.get('resources');
        const result = await GoogleSheets.syncResources(settings.googleSheetId, data.resources || []);
        await Logger.info(`Sheets 同步完成: ${result.rows} 条`);
        return { success: true, message: `已同步 ${result.rows} 条资源` };
    } catch (e) {
        await Logger.error(`Sheets 同步失败: ${e.message}`);
        return { success: false, message: e.message };
    }
}

// ============================================================
// 工具函数
// ============================================================

function normalizeUrlBg(url) {
    if (!url) return '';
    try {
        let u = url.trim().toLowerCase();
        if (!u.startsWith('http')) u = 'https://' + u;
        const parsed = new URL(u);
        let path = parsed.pathname.replace(/\/+$/, '') || '/';
        return parsed.hostname.replace(/^www\./, '') + path;
    } catch { return url.trim().toLowerCase(); }
}

function getDomainBg(url) {
    try {
        if (!url.startsWith('http')) url = 'https://' + url;
        return new URL(url).hostname.replace(/^www\./, '');
    } catch { return ''; }
}

async function getSettings() {
    return new Promise((resolve) => {
        chrome.storage.local.get('settings', (data) => {
            resolve(data.settings || {});
        });
    });
}

function broadcastStats() {
    broadcastToPopup({ action: 'statsUpdate', stats: collectState.stats });
}

function broadcastToPopup(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {});
}

function waitForTabLoad(tabId) {
    return new Promise((resolve) => {
        function listener(id, changeInfo) {
            if (id === tabId && changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }
        }
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
        }, 30000);
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
