/** Publish session management - extracted from background.js */

function getPublishStateView() {
    return TaskManager.buildPublishSessionsView(publishSessions, publishBatchRuntime.getState());
}

function isPublishSessionActive(state = {}) {
    return !!(
        state?.isPublishing
        || state?.awaitingManualContinue
        || state?.pendingSubmission
    );
}

function getActivePublishTaskIds() {
    return Object.entries(publishSessions || {})
        .filter(([, state]) => isPublishSessionActive(state))
        .map(([taskId]) => taskId);
}

function shouldPersistPublishSession(state = {}) {
    return !!(
        state?.currentTask
        || state?.isPublishing
        || state?.awaitingManualContinue
        || state?.pendingSubmission
        || state?.currentTabId
        || state?.currentUrl
        || state?.sessionId
        || state?.currentLease
        || (Array.isArray(state?.queue) && state.queue.length > 0)
        || state?.currentIndex
    );
}

function normalizeInterruptedPublishSession(state = {}) {
    if (!state?.isPublishing && !state?.awaitingManualContinue && !state?.pendingSubmission) {
        return state;
    }
    return {
        ...state,
        isPublishing: false,
        awaitingManualContinue: false,
        pendingSubmission: null,
        stopRequested: false,
        currentLease: null,
        nextRetryAt: '',
        waitingReason: ''
    };
}

function getPublishSessionState(taskId) {
    return {
        ...TaskManager.createDefaultPublishState(),
        ...(publishSessions?.[taskId] || {})
    };
}

function setPublishSessionState(taskId, nextState) {
    if (!taskId) return;
    if (shouldPersistPublishSession(nextState)) {
        publishSessions[taskId] = nextState;
    } else {
        delete publishSessions[taskId];
    }
    publishSessionsLoaded = true;
    flushPublishSessions().catch(() => {});
}

function updatePublishSessionState(taskId, patch = {}) {
    if (!taskId) return;
    const nextState = {
        ...getPublishSessionState(taskId),
        ...(patch || {})
    };
    setPublishSessionState(taskId, nextState);
}

function findPublishSessionTaskIdByPendingTab(tabId) {
    return Object.entries(publishSessions || {}).find(([, session]) => session.pendingSubmission?.tabId === tabId)?.[0] || '';
}

function findPublishSessionTaskIdByCurrentTab(tabId) {
    return Object.entries(publishSessions || {}).find(([, session]) => session.currentTabId === tabId)?.[0] || '';
}

function findPublishSessionTaskIdByResource(resourceId) {
    return Object.entries(publishSessions || {}).find(([, session]) => {
        const activeResourceId = session.queue?.[session.currentIndex]?.id || '';
        return activeResourceId === resourceId || session.pendingSubmission?.resourceId === resourceId;
    })?.[0] || '';
}

async function ensurePublishSessionsLoaded() {
    if (publishSessionsLoaded) return;
    const loadedSessions = await StateStore.loadPublishSessions(createDefaultPublishSessions());
    const nextSessions = {};
    let changed = false;

    for (const [taskId, session] of Object.entries(loadedSessions || {})) {
        const normalized = normalizeInterruptedPublishSession(session);
        nextSessions[taskId] = normalized;
        if (JSON.stringify(normalized) !== JSON.stringify(session || {})) {
            changed = true;
        }
    }

    publishSessions = nextSessions;
    publishSessionsLoaded = true;

    if (changed) {
        await StateStore.savePublishSessions(publishSessions);
    }
}

async function flushPublishSessions() {
    await StateStore.savePublishSessions(publishSessions);
}

async function ensurePublishBatchStateLoaded() {
    await publishBatchRuntime.ensureLoaded();
}

async function flushPublishBatchState() {
    await publishBatchRuntime.flush();
}

async function ensureAutoPublishControlLoaded() {
    if (autoPublishControlLoaded) return;
    autoPublishControlState = await StateStore.loadAutoPublishControlState(createDefaultAutoPublishControlState());
    autoPublishControlLoaded = true;
}

async function flushAutoPublishControlState() {
    await ensureAutoPublishControlLoaded();
    await StateStore.saveAutoPublishControlState(autoPublishControlState);
}

function getAutoPublishControlState() {
    return {
        ...createDefaultAutoPublishControlState(),
        ...(autoPublishControlState || {})
    };
}

async function setManualPublishFocusTask(taskId = '', reason = '') {
    await ensureAutoPublishControlLoaded();
    autoPublishControlState = {
        manualFocusTaskId: compactText(taskId || ''),
        updatedAt: new Date().toISOString(),
        reason: compactText(reason || (taskId ? 'manual-start' : 'cleared'))
    };
    await flushAutoPublishControlState();
}

function setPublishBatchState(nextState = {}) {
    publishBatchRuntime.setState(nextState);
}

function updatePublishBatchState(patch = {}) {
    publishBatchRuntime.updateState(patch);
}

function broadcastPublishBatchState() {
    publishBatchRuntime.broadcast();
}

function getPublishBatchDoneTaskIds(state = publishBatchRuntime.getState()) {
    return publishBatchRuntime.getDoneTaskIds(state);
}

function getPublishBatchRemainingTaskIds(state = publishBatchRuntime.getState()) {
    return publishBatchRuntime.getRemainingTaskIds(state);
}

function isPublishBatchRunning() {
    return publishBatchRuntime.isRunning();
}

function schedulePublishBatchAdvance(reason = 'publish-done', delayMs = 700) {
    publishBatchRuntime.scheduleAdvance(reason, delayMs);
}

async function finalizePublishBatch(message = '批量发布已完成') {
    return await publishBatchRuntime.finalize(message);
}

async function markPublishBatchTask(taskId, outcome = 'completed', detail = '', taskMap = new Map()) {
    await publishBatchRuntime.markTask(taskId, outcome, detail, taskMap);
}

async function advancePublishBatch(reason = 'task-finished') {
    return await publishBatchRuntime.advance(reason);
}

async function startPublishBatch(taskIds = []) {
    await setManualPublishFocusTask('', 'batch-start');
    return await publishBatchRuntime.start(taskIds);
}

async function stopPublishBatch(options = {}) {
    return await publishBatchRuntime.stop(options);
}

function clearPublishRetry(taskId) {
    const timer = publishRetryTimers.get(taskId);
    if (timer) {
        clearTimeout(timer);
        publishRetryTimers.delete(taskId);
    }
}

function schedulePublishRetry(taskId, delayMs = 1500, reason = 'lease-blocked') {
    if (!taskId) return;
    clearPublishRetry(taskId);
    const timeoutMs = Math.max(400, Number(delayMs || 0));
    const timer = setTimeout(async () => {
        publishRetryTimers.delete(taskId);
        try {
            await ensurePublishSessionsLoaded();
            const session = getPublishSessionState(taskId);
            if (!session.isPublishing || session.awaitingManualContinue) return;
            await PublishRuntime.dispatchQueue(getPublishRuntimeContext(taskId));
        } catch (error) {
            await Logger.error(`发布重试调度失败: ${error.message}`, {
                taskId,
                reason
            });
        }
    }, timeoutMs);
    publishRetryTimers.set(taskId, timer);
}

function isPublishSessionMatch(taskId, sessionId = '') {
    if (!taskId) return false;
    const session = getPublishSessionState(taskId);
    if (!sessionId) return true;
    return compactText(session.sessionId || '') === compactText(sessionId || '');
}

function getPublishLeaseConflict(taskId, sessionId = '', resource = {}) {
    const normalizedResourceId = compactText(resource?.id || '');
    const normalizedDomain = getDomainBg(resource?.url || '');
    if (!normalizedResourceId && !normalizedDomain) return null;

    for (const [activeTaskId, session] of Object.entries(publishSessions || {})) {
        if (!isPublishSessionActive(session)) continue;
        const lease = session?.currentLease || null;
        if (!lease) continue;
        const sameSession = activeTaskId === taskId
            && compactText(lease.sessionId || '') === compactText(sessionId || '');
        if (sameSession) continue;

        if (normalizedResourceId && compactText(lease.resourceId || '') === normalizedResourceId) {
            return {
                type: 'resource',
                taskId: activeTaskId,
                resourceId: normalizedResourceId,
                domain: compactText(lease.domain || normalizedDomain),
                url: compactText(lease.url || '')
            };
        }

        if (normalizedDomain && compactText(lease.domain || '') === normalizedDomain) {
            return {
                type: 'domain',
                taskId: activeTaskId,
                resourceId: compactText(lease.resourceId || ''),
                domain: normalizedDomain,
                url: compactText(lease.url || '')
            };
        }
    }

    return null;
}
