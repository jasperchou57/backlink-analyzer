/** Marketing automation orchestration - extracted from background.js */

async function startMarketingAutomation(options = {}) {
    await ensureMarketingAutomationLoaded();
    const forcePromotionRefresh = options.forcePromotionRefresh !== false;

    if (marketingAutomationState.isRunning && !marketingAutomationState.isPaused) {
        return { success: false, message: '持续宣传已在运行中。' };
    }

    const tasks = await TaskStore.getTasks();
    const metrics = getMarketingAutomationMetrics(tasks);
    const nextTask = selectNextMarketingTask(tasks, { forcePromotionRefresh });

    if (!nextTask) {
        if (metrics.scheduledPromotionTasks > 0) {
            const nextRefreshLabel = formatMarketingRefreshAt(metrics.nextPromotionRefreshAt);
            await updateMarketingAutomationState({
                isRunning: false,
                isPaused: true,
                pauseReason: 'scheduled',
                phase: 'scheduled',
                phaseLabel: '等待下一次调研',
                currentTaskId: '',
                currentTaskName: '',
                currentTaskType: '',
                pendingTasks: 0,
                dueNurtureTasks: 0,
                scheduledPromotionTasks: metrics.scheduledPromotionTasks,
                nextPromotionRefreshAt: metrics.nextPromotionRefreshAt || '',
                lastCompletedAt: new Date().toISOString(),
                lastMessage: nextRefreshLabel
                    ? `当前渠道都已推进完，将在 ${nextRefreshLabel} 自动继续调研。`
                    : '当前渠道都已推进完，等待下一次自动调研。'
            });
            return {
                success: false,
                message: nextRefreshLabel
                    ? `当前没有待推进的营销任务，下一次会在 ${nextRefreshLabel} 自动继续。`
                    : '当前没有待推进的营销任务，等待下一次自动调研。'
            };
        }

        await updateMarketingAutomationState({
            isRunning: false,
            isPaused: true,
            pauseReason: 'completed',
            phase: 'completed',
            phaseLabel: '无待执行任务',
            currentTaskId: '',
            currentTaskName: '',
            currentTaskType: '',
            pendingTasks: 0,
            dueNurtureTasks: 0,
            scheduledPromotionTasks: 0,
            nextPromotionRefreshAt: '',
            lastCompletedAt: new Date().toISOString(),
            lastMessage: '当前没有待推进的营销任务'
        });
        return { success: false, message: '当前没有待推进的营销任务。' };
    }

    await updateMarketingAutomationState(
        TaskManager.buildStartMarketingAutomationPatch(marketingAutomationState, {
            ...metrics,
            pendingTasks: metrics.pendingTasks || 1
        })
    );
    marketingAutomationState = {
        ...marketingAutomationState,
        forcePromotionRefresh: forcePromotionRefresh && !isPromotionTaskPending(nextTask)
    };
    ensureMarketingAutomationLoop();
    return { success: true };
}

async function runMarketingAutomationLoop() {
    await ensureMarketingAutomationLoaded();
    if (marketingAutomationState.isPaused || !marketingAutomationState.isRunning) return;

    while (marketingAutomationState.isRunning && !marketingAutomationState.isPaused) {
        const tasks = await TaskStore.getTasks();
        const metrics = getMarketingAutomationMetrics(tasks);
        const forcePromotionRefresh = !!marketingAutomationState.forcePromotionRefresh;
        const nextTask = selectNextMarketingTask(tasks, { forcePromotionRefresh });

        if (!nextTask) {
            const nextRefreshLabel = formatMarketingRefreshAt(metrics.nextPromotionRefreshAt);
            await updateMarketingAutomationState(metrics.scheduledPromotionTasks > 0 ? {
                isRunning: false,
                isPaused: true,
                pauseReason: 'scheduled',
                phase: 'scheduled',
                phaseLabel: '等待下一次调研',
                currentTaskId: '',
                currentTaskName: '',
                currentTaskType: '',
                pendingTasks: metrics.pendingTasks,
                dueNurtureTasks: metrics.dueNurtureTasks,
                scheduledPromotionTasks: metrics.scheduledPromotionTasks,
                nextPromotionRefreshAt: metrics.nextPromotionRefreshAt || '',
                lastCompletedAt: new Date().toISOString(),
                lastMessage: nextRefreshLabel
                    ? `当前渠道都已推进完，将在 ${nextRefreshLabel} 自动继续调研。`
                    : '当前渠道都已推进完，等待下一次自动调研。'
            } : {
                isRunning: false,
                isPaused: true,
                pauseReason: 'completed',
                phase: 'completed',
                phaseLabel: '已完成',
                currentTaskId: '',
                currentTaskName: '',
                currentTaskType: '',
                pendingTasks: metrics.pendingTasks,
                dueNurtureTasks: metrics.dueNurtureTasks,
                scheduledPromotionTasks: 0,
                nextPromotionRefreshAt: '',
                lastCompletedAt: new Date().toISOString(),
                lastMessage: '当前没有待推进的营销任务'
            });
            break;
        }

        if (forcePromotionRefresh) {
            marketingAutomationState = {
                ...marketingAutomationState,
                forcePromotionRefresh: false
            };
        }

        const nextTaskType = getTaskType(nextTask);
        const phaseLabel = nextTaskType === 'nurture' ? '执行养号会话' : '推进宣传渠道';
        await updateMarketingAutomationState({
            pauseReason: '',
            currentTaskId: nextTask.id || '',
            currentTaskName: nextTask.name || nextTask.website || nextTask.platformUrl || '',
            currentTaskType: nextTaskType,
            phase: nextTaskType === 'nurture' ? 'nurture' : 'promote',
            phaseLabel,
            pendingTasks: metrics.pendingTasks,
            dueNurtureTasks: metrics.dueNurtureTasks,
            scheduledPromotionTasks: metrics.scheduledPromotionTasks,
            nextPromotionRefreshAt: metrics.nextPromotionRefreshAt || '',
            lastMessage: `正在处理 ${nextTask.name || nextTask.website || nextTask.platformUrl || '营销任务'}`
        });

        const result = await runMarketingTask(nextTask, { active: false, automation: true });
        const nextMetrics = getMarketingAutomationMetrics(await TaskStore.getTasks());
        await updateMarketingAutomationState({
            processedTasks: Number(marketingAutomationState.processedTasks || 0) + 1,
            pendingTasks: nextMetrics.pendingTasks,
            dueNurtureTasks: nextMetrics.dueNurtureTasks,
            scheduledPromotionTasks: nextMetrics.scheduledPromotionTasks,
            nextPromotionRefreshAt: nextMetrics.nextPromotionRefreshAt || '',
            currentTaskId: '',
            currentTaskName: '',
            currentTaskType: '',
            phase: 'running',
            phaseLabel: '等待下一轮',
            lastMessage: result?.message || `${phaseLabel}已完成`
        });

        if (!marketingAutomationState.isRunning || marketingAutomationState.isPaused) {
            break;
        }

        await delay(1200);
    }
}

async function restoreTaskSchedules() {
    const tasks = await TaskStore.getTasks();
    await Promise.all(tasks.map((task) => syncTaskSchedule(task).catch(() => {})));
}

function getWorkflowTaskType(workflowId) {
    return WorkflowRegistry.get(workflowId || WorkflowRegistry.DEFAULT_WORKFLOW_ID)?.taskType || 'publish';
}

async function runPromotionCampaignTask(task = {}, options = {}) {
    const currentTask = await TaskStore.getTask(task.id) || task;
    let promotionPlan = currentTask.promotionPlan || null;
    let researchContext = currentTask.researchContext || null;
    let nurtureGenerated = { createdCount: 0, updatedCount: 0 };
    const now = new Date().toISOString();
    const existingReviewItems = Array.isArray(currentTask?.promotionPlan?.reviewItems)
        ? currentTask.promotionPlan.reviewItems
        : [];
    const refreshDue = !!getPromotionNextResearchAtMs(currentTask) && getPromotionNextResearchAtMs(currentTask) <= Date.now();
    const forceRefresh = !!options.forceRefresh;
    let generatedFresh = false;

    if (!Array.isArray(promotionPlan?.channels) || promotionPlan.channels.length === 0 || refreshDue || forceRefresh) {
        if (!researchContext?.generatedAt || refreshDue || forceRefresh) {
            researchContext = await marketingEngine.collectMarketingResearchContext(currentTask);
        }
        promotionPlan = await AIEngine.generateResearchPlan({
            website: currentTask.website || '',
            targetAudience: currentTask.targetAudience || '',
            preferredChannels: currentTask.preferredChannels || '',
            campaignBrief: currentTask.campaignBrief || '',
            researchContext
        });
        promotionPlan = MarketingPlanner.finalizeMarketingPlan(promotionPlan, currentTask, researchContext);
        promotionPlan = MarketingPlanner.filterPromotionPlanForUnopenedChannels(promotionPlan, existingReviewItems);
        nurtureGenerated = await marketingEngine.createNurtureTasksFromPromotionPlan(currentTask, promotionPlan);
        generatedFresh = true;
    } else {
        promotionPlan = MarketingPlanner.finalizeMarketingPlan(promotionPlan, currentTask, researchContext || {});
    }

    const openableChannels = (promotionPlan.channels || []).filter((channel) =>
        channel?.workflowId !== 'account-nurture' && normalizeHttpUrlBg(channel.url || '')
    );
    const totalOpenableChannels = openableChannels.length;
    const nextChannelIndex = Math.max(0, Math.min(
        Number.isFinite(Number(promotionPlan.nextChannelIndex))
            ? Number(promotionPlan.nextChannelIndex)
            : Number(promotionPlan.progressedChannelCount || 0),
        totalOpenableChannels
    ));
    const primaryChannel = totalOpenableChannels > 0 && nextChannelIndex < totalOpenableChannels
        ? openableChannels[nextChannelIndex]
        : null;
    let openedTabId = null;
    let openedReviewUrl = '';
    const nowReview = new Date().toISOString();

    if (primaryChannel) {
        const tab = await openOrReuseMarketingTab(normalizeHttpUrlBg(primaryChannel.url || ''), {
            active: options.active !== false,
            waitForLoad: true
        });
        openedTabId = tab.id;
        openedReviewUrl = normalizeHttpUrlBg(tab.url || primaryChannel.url || '');
    }

    let savedTask = currentTask;
    if (currentTask?.id) {
        const progressedChannelCount = primaryChannel
            ? Math.min(totalOpenableChannels, nextChannelIndex + 1)
            : Math.min(totalOpenableChannels, Number(promotionPlan.progressedChannelCount || 0));
        const reviewItems = primaryChannel
            ? MarketingPlanner.mergePromotionReviewItems(promotionPlan.reviewItems, {
                name: primaryChannel.name || '',
                url: openedReviewUrl || primaryChannel.url || '',
                workflowId: primaryChannel.workflowId || '',
                openedAt: nowReview
            })
            : (Array.isArray(promotionPlan.reviewItems) ? promotionPlan.reviewItems : []);
        const nextResearchAt = totalOpenableChannels > 0 && progressedChannelCount >= totalOpenableChannels
            ? computeNextPromotionResearchAt(currentTask)
            : '';
        savedTask = await TaskStore.updateTask(currentTask.id, (storedTask) => ({
            ...storedTask,
            lastRunAt: now,
            runCount: Number(storedTask.runCount || 0) + 1,
            researchContext: researchContext || storedTask.researchContext || null,
            promotionPlan: {
                ...promotionPlan,
                reviewItems,
                generatedNurtureTaskCount: generatedFresh
                    ? nurtureGenerated.createdCount
                    : Number(promotionPlan.generatedNurtureTaskCount || 0),
                updatedNurtureTaskCount: generatedFresh
                    ? nurtureGenerated.updatedCount
                    : Number(promotionPlan.updatedNurtureTaskCount || 0),
                totalOpenableChannels,
                nextChannelIndex: primaryChannel ? progressedChannelCount : nextChannelIndex,
                progressedChannelCount,
                lastOpenedChannelIndex: primaryChannel ? nextChannelIndex : Number(promotionPlan.lastOpenedChannelIndex || -1),
                openedChannelName: primaryChannel?.name || '',
                openedChannelUrl: openedReviewUrl || primaryChannel?.url || '',
                generatedAt: promotionPlan.generatedAt || now,
                lastOpenedAt: primaryChannel ? now : (promotionPlan.lastOpenedAt || ''),
                nextResearchAt,
                status: primaryChannel
                    ? (progressedChannelCount >= totalOpenableChannels ? 'completed' : 'in_progress')
                    : (nextResearchAt ? 'awaiting_refresh' : (promotionPlan.status || 'planned'))
            }
        }));
        if (savedTask) {
            await syncTaskSchedule(savedTask);
        }
    }

    await Logger.ai(`产品宣传计划已生成: ${task.name || task.website}`, {
        taskId: task.id || '',
        channels: promotionPlan.channels?.length || 0,
        browserSuggestedChannels: promotionPlan.browserSuggestedCount || 0,
        nextSteps: promotionPlan.nextSteps?.length || 0,
        nurtureCreated: nurtureGenerated.createdCount,
        nurtureUpdated: nurtureGenerated.updatedCount,
        searchQueries: researchContext?.queries?.length || 0,
        pageReads: researchContext?.pageReads?.length || 0,
        openedChannel: openedReviewUrl || primaryChannel?.url || ''
    });

    if (!primaryChannel) {
        const nextResearchAt = savedTask?.promotionPlan?.nextResearchAt || '';
        const nextRefreshLabel = formatMarketingRefreshAt(nextResearchAt);
        return {
            success: true,
            message: totalOpenableChannels > 0
                ? (nextRefreshLabel
                    ? `宣传渠道已全部推进完，将在 ${nextRefreshLabel} 自动重新调研。`
                    : `宣传渠道已全部推进完，等待下一次自动调研。`)
                : '已生成宣传计划，但当前没有可直接打开的宣传渠道。',
            promotionPlan: savedTask?.promotionPlan || promotionPlan,
            tabId: null
        };
    }

    const openedMessage = `，并已打开第 ${nextChannelIndex + 1}/${totalOpenableChannels} 个执行入口：${primaryChannel.name || primaryChannel.url}`;

    return {
        success: true,
        message: `${generatedFresh ? `已生成宣传计划，发现 ${promotionPlan.channels?.length || 0} 个渠道，生成 ${nurtureGenerated.createdCount} 个养号任务${nurtureGenerated.updatedCount ? `，更新 ${nurtureGenerated.updatedCount} 个旧养号任务` : ''}` : '已继续产品宣传流程'}${openedMessage}。`,
        promotionPlan: savedTask?.promotionPlan || promotionPlan,
        tabId: openedTabId
    };
}

async function runResearchTask(task = {}) {
    const researchContext = await marketingEngine.collectMarketingResearchContext(task);
    let researchResult = await AIEngine.generateResearchPlan({
        website: task.website || '',
        targetAudience: task.targetAudience || '',
        preferredChannels: task.preferredChannels || '',
        campaignBrief: task.campaignBrief || '',
        researchContext
    });
    researchResult = MarketingPlanner.finalizeMarketingPlan(researchResult, task, researchContext);

    const generated = await marketingEngine.createTasksFromResearchPlan(task, researchResult);
    const now = new Date().toISOString();

    const savedTask = task?.id
        ? await TaskStore.updateTask(task.id, (storedTask) => ({
            ...storedTask,
            lastRunAt: now,
            runCount: Number(storedTask.runCount || 0) + 1,
            researchContext,
            researchResult: {
                ...researchResult,
                generatedTaskCount: generated.createdCount,
                updatedTaskCount: generated.updatedCount,
                generatedAt: now
            }
        }))
        : null;

    await Logger.ai(`营销调研计划已生成: ${task.name || task.website}`, {
        taskId: task.id || '',
        channels: researchResult.channels?.length || 0,
        browserSuggestedChannels: researchResult.browserSuggestedCount || 0,
        nextSteps: researchResult.nextSteps?.length || 0,
        searchQueries: researchContext?.queries?.length || 0,
        pageReads: researchContext?.pageReads?.length || 0,
        createdTasks: generated.createdCount,
        updatedTasks: generated.updatedCount
    });

    return {
        success: true,
        message: `已生成营销计划，发现 ${researchResult.channels?.length || 0} 个渠道，并生成 ${generated.createdCount} 个新任务${generated.updatedCount ? `，更新 ${generated.updatedCount} 个旧任务` : ''}。`,
        researchResult: savedTask?.researchResult || researchResult
    };
}

async function runNurtureSession(task = {}, options = {}) {
    const platformUrl = normalizeHttpUrlBg(task.platformUrl || task.website || '');
    if (!platformUrl) {
        throw new Error('当前养号任务没有配置平台 URL');
    }

    const tab = await openOrReuseMarketingTab(platformUrl, { active: !!options.active, waitForLoad: true });

    await delay(1500);

    const executeBrowsePass = async (tabId) => {
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                func: async (payload) => {
                    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                    const collectLinks = () => Array.from(document.querySelectorAll('a[href]'))
                        .map((anchor) => ({
                            href: anchor.href || anchor.getAttribute('href') || '',
                            text: String(anchor.textContent || '').replace(/\s+/g, ' ').trim()
                        }))
                        .filter((item) =>
                            item.href
                            && !item.href.startsWith('javascript:')
                            && !item.href.startsWith('mailto:')
                            && item.text.length > 8
                        );

                    const height = Math.max(
                        document.body?.scrollHeight || 0,
                        document.documentElement?.scrollHeight || 0,
                        window.innerHeight
                    );

                    for (let index = 1; index <= 3; index++) {
                        const top = Math.min(height, Math.floor(height * (index / 3)));
                        window.scrollTo({ top, behavior: 'auto' });
                        await sleep(900);
                    }

                    const links = collectLinks();
                    const internalLink = links.find((item) => {
                        try {
                            const url = new URL(item.href);
                            return url.origin === window.location.origin && url.pathname !== window.location.pathname;
                        } catch {
                            return false;
                        }
                    });

                    return {
                        title: document.title || '',
                        url: window.location.href || '',
                        internalLink: internalLink?.href || '',
                        internalLinkText: internalLink?.text || '',
                        visibleLinkCount: links.length,
                        sessionGoal: payload.sessionGoal || ''
                    };
                },
                args: [{
                    sessionGoal: task.sessionGoal || ''
                }]
            });
            return results?.[0]?.result || null;
    };

    const firstPass = await executeBrowsePass(tab.id);
    let secondPass = null;

    if (firstPass?.internalLink && firstPass.internalLink !== platformUrl) {
        await chrome.tabs.update(tab.id, { url: firstPass.internalLink, active: !!options.active });
        await waitForTabLoad(tab.id);
        await delay(1200);
        secondPass = await executeBrowsePass(tab.id);
    }

    return {
        platformUrl: normalizeHttpUrlBg(secondPass?.url || firstPass?.url || platformUrl),
        visitedPages: secondPass ? 2 : 1,
        firstPass,
        secondPass
    };
}

async function executeNurtureTask(taskId, options = {}) {
    const task = await TaskStore.getTask(taskId);
    if (!task) return;

    const session = await runNurtureSession(task, options);
    const now = new Date().toISOString();
    const updatedTask = await TaskStore.updateTask(taskId, (storedTask) => ({
        ...storedTask,
        lastRunAt: now,
        runCount: Number(storedTask.runCount || 0) + 1,
        nextRunAt: computeNextNurtureRunAt(storedTask.frequency || 'daily'),
        lastSession: {
            platformUrl: session.platformUrl,
            visitedPages: session.visitedPages,
            firstTitle: session.firstPass?.title || '',
            secondTitle: session.secondPass?.title || '',
            internalLink: session.firstPass?.internalLink || '',
            completedAt: now
        }
    }));
    if (updatedTask) {
        await syncTaskSchedule(updatedTask);
    }

    await Logger.publish(`养号任务已执行: ${updatedTask?.name || task.name || task.platformUrl || task.website}`, {
        taskId,
        platformUrl: updatedTask?.platformUrl || task.platformUrl || '',
        frequency: updatedTask?.frequency || task.frequency || 'daily',
        visitedPages: session.visitedPages
    });

    return {
        success: true,
        session
    };
}

async function handleNurtureAlarm(taskId) {
    try {
        await executeNurtureTask(taskId, { active: false });
    } catch (error) {
        await Logger.error(`养号任务执行失败: ${error.message}`, { taskId });
    }
}

async function handleMarketingRefreshAlarm(taskId) {
    try {
        await ensureMarketingAutomationLoaded();
        if (marketingAutomationState.isPaused && marketingAutomationState.pauseReason === 'manual') {
            await Logger.publish('营销刷新已到期，但当前持续宣传处于手动暂停状态', { taskId });
            return;
        }
        await Logger.publish('营销刷新已到期，自动继续持续宣传', { taskId });
        await startMarketingAutomation({ forcePromotionRefresh: false });
    } catch (error) {
        await Logger.error(`营销刷新任务执行失败: ${error.message}`, { taskId });
    }
}

async function runMarketingTask(task = {}, options = {}) {
    try {
        const taskType = getTaskType(task);
        const targetUrl = task.platformUrl || task.website || '';

        if (task.workflowId === 'product-promote-campaign') {
            return await runPromotionCampaignTask(task, options);
        }

        if (taskType === 'research') {
            return await runResearchTask(task);
        }

        if (!targetUrl) {
            return {
                success: false,
                message: '当前任务还没有配置可打开的平台 URL'
            };
        }

        const url = normalizeHttpUrlBg(targetUrl);

        if (taskType === 'nurture') {
            const result = await executeNurtureTask(task.id, { active: options.active !== false });
            return {
                success: true,
                message: `已完成一次养号会话，浏览 ${result.session?.visitedPages || 1} 个页面。`,
                session: result.session
            };
        }

        const tab = await openOrReuseMarketingTab(url, { active: options.active !== false, waitForLoad: true });
        await Logger.publish(`已打开营销任务入口: ${task.name || url}`, {
            taskId: task.id || '',
            taskType,
            targetUrl: url
        });

        return {
            success: true,
            message: '已打开发帖/提交通道，下一步会补自动化执行器。',
            tabId: tab.id
        };
    } catch (error) {
        await Logger.error(`营销任务执行失败: ${error.message}`, {
            taskId: task.id || '',
            workflowId: task.workflowId || '',
            taskType: getTaskType(task)
        });
        return {
            success: false,
            message: error.message || '营销任务执行失败'
        };
    }
}

async function inspectMarketingReview(taskId = '', url = '') {
    const finalUrl = normalizeHttpUrlBg(url || '');
    if (!taskId || !finalUrl) {
        return { success: false, message: '缺少待检查页面地址' };
    }

    const updatedTask = await TaskStore.updateTask(taskId, (storedTask) => {
        const promotionPlan = storedTask.promotionPlan || {};
        const reviewItems = Array.isArray(promotionPlan.reviewItems) ? promotionPlan.reviewItems : [];
        const checkedAt = new Date().toISOString();
        return {
            ...storedTask,
            promotionPlan: {
                ...promotionPlan,
                reviewItems: reviewItems.map((item) =>
                    normalizeHttpUrlBg(item?.url || '') === finalUrl
                        ? { ...item, checkedAt }
                        : item
                )
            }
        };
    });
    if (!updatedTask) {
        return { success: false, message: '找不到对应营销任务' };
    }

    const tab = await openOrReuseMarketingTab(finalUrl, { active: true, waitForLoad: true });
    return {
        success: true,
        url: finalUrl,
        tabId: tab.id
    };
}
