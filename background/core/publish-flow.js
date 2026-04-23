/** Publish flow - extracted from background.js */

/**
 * Daily period boundary: Beijing time 17:00 = UTC 09:00.
 * Returns the UTC timestamp (ms) of the most recent period start.
 */
function getDailyPeriodStart(now) {
    const d = now || new Date();
    const boundary = new Date(Date.UTC(
        d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 9, 0, 0, 0
    ));
    if (d.getTime() < boundary.getTime()) {
        boundary.setUTCDate(boundary.getUTCDate() - 1);
    }
    return boundary.getTime();
}

/**
 * Read the current-day publish count for a task's active limit metric.
 * Returns 0 if the stored period doesn't match today's period.
 */
function getTaskDailyLimitCount(task) {
    const periodStart = getDailyPeriodStart();
    const isCurrentPeriod = Number(task?.dailyPeriodStart || 0) === periodStart;
    if (!isCurrentPeriod) return 0;
    // 锚文本相关模式（严格或优先）都按 anchor success 计数
    const isAnchorLimit = task?.commentStyle === 'anchor-html' || task?.commentStyle === 'anchor-prefer';
    return isAnchorLimit
        ? Number(task?.dailyAnchorSuccessCount || 0)
        : Number(task?.dailyPublishedCount || 0);
}

/**
 * Increment daily publish counts on the task and persist.
 * Returns the updated daily limit-relevant count.
 */
async function incrementTaskDailyPublishCount(taskId, { published = false, anchorSuccess = false } = {}) {
    const periodStart = getDailyPeriodStart();
    const result = await TaskStore.updateTask(taskId, (task) => {
        const isCurrentPeriod = Number(task.dailyPeriodStart || 0) === periodStart;
        const prevPublished = isCurrentPeriod ? Number(task.dailyPublishedCount || 0) : 0;
        const prevAnchor = isCurrentPeriod ? Number(task.dailyAnchorSuccessCount || 0) : 0;
        return {
            ...task,
            dailyPeriodStart: periodStart,
            dailyPublishedCount: prevPublished + (published ? 1 : 0),
            dailyAnchorSuccessCount: prevAnchor + (anchorSuccess ? 1 : 0)
        };
    });
    // 锚文本相关模式（严格或优先）都返回 anchor success 数
    const isAnchorLimit = result?.commentStyle === 'anchor-html' || result?.commentStyle === 'anchor-prefer';
    return isAnchorLimit
        ? Number(result?.dailyAnchorSuccessCount || 0)
        : Number(result?.dailyPublishedCount || 0);
}

async function savePublishTask(task) {
    task.workflowId = task.workflowId || WorkflowRegistry.DEFAULT_WORKFLOW_ID;
    task.taskType = getTaskType(task);
    task.commentStyle = task.commentStyle || 'standard';
    task.commentStyleVersion = PUBLISH_TASK_SCHEMA_VERSION;
    task.maxPublishes = Number(task.maxPublishes) > 0 ? Number(task.maxPublishes) : 0;

    const savedTask = await TaskStore.updateTasks((tasks) => {
        let nextTask = { ...task };

        if (nextTask.id) {
            const idx = tasks.findIndex((item) => item.id === nextTask.id);
            if (idx !== -1) {
                const existingTask = tasks[idx];
                const mergedTask = { ...existingTask, ...nextTask };

                if (getTaskType(mergedTask) === 'nurture') {
                    const frequencyChanged = existingTask.frequency !== mergedTask.frequency;
                    if (!mergedTask.nextRunAt || frequencyChanged) {
                        mergedTask.nextRunAt = computeNextNurtureRunAt(mergedTask.frequency || 'daily');
                    }
                }

                if (mergedTask.workflowId === 'product-promote-campaign') {
                    const campaignInputsChanged =
                        existingTask.website !== mergedTask.website
                        || existingTask.targetAudience !== mergedTask.targetAudience
                        || existingTask.preferredChannels !== mergedTask.preferredChannels
                        || existingTask.campaignBrief !== mergedTask.campaignBrief;
                    if (campaignInputsChanged) {
                        delete mergedTask.promotionPlan;
                        delete mergedTask.researchContext;
                    }
                }

                tasks[idx] = mergedTask;
                nextTask = mergedTask;
            }
        } else {
            nextTask.id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
            nextTask.createdAt = new Date().toISOString();
            nextTask.stats = { total: 0, success: 0, skipped: 0, pending: 0, failed: 0 };
            nextTask.runCount = Number(nextTask.runCount || 0);
            nextTask.lastRunAt = nextTask.lastRunAt || '';
            nextTask.autoDispatchPaused = !!nextTask.autoDispatchPaused;
            if (getTaskType(nextTask) === 'nurture') {
                nextTask.nextRunAt = computeNextNurtureRunAt(nextTask.frequency || 'daily');
            }
            tasks.push(nextTask);
        }

        return { tasks, value: nextTask };
    });

    await syncTaskSchedule(savedTask);
    await Logger.publish(`保存任务: ${savedTask.name || savedTask.website}`);
    if (autoPublishDispatch.isAutoPublishTask(savedTask)) {
        autoPublishDispatch.schedule('task-saved', 600);
    }
}

async function setTaskAutoDispatchPaused(taskId, paused = true, reason = 'manual') {
    if (!taskId) return null;
    return await TaskStore.updateTask(taskId, (task) => {
        const nextTask = {
            ...task,
            autoDispatchPaused: !!paused
        };

        if (paused) {
            nextTask.autoDispatchPausedAt = new Date().toISOString();
            nextTask.autoDispatchPauseReason = compactText(reason || 'manual');
        } else {
            delete nextTask.autoDispatchPausedAt;
            delete nextTask.autoDispatchPauseReason;
        }

        return nextTask;
    });
}

async function deletePublishTask(taskId) {
    await ensureAutoPublishControlLoaded();
    await TaskStore.removeTask(taskId);
    if ((getAutoPublishControlState().manualFocusTaskId || '') === taskId) {
        await setManualPublishFocusTask('', 'task-deleted');
    }
    try { await chrome.alarms.clear(getNurtureAlarmName(taskId)); } catch {}
    try { await chrome.alarms.clear(getPromotionRefreshAlarmName(taskId)); } catch {}
}

function getPublishWorkflow(task) {
    return WorkflowRegistry.get(task?.workflowId || WorkflowRegistry.DEFAULT_WORKFLOW_ID);
}

function getTaskPublishTarget(task = {}) {
    const siteUrl = (task.website || task.anchorUrl || '').trim();
    const fallbackUrl = (task.anchorUrl || task.website || '').trim();
    const normalized = normalizeUrlBg(siteUrl || fallbackUrl);
    return {
        key: normalized,
        url: siteUrl || fallbackUrl,
        domain: getDomainBg(siteUrl || fallbackUrl),
        taskId: task.id || '',
        taskName: task.name || task.website || ''
    };
}

function isPublishCandidateForTask(resource, task = {}) {
    return !!self.ResourceRules?.isPublishCandidateForTask?.(resource, task);
}

function getResourcePublishHistoryEntry(resource, taskOrTarget) {
    const targetKey = typeof taskOrTarget === 'string' ? taskOrTarget : taskOrTarget?.key;
    if (!targetKey) return null;
    return resource?.publishHistory?.[targetKey] || null;
}

function canPublishResourceForTask(resource, task) {
    if (!isPublishCandidateForTask(resource, task)) {
        return false;
    }
    if (getResourcePool(resource) === RESOURCE_POOLS.QUARANTINE) {
        return false;
    }
    // 资源级硬下架状态：永远跳过
    if (resource?.status === 'unpublishable') {
        return false;
    }

    const historyEntry = getResourcePublishHistoryEntry(resource, getTaskPublishTarget(task));
    if (!historyEntry) return true;
    if (historyEntry.lastStatus === 'pending' && historyEntry?.publishMeta?.reviewPending) {
        return false;
    }
    if (historyEntry.lastStatus === 'failed') {
        const failureRecovery = getPublishFailureRecoveryPolicy(historyEntry?.publishMeta || {}, historyEntry);
        return !!failureRecovery.retryable;
    }

    return !['published', 'skipped', 'failed', 'unpublishable'].includes(historyEntry.lastStatus);
}

function isRateLimitReason(reason = '') {
    return String(reason || '').toLowerCase() === 'comment_rate_limited';
}

// 硬原因：资源永远不可发，踢出队列。区别于软原因（临时问题，允许重试）
const HARD_UNPUBLISHABLE_REASONS = new Set([
    'comments-closed',
    'login-required',
    'captcha-blocked'
]);

// 软原因：临时问题，给 1-2 次重试机会后进入冷却，不永久下架
const SOFT_RETRYABLE_REASONS = new Set([
    'publish-runtime-timeout',
    'submit-confirm-timeout',
    'comment-form-not-found', // D+E 三级兜底都失败后上报，可能是页面慢加载
    'network-error',
    'tab-closed',
    'dispatch-message-failed'
]);

function getPublishFailureRecoveryPolicy(publishMeta = {}, historyEntry = null) {
    const reason = compactText(publishMeta?.submissionBlockReason || '').toLowerCase();
    const failedAttempts = Number(historyEntry?.attempts?.failed || 0);
    const maxAttempts = Number(PUBLISH_STRATEGY.RETRYABLE_FAILURE_MAX_ATTEMPTS || 0) || 3;

    // 显式硬标记：content script 直接告诉后台"这个资源永远不可发"
    if (publishMeta?.unpublishable === true) {
        return {
            retryable: false,
            terminalStatus: 'unpublishable',
            reason: reason || 'unpublishable',
            cooldownMs: 0,
            failedAttempts,
            maxAttempts
        };
    }

    if (publishMeta?.websiteRetryExhausted) {
        return {
            retryable: false,
            terminalStatus: 'skipped',
            reason: 'website-field-blocked-exhausted',
            cooldownMs: 0,
            failedAttempts,
            maxAttempts
        };
    }

    if (reason === 'duplicate_comment') {
        return {
            retryable: false,
            terminalStatus: 'skipped',
            reason,
            cooldownMs: 0,
            failedAttempts,
            maxAttempts
        };
    }

    // comment_submission_blocked 以前被归为 terminal skipped，一次就永久下架。
    // 但这个信号本身是 anchor-verifier 在 wp-comments-post.php 上 12.5s 内没找到 anchor
    // 就判定的（见 anchor-verifier.js 的 submissionBlockedPatterns 最后一条兜底），
    // 真实原因常常是：页面渲染慢、anchor 匹配被 rel/URL 误差漏掉、SPA 评论异步加载。
    // 改成有限次重试的软失败（最多 2 次），6h 冷却后再试一次。
    if (reason === 'comment_submission_blocked') {
        const softMaxAttempts = 2;
        return {
            retryable: failedAttempts < softMaxAttempts,
            terminalStatus: 'failed',
            reason,
            cooldownMs: 6 * 60 * 60 * 1000,
            failedAttempts,
            maxAttempts: softMaxAttempts
        };
    }

    // 硬原因：永久不可发，踢出队列
    if (HARD_UNPUBLISHABLE_REASONS.has(reason)) {
        return {
            retryable: false,
            terminalStatus: 'unpublishable',
            reason,
            cooldownMs: 0,
            failedAttempts,
            maxAttempts
        };
    }

    // 软原因：允许有限次重试，超过阈值后冷却但不永久下架
    if (SOFT_RETRYABLE_REASONS.has(reason)) {
        const softMaxAttempts = 2;
        return {
            retryable: failedAttempts < softMaxAttempts,
            terminalStatus: 'failed',
            reason,
            cooldownMs: 6 * 60 * 60 * 1000, // 6 小时冷却后可再试
            failedAttempts,
            maxAttempts: softMaxAttempts
        };
    }

    if (!reason || reason === 'unknown') {
        return {
            retryable: failedAttempts < maxAttempts,
            terminalStatus: 'failed',
            reason: reason || 'unknown',
            cooldownMs: Number(PUBLISH_STRATEGY.UNKNOWN_FAILURE_COOLDOWN_MS || 0) || 0,
            failedAttempts,
            maxAttempts
        };
    }

    return {
        retryable: false,
        terminalStatus: 'failed',
        reason: reason || 'unknown',
        cooldownMs: 0,
        failedAttempts,
        maxAttempts
    };
}

function interleaveResourcesByDomain(resources = []) {
    const grouped = new Map();

    for (const resource of resources) {
        const domain = getDomainBg(resource?.url || '') || '__unknown__';
        if (!grouped.has(domain)) grouped.set(domain, []);
        grouped.get(domain).push(resource);
    }

    const queue = Array.from(grouped.values());
    const interleaved = [];

    while (queue.length > 0) {
        for (let i = 0; i < queue.length; i++) {
            const group = queue[i];
            const resource = group.shift();
            if (resource) interleaved.push(resource);
            if (group.length === 0) {
                queue.splice(i, 1);
                i--;
            }
        }
    }

    return interleaved;
}

function mergePublishHistoryEntry(existingEntry, target, status, publishMeta = {}) {
    const now = publishMeta.updatedAt || new Date().toISOString();
    const attempts = existingEntry?.attempts || {};

    return {
        ...(existingEntry || {}),
        targetKey: target.key,
        targetUrl: target.url,
        targetDomain: target.domain,
        taskId: target.taskId,
        taskName: target.taskName,
        lastStatus: status,
        lastAttemptAt: now,
        lastPublishedAt: status === 'published' ? now : (existingEntry?.lastPublishedAt || ''),
        attempts: {
            published: (attempts.published || 0) + (status === 'published' ? 1 : 0),
            skipped: (attempts.skipped || 0) + (status === 'skipped' ? 1 : 0),
            failed: (attempts.failed || 0) + (status === 'failed' ? 1 : 0)
        },
        publishMeta: publishMeta
            ? { ...(existingEntry?.publishMeta || {}), ...publishMeta }
            : (existingEntry?.publishMeta || {})
    };
}

async function updateTaskPublishStats(taskId, resourceId, status, currentTask = {}, publishMeta = {}) {
    if (!taskId) return;
    await TaskStore.updateTask(taskId, (task) => {
        const stats = task.stats || { total: 0, success: 0, skipped: 0, pending: 0, failed: 0 };
        const statsStatus = String(publishMeta?.statsStatus || status || '').trim() || String(status || '').trim();
        const nextStats = {
            total: Number(stats.total || 0),
            success: Number(stats.success || 0),
            skipped: Number(stats.skipped || 0),
            pending: Number(stats.pending || 0),
            failed: Number(stats.failed || 0)
        };

        if (statsStatus !== 'pending') {
            nextStats.total++;
            if (statsStatus === 'published') nextStats.success++;
            else if (statsStatus === 'skipped') nextStats.skipped++;
            else if (statsStatus === 'failed') nextStats.failed++;
        }

        return {
            ...task,
            stats: nextStats
        };
    });
}

async function syncPublishLog(resourceId, status, currentTask = {}) {
    try {
        const settings = await getSettings();
        if (!settings.googleSheetId) return;

        const resources = await getStoredResources();
        const resource = resources.find((item) => item.id === resourceId);
        if (!resource) return;

        await GoogleSheets.syncPublishLog(settings.googleSheetId, {
            timestamp: new Date().toISOString(),
            url: resource.url,
            status,
            taskName: currentTask?.name || ''
        });
    } catch {}
}

function getPublishRuntimeContext(taskId) {
    return {
        defaultWorkflowId: WorkflowRegistry.DEFAULT_WORKFLOW_ID,
        publishStrategy: PUBLISH_STRATEGY,
        logger: Logger,
        buildWorkflowTask: (task) => PublishWorkflowTask.buildTask(task),
        getState: () => getPublishSessionState(taskId),
        setState: (nextState) => {
            setPublishSessionState(taskId, nextState);
        },
        updateState: (patch = {}) => {
            updatePublishSessionState(taskId, patch);
        },
        getResources: async () => await getStoredResources(),
        getResourcesAndTasks: async () => {
            return {
                resources: await getStoredResources(),
                publishTasks: await TaskStore.getTasks()
            };
        },
        getSiteTemplates: async () => await self.PublishMemory?.getSiteTemplates?.() || {},
        getSettings,
        getPublishWorkflow,
        workflowSupportsResource: (workflow, resource, task) => WorkflowRegistry.supportsResource(workflow, resource, task),
        canPublishResourceForTask,
        getResourcePool,
        selectDispatchResources,
        getAllDomainPublishPolicies,
        isResourceCoolingDown,
        interleaveResourcesByDomain,
        getPublishCandidatePriority: (resource, task) => self.ResourceRules?.getPublishCandidatePriority?.(resource, task) || 0,
        getResourcePublishRankingScore: (resource, task, siteTemplates = {}) => getResourcePublishRankingScore(resource, task, siteTemplates),
        getTaskPublishTarget,
        getTaskDailyLimitCount: (task) => getTaskDailyLimitCount(task),
        incrementDailyPublishCount: async (tId, delta) => await incrementTaskDailyPublishCount(tId, delta),
        getDailyPeriodStart: () => getDailyPeriodStart(),
        rebalanceDispatchQueue: () => rebalanceDispatchQueue(taskId),
        acquirePublishLease: (resource, options = {}) => acquirePublishLease(taskId, resource, options),
        releasePublishLease: (options = {}) => releasePublishLease(taskId, options),
        scheduleDispatchRetry: (delayMs = 1500, reason = 'lease-blocked') => schedulePublishRetry(taskId, delayMs, reason),
        clearDispatchRetry: () => clearPublishRetry(taskId),
        shouldPreferCommentViewport,
        openOrReusePublishTab: (url, options = {}) => openOrReusePublishTab(taskId, url, options),
        sendPublishToTab,
        delay,
        updateResourceStatus,
        verifyPublishedAnchor,
        recordDomainPublishEvidence,
        rememberPublishOutcome: async (resource, task, status, publishMeta) => {
            if (!self.PublishMemory?.rememberPublishOutcome) return null;
            return await self.PublishMemory.rememberPublishOutcome({ resource, task, status, publishMeta });
        },
        getLatestNetworkSignal: (options = {}) => getLatestNetworkSignal(options),
        setDomainPublishPolicy,
        isRateLimitReason,
        getFailureRecoveryPolicy: (publishMeta = {}, historyEntry = null) => (
            getPublishFailureRecoveryPolicy(publishMeta, historyEntry)
        ),
        focusPublishTab: () => focusPublishTab(taskId),
        shouldFocusPublishTab,
        moveCurrentResourceToQueueTail: () => moveCurrentResourceToQueueTail(taskId),
        resetResourcePublishState,
        updateTaskStats: updateTaskPublishStats,
        syncPublishLog,
        sendStopMessage: async (tabId) => {
            await chrome.tabs.sendMessage(tabId, {
                action: 'stopPublishSession',
                sessionId: getPublishSessionState(taskId).sessionId || ''
            });
        },
        broadcastDone: () => {
            broadcastToPopup({ action: 'publishDone', taskId });
            schedulePublishBatchAdvance('publish-done', 700);
            autoPublishDispatch.schedule('publish-done', 900);
        },
        broadcastProgress: (payload = {}) => {
            broadcastToPopup({
                action: 'publishProgress',
                taskId,
                ...payload
            });
        }
    };
}

async function startPublish(task, options = {}) {
    await ensurePublishSessionsLoaded();
    await ensurePublishBatchStateLoaded();
    await ensureAutoPublishControlLoaded();
    let runtimeTask = task?.id
        ? await TaskStore.getTask(task.id) || task
        : task;
    if (options.autoDispatch && runtimeTask?.autoDispatchPaused) {
        return {
            success: false,
            code: 'task_auto_dispatch_paused',
            message: '该任务已手动暂停自动接力，请手动点击发布后再恢复。'
        };
    }
    if (!options.autoDispatch && runtimeTask?.id && runtimeTask.autoDispatchPaused) {
        await setTaskAutoDispatchPaused(runtimeTask.id, false);
        runtimeTask = {
            ...runtimeTask,
            autoDispatchPaused: false
        };
    }
    const startResult = await PublishRuntime.start(getPublishRuntimeContext(runtimeTask.id), runtimeTask, options);
    if (startResult?.success && runtimeTask?.id) {
        if (!options.autoDispatch && !options.fromBatch) {
            await setManualPublishFocusTask(runtimeTask.id, 'manual-start');
        } else if (options.autoDispatch || options.fromBatch) {
            await setManualPublishFocusTask('', options.autoDispatch ? 'auto-dispatch' : 'batch-start');
        }
    }
    return startResult;
}

async function publishNext(taskId) {
    await ensurePublishSessionsLoaded();
    return await PublishRuntime.dispatchQueue(getPublishRuntimeContext(taskId));
}

async function handleCommentAction(resourceId, result, taskId, meta = {}, sessionId = '') {
    await ensurePublishSessionsLoaded();
    await ensurePublishBatchStateLoaded();
    const runtimeTaskId = taskId || findPublishSessionTaskIdByResource(resourceId);
    if (!runtimeTaskId) return;
    if (!isPublishSessionMatch(runtimeTaskId, sessionId || '')) return;
    clearPublishWatchdog(runtimeTaskId);
    clearPublishRetry(runtimeTaskId);
    const actionResult = await PublishRuntime.handleAction(
        getPublishRuntimeContext(runtimeTaskId),
        resourceId,
        result,
        runtimeTaskId,
        meta
    );

    // 实时同步：每次发布结果返回后立即广播资源统计更新
    try {
        const updatedResources = await getStoredResources();
        syncResourceOpportunityStats(updatedResources);
        broadcastStats();
        broadcastToPopup({ action: 'resourceStatsUpdate', taskId: runtimeTaskId });
    } catch {}

    const session = getPublishSessionState(runtimeTaskId);
    if (!isPublishSessionActive(session)) {
        schedulePublishBatchAdvance('publish-session-idle', 500);
        autoPublishDispatch.schedule('publish-session-idle', 700);
    }
    return actionResult;
}

async function updateResourceStatus(id, status, patch = {}) {
    const resources = await getStoredResources();
    const idx = resources.findIndex(r => r.id === id);
    if (idx !== -1) {
        const current = resources[idx];
        const next = {
            ...current,
            status
        };

        if (status === 'published') {
            next.publishedAt = new Date().toISOString();
        } else {
            delete next.publishedAt;
        }

        if (patch && typeof patch === 'object') {
            const {
                publishMeta,
                publishHistoryEntry,
                ...restPatch
            } = patch;

            Object.assign(next, restPatch);

            if (publishMeta) {
                next.publishMeta = { ...(current.publishMeta || {}), ...publishMeta };
                if (next.publishMeta.terminalFailureReason === 'comment_only_form' || next.publishMeta.linkMode === 'comment-only') {
                    next.publishMeta.commentOnlyDetected = true;
                    next.details = Array.from(new Set([...(next.details || []), 'comment-only']));
                }
            }

            if (publishHistoryEntry?.target?.key) {
                const key = publishHistoryEntry.target.key;
                next.publishHistory = {
                    ...(current.publishHistory || {}),
                    [key]: mergePublishHistoryEntry(
                        current.publishHistory?.[key] || null,
                        publishHistoryEntry.target,
                        status,
                        publishMeta || {}
                    )
                };
            }
        }

        const nextSourceTiers = mergeSourceTierArrays(next.sourceTiers || [], [
            next.discoverySourceTier || '',
            status === 'published' ? SOURCE_TIERS.HISTORICAL_SUCCESS : ''
        ]);
        const nextDiscoveryEdges = mergeDiscoveryEdges(next.discoveryEdges || [], status === 'published'
            ? [buildDiscoveryEdge(SOURCE_TIERS.HISTORICAL_SUCCESS, 'publish-success', next.url || '')]
            : []);
        next.sourceTiers = nextSourceTiers;
        next.discoveryEdges = nextDiscoveryEdges;
        resources[idx] = finalizeResourceSignals(next);
        const storedResources = await writeResourcesToStorage(resources);
        syncResourceOpportunityStats(storedResources);
        broadcastStats();
        autoPublishDispatch.schedule(`resource-status:${status}`, 900);
    }
}

async function resetResourcePublishState(resourceId, options = {}) {
    const { preserveHistory = false } = options;
    const resources = await getStoredResources();
    const idx = resources.findIndex(r => r.id === resourceId);
    if (idx === -1) return false;

    const nextResource = { ...resources[idx], status: 'pending' };
    delete nextResource.publishedAt;
    delete nextResource.publishMeta;
    if (!preserveHistory) {
        delete nextResource.publishHistory;
    }
    resources[idx] = finalizeResourceSignals(nextResource);
    const storedResources = await writeResourcesToStorage(resources);
    syncResourceOpportunityStats(storedResources);
    broadcastStats();
    return true;
}

async function resetAllPublishStatuses() {
    await ensurePublishSessionsLoaded();
    await ensurePublishBatchStateLoaded();
    const hasActivePublish = Object.values(publishSessions || {}).some((session) => session.isPublishing || session.awaitingManualContinue);
    if (hasActivePublish || isPublishBatchRunning()) {
        return { success: false, error: '请先停止当前发布任务，再执行重置。' };
    }

    const resources = await getStoredResources();
    let resetCount = 0;
    let clearedHistoryCount = 0;
    const nextResources = resources.map((resource) => {
        const historyCount = Object.keys(resource.publishHistory || {}).length;
        const needsReset =
            resource.status !== 'pending'
            || !!resource.publishedAt
            || !!resource.publishMeta
            || historyCount > 0;

        if (!needsReset) {
            return resource;
        }

        resetCount++;
        clearedHistoryCount += historyCount;
        const nextResource = { ...resource, status: 'pending' };
        delete nextResource.publishedAt;
        delete nextResource.publishMeta;
        delete nextResource.publishHistory;
        return finalizeResourceSignals(nextResource);
    });

    const storedResources = await writeResourcesToStorage(nextResources);
    syncResourceOpportunityStats(storedResources);
    broadcastStats();
    await TaskStore.updateTasks((tasks) => tasks.map((task) => {
        if (getTaskType(task) !== 'publish') {
            return task;
        }

        return {
            ...task,
            stats: {
                total: 0,
                success: 0,
                skipped: 0,
                pending: 0,
                failed: 0
            }
        };
    }));

    publishSessions = createDefaultPublishSessions();
    publishSessionsLoaded = true;
    await flushPublishSessions();
    await publishBatchRuntime.reset({ loaded: true });

    await Logger.publish(`已将发布资源重置为待发布，并清空历史尝试记录`, {
        resetCount,
        clearedHistoryCount
    });

    return { success: true, count: resetCount, clearedHistoryCount };
}

async function stopPublish(taskId, options = {}) {
    await ensurePublishSessionsLoaded();
    await ensurePublishBatchStateLoaded();
    const shouldStopBatch = !options.skipBatchStop
        && isPublishBatchRunning()
        && !taskId;
    if (shouldStopBatch) {
        await stopPublishBatch({ stopActiveTask: false, message: '已停止批量发布' });
    }
    const activeTaskIds = taskId
        ? [taskId]
        : Object.entries(publishSessions || {})
            .filter(([, session]) => isPublishSessionActive(session))
            .map(([activeTaskId]) => activeTaskId);
    for (const activeTaskId of activeTaskIds) {
        clearPublishWatchdog(activeTaskId);
        clearPublishRetry(activeTaskId);
        await PublishRuntime.stop(getPublishRuntimeContext(activeTaskId));
        if (!options.skipAutoDispatchPause) {
            await setTaskAutoDispatchPaused(activeTaskId, true, options.pauseReason || 'manual-stop');
        }
        if (taskId && isPublishBatchRunning()) {
            await publishBatchRuntime.markTask(activeTaskId, 'failed', '已手动停止');
            schedulePublishBatchAdvance('publish-manual-stop', 300);
        }
    }

    if (!taskId && !options.skipAutoDispatchPause) {
        await TaskStore.updateTasks((tasks) => tasks.map((task) => {
            if (!autoPublishDispatch.isAutoPublishTask({ ...task, autoDispatchPaused: false })) {
                return task;
            }
            return {
                ...task,
                autoDispatchPaused: true,
                autoDispatchPausedAt: new Date().toISOString(),
                autoDispatchPauseReason: compactText(options.pauseReason || 'manual-stop')
            };
        }));
    }
}

async function continuePublish(taskId) {
    await ensurePublishSessionsLoaded();
    if (!taskId) return;
    await PublishRuntime.continue(getPublishRuntimeContext(taskId));
}

async function republishResource(resourceId, taskId) {
    await ensurePublishSessionsLoaded();
    if (!taskId) return;
    await PublishRuntime.republish(getPublishRuntimeContext(taskId), resourceId, taskId);
}

function shouldFocusPublishTab(task, settings = {}) {
    return task?.mode !== 'full-auto' || !!settings.publishDebugMode;
}

async function focusPublishTab(taskId) {
    const session = getPublishSessionState(taskId);
    if (!session.currentTabId) return;

    try {
        const tab = await chrome.tabs.get(session.currentTabId);
        await chrome.tabs.update(tab.id, { active: true });
        if (typeof tab.windowId === 'number') {
            await chrome.windows.update(tab.windowId, { focused: true });
        }
    } catch {}
}

async function openOrReusePublishTab(taskId, url, options = {}) {
    const { active = true, preferCommentAnchor = true, commentHash = 'comments' } = options;
    const session = getPublishSessionState(taskId);
    const existingTabId = session.currentTabId;
    const navigateUrl = preferCommentAnchor
        ? buildPublishViewportUrl(url, { commentHash })
        : url;

    if (existingTabId) {
        try {
            await chrome.tabs.get(existingTabId);
            await chrome.tabs.update(existingTabId, { url: navigateUrl, active });
            await waitForTabLoad(existingTabId);
            return { id: existingTabId };
        } catch {
            updatePublishSessionState(taskId, { currentTabId: null });
        }
    }

    const tab = await chrome.tabs.create({ url: navigateUrl, active });
    updatePublishSessionState(taskId, { currentTabId: tab.id });
    await waitForTabLoad(tab.id);
    return tab;
}

function buildPublishViewportUrl(url, options = {}) {
    const rawUrl = String(url || '').trim();
    if (!rawUrl) return rawUrl;

    try {
        const parsed = new URL(rawUrl);
        if (!/^https?:$/i.test(parsed.protocol || '')) {
            return rawUrl;
        }

        if (parsed.hash) {
            return parsed.toString();
        }

        const commentHash = String(options.commentHash || 'comments').trim().replace(/^#+/, '');
        if (!commentHash) {
            return parsed.toString();
        }

        parsed.hash = commentHash;
        return parsed.toString();
    } catch {
        return rawUrl;
    }
}

function shouldPreferCommentViewport(resource = {}, task = {}, workflow = null) {
    const workflowId = workflow?.id || task?.workflowId || '';
    const rules = self.ResourceRules;
    if (!rules) return false;

    if (workflowId === 'blog-comment-backlink') {
        return !!(
            rules.resourceLooksLikeArticleComment?.(resource)
            || rules.resourceHasInlineSubmitForm?.(resource)
            || (
                rules.resourceLooksLikeComment?.(resource)
                && (
                    rules.resourceSupportsWebsiteField?.(resource)
                    || rules.resourceSupportsInlineCommentLink?.(resource)
                )
            )
        );
    }

    return !!(
        rules.resourceLooksLikeArticleComment?.(resource)
        || rules.resourceHasInlineSubmitForm?.(resource)
    );
}

/**
 * 署名池解析：把一个多行/多条字符串拆成有效条目列表。
 * 支持 \n / ; / , 三种分隔符（\n 最常用，逗号/分号为写在单行时的兼容）。
 * 空行和纯空白条目剔除，前后空格 trim。
 */
function parseIdentityPool(raw = '') {
    return String(raw || '')
        .split(/[\n;,]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

/**
 * 从名字池 + 邮箱池里抽一条配对条目。
 * - 两个池都至少有 1 条：按 min(len_name, len_email) 随机挑同一个 index（避免错配）
 * - 只有名字池：从名字随机挑，邮箱用单条
 * - 单条：退化为原行为，跟老代码一样
 * - 两者都空：返回空字符串
 *
 * 目的：避免同一个 commenterName+email 被 Akismet 学成指纹。
 * 用户在任务配置里填多行名字+多行邮箱（同顺序），扩展每次发布随机抽一组。
 */
function pickPooledIdentity(rawName, rawEmail) {
    const names = parseIdentityPool(rawName);
    const emails = parseIdentityPool(rawEmail);
    if (names.length <= 1 && emails.length <= 1) {
        return { name: names[0] || '', email: emails[0] || '' };
    }
    // 两池都有多条：按最短池长配对
    if (names.length > 1 && emails.length > 1) {
        const len = Math.min(names.length, emails.length);
        const idx = Math.floor(Math.random() * len);
        return { name: names[idx], email: emails[idx] };
    }
    // 只有一边多条：多边抽、另一边固定
    const name = names.length > 1
        ? names[Math.floor(Math.random() * names.length)]
        : (names[0] || '');
    const email = emails.length > 1
        ? emails[Math.floor(Math.random() * emails.length)]
        : (emails[0] || '');
    return { name, email };
}

async function sendPublishToTab(tabId, resource, task, workflow, settings, overrides = {}) {
    const domainPolicy = await getDomainPublishPolicy(resource?.url || '');
    const templateHint = await self.PublishMemory?.getTemplateHint?.(resource?.url || '');
    const shouldOmitWebsiteField = !!domainPolicy.omitWebsiteField || !!templateHint?.avoidWebsiteField;
    const session = getPublishSessionState(task.id);
    const websiteValue = Object.prototype.hasOwnProperty.call(overrides, 'website')
        ? overrides.website
        : (shouldOmitWebsiteField ? '' : (task.website || settings.website || ''));

    // 从池里抽一组 name+email（单条时等同旧行为）
    const pooledIdentity = pickPooledIdentity(
        task.name_commenter || settings.name || task.name || '',
        task.email || settings.email || ''
    );
    const workflowScriptFiles = workflow?.scripts?.length ? [...workflow.scripts] : [
        'content/comment-form-detection.js',
        'content/comment-standard-flow.js',
        'content/comment-executor.js',
        'content/comment-preflight.js',
        'content/comment-publisher.js'
    ];
    const scriptFiles = ensurePublishContentScripts(workflowScriptFiles);
    const styleFiles = workflow?.styles?.length ? workflow.styles : ['content/comment-publisher.css'];

    // 黑匣子：为这次 dispatch 分配 attemptId，贯穿 background / content 两层所有事件
    const attemptId = createPublishAttemptId();
    const eventBase = {
        attemptId,
        taskId: task?.id || '',
        resourceId: resource?.id || '',
        tabId,
        url: resource?.url || ''
    };
    logPublishEvent('dispatch-start', {
        ...eventBase,
        data: {
            workflowId: workflow?.id || '',
            mode: task?.mode || 'semi-auto',
            commentStyle: task?.commentStyle || 'standard',
            retryWithoutWebsite: !!overrides.retryWithoutWebsite,
            websiteOmitted: !websiteValue,
            domainPolicyOmit: !!domainPolicy.omitWebsiteField,
            templateHintAvoid: !!templateHint?.avoidWebsiteField,
            // 池抽取信息：方便在黑匣子里回看"这轮用了哪个名字"
            pickedName: pooledIdentity.name,
            nameFromPool: parseIdentityPool(task.name_commenter || settings.name || task.name || '').length > 1,
            emailFromPool: parseIdentityPool(task.email || settings.email || '').length > 1
        }
    });

    // 给 executeScript 加 8 秒超时，防止页面无响应导致永久挂起
    const withTimeout = (promise, ms, label) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms))
    ]);

    try {
        await withTimeout(
            chrome.scripting.executeScript({
                target: { tabId },
                files: scriptFiles
            }),
            8000,
            'executeScript'
        );
        if (styleFiles.length > 0) {
            await withTimeout(
                chrome.scripting.insertCSS({
                    target: { tabId },
                    files: styleFiles
                }),
                3000,
                'insertCSS'
            );
        }
        logPublishEvent('scripts-injected', eventBase);
    } catch (e) {
        logPublishEvent('scripts-inject-failed', {
            ...eventBase,
            data: { error: e?.message || String(e) }
        });
        // 脚本注入失败/超时，立刻启动看门狗确保兜底跳走
        schedulePublishWatchdog(task.id, {
            stage: 'dispatch',
            resourceId: resource.id,
            currentUrl: resource.url,
            sessionId: session.sessionId || '',
            timeoutMs: 5000  // 5 秒后强制跳过
        });
        throw new Error(`脚本注入失败: ${e.message}`);
    }

    try {
        await chrome.tabs.sendMessage(tabId, {
            action: 'fillComment',
            data: {
                attemptId,
                name: pooledIdentity.name,
                email: pooledIdentity.email,
                website: websiteValue,
                mode: task.mode || 'semi-auto',
                resourceId: resource.id,
                taskId: task.id,
                sessionId: session.sessionId || '',
                useAI: workflow?.defaults?.useAI !== false,
                pageTitle: resource.pageTitle || '',
                debugMode: !!settings.publishDebugMode,
                workflow,
                commentStyle: task.commentStyle || 'standard',
                anchorKeyword: task.anchorKeyword || settings.anchorKeyword || '',
                anchorUrl: task.anchorUrl || settings.anchorUrl || task.website || '',
                retryWithoutWebsite: !!overrides.retryWithoutWebsite,
                resource: {
                    id: resource.id,
                    url: resource.url,
                    pageTitle: resource.pageTitle || '',
                    linkMethod: resource.linkMethod || '',
                    linkModes: resource.linkModes || [],
                    opportunities: resource.opportunities || [],
                    details: resource.details || []
                },
                siteTemplate: templateHint || null
            }
        });
        logPublishEvent('fill-message-sent', eventBase);
    } catch (error) {
        logPublishEvent('fill-message-failed', {
            ...eventBase,
            data: { error: error?.message || String(error) }
        });
        throw new Error(`发送发布消息失败: ${error.message || 'unknown error'}`);
    }

    // 把 attemptId 存进 session，供后续 watchdog / navigation-confirm / verifier 事件关联
    updatePublishSessionState(task.id, { currentAttemptId: attemptId });

    // 看门狗必须启动，确保即使脚本卡住也能兜底跳走
    schedulePublishWatchdog(task.id, {
        stage: 'dispatch',
        resourceId: resource.id,
        currentUrl: resource.url,
        sessionId: session.sessionId || '',
        attemptId
    });
}

function ensurePublishContentScripts(scriptFiles = []) {
    const nextFiles = Array.isArray(scriptFiles) ? [...scriptFiles] : [];
    if (!nextFiles.includes('content/comment-publisher.js')) {
        return nextFiles;
    }

    const requiredFiles = [
        'content/comment-form-detection.js',
        'content/comment-standard-flow.js',
        'content/comment-executor.js',
        'content/comment-preflight.js'
    ];

    for (const file of requiredFiles.reverse()) {
        if (!nextFiles.includes(file)) {
            nextFiles.unshift(file);
        }
    }

    return nextFiles;
}

// 防御：提交后页面被重定向到 Cloudflare challenge / 登录墙 / 错误页时不能认为成功。
// 老版本用单词级 regex（包含 "challenge" / "login" / "forbidden" / "please-wait" 等
// 通用词），结果博客文章 slug 里含这些词就被误判，比如
//   feedyourfictionaddiction.com/.../discussion-challenge-link-up-giveaway.html
//     ^^^ "challenge" 是"书籍挑战活动"的意思，不是 Cloudflare challenge
//
// 新版用 URL 结构化解析：host / pathname / search 分别精确检查，只命中真正的
// 安全防护/错误页标识，不会误伤博客正文 slug。
function classifyPostSubmitUrl(rawUrl = '') {
    const raw = String(rawUrl || '').trim();
    if (!raw) return { blocked: false };
    let u;
    try {
        u = new URL(raw);
    } catch {
        return { blocked: false };
    }
    const host = u.hostname.toLowerCase();
    const path = (u.pathname || '/').toLowerCase();
    const search = (u.search || '').toLowerCase();

    // 1. Cloudflare / DDoS-Guard 的 CDN 主机名
    if (/(?:^|\.)cloudflare\.com$/.test(host)) return { blocked: true, reason: 'cloudflare-host' };
    if (/(?:^|\.)ddos-guard\.net$/.test(host)) return { blocked: true, reason: 'ddos-guard-host' };

    // 2. Cloudflare 挑战路径/参数（站点自己用 Cloudflare 代理时会出现在同站 URL 上）
    if (path.includes('/cdn-cgi/challenge-platform/')) return { blocked: true, reason: 'cf-challenge-path' };
    if (path.includes('/cdn-cgi/turnstile/')) return { blocked: true, reason: 'cf-turnstile-path' };
    if (search.includes('__cf_chl_')) return { blocked: true, reason: 'cf-challenge-param' };

    // 3. WP 登录页（精确路径，不是 slug 包含 login 就算）
    if (path === '/wp-login.php' || path.startsWith('/wp-login.php/')) {
        return { blocked: true, reason: 'wp-login' };
    }

    // 4. HTTP 错误页：路径就是单独的错误号或 "forbidden" 等关键字（不是嵌在 slug 里）
    //    匹配 /403 /404 /500 /503 /access-denied /forbidden 及其 .html/.php 变体
    if (/^\/(?:403|404|500|502|503|access-denied|forbidden)(?:\.(?:html?|php))?\/?$/.test(path)) {
        return { blocked: true, reason: 'http-error-page' };
    }

    // 5. 常见自定义登录路径（精确匹配整段路径，不是子串）
    //    避开误伤博客 slug（比如 "/how-to-login-tutorial/"）
    if (/^\/(?:login|signin|sign-in|account\/login|users\/sign_in)\/?$/.test(path)) {
        return { blocked: true, reason: 'login-page' };
    }

    return { blocked: false };
}

async function finalizePendingSubmissionFromNavigation(taskId, tabId) {
    await ensurePublishSessionsLoaded();
    const sessionSnapshot = getPublishSessionState(taskId);
    const pending = sessionSnapshot.pendingSubmission;
    if (!pending || pending.tabId !== tabId) return;

    clearPublishWatchdog(taskId);
    updatePublishSessionState(taskId, { pendingSubmission: null });

    let postUrl = '';
    try {
        const tab = await chrome.tabs.get(tabId);
        postUrl = tab?.url || '';
    } catch {}

    const classification = classifyPostSubmitUrl(postUrl);
    const attemptId = sessionSnapshot.currentAttemptId || '';

    if (classification.blocked) {
        logPublishEvent('navigation-confirm-blocked', {
            attemptId,
            taskId,
            resourceId: pending.resourceId,
            tabId,
            url: postUrl,
            data: { reason: classification.reason, blockReason: classification.reason }
        });
        // 跳转到 challenge/登录/错误页 → 评论肯定没发，标软可重试失败，
        // 走 SOFT_RETRYABLE 重试而不是一头扎进 'submitted' → verifier 再判错。
        await handleCommentAction(
            pending.resourceId,
            'failed',
            pending.taskId,
            {
                ...(pending.meta || {}),
                reportedVia: 'navigation-confirm-blocked',
                pageUrlAfterSubmit: postUrl,
                submissionBlocked: true,
                submissionBlockReason: 'publish-runtime-timeout',
                attemptId
            },
            pending.sessionId || ''
        );
        return;
    }

    logPublishEvent('navigation-confirm-ok', {
        attemptId,
        taskId,
        resourceId: pending.resourceId,
        tabId,
        url: postUrl,
        data: {}
    });

    await handleCommentAction(
        pending.resourceId,
        'submitted',
        pending.taskId,
        {
            ...(pending.meta || {}),
            reportedVia: 'navigation-confirm',
            pageUrlAfterSubmit: postUrl,
            attemptId
        },
        pending.sessionId || ''
    );
}
