/**
 * Background Service Worker - V3
 * AI 驱动 + 递归发现 + 多任务发布 + 日志 + Google Sheets
 */

// 导入模块
importScripts(
    'core/bg-utils.js',
    'core/domain-intel.js',
    'core/anchor-verifier.js',
    'core/auto-publish-dispatch.js',
    'marketing/marketing-research.js',
    'marketing/marketing-planner.js',
    'marketing/marketing-engine.js',
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
    'core/publish-session.js',
    'core/collection-flow.js',
    'core/publish-flow.js',
    'marketing/marketing-orchestrator.js',
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
    DOMAIN_RATE_LIMIT_COOLDOWN_MS: 0,
    RETRYABLE_FAILURE_COOLDOWN_MS: 0,
    UNKNOWN_FAILURE_COOLDOWN_MS: 0,
    RETRYABLE_FAILURE_MAX_ATTEMPTS: 3
};

const STORAGE_STRATEGY = {
    RESOURCE_HISTORY_LIMIT: 6,
    RESOURCE_URL_LIMIT: 260,
    RESOURCE_TITLE_LIMIT: 140,
    RESOURCE_DETAIL_LIMIT: 4,
    RESOURCE_DETAIL_TEXT_LIMIT: 80,
    RESOURCE_QUOTA_RETRY_LIMITS: [20000, 15000, 10000, 5000]
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
    DISPATCH_MS: 35000,
    SUBMISSION_MS: 20000
};

const PUBLISH_STAGE_WATCHDOG_MS = {
    bootstrap: 20000,
    preflight: 18000,
    finding_form: 25000,
    form_detected: 12000,
    generating_comment: 15000,
    comment_ready: 10000,
    filling_form: 50000,
    form_filled: 10000,
    pre_submit: 10000,
    submitting: 20000
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
const publishRetryTimers = new Map();
let autoPublishControlState = createDefaultAutoPublishControlState();
let autoPublishControlLoaded = false;
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
        autoPublishDispatch.clearTimer();
    }
});

const domainIntel = DomainIntel.create({
    FrontierScheduler,
    StateStore,
    getDomain: getDomainBg,
    mergeStringArrays,
    mergeSourceTierArrays,
    preferHigherSourceTier,
    mergeDiscoveryEdges,
    buildDiscoveryEdge,
    buildDomainProfileFromHtml,
    calculateDomainQualityScore,
    SOURCE_TIERS,
    getCollectState: () => collectState,
    getContinuousSeedDomain: () => continuousDiscoveryState.seedDomain,
    getContinuousMyDomain: () => continuousDiscoveryState.myDomain
});

const marketingEngine = MarketingEngine.create({
    openOrReuseMarketingTab,
    delay,
    TaskStore,
    Logger,
    AIEngine,
    getDomainBg,
    normalizeHttpUrlBg,
    compactText,
    WorkflowRegistry,
    getNurtureAlarmName,
    computeNextNurtureRunAt,
    syncTaskSchedule
});

const autoPublishDispatch = AutoPublishDispatch.create({
    getTaskType,
    getPublishWorkflow,
    canPublishResourceForTask,
    WorkflowRegistry,
    getResourcePool,
    selectDispatchResources,
    getAllDomainPublishPolicies,
    isResourceCoolingDown,
    getResourcePublishRankingScore,
    getEffectiveResourceSourceTier,
    getResourceAnchorVerifiedCount,
    getSourceTierScore,
    isPublishBatchRunning,
    getPublishStateView,
    getAutoPublishControlState,
    setManualPublishFocusTask,
    startPublish: (task, options) => startPublish(task, options),
    TaskStore,
    Logger,
    PublishMemory: self.PublishMemory,
    compactText,
    ensurePublishSessionsLoaded,
    ensurePublishBatchStateLoaded,
    ensureAutoPublishControlLoaded,
    getStoredResources,
    broadcastToPopup
});

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
    // Recover stalled batch publish after service worker restart (e.g., after sleep)
    try {
        await publishBatchRuntime.ensureLoaded();
        if (publishBatchRuntime.isRunning()) {
            publishBatchRuntime.scheduleAdvance('service-worker-restart', 2000);
        }
    } catch {}
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
    if (alarm.name === publishBatchRuntime.WATCHDOG_ALARM_NAME) {
        publishBatchRuntime.handleWatchdogAlarm().catch(() => {});
        return;
    }
    if (alarm.name.startsWith('nurture:')) {
        handleNurtureAlarm(alarm.name.slice('nurture:'.length)).catch(() => {});
        return;
    }
    if (alarm.name.startsWith('marketing-refresh:')) {
        handleMarketingRefreshAlarm(alarm.name.slice('marketing-refresh:'.length)).catch(() => {});
        return;
    }
    // 发布看门狗 alarm 兜底（Service Worker 休眠后 setTimeout 丢失时的最后防线）
    if (alarm.name.startsWith('publish-watchdog-')) {
        const taskId = alarm.name.slice('publish-watchdog-'.length);
        handlePublishWatchdogAlarm(taskId).catch((e) => {
            console.error('[Watchdog Alarm] Error:', e);
        });
        return;
    }
}

async function handlePublishWatchdogAlarm(taskId) {
    if (!taskId) return;

    // 如果 setTimeout 看门狗已经处理过了，alarm 不重复处理
    if (publishWatchdogs.has(taskId)) return;

    await ensurePublishSessionsLoaded();
    const session = getPublishSessionState(taskId);
    if (!session.isPublishing || session.awaitingManualContinue) return;

    const activeResourceId = session.queue?.[session.currentIndex]?.id || '';
    if (!activeResourceId) return;

    // 读取 alarm 元数据
    const metaKey = `watchdog-meta-${taskId}`;
    const metaData = await chrome.storage.session.get(metaKey);
    const meta = metaData[metaKey] || {};
    await chrome.storage.session.remove(metaKey).catch(() => {});

    await Logger.error('发布看门狗 Alarm 兜底触发（Service Worker 曾休眠）', {
        taskId,
        resourceId: activeResourceId,
        currentUrl: session.currentUrl || meta.currentUrl || ''
    });

    // 注入提示，2 秒硬超时；卡死则强制重置 tab
    const tabId = session.currentTabId;
    if (tabId) {
        const toastShown = await tryShowFailureToastInTab(tabId, '发布失败：页面长时间无响应（已自动恢复）', 2000);
        if (toastShown) {
            await new Promise(r => setTimeout(r, 3200));
        } else {
            await resetHungTab(tabId);
        }
    }

    await handleCommentAction(activeResourceId, 'failed', taskId, {
        reportedVia: 'alarm-watchdog',
        submissionBlocked: true,
        submissionBlockReason: 'service-worker-sleep-recovery'
    }, session.sessionId || '');
}

function handleWindowRemoved(windowId) {
    if (windowId === panelWindowId) panelWindowId = null;
}

async function handleTabRemoved(tabId) {
    if (tabId === collectTabId) {
        collectTabId = null;
    }
    if (tabId === marketingExecutionTabId) {
        marketingExecutionTabId = null;
    }
    let changed = false;
    const interruptedTaskIds = [];
    for (const [taskId, session] of Object.entries(publishSessions || {})) {
        if (tabId === session.currentTabId) {
            clearPublishWatchdog(taskId);
            clearPublishRetry(taskId);
            publishSessions[taskId] = {
                ...TaskManager.createDefaultPublishState(),
                stopRequested: true
            };
            interruptedTaskIds.push(taskId);
            changed = true;
        }
        if (tabId === session.pendingSubmission?.tabId) {
            publishSessions[taskId] = { ...publishSessions[taskId], pendingSubmission: null };
            changed = true;
        }
    }
    if (changed) {
        try {
            await flushPublishSessions();
        } catch {}
    }
    if (interruptedTaskIds.length > 0) {
        interruptedTaskIds.forEach((taskId) => {
            broadcastToPopup({ action: 'publishDone', taskId });
        });
        schedulePublishBatchAdvance('publish-tab-closed', 400);
        autoPublishDispatch.schedule('publish-tab-closed', 700);
    }
}

function handleTabUpdated(tabId, changeInfo) {
    if (changeInfo.status !== 'complete') return;
    // 检查 pendingSubmission（表单已提交，等待页面跳转完成）
    const pendingTaskId = findPublishSessionTaskIdByPendingTab(tabId);
    if (pendingTaskId) {
        finalizePendingSubmissionFromNavigation(pendingTaskId, tabId);
        return;
    }
    // 检查 currentTabId — 表单提交后页面 POST redirect，content script 被销毁
    const currentTaskId = findPublishSessionTaskIdByCurrentTab(tabId);
    if (currentTaskId) {
        const session = getPublishSessionState(currentTaskId);
        if (session.isPublishing && !session.awaitingManualContinue) {
            const activeResource = session.queue?.[session.currentIndex];
            if (!activeResource) return;

            // 只有在表单已提交（commentSubmitting 已收到）后才触发导航验证
            // 避免页面初次加载时误判为失败
            const currentStage = session.currentStage || '';
            if (!currentStage || currentStage === 'dispatch' || currentStage === 'waiting_lease') {
                return;
            }
            // 还在填写阶段（content script 仍在工作），不要触发导航验证
            if (['bootstrap', 'preflight', 'finding_form', 'form_detected', 'generating_comment',
                 'comment_ready', 'filling_form', 'form_filled', 'pre_submit'].includes(currentStage)) {
                return;
            }

            // 注入验证脚本：检查评论是否真的出现在页面上
            chrome.scripting.executeScript({
                target: { tabId },
                func: (commenterName, websiteUrl) => {
                    // 滚到评论区底部
                    const commentSection = document.querySelector('#comments, .comments-area, .comment-list, ol.commentlist');
                    if (commentSection) {
                        commentSection.scrollIntoView({ behavior: 'auto', block: 'end' });
                    } else {
                        window.scrollTo(0, document.body.scrollHeight);
                    }

                    // 检查是否有我们的评论
                    const allComments = document.querySelectorAll('.comment-body, li.comment, .comment-content, .comment');
                    let found = false;
                    let reviewPending = false;

                    for (const c of allComments) {
                        const text = (c.textContent || '').toLowerCase();
                        const links = c.querySelectorAll('a[href]');
                        for (const link of links) {
                            if (websiteUrl && link.href.includes(websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''))) {
                                found = true;
                                break;
                            }
                        }
                        if (commenterName && text.includes(commenterName.toLowerCase())) {
                            found = true;
                        }
                        if (found) break;
                    }

                    // 检查是否显示审核提示
                    const pageText = document.body.textContent || '';
                    if (/awaiting moderation|pending review|comment is awaiting|en attente de modération|pendiente de moderación|aguardando moderação/i.test(pageText)) {
                        reviewPending = true;
                        found = true; // 审核中也算提交成功
                    }

                    return { found, reviewPending, url: location.href, commentCount: allComments.length };
                },
                args: [
                    session.currentTask?.name_commenter || '',
                    session.currentTask?.website || ''
                ]
            }).then((results) => {
                const verification = results?.[0]?.result;
                if (verification) {
                    handleCommentAction(activeResource.id, verification.found ? 'published' : 'failed', currentTaskId, {
                        reportedVia: 'tab-navigation-verify',
                        pageUrlAfterSubmit: verification.url,
                        commentLocated: verification.found,
                        reviewPending: verification.reviewPending,
                        submissionBlocked: !verification.found
                    }, session.sessionId || '');
                }
            }).catch(() => {
                // 脚本注入失败，根据 URL 判断
                chrome.tabs.get(tabId).then((tab) => {
                    const url = tab?.url || '';
                    const likelySuccess = url.includes('#comment-');
                    handleCommentAction(activeResource.id, likelySuccess ? 'published' : 'failed', currentTaskId, {
                        reportedVia: 'tab-navigation-fallback',
                        pageUrlAfterSubmit: url
                    }, session.sessionId || '');
                }).catch(() => {});
            });
        }
    }
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

function createDefaultAutoPublishControlState() {
    return {
        manualFocusTaskId: '',
        updatedAt: '',
        reason: ''
    };
}

// === Publish sessions: see core/publish-session.js ===

function acquirePublishLease(taskId, resource = {}, options = {}) {
    if (!taskId || !resource?.id) {
        return { success: false, code: 'invalid_publish_lease' };
    }

    const session = getPublishSessionState(taskId);
    const sessionId = compactText(options.sessionId || session.sessionId || '');
    const currentLease = session.currentLease || null;
    if (
        currentLease
        && compactText(currentLease.sessionId || '') === sessionId
        && compactText(currentLease.resourceId || '') === compactText(resource.id || '')
    ) {
        return { success: true, lease: currentLease };
    }

    const conflict = getPublishLeaseConflict(taskId, sessionId, resource);
    if (conflict) {
        return { success: false, code: 'publish_lease_conflict', conflict };
    }

    const lease = {
        taskId,
        sessionId,
        resourceId: compactText(resource.id || ''),
        url: compactText(resource.url || ''),
        domain: getDomainBg(resource.url || ''),
        acquiredAt: new Date().toISOString()
    };

    updatePublishSessionState(taskId, {
        currentLease: lease,
        nextRetryAt: '',
        waitingReason: ''
    });

    return { success: true, lease };
}

function releasePublishLease(taskId, options = {}) {
    if (!taskId) return false;
    const session = getPublishSessionState(taskId);
    const lease = session.currentLease || null;
    if (!lease) return false;

    const sessionId = compactText(options.sessionId || '');
    const resourceId = compactText(options.resourceId || '');
    if (sessionId && compactText(lease.sessionId || '') !== sessionId) {
        return false;
    }
    if (resourceId && compactText(lease.resourceId || '') !== resourceId) {
        return false;
    }

    updatePublishSessionState(taskId, {
        currentLease: null,
        nextRetryAt: '',
        waitingReason: ''
    });
    return true;
}

function clearPublishWatchdog(taskId) {
    const timer = publishWatchdogs.get(taskId);
    if (timer) {
        clearTimeout(timer);
        publishWatchdogs.delete(taskId);
    }
    // 同时清除 alarm 兜底
    chrome.alarms.clear(`publish-watchdog-${taskId}`).catch(() => {});
}

// 在 tab 里显示一个红色 toast，但带 2 秒硬超时
// 用于看门狗超时时通知用户。如果 tab 卡死（"页面无响应"），不浪费时间等，直接跳过
async function tryShowFailureToastInTab(tabId, msg, injectTimeoutMs = 2000) {
    if (!tabId) return false;
    try {
        await Promise.race([
            chrome.scripting.executeScript({
                target: { tabId },
                func: (m) => {
                    const overlay = document.createElement('div');
                    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999998;';
                    const toast = document.createElement('div');
                    toast.innerHTML = '<div style="font-size:28px;margin-bottom:8px;">⚠️</div><div style="font-size:18px;font-weight:600;line-height:1.5;">' + m.replace(/</g, '&lt;') + '</div><div style="font-size:13px;color:rgba(255,255,255,0.7);margin-top:10px;">3 秒后自动继续...</div>';
                    toast.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;background:#dc2626;color:white;padding:30px 40px;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.4);text-align:center;min-width:320px;max-width:500px;';
                    document.body.appendChild(overlay);
                    document.body.appendChild(toast);
                    setTimeout(() => { overlay.remove(); toast.remove(); }, 3000);
                },
                args: [msg]
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('toast-inject-timeout')), injectTimeoutMs))
        ]);
        return true;
    } catch {
        return false;
    }
}

// 卡死的 tab 强制重置：navigate 到 about:blank 让 Chrome 杀掉旧 renderer，
// 下一个资源派发时再 navigate 到新 URL 就能顺利加载
async function resetHungTab(tabId) {
    if (!tabId) return;
    try {
        await Promise.race([
            chrome.tabs.update(tabId, { url: 'about:blank' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('tab-reset-timeout')), 2500))
        ]);
    } catch {}
}

function schedulePublishWatchdog(taskId, options = {}) {
    if (!taskId || !options.resourceId) return;

    clearPublishWatchdog(taskId);

    // 用 chrome.alarms 做硬性兜底（不受 Service Worker 休眠影响）
    // alarm 比 setTimeout 多 15 秒，给 setTimeout 优先触发的机会
    const alarmDelayMs = Math.max(30000, (Number(options.timeoutMs || 0) || PUBLISH_WATCHDOG.DISPATCH_MS) + 15000);
    chrome.alarms.create(`publish-watchdog-${taskId}`, {
        delayInMinutes: alarmDelayMs / 60000
    });
    // 保存 alarm 元数据供 onAlarm 回调使用
    chrome.storage.session.set({
        [`watchdog-meta-${taskId}`]: {
            resourceId: options.resourceId,
            stage: options.stage || 'dispatch',
            currentUrl: options.currentUrl || '',
            sessionId: options.sessionId || '',
            createdAt: Date.now()
        }
    }).catch(() => {});

    const stage = options.stage || 'dispatch';
    const timeoutMs = Number(options.timeoutMs || 0) || (stage === 'submission' ? PUBLISH_WATCHDOG.SUBMISSION_MS : PUBLISH_WATCHDOG.DISPATCH_MS);
    const resourceId = options.resourceId;
    const currentUrl = options.currentUrl || '';
    const sessionId = compactText(options.sessionId || '');

    const timer = setTimeout(async () => {
        publishWatchdogs.delete(taskId);

        try {
            await ensurePublishSessionsLoaded();
            const session = getPublishSessionState(taskId);
            const activeResourceId = session.queue?.[session.currentIndex]?.id || '';
            const pendingResourceId = session.pendingSubmission?.resourceId || '';
            const activeSessionId = compactText(session.sessionId || '');

            if (!session.isPublishing || session.awaitingManualContinue) return;
            if (sessionId && activeSessionId && sessionId !== activeSessionId) return;
            if (stage === 'dispatch' && activeResourceId !== resourceId) return;
            if (stage === 'submission' && pendingResourceId !== resourceId) return;

            await Logger.error('发布任务超时，已自动跳过当前资源', {
                taskId,
                resourceId,
                stage,
                currentUrl
            });

            // 向当前 Tab 注入红色 toast 提示，但带 2 秒硬超时
            // 如果 tab 卡死（Chrome "页面无响应"），跳过 toast 直接进入失败处理
            const sessionForTab = getPublishSessionState(taskId);
            const hungTabId = sessionForTab.currentTabId;
            if (hungTabId) {
                const timeoutMsg = `发布失败：操作超时（${stage === 'submission' ? '提交后等待确认超时' : '页面响应太慢'}）`;
                const toastShown = await tryShowFailureToastInTab(hungTabId, timeoutMsg, 2000);
                if (toastShown) {
                    await new Promise(r => setTimeout(r, 3200));
                } else {
                    // tab 没响应，强制重置释放卡死的 renderer
                    await resetHungTab(hungTabId);
                }
            }

            await handleCommentAction(resourceId, 'failed', taskId, {
                reportedVia: 'watchdog',
                watchdogStage: stage,
                submissionBlocked: true,
                submissionBlockReason: stage === 'submission'
                    ? 'submit-confirm-timeout'
                    : 'publish-runtime-timeout'
            }, sessionId);
        } catch (e) {
            console.error('[Watchdog] handleCommentAction failed:', e);
            await Logger.error('看门狗处理失败', { taskId, resourceId, error: e.message });
        }
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

    const pendingDomains = domainIntel.getCache().frontier.filter((entry) => {
        const domain = entry.domain || '';
        if (!domain) return false;
        if (domain === getDomainBg(continuousDiscoveryState.seedDomain || '')) return false;
        if (domain === getDomainBg(continuousDiscoveryState.myDomain || '')) return false;
        return (entry.crawlStatus || 'pending') === 'pending';
    }).length;

    const processedDomains = domainIntel.getCache().frontier.filter((entry) => (entry.crawlStatus || '') === 'completed').length;
    const failedDomains = domainIntel.getCache().frontier.filter((entry) => (entry.crawlStatus || '') === 'failed').length;

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

// ─── 网络信号处理：来自 network-inspector-bridge.js ───
let latestNetworkSignals = new Map(); // tabId → signal

function handleNetworkSignal(signal) {
    if (!signal || !signal.type) return;
    // 存储最新信号，供 publish verification 时参考
    const key = signal.url || 'unknown';
    latestNetworkSignals.set(key, signal);
    // 清理旧信号（保留最近 50 条）
    if (latestNetworkSignals.size > 50) {
        const oldest = latestNetworkSignals.keys().next().value;
        latestNetworkSignals.delete(oldest);
    }

    // 如果检测到 moderation 信号，记录日志
    if (signal.type === 'moderation') {
        Logger.info('网络层检测到评论进入审核队列', { url: signal.url, source: signal.source });
    } else if (signal.type === 'rejected') {
        Logger.error('网络层检测到评论被拒绝', { url: signal.url, source: signal.source });
    } else if (signal.type === 'confirmed') {
        Logger.info('网络层确认评论提交成功', { url: signal.url, source: signal.source });
    }
}

function getLatestNetworkSignal(url) {
    if (!url) return null;
    return latestNetworkSignals.get(url) || null;
}

async function handleCommentSubmittingMessage(msg = {}, sender = {}) {
    await ensurePublishSessionsLoaded();
    const taskId = msg.taskId || findPublishSessionTaskIdByCurrentTab(sender.tab?.id) || '';
    if (!taskId) return;
    if (!isPublishSessionMatch(taskId, msg.sessionId || '')) return;

    clearPublishWatchdog(taskId);
    const session = getPublishSessionState(taskId);
    setPublishSessionState(taskId, {
        ...session,
        pendingSubmission: {
            resourceId: msg.resourceId,
            taskId,
            sessionId: session.sessionId || '',
            tabId: sender.tab?.id || session.currentTabId || null,
            meta: msg.meta || {},
            createdAt: Date.now()
        }
    });
    schedulePublishWatchdog(taskId, {
        stage: 'submission',
        resourceId: msg.resourceId,
        currentUrl: session.currentUrl,
        sessionId: session.sessionId || ''
    });
}

async function handleCommentProgressMessage(msg = {}, sender = {}) {
    await ensurePublishSessionsLoaded();
    const taskId = msg.taskId || findPublishSessionTaskIdByCurrentTab(sender.tab?.id) || '';
    if (!taskId) return;
    if (!isPublishSessionMatch(taskId, msg.sessionId || '')) return;

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
        timeoutMs,
        resourceId: msg.resourceId || activeResourceId,
        currentUrl: session.currentUrl,
        timeoutMs,
        sessionId: session.sessionId || ''
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
        commentAction: (msg) => handleCommentAction(msg.resourceId, msg.result, msg.taskId, msg.meta || {}, msg.sessionId || ''),
        networkSignal: (msg) => handleNetworkSignal(msg.signal),
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
        cleanupResourceQueue: async () => await cleanupResourceQueue(),
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
        runAutoPublishScheduler: async () => autoPublishDispatch.run({ reason: 'manual-trigger' }),
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
        },
        // ── 导入哥飞 226 条资源 ────────────────
        importGefeiResources: async (msg) => {
            try {
                const response = await fetch(chrome.runtime.getURL('data/gefei-226-resources.json'));
                const rawData = await response.json();
                const clearExisting = msg?.clearExisting !== false;

                const resources = rawData.map((item, index) => {
                    const isBlogComment = item.type === 'blog_comment';
                    const isProfile = item.type === 'profile';
                    return {
                        id: `gefei-${index}-${Date.now()}`,
                        url: item.url,
                        pageTitle: '',
                        opportunities: isBlogComment ? ['comment'] : (isProfile ? ['register'] : ['comment']),
                        linkModes: isBlogComment && item.hasUrlField ? ['website-field'] : (isProfile ? ['profile-link'] : []),
                        details: [
                            'gefei-verified',
                            isBlogComment ? 'wordpress' : '',
                            isBlogComment ? 'inline-submit-form' : '',
                            isBlogComment && item.hasUrlField ? 'website-field' : '',
                            isProfile ? 'profile-link' : ''
                        ].filter(Boolean),
                        sources: [item.discoveredFrom || 'gefei'],
                        hasUrlField: isBlogComment ? item.hasUrlField : false,
                        hasCaptcha: item.hasCaptcha,
                        resourceClass: isBlogComment ? 'blog-comment' : 'profile',
                        frictionLevel: item.hasCaptcha ? 'high' : (isBlogComment ? 'low' : 'medium'),
                        directPublishReady: isBlogComment && item.hasUrlField && !item.hasCaptcha,
                        status: 'pending',
                        gefeiSeed: true
                    };
                });

                if (clearExisting) {
                    await writeResourcesToStorage(resources);
                } else {
                    const existing = await getStoredResources();
                    const existingUrls = new Set(existing.map(r => normalizeHttpUrlBg(r.url || '')));
                    const newOnly = resources.filter(r => !existingUrls.has(normalizeHttpUrlBg(r.url || '')));
                    await writeResourcesToStorage([...existing, ...newOnly]);
                }

                const stored = await getStoredResources();
                syncResourceOpportunityStats(stored);
                broadcastStats();

                await Logger.collect(`哥飞资源导入完成: ${resources.length} 条`);
                return { success: true, imported: resources.length };
            } catch (error) {
                return { success: false, message: error.message };
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

// startCollect → see core/collection-flow.js

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

function mergeDomainStatus(current = 'discovered', next = 'discovered') {
    return FrontierScheduler.mergeStatus(current, next);
}

// Domain intel delegators
function ensureDomainIntelLoaded() { return domainIntel.ensureLoaded(); }
function flushDomainIntel() { return domainIntel.flush(); }
function createDomainFrontierEntry(domain) { return domainIntel.createEntry(domain); }
function ensureDomainFrontierEntry(domain) { return domainIntel.ensureFrontierEntry(domain); }
function shouldQueueDomainForRecursiveCollection(context) { return domainIntel.shouldQueueForRecursive(context); }
function getContextRecursiveDepth(context) { return domainIntel.getContextRecursiveDepth(context); }
function markEntryCrawlPending(entry, context) { return domainIntel.markEntryCrawlPending(entry, context); }
function markDomainCrawlState(domain, patch) { return domainIntel.markCrawlState(domain, patch); }
function getNextPendingFrontierDomain() { return domainIntel.getNextPending(); }
function recordDomainIntel(items, context) { return domainIntel.recordIntel(items, context); }
function recordDomainPublishEvidence(url, status, publishMeta) { return domainIntel.recordPublishEvidence(url, status, publishMeta); }
function recordDomainDrilldown(seed, finalUrl, html, pages) { return domainIntel.recordDrilldown(seed, finalUrl, html, pages); }
function enrichDomainProfileFromPage(url, html, ruleResult) { return domainIntel.enrichProfile(url, html, ruleResult); }
function recalculateDomainIntelScores() { return domainIntel.recalculateScores(); }
function getDomainIntelView() { return domainIntel.getView(); }

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
    const pendingFrontierDomains = domainIntel.getCache().frontier.filter((entry) => {
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

// runContinuousDiscoveryLoop → see core/collection-flow.js

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

// startMarketingAutomation -> extracted to background/marketing/marketing-orchestrator.js

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

// runMarketingAutomationLoop -> extracted to background/marketing/marketing-orchestrator.js

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
            'autoPublishControlState',
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

    autoPublishDispatch.clearTimer();
    for (const taskId of publishRetryTimers.keys()) {
        clearPublishRetry(taskId);
    }
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
    await setManualPublishFocusTask('', 'resource-workspace-cleared');
    domainIntel.resetCache();
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
    await broadcastContinuousDiscoveryState();
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
// URL 前置过滤：砍掉明显不可用的资源
// ============================================================

const LOW_QUALITY_PATH_PATTERNS = /\/(category|tag|author|search|feed|page\/\d+|attachment|wp-admin|wp-login|wp-content|wp-includes|xmlrpc|trackback|embed)\//i;
const LOW_QUALITY_QUERY_PATTERNS = /[?&](s|search|q|preview|replytocom)=/i;
const LOW_QUALITY_DOMAIN_SUFFIXES = /\.(gov|edu|mil)$/i;
const SOCIAL_MEDIA_DOMAINS = /^(facebook|twitter|x|instagram|linkedin|youtube|tiktok|pinterest|reddit|quora|medium|tumblr|flickr|vimeo|t\.co)\./i;

function isLowQualityCollectUrl(url) {
    if (!url) return true;
    try {
        const parsed = new URL(url.startsWith('http') ? url : 'https://' + url);
        const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
        const pathname = parsed.pathname.toLowerCase();

        // 域名级过滤
        if (LOW_QUALITY_DOMAIN_SUFFIXES.test(hostname)) return true;
        if (SOCIAL_MEDIA_DOMAINS.test(hostname)) return true;

        // 路径特征过滤
        if (LOW_QUALITY_PATH_PATTERNS.test(pathname)) return true;

        // 查询参数过滤
        if (LOW_QUALITY_QUERY_PATTERNS.test(parsed.search)) return true;

        // 首页/根路径（无具体文章）
        if (pathname === '/' || pathname === '') return true;

        // 文件扩展名过滤（非 HTML）
        if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|mp3|mp4|css|js|xml|json|rss|atom)$/i.test(pathname)) return true;

        return false;
    } catch {
        return true;
    }
}

// ============================================================
// Fetch 批量分析
// ============================================================

async function buildAnalysisTargets(links) {
    const directPages = [];
    const domainSeeds = [];
    const seenTargets = new Set();
    let filteredCount = 0;

    for (const link of [...links].sort((a, b) => getAnalysisSeedScore(b) - getAnalysisSeedScore(a))) {
        const normalized = normalizeUrlBg(link.url);
        if (!normalized || seenTargets.has(normalized)) continue;

        // URL 前置过滤
        if (link.candidateType === 'backlink-page' && isLowQualityCollectUrl(link.url)) {
            filteredCount++;
            continue;
        }

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

    if (filteredCount > 0) {
        Logger.collect(`前置过滤: 跳过 ${filteredCount} 个低质量 URL（分类页/标签页/搜索页等）`);
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
                    const details = result.details || [];
                    const anchorCount = Number(result.commentAnchorCount || 0);
                    const hasComments = details.includes('has-existing-comments');

                    // 硬拒绝 #1：分析已明确给出硬阻断（评论关闭/登录/验证码）
                    const hasHardBlocker =
                        details.includes('login-required')
                        || details.includes('comment-closed')
                        || details.includes('captcha')
                        || result.requiresLoginToPost === true
                        || result.commentsClosed === true
                        || result.hasCaptcha === true;
                    if (hasHardBlocker) {
                        collectState.stats.analyzed++;
                        collectState.stats.inQueue = Math.max(collectState.stats.inQueue - 1, 0);
                        broadcastStats();
                        continue;
                    }

                    // 硬拒绝 #2：有评论区但评论里 0 条带链接 → 站主大概率删链接
                    if (hasComments && anchorCount === 0) {
                        collectState.stats.analyzed++;
                        collectState.stats.inQueue = Math.max(collectState.stats.inQueue - 1, 0);
                        broadcastStats();
                        continue;
                    }

                    // 硬拒绝 #3：既不是 directPublishReady，也没有锚链证据 → weak 池不够强
                    // 避免把一大批勉强像评论页但实际发不出去的页面灌进主队列
                    if (!result.directPublishReady && anchorCount === 0) {
                        collectState.stats.analyzed++;
                        collectState.stats.inQueue = Math.max(collectState.stats.inQueue - 1, 0);
                        broadcastStats();
                        continue;
                    }

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

// fetchAnalyzePage → see core/collection-flow.js

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
        directPublishReady: !!result.directPublishReady,
        commentAnchorCount: Number(result.commentAnchorCount || 0)
    };
}

// ============================================================
// 递归外链发现
// ============================================================

// extractCommenterDomains → see core/collection-flow.js

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

// recursiveDiscovery → see core/collection-flow.js

// ============================================================
// 资源保存
// ============================================================

async function getStoredResources() {
    return await resourceStore.getResources();
}

async function writeResourcesToStorage(resources = []) {
    return await resourceStore.writeResources(resources);
}

/**
 * 一次性清理：用现有字段硬筛选资源队列。
 * - edu/gov/社交媒体域名 → 下架
 * - 评论区存在但无表单（评论已关闭的强指示）→ 下架
 * - commentsClosed / requiresLogin 字段 = true → 下架
 * - 历史连续失败 ≥3 次且从未成功 → 下架
 * - 历史发布原因命中 HARD_UNPUBLISHABLE_REASONS → 下架
 * - commentAnchorCount ≥3 → 加 boost 标签（不下架，只排序加权）
 */
async function cleanupResourceQueue() {
    const resources = await getStoredResources();
    const counts = {
        total: resources.length,
        markedUnpublishable: 0,
        alreadyUnpublishable: 0,
        boosted: 0,
        kept: 0
    };
    const reasonStats = {};

    const nextResources = resources.map((resource) => {
        if (!resource) return resource;
        if (resource.status === 'unpublishable') {
            counts.alreadyUnpublishable++;
            return resource;
        }

        const domain = getDomainBg(resource.url || '') || '';
        const details = Array.isArray(resource.details) ? resource.details : [];
        const detailsSet = new Set(details);
        const reasons = [];

        // 1. 不值得分析的域名
        if (domain && FrontierScheduler.isUnwantedDomain(domain)) {
            reasons.push('unwanted-domain');
        }

        // 2. 硬阻断信号（采集时写进 details 的 blockers）
        if (detailsSet.has('login-required')) reasons.push('login-required');
        if (detailsSet.has('comment-closed')) reasons.push('comments-closed');
        if (detailsSet.has('captcha')) reasons.push('captcha-blocked');

        // 3. 运行时字段（发布时 detectPageCommentCapabilities 写入，老数据大多没有）
        if (resource.hasExistingComments === true && resource.hasCommentForm === false) {
            reasons.push('comments-closed-inferred');
        }
        if (resource.commentsClosed === true) reasons.push('comments-closed');
        if (resource.requiresLogin === true || resource.requiresLoginToPost === true) {
            reasons.push('login-required');
        }
        if (resource.hasCaptcha === true) reasons.push('captcha-blocked');

        // 4. 弱资源组合：weak 类 + 非 directPublishReady + 0 锚链 + 0 linkMode
        //    = 没有任何强信号，且没有任何留链通道，几乎肯定发不了
        const anchorCount = Number(resource.commentAnchorCount || 0);
        const resourceClass = String(resource.resourceClass || '').toLowerCase();
        const isWeakClass = resourceClass === 'weak';
        const hasDirectPublish = resource.directPublishReady === true;
        const linkModes = Array.isArray(resource.linkModes) ? resource.linkModes : [];
        if (isWeakClass && !hasDirectPublish && anchorCount === 0 && linkModes.length === 0) {
            reasons.push('weak-no-signal');
        }

        // 5. 核心元素缺失：连 textarea 都没找到 → 没地方写评论
        if (detailsSet.has('no-textarea') && anchorCount === 0) {
            reasons.push('no-textarea');
        }

        // 6. 没有任何 opportunities = 完全没地方留链
        if (!Array.isArray(resource.opportunities) || resource.opportunities.length === 0) {
            reasons.push('no-opportunity');
        }

        // 7. 历史连续失败或历史硬阻断
        const historyEntries = Object.values(resource.publishHistory || {});
        for (const entry of historyEntries) {
            const failed = Number(entry?.attempts?.failed || 0);
            const published = Number(entry?.attempts?.published || 0);
            if (failed >= 3 && published === 0) {
                reasons.push('chronic-failure');
                break;
            }
            const blockReason = String(entry?.publishMeta?.submissionBlockReason || '').toLowerCase();
            if (['comments-closed', 'login-required', 'captcha-blocked'].includes(blockReason)) {
                reasons.push(`historical-${blockReason}`);
                break;
            }
        }

        if (reasons.length > 0) {
            counts.markedUnpublishable++;
            const dedupedReasons = Array.from(new Set(reasons));
            dedupedReasons.forEach((r) => {
                reasonStats[r] = (reasonStats[r] || 0) + 1;
            });
            return {
                ...resource,
                status: 'unpublishable',
                publishMeta: {
                    ...(resource.publishMeta || {}),
                    unpublishableReason: dedupedReasons.join(','),
                    cleanupMarkedAt: new Date().toISOString()
                }
            };
        }

        // 高质量加权：≥3 条带链接评论
        if (anchorCount >= 3) {
            counts.boosted++;
            return {
                ...resource,
                details: Array.from(new Set([...details, 'anchor-count-boost']))
            };
        }

        counts.kept++;
        return resource;
    });

    const stored = await writeResourcesToStorage(nextResources);
    syncResourceOpportunityStats(stored);
    broadcastStats();
    autoPublishDispatch.schedule('resource-cleanup', 1500);

    return { success: true, counts, reasonStats };
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

    // 哥飞种子：初始信任预设信号，但发布失败过的允许重新计算
    const gefeiHasFailures = nextResource.gefeiSeed
        && (nextResource.publishMeta?.submissionBlocked || nextResource.status === 'failed' || nextResource.status === 'skipped');
    if (nextResource.gefeiSeed && nextResource.directPublishReady && !gefeiHasFailures) {
        nextResource.sourceTier = getEffectiveResourceSourceTier(nextResource) || nextResource.discoverySourceTier || nextResource.sourceTier || '';
        nextResource.sourceTierScore = getSourceTierScore(nextResource.sourceTier);
        nextResource.sourceEvidence = summarizeSourceEvidenceFromEdges(nextResource.discoveryEdges || []);
        nextResource = applyResourcePool(nextResource);
        return nextResource;
    }

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
    autoPublishDispatch.schedule('resource-discovered');
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

// restoreTaskSchedules -> extracted to background/marketing/marketing-orchestrator.js

// getWorkflowTaskType -> extracted to background/marketing/marketing-orchestrator.js

// runPromotionCampaignTask -> extracted to background/marketing/marketing-orchestrator.js

// runResearchTask -> extracted to background/marketing/marketing-orchestrator.js

// runNurtureSession -> extracted to background/marketing/marketing-orchestrator.js

// executeNurtureTask -> extracted to background/marketing/marketing-orchestrator.js

// handleNurtureAlarm -> extracted to background/marketing/marketing-orchestrator.js

// handleMarketingRefreshAlarm -> extracted to background/marketing/marketing-orchestrator.js

// runMarketingTask -> extracted to background/marketing/marketing-orchestrator.js

// inspectMarketingReview -> extracted to background/marketing/marketing-orchestrator.js

// savePublishTask -> extracted to background/core/publish-flow.js
// setTaskAutoDispatchPaused -> extracted to background/core/publish-flow.js
// deletePublishTask -> extracted to background/core/publish-flow.js
// getPublishWorkflow -> extracted to background/core/publish-flow.js
// getTaskPublishTarget -> extracted to background/core/publish-flow.js
// isPublishCandidateForTask -> extracted to background/core/publish-flow.js
// getResourcePublishHistoryEntry -> extracted to background/core/publish-flow.js
// canPublishResourceForTask -> extracted to background/core/publish-flow.js
// isRateLimitReason -> extracted to background/core/publish-flow.js
// getPublishFailureRecoveryPolicy -> extracted to background/core/publish-flow.js
// interleaveResourcesByDomain -> extracted to background/core/publish-flow.js
// mergePublishHistoryEntry -> extracted to background/core/publish-flow.js
// updateTaskPublishStats -> extracted to background/core/publish-flow.js
// syncPublishLog -> extracted to background/core/publish-flow.js
// getPublishRuntimeContext -> extracted to background/core/publish-flow.js
// startPublish -> extracted to background/core/publish-flow.js
// publishNext -> extracted to background/core/publish-flow.js
// handleCommentAction -> extracted to background/core/publish-flow.js
// updateResourceStatus -> extracted to background/core/publish-flow.js
// resetResourcePublishState -> extracted to background/core/publish-flow.js
// resetAllPublishStatuses -> extracted to background/core/publish-flow.js

// stopCollect → see core/collection-flow.js

// stopPublish -> extracted to background/core/publish-flow.js
// continuePublish -> extracted to background/core/publish-flow.js
// republishResource -> extracted to background/core/publish-flow.js
// shouldFocusPublishTab -> extracted to background/core/publish-flow.js
// focusPublishTab -> extracted to background/core/publish-flow.js
// openOrReusePublishTab -> extracted to background/core/publish-flow.js
// buildPublishViewportUrl -> extracted to background/core/publish-flow.js
// shouldPreferCommentViewport -> extracted to background/core/publish-flow.js
// sendPublishToTab -> extracted to background/core/publish-flow.js
// ensurePublishContentScripts -> extracted to background/core/publish-flow.js
// finalizePendingSubmissionFromNavigation -> extracted to background/core/publish-flow.js

function verifyPublishedAnchor(tabId, options = {}) {
    return AnchorVerifier.verify(tabId, options, { delay });
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
    // Cooldown disabled — efficiency first, don't get stuck on one domain
    return { active: false, remainingMs: 0, cooldownUntil: '' };
}

function isResourceCoolingDown(resource, policies = {}, now = Date.now()) {
    const domain = getDomainBg(resource?.url || '');
    if (!domain) return false;
    return getDomainCooldownState(policies?.[domain] || {}, now).active;
}

async function rebalanceDispatchQueue(taskId) {
    const session = getPublishSessionState(taskId);
    if (!session.isPublishing || session.currentIndex >= session.queue.length) {
        return {
            moved: 0,
            blocked: false,
            cooldownUntil: '',
            cooldownBlockedCount: 0,
            leaseBlockedCount: 0,
            retryDelayMs: 0,
            waitingReason: ''
        };
    }

    const policies = await getAllDomainPublishPolicies();
    const now = Date.now();
    let moved = 0;
    let scanned = 0;
    let earliestCooldownUntil = '';
    let cooldownBlockedCount = 0;
    let leaseBlockedCount = 0;
    const queue = [...session.queue];
    const currentIndex = session.currentIndex;
    const remaining = queue.length - currentIndex;

    while (currentIndex < queue.length && scanned < remaining) {
        const resource = queue[currentIndex];
        const domain = getDomainBg(resource?.url || '');
        const policy = policies?.[domain] || {};
        const cooldownState = getDomainCooldownState(policy, now);
        const leaseConflict = getPublishLeaseConflict(taskId, session.sessionId || '', resource);
        if (!cooldownState.active && !leaseConflict) {
            break;
        }

        if (cooldownState.active) {
            cooldownBlockedCount++;
        }
        if (leaseConflict) {
            leaseBlockedCount++;
        }
        if (cooldownState.active && (!earliestCooldownUntil || new Date(cooldownState.cooldownUntil).getTime() < new Date(earliestCooldownUntil).getTime())) {
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
        cooldownUntil: earliestCooldownUntil,
        cooldownBlockedCount,
        leaseBlockedCount,
        retryDelayMs: leaseBlockedCount > 0 ? 1800 : 0,
        waitingReason: leaseBlockedCount > 0
            ? (cooldownBlockedCount > 0 ? 'lease-and-cooldown' : 'lease-blocked')
            : (cooldownBlockedCount > 0 ? 'cooldown-only' : '')
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

// persistCollectSnapshot → see core/collection-flow.js

// getPersistedCollectView → see core/collection-flow.js

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
