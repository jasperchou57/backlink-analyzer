/**
 * Background Service Worker - V3
 * AI 驱动 + 递归发现 + 多任务发布 + 日志 + Google Sheets
 */

// 导入模块
importScripts(
    '../utils/local-db.js',
    '../utils/resource-rules.js',
    '../utils/domain-profile.js',
    '../utils/html-comment-detection.js',
    'core/state-store.js',
    'core/task-store.js',
    'core/resource-store.js',
    'core/resource-pools.js',
    'core/runtime-message-router.js',
    'core/publish-memory.js',
    'core/frontier-scheduler.js',
    'core/task-manager.js',
    'core/task-runner.js',
    'core/continuous-discovery-engine.js',
    'core/collector-runtime.js',
    'core/publish-batch.js',
    'core/publish-runtime.js',
    'tasks/discover-workflow.js',
    'tasks/publish-workflow.js',
    '../utils/ai-engine.js',
    '../utils/logger.js',
    '../utils/google-sheets.js',
    '../utils/workflows.js'
);

// === 状态 ===
let collectState = {
    isCollecting: false,
    domain: '',
    myDomain: '',
    sources: [],
    backlinks: { ahrefs: [], semrush: [], similarweb: [] },
    myBacklinks: [],
    stats: { backlinksFound: 0, targetsFound: 0, analyzed: 0, blogResources: 0, inQueue: 0 },
    // 递归发现
    discoveredDomains: new Set(),
    discoveryQueue: [],
    processedDiscoveryDomains: new Set(),
    discoveryDepth: 0,
    maxDiscoveryDepth: 3,
    maxDiscoveryQueue: 500,
    maxRecursiveDomains: 50,
    recursiveDomainsProcessed: 0,
    sourceRequest: null
};

const ANALYSIS_STRATEGY = {
    DIRECT_PAGE_LIMIT: 450,
    DOMAIN_SEED_LIMIT: 260,
    DOMAIN_FETCH_TIMEOUT: 8000,
    DOMAIN_DRILLDOWN_CONCURRENCY: 6,
    MAX_DRILLDOWN_PAGES_PER_DOMAIN: 4,
    MAX_DRILLDOWN_LINKS_TO_PARSE: 120,
    MAX_ANALYSIS_TARGETS: 1200
};

const DISCOVERY_STRATEGY = {
    RECURSIVE_SOURCE_ALLOWLIST: ['semrush', 'similarweb']
};

const PUBLISH_STRATEGY = {
    DOMAIN_RATE_LIMIT_COOLDOWN_MS: 5 * 60 * 1000,
    RETRYABLE_FAILURE_COOLDOWN_MS: 12 * 60 * 1000,
    UNKNOWN_FAILURE_COOLDOWN_MS: 30 * 60 * 1000,
    RETRYABLE_FAILURE_MAX_ATTEMPTS: 3
};

const STORAGE_STRATEGY = {
    RESOURCE_HISTORY_LIMIT: 6,
    RESOURCE_URL_LIMIT: 260,
    RESOURCE_TITLE_LIMIT: 140,
    RESOURCE_DETAIL_LIMIT: 4,
    RESOURCE_DETAIL_TEXT_LIMIT: 80,
    RESOURCE_QUOTA_RETRY_LIMITS: [4500, 3500, 2500, 1500]
};

const SOURCE_TIERS = {
    HISTORICAL_SUCCESS: 'historical-success',
    COMMENT_OBSERVED: 'comment-observed',
    COMPETITOR_BACKLINK: 'competitor-backlink',
    RULE_GUESS: 'rule-guess',
    AI_GUESS: 'ai-guess'
};

const SOURCE_TIER_SCORES = {
    [SOURCE_TIERS.HISTORICAL_SUCCESS]: 100,
    [SOURCE_TIERS.COMMENT_OBSERVED]: 82,
    [SOURCE_TIERS.COMPETITOR_BACKLINK]: 64,
    [SOURCE_TIERS.RULE_GUESS]: 38,
    [SOURCE_TIERS.AI_GUESS]: 18
};

const resourceStore = ResourceStore.create({
    strategy: STORAGE_STRATEGY,
    compactText,
    normalizeHttpUrl: normalizeHttpUrlBg,
    logger: console
});

const MARKETING_STRATEGY = {
    PROMOTION_REFRESH_HOURS: 6
};

const PUBLISH_WATCHDOG = {
    DISPATCH_MS: 20000,
    SUBMISSION_MS: 15000
};

const PUBLISH_STAGE_WATCHDOG_MS = {
    bootstrap: 12000,
    preflight: 9000,
    finding_form: 9000,
    form_detected: 7000,
    generating_comment: 7000,
    comment_ready: 5000,
    filling_form: 6000,
    form_filled: 5000,
    pre_submit: 5000,
    submitting: 12000
};

const RESOURCE_POOLS = self.ResourcePoolUtils?.DEFAULT_POOLS || {
    MAIN: 'main',
    LEGACY: 'legacy',
    QUARANTINE: 'quarantine'
};
const RESOURCE_SIGNAL_VERSION = 3;
const PUBLISH_TASK_SCHEMA_VERSION = 2;

let publishSessions = TaskManager.createDefaultPublishSessions();
let publishSessionsLoaded = false;
const publishWatchdogs = new Map();
let autoPublishDispatchTimer = null;
let autoPublishDispatchRunning = false;
let resourceSignalNormalizationTimer = null;
let resourceSignalNormalizationRunning = false;

const domainProfileUtils = self.DomainProfileUtils.create({
    compactText,
    getDomain: getDomainBg,
    sourceTiers: SOURCE_TIERS,
    sourceTierScores: SOURCE_TIER_SCORES
});

const {
    pushUniqueValue,
    mergeStringArrays,
    inferLanguageFromHtml,
    inferCountryFromDomain,
    detectCmsFromHtml,
    detectSiteTypeFromHtml,
    detectTopicFromText,
    normalizeSourceTier,
    getSourceTierScore,
    preferHigherSourceTier,
    mergeSourceTierArrays,
    buildDiscoveryEdge,
    mergeDiscoveryEdges,
    getResourcePublishedSuccessCount,
    getResourceAnchorVerifiedCount,
    getEffectiveResourceSourceTier,
    summarizeSourceEvidenceFromEdges,
    calculateDomainQualityScore,
    buildDomainProfileFromHtml
} = domainProfileUtils;

const resourcePoolUtils = self.ResourcePoolUtils.create({
    resourceRules: self.ResourceRules,
    getSourceTierScore,
    getResourcePublishedSuccessCount,
    getResourceAnchorVerifiedCount
});

const {
    apply: applyResourcePool,
    getResourcePool,
    countByPool: countResourcesByPool,
    selectDispatchResources
} = resourcePoolUtils;

const publishBatchRuntime = self.PublishBatchRuntime.create({
    taskManager: TaskManager,
    stateStore: StateStore,
    taskStore: TaskStore,
    logger: Logger,
    broadcast: (state) => {
        broadcastToPopup({
            action: 'publishBatchUpdate',
            state
        });
    },
    ensurePublishSessionsLoaded: () => ensurePublishSessionsLoaded(),
    getPublishStateView: () => TaskManager.buildPublishSessionsView(publishSessions, publishBatchRuntime.getState()),
    getTaskType,
    startPublish: (task, options = {}) => startPublish(task, options),
    stopPublish: (taskId, options = {}) => stopPublish(taskId, options),
    hasActivePublishSession: () => Object.values(publishSessions || {}).some((session) =>
        session.isPublishing || session.awaitingManualContinue || session.pendingSubmission
    ),
    clearAutoPublishDispatchTimer: () => {
        if (autoPublishDispatchTimer) {
            clearTimeout(autoPublishDispatchTimer);
            autoPublishDispatchTimer = null;
        }
    }
});

let domainIntelCache = {
    frontier: [],
    profiles: {}
};
let domainIntelLoaded = false;

let continuousDiscoveryState = {
    isRunning: false,
    isPaused: true,
    seedDomain: '',
    myDomain: '',
    sources: [],
    seedInitialized: false,
    currentDomain: '',
    lastSeedRunAt: '',
    lastFrontierRunAt: '',
    lastCompletedAt: '',
    lastMessage: ''
};
let continuousDiscoveryLoaded = false;
let continuousDiscoveryLoopRunning = false;

let marketingAutomationState = TaskManager.createDefaultMarketingAutomationState();
let marketingAutomationLoaded = false;
let marketingAutomationLoopRunning = false;

let panelWindowId = null;
let collectTabId = null;
let marketingExecutionTabId = null;

async function openPanelWindow() {
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
}

async function configureActionSurface() {
    if (!chrome.sidePanel?.setPanelBehavior) return;

    try {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } catch {}
}

async function bootstrapBackgroundRuntime() {
    if (chrome.sidePanel?.setPanelBehavior) {
        await configureActionSurface();
    }
    await restoreTaskSchedules();
    await performStorageMaintenance();
}

function triggerBackgroundBootstrap() {
    bootstrapBackgroundRuntime().catch(() => {});
}

triggerBackgroundBootstrap();
chrome.runtime.onInstalled.addListener(() => {
    triggerBackgroundBootstrap();
});
chrome.runtime.onStartup.addListener(() => {
    triggerBackgroundBootstrap();
});

if (!chrome.sidePanel?.setPanelBehavior) {
    // Fallback for browsers without side panel support.
    chrome.action.onClicked.addListener(() => {
        openPanelWindow();
    });
}

function handleAlarmEvent(alarm) {
    if (!alarm?.name) return;
    if (alarm.name.startsWith('nurture:')) {
        handleNurtureAlarm(alarm.name.slice('nurture:'.length)).catch(() => {});
        return;
    }
    if (alarm.name.startsWith('marketing-refresh:')) {
        handleMarketingRefreshAlarm(alarm.name.slice('marketing-refresh:'.length)).catch(() => {});
    }
}

function handleWindowRemoved(windowId) {
    if (windowId === panelWindowId) panelWindowId = null;
}

function handleTabRemoved(tabId) {
    if (tabId === collectTabId) {
        collectTabId = null;
    }
    if (tabId === marketingExecutionTabId) {
        marketingExecutionTabId = null;
    }
    let changed = false;
    for (const [taskId, session] of Object.entries(publishSessions || {})) {
        if (tabId === session.currentTabId) {
            publishSessions[taskId] = { ...session, currentTabId: null };
            changed = true;
        }
        if (tabId === session.pendingSubmission?.tabId) {
            publishSessions[taskId] = { ...publishSessions[taskId], pendingSubmission: null };
            changed = true;
        }
    }
    if (changed) {
        flushPublishSessions().catch(() => {});
    }
}

function handleTabUpdated(tabId, changeInfo) {
    if (changeInfo.status !== 'complete') return;
    const taskId = findPublishSessionTaskIdByPendingTab(tabId);
    if (!taskId) return;
    finalizePendingSubmissionFromNavigation(taskId, tabId);
}

chrome.alarms.onAlarm.addListener(handleAlarmEvent);
chrome.windows.onRemoved.addListener(handleWindowRemoved);
chrome.tabs.onRemoved.addListener(handleTabRemoved);
chrome.tabs.onUpdated.addListener(handleTabUpdated);

function createDefaultContinuousDiscoveryState() {
    return TaskManager.createDefaultContinuousDiscoveryState();
}

function createDefaultPublishState() {
    return TaskManager.createDefaultPublishState();
}

function createDefaultPublishSessions() {
    return TaskManager.createDefaultPublishSessions();
}

function createDefaultPublishBatchState() {
    return TaskManager.createDefaultPublishBatchState();
}

function getPublishStateView() {
    return TaskManager.buildPublishSessionsView(publishSessions, publishBatchRuntime.getState());
}

function shouldPersistPublishSession(state = {}) {
    return !!(
        state?.currentTask
        || state?.isPublishing
        || state?.awaitingManualContinue
        || state?.pendingSubmission
        || state?.currentTabId
        || state?.currentUrl
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
        currentTabId: null,
        stopRequested: false
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
    return await publishBatchRuntime.start(taskIds);
}

async function stopPublishBatch(options = {}) {
    return await publishBatchRuntime.stop(options);
}

function clearPublishWatchdog(taskId) {
    const timer = publishWatchdogs.get(taskId);
    if (timer) {
        clearTimeout(timer);
        publishWatchdogs.delete(taskId);
    }
}

function schedulePublishWatchdog(taskId, options = {}) {
    if (!taskId || !options.resourceId) return;

    clearPublishWatchdog(taskId);

    const stage = options.stage || 'dispatch';
    const timeoutMs = Number(options.timeoutMs || 0) || (stage === 'submission' ? PUBLISH_WATCHDOG.SUBMISSION_MS : PUBLISH_WATCHDOG.DISPATCH_MS);
    const resourceId = options.resourceId;
    const currentUrl = options.currentUrl || '';

    const timer = setTimeout(async () => {
        publishWatchdogs.delete(taskId);

        try {
            await ensurePublishSessionsLoaded();
            const session = getPublishSessionState(taskId);
            const activeResourceId = session.queue?.[session.currentIndex]?.id || '';
            const pendingResourceId = session.pendingSubmission?.resourceId || '';

            if (!session.isPublishing || session.awaitingManualContinue) return;
            if (stage === 'dispatch' && activeResourceId !== resourceId) return;
            if (stage === 'submission' && pendingResourceId !== resourceId) return;

            await Logger.error('发布任务超时，已自动跳过当前资源', {
                taskId,
                resourceId,
                stage,
                currentUrl
            });

            await handleCommentAction(resourceId, 'failed', taskId, {
                reportedVia: 'watchdog',
                watchdogStage: stage,
                submissionBlocked: true,
                submissionBlockReason: stage === 'submission'
                    ? 'submit-confirm-timeout'
                    : 'publish-runtime-timeout'
            });
        } catch {}
    }, timeoutMs);

    publishWatchdogs.set(taskId, timer);
}

async function ensureContinuousDiscoveryLoaded() {
    if (continuousDiscoveryLoaded) return;
    const data = await StateStore.get(['continuousDiscoveryState', 'collectState']);
    continuousDiscoveryState = await StateStore.loadContinuousDiscoveryState(createDefaultContinuousDiscoveryState());
    const persistedCollectState = data.collectState || {};
    if (continuousDiscoveryState.isRunning && !persistedCollectState.isCollecting) {
        continuousDiscoveryState = TaskManager.buildInterruptedContinuousDiscoveryPatch(continuousDiscoveryState);
        await StateStore.saveContinuousDiscoveryState(continuousDiscoveryState);
    }
    continuousDiscoveryLoaded = true;
}

async function flushContinuousDiscoveryState() {
    await StateStore.saveContinuousDiscoveryState(continuousDiscoveryState);
}

async function updateContinuousDiscoveryState(patch = {}, options = {}) {
    await ensureContinuousDiscoveryLoaded();
    continuousDiscoveryState = TaskManager.normalizeContinuousDiscoveryPatch(continuousDiscoveryState, patch);
    await flushContinuousDiscoveryState();
    if (options.broadcast !== false) {
        await broadcastContinuousDiscoveryState();
    }
}

async function getContinuousDiscoveryStateView() {
    await ensureContinuousDiscoveryLoaded();
    await ensureDomainIntelLoaded();

    const pendingDomains = domainIntelCache.frontier.filter((entry) => {
        const domain = entry.domain || '';
        if (!domain) return false;
        if (domain === getDomainBg(continuousDiscoveryState.seedDomain || '')) return false;
        if (domain === getDomainBg(continuousDiscoveryState.myDomain || '')) return false;
        return (entry.crawlStatus || 'pending') === 'pending';
    }).length;

    const processedDomains = domainIntelCache.frontier.filter((entry) => (entry.crawlStatus || '') === 'completed').length;
    const failedDomains = domainIntelCache.frontier.filter((entry) => (entry.crawlStatus || '') === 'failed').length;

    return TaskManager.buildContinuousDiscoveryView(continuousDiscoveryState, {
        pendingDomains,
        processedDomains,
        failedDomains
    });
}

async function broadcastContinuousDiscoveryState() {
    const state = await getContinuousDiscoveryStateView();
    broadcastToPopup({ action: 'continuousStateUpdate', state });
}

async function ensureMarketingAutomationLoaded() {
    if (marketingAutomationLoaded) return;
    marketingAutomationState = await StateStore.loadMarketingAutomationState(TaskManager.createDefaultMarketingAutomationState());
    if (marketingAutomationState.isRunning && !marketingAutomationLoopRunning) {
        marketingAutomationState = TaskManager.buildInterruptedMarketingAutomationPatch(marketingAutomationState);
        await StateStore.saveMarketingAutomationState(marketingAutomationState);
    }
    marketingAutomationLoaded = true;
}

async function flushMarketingAutomationState() {
    await StateStore.saveMarketingAutomationState(marketingAutomationState);
}

async function updateMarketingAutomationState(patch = {}, options = {}) {
    await ensureMarketingAutomationLoaded();
    marketingAutomationState = TaskManager.normalizeMarketingAutomationPatch(marketingAutomationState, patch);
    await flushMarketingAutomationState();
    if (options.broadcast !== false) {
        await broadcastMarketingAutomationState();
    }
}

function isVisibleMarketingTaskBg(task = {}) {
    const workflow = WorkflowRegistry.get(task?.workflowId || WorkflowRegistry.DEFAULT_WORKFLOW_ID) || {};
    return !workflow.internal && (workflow.taskType || task.taskType || 'publish') !== 'publish';
}

function getPromotionProgress(task = {}) {
    const plan = task?.promotionPlan || {};
    const channels = Array.isArray(plan.channels)
        ? plan.channels.filter((channel) => channel?.workflowId !== 'account-nurture' && normalizeHttpUrlBg(channel.url || ''))
        : [];
    const total = Number(plan.totalOpenableChannels || channels.length || 0);
    const progressed = Math.min(
        total,
        Number.isFinite(Number(plan.progressedChannelCount))
            ? Number(plan.progressedChannelCount)
            : Number(plan.nextChannelIndex || 0)
    );
    return { total, progressed };
}

function getPromotionRefreshAlarmName(taskId = '') {
    return `marketing-refresh:${taskId}`;
}

function getPromotionRefreshDelayMs(task = {}) {
    const rawHours = Number(task.refreshHours || MARKETING_STRATEGY.PROMOTION_REFRESH_HOURS);
    const hours = Number.isFinite(rawHours) && rawHours > 0 ? rawHours : MARKETING_STRATEGY.PROMOTION_REFRESH_HOURS;
    return hours * 60 * 60 * 1000;
}

function computeNextPromotionResearchAt(task = {}) {
    return new Date(Date.now() + getPromotionRefreshDelayMs(task)).toISOString();
}

function getPromotionNextResearchAtMs(task = {}) {
    const value = task?.promotionPlan?.nextResearchAt || '';
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
}

function isPromotionTaskScheduled(task = {}) {
    if (task.workflowId !== 'product-promote-campaign') return false;
    const refreshAtMs = getPromotionNextResearchAtMs(task);
    return refreshAtMs > Date.now();
}

function isPromotionTaskPending(task = {}) {
    if (task.workflowId !== 'product-promote-campaign') return false;
    const plan = task?.promotionPlan || null;
    if (!Array.isArray(plan?.channels) || plan.channels.length === 0) return true;
    const { total, progressed } = getPromotionProgress(task);
    if (total > 0 && progressed < total) return true;
    const refreshAtMs = getPromotionNextResearchAtMs(task);
    return refreshAtMs > 0 && refreshAtMs <= Date.now();
}

function isNurtureTaskDue(task = {}) {
    const workflow = WorkflowRegistry.get(task?.workflowId || WorkflowRegistry.DEFAULT_WORKFLOW_ID) || {};
    const taskType = workflow.taskType || task.taskType || 'publish';
    if (taskType !== 'nurture') return false;
    const nextRunAtMs = new Date(task.nextRunAt || '').getTime();
    return !Number.isFinite(nextRunAtMs) || nextRunAtMs <= Date.now();
}

function getMarketingAutomationMetrics(tasks = []) {
    const visibleTasks = (tasks || []).filter(isVisibleMarketingTaskBg);
    const scheduledRefreshTimes = visibleTasks
        .filter((task) => isPromotionTaskScheduled(task))
        .map((task) => getPromotionNextResearchAtMs(task))
        .filter((time) => time > Date.now())
        .sort((a, b) => a - b);
    return {
        pendingTasks: visibleTasks.filter((task) => isPromotionTaskPending(task)).length,
        dueNurtureTasks: visibleTasks.filter((task) => isNurtureTaskDue(task)).length,
        scheduledPromotionTasks: scheduledRefreshTimes.length,
        nextPromotionRefreshAt: scheduledRefreshTimes[0] ? new Date(scheduledRefreshTimes[0]).toISOString() : ''
    };
}

function selectNextMarketingTask(tasks = [], options = {}) {
    const visibleTasks = (tasks || []).filter(isVisibleMarketingTaskBg);
    const promotionTasks = visibleTasks
        .filter((task) => isPromotionTaskPending(task))
        .sort((a, b) => String(a.lastRunAt || '').localeCompare(String(b.lastRunAt || '')) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

    if (promotionTasks.length > 0) {
        return promotionTasks[0];
    }

    const nurtureTasks = visibleTasks
        .filter((task) => isNurtureTaskDue(task))
        .sort((a, b) => {
            const aTime = new Date(a.nextRunAt || a.createdAt || 0).getTime() || 0;
            const bTime = new Date(b.nextRunAt || b.createdAt || 0).getTime() || 0;
            return aTime - bTime;
        });

    if (nurtureTasks.length > 0) {
        return nurtureTasks[0];
    }

    if (options.forcePromotionRefresh) {
        const refreshableTasks = visibleTasks
            .filter((task) => task.workflowId === 'product-promote-campaign')
            .sort((a, b) => String(a.lastRunAt || '').localeCompare(String(b.lastRunAt || '')) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
        if (refreshableTasks.length > 0) {
            return refreshableTasks[0];
        }
    }

    return null;
}

async function getMarketingAutomationStateView() {
    await ensureMarketingAutomationLoaded();
    const tasks = await TaskStore.getTasks();
    const metrics = getMarketingAutomationMetrics(tasks);
    return TaskManager.buildMarketingAutomationView(marketingAutomationState, {
        ...metrics,
        processedTasks: marketingAutomationState.processedTasks || 0
    });
}

async function broadcastMarketingAutomationState() {
    const state = await getMarketingAutomationStateView();
    broadcastToPopup({ action: 'marketingStateUpdate', state });
}

async function ensureCollectTab() {
    if (collectTabId) {
        try {
            await chrome.tabs.get(collectTabId);
            return collectTabId;
        } catch {
            collectTabId = null;
        }
    }

    const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    collectTabId = tab.id;
    return collectTabId;
}

async function openOrReuseMarketingTab(url, options = {}) {
    const { active = false, waitForLoad = true } = options;
    const targetUrl = normalizeHttpUrlBg(url || '') || 'about:blank';

    if (marketingExecutionTabId) {
        try {
            await chrome.tabs.get(marketingExecutionTabId);
            await chrome.tabs.update(marketingExecutionTabId, { url: targetUrl, active: !!active });
            if (waitForLoad) {
                await waitForTabLoad(marketingExecutionTabId);
            }
            return await chrome.tabs.get(marketingExecutionTabId);
        } catch {
            marketingExecutionTabId = null;
        }
    }

    const tab = await chrome.tabs.create({ url: targetUrl, active: !!active });
    marketingExecutionTabId = tab.id;
    if (waitForLoad) {
        await waitForTabLoad(tab.id);
        return await chrome.tabs.get(tab.id);
    }
    return tab;
}

function getContinuousSeedDomain() {
    return getDomainBg(continuousDiscoveryState.seedDomain || '');
}

function getContinuousMyDomain() {
    return getDomainBg(continuousDiscoveryState.myDomain || '');
}

async function handleCommentSubmittingMessage(msg = {}, sender = {}) {
    await ensurePublishSessionsLoaded();
    const taskId = msg.taskId || findPublishSessionTaskIdByCurrentTab(sender.tab?.id) || '';
    if (!taskId) return;

    clearPublishWatchdog(taskId);
    const session = getPublishSessionState(taskId);
    setPublishSessionState(taskId, {
        ...session,
        pendingSubmission: {
            resourceId: msg.resourceId,
            taskId,
            tabId: sender.tab?.id || session.currentTabId || null,
            meta: msg.meta || {},
            createdAt: Date.now()
        }
    });
    schedulePublishWatchdog(taskId, {
        stage: 'submission',
        resourceId: msg.resourceId,
        currentUrl: session.currentUrl
    });
}

async function handleCommentProgressMessage(msg = {}, sender = {}) {
    await ensurePublishSessionsLoaded();
    const taskId = msg.taskId || findPublishSessionTaskIdByCurrentTab(sender.tab?.id) || '';
    if (!taskId) return;

    const session = getPublishSessionState(taskId);
    const activeResourceId = session.queue?.[session.currentIndex]?.id || '';
    if (!session.isPublishing || session.awaitingManualContinue) return;
    if (msg.resourceId && activeResourceId && msg.resourceId !== activeResourceId) return;

    const nextStage = compactText(msg.stage || '');
    const nextStageLabel = compactText(msg.stageLabel || '');
    const nextStageAt = new Date().toISOString();

    updatePublishSessionState(taskId, {
        currentStage: nextStage,
        currentStageLabel: nextStageLabel,
        currentStageAt: nextStageAt
    });

    const timeoutMs = Number(msg.stageTimeoutMs || 0)
        || PUBLISH_STAGE_WATCHDOG_MS[nextStage]
        || PUBLISH_WATCHDOG.DISPATCH_MS;

    clearPublishWatchdog(taskId);
    schedulePublishWatchdog(taskId, {
        stage: 'dispatch',
        resourceId: msg.resourceId || activeResourceId,
        currentUrl: session.currentUrl,
        timeoutMs
    });

    const nextState = getPublishSessionState(taskId);
    broadcastToPopup({
        action: 'publishProgress',
        currentUrl: nextState.currentUrl,
        current: nextState.currentIndex + 1,
        total: nextState.queue?.length || 0,
        taskId,
        isPublishing: !!nextState.isPublishing,
        awaitingManualContinue: !!nextState.awaitingManualContinue,
        currentLimitCount: Number(nextState.currentLimitCount || 0),
        targetLimitCount: Number(nextState.targetLimitCount || 0),
        limitType: nextState.limitType || '',
        sessionPublishedCount: Number(nextState.sessionPublishedCount || 0),
        sessionAnchorSuccessCount: Number(nextState.sessionAnchorSuccessCount || 0),
        currentStage: nextState.currentStage || '',
        currentStageLabel: nextState.currentStageLabel || '',
        currentStageAt: nextState.currentStageAt || ''
    });
}

// === 消息处理 ===
const runtimeMessageRouter = RuntimeMessageRouter.create({
    fireAndForget: {
        startCollect: (msg) => startCollect(msg.domain, msg.myDomain, msg.sources),
        stopCollect: () => stopCollect(),
        stopPublish: (msg) => stopPublish(msg.taskId),
        continuePublish: (msg) => continuePublish(msg.taskId),
        openFloatingPanel: () => openPanelWindow(),
        backlinkData: (msg) => handleBacklinkData(msg.source, msg.urls, msg.items || []),
        commentAction: (msg) => handleCommentAction(msg.resourceId, msg.result, msg.taskId, msg.meta || {}),
        commentSubmitting: (msg, sender) => handleCommentSubmittingMessage(msg, sender),
        commentProgress: (msg, sender) => handleCommentProgressMessage(msg, sender),
        republish: (msg) => republishResource(msg.resourceId, msg.taskId)
    },
    asyncActions: {
        startContinuousDiscovery: (msg) => startContinuousDiscovery(msg.domain, msg.myDomain, msg.sources),
        pauseContinuousDiscovery: () => pauseContinuousDiscovery(),
        getContinuousDiscoveryState: async () => ({ state: await getContinuousDiscoveryStateView() }),
        startMarketingAutomation: (msg) => startMarketingAutomation(msg || {}),
        pauseMarketingAutomation: () => pauseMarketingAutomation(),
        getMarketingAutomationState: async () => ({ state: await getMarketingAutomationStateView() }),
        startPublish: (msg) => startPublish(msg.task),
        startPublishBatch: (msg) => startPublishBatch(msg.taskIds || []),
        stopPublishBatch: () => stopPublishBatch(),
        runMarketingTask: (msg) => runMarketingTask(msg.task, { active: true }),
        inspectMarketingReview: (msg) => inspectMarketingReview(msg.taskId, msg.url),
        getPublishState: async () => {
            await ensurePublishSessionsLoaded();
            await ensurePublishBatchStateLoaded();
            return getPublishStateView();
        },
        getPublishInsights: async () => ({ insights: await getPublishInsights() }),
        getStats: () => getPersistedCollectView(),
        getResources: async () => ({ resources: await getStoredResources() }),
        getTasks: async () => ({ tasks: await TaskStore.getTasks() }),
        getDomainIntel: async () => ({ domainIntel: await getDomainIntelView() }),
        saveTask: async (msg) => {
            await savePublishTask(msg.task);
            return { success: true };
        },
        deleteTask: async (msg) => {
            await deletePublishTask(msg.taskId);
            return { success: true };
        },
        getLogs: async () => ({ logs: await Logger.getAll() }),
        clearLogs: async () => {
            await Logger.clear();
            return { success: true };
        },
        clearAllData: async () => await clearResourceWorkspace(),
        testAiConnection: () => AIEngine.testConnection(),
        getAIUsageStats: async () => ({ success: true, stats: await AIEngine.getUsageStats() }),
        resetAIUsageStats: async () => {
            await AIEngine.resetUsageStats();
            return { success: true };
        },
        syncToSheets: () => syncToGoogleSheets(),
        resetStatus: async (msg) => {
            await resetResourcePublishState(msg.resourceId);
            return { success: true };
        },
        resetAllStatuses: () => resetAllPublishStatuses(),
        runAutoPublishScheduler: async () => runAutoPublishDispatch({ reason: 'manual-trigger' }),
        aiExtractForm: (msg) => AIEngine.extractFormStructure(msg.html),
        aiGenerateComment: async (msg) => {
            try {
                const comment = await AIEngine.generateComment(
                    msg.pageTitle,
                    msg.pageContent,
                    msg.targetUrl,
                    msg.options || {}
                );
                return { comment };
            } catch (error) {
                return { comment: '', error: error.message };
            }
        }
    },
    onError: (action, error) => {
        console.error(`消息处理失败 [${action}]`, error);
        Logger.error(`消息处理失败 [${action}]: ${error?.message || error}`, { action }).catch(() => {});
    }
});

chrome.runtime.onMessage.addListener(runtimeMessageRouter);

// ============================================================
// 收集流程 — 单 Tab 复用 + 递归发现
// ============================================================

async function startCollect(domain, myDomain, sources) {
    await CollectorRuntime.runSeedCollection({
        logger: Logger,
        delay,
        waitForTabLoad,
        mergeBacklinks,
        buildAnalysisTargets,
        fetchAnalyzeAll,
        recursiveDiscovery,
        recordDomainIntel,
        broadcastStats,
        broadcastContinuousDiscoveryState,
        broadcastCollectDone: () => broadcastToPopup({ action: 'collectDone' }),
        getDomain: (value) => getDomainBg(value || ''),
        getCollectState: () => collectState,
        setCollectState: (nextState) => { collectState = nextState; },
        resetCollectWaveStats: (mergedCount) => {
            collectState.stats.backlinksFound = mergedCount;
            collectState.stats.targetsFound = mergedCount;
            collectState.stats.analyzed = 0;
            collectState.stats.inQueue = 0;
        },
        setCollectWaveTargets: (count) => {
            collectState.stats.targetsFound = count;
            collectState.stats.inQueue = count;
        },
        seedFrontier: async (seededDomains) => {
            await ensureDomainIntelLoaded();
            const seedEntry = seededDomains[0] ? ensureDomainFrontierEntry(seededDomains[0]) : null;
            if (seedEntry) {
                seedEntry.crawlStatus = 'completed';
                seedEntry.status = mergeDomainStatus(seedEntry.status, 'expanded');
            }
            if (seededDomains[1]) {
                const myEntry = ensureDomainFrontierEntry(seededDomains[1]);
                myEntry.crawlStatus = 'completed';
                myEntry.status = mergeDomainStatus(myEntry.status, 'profiled');
            }
            await flushDomainIntel();
        },
        persistCollectSnapshot: async (snapshot) => {
            await StateStore.saveCollectSnapshot(snapshot);
        },
        openCollectTab: async () => {
            const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
            collectTabId = tab.id;
            return collectTabId;
        },
        closeCollectTab: async () => {
            if (!collectTabId) return;
            try { await chrome.tabs.remove(collectTabId); } catch {}
            collectTabId = null;
        },
        finishCollecting: () => {
            collectState.isCollecting = false;
        },
        updateTab: async (tabId, url) => {
            await chrome.tabs.update(tabId, { url });
        },
        executeCollector: async (tabId, collectorFile) => {
            await chrome.scripting.executeScript({
                target: { tabId },
                files: [`content/${collectorFile}`]
            });
        },
        triggerMyDomainCollect: async (tabId) => {
            try {
                await chrome.tabs.sendMessage(tabId, { action: 'collectAsMyDomain' });
            } catch {}
        },
        setSourceDone: (source, value) => {
            collectState[`${source}_done`] = value;
        },
        isSourceDone: (source) => !!collectState[`${source}_done`],
        setSourceRequest: (value) => {
            collectState.sourceRequest = value;
        },
        getSourceRequest: () => collectState.sourceRequest
    }, domain, myDomain, sources);
}

async function navigateAndCollect(tabId, url, source) {
    return await CollectorRuntime.navigateAndCollect({
        logger: Logger,
        delay,
        waitForTabLoad,
        updateTab: async (targetTabId, targetUrl) => {
            await chrome.tabs.update(targetTabId, { url: targetUrl });
        },
        executeCollector: async (targetTabId, collectorFile) => {
            await chrome.scripting.executeScript({
                target: { tabId: targetTabId },
                files: [`content/${collectorFile}`]
            });
        },
        triggerMyDomainCollect: async (targetTabId) => {
            try {
                await chrome.tabs.sendMessage(targetTabId, { action: 'collectAsMyDomain' });
            } catch {}
        },
        setSourceDone: (targetSource, value) => {
            collectState[`${targetSource}_done`] = value;
        },
        isSourceDone: (targetSource) => !!collectState[`${targetSource}_done`],
        setSourceRequest: (value) => {
            collectState.sourceRequest = value;
        },
        getSourceRequest: () => collectState.sourceRequest
    }, tabId, url, source);
}

function getSourceUrl(source, domain) {
    return CollectorRuntime.getSourceUrl(source, domain);
}

function handleBacklinkData(source, urls, items = []) {
    const normalizedItems = normalizeCollectedItems(items, urls, source);
    const baseSource = String(source || '').replace(/^my-/, '');
    if (collectState.sourceRequest && collectState.sourceRequest.source === source) {
        collectState.sourceRequest.result = normalizedItems;
    }
    if (source.startsWith('my-')) {
        collectState.myBacklinks = mergeUrlList(
            collectState.myBacklinks,
            normalizedItems.map((item) => item.url)
        );
    } else {
        collectState.backlinks[baseSource] = mergeCollectedItemList(
            collectState.backlinks[baseSource] || [],
            normalizedItems
        );
    }
    const mergedCount = mergeBacklinks().length;
    collectState.stats.backlinksFound = mergedCount;
    if (collectState.discoveryDepth === 0) {
        collectState.stats.targetsFound = mergedCount;
    }
    collectState[`${source}_done`] = true;
    broadcastStats();
}

// ============================================================
// 持续发现：Domain Frontier + Domain Profile
// ============================================================

async function ensureDomainIntelLoaded() {
    if (domainIntelLoaded) return;
    domainIntelCache = await StateStore.loadDomainIntel();
    domainIntelLoaded = true;
}

async function flushDomainIntel() {
    if (!domainIntelLoaded) return;
    await StateStore.saveDomainIntel(domainIntelCache.frontier, domainIntelCache.profiles);
}

function createDomainFrontierEntry(domain) {
    return FrontierScheduler.createEntry(domain);
}

function mergeDomainStatus(current = 'discovered', next = 'discovered') {
    return FrontierScheduler.mergeStatus(current, next);
}

function ensureDomainFrontierEntry(domain) {
    let entry = domainIntelCache.frontier.find((item) => item.domain === domain);
    if (!entry) {
        entry = createDomainFrontierEntry(domain);
        domainIntelCache.frontier.push(entry);
    }
    return entry;
}

function shouldQueueDomainForRecursiveCollection(context = {}) {
    return FrontierScheduler.shouldQueueForRecursiveCollection(context);
}

function getContextRecursiveDepth(context = {}) {
    if (Number.isFinite(context.recursiveDepth)) return Number(context.recursiveDepth);
    return Number(collectState.discoveryDepth || 0);
}

function markEntryCrawlPending(entry, context = {}) {
    FrontierScheduler.markEntryCrawlPending(entry, {
        ...context,
        recursiveDepth: getContextRecursiveDepth(context)
    }, {
        seedDomain: getContinuousSeedDomain() || getDomainBg(collectState.domain || ''),
        myDomain: getContinuousMyDomain() || getDomainBg(collectState.myDomain || '')
    });
}

async function markDomainCrawlState(domain, patch = {}) {
    if (!domain) return;
    await ensureDomainIntelLoaded();
    const entry = ensureDomainFrontierEntry(domain);
    Object.assign(entry, patch);
    recalculateDomainIntelScores();
    await flushDomainIntel();
}

function getNextPendingFrontierDomain() {
    return FrontierScheduler.getNextPendingEntry(domainIntelCache.frontier, {
        seedDomain: getContinuousSeedDomain() || getDomainBg(collectState.domain || ''),
        myDomain: getContinuousMyDomain() || getDomainBg(collectState.myDomain || '')
    });
}

// Domain profiling helpers moved to utils/domain-profile.js

async function recordDomainIntel(items = [], context = {}) {
    if (!items.length) return;
    await ensureDomainIntelLoaded();
    const now = new Date().toISOString();

    for (const item of items) {
        const domain = getDomainBg(item.domain || item.url || item);
        if (!domain) continue;

        const entry = ensureDomainFrontierEntry(domain);
        entry.lastSeenAt = now;
        entry.seenCount = (entry.seenCount || 0) + 1;
        entry.status = mergeDomainStatus(entry.status, context.status || 'discovered');
        entry.sources = mergeStringArrays(entry.sources, item.sources || context.sources || [], 8);
        entry.sourceTypes = mergeStringArrays(entry.sourceTypes, item.sourceTypes || (item.sourceType ? [item.sourceType] : []) || [], 4);
        entry.sourceTiers = mergeSourceTierArrays(entry.sourceTiers || [], [
            item.sourceTier || '',
            ...(item.sourceTiers || []),
            context.sourceTier || ''
        ]);
        entry.sourceTier = preferHigherSourceTier(
            entry.sourceTier || '',
            item.sourceTier || context.sourceTier || ''
        );
        entry.discoveryMethods = mergeStringArrays(entry.discoveryMethods, [context.discoveryMethod || 'collector'], 6);
        entry.discoveryEdges = mergeDiscoveryEdges(entry.discoveryEdges || [], item.discoveryEdges || []);
        entry.seedTargets = mergeStringArrays(entry.seedTargets, [context.seedTarget || collectState.domain || ''], 6);
        entry.discoveredFromUrls = mergeStringArrays(entry.discoveredFromUrls, [context.discoveredFromUrl || ''], 6);
        entry.sampleUrls = mergeStringArrays(entry.sampleUrls, [item.url || ''], 6);
        if (item.sourceType === 'ref-domain' || entry.sourceTypes.includes('ref-domain')) {
            entry.domainSeedCount = (entry.domainSeedCount || 0) + 1;
        }
        if (item.sourceType === 'backlink-page' || entry.sourceTypes.includes('backlink-page')) {
            entry.pageSeedCount = (entry.pageSeedCount || 0) + 1;
        }
        if (context.commentMention) {
            entry.commentMentions = (entry.commentMentions || 0) + 1;
        }
        if (shouldQueueDomainForRecursiveCollection(context)) {
            markEntryCrawlPending(entry, context);
        }
    }

    recalculateDomainIntelScores();
    await flushDomainIntel();
}

async function recordDomainPublishEvidence(url, status, publishMeta = {}) {
    const domain = getDomainBg(url);
    if (!domain) return;

    await ensureDomainIntelLoaded();
    const entry = ensureDomainFrontierEntry(domain);
    entry.sourceTiers = mergeSourceTierArrays(entry.sourceTiers || [], [
        status === 'published' ? SOURCE_TIERS.HISTORICAL_SUCCESS : ''
    ]);
    entry.sourceTier = preferHigherSourceTier(entry.sourceTier || '', status === 'published' ? SOURCE_TIERS.HISTORICAL_SUCCESS : '');

    if (status === 'published') {
        entry.lastPublishedAt = publishMeta.updatedAt || new Date().toISOString();
        entry.publishSuccessCount = Number(entry.publishSuccessCount || 0) + 1;
        if (publishMeta.anchorVisible) {
            entry.verifiedAnchorCount = Number(entry.verifiedAnchorCount || 0) + 1;
        }
        entry.discoveryEdges = mergeDiscoveryEdges(entry.discoveryEdges || [], [
            buildDiscoveryEdge(SOURCE_TIERS.HISTORICAL_SUCCESS, 'publish-success', url)
        ]);
    }

    if (publishMeta.submissionBlocked) {
        entry.blockedPublishCount = Number(entry.blockedPublishCount || 0) + 1;
    }

    recalculateDomainIntelScores();
    await flushDomainIntel();
}

async function recordDomainDrilldown(seed, finalUrl, html, pages = []) {
    const domain = seed?.domain || getDomainBg(seed?.url || finalUrl);
    if (!domain) return;

    await ensureDomainIntelLoaded();
    const entry = ensureDomainFrontierEntry(domain);
    const profile = buildDomainProfileFromHtml(finalUrl, html, {
        sampleUrls: pages
    });
    const existingProfile = domainIntelCache.profiles[domain] || {};

    domainIntelCache.profiles[domain] = {
        ...existingProfile,
        ...profile,
        trafficLabel: existingProfile.trafficLabel || profile.trafficLabel || '',
        pageSamples: mergeStringArrays(existingProfile.pageSamples || [], pages, 8)
    };

    entry.status = mergeDomainStatus(entry.status, pages.length > 0 ? 'expanded' : 'profiled');
    entry.lastExpandedAt = new Date().toISOString();
    entry.profileUpdatedAt = new Date().toISOString();
    entry.drilldownPages = Math.max(entry.drilldownPages || 0, pages.length);
    entry.sampleUrls = mergeStringArrays(entry.sampleUrls, [finalUrl, ...pages], 8);
    entry.discoveryMethods = mergeStringArrays(entry.discoveryMethods, ['domain-drilldown'], 6);

    recalculateDomainIntelScores();
    await flushDomainIntel();
}

async function enrichDomainProfileFromPage(url, html, ruleResult = null) {
    const domain = getDomainBg(url);
    if (!domain) return;

    await ensureDomainIntelLoaded();
    const entry = ensureDomainFrontierEntry(domain);
    const existingProfile = domainIntelCache.profiles[domain] || {};
    const profilePatch = buildDomainProfileFromHtml(url, html, {
        sampleUrls: [url],
        trafficLabel: existingProfile.trafficLabel || ''
    });

    const nextProfile = {
        ...existingProfile,
        ...profilePatch,
        pageSamples: mergeStringArrays(existingProfile.pageSamples || [], [url], 8)
    };
    if (ruleResult?.opportunities?.includes('comment')) {
        nextProfile.commentCapable = true;
        entry.commentOpportunityCount = (entry.commentOpportunityCount || 0) + 1;
    }

    domainIntelCache.profiles[domain] = nextProfile;
    entry.profileUpdatedAt = new Date().toISOString();
    entry.status = mergeDomainStatus(entry.status, 'profiled');
    entry.sampleUrls = mergeStringArrays(entry.sampleUrls, [url], 8);

    recalculateDomainIntelScores();
    await flushDomainIntel();
}

function recalculateDomainIntelScores() {
    for (const entry of domainIntelCache.frontier) {
        const profile = domainIntelCache.profiles[entry.domain] || {};
        entry.qualityScore = calculateDomainQualityScore(entry, profile);
    }
}

async function getDomainIntelView() {
    await ensureDomainIntelLoaded();
    const items = [...domainIntelCache.frontier]
        .map((entry) => ({
            ...entry,
            profile: domainIntelCache.profiles[entry.domain] || {}
        }))
        .sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0) || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));

    const stats = {
        total: items.length,
        profiled: items.filter((item) => item.profile?.profiledAt).length,
        expanded: items.filter((item) => item.status === 'expanded').length,
        commentDiscovered: items.filter((item) => (item.commentMentions || 0) > 0).length
    };

    return { items, stats };
}

async function startContinuousDiscovery(domain, myDomain, sources = []) {
    await ensureContinuousDiscoveryLoaded();

    if (continuousDiscoveryState.isRunning && !continuousDiscoveryState.isPaused) {
        return { success: false, message: '持续发现已在运行中。' };
    }

    const normalizedDomain = getDomainBg(domain || '');
    const normalizedMyDomain = getDomainBg(myDomain || '');
    const normalizedSources = Array.from(new Set((sources || []).filter(Boolean)));

    if (!normalizedDomain) {
        return { success: false, message: '请输入目标域名。' };
    }
    if (normalizedSources.length === 0) {
        return { success: false, message: '请至少选择一个数据源。' };
    }

    const seedChanged =
        getDomainBg(continuousDiscoveryState.seedDomain || '') !== normalizedDomain ||
        getDomainBg(continuousDiscoveryState.myDomain || '') !== normalizedMyDomain ||
        JSON.stringify(continuousDiscoveryState.sources || []) !== JSON.stringify(normalizedSources);

    await ensureDomainIntelLoaded();
    const pendingFrontierDomains = domainIntelCache.frontier.filter((entry) => {
        if (!entry?.domain) return false;
        if (entry.domain === normalizedDomain || entry.domain === normalizedMyDomain) return false;
        return (entry.crawlStatus || 'pending') === 'pending';
    }).length;

    if (seedChanged) {
        const seedEntry = ensureDomainFrontierEntry(normalizedDomain);
        seedEntry.crawlStatus = 'completed';
        const myEntry = normalizedMyDomain ? ensureDomainFrontierEntry(normalizedMyDomain) : null;
        if (myEntry) myEntry.crawlStatus = 'completed';
        await flushDomainIntel();
    }

    await updateContinuousDiscoveryState(TaskManager.buildStartContinuousDiscoveryPatch(continuousDiscoveryState, {
        normalizedDomain,
        normalizedMyDomain,
        normalizedSources,
        seedChanged,
        pendingFrontierDomains
    }));

    ensureContinuousDiscoveryLoop();
    return { success: true };
}

async function pauseContinuousDiscovery() {
    await ensureContinuousDiscoveryLoaded();
    await updateContinuousDiscoveryState(TaskManager.buildPauseContinuousDiscoveryPatch(continuousDiscoveryState));
    collectState.isCollecting = false;
    await StateStore.saveCollectSnapshot({
        collectState: {
            isCollecting: false,
            domain: getContinuousSeedDomain(),
            myDomain: getContinuousMyDomain(),
            sources: collectState.sources || []
        },
        collectStats: collectState.stats
    });
    return { success: true };
}

function ensureContinuousDiscoveryLoop() {
    if (continuousDiscoveryLoopRunning) return;
    continuousDiscoveryLoopRunning = true;
    runContinuousDiscoveryLoop()
        .catch(async (error) => {
            await Logger.error(`持续发现流程异常: ${error.message}`);
            await updateContinuousDiscoveryState({
                isRunning: false,
                currentDomain: '',
                lastMessage: `持续发现异常中止: ${error.message}`
            });
        })
        .finally(() => {
            continuousDiscoveryLoopRunning = false;
        });
}

function prepareContinuousCollectContext() {
    collectState.isCollecting = true;
    collectState.domain = getContinuousSeedDomain() || collectState.domain || '';
    collectState.myDomain = getContinuousMyDomain() || collectState.myDomain || '';
    collectState.sources = [...(continuousDiscoveryState.sources || collectState.sources || [])];
    collectState.sourceRequest = null;
}

async function runContinuousDiscoveryLoop() {
    const runtimeContext = {
        ensureContinuousDiscoveryLoaded,
        ensureDomainIntelLoaded,
        ensureCollectTab,
        startCollect,
        buildAnalysisTargets,
        fetchAnalyzeAll,
        collectRecursiveDomainBacklinks,
        markDomainCrawlState,
        mergeDomainStatus,
        getNextPendingFrontierDomain,
        getContinuousDiscoveryStateView,
        updateContinuousDiscoveryState,
        getContinuousState: () => continuousDiscoveryState,
        getContinuousSeedDomain,
        getContinuousMyDomain,
        getContinuousSources: () => continuousDiscoveryState.sources || [],
        getDomainEntry: (domain) => domainIntelCache.frontier.find((item) => item.domain === domain) || null,
        isContinuousRunning: () => continuousDiscoveryState.isRunning && !continuousDiscoveryState.isPaused,
        prepareCollectContext: prepareContinuousCollectContext,
        incrementQueuedTargets: (count) => {
            collectState.stats.targetsFound += count;
            collectState.stats.inQueue += count;
        },
        broadcastStats,
        persistCollectRunning: async (isCollecting) => {
            collectState.isCollecting = isCollecting;
            await StateStore.saveCollectSnapshot({
                collectState: {
                    isCollecting,
                    domain: getContinuousSeedDomain(),
                    myDomain: getContinuousMyDomain(),
                    sources: collectState.sources || []
                },
                collectStats: collectState.stats
            });
        },
        closeCollectTab: async () => {
            if (!collectTabId) return;
            try { await chrome.tabs.remove(collectTabId); } catch {}
            collectTabId = null;
        },
        broadcastCollectDone: () => broadcastToPopup({ action: 'collectDone' }),
        logger: Logger,
        taskManager: TaskManager
    };

    await ensureContinuousDiscoveryLoaded();
    if (continuousDiscoveryState.isPaused || !continuousDiscoveryState.isRunning) return;

    const task = DiscoverWorkflow.buildTask(continuousDiscoveryState);
    await TaskRunner.run(task, {
        shouldStop: () => continuousDiscoveryState.isPaused || !continuousDiscoveryState.isRunning,
        handlers: {
            seed_collect: async () => await ContinuousDiscoveryEngine.runSeedInitialization(runtimeContext),
            frontier_collect: async () => await ContinuousDiscoveryEngine.runFrontierCollection(runtimeContext)
        },
        onStepStart: async (step, index, total, currentTask) => {
            await updateContinuousDiscoveryState(
                TaskManager.buildContinuousStepPatch(continuousDiscoveryState, currentTask, step, index, total)
            );
        }
    });
}

function formatMarketingRefreshAt(refreshAt = '') {
    const time = new Date(refreshAt).getTime();
    if (!Number.isFinite(time) || time <= 0) return '';
    return new Date(time).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

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

async function pauseMarketingAutomation() {
    await ensureMarketingAutomationLoaded();
    await updateMarketingAutomationState(TaskManager.buildPauseMarketingAutomationPatch(marketingAutomationState));
    return { success: true };
}

function ensureMarketingAutomationLoop() {
    if (marketingAutomationLoopRunning) return;
    marketingAutomationLoopRunning = true;
    runMarketingAutomationLoop()
        .catch(async (error) => {
            await Logger.error(`持续宣传流程异常: ${error.message}`);
            await updateMarketingAutomationState({
                isRunning: false,
                isPaused: true,
                phase: 'failed',
                phaseLabel: '异常中止',
                currentTaskId: '',
                currentTaskName: '',
                currentTaskType: '',
                lastCompletedAt: new Date().toISOString(),
                lastMessage: `持续宣传异常中止: ${error.message}`
            });
        })
        .finally(() => {
            marketingAutomationLoopRunning = false;
        });
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

function hasActiveResourceWorkspaceJob() {
    const hasActivePublish = Object.values(publishSessions || {}).some((session) =>
        session.isPublishing || session.awaitingManualContinue || session.pendingSubmission
    );
    const discoveryRunning = !!collectState.isCollecting || (!!continuousDiscoveryState.isRunning && !continuousDiscoveryState.isPaused);
    return hasActivePublish || isPublishBatchRunning() || discoveryRunning;
}

async function clearResourceWorkspace() {
    await ensurePublishSessionsLoaded();
    await ensurePublishBatchStateLoaded();

    if (hasActiveResourceWorkspaceJob()) {
        return {
            success: false,
            error: '请先停止正在运行的持续发现或发布任务，再清空资源池。'
        };
    }

    const existingResources = await getStoredResources();
    const clearedResources = existingResources.length;
    const poolCounts = countResourcesByPool(existingResources);
    const preservedTemplates = Object.keys(await self.PublishMemory?.getSiteTemplates?.() || {}).length;
    const preservedAttempts = (await self.PublishMemory?.getPublishAttempts?.() || []).length;

    await resourceStore.clearAll();
    try {
        await chrome.storage.local.remove([
            'resources',
            'domainFrontier',
            'domainProfiles',
            'collectState',
            'collectStats',
            'publishSessions',
            'publishState',
            'publishBatchState',
            'continuousDiscoveryState'
        ]);
    } catch {}

    try {
        await LocalDB?.saveDomainIntel?.([], {});
    } catch {}
    try {
        await LocalDB?.setCollectSnapshot?.(null, null);
    } catch {}
    try {
        await LocalDB?.setPublishSessions?.({});
    } catch {}

    if (autoPublishDispatchTimer) {
        clearTimeout(autoPublishDispatchTimer);
        autoPublishDispatchTimer = null;
    }
    autoPublishDispatchRunning = false;
    if (resourceSignalNormalizationTimer) {
        clearTimeout(resourceSignalNormalizationTimer);
        resourceSignalNormalizationTimer = null;
    }
    resourceSignalNormalizationRunning = false;
    publishBatchRuntime.clearAdvanceTimer();
    collectState = {
        isCollecting: false,
        domain: '',
        myDomain: '',
        sources: [],
        backlinks: { ahrefs: [], semrush: [], similarweb: [] },
        myBacklinks: [],
        stats: { backlinksFound: 0, targetsFound: 0, analyzed: 0, blogResources: 0, inQueue: 0 },
        discoveredDomains: new Set(),
        discoveryQueue: [],
        processedDiscoveryDomains: new Set(),
        discoveryDepth: 0,
        maxDiscoveryDepth: 3,
        maxDiscoveryQueue: 500,
        maxRecursiveDomains: 50,
        recursiveDomainsProcessed: 0,
        sourceRequest: null
    };
    syncResourceOpportunityStats([]);
    publishSessions = createDefaultPublishSessions();
    publishSessionsLoaded = true;
    await flushPublishSessions();
    await publishBatchRuntime.reset({ loaded: true });
    domainIntelCache = { frontier: [], profiles: {} };
    domainIntelLoaded = false;
    continuousDiscoveryState = createDefaultContinuousDiscoveryState();
    continuousDiscoveryLoaded = false;
    continuousDiscoveryLoopRunning = false;
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

    broadcastStats();
    broadcastContinuousState();
    await Logger.publish('已清空资源池，模板记忆、发布经验、任务配置与设置已保留', {
        clearedResources,
        poolCounts,
        preservedTemplates,
        preservedAttempts
    });

    return {
        success: true,
        clearedResources,
        poolCounts,
        preservedTemplates,
        preservedAttempts
    };
}

// ============================================================
// 三源合并 + Link Gap
// ============================================================

function mergeBacklinks(backlinksBySource = collectState.backlinks, options = {}) {
    const urlMap = new Map();
    const excludedDomains = new Set(
        (options.excludedDomains || [collectState.domain, collectState.myDomain])
            .map((value) => getDomainBg(value || ''))
            .filter(Boolean)
    );

    for (const [source, items] of Object.entries(backlinksBySource || {})) {
        if (!items) continue;
        const key = getSourceCode(source);

        for (const item of items) {
            const url = item.url;
            const norm = normalizeUrlBg(url);
            if (!norm || norm === '/') continue;
            const itemDomain = getDomainBg(url);
            if (excludedDomains.has(itemDomain)) continue;

            if (urlMap.has(norm)) {
                const entry = urlMap.get(norm);
                if (!entry.sources.includes(key)) entry.sources.push(key);
                if (!entry.sourceTypes.includes(item.sourceType)) entry.sourceTypes.push(item.sourceType);
                entry.sourceTiers = mergeSourceTierArrays(entry.sourceTiers, [item.sourceTier]);
                entry.sourceTier = preferHigherSourceTier(entry.sourceTier, item.sourceTier);
                entry.discoveryEdges = mergeDiscoveryEdges(entry.discoveryEdges, item.discoveryEdges || []);
                entry.candidateType = resolveCandidateType(entry.sourceTypes);
            } else {
                urlMap.set(norm, {
                    url,
                    normalizedUrl: norm,
                    sources: [key],
                    sourceTypes: [item.sourceType],
                    sourceTier: normalizeSourceTier(item.sourceTier) || SOURCE_TIERS.COMPETITOR_BACKLINK,
                    sourceTiers: mergeSourceTierArrays([], [item.sourceTier || SOURCE_TIERS.COMPETITOR_BACKLINK]),
                    discoveryEdges: mergeDiscoveryEdges([], item.discoveryEdges || []),
                    candidateType: resolveCandidateType([item.sourceType]),
                    domain: getDomainBg(url)
                });
            }
        }
    }

    let merged = Array.from(urlMap.values());

    // Link Gap
    const myBacklinks = options.myBacklinks || collectState.myBacklinks || [];
    if (myBacklinks.length > 0) {
        const myDomains = new Set(myBacklinks.map(u => getDomainBg(u)).filter(Boolean));
        merged = merged.filter(link => !myDomains.has(link.domain));
    }

    merged.sort((a, b) => getAnalysisSeedScore(b) - getAnalysisSeedScore(a));
    return merged;
}

// ============================================================
// Fetch 批量分析
// ============================================================

async function buildAnalysisTargets(links) {
    const directPages = [];
    const domainSeeds = [];
    const seenTargets = new Set();

    for (const link of [...links].sort((a, b) => getAnalysisSeedScore(b) - getAnalysisSeedScore(a))) {
        const normalized = normalizeUrlBg(link.url);
        if (!normalized || seenTargets.has(normalized)) continue;

        if (link.candidateType === 'backlink-page' || link.candidateType === 'hybrid') {
            if (directPages.length >= ANALYSIS_STRATEGY.DIRECT_PAGE_LIMIT) continue;
            directPages.push({
                ...link,
                analysisStage: 'direct-page'
            });
            seenTargets.add(normalized);
            continue;
        }

        if (link.candidateType === 'ref-domain' && domainSeeds.length < ANALYSIS_STRATEGY.DOMAIN_SEED_LIMIT) {
            domainSeeds.push(link);
        }
    }

    const drilledPages = await expandDomainSeeds(domainSeeds, seenTargets);
    const combined = [...directPages, ...drilledPages]
        .sort((a, b) => getAnalysisTargetScore(b) - getAnalysisTargetScore(a))
        .slice(0, ANALYSIS_STRATEGY.MAX_ANALYSIS_TARGETS);

    return combined;
}

async function expandDomainSeeds(domainSeeds, seenTargets = new Set()) {
    const queue = [...domainSeeds];
    const results = [];
    let cursor = 0;

    async function worker() {
        while (collectState.isCollecting) {
            const currentIndex = cursor++;
            if (currentIndex >= queue.length) break;
            if (results.length >= ANALYSIS_STRATEGY.MAX_ANALYSIS_TARGETS) break;

            const seed = queue[currentIndex];
            const pages = await discoverCandidatePagesFromDomain(seed);
            for (const page of pages) {
                const normalized = normalizeUrlBg(page.url);
                if (!normalized || seenTargets.has(normalized)) continue;
                seenTargets.add(normalized);
                results.push(page);
                if (results.length >= ANALYSIS_STRATEGY.MAX_ANALYSIS_TARGETS) break;
            }
        }
    }

    const workers = [];
    for (let i = 0; i < ANALYSIS_STRATEGY.DOMAIN_DRILLDOWN_CONCURRENCY; i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return results;
}

async function discoverCandidatePagesFromDomain(seed) {
    const homepageUrl = seed.url.startsWith('http') ? seed.url : `https://${seed.url}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ANALYSIS_STRATEGY.DOMAIN_FETCH_TIMEOUT);

    try {
        const response = await fetch(homepageUrl, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
        });
        clearTimeout(timeout);

        if (!response.ok) return [];
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/html')) return [];

        const finalUrl = response.url || homepageUrl;
        const html = await response.text();
        const pages = extractDomainCandidatePages(html, finalUrl, seed.domain || getDomainBg(finalUrl));
        await recordDomainDrilldown(seed, finalUrl, html, pages);
        if (pages.length === 0) {
            return [createDrilldownTarget(finalUrl, seed, false)];
        }

        return pages.map((url) => createDrilldownTarget(url, seed, true));
    } catch {
        clearTimeout(timeout);
        return [];
    }
}

function extractDomainCandidatePages(html, baseUrl, expectedDomain) {
    const candidates = new Map();
    const anchorRegex = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    let scanned = 0;

    while ((match = anchorRegex.exec(html)) !== null && scanned < ANALYSIS_STRATEGY.MAX_DRILLDOWN_LINKS_TO_PARSE) {
        scanned++;
        const href = match[1];
        const anchorHtml = match[2] || '';
        const anchorText = compactText(anchorHtml.replace(/<[^>]+>/g, ' '));
        const resolvedUrl = resolveDomainCandidateUrl(href, baseUrl, expectedDomain);
        if (!resolvedUrl) continue;

        const score = scoreDomainCandidateUrl(resolvedUrl, anchorText);
        if (score <= 0) continue;

        const normalized = normalizeUrlBg(resolvedUrl);
        const current = candidates.get(normalized);
        if (!current || score > current.score) {
            candidates.set(normalized, { url: resolvedUrl, score });
        }
    }

    return Array.from(candidates.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, ANALYSIS_STRATEGY.MAX_DRILLDOWN_PAGES_PER_DOMAIN)
        .map((item) => item.url);
}

function resolveDomainCandidateUrl(href, baseUrl, expectedDomain) {
    const raw = String(href || '').trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('tel:')) {
        return '';
    }

    try {
        const resolved = new URL(raw, baseUrl);
        if (!/^https?:$/i.test(resolved.protocol)) return '';
        const hostname = resolved.hostname.replace(/^www\./, '').toLowerCase();
        if (!hostname || hostname !== String(expectedDomain || '').replace(/^www\./, '').toLowerCase()) return '';
        if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|rar|mp4|mp3|xml|json)$/i.test(resolved.pathname)) return '';
        return resolved.href;
    } catch {
        return '';
    }
}

function scoreDomainCandidateUrl(url, anchorText = '') {
    try {
        const parsed = new URL(url);
        const path = (parsed.pathname || '/').toLowerCase();
        const full = `${path} ${anchorText.toLowerCase()}`;

        if (path === '/' || path === '') return 5;
        if (/\/(?:tag|tags|category|categories|author|authors|privacy|terms|contact|about|login|register|account|feed|search)\b/.test(path)) return -40;
        if (/\/page\/\d+/.test(path)) return -20;

        let score = 0;
        if (/comment|reply|discussion|forum|thread|topic/.test(full)) score += 80;
        if (/blog|news|article|post|story|journal|insight|guide|tutorial/.test(full)) score += 55;
        if (/\/20\d{2}\/\d{1,2}\//.test(path)) score += 45;
        if (/-/.test(path) && path.length > 24) score += 20;
        if ((path.match(/\//g) || []).length >= 2) score += 10;
        if (anchorText.length > 18) score += 8;
        return score;
    } catch {
        return 0;
    }
}

function createDrilldownTarget(url, seed, drilled = true) {
    const sourceTypes = Array.from(new Set([...(seed.sourceTypes || []), 'backlink-page']));
    const sourceTier = drilled ? SOURCE_TIERS.RULE_GUESS : (seed.sourceTier || SOURCE_TIERS.COMPETITOR_BACKLINK);
    return {
        url,
        normalizedUrl: normalizeUrlBg(url),
        sources: [...(seed.sources || [])],
        sourceTypes,
        sourceTier,
        sourceTiers: mergeSourceTierArrays(seed.sourceTiers || [], [sourceTier]),
        discoveryEdges: mergeDiscoveryEdges(seed.discoveryEdges || [], [
            buildDiscoveryEdge(sourceTier, drilled ? 'domain-drilldown' : 'domain-homepage', seed.domain || getDomainBg(seed.url))
        ]),
        candidateType: resolveCandidateType(sourceTypes),
        domain: getDomainBg(url),
        analysisStage: drilled ? 'domain-drilldown' : 'domain-homepage',
        seedDomain: seed.domain || getDomainBg(seed.url)
    };
}

async function fetchAnalyzeAll(links) {
    const CONCURRENCY = 8;
    const queue = [...links];

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

            collectState.stats.analyzed++;
            collectState.stats.inQueue = Math.max(collectState.stats.inQueue - 1, 0);
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
        if (ruleResult) {
            ruleResult.candidateType = link.candidateType || resolveCandidateType(link.sourceTypes || []);
            ruleResult.sourceTypes = [...(link.sourceTypes || [])];
            ruleResult.discoverySourceTier = normalizeSourceTier(link.sourceTier || '');
            ruleResult.sourceTier = normalizeSourceTier(link.sourceTier || '');
            ruleResult.sourceTiers = mergeSourceTierArrays(link.sourceTiers || [], [ruleResult.sourceTier]);
            ruleResult.discoveryEdges = mergeDiscoveryEdges(link.discoveryEdges || [], [
                buildDiscoveryEdge(ruleResult.sourceTier || SOURCE_TIERS.RULE_GUESS, 'rule-match', link.analysisStage || link.candidateType || 'page')
            ]);
        }
        await enrichDomainProfileFromPage(url, html, ruleResult);

        // AI 结果增强
        if (aiResult && aiResult.canLeaveLink && !ruleResult) {
            const aiOpportunities = [];
            if (aiResult.hasComments || aiResult.isBlog) {
                aiOpportunities.push('comment');
            }
            if (aiResult.siteType && !aiOpportunities.includes(aiResult.siteType)) {
                aiOpportunities.push(aiResult.siteType);
            }
            if (aiOpportunities.length === 0) {
                aiOpportunities.push('comment');
            }
            return {
                url,
                pageTitle: html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.trim()?.substring(0, 100) || '',
                opportunities: aiOpportunities,
                details: ['ai-candidate', aiResult.reason || ''],
                sources: link.sources || [],
                sourceTypes: [...(link.sourceTypes || [])],
                discoverySourceTier: normalizeSourceTier(link.sourceTier || SOURCE_TIERS.AI_GUESS) || SOURCE_TIERS.AI_GUESS,
                sourceTier: preferHigherSourceTier(link.sourceTier || '', SOURCE_TIERS.AI_GUESS) || SOURCE_TIERS.AI_GUESS,
                sourceTiers: mergeSourceTierArrays(link.sourceTiers || [], [SOURCE_TIERS.AI_GUESS, link.sourceTier || '']),
                discoveryEdges: mergeDiscoveryEdges(link.discoveryEdges || [], [
                    buildDiscoveryEdge(SOURCE_TIERS.AI_GUESS, 'ai-classify', link.analysisStage || link.candidateType || 'page')
                ]),
                candidateType: link.candidateType || resolveCandidateType(link.sourceTypes || []),
                linkMethod: 'text',
                aiClassified: true
            };
        }

        // 提取评论中的其他网站（为递归发现做准备）
        if (ruleResult && ruleResult.opportunities.includes('comment')) {
            await extractCommenterDomains(html, {
                discoveredFromUrl: url,
                seedTarget: collectState.domain
            });
        }

        return ruleResult;
    } catch {
        clearTimeout(timeout);
        return null;
    }
}

function analyzeHtml(html, url, link) {
    const result = self.HtmlCommentDetection?.analyze?.(html, url, {
        resourceRules: self.ResourceRules
    });
    if (!result) return null;

    return {
        url,
        pageTitle: result.pageTitle || '',
        opportunities: result.opportunities || [],
        details: result.details || [],
        sources: link.sources || [],
        linkModes: result.linkModes || [],
        linkMethod: result.linkMethod || 'text',
        hasCaptcha: !!result.hasCaptcha,
        hasUrlField: !!result.hasUrlField,
        resourceClass: result.resourceClass || '',
        frictionLevel: result.frictionLevel || '',
        directPublishReady: !!result.directPublishReady
    };
}

// ============================================================
// 递归外链发现
// ============================================================

async function extractCommenterDomains(html, context = {}) {
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
    const newlyDiscovered = [];
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
            newlyDiscovered.push({
                url: `https://${domain}/`,
                domain,
                sourceType: 'ref-domain',
                sourceTier: SOURCE_TIERS.COMMENT_OBSERVED,
                sourceTiers: [SOURCE_TIERS.COMMENT_OBSERVED],
                discoveryEdges: [
                    buildDiscoveryEdge(
                        SOURCE_TIERS.COMMENT_OBSERVED,
                        'commenter-domain',
                        context.discoveredFromUrl || domain
                    )
                ],
                sources: ['D']
            });
            if (collectState.discoveryQueue.length < collectState.maxDiscoveryQueue) {
                collectState.discoveryQueue.push(domain);
            }
        }
    }

    if (newlyDiscovered.length > 0) {
        await recordDomainIntel(newlyDiscovered, {
            discoveryMethod: 'commenter-domain',
            seedTarget: context.seedTarget || collectState.domain,
            discoveredFromUrl: context.discoveredFromUrl || '',
            status: 'queued',
            commentMention: true
        });
    }
}

function getRecursiveCollectSources() {
    const allowlist = new Set(DISCOVERY_STRATEGY.RECURSIVE_SOURCE_ALLOWLIST);
    return (collectState.sources || []).filter((source) => allowlist.has(source));
}

async function collectRecursiveDomainBacklinks(domain) {
    const recursiveSources = getRecursiveCollectSources();
    if (recursiveSources.length === 0) {
        return [];
    }

    const collectedBySource = {};
    for (const source of recursiveSources) {
        if (!collectState.isCollecting) break;
        const url = getSourceUrl(source, domain);
        if (!url) continue;

        await Logger.collect(`递归采集网站外链: ${domain}`, { source });
        const items = await navigateAndCollect(collectTabId, url, source);
        collectedBySource[source] = items;
    }

    const merged = mergeBacklinks(collectedBySource, {
        excludedDomains: [collectState.domain, collectState.myDomain, domain],
        myBacklinks: collectState.myBacklinks
    });

    if (merged.length > 0) {
        await recordDomainIntel(merged, {
            discoveryMethod: 'recursive-collector-merge',
            seedTarget: collectState.domain,
            discoveredFromUrl: `https://${domain}/`,
            status: 'discovered'
        });
    }

    return merged;
}

async function recursiveDiscovery() {
    if (collectState.discoveryQueue.length === 0) return;
    if (collectState.discoveryDepth >= collectState.maxDiscoveryDepth) return;
    if (collectState.recursiveDomainsProcessed >= collectState.maxRecursiveDomains) return;

    const recursiveSources = getRecursiveCollectSources();
    if (recursiveSources.length === 0) {
        await Logger.collect('递归网站外链发现已跳过：当前仅支持用 SEMrush / SimilarWeb 继续自动扩展');
        return;
    }

    await Logger.collect(`递归发现: 发现 ${collectState.discoveryQueue.length} 个新域名，深度 ${collectState.discoveryDepth + 1}`);

    collectState.discoveryDepth++;
    const remainingBudget = Math.max(collectState.maxRecursiveDomains - collectState.recursiveDomainsProcessed, 0);
    const queuedUnique = [...new Set(collectState.discoveryQueue)]
        .filter((domain) => domain && !collectState.processedDiscoveryDomains.has(domain));
    const domainsToProcess = queuedUnique.slice(0, remainingBudget);
    const deferredDomains = queuedUnique.slice(domainsToProcess.length);
    collectState.discoveryQueue = deferredDomains;

    if (domainsToProcess.length === 0) return;

    const links = domainsToProcess.map((domain) => ({
        url: `https://${domain}`,
        normalizedUrl: domain,
        sources: ['D'],
        sourceTypes: ['ref-domain'],
        sourceTier: SOURCE_TIERS.COMMENT_OBSERVED,
        sourceTiers: [SOURCE_TIERS.COMMENT_OBSERVED],
        discoveryEdges: [buildDiscoveryEdge(SOURCE_TIERS.COMMENT_OBSERVED, 'recursive-discovery', domain)],
        candidateType: 'ref-domain',
        domain
    }));
    await recordDomainIntel(links, {
        discoveryMethod: 'recursive-discovery',
        seedTarget: collectState.domain,
        status: 'queued'
    });

    for (const domain of domainsToProcess) {
        if (!collectState.isCollecting) break;

        collectState.processedDiscoveryDomains.add(domain);
        collectState.recursiveDomainsProcessed++;

        const merged = await collectRecursiveDomainBacklinks(domain);
        if (merged.length === 0) {
            await Logger.collect(`递归网站外链为空: ${domain}`);
            continue;
        }

        const analysisTargets = await buildAnalysisTargets(merged);
        collectState.stats.targetsFound += analysisTargets.length;
        collectState.stats.inQueue += analysisTargets.length;
        broadcastStats();

        await Logger.collect(`递归网站分析目标准备完成: ${domain}`, {
            targets: analysisTargets.length,
            sources: recursiveSources
        });

        await fetchAnalyzeAll(analysisTargets);
    }

    if (collectState.isCollecting && collectState.discoveryQueue.length > 0) {
        await recursiveDiscovery();
    }
}

// ============================================================
// 资源保存
// ============================================================

async function getStoredResources() {
    return await resourceStore.getResources();
}

async function writeResourcesToStorage(resources = []) {
    return await resourceStore.writeResources(resources);
}

async function performStorageMaintenance() {
    try {
        await resourceStore.performMaintenance();
    } catch {}

    try {
        await migratePublishTaskCommentStyles();
    } catch {}

    scheduleResourceSignalNormalization(900);

    try {
        await ensureDomainIntelLoaded();
        await flushDomainIntel();
    } catch {}
}

async function migratePublishTaskCommentStyles() {
    await TaskStore.updateTasks((tasks) => {
        let changed = false;
        const nextTasks = tasks.map((task) => {
            if (!task || typeof task !== 'object') return task;
            const currentVersion = Number(task.commentStyleVersion || 0);
            if (currentVersion >= PUBLISH_TASK_SCHEMA_VERSION) {
                return task;
            }

            const nextTask = { ...task, commentStyleVersion: PUBLISH_TASK_SCHEMA_VERSION };
            if (task.commentStyle === 'anchor-html') {
                nextTask.commentStyle = 'anchor-prefer';
            }
            if (
                nextTask.commentStyle !== task.commentStyle
                || Number(nextTask.commentStyleVersion || 0) !== currentVersion
            ) {
                changed = true;
                return nextTask;
            }
            return task;
        });

        return changed ? nextTasks : tasks;
    });
}

function sanitizeResourceSignals(resource = {}) {
    const nextResource = {
        ...resource,
        signalVersion: RESOURCE_SIGNAL_VERSION
    };
    const details = Array.from(new Set((nextResource.details || []).filter(Boolean)));
    const historyEntries = Object.values(nextResource.publishHistory || {});
    let normalizedUrl = '';
    try {
        normalizedUrl = normalizeUrlBg(nextResource.url || '');
    } catch {}
    let parsedHost = '';
    let parsedPath = '';
    try {
        if (normalizedUrl) {
            const parsed = new URL(normalizedUrl);
            parsedHost = parsed.hostname.replace(/^www\./i, '').toLowerCase();
            parsedPath = (parsed.pathname || '/').toLowerCase();
        }
    } catch {}
    const looksLikeAmebaOwnd =
        /(shopinfo\.jp|themedia\.jp)$/i.test(parsedHost)
        || details.some((detail) => /(ameba-ownd|powered-by-ownd|powered by ownd)/i.test(String(detail || '')))
        || String(nextResource.publishMeta?.cms || '').trim() === 'ameba-ownd';
    const isCommentOnly =
        details.some((detail) => /comment-only/i.test(String(detail || '')))
        || String(nextResource.publishMeta?.terminalFailureReason || '').trim() === 'comment_only_form'
        || !!nextResource.publishMeta?.commentOnlyDetected
        || historyEntries.some((entry) => String(entry?.publishMeta?.terminalFailureReason || '').trim() === 'comment_only_form')
        || (
            looksLikeAmebaOwnd
            && /\/posts\//.test(parsedPath)
            && !historyEntries.some((entry) => entry?.lastStatus === 'published')
            && nextResource.status !== 'published'
            && !nextResource.publishMeta?.anchorVisible
        );

    if (!isCommentOnly) {
        return nextResource;
    }

    nextResource.details = Array.from(new Set([...details, 'comment-only', ...(looksLikeAmebaOwnd ? ['ameba-ownd'] : [])]));
    nextResource.linkModes = (nextResource.linkModes || []).filter((mode) => compactText(mode || '') === 'profile-link');
    nextResource.hasUrlField = false;
    nextResource.directPublishReady = false;
    if ((nextResource.resourceClass || '') !== 'profile') {
        nextResource.resourceClass = 'weak';
    }
    nextResource.frictionLevel = 'high';
    if (!(nextResource.linkModes || []).length) {
        nextResource.linkMethod = 'text';
    }
    return nextResource;
}

function finalizeResourceSignals(resource = {}) {
    let nextResource = sanitizeResourceSignals(resource);
    const recomputedClass = self.ResourceRules?.getResourceClass?.({
        ...nextResource,
        resourceClass: ''
    }) || nextResource.resourceClass || '';
    const recomputedFriction = self.ResourceRules?.getResourceFrictionLevel?.({
        ...nextResource,
        frictionLevel: ''
    }) || nextResource.frictionLevel || '';
    const recomputedDirectReady = !!self.ResourceRules?.isDirectPublishReady?.(nextResource);

    nextResource = {
        ...nextResource,
        resourceClass: recomputedClass,
        frictionLevel: recomputedFriction,
        directPublishReady: recomputedDirectReady
    };
    nextResource = sanitizeResourceSignals(nextResource);
    nextResource.sourceTier = getEffectiveResourceSourceTier(nextResource) || nextResource.discoverySourceTier || nextResource.sourceTier || '';
    nextResource.sourceTierScore = getSourceTierScore(nextResource.sourceTier);
    nextResource.sourceEvidence = summarizeSourceEvidenceFromEdges(nextResource.discoveryEdges || []);
    nextResource = applyResourcePool(nextResource);
    return nextResource;
}

function countPendingOperationalResources(resources = []) {
    return (resources || []).filter((resource) =>
        resource?.status === 'pending' && getResourcePool(resource) !== RESOURCE_POOLS.QUARANTINE
    ).length;
}

function syncResourceOpportunityStats(resources = []) {
    collectState.stats.blogResources = countPendingOperationalResources(resources);
}

function needsResourceSignalNormalization(resource = {}) {
    return Number(resource?.signalVersion || 0) !== RESOURCE_SIGNAL_VERSION;
}

function getResourceSignalSnapshot(resource = {}) {
    return JSON.stringify({
        signalVersion: Number(resource.signalVersion || 0),
        details: Array.from(new Set((resource.details || []).filter(Boolean))),
        linkModes: Array.from(new Set((resource.linkModes || []).filter(Boolean))),
        hasUrlField: !!resource.hasUrlField,
        directPublishReady: !!resource.directPublishReady,
        resourceClass: String(resource.resourceClass || ''),
        frictionLevel: String(resource.frictionLevel || ''),
        linkMethod: String(resource.linkMethod || ''),
        resourcePool: String(resource.resourcePool || ''),
        resourcePoolReason: String(resource.resourcePoolReason || '')
    });
}

async function normalizeStoredResourceSignals() {
    if (resourceSignalNormalizationRunning) return false;
    resourceSignalNormalizationRunning = true;
    const resources = await getStoredResources();
    let changed = false;
    const nextResources = [...resources];

    try {
        for (let index = 0; index < resources.length; index++) {
            const resource = resources[index];
            if (!needsResourceSignalNormalization(resource)) {
                continue;
            }

            const beforeSnapshot = getResourceSignalSnapshot(resource);
            const nextResource = finalizeResourceSignals(resource);

            const afterSnapshot = getResourceSignalSnapshot(nextResource);
            if (beforeSnapshot !== afterSnapshot) {
                nextResources[index] = nextResource;
                changed = true;
            } else if (nextResource.signalVersion !== resource.signalVersion) {
                nextResources[index] = nextResource;
                changed = true;
            }
        }

        if (changed) {
            await writeResourcesToStorage(nextResources);
            syncResourceOpportunityStats(nextResources);
            broadcastStats();
        }
        return changed;
    } finally {
        resourceSignalNormalizationRunning = false;
        resourceSignalNormalizationTimer = null;
    }
}

function scheduleResourceSignalNormalization(delayMs = 900) {
    if (resourceSignalNormalizationRunning) return;
    if (resourceSignalNormalizationTimer) {
        clearTimeout(resourceSignalNormalizationTimer);
    }
    resourceSignalNormalizationTimer = setTimeout(() => {
        normalizeStoredResourceSignals().catch(() => {});
    }, Math.max(200, Number(delayMs || 0)));
}

async function saveResource(result) {
    const resources = await getStoredResources();
    const normalized = normalizeUrlBg(result.url);
    const existingIndex = resources.findIndex((resource) => normalizeUrlBg(resource.url) === normalized);
    const incomingSourceTypes = result.sourceTypes || [];
    const incomingOpportunities = Array.from(new Set(result.opportunities || []));
    const incomingDetails = Array.from(new Set(result.details || []));
    const incomingLinkModes = Array.from(new Set(result.linkModes || []));
    const incomingSourceTiers = mergeSourceTierArrays(result.sourceTiers || [], [
        result.discoverySourceTier || '',
        result.sourceTier || ''
    ]);
    const incomingDiscoveryEdges = mergeDiscoveryEdges([], result.discoveryEdges || []);

    if (existingIndex >= 0) {
        const existing = resources[existingIndex] || {};
        const mergedSourceTypes = Array.from(new Set([...(existing.sourceTypes || []), ...incomingSourceTypes]));
        const mergedOpportunities = Array.from(new Set([...(existing.opportunities || []), ...incomingOpportunities]));
        const mergedDetails = Array.from(new Set([...(existing.details || []), ...incomingDetails]));
        const mergedLinkModes = Array.from(new Set([...(existing.linkModes || []), ...incomingLinkModes]));
        const mergedDiscoverySourceTier = preferHigherSourceTier(existing.discoverySourceTier || '', result.discoverySourceTier || result.sourceTier || '');
        const mergedSourceTiers = mergeSourceTierArrays(existing.sourceTiers || [], incomingSourceTiers);
        const mergedDiscoveryEdges = mergeDiscoveryEdges(existing.discoveryEdges || [], incomingDiscoveryEdges);

        let nextResource = {
            ...existing,
            pageTitle: result.pageTitle || existing.pageTitle || '',
            type: mergedOpportunities.join('+'),
            opportunities: mergedOpportunities,
            details: mergedDetails,
            linkModes: mergedLinkModes,
            linkMethod: resourceStore.getPreferredLinkMethod(existing.linkMethod || '', result.linkMethod || ''),
            sources: Array.from(new Set([...(existing.sources || []), ...(result.sources || [])])),
            sourceTypes: mergedSourceTypes,
            discoverySourceTier: mergedDiscoverySourceTier,
            sourceTiers: mergedSourceTiers,
            discoveryEdges: mergedDiscoveryEdges,
            candidateType: resolveCandidateType(mergedSourceTypes),
            aiClassified: !!existing.aiClassified || !!result.aiClassified,
            hasCaptcha: typeof result.hasCaptcha === 'boolean' ? result.hasCaptcha : !!existing.hasCaptcha,
            hasUrlField: typeof result.hasUrlField === 'boolean' ? result.hasUrlField : !!existing.hasUrlField,
            directPublishReady: typeof result.directPublishReady === 'boolean'
                ? result.directPublishReady
                : !!existing.directPublishReady
        };
        resources[existingIndex] = finalizeResourceSignals(nextResource);
    } else {
        let nextResource = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            url: result.url,
            pageTitle: result.pageTitle,
            type: incomingOpportunities.join('+'),
            opportunities: incomingOpportunities,
            details: incomingDetails,
            linkModes: incomingLinkModes,
            linkMethod: result.linkMethod,
            sources: result.sources,
            sourceTypes: incomingSourceTypes,
            discoverySourceTier: result.discoverySourceTier || result.sourceTier || '',
            sourceTiers: incomingSourceTiers,
            discoveryEdges: incomingDiscoveryEdges,
            candidateType: result.candidateType || resolveCandidateType(incomingSourceTypes),
            discoveredAt: new Date().toISOString(),
            status: 'pending',
            aiClassified: !!result.aiClassified,
            hasCaptcha: !!result.hasCaptcha,
            hasUrlField: !!result.hasUrlField,
            resourceClass: result.resourceClass || '',
            frictionLevel: result.frictionLevel || '',
            directPublishReady: !!result.directPublishReady
        };
        resources.push(finalizeResourceSignals(nextResource));
    }

    const storedResources = await writeResourcesToStorage(resources);
    syncResourceOpportunityStats(storedResources);
    scheduleAutoPublishDispatch('resource-discovered');
    broadcastStats();
}

// ============================================================
// 多网站发布任务
// ============================================================

function getTaskType(task = {}) {
    return task.taskType || WorkflowRegistry.get(task?.workflowId || WorkflowRegistry.DEFAULT_WORKFLOW_ID)?.taskType || 'publish';
}

function getNurtureAlarmName(taskId) {
    return `nurture:${taskId}`;
}

function getAlarmPeriodMinutes(frequency = 'daily') {
    switch (frequency) {
        case 'every-2-days':
            return 60 * 24 * 2;
        case 'weekly':
            return 60 * 24 * 7;
        case 'daily':
        default:
            return 60 * 24;
    }
}

function getAlarmPeriodMs(frequency = 'daily') {
    return getAlarmPeriodMinutes(frequency) * 60 * 1000;
}

function computeNextNurtureRunAt(frequency = 'daily', fromMs = Date.now()) {
    return new Date(fromMs + getAlarmPeriodMs(frequency)).toISOString();
}

function buildMarketingResearchQueries(task = {}, snapshot = {}) {
    const website = normalizeHttpUrlBg(task.website || '');
    const domain = getDomainBg(website);
    const title = compactText(snapshot.title || '').replace(/\s*[|\-–—]\s*.*/, '');
    const productSeed = title || domain || compactText(task.name || '');
    const targetAudience = compactText(task.targetAudience || '');
    const preferredChannels = compactText(task.preferredChannels || '');
    const brief = compactText(task.campaignBrief || '');

    const rawQueries = [
        `${productSeed} ${preferredChannels || targetAudience || brief}`.trim(),
        `${productSeed} site:reddit.com OR site:news.ycombinator.com OR site:dev.to OR site:producthunt.com OR site:indiehackers.com`.trim(),
        `${productSeed} submit site OR app directory OR startup directory OR product showcase`.trim(),
        `${productSeed} forum OR community OR launch OR review`.trim()
    ];

    return Array.from(new Set(rawQueries.map((value) => compactText(value)).filter(Boolean))).slice(0, 4);
}

async function readMarketingTargetSnapshot(url = '') {
    const finalUrl = normalizeHttpUrlBg(url);
    if (!finalUrl) return null;

    const tab = await openOrReuseMarketingTab(finalUrl, { active: false, waitForLoad: true });
    try {
        await delay(1200);
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
                const description = document.querySelector('meta[name="description"]')?.getAttribute('content')
                    || document.querySelector('meta[property="og:description"]')?.getAttribute('content')
                    || '';
                const headings = Array.from(document.querySelectorAll('h1, h2'))
                    .map((node) => compact(node.textContent))
                    .filter(Boolean)
                    .slice(0, 6);
                const paragraphs = Array.from(document.querySelectorAll('main p, article p, p'))
                    .map((node) => compact(node.textContent))
                    .filter((text) => text.length > 40)
                    .slice(0, 4);

                return {
                    title: compact(document.title),
                    description: compact(description),
                    headings,
                    summary: paragraphs.join(' ').slice(0, 600),
                    url: window.location.href
                };
            }
        });
        return results?.[0]?.result || null;
    } catch {
        return null;
    }
}

function getMarketingPageReadScore(item = {}, ownDomain = '') {
    const url = normalizeHttpUrlBg(item.url || '');
    const host = getDomainBg(url);
    const text = compactText([item.title, item.snippet].filter(Boolean).join(' ')).toLowerCase();
    let score = 0;

    if (!url || !host || (ownDomain && host === ownDomain)) return -999;
    if (/(google|bing|yahoo)\./.test(host)) return -999;

    if (/(reddit|news\.ycombinator|dev\.to|producthunt|indiehackers|itch\.io|youtube|x\.com|twitter|instagram|facebook|linkedin)\./.test(host)) {
        score += 120;
    }
    if (/(directory|directories|submit|showcase|launch|community|forum|startup|indie|product hunt|appsumo|betalist)/.test(text)) {
        score += 40;
    }
    if (/(post|thread|discussion|launch|listing|directory|submit)/.test(text)) {
        score += 25;
    }

    score += Math.max(0, 20 - (item.rank || 0));
    return score;
}

function buildMarketingPageReadCandidates(queryResults = [], ownDomain = '') {
    const scored = [];
    for (const entry of queryResults) {
        const results = Array.isArray(entry?.results) ? entry.results : [];
        for (let index = 0; index < results.length; index++) {
            const item = results[index] || {};
            scored.push({
                ...item,
                query: entry.query || '',
                rank: index + 1,
                score: getMarketingPageReadScore({ ...item, rank: index + 1 }, ownDomain)
            });
        }
    }

    const seenHosts = new Set();
    return scored
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .filter((item) => {
            const host = getDomainBg(item.url || '');
            if (!host || seenHosts.has(host)) return false;
            seenHosts.add(host);
            return true;
        })
        .slice(0, 6);
}

async function readMarketingPageSnapshot(url = '') {
    const finalUrl = normalizeHttpUrlBg(url);
    if (!finalUrl) return null;

    const tab = await openOrReuseMarketingTab(finalUrl, { active: false, waitForLoad: true });
    try {
        await delay(1400);
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
                const description = document.querySelector('meta[name="description"]')?.getAttribute('content')
                    || document.querySelector('meta[property="og:description"]')?.getAttribute('content')
                    || '';
                const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
                    .map((node) => compact(node.textContent))
                    .filter(Boolean)
                    .slice(0, 8);
                const paragraphs = Array.from(document.querySelectorAll('main p, article p, p'))
                    .map((node) => compact(node.textContent))
                    .filter((text) => text.length > 40)
                    .slice(0, 3);
                return {
                    title: compact(document.title),
                    description: compact(description),
                    headings,
                    summary: paragraphs.join(' ').slice(0, 500),
                    url: window.location.href
                };
            }
        });
        const snapshot = results?.[0]?.result || null;
        if (!snapshot) return null;
        return {
            ...snapshot,
            host: getDomainBg(snapshot.url || finalUrl)
        };
    } catch {
        return null;
    }
}

async function collectBrowserSearchResults(query = '') {
    const finalQuery = compactText(query);
    if (!finalQuery) return [];

    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(finalQuery)}`;
    const tab = await openOrReuseMarketingTab(searchUrl, { active: false, waitForLoad: true });
    try {
        await delay(1400);
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
                return Array.from(document.querySelectorAll('li.b_algo, article[data-testid="result"], .result, .web-result'))
                    .map((node) => {
                        const anchor = node.querySelector('a[href]');
                        if (!anchor) return null;
                        const title = compact(anchor.textContent);
                        const url = anchor.href || anchor.getAttribute('href') || '';
                        const snippet = compact(
                            node.querySelector('.b_caption p, p, .result__snippet, .snippet, .description')?.textContent || ''
                        );
                        return {
                            title,
                            url,
                            snippet
                        };
                    })
                    .filter((item) => item && item.url && /^https?:/i.test(item.url) && item.title)
                    .slice(0, 8);
            }
        });
        return results?.[0]?.result || [];
    } catch {
        return [];
    }
}

function normalizePromotionReviewItem(item = {}) {
    const url = normalizeHttpUrlBg(item.url || '');
    if (!url) return null;
    const openedAt = item.openedAt || new Date().toISOString();
    return {
        name: compactText(item.name || getKnownMarketingPlatformLabel(getDomainBg(url))),
        url,
        host: getDomainBg(url),
        workflowId: compactText(item.workflowId || ''),
        openedAt,
        checkedAt: item.checkedAt || '',
        openCount: Math.max(1, Number(item.openCount || 1))
    };
}

function mergePromotionReviewItems(existingItems = [], item = {}) {
    const normalized = normalizePromotionReviewItem(item);
    if (!normalized) return Array.isArray(existingItems) ? existingItems : [];

    const items = Array.isArray(existingItems) ? existingItems : [];
    const existingIndex = items.findIndex((entry) => normalizeHttpUrlBg(entry?.url || '') === normalized.url);
    if (existingIndex >= 0) {
        const existing = items[existingIndex] || {};
        const merged = {
            ...existing,
            ...normalized,
            name: normalized.name || existing.name || '',
            openCount: Math.max(1, Number(existing.openCount || 1)) + 1,
            checkedAt: existing.checkedAt || normalized.checkedAt || ''
        };
        const next = items.slice();
        next[existingIndex] = merged;
        return next
            .sort((a, b) => new Date(b.openedAt || 0).getTime() - new Date(a.openedAt || 0).getTime())
            .slice(0, 20);
    }

    return [normalized, ...items]
        .sort((a, b) => new Date(b.openedAt || 0).getTime() - new Date(a.openedAt || 0).getTime())
        .slice(0, 20);
}

async function collectMarketingResearchContext(task = {}) {
    const snapshot = await readMarketingTargetSnapshot(task.website || '');
    const queries = buildMarketingResearchQueries(task, snapshot || {});
    const queryResults = [];
    const seenUrls = new Set();
    const ownDomain = getDomainBg(task.website || '');

    for (const query of queries) {
        const results = await collectBrowserSearchResults(query);
        const filtered = results.filter((item) => {
            const normalized = normalizeHttpUrlBg(item.url || '');
            if (!normalized || seenUrls.has(normalized)) return false;
            seenUrls.add(normalized);
            return true;
        });
        queryResults.push({ query, results: filtered });
    }

    const candidates = buildMarketingPageReadCandidates(queryResults, ownDomain);
    const pageReads = [];
    for (const candidate of candidates) {
        const page = await readMarketingPageSnapshot(candidate.url || '');
        if (!page) continue;
        pageReads.push({
            query: candidate.query || '',
            rank: candidate.rank || 0,
            title: page.title || candidate.title || '',
            url: page.url || candidate.url || '',
            description: page.description || '',
            summary: page.summary || candidate.snippet || '',
            headings: page.headings || [],
            host: page.host || getDomainBg(candidate.url || '')
        });
    }

    return {
        generatedAt: new Date().toISOString(),
        snapshot: snapshot || null,
        queries: queryResults,
        pageReads
    };
}

function getKnownMarketingPlatformLabel(host = '') {
    const normalized = String(host || '').toLowerCase();
    const platformMap = [
        ['reddit.com', 'Reddit'],
        ['news.ycombinator.com', 'Hacker News'],
        ['dev.to', 'Dev.to'],
        ['producthunt.com', 'Product Hunt'],
        ['indiehackers.com', 'Indie Hackers'],
        ['itch.io', 'itch.io'],
        ['youtube.com', 'YouTube'],
        ['instagram.com', 'Instagram'],
        ['x.com', 'X'],
        ['twitter.com', 'Twitter'],
        ['facebook.com', 'Facebook'],
        ['linkedin.com', 'LinkedIn'],
        ['threads.net', 'Threads'],
        ['tiktok.com', 'TikTok'],
        ['alternativeto.net', 'AlternativeTo'],
        ['betalist.com', 'BetaList'],
        ['startupstash.com', 'Startup Stash'],
        ['saashub.com', 'SaaSHub'],
        ['toolify.ai', 'Toolify'],
        ['futurepedia.io', 'Futurepedia'],
        ['thereisanaiforthat.com', 'ThereIsAnAIForThat'],
        ['launchingnext.com', 'Launching Next'],
        ['insanelycooltools.com', 'Insanely Cool Tools'],
        ['chromewebstore.google.com', 'Chrome Web Store'],
        ['addons.mozilla.org', 'Mozilla Add-ons']
    ];

    const matched = platformMap.find(([pattern]) => normalized === pattern || normalized.endsWith(`.${pattern}`));
    if (matched) return matched[1];
    return normalized.replace(/^www\./, '') || '平台';
}

function isLikelyMarketingPlatformCandidate(candidate = {}, workflowId = '') {
    const host = String(candidate.host || getDomainBg(candidate.url || '') || '').toLowerCase();
    const text = compactText([
        candidate.title,
        candidate.description,
        candidate.summary,
        candidate.snippet,
        candidate.query,
        candidate.reason
    ].join(' ')).toLowerCase();

    if (!host) return false;
    if (/google\.com|bing\.com|yahoo\.com|duckduckgo\.com|baidu\.com|wikipedia\.org|fandom\.com/i.test(host)) {
        return false;
    }
    if (/(login|sign in|pricing|docs|documentation|terms|privacy|download|apk|wiki|codes)/i.test(text)
        && !/(forum|community|discussion|subreddit|directory|listing|submit|launch|show hn|product hunt)/i.test(text)) {
        return false;
    }

    const knownPlatform = /(reddit\.com|news\.ycombinator\.com|dev\.to|producthunt\.com|indiehackers\.com|itch\.io|youtube\.com|instagram\.com|x\.com|twitter\.com|facebook\.com|linkedin\.com|threads\.net|tiktok\.com|alternativeto\.net|betalist\.com|startupstash\.com|saashub\.com|toolify\.ai|futurepedia\.io|thereisanaiforthat\.com|launchingnext\.com|insanelycooltools\.com|chromewebstore\.google\.com|addons\.mozilla\.org|g2\.com|capterra\.com|appsumo\.com|discord\.com|devforum\.roblox\.com)/i;
    if (knownPlatform.test(host)) return true;

    if (workflowId === 'community-post-promote') {
        return /(forum|community|discussion|thread|subreddit|discourse|phpbb|xenforo|vbulletin|show hn|share your project)/i.test(`${host} ${text}`);
    }
    if (workflowId === 'directory-submit-promote') {
        return /(submit|directory|listing|launch|showcase|catalog|startup directory|tool directory|product hunt|app directory)/i.test(text);
    }
    if (workflowId === 'account-nurture') {
        return /(youtube|instagram|twitter|x\.com|facebook|linkedin|threads|tiktok|discord)/i.test(host);
    }
    return false;
}

function inferMarketingWorkflowId(candidate = {}) {
    const host = String(candidate.host || getDomainBg(candidate.url || '') || '').toLowerCase();
    const text = compactText([
        candidate.title,
        candidate.description,
        candidate.summary,
        candidate.snippet,
        candidate.query
    ].join(' ')).toLowerCase();

    const socialHosts = /(youtube\.com|instagram\.com|x\.com|twitter\.com|facebook\.com|linkedin\.com|threads\.net|tiktok\.com|discord\.com)/i;
    const communityHosts = /(reddit\.com|news\.ycombinator\.com|dev\.to|indiehackers\.com|hashnode\.com|medium\.com|substack\.com|forum|community|discourse|phpbb|xenforo|vbulletin)/i;
    const directoryHosts = /(producthunt\.com|alternativeto\.net|betalist\.com|startupstash\.com|saashub\.com|toolify\.ai|futurepedia\.io|thereisanaiforthat\.com|launchingnext\.com|insanelycooltools\.com|chromewebstore\.google\.com|addons\.mozilla\.org|g2\.com|capterra\.com|appsumo\.com)/i;

    if (socialHosts.test(host)) return 'account-nurture';
    if (directoryHosts.test(host)) return 'directory-submit-promote';
    if (communityHosts.test(host)) return 'community-post-promote';

    if (/\b(submit|directory|listing|launch|showcase|startup directory|product hunt|chrome extension store|add-ons)\b/i.test(text)) {
        return 'directory-submit-promote';
    }
    if (/\b(subreddit|community|forum|discussion|thread|show hn|post idea|devlog|share your project|launch thread)\b/i.test(text)) {
        return 'community-post-promote';
    }
    if (/\b(profile|followers|subscribe|channel|feed|timeline|creator)\b/i.test(text)) {
        return 'account-nurture';
    }
    return 'community-post-promote';
}

function scoreMarketingCandidate(candidate = {}) {
    const host = String(candidate.host || getDomainBg(candidate.url || '') || '').toLowerCase();
    const text = compactText([
        candidate.title,
        candidate.description,
        candidate.summary,
        candidate.snippet,
        candidate.query
    ].join(' ')).toLowerCase();

    let score = Number(candidate.rank || 0) > 0 ? Math.max(0, 40 - (Number(candidate.rank) * 4)) : 8;
    if (candidate.source === 'page-read') score += 24;
    if (/reddit\.com|news\.ycombinator\.com|dev\.to|producthunt\.com|indiehackers\.com|itch\.io|alternativeto\.net|betalist\.com|startupstash\.com|saashub\.com/i.test(host)) score += 20;
    if (/\b(submit|directory|listing|community|forum|discussion|launch|show hn|share your project|product hunt)\b/i.test(text)) score += 12;
    if (/\b(login|sign in|pricing|docs|documentation|terms|privacy)\b/i.test(text)) score -= 8;
    if (/google\.com|bing\.com|yahoo\.com|duckduckgo\.com/i.test(host)) score -= 20;
    return Math.max(0, Math.min(100, score));
}

function buildMarketingChannelAngle(task = {}, workflowId = '', candidate = {}, researchContext = {}) {
    const audience = compactText(task.targetAudience || '');
    const brief = compactText(task.campaignBrief || '').slice(0, 120);
    const productTitle = compactText(researchContext?.snapshot?.title || task.name || getDomainBg(task.website || '') || '产品');
    const platform = getKnownMarketingPlatformLabel(candidate.host || getDomainBg(candidate.url || ''));

    if (workflowId === 'directory-submit-promote') {
        return compactText(`提交 ${productTitle} 到 ${platform}，突出 ${brief || '核心卖点、差异化与落地页价值'}。`);
    }
    if (workflowId === 'account-nurture') {
        return compactText(`围绕 ${platform} 的目标用户 ${audience || '相关受众'} 做低频浏览、点赞和自然互动，逐步建立账号历史。`);
    }
    return compactText(`在 ${platform} 以 ${audience || '目标用户'} 为对象，分享 ${brief || `${productTitle} 的使用价值、案例和故事`}。`);
}

function buildMarketingChannelReason(candidate = {}, workflowId = '') {
    const query = compactText(candidate.query || '');
    const evidence = compactText(candidate.summary || candidate.description || candidate.snippet || '').slice(0, 180);
    const host = candidate.host || getDomainBg(candidate.url || '');
    const workflowLabelMap = {
        'community-post-promote': '社区发帖',
        'directory-submit-promote': '目录提交',
        'account-nurture': '账号养护'
    };
    const label = workflowLabelMap[workflowId] || '宣传渠道';
    const parts = [
        `${label}候选`,
        host ? `来源站点：${host}` : '',
        query ? `命中搜索：${query}` : '',
        evidence ? `页面摘要：${evidence}` : ''
    ].filter(Boolean);
    return parts.join('；');
}

function buildMarketingChannelName(candidate = {}, workflowId = '') {
    const host = candidate.host || getDomainBg(candidate.url || '');
    const platformLabel = getKnownMarketingPlatformLabel(host);
    if (workflowId === 'account-nurture') return `${platformLabel} 账号养护`;
    if (workflowId === 'directory-submit-promote') return `${platformLabel} 目录提交`;
    return `${platformLabel} 社区发帖`;
}

function normalizeMarketingChannel(channel = {}, task = {}, researchContext = {}) {
    const url = normalizeHttpUrlBg(channel.url || '');
    if (!url) return null;
    const host = getDomainBg(url);
    const workflowId = ['community-post-promote', 'directory-submit-promote', 'account-nurture'].includes(channel.workflowId)
        ? channel.workflowId
        : inferMarketingWorkflowId({ ...channel, url, host });
    const score = Number(channel.score || scoreMarketingCandidate({ ...channel, url, host }));

    return {
        name: compactText(channel.name || buildMarketingChannelName({ ...channel, host }, workflowId)),
        url,
        host,
        workflowId,
        angle: compactText(channel.angle || buildMarketingChannelAngle(task, workflowId, { ...channel, url, host }, researchContext)),
        reason: compactText(channel.reason || buildMarketingChannelReason({ ...channel, url, host }, workflowId)),
        source: compactText(channel.source || 'ai-plan'),
        query: compactText(channel.query || ''),
        title: compactText(channel.title || ''),
        score
    };
}

function buildMarketingFallbackChannels(task = {}, researchContext = {}) {
    const pageReads = Array.isArray(researchContext?.pageReads) ? researchContext.pageReads : [];
    const queryResults = Array.isArray(researchContext?.queries) ? researchContext.queries : [];
    const candidates = [];

    for (const page of pageReads) {
        candidates.push({
            ...page,
            source: 'page-read',
            rank: Number(page.rank || 0)
        });
    }

    for (const entry of queryResults) {
        const query = String(entry?.query || '').trim();
        const results = Array.isArray(entry?.results) ? entry.results : [];
        for (let index = 0; index < results.length; index++) {
            const item = results[index] || {};
            candidates.push({
                ...item,
                query,
                source: 'search-result',
                rank: index + 1,
                host: getDomainBg(item.url || '')
            });
        }
    }

    const deduped = new Map();
    for (const candidate of candidates) {
        const normalizedUrl = normalizeHttpUrlBg(candidate.url || '');
        if (!normalizedUrl) continue;
        const host = getDomainBg(normalizedUrl);
        if (!host || host === getDomainBg(task.website || '')) continue;

        const workflowId = inferMarketingWorkflowId({ ...candidate, url: normalizedUrl, host });
        if (!isLikelyMarketingPlatformCandidate({ ...candidate, url: normalizedUrl, host }, workflowId)) continue;
        const normalized = normalizeMarketingChannel({
            ...candidate,
            url: normalizedUrl,
            host,
            workflowId,
            score: scoreMarketingCandidate({ ...candidate, url: normalizedUrl, host })
        }, task, researchContext);
        if (!normalized) continue;

        const key = `${normalized.workflowId}::${normalized.url}`;
        const existing = deduped.get(key);
        if (!existing || normalized.score > existing.score) {
            deduped.set(key, normalized);
        }
    }

    const priority = {
        'community-post-promote': 0,
        'directory-submit-promote': 1,
        'account-nurture': 2
    };

    return Array.from(deduped.values())
        .sort((a, b) => {
            const priorityDelta = (priority[a.workflowId] || 9) - (priority[b.workflowId] || 9);
            if (priorityDelta !== 0) return priorityDelta;
            return (b.score || 0) - (a.score || 0);
        })
        .slice(0, 8);
}

function summarizeMarketingChannelMix(channels = []) {
    return channels.reduce((summary, channel) => {
        const workflowId = channel?.workflowId || '';
        summary[workflowId] = Number(summary[workflowId] || 0) + 1;
        return summary;
    }, {});
}

function finalizeMarketingPlan(rawPlan = {}, task = {}, researchContext = {}) {
    const fallbackChannels = buildMarketingFallbackChannels(task, researchContext);
    const merged = new Map();
    const priority = {
        'community-post-promote': 0,
        'directory-submit-promote': 1,
        'account-nurture': 2
    };

    for (const channel of Array.isArray(rawPlan?.channels) ? rawPlan.channels : []) {
        const normalized = normalizeMarketingChannel(channel, task, researchContext);
        if (!normalized) continue;
        merged.set(`${normalized.workflowId}::${normalized.url}`, normalized);
    }

    for (const channel of fallbackChannels) {
        const key = `${channel.workflowId}::${channel.url}`;
        const existing = merged.get(key);
        if (existing) {
            merged.set(key, {
                ...channel,
                ...existing,
                angle: existing.angle || channel.angle,
                reason: existing.reason || channel.reason,
                score: Math.max(Number(existing.score || 0), Number(channel.score || 0)),
                source: existing.source || channel.source
            });
        } else {
            merged.set(key, channel);
        }
    }

    const channels = Array.from(merged.values()).sort((a, b) => {
        const priorityDelta = (priority[a.workflowId] || 9) - (priority[b.workflowId] || 9);
        if (priorityDelta !== 0) return priorityDelta;
        return Number(b.score || 0) - Number(a.score || 0);
    });
    const channelMix = summarizeMarketingChannelMix(channels);
    const nextSteps = Array.isArray(rawPlan?.nextSteps) && rawPlan.nextSteps.length > 0
        ? rawPlan.nextSteps
        : [
            channelMix['community-post-promote'] ? '优先推进高分社区渠道，准备对应发帖角度与落地页。' : '',
            channelMix['directory-submit-promote'] ? '整理目录提交所需的标题、描述、分类和截图素材。' : '',
            channelMix['account-nurture'] ? '把需要长期积累的平台加入养号节奏，降低直接发帖风险。' : ''
        ].filter(Boolean);
    const cautions = Array.isArray(rawPlan?.cautions) && rawPlan.cautions.length > 0
        ? rawPlan.cautions
        : [
            '优先在允许推广的社区或目录提交，不要在规则不明的平台直接硬广。',
            '对需要登录、养号或人工上传素材的平台，保留人工接管点。'
        ];
    const summary = compactText(rawPlan?.summary || '')
        || `已基于浏览器调研整理 ${channels.length} 个可执行渠道，其中社区发帖 ${channelMix['community-post-promote'] || 0} 个、目录提交 ${channelMix['directory-submit-promote'] || 0} 个、账号养护 ${channelMix['account-nurture'] || 0} 个。`;

    return {
        ...rawPlan,
        summary,
        channels,
        nextSteps,
        cautions,
        browserSuggestedCount: fallbackChannels.length,
        channelMix
    };
}

function filterPromotionPlanForUnopenedChannels(plan = {}, reviewItems = []) {
    const openedUrls = new Set((Array.isArray(reviewItems) ? reviewItems : [])
        .map((item) => normalizeHttpUrlBg(item?.url || ''))
        .filter(Boolean));

    const channels = (Array.isArray(plan.channels) ? plan.channels : [])
        .filter((channel) => {
            const url = normalizeHttpUrlBg(channel?.url || '');
            return url && !openedUrls.has(url);
        });

    const channelMix = summarizeMarketingChannelMix(channels);
    const totalOpenableChannels = channels.filter((channel) =>
        channel?.workflowId !== 'account-nurture' && normalizeHttpUrlBg(channel?.url || '')
    ).length;

    return {
        ...plan,
        channels,
        channelMix,
        totalOpenableChannels,
        nextChannelIndex: 0,
        progressedChannelCount: 0,
        lastOpenedChannelIndex: -1,
        openedChannelName: '',
        openedChannelUrl: '',
        lastOpenedAt: '',
        status: totalOpenableChannels > 0 ? 'planned' : 'awaiting_refresh'
    };
}

async function syncTaskSchedule(task = {}) {
    if (!task.id) return;
    const nurtureAlarmName = getNurtureAlarmName(task.id);
    const promotionAlarmName = getPromotionRefreshAlarmName(task.id);
    const taskType = getTaskType(task);

    if (taskType === 'nurture') {
        try { await chrome.alarms.clear(promotionAlarmName); } catch {}
        const periodInMinutes = getAlarmPeriodMinutes(task.frequency || 'daily');
        const now = Date.now();
        let nextRunAtMs = new Date(task.nextRunAt || '').getTime();
        if (!Number.isFinite(nextRunAtMs) || nextRunAtMs <= now) {
            nextRunAtMs = now + getAlarmPeriodMs(task.frequency || 'daily');
        }
        await chrome.alarms.create(nurtureAlarmName, {
            when: nextRunAtMs,
            periodInMinutes
        });
        return;
    }

    try { await chrome.alarms.clear(nurtureAlarmName); } catch {}

    if (task.workflowId === 'product-promote-campaign') {
        const nextResearchAtMs = getPromotionNextResearchAtMs(task);
        if (nextResearchAtMs > Date.now()) {
            await chrome.alarms.create(promotionAlarmName, {
                when: nextResearchAtMs
            });
        } else {
            try { await chrome.alarms.clear(promotionAlarmName); } catch {}
        }
        return;
    }

    try { await chrome.alarms.clear(promotionAlarmName); } catch {}
}

async function restoreTaskSchedules() {
    const tasks = await TaskStore.getTasks();
    await Promise.all(tasks.map((task) => syncTaskSchedule(task).catch(() => {})));
}

function getWorkflowTaskType(workflowId) {
    return WorkflowRegistry.get(workflowId || WorkflowRegistry.DEFAULT_WORKFLOW_ID)?.taskType || 'publish';
}

function buildGeneratedMarketingTask(baseTask = {}, channel = {}, index = 0) {
    const workflowId = ['community-post-promote', 'directory-submit-promote', 'account-nurture'].includes(channel.workflowId)
        ? channel.workflowId
        : 'community-post-promote';
    const taskType = getWorkflowTaskType(workflowId);
    const platformUrl = normalizeHttpUrlBg(channel.url || '');
    const workflowLabel = WorkflowRegistry.getLabel(workflowId);
    const angle = String(channel.angle || '').trim();
    const reason = String(channel.reason || '').trim();
    const campaignBrief = [
        String(baseTask.campaignBrief || '').trim(),
        reason ? `研究建议：${reason}` : '',
        angle ? `建议角度：${angle}` : ''
    ].filter(Boolean).join('\n');

    return {
        id: `research-${baseTask.id || 'seed'}-${index}-${Math.random().toString(36).slice(2, 7)}`,
        name: `${baseTask.name || baseTask.website || '营销任务'} · ${channel.name || workflowLabel}`,
        website: baseTask.website || '',
        workflowId,
        taskType,
        platformUrl,
        campaignBrief,
        postAngle: taskType === 'promote' ? angle : '',
        submitCategory: workflowId === 'directory-submit-promote' ? angle : '',
        frequency: workflowId === 'account-nurture' ? 'daily' : '',
        sessionGoal: workflowId === 'account-nurture' ? (angle || reason || '浏览并进行低频互动') : '',
        nextRunAt: workflowId === 'account-nurture' ? computeNextNurtureRunAt('daily') : '',
        generatedFromTaskId: baseTask.id || '',
        generatedByResearch: true,
        generatedAt: new Date().toISOString(),
        stats: { total: 0, success: 0, skipped: 0, pending: 0, failed: 0 },
        runCount: 0,
        lastRunAt: ''
    };
}

async function createNurtureTasksFromPromotionPlan(baseTask = {}, promotionPlan = {}) {
    const channels = Array.isArray(promotionPlan.channels) ? promotionPlan.channels : [];
    const nurtureChannels = channels.filter((channel) => channel?.workflowId === 'account-nurture');
    const scheduledTasks = [];
    const summary = await TaskStore.updateTasks((tasks) => {
        let createdCount = 0;
        let updatedCount = 0;

        for (let index = 0; index < nurtureChannels.length; index++) {
            const channel = nurtureChannels[index] || {};
            const normalizedUrl = normalizeHttpUrlBg(channel.url || '');
            if (!normalizedUrl) continue;

            const existingIndex = tasks.findIndex((task) =>
                task.generatedFromTaskId === baseTask.id
                && task.workflowId === 'account-nurture'
                && normalizeHttpUrlBg(task.platformUrl || '') === normalizedUrl
            );

            const generatedTask = {
                ...buildGeneratedMarketingTask(baseTask, channel, index),
                workflowId: 'account-nurture',
                taskType: 'nurture',
                name: `${baseTask.name || baseTask.website || '产品宣传'} · 养号 · ${channel.name || getDomainBg(channel.url || '') || '平台'}`,
                generatedByCampaign: true
            };

            if (existingIndex >= 0) {
                tasks[existingIndex] = {
                    ...tasks[existingIndex],
                    ...generatedTask,
                    id: tasks[existingIndex].id,
                    createdAt: tasks[existingIndex].createdAt || new Date().toISOString(),
                    runCount: Number(tasks[existingIndex].runCount || 0),
                    lastRunAt: tasks[existingIndex].lastRunAt || ''
                };
                scheduledTasks.push({ ...tasks[existingIndex] });
                updatedCount++;
            } else {
                generatedTask.createdAt = new Date().toISOString();
                tasks.push(generatedTask);
                scheduledTasks.push({ ...generatedTask });
                createdCount++;
            }
        }

        return {
            tasks,
            value: {
                createdCount,
                updatedCount,
                totalChannels: nurtureChannels.length
            }
        };
    });
    await Promise.all(scheduledTasks.map((task) => syncTaskSchedule(task).catch(() => {})));
    return {
        createdCount: summary.createdCount,
        updatedCount: summary.updatedCount,
        totalChannels: summary.totalChannels
    };
}

async function createTasksFromResearchPlan(baseTask = {}, researchResult = {}) {
    const channels = Array.isArray(researchResult.channels) ? researchResult.channels : [];
    const scheduledTasks = [];
    const summary = await TaskStore.updateTasks((tasks) => {
        let createdCount = 0;
        let updatedCount = 0;

        for (let index = 0; index < channels.length; index++) {
            const channel = channels[index] || {};
            const normalizedUrl = normalizeHttpUrlBg(channel.url || '');
            if (!normalizedUrl) continue;

            const workflowId = ['community-post-promote', 'directory-submit-promote', 'account-nurture'].includes(channel.workflowId)
                ? channel.workflowId
                : 'community-post-promote';

            const existingIndex = tasks.findIndex((task) =>
                task.generatedFromTaskId === baseTask.id
                && task.workflowId === workflowId
                && normalizeHttpUrlBg(task.platformUrl || '') === normalizedUrl
            );

            const generatedTask = buildGeneratedMarketingTask(baseTask, channel, index);

            if (existingIndex >= 0) {
                tasks[existingIndex] = {
                    ...tasks[existingIndex],
                    ...generatedTask,
                    id: tasks[existingIndex].id,
                    createdAt: tasks[existingIndex].createdAt || new Date().toISOString(),
                    runCount: Number(tasks[existingIndex].runCount || 0),
                    lastRunAt: tasks[existingIndex].lastRunAt || ''
                };
                scheduledTasks.push({ ...tasks[existingIndex] });
                updatedCount++;
            } else {
                generatedTask.createdAt = new Date().toISOString();
                tasks.push(generatedTask);
                scheduledTasks.push({ ...generatedTask });
                createdCount++;
            }
        }

        return {
            tasks,
            value: {
                createdCount,
                updatedCount,
                totalChannels: channels.length
            }
        };
    });
    await Promise.all(scheduledTasks.map((task) => syncTaskSchedule(task).catch(() => {})));
    return {
        createdCount: summary.createdCount,
        updatedCount: summary.updatedCount,
        totalChannels: summary.totalChannels
    };
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
            researchContext = await collectMarketingResearchContext(currentTask);
        }
        promotionPlan = await AIEngine.generateResearchPlan({
            website: currentTask.website || '',
            targetAudience: currentTask.targetAudience || '',
            preferredChannels: currentTask.preferredChannels || '',
            campaignBrief: currentTask.campaignBrief || '',
            researchContext
        });
        promotionPlan = finalizeMarketingPlan(promotionPlan, currentTask, researchContext);
        promotionPlan = filterPromotionPlanForUnopenedChannels(promotionPlan, existingReviewItems);
        nurtureGenerated = await createNurtureTasksFromPromotionPlan(currentTask, promotionPlan);
        generatedFresh = true;
    } else {
        promotionPlan = finalizeMarketingPlan(promotionPlan, currentTask, researchContext || {});
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
            ? mergePromotionReviewItems(promotionPlan.reviewItems, {
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
    const researchContext = await collectMarketingResearchContext(task);
    let researchResult = await AIEngine.generateResearchPlan({
        website: task.website || '',
        targetAudience: task.targetAudience || '',
        preferredChannels: task.preferredChannels || '',
        campaignBrief: task.campaignBrief || '',
        researchContext
    });
    researchResult = finalizeMarketingPlan(researchResult, task, researchContext);

    const generated = await createTasksFromResearchPlan(task, researchResult);
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
    if (isAutoPublishTask(savedTask)) {
        scheduleAutoPublishDispatch('task-saved', 600);
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
    await TaskStore.removeTask(taskId);
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
        rebalanceCooldownQueue: () => rebalanceCooldownQueue(taskId),
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
            await chrome.tabs.sendMessage(tabId, { action: 'stopPublishSession' });
        },
        broadcastDone: () => {
            broadcastToPopup({ action: 'publishDone', taskId });
            schedulePublishBatchAdvance('publish-done', 700);
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
    if (!options.fromBatch && isPublishBatchRunning()) {
        return {
            success: false,
            code: 'publish_batch_busy',
            message: '当前批量发布进行中，请先停止批量发布后再单独启动任务。'
        };
    }
    const hasOtherActivePublish = Object.entries(publishSessions || {}).some(([activeTaskId, session]) => {
        if (activeTaskId === runtimeTask?.id) return false;
        return !!session?.isPublishing || !!session?.awaitingManualContinue || !!session?.pendingSubmission;
    });
    if (hasOtherActivePublish) {
        return {
            success: false,
            code: 'publish_session_busy',
            message: '当前已有其他发布任务在运行，请先停止或完成后再启动新的任务。'
        };
    }
    if (!options.autoDispatch && runtimeTask?.id && runtimeTask.autoDispatchPaused) {
        await setTaskAutoDispatchPaused(runtimeTask.id, false);
        runtimeTask = {
            ...runtimeTask,
            autoDispatchPaused: false
        };
    }
    return await PublishRuntime.start(getPublishRuntimeContext(runtimeTask.id), runtimeTask);
}

async function publishNext(taskId) {
    await ensurePublishSessionsLoaded();
    return await PublishRuntime.dispatchQueue(getPublishRuntimeContext(taskId));
}

async function handleCommentAction(resourceId, result, taskId, meta = {}) {
    await ensurePublishSessionsLoaded();
    await ensurePublishBatchStateLoaded();
    const runtimeTaskId = taskId || findPublishSessionTaskIdByResource(resourceId);
    if (!runtimeTaskId) return;
    clearPublishWatchdog(runtimeTaskId);
    const actionResult = await PublishRuntime.handleAction(
        getPublishRuntimeContext(runtimeTaskId),
        resourceId,
        result,
        runtimeTaskId,
        meta
    );
    const session = getPublishSessionState(runtimeTaskId);
    if (!session.isPublishing && !session.awaitingManualContinue && !session.pendingSubmission) {
        schedulePublishBatchAdvance('publish-session-idle', 500);
        scheduleAutoPublishDispatch('publish-session-idle', 700);
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
        scheduleAutoPublishDispatch(`resource-status:${status}`, 900);
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

function stopCollect() {
    collectState.isCollecting = false;
    if (continuousDiscoveryLoaded && continuousDiscoveryState.isRunning) {
        continuousDiscoveryState.isRunning = false;
        continuousDiscoveryState.isPaused = true;
        continuousDiscoveryState.currentDomain = '';
        continuousDiscoveryState.lastMessage = '已暂停持续发现';
        flushContinuousDiscoveryState().catch(() => {});
        broadcastContinuousDiscoveryState().catch(() => {});
    }
    persistCollectSnapshot().catch(() => {});
    broadcastToPopup({ action: 'collectDone' });
    Logger.collect('手动停止收集');
}

async function stopPublish(taskId, options = {}) {
    await ensurePublishSessionsLoaded();
    await ensurePublishBatchStateLoaded();
    const batchCurrentTaskId = publishBatchRuntime.getState().currentTaskId || '';
    const shouldStopBatch = !options.skipBatchStop
        && isPublishBatchRunning()
        && (!taskId || !batchCurrentTaskId || batchCurrentTaskId === taskId);
    if (shouldStopBatch) {
        await stopPublishBatch({ stopActiveTask: false, message: '已停止批量发布' });
    }
    const activeTaskIds = taskId
        ? [taskId]
        : Object.entries(publishSessions || {})
            .filter(([, session]) => session.isPublishing || session.awaitingManualContinue)
            .map(([activeTaskId]) => activeTaskId);
    for (const taskId of activeTaskIds) {
        clearPublishWatchdog(taskId);
        await PublishRuntime.stop(getPublishRuntimeContext(taskId));
        if (!options.skipAutoDispatchPause) {
            await setTaskAutoDispatchPaused(taskId, true, options.pauseReason || 'manual-stop');
        }
    }

    if (!taskId && !options.skipAutoDispatchPause) {
        await TaskStore.updateTasks((tasks) => tasks.map((task) => {
            if (!isAutoPublishTask({ ...task, autoDispatchPaused: false })) {
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
        currentUrl: resource.url
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
        }
    );
}

async function verifyPublishedAnchor(tabId, options = {}) {
    let lastResult = null;

    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            await delay(attempt === 0 ? 1500 : 2500);
            const results = await chrome.scripting.executeScript({
                target: { tabId },
                func: (payload) => {
                    const normalizeText = (value) => String(value || '')
                        .normalize('NFD')
                        .replace(/[\u0300-\u036f]/g, '')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .toLowerCase();
                    const normalizeUrl = (value) => String(value || '')
                        .trim()
                        .toLowerCase()
                        .replace(/^https?:\/\//, '')
                        .replace(/^www\./, '')
                        .replace(/\/+$/, '');
                    const getCommentBlockSelector = () => 'li, article, .comment, .comment-body, .commentlist li, .comment-content, .comment_container, .comments-area article, .comments-area li';
                    const isVisible = (el) => {
                        if (!el) return false;
                        const rect = el.getBoundingClientRect?.();
                        return !!rect && rect.width > 0 && rect.height > 0;
                    };
                    const buildCommentPreviewTokens = (value) => {
                        const normalized = normalizeText(value || '');
                        if (!normalized) return [];
                        const tokens = normalized
                            .split(/[.!?。！？]/)
                            .map((item) => item.trim())
                            .filter((item) => item.length >= 18)
                            .map((item) => item.slice(0, 120));
                        if (tokens.length > 0) {
                            return Array.from(new Set(tokens)).slice(0, 3);
                        }
                        return [normalized.slice(0, 120)].filter(Boolean);
                    };
                    const clearReviewMarkers = () => {
                        document.querySelectorAll('[data-bla-review-target="1"]').forEach((node) => {
                            node.removeAttribute('data-bla-review-target');
                            node.style.outline = '';
                            node.style.outlineOffset = '';
                            node.style.backgroundColor = '';
                            node.style.scrollMarginTop = '';
                        });
                    };

                    const targetUrl = normalizeUrl(payload.anchorUrl || '');
                    const anchorText = normalizeText(payload.anchorText || '');
                    const commenterName = normalizeText(payload.commenterName || '');
                    const commentPreviewTokens = buildCommentPreviewTokens(payload.commentPreview || '');
                    const pageTextRaw = String(document.body?.innerText || '').trim();
                    const pageText = normalizeText(pageTextRaw);
                    const pageUrl = String(window.location.href || '');
                    const pageUrlLower = pageUrl.toLowerCase();
                    const pagePath = String(window.location.pathname || '').toLowerCase();

                    const anchors = Array.from(document.querySelectorAll('a[href]'));
                    const matchingAnchors = anchors.filter((anchor) => {
                        const href = normalizeUrl(anchor.getAttribute('href') || anchor.href || '');
                        const text = normalizeText(anchor.textContent || '');
                        const hrefMatches = targetUrl && (href === targetUrl || href.includes(targetUrl) || targetUrl.includes(href));
                        const textMatches = !anchorText || text.includes(anchorText);
                        return hrefMatches && textMatches;
                    });

                    const relatedAnchor = commenterName
                        ? (matchingAnchors.find((anchor) => {
                            const block = anchor.closest(getCommentBlockSelector());
                            return normalizeText(block?.textContent || '').includes(commenterName);
                        }) || null)
                        : (matchingAnchors[0] || null);
                    const commentBlocks = Array.from(document.querySelectorAll(getCommentBlockSelector()))
                        .filter((block) => isVisible(block))
                        .filter((block, index, list) => list.indexOf(block) === index);
                    const anchorBlock = relatedAnchor?.closest(getCommentBlockSelector()) || null;
                    const scoredBlocks = commentBlocks
                        .map((block) => {
                            const text = normalizeText(block.textContent || '');
                            let score = 0;
                            if (!text) return { block, score: 0, excerpt: '' };
                            if (anchorBlock && block === anchorBlock) score += 10;
                            if (commenterName && text.includes(commenterName)) score += 5;
                            if (commentPreviewTokens.some((token) => token && text.includes(token))) score += 6;
                            if (targetUrl) {
                                const localAnchors = Array.from(block.querySelectorAll('a[href]'));
                                if (localAnchors.some((anchor) => {
                                    const href = normalizeUrl(anchor.getAttribute('href') || anchor.href || '');
                                    return href && (href === targetUrl || href.includes(targetUrl) || targetUrl.includes(href));
                                })) {
                                    score += 4;
                                }
                            }
                            return {
                                block,
                                score,
                                excerpt: String(block.textContent || '').trim().slice(0, 220)
                            };
                        })
                        .sort((left, right) => right.score - left.score);
                    const locatedBlock = anchorBlock || scoredBlocks.find((entry) => entry.score >= 6)?.block || null;
                    const locationMethod = anchorBlock
                        ? 'anchor-block'
                        : (locatedBlock ? 'comment-block' : '');
                    if (locatedBlock) {
                        clearReviewMarkers();
                        locatedBlock.setAttribute('data-bla-review-target', '1');
                        locatedBlock.style.outline = '3px solid #14d39a';
                        locatedBlock.style.outlineOffset = '6px';
                        locatedBlock.style.backgroundColor = 'rgba(20, 211, 154, 0.08)';
                        locatedBlock.style.scrollMarginTop = '120px';
                        try {
                            locatedBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        } catch {}
                    }
                    const websiteFieldBlockedFirstComment =
                        pageText.includes('not permitted to submit a website address')
                        && pageText.includes('delete the website in the website field');
                    const reviewPendingPatterns = [
                        {
                            reason: 'moderated',
                            test: () => pageUrlLower.includes('unapproved=')
                                && pageUrlLower.includes('moderation-hash=')
                        },
                        {
                            reason: 'moderated',
                            test: () => pageText.includes('your comment is awaiting moderation')
                                || pageText.includes('comment is awaiting moderation')
                                || pageText.includes('held for moderation')
                        },
                        {
                            reason: 'moderated',
                            test: () => pageText.includes('awaiting approval')
                                || pageText.includes('pending approval')
                                || pageText.includes('pending moderation')
                        },
                        {
                            reason: 'moderated',
                            test: () => pageText.includes('评论正在等待审核')
                                || pageText.includes('评论正在审核')
                                || pageText.includes('审核后显示')
                                || pageText.includes('留言正在审核')
                        },
                        {
                            reason: 'moderated',
                            test: () => pageText.includes('votre commentaire est en attente de moderation')
                                || pageText.includes('votre commentaire est en attente de modération')
                                || pageText.includes('en attente de moderation')
                                || pageText.includes('en attente de modération')
                                || pageText.includes('sera visible apres validation')
                                || pageText.includes('sera visible après validation')
                                || pageText.includes('apercu, votre commentaire sera visible apres validation')
                                || pageText.includes('aperçu, votre commentaire sera visible après validation')
                        }
                    ];
                    const submissionBlockedPatterns = [
                        {
                            reason: 'comment_rate_limited',
                            test: () =>
                                pagePath.includes('wp-comments-post.php') &&
                                (pageText.includes('comentarios rapido demais') ||
                                    pageText.includes('comentarios rapido de mais') ||
                                    pageText.includes('calma ai') ||
                                    pageText.includes('calma ai.'))
                        },
                        {
                            reason: 'comment_rate_limited',
                            test: () => pageText.includes('posting comments too quickly') || pageText.includes('comments too quickly')
                        },
                        {
                            reason: 'comment_rate_limited',
                            test: () => pageText.includes('you are posting comments too fast') || pageText.includes('slow down')
                        },
                        {
                            reason: 'duplicate_comment',
                            test: () => pageText.includes('duplicate comment detected') || pageText.includes('looks as though you have already said that')
                        },
                        {
                            reason: 'comment_submission_blocked',
                            test: () => pagePath.includes('wp-comments-post.php')
                                && !websiteFieldBlockedFirstComment
                                && !relatedAnchor
                                && !locatedBlock
                        }
                    ];
                    const submissionBlockedMatch = submissionBlockedPatterns.find((pattern) => {
                        try {
                            return pattern.test();
                        } catch {
                            return false;
                        }
                    });
                    const reviewPendingMatch = reviewPendingPatterns.find((pattern) => {
                        try {
                            return pattern.test();
                        } catch {
                            return false;
                        }
                    });

                    return {
                        anchorVisible: !!relatedAnchor,
                        anchorCount: matchingAnchors.length,
                        anchorText: relatedAnchor ? String(relatedAnchor.textContent || '').trim() : '',
                        anchorHref: relatedAnchor ? String(relatedAnchor.getAttribute('href') || relatedAnchor.href || '') : '',
                        commenterMatched: !!relatedAnchor && !!commenterName,
                        commentLocated: !!locatedBlock,
                        commentLocationMethod: locationMethod,
                        commentExcerpt: locatedBlock ? String(locatedBlock.textContent || '').trim().slice(0, 220) : '',
                        websiteFieldBlockedFirstComment,
                        reviewPending: !!reviewPendingMatch,
                        reviewPolicy: reviewPendingMatch?.reason || '',
                        submissionBlocked: !!submissionBlockedMatch,
                        submissionBlockReason: submissionBlockedMatch?.reason || '',
                        noticeExcerpt: (websiteFieldBlockedFirstComment || submissionBlockedMatch || reviewPendingMatch)
                            ? pageTextRaw.slice(0, 280)
                            : '',
                        pageUrl
                    };
                },
                args: [options]
            });

            lastResult = results?.[0]?.result || null;
            if (
                lastResult?.anchorVisible
                || lastResult?.commentLocated
                || lastResult?.websiteFieldBlockedFirstComment
                || lastResult?.submissionBlocked
                || lastResult?.reviewPending
            ) {
                return lastResult;
            }
        } catch {}
    }

    return lastResult;
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
        const resources = await getStoredResources();
        const result = await GoogleSheets.syncResources(settings.googleSheetId, resources);
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

function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

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

function normalizeHttpUrlBg(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function normalizeCollectedItems(items = [], urls = [], source = '') {
    const defaultSourceType = inferDefaultSourceType(source);
    const rawItems = Array.isArray(items) && items.length > 0
        ? items
        : (urls || []).map((url) => ({ url }));

    const seen = new Set();
    const normalized = [];

    for (const rawItem of rawItems) {
        const value = typeof rawItem === 'string' ? rawItem : rawItem?.url;
        if (!value) continue;
        const sourceType = resolveCollectedSourceType(source, rawItem?.sourceType || defaultSourceType);
        const normalizedUrl = normalizeSourceUrl(value, sourceType);
        if (!normalizedUrl) continue;
        const dedupeKey = `${normalizedUrl}@@${sourceType}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const sourceTier = SOURCE_TIERS.COMPETITOR_BACKLINK;
        normalized.push({
            url: normalizedUrl,
            sourceType,
            sourceTier,
            discoveryEdges: [
                buildDiscoveryEdge(
                    sourceTier,
                    'collector-backlink',
                    `${String(source || '').replace(/^my-/, '')}:${sourceType}`
                )
            ]
        });
    }

    return normalized;
}

function mergeCollectedItemList(existing = [], incoming = []) {
    const merged = [...(existing || [])];
    const seen = new Set(
        merged.map((item) => `${normalizeUrlBg(item.url)}@@${item.sourceType || 'ref-domain'}`)
    );

    for (const item of incoming || []) {
        const key = `${normalizeUrlBg(item.url)}@@${item.sourceType || 'ref-domain'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
    }

    return merged;
}

function mergeUrlList(existing = [], incoming = []) {
    const merged = [...(existing || [])];
    const seen = new Set(merged.map((value) => normalizeUrlBg(value)));
    for (const value of incoming || []) {
        const normalized = normalizeUrlBg(value);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        merged.push(value);
    }
    return merged;
}

function inferDefaultSourceType(source = '') {
    const baseSource = String(source || '').replace(/^my-/, '');
    if (baseSource === 'ahrefs') return 'backlink-page';
    return 'ref-domain';
}

function resolveCollectedSourceType(source = '', sourceType = 'ref-domain') {
    const baseSource = String(source || '').replace(/^my-/, '');
    if (baseSource === 'semrush') return 'ref-domain';
    return sourceType || inferDefaultSourceType(source);
}

function normalizeSourceUrl(url, sourceType = 'ref-domain') {
    try {
        const prepared = String(url || '').trim();
        if (!prepared) return '';
        const normalized = prepared.startsWith('http') ? prepared : `https://${prepared}`;
        const parsed = new URL(normalized);
        const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
        if (!hostname) return '';

        if (sourceType === 'ref-domain') {
            return `https://${hostname}/`;
        }

        const path = parsed.pathname.replace(/\/+$/, '') || '/';
        const search = parsed.search || '';
        return `https://${hostname}${path}${search}`;
    } catch {
        return '';
    }
}

function resolveCandidateType(sourceTypes = []) {
    const typeSet = new Set(sourceTypes || []);
    if (typeSet.has('backlink-page') && typeSet.has('ref-domain')) {
        return 'hybrid';
    }
    if (typeSet.has('backlink-page')) {
        return 'backlink-page';
    }
    return 'ref-domain';
}

function getSourceCode(source = '') {
    const baseSource = String(source || '').replace(/^my-/, '');
    switch (baseSource) {
        case 'ahrefs':
            return 'A';
        case 'semrush':
            return 'M';
        case 'similarweb':
            return 'W';
        default:
            return baseSource ? baseSource.charAt(0).toUpperCase() : 'U';
    }
}

function getAnalysisSeedScore(link = {}) {
    const sourceSet = new Set(link.sources || []);
    let score = (sourceSet.size || 0) * 20;
    if (link.candidateType === 'backlink-page') score += 90;
    if (link.candidateType === 'hybrid') score += 100;
    if (link.candidateType === 'ref-domain') score += 30;
    if (sourceSet.has('A')) score += 35;
    if (sourceSet.has('M')) score += 20;
    if (sourceSet.has('W')) score += 15;
    score += getSourceTierScore(link.sourceTier || '');
    return score;
}

function getAnalysisTargetScore(link = {}) {
    let score = getAnalysisSeedScore(link);
    if (link.analysisStage === 'direct-page') score += 40;
    if (link.analysisStage === 'domain-drilldown') score += 25;
    if (link.analysisStage === 'domain-homepage') score -= 10;
    score += Math.min((link.discoveryEdges || []).length * 2, 10);
    return score;
}

function getDomainBg(url) {
    try {
        if (!url.startsWith('http')) url = 'https://' + url;
        return new URL(url).hostname.replace(/^www\./, '');
    } catch { return ''; }
}

function getBestTemplateHostScore(host = '', siteTemplates = {}) {
    if (!host) return 0;

    let bestScore = 0;
    for (const template of Object.values(siteTemplates || {})) {
        if ((template?.host || '') !== host) continue;
        const score =
            Number(template.successCount || 0) * 18
            + Number(template.verifiedCount || 0) * 7
            - Number(template.failureCount || 0) * 4
            - Number(template.reviewPendingCount || 0) * 3
            - Number(template.blockedCount || 0) * 6;
        if (score > bestScore) bestScore = score;
    }

    return bestScore;
}

function getResourcePublishRankingScore(resource = {}, task = {}, siteTemplates = {}) {
    const basePriority = self.ResourceRules?.getPublishCandidatePriority?.(resource, task) || 0;
    const resourcePool = getResourcePool(resource);
    const resourceClass = self.ResourceRules?.getResourceClass?.(resource) || resource.resourceClass || 'weak';
    const frictionLevel = self.ResourceRules?.getResourceFrictionLevel?.(resource) || resource.frictionLevel || 'high';
    const hasWebsiteField = !!self.ResourceRules?.resourceSupportsWebsiteField?.(resource);
    const hasInlineSubmitForm = !!self.ResourceRules?.resourceHasInlineSubmitForm?.(resource);
    const hasCaptcha = !!self.ResourceRules?.resourceHasCaptcha?.(resource);
    const hasUrlField = !!self.ResourceRules?.resourceHasUrlField?.(resource);
    const directPublishReady = !!self.ResourceRules?.isDirectPublishReady?.(resource);
    const effectiveTier = getEffectiveResourceSourceTier(resource);
    const host = getDomainBg(resource.url || '');
    const templateScore = getBestTemplateHostScore(host, siteTemplates);
    const publishedSuccessCount = getResourcePublishedSuccessCount(resource);
    const anchorVerifiedCount = getResourceAnchorVerifiedCount(resource);
    const discoveryEdgeCount = (resource.discoveryEdges || []).length;
    const sourceEvidence = resource.sourceEvidence || {};
    const taskHistoryEntry = getResourcePublishHistoryEntry(resource, getTaskPublishTarget(task));
    const failureRecovery = taskHistoryEntry?.lastStatus === 'failed'
        ? getPublishFailureRecoveryPolicy(taskHistoryEntry?.publishMeta || {}, taskHistoryEntry)
        : null;
    const blockedPenalty = Number(resource.publishMeta?.submissionBlocked ? 1 : 0)
        + Number(resource.publishMeta?.websiteFieldBlockedFirstComment ? 1 : 0);
    const reviewPenalty = Number(resource.publishMeta?.reviewPending ? 1 : 0);
    const recencyScore = Number(new Date(resource.publishedAt || resource.discoveredAt || 0).getTime() || 0) / 1e11;
    const classScoreMap = {
        'blog-comment': 2800,
        profile: 1900,
        'inline-comment': 1600,
        weak: 0
    };
    const frictionScoreMap = {
        low: 3800,
        medium: 1200,
        high: -2200
    };

    let score = basePriority * 1e6;
    if (resourcePool === RESOURCE_POOLS.MAIN) score += 5200;
    if (resourcePool === RESOURCE_POOLS.LEGACY) score -= 1200;
    if (resourcePool === RESOURCE_POOLS.QUARANTINE) score -= 18000;
    score += getSourceTierScore(effectiveTier) * 1e4;
    score += publishedSuccessCount * 3500;
    score += anchorVerifiedCount * 5200;
    score += Number(classScoreMap[resourceClass] || 0);
    score += Number(frictionScoreMap[frictionLevel] || 0);
    if (directPublishReady) score += 2600;
    if (hasWebsiteField) score += 2400;
    if (hasUrlField) score += 1100;
    if (hasInlineSubmitForm) score += 1700;
    if (hasCaptcha) score -= 2800;
    score += Math.min(templateScore, 80) * 120;
    score += Math.min(discoveryEdgeCount, 8) * 90;
    score += Number(sourceEvidence.commentObserved || 0) * 240;
    score += Number(sourceEvidence.competitorBacklink || 0) * 120;
    score -= blockedPenalty * 1800;
    score -= reviewPenalty * 750;
    if (failureRecovery?.retryable) {
        score -= 4200 + Math.min(Number(failureRecovery.failedAttempts || 0), 6) * 1200;
    } else if (taskHistoryEntry?.lastStatus === 'failed') {
        score -= 12000;
    }
    score += recencyScore;

    return Math.round(score);
}

function getAutoPublishTaskScore(summary = {}) {
    let score = Number(summary.topScore || 0);
    score += Math.min(Number(summary.readyCount || 0), 40) * 800;
    score += Math.min(Number(summary.verifiedCount || 0), 12) * 1200;
    score += Math.min(Number(summary.commentObservedCount || 0), 12) * 220;
    if (summary.commentStyle === 'anchor-html') {
        score += 1600;
    } else if (summary.commentStyle === 'anchor-prefer') {
        score += 900;
    }
    return Math.round(score);
}

function buildDurationSummary(values = []) {
    const durations = (values || [])
        .map((value) => Number(value || 0))
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((left, right) => left - right);
    if (durations.length === 0) {
        return { count: 0, p50: 0, p90: 0, avg: 0 };
    }

    const getPercentile = (ratio) => {
        const index = Math.min(durations.length - 1, Math.max(0, Math.ceil(durations.length * ratio) - 1));
        return Math.round(durations[index] || 0);
    };

    const avg = durations.reduce((total, value) => total + value, 0) / durations.length;
    return {
        count: durations.length,
        p50: getPercentile(0.5),
        p90: getPercentile(0.9),
        avg: Math.round(avg)
    };
}

async function getPublishInsights() {
    const attempts = await self.PublishMemory?.getPublishAttempts?.() || [];
    const templates = await self.PublishMemory?.getSiteTemplates?.() || {};
    const resources = await getStoredResources();

    const standardAttempts = attempts.filter((attempt) => !['anchor-html', 'anchor-prefer'].includes(attempt.commentStyle));
    const anchorAttempts = attempts.filter((attempt) => ['anchor-html', 'anchor-prefer'].includes(attempt.commentStyle));
    const commentVerifiedAttempts = attempts.filter((attempt) => attempt.commentFieldVerified);
    const anchorVisibleAttempts = attempts.filter((attempt) => attempt.anchorVisible);
    const reviewPendingAttempts = attempts.filter((attempt) => attempt.reviewPending);

    const blockedReasons = Object.entries(attempts.reduce((map, attempt) => {
        const reason = compactText(attempt.submissionBlockReason || '');
        if (!reason) return map;
        map[reason] = Number(map[reason] || 0) + 1;
        return map;
    }, {}))
        .sort((left, right) => right[1] - left[1])
        .slice(0, 8)
        .map(([reason, count]) => ({ reason, count }));

    const linkModes = Object.entries(attempts.reduce((map, attempt) => {
        const mode = compactText(attempt.linkMode || 'unknown');
        map[mode] = Number(map[mode] || 0) + 1;
        return map;
    }, {}))
        .sort((left, right) => right[1] - left[1])
        .slice(0, 8)
        .map(([mode, count]) => ({ mode, count }));

    const sourceTierCounts = Object.entries(resources.reduce((map, resource) => {
        const tier = getEffectiveResourceSourceTier(resource) || 'unknown';
        map[tier] = Number(map[tier] || 0) + 1;
        return map;
    }, {}))
        .sort((left, right) => right[1] - left[1])
        .map(([tier, count]) => ({ tier, count }));
    const resourcePoolCounts = countResourcesByPool(resources);

    return {
        generatedAt: new Date().toISOString(),
        attempts: {
            total: attempts.length,
            published: attempts.filter((attempt) => attempt.status === 'published').length,
            failed: attempts.filter((attempt) => attempt.status === 'failed').length,
            skipped: attempts.filter((attempt) => attempt.status === 'skipped').length,
            pendingReview: reviewPendingAttempts.length
        },
        quality: {
            commentFieldVerifiedRate: attempts.length ? Math.round((commentVerifiedAttempts.length / attempts.length) * 1000) / 10 : 0,
            anchorVisibleRate: attempts.length ? Math.round((anchorVisibleAttempts.length / attempts.length) * 1000) / 10 : 0,
            reviewPendingRate: attempts.length ? Math.round((reviewPendingAttempts.length / attempts.length) * 1000) / 10 : 0
        },
        speed: {
            standard: buildDurationSummary(standardAttempts.map((attempt) => attempt.durationMs)),
            anchor: buildDurationSummary(anchorAttempts.map((attempt) => attempt.durationMs))
        },
        resources: {
            total: resources.length,
            pending: countPendingOperationalResources(resources),
            published: resources.filter((resource) => resource.status === 'published').length,
            sourceTiers: sourceTierCounts,
            pools: resourcePoolCounts
        },
        templates: {
            total: Object.keys(templates || {}).length,
            avoidWebsiteField: Object.values(templates || {}).filter((template) =>
                Number(template.websiteFieldBlockedCount || 0) >= Number(template.successCount || 0)
                && Number(template.websiteFieldBlockedCount || 0) > 0
            ).length
        },
        blockers: blockedReasons,
        linkModes
    };
}

function isAutoPublishTask(task = {}) {
    return getTaskType(task) === 'publish'
        && task.workflowId === 'blog-comment-backlink'
        && task.mode === 'full-auto'
        && !task.autoDispatchPaused
        && !!compactText(task.website || task.anchorUrl || '');
}

function summarizeAutoPublishTask(task = {}, resources = [], policies = {}, siteTemplates = {}) {
    if (!isAutoPublishTask(task)) return null;

    const workflow = getPublishWorkflow(task);
    const readyResources = (resources || [])
        .filter((resource) =>
            canPublishResourceForTask(resource, task)
            && WorkflowRegistry.supportsResource(workflow, resource, task)
            && !isResourceCoolingDown(resource, policies)
        );
    const dispatchSelection = selectDispatchResources(readyResources);
    const selectedResources = (dispatchSelection.resources || [])
        .map((resource) => ({
            resource,
            score: getResourcePublishRankingScore(resource, task, siteTemplates)
        }))
        .sort((left, right) => right.score - left.score);

    if (selectedResources.length === 0) return null;

    const top = selectedResources[0];
    const topResource = top?.resource || {};
    const topSourceEvidence = topResource.sourceEvidence || {};
    const summary = {
        task,
        readyCount: selectedResources.length,
        poolCounts: dispatchSelection.counts,
        activePool: dispatchSelection.activePool || '',
        topScore: Number(top?.score || 0),
        topResourceId: topResource.id || '',
        topResourceUrl: topResource.url || '',
        verifiedCount: getResourceAnchorVerifiedCount(topResource),
        commentObservedCount: Number(topSourceEvidence.commentObserved || 0),
        commentStyle: task.commentStyle || 'standard'
    };
    summary.dispatchScore = getAutoPublishTaskScore(summary);
    return summary;
}

function scheduleAutoPublishDispatch(reason = 'resource-update', delayMs = 1200) {
    if (isPublishBatchRunning()) {
        return;
    }
    if (autoPublishDispatchTimer) {
        clearTimeout(autoPublishDispatchTimer);
    }
    autoPublishDispatchTimer = setTimeout(() => {
        autoPublishDispatchTimer = null;
        runAutoPublishDispatch({ reason }).catch(async (error) => {
            await Logger.error(`自动发布调度失败: ${error.message}`, { reason });
        });
    }, Math.max(200, Number(delayMs || 0)));
}

async function runAutoPublishDispatch(options = {}) {
    if (autoPublishDispatchRunning) {
        return { success: false, code: 'auto_dispatch_running', message: '自动调度已在执行中。' };
    }

    autoPublishDispatchRunning = true;
    try {
        await ensurePublishSessionsLoaded();
        await ensurePublishBatchStateLoaded();
        if (isPublishBatchRunning()) {
            return { success: false, code: 'publish_batch_busy', message: '批量发布进行中，自动调度暂不接管。' };
        }
        const sessionView = getPublishStateView();
        if (sessionView.isPublishing) {
            return { success: false, code: 'publish_session_busy', message: '当前已有发布任务在运行。' };
        }

        const [tasks, resources, policies, siteTemplates] = await Promise.all([
            TaskStore.getTasks(),
            getStoredResources(),
            getAllDomainPublishPolicies(),
            self.PublishMemory?.getSiteTemplates?.() || {}
        ]);

        const candidates = (tasks || [])
            .map((task) => summarizeAutoPublishTask(task, resources, policies, siteTemplates))
            .filter(Boolean)
            .sort((left, right) => right.dispatchScore - left.dispatchScore);

        const nextTask = candidates[0];
        if (!nextTask) {
            return { success: false, code: 'no_auto_publish_task', message: '当前没有可自动接力的全自动发布任务。' };
        }

        await Logger.publish('自动调度命中下一条发布任务', {
            reason: options.reason || '',
            taskId: nextTask.task.id || '',
            taskName: nextTask.task.name || nextTask.task.website || '',
            readyCount: nextTask.readyCount,
            topResourceUrl: nextTask.topResourceUrl
        });

        return await startPublish(nextTask.task, { autoDispatch: true });
    } finally {
        autoPublishDispatchRunning = false;
    }
}

async function getSettings() {
    if (typeof LocalDB !== 'undefined' && typeof LocalDB.getSettings === 'function') {
        try {
            if (typeof LocalDB.migrateFromChromeStorage === 'function') {
                await LocalDB.migrateFromChromeStorage({ clearLegacy: true });
            }
            const settings = await LocalDB.getSettings();
            if (settings && typeof settings === 'object' && Object.keys(settings).length > 0) {
                return settings;
            }
        } catch {}
    }
    return new Promise((resolve) => {
        chrome.storage.local.get('settings', (data) => {
            resolve(data.settings || {});
        });
    });
}

async function getDomainPublishPolicy(url) {
    const domain = getDomainBg(url);
    if (!domain) return {};

    if (typeof LocalDB !== 'undefined' && typeof LocalDB.getDomainPublishPolicies === 'function') {
        try {
            if (typeof LocalDB.migrateFromChromeStorage === 'function') {
                await LocalDB.migrateFromChromeStorage({ clearLegacy: true });
            }
            const policies = await LocalDB.getDomainPublishPolicies();
            if (policies && Object.keys(policies).length > 0) {
                return policies?.[domain] || {};
            }
        } catch {}
    }

    const data = await chrome.storage.local.get('domainPublishPolicies');
    return data.domainPublishPolicies?.[domain] || {};
}

async function getAllDomainPublishPolicies() {
    if (typeof LocalDB !== 'undefined' && typeof LocalDB.getDomainPublishPolicies === 'function') {
        try {
            if (typeof LocalDB.migrateFromChromeStorage === 'function') {
                await LocalDB.migrateFromChromeStorage({ clearLegacy: true });
            }
            const policies = await LocalDB.getDomainPublishPolicies();
            if (policies && Object.keys(policies).length > 0) {
                return policies;
            }
        } catch {}
    }
    const data = await chrome.storage.local.get('domainPublishPolicies');
    return data.domainPublishPolicies || {};
}

async function setDomainPublishPolicy(url, patch = {}) {
    const domain = getDomainBg(url);
    if (!domain) return;

    let policies = {};
    if (typeof LocalDB !== 'undefined' && typeof LocalDB.getDomainPublishPolicies === 'function') {
        try {
            policies = await LocalDB.getDomainPublishPolicies();
        } catch {
            policies = {};
        }
    } else {
        const data = await chrome.storage.local.get('domainPublishPolicies');
        policies = data.domainPublishPolicies || {};
    }
    policies[domain] = {
        ...(policies[domain] || {}),
        ...patch
    };
    if (typeof LocalDB !== 'undefined' && typeof LocalDB.setDomainPublishPolicies === 'function') {
        try {
            await LocalDB.setDomainPublishPolicies(policies);
            await chrome.storage.local.remove('domainPublishPolicies');
            return;
        } catch {}
    }
    await chrome.storage.local.set({ domainPublishPolicies: policies });
}

function getDomainCooldownState(policy = {}, now = Date.now()) {
    const cooldownUntilRaw = policy?.cooldownUntil || '';
    if (!cooldownUntilRaw) {
        return { active: false, remainingMs: 0, cooldownUntil: '' };
    }

    const cooldownUntilMs = new Date(cooldownUntilRaw).getTime();
    if (!Number.isFinite(cooldownUntilMs) || cooldownUntilMs <= now) {
        return { active: false, remainingMs: 0, cooldownUntil: cooldownUntilRaw };
    }

    return {
        active: true,
        remainingMs: cooldownUntilMs - now,
        cooldownUntil: cooldownUntilRaw
    };
}

function isResourceCoolingDown(resource, policies = {}, now = Date.now()) {
    const domain = getDomainBg(resource?.url || '');
    if (!domain) return false;
    return getDomainCooldownState(policies?.[domain] || {}, now).active;
}

async function rebalanceCooldownQueue(taskId) {
    const session = getPublishSessionState(taskId);
    if (!session.isPublishing || session.currentIndex >= session.queue.length) {
        return { moved: 0, blocked: false, cooldownUntil: '' };
    }

    const policies = await getAllDomainPublishPolicies();
    const now = Date.now();
    let moved = 0;
    let scanned = 0;
    let earliestCooldownUntil = '';
    const queue = [...session.queue];
    const currentIndex = session.currentIndex;
    const remaining = queue.length - currentIndex;

    while (currentIndex < queue.length && scanned < remaining) {
        const resource = queue[currentIndex];
        const domain = getDomainBg(resource?.url || '');
        const policy = policies?.[domain] || {};
        const cooldownState = getDomainCooldownState(policy, now);
        if (!cooldownState.active) {
            break;
        }

        if (!earliestCooldownUntil || new Date(cooldownState.cooldownUntil).getTime() < new Date(earliestCooldownUntil).getTime()) {
            earliestCooldownUntil = cooldownState.cooldownUntil;
        }

        const [current] = queue.splice(currentIndex, 1);
        if (current) {
            queue.push(current);
            moved++;
        }
        scanned++;
    }

    if (moved > 0) {
        updatePublishSessionState(taskId, { queue });
    }

    return {
        moved,
        blocked: scanned >= remaining && remaining > 0,
        cooldownUntil: earliestCooldownUntil
    };
}

function moveCurrentResourceToQueueTail(taskId) {
    const session = getPublishSessionState(taskId);
    if (!session.queue?.length || session.currentIndex >= session.queue.length) return;
    const queue = [...session.queue];
    const [current] = queue.splice(session.currentIndex, 1);
    if (current) {
        queue.push(current);
        updatePublishSessionState(taskId, { queue });
    }
}

async function persistCollectSnapshot() {
    await StateStore.saveCollectSnapshot({
        collectState: {
            isCollecting: collectState.isCollecting,
            domain: collectState.domain,
            myDomain: collectState.myDomain,
            sources: collectState.sources || []
        },
        collectStats: collectState.stats
    });
}

async function getPersistedCollectView() {
    return await StateStore.loadCollectView(collectState.stats, collectState.isCollecting);
}

function broadcastStats() {
    persistCollectSnapshot().catch(() => {});
    broadcastToPopup({ action: 'statsUpdate', stats: collectState.stats });
}

function broadcastToPopup(msg) {
    chrome.runtime.sendMessage(msg).catch(() => {});
}

function waitForTabLoad(tabId) {
    return new Promise(async (resolve) => {
        let settled = false;
        let intervalId = null;
        let timeoutId = null;
        const settle = () => {
            if (settled) return;
            settled = true;
            if (intervalId) clearInterval(intervalId);
            if (timeoutId) clearTimeout(timeoutId);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
        };

        try {
            const existingTab = await chrome.tabs.get(tabId);
            if (existingTab?.status === 'complete') {
                setTimeout(settle, 350);
                return;
            }
        } catch {}

        async function probeReadyState() {
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: () => ({
                        readyState: document.readyState,
                        hasBody: !!document.body,
                        hasMain: !!document.querySelector('main, article, form, body *')
                    })
                });
                const state = results?.[0]?.result || {};
                if (state.hasBody && state.hasMain && state.readyState && state.readyState !== 'loading') {
                    settle();
                }
            } catch {}
        }

        function listener(id, changeInfo) {
            if (id === tabId && changeInfo.status === 'complete') {
                setTimeout(settle, 350);
            }
        }

        chrome.tabs.onUpdated.addListener(listener);
        intervalId = setInterval(() => {
            probeReadyState().catch(() => {});
        }, 450);
        probeReadyState().catch(() => {});
        timeoutId = setTimeout(settle, 25000);
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
