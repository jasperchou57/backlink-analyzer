/**
 * Background Service Worker - V3
 * AI 驱动 + 递归发现 + 多任务发布 + 日志 + Google Sheets
 */

// 导入模块
importScripts('../utils/ai-engine.js', '../utils/logger.js', '../utils/google-sheets.js', '../utils/workflows.js');

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
    DOMAIN_RATE_LIMIT_COOLDOWN_MS: 5 * 60 * 1000
};

let publishState = {
    isPublishing: false,
    currentTask: null,
    currentIndex: 0,
    queue: [],
    currentWorkflowId: null,
    currentTabId: null,
    currentUrl: '',
    stopRequested: false,
    awaitingManualContinue: false,
    pendingSubmission: null
};

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

let panelWindowId = null;
let collectTabId = null;

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

if (chrome.sidePanel?.setPanelBehavior) {
    configureActionSurface();
    chrome.runtime.onInstalled.addListener(() => {
        configureActionSurface();
    });
    chrome.runtime.onStartup.addListener(() => {
        configureActionSurface();
    });
} else {
    // Fallback for browsers without side panel support.
    chrome.action.onClicked.addListener(() => {
        openPanelWindow();
    });
}

chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === panelWindowId) panelWindowId = null;
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === collectTabId) {
        collectTabId = null;
    }
    if (tabId === publishState.currentTabId) {
        publishState.currentTabId = null;
    }
    if (tabId === publishState.pendingSubmission?.tabId) {
        publishState.pendingSubmission = null;
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== 'complete') return;
    if (!publishState.pendingSubmission) return;
    if (publishState.pendingSubmission.tabId !== tabId) return;

    finalizePendingSubmissionFromNavigation(tabId);
});

function createDefaultContinuousDiscoveryState() {
    return {
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
}

async function ensureContinuousDiscoveryLoaded() {
    if (continuousDiscoveryLoaded) return;
    const data = await chrome.storage.local.get(['continuousDiscoveryState', 'collectState']);
    continuousDiscoveryState = {
        ...createDefaultContinuousDiscoveryState(),
        ...(data.continuousDiscoveryState || {})
    };
    const persistedCollectState = data.collectState || {};
    if (continuousDiscoveryState.isRunning && !persistedCollectState.isCollecting) {
        continuousDiscoveryState.isRunning = false;
        continuousDiscoveryState.isPaused = true;
        continuousDiscoveryState.currentDomain = '';
        continuousDiscoveryState.lastMessage = continuousDiscoveryState.lastMessage || '上次持续发现已中断，可继续';
        await chrome.storage.local.set({ continuousDiscoveryState });
    }
    continuousDiscoveryLoaded = true;
}

async function flushContinuousDiscoveryState() {
    await chrome.storage.local.set({ continuousDiscoveryState });
}

async function updateContinuousDiscoveryState(patch = {}, options = {}) {
    await ensureContinuousDiscoveryLoaded();
    continuousDiscoveryState = {
        ...continuousDiscoveryState,
        ...patch
    };
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

    return {
        ...continuousDiscoveryState,
        pendingDomains,
        processedDomains,
        failedDomains
    };
}

async function broadcastContinuousDiscoveryState() {
    const state = await getContinuousDiscoveryStateView();
    broadcastToPopup({ action: 'continuousStateUpdate', state });
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

function getContinuousSeedDomain() {
    return getDomainBg(continuousDiscoveryState.seedDomain || '');
}

function getContinuousMyDomain() {
    return getDomainBg(continuousDiscoveryState.myDomain || '');
}

// === 消息处理 ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.action) {
        case 'startCollect':
            startCollect(msg.domain, msg.myDomain, msg.sources);
            break;
        case 'stopCollect':
            stopCollect();
            break;
        case 'startContinuousDiscovery':
            startContinuousDiscovery(msg.domain, msg.myDomain, msg.sources).then(result => sendResponse(result));
            return true;
        case 'pauseContinuousDiscovery':
            pauseContinuousDiscovery().then(result => sendResponse(result));
            return true;
        case 'getContinuousDiscoveryState':
            getContinuousDiscoveryStateView().then((state) => sendResponse({ state }));
            return true;
        case 'startPublish':
            startPublish(msg.task).then(result => sendResponse(result));
            return true;
        case 'stopPublish':
            stopPublish();
            break;
        case 'continuePublish':
            continuePublish();
            break;
        case 'openFloatingPanel':
            openPanelWindow();
            break;
        case 'getPublishState':
            sendResponse({
                isPublishing: publishState.isPublishing,
                currentIndex: publishState.currentIndex,
                total: publishState.queue?.length || 0,
                currentUrl: publishState.currentUrl || '',
                taskId: publishState.currentTask?.id || '',
                taskName: publishState.currentTask?.name || publishState.currentTask?.website || '',
                stopRequested: !!publishState.stopRequested,
                awaitingManualContinue: !!publishState.awaitingManualContinue
            });
            return false;
        case 'backlinkData':
            handleBacklinkData(msg.source, msg.urls, msg.items || []);
            break;
        case 'commentAction':
            handleCommentAction(msg.resourceId, msg.result, msg.taskId, msg.meta || {});
            break;
        case 'commentSubmitting':
            publishState.pendingSubmission = {
                resourceId: msg.resourceId,
                taskId: msg.taskId,
                tabId: sender.tab?.id || publishState.currentTabId || null,
                meta: msg.meta || {},
                createdAt: Date.now()
            };
            break;
        case 'getStats':
            getPersistedCollectView().then((view) => sendResponse(view));
            return true;
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
        case 'getDomainIntel':
            getDomainIntelView().then((domainIntel) => sendResponse({ domainIntel }));
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
        case 'clearAllData':
            resetAllLocalData().then(() => sendResponse({ success: true }));
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
            resetResourcePublishState(msg.resourceId).then(() => sendResponse({ success: true }));
            return true;
        case 'resetAllStatuses':
            resetAllPublishStatuses().then(result => sendResponse(result));
            return true;
        // AI 请求从 content script 转发
        case 'aiExtractForm':
            AIEngine.extractFormStructure(msg.html).then(result => sendResponse(result));
            return true;
        case 'aiGenerateComment':
            AIEngine.generateComment(msg.pageTitle, msg.pageContent, msg.targetUrl, msg.options || {}).then(comment => {
                sendResponse({ comment });
            }).catch(err => {
                sendResponse({ comment: '', error: err.message });
            });
            return true;
    }
});

// ============================================================
// 收集流程 — 单 Tab 复用 + 递归发现
// ============================================================

async function startCollect(domain, myDomain, sources) {
    const seededDomains = [domain, myDomain]
        .map((value) => getDomainBg(value || ''))
        .filter(Boolean);
    collectState = {
        isCollecting: true,
        domain,
        myDomain,
        sources,
        backlinks: { ahrefs: [], semrush: [], similarweb: [] },
        myBacklinks: [],
        stats: { backlinksFound: 0, targetsFound: 0, analyzed: 0, blogResources: 0, inQueue: 0 },
        discoveredDomains: new Set(seededDomains),
        discoveryQueue: [],
        processedDiscoveryDomains: new Set(seededDomains),
        discoveryDepth: 0,
        maxDiscoveryDepth: 3,
        maxDiscoveryQueue: 500,
        maxRecursiveDomains: 50,
        recursiveDomainsProcessed: 0,
        sourceRequest: null
    };

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

    // 3. 合并三源数据
    if (collectState.isCollecting) {
        const merged = mergeBacklinks();
        await recordDomainIntel(merged, {
            discoveryMethod: 'collector-merge',
            seedTarget: collectState.domain,
            status: 'discovered'
        });
        collectState.stats.backlinksFound = merged.length;
        collectState.stats.targetsFound = merged.length;
        collectState.stats.analyzed = 0;
        collectState.stats.inQueue = 0;
        broadcastStats();
        await Logger.collect(`合并完成: ${merged.length} 条外链`);

        // 4. 构建分析目标（页面优先，域名再下钻）
        const analysisTargets = await buildAnalysisTargets(merged);
        collectState.stats.targetsFound = analysisTargets.length;
        collectState.stats.inQueue = analysisTargets.length;
        broadcastStats();
        await Logger.collect(`分析目标准备完成: ${analysisTargets.length} 个`, {
            directPages: analysisTargets.filter((item) => item.analysisStage === 'direct-page').length,
            domainDrilldowns: analysisTargets.filter((item) => item.analysisStage === 'domain-drilldown').length
        });

        // 5. Fetch 批量分析
        await fetchAnalyzeAll(analysisTargets);

        // 6. 递归发现
        await recursiveDiscovery();
    }

    try { await chrome.tabs.remove(collectTabId); } catch {}
    collectTabId = null;

    collectState.isCollecting = false;
    await chrome.storage.local.set({ collectState: { isCollecting: false, domain, myDomain } });
    await broadcastContinuousDiscoveryState();
    broadcastToPopup({ action: 'collectDone' });
    await Logger.collect('收集完成');
}

async function navigateAndCollect(tabId, url, source) {
    try {
        collectState[`${source}_done`] = false;
        collectState.sourceRequest = {
            source,
            result: []
        };
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

        const baseSource = source.replace('my-', '');
        const waitTimeout = baseSource === 'similarweb'
            ? 150000
            : baseSource === 'semrush'
                ? 210000
                : baseSource === 'ahrefs'
                    ? 90000
                    : 45000;
        await waitForData(source, waitTimeout);
        const requestResult = collectState.sourceRequest?.source === source
            ? [...(collectState.sourceRequest.result || [])]
            : [];
        collectState.sourceRequest = null;
        return requestResult;
    } catch (e) {
        collectState.sourceRequest = null;
        await Logger.error(`收集失败 (${source}): ${e.message}`);
        return [];
    }
}

function getSourceUrl(source, domain) {
    switch (source) {
        case 'ahrefs':
            return `https://ahrefs.com/backlink-checker/?input=${domain}&mode=subdomains`;
        case 'semrush':
            return `https://sem.3ue.co/analytics/backlinks/backlinks/?q=${domain}&searchType=domain`;
        case 'similarweb':
            return `https://sim.3ue.co/#/digitalsuite/acquisition/backlinks/table/999/?duration=28d&key=${domain}&sort=DomainScore`;
        default:
            return null;
    }
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

async function waitForData(source, timeout) {
    const start = Date.now();
    while (!collectState[`${source}_done`] && Date.now() - start < timeout) {
        await delay(1000);
    }
}

// ============================================================
// 持续发现：Domain Frontier + Domain Profile
// ============================================================

async function ensureDomainIntelLoaded() {
    if (domainIntelLoaded) return;
    const data = await chrome.storage.local.get(['domainFrontier', 'domainProfiles']);
    domainIntelCache = {
        frontier: data.domainFrontier || [],
        profiles: data.domainProfiles || {}
    };
    domainIntelLoaded = true;
}

async function flushDomainIntel() {
    if (!domainIntelLoaded) return;
    await chrome.storage.local.set({
        domainFrontier: domainIntelCache.frontier,
        domainProfiles: domainIntelCache.profiles
    });
}

function createDomainFrontierEntry(domain) {
    const now = new Date().toISOString();
    return {
        domain,
        status: 'discovered',
        crawlStatus: 'pending',
        firstSeenAt: now,
        lastSeenAt: now,
        sources: [],
        sourceTypes: [],
        discoveryMethods: [],
        seedTargets: [],
        discoveredFromUrls: [],
        sampleUrls: [],
        seenCount: 0,
        commentMentions: 0,
        domainSeedCount: 0,
        pageSeedCount: 0,
        drilldownPages: 0,
        commentOpportunityCount: 0,
        verifiedAnchorCount: 0,
        crawlAttempts: 0,
        crawlDepth: 0,
        lastCollectedAt: '',
        lastExpandedAt: '',
        profileUpdatedAt: '',
        qualityScore: 0
    };
}

function mergeDomainStatus(current = 'discovered', next = 'discovered') {
    const order = {
        discovered: 1,
        queued: 2,
        profiled: 3,
        expanded: 4
    };
    return (order[next] || 0) > (order[current] || 0) ? next : current;
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
    const method = String(context.discoveryMethod || '');
    return [
        'collector-merge',
        'recursive-collector-merge',
        'commenter-domain',
        'recursive-discovery'
    ].includes(method);
}

function getContextRecursiveDepth(context = {}) {
    if (Number.isFinite(context.recursiveDepth)) return Number(context.recursiveDepth);
    return Number(collectState.discoveryDepth || 0);
}

function markEntryCrawlPending(entry, context = {}) {
    if (!entry) return;

    const seedDomain = getContinuousSeedDomain() || getDomainBg(collectState.domain || '');
    const myDomain = getContinuousMyDomain() || getDomainBg(collectState.myDomain || '');
    if (entry.domain === seedDomain || entry.domain === myDomain) {
        entry.crawlStatus = 'completed';
        return;
    }

    if (entry.crawlStatus === 'processing') return;
    if (!entry.lastCollectedAt || entry.crawlStatus !== 'completed') {
        entry.crawlStatus = 'pending';
    }
    entry.crawlDepth = Math.max(entry.crawlDepth || 0, getContextRecursiveDepth(context));
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
    const seedDomain = getContinuousSeedDomain() || getDomainBg(collectState.domain || '');
    const myDomain = getContinuousMyDomain() || getDomainBg(collectState.myDomain || '');

    return [...domainIntelCache.frontier]
        .filter((entry) => {
            if (!entry?.domain) return false;
            if (entry.domain === seedDomain || entry.domain === myDomain) return false;
            return (entry.crawlStatus || 'pending') === 'pending';
        })
        .sort((a, b) => {
            const depthDiff = (a.crawlDepth || 0) - (b.crawlDepth || 0);
            if (depthDiff !== 0) return depthDiff;
            const scoreDiff = (b.qualityScore || 0) - (a.qualityScore || 0);
            if (scoreDiff !== 0) return scoreDiff;
            return String(a.lastSeenAt || '').localeCompare(String(b.lastSeenAt || ''));
        })[0] || null;
}

function pushUniqueValue(target, value, limit = 6) {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    if (!Array.isArray(target)) return;
    if (target.includes(normalized)) return;
    target.push(normalized);
    if (target.length > limit) {
        target.splice(0, target.length - limit);
    }
}

function mergeStringArrays(values = [], nextValues = [], limit = 6) {
    const merged = Array.isArray(values) ? [...values] : [];
    for (const value of nextValues || []) {
        pushUniqueValue(merged, value, limit);
    }
    return merged;
}

function inferLanguageFromHtml(html = '') {
    const langMatch = html.match(/<html[^>]+lang=["']([^"']+)["']/i);
    if (langMatch?.[1]) return langMatch[1].trim().toLowerCase();

    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 2500);

    if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
    if (/[\u3040-\u30ff]/.test(text)) return 'ja';
    if (/[\u0400-\u04ff]/.test(text)) return 'ru';
    if (/[àèìòù]/i.test(text) || /\b(ciao|grazie|commenti|articolo)\b/i.test(text)) return 'it';
    if (/[áéíóúñ]/i.test(text) || /\b(hola|articulo|comentarios)\b/i.test(text)) return 'es';
    if (/[ãõç]/i.test(text) || /\b(voce|comentarios|comentario)\b/i.test(text)) return 'pt';
    return 'en';
}

function inferCountryFromDomain(domain = '', language = '') {
    const tld = domain.split('.').pop() || '';
    const ccMap = {
        br: 'BR', it: 'IT', fr: 'FR', de: 'DE', es: 'ES', pt: 'PT', ru: 'RU',
        cn: 'CN', jp: 'JP', uk: 'GB', us: 'US', ca: 'CA', au: 'AU', in: 'IN',
        nl: 'NL', pl: 'PL', ro: 'RO', tr: 'TR', mx: 'MX'
    };
    if (ccMap[tld]) return ccMap[tld];

    if (language.startsWith('pt-br')) return 'BR';
    if (language.startsWith('pt')) return 'PT';
    if (language.startsWith('zh')) return 'CN';
    if (language.startsWith('ja')) return 'JP';
    if (language.startsWith('ru')) return 'RU';
    if (language.startsWith('it')) return 'IT';
    if (language.startsWith('es')) return 'ES';
    return '';
}

function detectCmsFromHtml(html = '') {
    const lower = html.toLowerCase();
    if (lower.includes('wp-content') || lower.includes('wp-includes') || lower.includes('wordpress')) return 'wordpress';
    if (lower.includes('woocommerce')) return 'woocommerce';
    if (lower.includes('shopify') || lower.includes('cdn.shopify.com')) return 'shopify';
    if (lower.includes('ghost/')) return 'ghost';
    if (lower.includes('webflow')) return 'webflow';
    if (lower.includes('wix.com') || lower.includes('wixstatic.com')) return 'wix';
    if (lower.includes('squarespace')) return 'squarespace';
    if (lower.includes('drupal-settings-json') || lower.includes('drupal')) return 'drupal';
    if (lower.includes('joomla')) return 'joomla';
    if (lower.includes('mediawiki')) return 'mediawiki';
    return '';
}

function detectSiteTypeFromHtml(html = '', url = '', sampleUrls = []) {
    const lower = html.toLowerCase();
    const joinedUrls = sampleUrls.join(' ').toLowerCase();
    const pathHints = `${url} ${joinedUrls}`.toLowerCase();

    if (lower.includes('commentform') || lower.includes('wp-comments-post') || lower.includes('leave a reply') || lower.includes('leave a comment')) {
        return 'blog';
    }
    if (lower.includes('phpbb') || lower.includes('vbulletin') || lower.includes('xenforo') || lower.includes('discourse')) {
        return 'forum';
    }
    if (lower.includes('mediawiki') || lower.includes('wiki')) {
        return 'wiki';
    }
    if (lower.includes('directory') || lower.includes('submit your site') || lower.includes('listing')) {
        return 'directory';
    }
    if (lower.includes('cart') || lower.includes('checkout') || lower.includes('product') || lower.includes('woocommerce') || lower.includes('shopify')) {
        return 'store';
    }
    if (pathHints.includes('/blog') || pathHints.includes('/news') || pathHints.includes('/article') || pathHints.includes('/post')) {
        return 'blog';
    }
    if (pathHints.includes('/tool') || pathHints.includes('/generator') || pathHints.includes('/calculator')) {
        return 'tool';
    }
    return 'website';
}

function detectTopicFromText(text = '') {
    const lower = text.toLowerCase();
    const topicRules = [
        ['gaming', /\b(game|gaming|roblox|minecraft|steam|xbox|playstation|wiki)\b/gi],
        ['tech', /\b(ai|tech|software|saas|cloud|developer|chrome extension|app)\b/gi],
        ['business', /\b(marketing|seo|business|startup|agency|analytics)\b/gi],
        ['finance', /\b(finance|loan|credit|bank|insurance|investment)\b/gi],
        ['health', /\b(health|clinic|doctor|fitness|medical|wellness)\b/gi],
        ['education', /\b(course|school|student|essay|education|learn)\b/gi],
        ['travel', /\b(travel|hotel|flight|destination|tour)\b/gi],
        ['entertainment', /\b(movie|music|streaming|iptv|tv|anime|celebrity)\b/gi],
        ['sports', /\b(football|soccer|nba|nfl|sport|tennis)\b/gi],
        ['gambling', /\b(casino|slot|bet|betting|poker|jackpot)\b/gi],
        ['adult', /\b(adult|porn|sex|escort)\b/gi]
    ];

    let bestTopic = 'general';
    let bestScore = 0;
    for (const [topic, pattern] of topicRules) {
        const matches = lower.match(pattern);
        const score = matches?.length || 0;
        if (score > bestScore) {
            bestScore = score;
            bestTopic = topic;
        }
    }

    return bestTopic;
}

function calculateDomainQualityScore(entry = {}, profile = {}) {
    let score = 10;
    const sources = new Set(entry.sources || []);

    score += Math.min((sources.size || 0) * 8, 24);
    score += Math.min((entry.commentMentions || 0) * 4, 16);
    score += Math.min((entry.drilldownPages || 0) * 3, 15);
    score += Math.min((entry.commentOpportunityCount || 0) * 6, 18);

    if (profile.siteType === 'blog') score += 22;
    if (profile.siteType === 'forum') score += 16;
    if (profile.siteType === 'wiki') score += 10;
    if (profile.siteType === 'directory') score += 8;
    if (profile.siteType === 'store') score -= 8;
    if (profile.cms === 'wordpress') score += 6;
    if (profile.commentCapable) score += 12;
    if (profile.topic === 'gambling' || profile.topic === 'adult') score -= 18;
    if (sources.has('A')) score += 6;
    if (sources.has('M')) score += 4;
    if (sources.has('W')) score += 3;

    return Math.max(0, Math.min(100, Math.round(score)));
}

function buildDomainProfileFromHtml(url, html, hints = {}) {
    const title = html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.trim()?.slice(0, 140) || '';
    const description = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1]?.trim()?.slice(0, 220) || '';
    const language = inferLanguageFromHtml(html);
    const cms = detectCmsFromHtml(html);
    const siteType = detectSiteTypeFromHtml(html, url, hints.sampleUrls || []);
    const pageText = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 5000);
    const topic = detectTopicFromText(`${title} ${description} ${pageText}`);
    const country = inferCountryFromDomain(getDomainBg(url), language);

    return {
        homepageUrl: url,
        title,
        description,
        language,
        country,
        cms,
        siteType,
        topic,
        commentCapable: /commentform|wp-comments-post|leave a reply|leave a comment/i.test(html),
        trafficLabel: hints.trafficLabel || '',
        profiledAt: new Date().toISOString()
    };
}

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
        entry.discoveryMethods = mergeStringArrays(entry.discoveryMethods, [context.discoveryMethod || 'collector'], 6);
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

    const nextSeedUrl = `https://${normalizedDomain}/`;
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

    await updateContinuousDiscoveryState({
        isRunning: true,
        isPaused: false,
        seedDomain: nextSeedUrl,
        myDomain: normalizedMyDomain ? `https://${normalizedMyDomain}/` : '',
        sources: normalizedSources,
        seedInitialized: (seedChanged || pendingFrontierDomains === 0) ? false : !!continuousDiscoveryState.seedInitialized,
        currentDomain: '',
        lastMessage: (seedChanged || pendingFrontierDomains === 0)
            ? '准备启动新的持续发现流程'
            : '继续持续发现流程'
    });

    ensureContinuousDiscoveryLoop();
    return { success: true };
}

async function pauseContinuousDiscovery() {
    await ensureContinuousDiscoveryLoaded();
    await updateContinuousDiscoveryState({
        isRunning: false,
        isPaused: true,
        currentDomain: '',
        lastMessage: '已暂停持续发现'
    });
    collectState.isCollecting = false;
    await chrome.storage.local.set({
        collectState: {
            isCollecting: false,
            domain: getContinuousSeedDomain(),
            myDomain: getContinuousMyDomain()
        }
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

async function processFrontierDomain(domain) {
    prepareContinuousCollectContext();
    const now = new Date().toISOString();

    await markDomainCrawlState(domain, {
        crawlStatus: 'processing',
        status: mergeDomainStatus(
            domainIntelCache.frontier.find((item) => item.domain === domain)?.status || 'discovered',
            'queued'
        ),
        lastSeenAt: now,
        crawlAttempts: (domainIntelCache.frontier.find((item) => item.domain === domain)?.crawlAttempts || 0) + 1
    });

    await updateContinuousDiscoveryState({
        currentDomain: domain,
        lastFrontierRunAt: now,
        lastMessage: `正在递归分析 ${domain}`
    });

    const merged = await collectRecursiveDomainBacklinks(domain);
    if (!collectState.isCollecting || continuousDiscoveryState.isPaused || !continuousDiscoveryState.isRunning) {
        await markDomainCrawlState(domain, { crawlStatus: 'pending' });
        return false;
    }

    if (merged.length === 0) {
        await markDomainCrawlState(domain, {
            crawlStatus: 'completed',
            lastCollectedAt: new Date().toISOString(),
            status: mergeDomainStatus(
                domainIntelCache.frontier.find((item) => item.domain === domain)?.status || 'discovered',
                'profiled'
            )
        });
        await Logger.collect(`持续发现: ${domain} 未发现可继续分析的外链`);
        return true;
    }

    const analysisTargets = await buildAnalysisTargets(merged);
    collectState.stats.targetsFound += analysisTargets.length;
    collectState.stats.inQueue += analysisTargets.length;
    broadcastStats();
    await Logger.collect(`持续发现: ${domain} 准备分析 ${analysisTargets.length} 个目标`);

    await fetchAnalyzeAll(analysisTargets);

    await markDomainCrawlState(domain, {
        crawlStatus: 'completed',
        lastCollectedAt: new Date().toISOString(),
        status: mergeDomainStatus(
            domainIntelCache.frontier.find((item) => item.domain === domain)?.status || 'discovered',
            'expanded'
        )
    });
    return true;
}

async function runContinuousDiscoveryLoop() {
    await ensureContinuousDiscoveryLoaded();
    if (continuousDiscoveryState.isPaused || !continuousDiscoveryState.isRunning) return;

    if (!continuousDiscoveryState.seedInitialized) {
        await updateContinuousDiscoveryState({
            currentDomain: getContinuousSeedDomain(),
            lastMessage: `正在初始化种子网站 ${getContinuousSeedDomain()}`
        });
        await startCollect(
            getContinuousSeedDomain(),
            getContinuousMyDomain(),
            continuousDiscoveryState.sources || []
        );
        await updateContinuousDiscoveryState({
            seedInitialized: true,
            currentDomain: '',
            lastSeedRunAt: new Date().toISOString(),
            lastMessage: '种子网站初始化完成，开始持续处理发现池'
        });
    }

    prepareContinuousCollectContext();
    await chrome.storage.local.set({
        collectState: {
            isCollecting: true,
            domain: getContinuousSeedDomain(),
            myDomain: getContinuousMyDomain()
        }
    });
    await ensureDomainIntelLoaded();
    await ensureCollectTab();

    while (continuousDiscoveryState.isRunning && !continuousDiscoveryState.isPaused) {
        const nextEntry = getNextPendingFrontierDomain();
        if (!nextEntry) {
            break;
        }

        const processed = await processFrontierDomain(nextEntry.domain);
        await ensureContinuousDiscoveryLoaded();
        if (!processed) break;
    }

    const finalState = await getContinuousDiscoveryStateView();
    if (!finalState.pendingDomains) {
        await updateContinuousDiscoveryState({
            isRunning: false,
            currentDomain: '',
            lastCompletedAt: new Date().toISOString(),
            lastMessage: '持续发现已完成，发现池暂时没有新的待递归网站'
        });
        await chrome.storage.local.set({
            collectState: {
                isCollecting: false,
                domain: getContinuousSeedDomain(),
                myDomain: getContinuousMyDomain()
            }
        });
        if (collectTabId) {
            try { await chrome.tabs.remove(collectTabId); } catch {}
            collectTabId = null;
        }
        broadcastToPopup({ action: 'collectDone' });
        return;
    }

    if (continuousDiscoveryState.isPaused) {
        await updateContinuousDiscoveryState({
            currentDomain: '',
            lastMessage: '持续发现已暂停'
        });
        await chrome.storage.local.set({
            collectState: {
                isCollecting: false,
                domain: getContinuousSeedDomain(),
                myDomain: getContinuousMyDomain()
            }
        });
        return;
    }

    await updateContinuousDiscoveryState({
        isRunning: false,
        currentDomain: '',
        lastCompletedAt: new Date().toISOString(),
        lastMessage: '持续发现已结束'
    });
    await chrome.storage.local.set({
        collectState: {
            isCollecting: false,
            domain: getContinuousSeedDomain(),
            myDomain: getContinuousMyDomain()
        }
    });
}

async function resetAllLocalData() {
    await chrome.storage.local.clear();
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
    publishState = {
        isPublishing: false,
        currentTask: null,
        currentIndex: 0,
        queue: [],
        currentWorkflowId: null,
        currentTabId: null,
        currentUrl: '',
        stopRequested: false,
        awaitingManualContinue: false,
        pendingSubmission: null
    };
    domainIntelCache = { frontier: [], profiles: {} };
    domainIntelLoaded = false;
    continuousDiscoveryState = createDefaultContinuousDiscoveryState();
    continuousDiscoveryLoaded = false;
    continuousDiscoveryLoopRunning = false;
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
                entry.candidateType = resolveCandidateType(entry.sourceTypes);
            } else {
                urlMap.set(norm, {
                    url,
                    normalizedUrl: norm,
                    sources: [key],
                    sourceTypes: [item.sourceType],
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
    return {
        url,
        normalizedUrl: normalizeUrlBg(url),
        sources: [...(seed.sources || [])],
        sourceTypes,
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
        }
        await enrichDomainProfileFromPage(url, html, ruleResult);

        // AI 结果增强
        if (aiResult && aiResult.canLeaveLink && !ruleResult) {
            return {
                url,
                pageTitle: html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.trim()?.substring(0, 100) || '',
                opportunities: [aiResult.siteType || 'comment'],
                details: [aiResult.reason || ''],
                sources: link.sources || [],
                sourceTypes: [...(link.sourceTypes || [])],
                candidateType: link.candidateType || resolveCandidateType(link.sourceTypes || []),
                linkMethod: 'website-field',
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
            newlyDiscovered.push({ url: `https://${domain}/`, domain, sourceType: 'ref-domain', sources: ['D'] });
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
            sourceTypes: result.sourceTypes || [],
            candidateType: result.candidateType || resolveCandidateType(result.sourceTypes || []),
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
    task.workflowId = task.workflowId || WorkflowRegistry.DEFAULT_WORKFLOW_ID;
    task.commentStyle = task.commentStyle || 'standard';
    task.maxPublishes = Number(task.maxPublishes) > 0 ? Number(task.maxPublishes) : 0;

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

function getResourcePublishHistoryEntry(resource, taskOrTarget) {
    const targetKey = typeof taskOrTarget === 'string' ? taskOrTarget : taskOrTarget?.key;
    if (!targetKey) return null;
    return resource?.publishHistory?.[targetKey] || null;
}

function canPublishResourceForTask(resource, task) {
    if (resource.status !== 'pending') return false;

    const historyEntry = getResourcePublishHistoryEntry(resource, getTaskPublishTarget(task));
    if (!historyEntry) return true;

    return !['published', 'skipped', 'failed'].includes(historyEntry.lastStatus);
}

function isRateLimitReason(reason = '') {
    return String(reason || '').toLowerCase() === 'comment_rate_limited';
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

async function startPublish(task) {
    if (publishState.isPublishing) {
        await Logger.publish('已有发布任务在运行，请先暂停当前任务后再启动新的任务');
        return {
            success: false,
            code: 'already_running',
            message: '已有发布任务在运行，请先停止当前任务。'
        };
    }

    const data = await chrome.storage.local.get('resources');
    const resources = data.resources || [];
    const workflow = getPublishWorkflow(task);
    const policies = await getAllDomainPublishPolicies();
    const workflowPending = resources.filter(r => r.status === 'pending' && WorkflowRegistry.supportsResource(workflow, r));
    const pendingAll = resources.filter(r => WorkflowRegistry.supportsResource(workflow, r) && canPublishResourceForTask(r, task));
    const pendingReady = pendingAll.filter((resource) => !isResourceCoolingDown(resource, policies));
    const maxPublishes = Number(task?.maxPublishes) > 0 ? Number(task.maxPublishes) : 0;
    const pendingBase = maxPublishes > 0 ? pendingReady.slice(0, maxPublishes) : pendingReady;
    const pending = interleaveResourcesByDomain(pendingBase);

    if (pending.length === 0) {
        const hasWorkflowPending = workflowPending.length > 0;
        const targetUrl = getTaskPublishTarget(task).url || task.website || '';
        const hasOnlyCooldownBlocked = pendingAll.length > 0 && pendingReady.length === 0;
        const message = hasOnlyCooldownBlocked
            ? '当前可发资源都处于域名冷却中，请稍后再试。'
            : hasWorkflowPending
                ? '当前网站之前已经发过这些资源了，没有新的可发资源。'
                : '当前没有可直接发布的博客评论资源。';
        await Logger.publish(`没有找到可用于当前网站且未发布过的资源`, {
            workflowId: workflow?.id || WorkflowRegistry.DEFAULT_WORKFLOW_ID,
            target: targetUrl,
            workflowPending: workflowPending.length,
            cooldownBlocked: pendingAll.length - pendingReady.length
        });
        return {
            success: false,
            code: hasOnlyCooldownBlocked
                ? 'domain_cooldown_active'
                : hasWorkflowPending
                    ? 'site_history_exhausted'
                    : 'no_pending_resources',
            message,
            workflowPending: workflowPending.length,
            eligiblePending: pendingAll.length,
            readyPending: pendingReady.length,
            target: targetUrl
        };
    }

    publishState = {
        isPublishing: true,
        currentTask: task,
        queue: pending,
        currentIndex: 0,
        currentWorkflowId: workflow?.id || WorkflowRegistry.DEFAULT_WORKFLOW_ID,
        currentTabId: null,
        currentUrl: pending[0]?.url || '',
        stopRequested: false,
        awaitingManualContinue: false,
        pendingSubmission: null
    };

    await Logger.publish(`开始发布: ${task.name || task.website}`, {
        total: pending.length,
        workflowId: workflow?.id || WorkflowRegistry.DEFAULT_WORKFLOW_ID,
        maxPublishes
    });
    await publishNext();
    return {
        success: true,
        queued: pending.length
    };
}

async function publishNext() {
    if (!publishState.isPublishing) return;
    if (publishState.awaitingManualContinue) return;
    const cooldownState = await rebalanceCooldownQueue();
    if (cooldownState.moved > 0) {
        await Logger.publish(`已重排 ${cooldownState.moved} 个处于域名冷却中的资源`, {
            taskId: publishState.currentTask?.id || ''
        });
    }
    if (cooldownState.blocked) {
        publishState.isPublishing = false;
        broadcastToPopup({ action: 'publishDone' });
        await Logger.publish('剩余资源全部处于域名冷却中，已暂停本轮发布', {
            taskId: publishState.currentTask?.id || '',
            cooldownUntil: cooldownState.cooldownUntil || ''
        });
        return;
    }
    if (publishState.currentIndex >= publishState.queue.length) {
        publishState.isPublishing = false;
        broadcastToPopup({ action: 'publishDone' });
        await Logger.publish('发布完成');
        return;
    }

    const resource = publishState.queue[publishState.currentIndex];
    const task = publishState.currentTask;
    const workflow = getPublishWorkflow(task);
    const settings = await getSettings();
    const shouldFocus = shouldFocusPublishTab(task, settings);
    let url = resource.url;
    if (!url.startsWith('http')) url = 'https://' + url;
    publishState.currentUrl = resource.url;

    broadcastToPopup({
        action: 'publishProgress',
        currentUrl: resource.url,
        current: publishState.currentIndex + 1,
        total: publishState.queue.length,
        taskId: task.id,
        isPublishing: true
    });

    try {
        const tab = await openOrReusePublishTab(url, { active: shouldFocus });
        await delay(2000);

        if (!publishState.isPublishing) {
            return;
        }

        await sendPublishToTab(tab.id, resource, task, workflow, settings);
    } catch (e) {
        await Logger.error(`发布失败: ${resource.url}`, { error: e.message });
        await updateResourceStatus(resource.id, 'failed');
        publishState.currentIndex++;
        await publishNext();
    }
}

async function handleCommentAction(resourceId, result, taskId, meta = {}) {
    const activeResourceId = publishState.queue?.[publishState.currentIndex]?.id || '';
    if (activeResourceId && activeResourceId !== resourceId) {
        return;
    }

    if (publishState.pendingSubmission?.resourceId === resourceId) {
        publishState.pendingSubmission = null;
    }

    const statusMap = { submitted: 'published', skipped: 'skipped', failed: 'failed' };
    let status = statusMap[result] || result;
    const publishMeta = {
        ...(meta || {}),
        commentStyle: meta.commentStyle || publishState.currentTask?.commentStyle || 'standard',
        anchorRequested: !!meta.anchorRequested,
        anchorInjected: !!meta.anchorInjected,
        anchorText: meta.anchorText || publishState.currentTask?.anchorKeyword || '',
        anchorUrl: meta.anchorUrl || publishState.currentTask?.anchorUrl || publishState.currentTask?.website || '',
        updatedAt: new Date().toISOString()
    };

    if (status === 'published' && publishState.currentTabId) {
        const verification = await verifyPublishedAnchor(publishState.currentTabId, {
            anchorUrl: publishMeta.anchorUrl,
            anchorText: publishMeta.anchorText,
            commenterName: publishState.currentTask?.name_commenter || publishState.currentTask?.name || ''
        });
        if (publishMeta.anchorRequested) {
            publishMeta.anchorVisible = !!verification?.anchorVisible;
            publishMeta.anchorVerified = !!verification;
            publishMeta.anchorVerification = verification || null;
        }
        publishMeta.websiteFieldBlockedFirstComment = !!verification?.websiteFieldBlockedFirstComment;
        if (verification?.noticeExcerpt) {
            publishMeta.websiteFieldNotice = verification.noticeExcerpt;
        }
        publishMeta.submissionBlocked = !!verification?.submissionBlocked;
        publishMeta.submissionBlockReason = verification?.submissionBlockReason || '';
        publishMeta.pageUrlAfterSubmit = verification?.pageUrl || '';
        if (publishMeta.submissionBlocked) {
            status = 'failed';
            await Logger.error('评论提交被站点拦截，已改判为失败', {
                url: publishState.currentUrl,
                reason: publishMeta.submissionBlockReason || '',
                pageUrl: publishMeta.pageUrlAfterSubmit || ''
            });
        }
    }

    if (publishMeta.websiteFieldBlockedFirstComment) {
        const resource = publishState.queue[publishState.currentIndex];
        const settings = await getSettings();
        const shouldFocus = shouldFocusPublishTab(publishState.currentTask, settings);
        await setDomainPublishPolicy(resource?.url || publishState.currentUrl || '', {
            omitWebsiteField: true,
            reason: 'first-comment-website-block',
            updatedAt: new Date().toISOString()
        });

        if (!meta.retryWithoutWebsite && publishState.currentTabId && resource && publishState.currentTask) {
            const workflow = getPublishWorkflow(publishState.currentTask);
            let retryUrl = resource.url;
            if (retryUrl && !retryUrl.startsWith('http')) retryUrl = 'https://' + retryUrl;

            await Logger.publish('检测到首评禁止 Website 字段，已自动改为清空 Website 字段后重试', {
                url: resource.url
            });

            const tab = await openOrReusePublishTab(retryUrl, { active: shouldFocus });
            await delay(2000);

            if (!publishState.isPublishing) return;

            await sendPublishToTab(tab.id, resource, publishState.currentTask, workflow, settings, {
                website: '',
                retryWithoutWebsite: true
            });
            return;
        }

        if (meta.retryWithoutWebsite) {
            status = 'failed';
            publishMeta.websiteRetryExhausted = true;
            await Logger.error('清空 Website 字段后重试仍被站点拦截', {
                url: publishState.currentUrl,
                notice: publishMeta.websiteFieldNotice || ''
            });
        }
    }

    if (status === 'failed' && isRateLimitReason(publishMeta.submissionBlockReason)) {
        const cooldownUntil = new Date(Date.now() + PUBLISH_STRATEGY.DOMAIN_RATE_LIMIT_COOLDOWN_MS).toISOString();
        await setDomainPublishPolicy(publishState.currentUrl || '', {
            cooldownUntil,
            cooldownReason: publishMeta.submissionBlockReason,
            updatedAt: new Date().toISOString()
        });
        publishMeta.cooldownUntil = cooldownUntil;
        publishMeta.cooldownDeferred = true;
        status = 'pending';
        await Logger.publish('站点触发评论限流，已自动进入域名冷却', {
            url: publishState.currentUrl,
            cooldownUntil
        });
    }

    const publishTarget = getTaskPublishTarget(publishState.currentTask || {});
    await updateResourceStatus(resourceId, status, {
        publishMeta,
        publishHistoryEntry: publishTarget.key ? { target: publishTarget } : null
    });
    await Logger.publish(`评论${result}: ${resourceId}`);

    // 更新任务统计
    if (taskId) {
        const data = await chrome.storage.local.get('publishTasks');
        const tasks = data.publishTasks || [];
        const task = tasks.find(t => t.id === taskId);
        if (task) {
            task.stats = task.stats || { total: 0, success: 0, pending: 0, failed: 0 };
            if (status !== 'pending') {
                task.stats.total++;
                if (status === 'published') task.stats.success++;
                else if (status === 'failed') task.stats.failed++;
            }
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

    if (result === 'submitted' && status === 'published') {
        const settings = await getSettings();
        const shouldHoldForReview = publishState.currentTask?.mode !== 'full-auto' || !!settings.publishDebugMode;

        if (shouldHoldForReview) {
            await focusPublishTab();
            publishState.awaitingManualContinue = true;
            broadcastToPopup({
                action: 'publishProgress',
                currentUrl: publishState.currentUrl,
                current: publishState.currentIndex + 1,
                total: publishState.queue.length,
                taskId: publishState.currentTask?.id,
                isPublishing: true,
                awaitingManualContinue: true
            });
            await Logger.publish('当前资源已提交，等待手动继续到下一个页面');
            return;
        }
    }

    if (status === 'pending' && publishMeta.cooldownDeferred) {
        moveCurrentResourceToQueueTail();
    } else {
        publishState.currentIndex++;
    }
    await publishNext();
}

async function updateResourceStatus(id, status, patch = {}) {
    const data = await chrome.storage.local.get('resources');
    const resources = data.resources || [];
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

        resources[idx] = next;
        await chrome.storage.local.set({ resources });
    }
}

async function resetResourcePublishState(resourceId, options = {}) {
    const { preserveHistory = false } = options;
    const data = await chrome.storage.local.get('resources');
    const resources = data.resources || [];
    const idx = resources.findIndex(r => r.id === resourceId);
    if (idx === -1) return false;

    const nextResource = { ...resources[idx], status: 'pending' };
    delete nextResource.publishedAt;
    delete nextResource.publishMeta;
    if (!preserveHistory) {
        delete nextResource.publishHistory;
    }
    resources[idx] = nextResource;
    await chrome.storage.local.set({ resources });
    return true;
}

async function resetAllPublishStatuses() {
    if (publishState.isPublishing) {
        return { success: false, error: '请先停止当前发布任务，再执行重置。' };
    }

    const data = await chrome.storage.local.get('resources');
    const resources = data.resources || [];

    let resetCount = 0;
    let deletedFailedCount = 0;
    const nextResources = resources.reduce((list, resource) => {
        if (resource.status === 'pending' && !resource.publishedAt && !resource.publishMeta) {
            list.push(resource);
            return list;
        }

        if (resource.status === 'failed') {
            deletedFailedCount++;
            return list;
        }

        resetCount++;
        const nextResource = { ...resource, status: 'pending' };
        delete nextResource.publishedAt;
        delete nextResource.publishMeta;
        list.push(nextResource);
        return list;
    }, []);

    await chrome.storage.local.set({
        resources: nextResources
    });
    await Logger.publish(`已重置当前发布状态，并保留各网站历史记录`, {
        resetCount,
        deletedFailedCount
    });

    return { success: true, count: resetCount, deletedFailedCount };
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

async function stopPublish() {
    publishState.isPublishing = false;
    publishState.stopRequested = true;
    publishState.awaitingManualContinue = false;
    publishState.pendingSubmission = null;
    const currentTabId = publishState.currentTabId;
    publishState.currentTabId = null;

    if (currentTabId) {
        try {
            await chrome.tabs.sendMessage(currentTabId, { action: 'stopPublishSession' });
        } catch {}
    }

    broadcastToPopup({ action: 'publishDone' });
    Logger.publish('手动停止发布');
}

async function continuePublish() {
    if (!publishState.isPublishing || !publishState.awaitingManualContinue) return;
    publishState.awaitingManualContinue = false;
    publishState.currentIndex++;
    await publishNext();
}

async function republishResource(resourceId, taskId) {
    const data = await chrome.storage.local.get(['resources', 'publishTasks']);
    const resources = data.resources || [];
    const resource = resources.find(r => r.id === resourceId);
    if (!resource) return;

    await resetResourcePublishState(resourceId, { preserveHistory: true });

    const tasks = data.publishTasks || [];
    const task = taskId ? tasks.find(t => t.id === taskId) : tasks[0];
    if (!task) return;

    publishState = {
        isPublishing: true,
        currentTask: task,
        queue: [resource],
        currentIndex: 0,
        currentWorkflowId: getPublishWorkflow(task)?.id || WorkflowRegistry.DEFAULT_WORKFLOW_ID,
        currentTabId: null,
        currentUrl: resource.url || '',
        stopRequested: false,
        awaitingManualContinue: false,
        pendingSubmission: null
    };
    await publishNext();
}

function shouldFocusPublishTab(task, settings = {}) {
    return task?.mode !== 'full-auto' || !!settings.publishDebugMode;
}

async function focusPublishTab() {
    if (!publishState.currentTabId) return;

    try {
        const tab = await chrome.tabs.get(publishState.currentTabId);
        await chrome.tabs.update(tab.id, { active: true });
        if (typeof tab.windowId === 'number') {
            await chrome.windows.update(tab.windowId, { focused: true });
        }
    } catch {}
}

async function openOrReusePublishTab(url, options = {}) {
    const { active = true } = options;
    const existingTabId = publishState.currentTabId;

    if (existingTabId) {
        try {
            await chrome.tabs.get(existingTabId);
            await chrome.tabs.update(existingTabId, { url, active });
            await waitForTabLoad(existingTabId);
            return { id: existingTabId };
        } catch {
            publishState.currentTabId = null;
        }
    }

    const tab = await chrome.tabs.create({ url, active });
    publishState.currentTabId = tab.id;
    await waitForTabLoad(tab.id);
    return tab;
}

async function sendPublishToTab(tabId, resource, task, workflow, settings, overrides = {}) {
    const domainPolicy = await getDomainPublishPolicy(resource?.url || '');
    const websiteValue = Object.prototype.hasOwnProperty.call(overrides, 'website')
        ? overrides.website
        : (domainPolicy.omitWebsiteField ? '' : (task.website || ''));
    const scriptFiles = workflow?.scripts?.length ? workflow.scripts : ['content/comment-publisher.js'];
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
            name: task.name_commenter || task.name || '',
            email: task.email || '',
            website: websiteValue,
            mode: task.mode || 'semi-auto',
            resourceId: resource.id,
            taskId: task.id,
            useAI: true,
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
                opportunities: resource.opportunities || [],
                details: resource.details || []
            }
        }
    });
}

async function finalizePendingSubmissionFromNavigation(tabId) {
    const pending = publishState.pendingSubmission;
    if (!pending || pending.tabId !== tabId) return;

    publishState.pendingSubmission = null;
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

                    const targetUrl = normalizeUrl(payload.anchorUrl || '');
                    const anchorText = normalizeText(payload.anchorText || '');
                    const commenterName = normalizeText(payload.commenterName || '');
                    const pageTextRaw = String(document.body?.innerText || '').trim();
                    const pageText = normalizeText(pageTextRaw);
                    const pageUrl = String(window.location.href || '');
                    const pagePath = String(window.location.pathname || '').toLowerCase();

                    const anchors = Array.from(document.querySelectorAll('a[href]'));
                    const matchingAnchors = anchors.filter((anchor) => {
                        const href = normalizeUrl(anchor.getAttribute('href') || anchor.href || '');
                        const text = normalizeText(anchor.textContent || '');
                        const hrefMatches = targetUrl && (href === targetUrl || href.includes(targetUrl) || targetUrl.includes(href));
                        const textMatches = !anchorText || text.includes(anchorText);
                        return hrefMatches && textMatches;
                    });

                    const relatedAnchor = matchingAnchors.find((anchor) => {
                        if (!commenterName) return true;
                        const block = anchor.closest('li, article, .comment, .comment-body, .commentlist li, .comment-content, .comment_container, .comments-area');
                        return normalizeText(block?.textContent || '').includes(commenterName);
                    }) || matchingAnchors[0] || null;
                    const websiteFieldBlockedFirstComment =
                        pageText.includes('not permitted to submit a website address')
                        && pageText.includes('delete the website in the website field');
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
                        }
                    ];
                    const submissionBlockedMatch = submissionBlockedPatterns.find((pattern) => {
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
                        websiteFieldBlockedFirstComment,
                        submissionBlocked: !!submissionBlockedMatch,
                        submissionBlockReason: submissionBlockedMatch?.reason || '',
                        noticeExcerpt: (websiteFieldBlockedFirstComment || submissionBlockedMatch) ? pageTextRaw.slice(0, 280) : '',
                        pageUrl
                    };
                },
                args: [options]
            });

            lastResult = results?.[0]?.result || null;
            if (lastResult?.anchorVisible || lastResult?.websiteFieldBlockedFirstComment || lastResult?.submissionBlocked) {
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
        normalized.push({
            url: normalizedUrl,
            sourceType
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
    return score;
}

function getAnalysisTargetScore(link = {}) {
    let score = getAnalysisSeedScore(link);
    if (link.analysisStage === 'direct-page') score += 40;
    if (link.analysisStage === 'domain-drilldown') score += 25;
    if (link.analysisStage === 'domain-homepage') score -= 10;
    return score;
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

async function getDomainPublishPolicy(url) {
    const domain = getDomainBg(url);
    if (!domain) return {};

    const data = await chrome.storage.local.get('domainPublishPolicies');
    return data.domainPublishPolicies?.[domain] || {};
}

async function getAllDomainPublishPolicies() {
    const data = await chrome.storage.local.get('domainPublishPolicies');
    return data.domainPublishPolicies || {};
}

async function setDomainPublishPolicy(url, patch = {}) {
    const domain = getDomainBg(url);
    if (!domain) return;

    const data = await chrome.storage.local.get('domainPublishPolicies');
    const policies = data.domainPublishPolicies || {};
    policies[domain] = {
        ...(policies[domain] || {}),
        ...patch
    };
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

async function rebalanceCooldownQueue() {
    if (!publishState.isPublishing || publishState.currentIndex >= publishState.queue.length) {
        return { moved: 0, blocked: false, cooldownUntil: '' };
    }

    const policies = await getAllDomainPublishPolicies();
    const now = Date.now();
    let moved = 0;
    let scanned = 0;
    let earliestCooldownUntil = '';
    const remaining = publishState.queue.length - publishState.currentIndex;

    while (publishState.currentIndex < publishState.queue.length && scanned < remaining) {
        const resource = publishState.queue[publishState.currentIndex];
        const domain = getDomainBg(resource?.url || '');
        const policy = policies?.[domain] || {};
        const cooldownState = getDomainCooldownState(policy, now);
        if (!cooldownState.active) {
            break;
        }

        if (!earliestCooldownUntil || new Date(cooldownState.cooldownUntil).getTime() < new Date(earliestCooldownUntil).getTime()) {
            earliestCooldownUntil = cooldownState.cooldownUntil;
        }

        const [current] = publishState.queue.splice(publishState.currentIndex, 1);
        if (current) {
            publishState.queue.push(current);
            moved++;
        }
        scanned++;
    }

    return {
        moved,
        blocked: scanned >= remaining && remaining > 0,
        cooldownUntil: earliestCooldownUntil
    };
}

function moveCurrentResourceToQueueTail() {
    if (!publishState.queue?.length || publishState.currentIndex >= publishState.queue.length) return;
    const [current] = publishState.queue.splice(publishState.currentIndex, 1);
    if (current) {
        publishState.queue.push(current);
    }
}

async function persistCollectSnapshot() {
    await chrome.storage.local.set({
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
    const data = await chrome.storage.local.get(['collectState', 'collectStats']);
    return {
        stats: data.collectStats || collectState.stats,
        isCollecting: data.collectState?.isCollecting || collectState.isCollecting
    };
}

function broadcastStats() {
    persistCollectSnapshot().catch(() => {});
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
