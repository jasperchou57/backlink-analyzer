/** Publish flow - extracted from background.js */

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

    const historyEntry = getResourcePublishHistoryEntry(resource, getTaskPublishTarget(task));
    if (!historyEntry) return true;
    if (historyEntry.lastStatus === 'pending' && historyEntry?.publishMeta?.reviewPending) {
        return false;
    }
    if (historyEntry.lastStatus === 'failed') {
        const failureRecovery = getPublishFailureRecoveryPolicy(historyEntry?.publishMeta || {}, historyEntry);
        return !!failureRecovery.retryable;
    }

    return !['published', 'skipped', 'failed'].includes(historyEntry.lastStatus);
}

function isRateLimitReason(reason = '') {
    return String(reason || '').toLowerCase() === 'comment_rate_limited';
}

function getPublishFailureRecoveryPolicy(publishMeta = {}, historyEntry = null) {
    const reason = compactText(publishMeta?.submissionBlockReason || '').toLowerCase();
    const failedAttempts = Number(historyEntry?.attempts?.failed || 0);
    const maxAttempts = Number(PUBLISH_STRATEGY.RETRYABLE_FAILURE_MAX_ATTEMPTS || 0) || 3;

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

    if (reason === 'comment_submission_blocked') {
        return {
            retryable: false,
            terminalStatus: 'skipped',
            reason,
            cooldownMs: 0,
            failedAttempts,
            maxAttempts
        };
    }

    if (reason === 'publish-runtime-timeout' || reason === 'submit-confirm-timeout') {
        return {
            retryable: failedAttempts < maxAttempts,
            terminalStatus: 'failed',
            reason,
            cooldownMs: Number(PUBLISH_STRATEGY.RETRYABLE_FAILURE_COOLDOWN_MS || 0) || 0,
            failedAttempts,
            maxAttempts
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

async function updateTaskPublishStats(taskId, resourceId, status, currentTask = {}) {
    if (!taskId) return;
    await TaskStore.updateTask(taskId, (task) => {
        const stats = task.stats || { total: 0, success: 0, skipped: 0, pending: 0, failed: 0 };
        const nextStats = {
            total: Number(stats.total || 0),
            success: Number(stats.success || 0),
            skipped: Number(stats.skipped || 0),
            pending: Number(stats.pending || 0),
            failed: Number(stats.failed || 0)
        };

        if (status !== 'pending') {
            nextStats.total++;
            if (status === 'published') nextStats.success++;
            else if (status === 'skipped') nextStats.skipped++;
            else if (status === 'failed') nextStats.failed++;
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

async function sendPublishToTab(tabId, resource, task, workflow, settings, overrides = {}) {
    const domainPolicy = await getDomainPublishPolicy(resource?.url || '');
    const templateHint = await self.PublishMemory?.getTemplateHint?.(resource?.url || '');
    const shouldOmitWebsiteField = !!domainPolicy.omitWebsiteField || !!templateHint?.avoidWebsiteField;
    const session = getPublishSessionState(task.id);
    const websiteValue = Object.prototype.hasOwnProperty.call(overrides, 'website')
        ? overrides.website
        : (shouldOmitWebsiteField ? '' : (task.website || settings.website || ''));
    const workflowScriptFiles = workflow?.scripts?.length ? [...workflow.scripts] : [
        'content/comment-form-detection.js',
        'content/comment-standard-flow.js',
        'content/comment-executor.js',
        'content/comment-preflight.js',
        'content/comment-publisher.js'
    ];
    const scriptFiles = ensurePublishContentScripts(workflowScriptFiles);
    const styleFiles = workflow?.styles?.length ? workflow.styles : ['content/comment-publisher.css'];

    await chrome.scripting.executeScript({
        target: { tabId },
        files: scriptFiles
    });
    if (styleFiles.length > 0) {
        await chrome.scripting.insertCSS({
            target: { tabId },
            files: styleFiles
        });
    }

    await chrome.tabs.sendMessage(tabId, {
        action: 'fillComment',
        data: {
            name: task.name_commenter || settings.name || task.name || '',
            email: task.email || settings.email || '',
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

    schedulePublishWatchdog(task.id, {
        stage: 'dispatch',
        resourceId: resource.id,
        currentUrl: resource.url,
        sessionId: session.sessionId || ''
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

async function finalizePendingSubmissionFromNavigation(taskId, tabId) {
    await ensurePublishSessionsLoaded();
    const pending = getPublishSessionState(taskId).pendingSubmission;
    if (!pending || pending.tabId !== tabId) return;

    clearPublishWatchdog(taskId);
    updatePublishSessionState(taskId, { pendingSubmission: null });
    await handleCommentAction(
        pending.resourceId,
        'submitted',
        pending.taskId,
        {
            ...(pending.meta || {}),
            reportedVia: 'navigation-confirm'
        },
        pending.sessionId || ''
    );
}
