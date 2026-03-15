/**
 * Publisher - 发布引擎模块
 * 从 background.js 提取，负责 Agent 循环、任务管理、发布流程
 */

// === 发布状态 ===
let publishState = {
    isPublishing: false,
    currentTask: null,
    currentIndex: 0
};

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

async function startPublish(task, resourceIds) {
    const data = await chrome.storage.local.get('resources');
    const resources = data.resources || [];

    let pending;
    if (resourceIds && resourceIds.length > 0) {
        // 发布指定的资源（从资源库的"开始"按钮）
        pending = resources.filter(r => resourceIds.includes(r.id));
    } else if (task.categoryFilter) {
        // 按分类发布（从任务卡片的分类▶按钮）
        const cat = task.categoryFilter;
        pending = resources.filter(r => {
            if (r.status !== 'pending') return false;
            const opps = r.opportunities || [r.type] || [];
            if (cat === 'comment') return opps.includes('comment');
            if (cat === 'submit-site') return opps.includes('submit-site');
            if (cat === 'forum') return opps.includes('forum');
            // listing = everything else
            return !opps.includes('comment') && !opps.includes('submit-site') && !opps.includes('forum');
        });
    } else {
        // 发布所有待发布资源
        pending = resources.filter(r => r.status === 'pending');
    }

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
