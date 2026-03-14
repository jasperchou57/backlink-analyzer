/**
 * Popup.js V3 - 主弹窗逻辑
 * 新增：日志 Tab、多任务管理、AI/Sheets 设置
 */

let currentWorkspace = 'home';
let currentTab = '';
let publishStateView = {
    isPublishing: false,
    activeCount: 0,
    activeTaskIds: [],
    sessions: {},
    batch: {
        isRunning: false,
        isPaused: true,
        currentTaskId: '',
        queueTaskIds: [],
        totalTasks: 0,
        completedTaskIds: [],
        skippedTaskIds: [],
        failedTaskIds: [],
        doneCount: 0,
        remainingCount: 0,
        lastMessage: ''
    }
};
let marketingAutomationState = {
    isRunning: false,
    isPaused: true,
    currentTaskName: '',
    phaseLabel: '',
    pendingTasks: 0,
    dueNurtureTasks: 0,
    processedTasks: 0,
    lastMessage: ''
};
const expandedPublishTaskIds = new Set();
const expandedMarketingTaskIds = new Set();
let visiblePublishTaskIds = [];
let visiblePublishTaskIdsByWorkflow = {};
let resourcePanel = null;
let taskRenderDiagnostics = [];

function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

document.addEventListener('DOMContentLoaded', async () => {
    const surface = await detectSurface();
    document.body.dataset.surface = surface;
    document.body.dataset.workspace = currentWorkspace;

    const homePanel = document.getElementById('panel-home');
    const tabNav = document.getElementById('tab-nav');
    const btnHome = document.getElementById('btn-home');
    const btnEnterBacklink = document.getElementById('btn-enter-backlink');
    const btnEnterMarketing = document.getElementById('btn-enter-marketing');

    // === 关闭按钮 ===
    const btnClose = document.getElementById('btn-close');
    if (btnClose) {
        if (surface === 'sidepanel') {
            btnClose.textContent = '↗';
            btnClose.title = '弹出独立窗口';
            btnClose.addEventListener('click', async () => {
                await chrome.runtime.sendMessage({ action: 'openFloatingPanel' });
            });
        } else {
            btnClose.addEventListener('click', () => window.close());
        }
    }

    // === 初始化语言 ===
    await i18n.loadLanguage();
    const langSelect = document.getElementById('lang-select');
    langSelect.value = i18n.currentLang;
    resourcePanel = ResourcePanel.create({
        storageHelper: StorageHelper,
        workflowRegistry: window.WorkflowRegistry,
        getWorkflowMeta,
        isPublishCandidateForTask: isPublishCandidateForTaskUi,
        escapeHtml,
        i18n,
        getCurrentTab: () => currentTab,
        refreshPublishStats,
        refreshTasks
    });
    updateUILanguage();

    langSelect.addEventListener('change', () => {
        i18n.setLanguage(langSelect.value);
        updateUILanguage();
    });

    const switchWorkspace = async (workspace, targetTab) => {
        currentWorkspace = workspace;
        document.body.dataset.workspace = workspace;

        const isHome = workspace === 'home';
        homePanel.classList.toggle('active', isHome);
        tabNav.classList.toggle('hidden', isHome);

        document.querySelectorAll('.tab-btn').forEach((btn) => {
            const mode = btn.dataset.mode || 'all';
            const isVisible = !isHome && (mode === 'all' || mode === workspace);
            btn.style.display = isVisible ? '' : 'none';
            btn.classList.remove('active');
        });

        document.querySelectorAll('.tab-panel').forEach((panel) => {
            panel.classList.remove('active');
        });

        if (isHome) {
            currentTab = '';
            updatePublishWorkspaceView();
            refreshTasks();
            refreshWorkflowLibrary();
            return;
        }

        const visibleButtons = Array.from(document.querySelectorAll('.tab-btn')).filter((btn) => btn.style.display !== 'none');
        const fallbackTab = workspace === 'marketing' ? 'marketing' : 'collect';
        const nextTab = targetTab || fallbackTab;
        const activeButton = visibleButtons.find((btn) => btn.dataset.tab === nextTab) || visibleButtons[0];
        if (!activeButton) return;

        currentTab = activeButton.dataset.tab;
        activeButton.classList.add('active');

        const targetPanel = document.getElementById('panel-' + currentTab);
        if (targetPanel) {
            targetPanel.classList.add('active');
        }

        updatePublishWorkspaceView();
        refreshWorkflowLibrary();
        refreshTasks();

        if (currentTab === 'resources') {
            resourcePanel?.refresh();
            resourcePanel?.scheduleHeaderSync();
        }
        if (currentTab === 'collect') await refreshDomainIntel();
        if (currentTab === 'publish') {
            refreshPublishStats();
            await refreshPublishState();
        }
        if (currentTab === 'marketing') {
            await refreshMarketingAutomationState();
            await refreshMarketingWorkspace();
        }
        if (currentTab === 'logs') refreshLogs();
    };

    btnHome?.addEventListener('click', async () => {
        await switchWorkspace('home');
    });
    btnEnterBacklink?.addEventListener('click', async () => {
        await switchWorkspace('backlink', 'collect');
    });
    btnEnterMarketing?.addEventListener('click', async () => {
        await switchWorkspace('marketing', 'marketing');
    });

    // === Tab 切换 ===
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const workspace = btn.dataset.mode === 'all' ? (currentWorkspace === 'home' ? 'backlink' : currentWorkspace) : btn.dataset.mode;
            await switchWorkspace(workspace, btn.dataset.tab);
        });
    });

    // === 资源库筛选按钮 ===
    document.querySelectorAll('.res-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.res-filter').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            resourcePanel?.refresh();
            resourcePanel?.scheduleHeaderSync();
        });
    });

    // === 收集按钮 ===
    const btnCollect = document.getElementById('btn-collect');
    const btnPauseCollect = document.getElementById('btn-pause-collect');
    let continuousState = {
        isRunning: false,
        isPaused: true,
        seedDomain: '',
        myDomain: '',
        sources: [],
        currentDomain: '',
        pendingDomains: 0,
        processedDomains: 0,
        lastMessage: ''
    };

    btnCollect.addEventListener('click', async () => {
        const domain = normalizeDomain(document.getElementById('domain-input').value);
        const myDomain = normalizeDomain(document.getElementById('my-domain-input').value);

        if (!domain) {
            document.getElementById('domain-input').focus();
            return;
        }

        const sources = [];
        if (document.getElementById('src-ahrefs').checked) sources.push('ahrefs');
        if (document.getElementById('src-semrush').checked) sources.push('semrush');
        if (document.getElementById('src-similarweb').checked) sources.push('similarweb');

        if (sources.length === 0) {
            alert('请至少选择一个数据源');
            return;
        }

        const resp = await chrome.runtime.sendMessage({
            action: 'startContinuousDiscovery',
            domain,
            myDomain,
            sources
        });

        if (!resp?.success) {
            alert(resp?.message || '启动持续发现失败');
            return;
        }

        await refreshContinuousDiscoveryState();
    });

    btnPauseCollect.addEventListener('click', async () => {
        const resp = await chrome.runtime.sendMessage({ action: 'pauseContinuousDiscovery' });
        if (!resp?.success) {
            alert(resp?.message || '暂停失败');
            return;
        }
        await refreshContinuousDiscoveryState();
    });

    function updateContinuousUI(state = {}) {
        continuousState = {
            ...continuousState,
            ...(state || {})
        };
        const running = !!continuousState.isRunning;
        const paused = !!continuousState.isPaused;
        const dot = document.getElementById('status-dot');
        const text = document.getElementById('status-text');
        const engineTitle = document.getElementById('collect-engine-title');
        const engineDetail = document.getElementById('collect-engine-detail');
        const sessionState = document.getElementById('continuous-session-state');
        const sessionSeed = document.getElementById('continuous-seed-domain');
        const sessionMyDomain = document.getElementById('continuous-my-domain');
        const sessionCurrent = document.getElementById('continuous-current-domain');
        const sessionLastCompleted = document.getElementById('continuous-last-completed');
        const sessionMeta = document.getElementById('continuous-session-meta');
        const sessionSources = document.getElementById('continuous-session-sources');

        btnCollect.disabled = running;
        btnPauseCollect.disabled = !running;
        btnCollect.textContent = (continuousState.pendingDomains || continuousState.processedDomains)
            ? i18n.t('collect.resumeContinuous')
            : i18n.t('collect.startContinuous');

        if (running) {
            dot.className = 'status-dot active';
            text.textContent = i18n.t('collect.analyzing');
            engineTitle.textContent = i18n.t('collect.runningStatus');
        } else if (paused && (continuousState.pendingDomains || continuousState.processedDomains)) {
            dot.className = 'status-dot';
            text.textContent = i18n.t('collect.idle');
            engineTitle.textContent = i18n.t('collect.pausedStatus');
            sessionState.textContent = '已暂停';
        } else {
            dot.className = 'status-dot done';
            text.textContent = i18n.t('collect.done');
            engineTitle.textContent = i18n.t('collect.idleStatus');
            sessionState.textContent = '未启动';
        }

        if (running) {
            sessionState.textContent = '运行中';
        }

        sessionSeed.textContent = continuousState.seedDomain || '-';
        sessionMyDomain.textContent = continuousState.myDomain || '-';
        sessionCurrent.textContent = continuousState.currentDomain || '-';
        sessionLastCompleted.textContent = continuousState.lastCompletedAt
            ? formatTime(continuousState.lastCompletedAt)
            : '-';
        const phaseLabel = continuousState.phaseLabel || (running ? '运行中' : paused ? '已暂停' : '空闲');
        sessionMeta.textContent = `阶段：${phaseLabel} · 待处理 ${continuousState.pendingDomains || 0} · 已处理 ${continuousState.processedDomains || 0} · 失败 ${continuousState.failedDomains || 0}`;

        const sourceLabelMap = {
            ahrefs: 'Ahrefs',
            semrush: 'SEMrush',
            similarweb: 'SimilarWeb'
        };
        sessionSources.innerHTML = '';
        (continuousState.sources || []).forEach((source) => {
            const badge = document.createElement('span');
            badge.className = 'continuous-session-source';
            badge.textContent = sourceLabelMap[source] || source;
            sessionSources.appendChild(badge);
        });

        const detailParts = [];
        if (continuousState.currentDomain) detailParts.push(`${i18n.t('collect.currentDomain')}: ${continuousState.currentDomain}`);
        if (Number.isFinite(continuousState.pendingDomains)) detailParts.push(`${i18n.t('collect.pendingDomains')}: ${continuousState.pendingDomains}`);
        if (Number.isFinite(continuousState.processedDomains)) detailParts.push(`${i18n.t('collect.processedDomains')}: ${continuousState.processedDomains}`);
        if (continuousState.lastMessage) detailParts.push(continuousState.lastMessage);
        engineDetail.textContent = detailParts.join(' · ') || i18n.t('collect.engineHint');
    }
    window.__updateContinuousUI = updateContinuousUI;

    // === 多任务发布 ===
    document.getElementById('btn-add-task').addEventListener('click', () => openTaskEditor());
    document.getElementById('btn-add-marketing-task').addEventListener('click', () => openTaskEditor());
    document.getElementById('btn-start-marketing-automation').addEventListener('click', async () => {
        const result = await chrome.runtime.sendMessage({ action: 'startMarketingAutomation' });
        if (!result?.success) {
            alert(result?.message || '启动持续宣传失败');
            await refreshMarketingAutomationState();
            return;
        }
        await refreshMarketingAutomationState();
        await refreshMarketingWorkspace();
    });
    document.getElementById('btn-pause-marketing-automation').addEventListener('click', async () => {
        const result = await chrome.runtime.sendMessage({ action: 'pauseMarketingAutomation' });
        if (!result?.success) {
            alert(result?.message || '暂停持续宣传失败');
            return;
        }
        await refreshMarketingAutomationState();
    });
    document.getElementById('btn-reset-publish-statuses').addEventListener('click', async () => {
        const confirmed = confirm('“重置资源状态”会把当前所有发布尝试恢复成初始待发状态。\n\n已发布 / 已跳过 / 失败：统一回到待发布\n历史记录：清空\n任务累计统计：清零\n\n确定继续？');
        if (!confirmed) return;

        const result = await chrome.runtime.sendMessage({ action: 'resetAllStatuses' });
        if (!result?.success) {
            alert(result?.error || '重置失败');
            return;
        }

        await refreshPublishState();
        await refreshPublishStats();
        await refreshTasks();
        await resourcePanel?.refresh();
        alert(`已重置 ${result.count || 0} 个资源状态，并清空 ${result.clearedHistoryCount || 0} 条发布历史。\n当前任务统计已归零。`);
    });
    document.getElementById('btn-stop-publish').addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ action: 'stopPublish' });
        await refreshPublishState();
        refreshTasks();
    });
    document.getElementById('btn-continue-publish').addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ action: 'continuePublish' });
        await refreshPublishState();
        refreshTasks();
    });

    // === 资源导出 ===
    document.getElementById('btn-export').addEventListener('click', async () => {
        const resources = await StorageHelper.getResources();
        if (resources.length === 0) return;
        exportToCSV(resources);
    });

    // === 日志 ===
    document.getElementById('btn-clear-logs').addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ action: 'clearLogs' });
        refreshLogs();
    });
    document.getElementById('log-filter').addEventListener('change', () => refreshLogs());

    // === 设置 ===
    document.getElementById('btn-settings').addEventListener('click', () => openSettings());

    // === 清空数据 ===
    document.getElementById('btn-clear').addEventListener('click', async () => {
        if (confirm(i18n.t('footer.clearConfirm'))) {
            await chrome.runtime.sendMessage({ action: 'clearAllData' });
            updateStats({ backlinksFound: 0, targetsFound: 0, analyzed: 0, blogResources: 0, inQueue: 0 });
            await refreshDomainIntel();
            resourcePanel?.refresh();
            refreshPublishStats();
        }
    });

    // === 监听 background 消息 ===
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'statsUpdate') {
            updateStats(msg.stats);
            const collectPanel = document.getElementById('panel-collect');
            if (collectPanel.classList.contains('active')) {
                refreshDomainIntel();
            }
            const publishPanel = document.getElementById('panel-publish');
            if (publishPanel.classList.contains('active')) {
                refreshTasks();
            }
        }
        if (msg.action === 'continuousStateUpdate') {
            updateContinuousUI(msg.state || {});
        }
        if (msg.action === 'marketingStateUpdate') {
            updateMarketingAutomationUI(msg.state || {});
        }
        if (msg.action === 'collectDone') {
            refreshContinuousDiscoveryState();
            refreshDomainIntel();
            const publishPanel = document.getElementById('panel-publish');
            if (publishPanel.classList.contains('active')) {
                refreshTasks();
            }
        }
        if (msg.action === 'publishProgress') {
            updatePublishProgress(msg);
        }
        if (msg.action === 'publishDone') {
            refreshPublishState().then(() => refreshTasks());
        }
        if (msg.action === 'publishBatchUpdate') {
            refreshPublishState().then(() => refreshTasks());
        }
        if (msg.action === 'newLog') {
            const logsPanel = document.getElementById('panel-logs');
            if (logsPanel.classList.contains('active')) {
                refreshLogs();
            }
        }
    });

    // === 初始化数据 ===
    try {
        const resp = await chrome.runtime.sendMessage({ action: 'getStats' });
        if (resp && resp.stats) {
            updateStats(resp.stats);
        }
    } catch { }

    const collectState = await StorageHelper.getCollectState();
    if (collectState.isCollecting || collectState.domain || collectState.myDomain) {
        document.getElementById('domain-input').value = collectState.domain || '';
        document.getElementById('my-domain-input').value = collectState.myDomain || '';
    }
    await refreshContinuousDiscoveryState();
    refreshWorkflowLibrary();
    refreshPublishStats();
    await refreshDomainIntel();
    await refreshPublishState();
    await refreshMarketingAutomationState();
    refreshTasks();
    await refreshMarketingWorkspace();
    await switchWorkspace('home');
    resourcePanel?.ensureListObserver();

    // === 定时轮询最新状态（每 2 秒） ===
    setInterval(async () => {
        try {
            const resp = await chrome.runtime.sendMessage({ action: 'getStats' });
            if (resp && resp.stats) {
                updateStats(resp.stats);
            }
        } catch { }

        try {
            await refreshPublishState();
        } catch { }

        try {
            const collectPanel = document.getElementById('panel-collect');
            if (collectPanel.classList.contains('active')) {
                await refreshDomainIntel();
                await refreshContinuousDiscoveryState();
            }
        } catch { }

        try {
            const publishPanel = document.getElementById('panel-publish');
            if (publishPanel.classList.contains('active')) {
                await refreshTasks();
            }
        } catch { }

        try {
            const marketingPanel = document.getElementById('panel-marketing');
            if (marketingPanel.classList.contains('active')) {
                await refreshMarketingAutomationState();
                await refreshMarketingWorkspace();
            }
        } catch { }
    }, 2000);
});

async function detectSurface() {
    if (!chrome.runtime?.getContexts) {
        return 'window';
    }

    try {
        const contexts = await chrome.runtime.getContexts({
            documentUrls: [window.location.href]
        });
        const currentContext = contexts.find(context => context.documentUrl === window.location.href);
        return currentContext?.contextType === 'SIDE_PANEL' ? 'sidepanel' : 'window';
    } catch {
        return 'window';
    }
}

// === UI 更新函数 ===

function updateStats(stats) {
    document.getElementById('stat-backlinks').textContent = stats.targetsFound ?? stats.backlinksFound ?? 0;
    document.getElementById('stat-analyzed').textContent = stats.analyzed || 0;
    document.getElementById('stat-blogs').textContent = stats.blogResources || 0;
    document.getElementById('stat-queue').textContent = stats.inQueue || 0;
}

async function refreshContinuousDiscoveryState() {
    const resp = await chrome.runtime.sendMessage({ action: 'getContinuousDiscoveryState' });
    const state = resp?.state || {};
    const sources = Array.isArray(state.sources) ? state.sources : [];

    if (!document.getElementById('domain-input').value && state.seedDomain) {
        document.getElementById('domain-input').value = normalizeDomain(state.seedDomain);
    }
    if (!document.getElementById('my-domain-input').value && state.myDomain) {
        document.getElementById('my-domain-input').value = normalizeDomain(state.myDomain);
    }
    if (sources.length > 0) {
        document.getElementById('src-ahrefs').checked = sources.includes('ahrefs');
        document.getElementById('src-semrush').checked = sources.includes('semrush');
        document.getElementById('src-similarweb').checked = sources.includes('similarweb');
    }

    const event = new CustomEvent('continuous-state-refresh', { detail: state });
    document.dispatchEvent(event);
    if (typeof window.__updateContinuousUI === 'function') {
        window.__updateContinuousUI(state);
    }
}

async function refreshDomainIntel() {
    const resp = await chrome.runtime.sendMessage({ action: 'getDomainIntel' });
    const domainIntel = resp?.domainIntel || { items: [], stats: {} };
    const items = domainIntel.items || [];
    const stats = domainIntel.stats || {};

    document.getElementById('domain-frontier-count').textContent = stats.total || 0;
    document.getElementById('domain-profiled-count').textContent = stats.profiled || 0;
    document.getElementById('domain-expanded-count').textContent = stats.expanded || 0;
    document.getElementById('domain-comment-count').textContent = stats.commentDiscovered || 0;

    const list = document.getElementById('domain-frontier-list');
    const empty = document.getElementById('domain-frontier-empty');

    if (items.length === 0) {
        empty.style.display = 'block';
        list.querySelectorAll('.frontier-item').forEach((node) => node.remove());
        return;
    }

    empty.style.display = 'none';
    list.innerHTML = '';

    items.slice(0, 8).forEach((item) => {
        const profile = item.profile || {};
        const node = document.createElement('div');
        node.className = 'frontier-item';

        const tags = [
            `<span class="frontier-tag status-${escapeHtml(item.status || 'discovered')}">${escapeHtml(item.status || 'discovered')}</span>`
        ];
        if (item.crawlStatus) {
            tags.push(`<span class="frontier-tag source-crawl">${escapeHtml(item.crawlStatus)}</span>`);
        }

        if (profile.siteType) tags.push(`<span class="frontier-tag">${escapeHtml(profile.siteType)}</span>`);
        if (profile.topic && profile.topic !== 'general') tags.push(`<span class="frontier-tag">${escapeHtml(profile.topic)}</span>`);
        if (profile.language) tags.push(`<span class="frontier-tag">${escapeHtml(profile.language)}</span>`);
        if (profile.cms) tags.push(`<span class="frontier-tag">${escapeHtml(profile.cms)}</span>`);
        (item.discoveryMethods || []).slice(0, 2).forEach((method) => {
            tags.push(`<span class="frontier-tag source-${escapeHtml(method)}">${escapeHtml(method)}</span>`);
        });

        const detailParts = [];
        if (item.seedTargets?.length) detailParts.push(`目标: ${item.seedTargets.slice(-2).join(', ')}`);
        if (item.commentMentions) detailParts.push(`评论发现 ${item.commentMentions}`);
        if (item.drilldownPages) detailParts.push(`下钻 ${item.drilldownPages} 页`);
        if (item.sampleUrls?.length) detailParts.push(`样本 ${Math.min(item.sampleUrls.length, 6)} 条`);
        if (item.lastCollectedAt) detailParts.push(`递归 ${formatTime(item.lastCollectedAt)}`);
        if (profile.trafficLabel) detailParts.push(`流量 ${profile.trafficLabel}`);

        node.innerHTML = `
            <div class="frontier-item-head">
                <div class="frontier-domain">${escapeHtml(item.domain)}</div>
                <div class="frontier-score">Q ${item.qualityScore || 0}</div>
            </div>
            <div class="frontier-tags">${tags.join('')}</div>
            <div class="frontier-detail">${escapeHtml(detailParts.join(' · ') || profile.title || '已进入持续发现池')}</div>
        `;

        list.appendChild(node);
    });
}

async function refreshMarketingAutomationState() {
    const resp = await chrome.runtime.sendMessage({ action: 'getMarketingAutomationState' });
    updateMarketingAutomationUI(resp?.state || {});
}

function updateMarketingAutomationUI(state = {}) {
    marketingAutomationState = {
        ...marketingAutomationState,
        ...(state || {})
    };

    const btnStart = document.getElementById('btn-start-marketing-automation');
    const btnPause = document.getElementById('btn-pause-marketing-automation');
    const stateEl = document.getElementById('marketing-session-state');
    const taskEl = document.getElementById('marketing-current-task');
    const phaseEl = document.getElementById('marketing-current-phase');
    const pendingEl = document.getElementById('marketing-pending-count');
    const nurtureEl = document.getElementById('marketing-due-nurture-count');
    const messageEl = document.getElementById('marketing-session-message');

    const isRunning = !!marketingAutomationState.isRunning;
    const isPaused = !!marketingAutomationState.isPaused;
    const isScheduled = marketingAutomationState.phase === 'scheduled' || marketingAutomationState.pauseReason === 'scheduled';
    btnStart.disabled = isRunning;
    btnPause.disabled = !isRunning;
    btnStart.textContent = (marketingAutomationState.pendingTasks || marketingAutomationState.dueNurtureTasks || marketingAutomationState.processedTasks)
        ? '继续持续宣传'
        : '开始持续宣传';

    if (isRunning) {
        stateEl.textContent = '运行中';
    } else if (isScheduled) {
        stateEl.textContent = '等待调研';
    } else if (isPaused && (marketingAutomationState.pendingTasks || marketingAutomationState.dueNurtureTasks || marketingAutomationState.processedTasks)) {
        stateEl.textContent = '已暂停';
    } else {
        stateEl.textContent = '未启动';
    }

    taskEl.textContent = marketingAutomationState.currentTaskName || '-';
    phaseEl.textContent = marketingAutomationState.phaseLabel || '-';
    pendingEl.textContent = Number(marketingAutomationState.pendingTasks || 0);
    nurtureEl.textContent = Number(marketingAutomationState.dueNurtureTasks || 0);
    const nextRefreshLabel = formatLastRunLabel(marketingAutomationState.nextPromotionRefreshAt);
    const scheduledHint = isScheduled && nextRefreshLabel && nextRefreshLabel !== '-'
        ? `下次调研：${nextRefreshLabel}`
        : '';
    messageEl.textContent = [marketingAutomationState.lastMessage || '等待开始', scheduledHint].filter(Boolean).join(' · ');
}

async function refreshPublishStats() {
    const resources = await StorageHelper.getResources();
    const counts = { pending: 0, published: 0, skipped: 0, failed: 0 };
    resources.forEach(r => { if (counts[r.status] !== undefined) counts[r.status]++; });
    const anchorPublishedCount = resources.filter(r =>
        r.status === 'published' && (r.publishMeta?.anchorInjected || r.publishMeta?.anchorVisible)
    ).length;

    document.getElementById('pub-pending').textContent = counts.pending;
    document.getElementById('pub-published').textContent = counts.published;
    document.getElementById('pub-skipped').textContent = counts.skipped;
    document.getElementById('pub-failed').textContent = counts.failed;
    document.getElementById('pub-anchor-count').textContent = anchorPublishedCount;

    const blogCount = resources.filter(r =>
        r.status === 'pending' &&
        ((r.opportunities && r.opportunities.includes('comment')) || r.type === 'comment')
    ).length;
    document.getElementById('pub-blog-count').textContent = blogCount;

    const emptyState = document.getElementById('publish-empty');
    if (counts.pending === 0) {
        emptyState.style.display = 'block';
    } else {
        emptyState.style.display = 'none';
    }
}

function updatePublishProgress(msg) {
    if (msg?.taskId) {
        const existing = publishStateView.sessions?.[msg.taskId] || {};
        publishStateView = {
            ...(publishStateView || {}),
            isPublishing: true,
            sessions: {
                ...(publishStateView.sessions || {}),
                [msg.taskId]: {
                    ...existing,
                    isPublishing: !!msg.isPublishing,
                    currentIndex: Math.max(0, Number(msg.current || 1) - 1),
                    total: Number(msg.total || existing.total || 0),
                    currentUrl: msg.currentUrl || existing.currentUrl || '',
                    taskId: msg.taskId,
                    awaitingManualContinue: !!msg.awaitingManualContinue,
                    currentLimitCount: Number(msg.currentLimitCount ?? existing.currentLimitCount ?? 0),
                    targetLimitCount: Number(msg.targetLimitCount ?? existing.targetLimitCount ?? 0),
                    limitType: msg.limitType || existing.limitType || '',
                    sessionPublishedCount: Number(msg.sessionPublishedCount ?? existing.sessionPublishedCount ?? 0),
                    sessionAnchorSuccessCount: Number(msg.sessionAnchorSuccessCount ?? existing.sessionAnchorSuccessCount ?? 0),
                    currentStage: msg.currentStage || existing.currentStage || '',
                    currentStageLabel: msg.currentStageLabel || existing.currentStageLabel || '',
                    currentStageAt: msg.currentStageAt || existing.currentStageAt || ''
                }
            }
        };
    }
    if (currentWorkspace === 'backlink' && currentTab === 'publish') {
        refreshTasks();
    }
}

async function refreshPublishState() {
    const state = await chrome.runtime.sendMessage({ action: 'getPublishState' });
    publishStateView = state || {
        isPublishing: false,
        activeCount: 0,
        activeTaskIds: [],
        sessions: {},
        batch: {
            isRunning: false,
            isPaused: true,
            currentTaskId: '',
            queueTaskIds: [],
            totalTasks: 0,
            completedTaskIds: [],
            skippedTaskIds: [],
            failedTaskIds: [],
            doneCount: 0,
            remainingCount: 0,
            lastMessage: ''
        }
    };
    document.getElementById('publish-current').style.display = 'none';
    return publishStateView;
}

function getAvailableWorkflows() {
    return window.WorkflowRegistry?.list?.() || [];
}

function getWorkflowLabel(workflowId) {
    return window.WorkflowRegistry?.getLabel?.(workflowId) || 'Default Workflow';
}

function getWorkflowDescription(workflowId) {
    return window.WorkflowRegistry?.get?.(workflowId)?.description || '';
}

function getWorkflowMeta(workflowId) {
    return window.WorkflowRegistry?.getMeta?.(workflowId)
        || window.WorkflowRegistry?.get?.(workflowId)
        || null;
}

function getDefaultWorkflowId() {
    return window.WorkflowRegistry?.DEFAULT_WORKFLOW_ID || 'blog-comment-backlink';
}

function isInternalWorkflow(workflowId) {
    return !!(getWorkflowMeta(workflowId)?.internal);
}

function isBacklinkTask(task) {
    const workflowMeta = getWorkflowMeta(task?.workflowId || getDefaultWorkflowId()) || {};
    return (workflowMeta.taskType || 'publish') === 'publish';
}

function isMarketingTask(task) {
    return !isBacklinkTask(task);
}

function isVisibleMarketingTask(task) {
    return isMarketingTask(task) && !isInternalWorkflow(task?.workflowId || getDefaultWorkflowId());
}

function getDefaultWorkflowIdForWorkspace(workspace = currentWorkspace) {
    const workflows = getAvailableWorkflows();
    const wantedMarketing = workspace === 'marketing';
    const match = workflows.find((workflow) => {
        const meta = getWorkflowMeta(workflow.id) || workflow;
        if (meta.internal) return false;
        return wantedMarketing
            ? (meta.taskType || 'publish') !== 'publish'
            : (meta.taskType || 'publish') === 'publish';
    });
    return match?.id || getDefaultWorkflowId();
}

function updatePublishWorkspaceView() {
    const title = document.getElementById('task-panel-title');
    const resetBtn = document.getElementById('btn-reset-publish-statuses');
    const publishStats = document.querySelector('#panel-publish .publish-stats');
    const publishOverview = document.getElementById('publish-overview-global');
    const publishEmpty = document.getElementById('publish-empty');
    const blogBar = document.getElementById('blog-count-bar');
    const anchorBar = document.getElementById('anchor-count-bar');
    const currentBox = document.getElementById('publish-current');

    const isMarketing = currentWorkspace === 'marketing';
    if (title) {
        title.textContent = isMarketing ? '营销任务' : '外链发布任务';
    }
    if (resetBtn) resetBtn.style.display = isMarketing ? 'none' : 'inline-flex';
    if (publishOverview) publishOverview.style.display = 'none';
    if (publishStats) publishStats.style.display = 'none';
    if (blogBar) blogBar.style.display = 'none';
    if (anchorBar) anchorBar.style.display = 'none';
    if (currentBox) currentBox.style.display = 'none';
    if (publishEmpty) publishEmpty.style.display = 'none';
}

function formatLastRunLabel(value) {
    if (!value) return '-';
    return formatTime(value);
}

function getTaskPublishTargetKey(task) {
    return normalizeUrl(task?.website || task?.anchorUrl || '');
}

function getTaskHistoryEntry(resource, task) {
    const targetKey = getTaskPublishTargetKey(task);
    if (!targetKey) return null;
    return resource?.publishHistory?.[targetKey] || null;
}

function getHistoryAttempts(entry) {
    if (!entry) {
        return { published: 0, failed: 0, skipped: 0 };
    }

    const attempts = entry.attempts || {};
    if (Object.keys(attempts).length > 0) {
        return {
            published: attempts.published || 0,
            failed: attempts.failed || 0,
            skipped: attempts.skipped || 0
        };
    }

    return {
        published: entry.lastStatus === 'published' ? 1 : 0,
        failed: entry.lastStatus === 'failed' ? 1 : 0,
        skipped: entry.lastStatus === 'skipped' ? 1 : 0
    };
}

function getCurrentHistoryCounts(entry) {
    return {
        published: entry?.lastStatus === 'published' ? 1 : 0,
        failed: entry?.lastStatus === 'failed' ? 1 : 0,
        skipped: entry?.lastStatus === 'skipped' ? 1 : 0
    };
}

function isPublishCandidateForTaskUi(resource, task = {}) {
    return !!window.ResourceRules?.isPublishCandidateForTask?.(resource, task);
}

function computeTaskPublishOverview(task, resources) {
    const workflow = getWorkflowMeta(task?.workflowId || getDefaultWorkflowId());
    return resources.reduce((stats, resource) => {
        let supported = true;
        try {
            supported = !!window.WorkflowRegistry?.supportsResource?.(workflow, resource, task);
        } catch {
            supported = false;
        }
        if (!supported) {
            return stats;
        }

        const historyEntry = getTaskHistoryEntry(resource, task);
        const attempts = getHistoryAttempts(historyEntry);
        const currentOutcome = getCurrentHistoryCounts(historyEntry);
        const isDirectCandidate = isPublishCandidateForTaskUi(resource, task);
        const hasTaskHistory = !!historyEntry && (attempts.published + attempts.failed + attempts.skipped > 0);
        if (isDirectCandidate || hasTaskHistory) {
            stats.directTotal++;
        }

        stats.published += currentOutcome.published;
        stats.failed += currentOutcome.failed;
        stats.skipped += currentOutcome.skipped;
        stats.total += currentOutcome.published + currentOutcome.failed + currentOutcome.skipped;

        const taskPending =
            (!historyEntry || !['published', 'failed', 'skipped'].includes(historyEntry.lastStatus))
            && isDirectCandidate;
        if (taskPending) {
            stats.pending++;
            stats.direct++;
        }

        if (
            attempts.published > 0 &&
            (historyEntry?.publishMeta?.anchorInjected || historyEntry?.publishMeta?.anchorVisible || historyEntry?.publishMeta?.anchorRequested)
        ) {
            stats.anchorSubmitted++;
        }

        if (attempts.published > 0 && historyEntry?.publishMeta?.anchorVisible) {
            stats.anchorSuccess++;
        }

        return stats;
    }, {
        pending: 0,
        published: 0,
        failed: 0,
        skipped: 0,
        direct: 0,
        directTotal: 0,
        anchorSubmitted: 0,
        anchorSuccess: 0,
        total: 0
    });
}

function resetTaskRenderDiagnostics() {
    taskRenderDiagnostics = [];
}

function reportTaskRenderDiagnostic(task = {}, error = null) {
    const message = String(error?.message || error || 'render-error').trim() || 'render-error';
    taskRenderDiagnostics.push({
        taskId: task?.id || '',
        taskName: task?.name || task?.website || task?.platformUrl || '未命名任务',
        message
    });
    taskRenderDiagnostics = taskRenderDiagnostics.slice(-6);
}

function renderTaskRenderDiagnostics() {
    const panel = document.getElementById('task-render-diagnostics');
    if (!panel) return;

    if (!taskRenderDiagnostics.length) {
        panel.style.display = 'none';
        panel.innerHTML = '';
        return;
    }

    panel.style.display = 'block';
    panel.innerHTML = `
        <div class="task-render-diag-head">任务渲染已降级 ${taskRenderDiagnostics.length} 条</div>
        <div class="task-render-diag-list">
            ${taskRenderDiagnostics.map((item) => `
                <div class="task-render-diag-item">
                    <span class="task-render-diag-name">${escapeHtml(item.taskName)}</span>
                    <span class="task-render-diag-msg">${escapeHtml(item.message)}</span>
                </div>
            `).join('')}
        </div>
    `;
}

function appendFallbackTaskCard(list, task, error) {
    if (!list) return;

    const card = document.createElement('div');
    card.className = 'task-card';
    const workflowId = task?.workflowId || getDefaultWorkflowId();
    const workflowMeta = getWorkflowMeta(workflowId) || {};
    const taskType = workflowMeta.taskType || task?.taskType || 'publish';
    const sessionState = publishStateView.sessions?.[task?.id] || null;
    const isWaitingContinue = !!sessionState?.awaitingManualContinue;
    const isActivePublish = !!sessionState?.isPublishing || isWaitingContinue;
    const runTitle = taskType === 'publish'
        ? (isActivePublish ? '停止发布' : '开始发布')
        : '启动任务';
    const runIcon = taskType === 'publish'
        ? (isActivePublish ? '■' : '▶')
        : '↗';

    card.innerHTML = `
        <div class="task-head">
            <div class="task-info">
                <div class="task-name">${escapeHtml(task?.name || task?.website || task?.id || '未命名任务')}</div>
                <div class="task-meta">${escapeHtml(task?.website || task?.platformUrl || '-')}</div>
                <div class="task-workflow">${escapeHtml(getWorkflowLabel(workflowId))}</div>
                <div class="task-stats-mini">任务卡片渲染降级显示</div>
                <div class="task-stats-mini">${escapeHtml(error?.message || 'render-error')}</div>
            </div>
            <div class="task-actions">
                <button class="task-btn task-run" title="${runTitle}">${runIcon}</button>
                <button class="task-btn task-edit" title="编辑">✎</button>
                <button class="task-btn task-del" title="删除">×</button>
            </div>
        </div>
    `;

    card.querySelector('.task-run')?.addEventListener('click', async () => {
        if (taskType === 'publish') {
            if (isActivePublish) {
                await chrome.runtime.sendMessage({ action: 'stopPublish', taskId: task.id });
                await refreshPublishState();
                await refreshTasks();
                return;
            }

            const result = await chrome.runtime.sendMessage({ action: 'startPublish', task });
            if (!result?.success) {
                alert(result?.message || '开始发布失败');
                await refreshPublishState();
                await refreshTasks();
                return;
            }
            expandedPublishTaskIds.add(task.id);
            await refreshPublishState();
            await refreshTasks();
            return;
        }

        const result = await chrome.runtime.sendMessage({ action: 'runMarketingTask', task });
        if (!result?.success) {
            alert(result?.message || '任务启动失败');
            return;
        }
        await refreshMarketingWorkspace();
        await refreshTasks();
    });

    card.querySelector('.task-edit')?.addEventListener('click', () => {
        openTaskEditor(task);
    });
    card.querySelector('.task-del')?.addEventListener('click', async () => {
        if (confirm(`确定删除任务 "${task?.name || task?.website || task?.id || ''}"？`)) {
            await chrome.runtime.sendMessage({ action: 'deleteTask', taskId: task.id });
            await refreshMarketingWorkspace();
            await refreshTasks();
        }
    });

    list.appendChild(card);
}

function getTaskPublishLimitLabel(task) {
    if (Number(task?.maxPublishes) <= 0) return '不限量';
    return task?.commentStyle === 'anchor-html'
        ? `本次成功锚文本上限 ${task.maxPublishes}`
        : `本次成功发布上限 ${task.maxPublishes}`;
}

function getCommentStyleLabel(commentStyle = 'standard') {
    if (commentStyle === 'anchor-html') return '严格锚文本';
    if (commentStyle === 'anchor-prefer') return '锚文本优先';
    return '普通评论';
}

function getTaskMaxPublishesFieldMeta(commentStyle = 'standard') {
    if (commentStyle === 'anchor-html') {
        return {
            label: '本次成功锚文本上限',
            placeholder: '留空表示持续尝试，直到没有可发资源',
            help: '只在检测到页面支持 HTML 锚文本时才发布；不支持会直接跳过，不会退化成普通评论。'
        };
    }
    if (commentStyle === 'anchor-prefer') {
        return {
            label: '本次成功发布上限',
            placeholder: '留空表示持续尝试，直到没有可发资源',
            help: '优先尝试 HTML 锚文本；如果页面不支持，则自动降级为普通评论发布。'
        };
    }

    return {
        label: '本次成功发布上限',
        placeholder: '留空表示发送全部符合条件的资源',
        help: '达到成功发布数量后，当前任务会自动停止。'
    };
}

function computeTaskStats(task, resources) {
    return resources.reduce((stats, resource) => {
        const historyEntry = getTaskHistoryEntry(resource, task);
        if (!historyEntry) return stats;

        const currentOutcome = getCurrentHistoryCounts(historyEntry);
        stats.success += currentOutcome.published;
        stats.failed += currentOutcome.failed;
        stats.skipped += currentOutcome.skipped;
        stats.total += currentOutcome.published + currentOutcome.failed + currentOutcome.skipped;
        return stats;
    }, { total: 0, success: 0, failed: 0, skipped: 0 });
}

// ============================================================
// 多任务管理
// ============================================================

async function refreshTasks() {
    const resp = await chrome.runtime.sendMessage({ action: 'getTasks' });
    const allTasks = resp?.tasks || [];
    const tasks = currentWorkspace === 'marketing'
        ? allTasks.filter(isVisibleMarketingTask)
        : currentWorkspace === 'backlink'
            ? allTasks.filter(isBacklinkTask)
            : allTasks;
    const resources = await StorageHelper.getResources();
    const publishState = await chrome.runtime.sendMessage({ action: 'getPublishState' });
    publishStateView = publishState || {
        isPublishing: false,
        activeCount: 0,
        activeTaskIds: [],
        sessions: {},
        batch: {
            isRunning: false,
            isPaused: true,
            currentTaskId: '',
            queueTaskIds: [],
            totalTasks: 0,
            completedTaskIds: [],
            skippedTaskIds: [],
            failedTaskIds: [],
            doneCount: 0,
            remainingCount: 0,
            lastMessage: ''
        }
    };
    visiblePublishTaskIds = tasks
        .filter((task) => isBacklinkTask(task))
        .map((task) => task.id)
        .filter(Boolean);
    visiblePublishTaskIdsByWorkflow = tasks
        .filter((task) => isBacklinkTask(task))
        .reduce((map, task) => {
            const workflowId = task.workflowId || getDefaultWorkflowId();
            if (!map[workflowId]) {
                map[workflowId] = [];
            }
            if (task.id) {
                map[workflowId].push(task.id);
            }
            return map;
        }, {});
    refreshWorkflowLibrary();
    const list = currentWorkspace === 'marketing'
        ? document.getElementById('marketing-task-list')
        : document.getElementById('task-list');
    list.innerHTML = '';
    resetTaskRenderDiagnostics();

    const visibleTaskIds = new Set(tasks.map((task) => task.id).filter(Boolean));
    Array.from(expandedPublishTaskIds).forEach((taskId) => {
        if (!visibleTaskIds.has(taskId)) {
            expandedPublishTaskIds.delete(taskId);
        }
    });
    Array.from(expandedMarketingTaskIds).forEach((taskId) => {
        if (!visibleTaskIds.has(taskId)) {
            expandedMarketingTaskIds.delete(taskId);
        }
    });

    if (tasks.length === 0) {
        if (currentWorkspace === 'marketing') {
            document.getElementById('marketing-empty').style.display = 'block';
        } else {
            list.innerHTML = '<div class="empty-hint">暂无外链发布任务，点击"新建任务"创建</div>';
        }
        refreshWorkflowLibrary();
        renderTaskRenderDiagnostics();
        return;
    }

    if (currentWorkspace === 'marketing') {
        document.getElementById('marketing-empty').style.display = 'none';
    }

    tasks.forEach(task => {
        try {
            const card = document.createElement('div');
            card.className = 'task-card';
            const workflowMeta = getWorkflowMeta(task.workflowId || getDefaultWorkflowId()) || {};
            const researchResult = task.researchResult || {};
            const researchContext = task.researchContext || {};
            const promotionPlan = task.promotionPlan || {};
            const promotionChannels = (promotionPlan.channels || []).filter((item) =>
                item?.workflowId !== 'account-nurture' && item?.url
            );
            const totalPromotionChannels = Number(promotionPlan.totalOpenableChannels || promotionChannels.length || 0);
            const progressedPromotionChannels = Math.min(
                totalPromotionChannels,
                Number(promotionPlan.progressedChannelCount || promotionPlan.nextChannelIndex || 0)
            );
            const nextPromotionChannel = totalPromotionChannels > progressedPromotionChannels
                ? promotionChannels[progressedPromotionChannels]
                : null;
            const historyStats = computeTaskStats(task, resources);
            const publishOverview = computeTaskPublishOverview(task, resources);
            const sessionState = publishStateView.sessions?.[task.id] || null;
            const isSessionRunning = !!sessionState?.isPublishing;
            const isWaitingContinue = !!sessionState?.awaitingManualContinue;
            const isActivePublish = isSessionRunning || isWaitingContinue;
            const isExpanded = expandedPublishTaskIds.has(task.id);
            const hasHistoryStats = historyStats.total > 0;
            const stats = hasHistoryStats
                ? historyStats
                : (task.stats || { total: 0, success: 0, pending: 0, failed: 0 });
            const commentStyleLabel = getCommentStyleLabel(task.commentStyle || 'standard');
            const limitLabel = getTaskPublishLimitLabel(task);
            const taskType = workflowMeta.taskType || 'publish';
            const isPromotionCampaign = task.workflowId === 'product-promote-campaign';
            const isExpandedMarketing = expandedMarketingTaskIds.has(task.id);
            const browserSuggestedCount = Number(
                promotionPlan?.browserSuggestedCount
                || researchResult?.browserSuggestedCount
                || 0
            );
            const promotionMix = promotionPlan?.channelMix || researchResult?.channelMix || {};
            const reviewItems = Array.isArray(promotionPlan?.reviewItems) ? promotionPlan.reviewItems : [];
            const pendingReviewItems = reviewItems.filter((item) => !item?.checkedAt);
            const promotionMixSummary = [
                Number(promotionMix['community-post-promote'] || 0) ? `社区 ${promotionMix['community-post-promote']}` : '',
                Number(promotionMix['directory-submit-promote'] || 0) ? `目录 ${promotionMix['directory-submit-promote']}` : '',
                Number(promotionMix['account-nurture'] || 0) ? `养号 ${promotionMix['account-nurture']}` : ''
            ].filter(Boolean).join(' · ');
            const checkedReviewItems = reviewItems.filter((item) => !!item?.checkedAt);
            const reviewSummaryItems = reviewItems.slice(0, 3);
            const nextPromotionRefreshLabel = formatLastRunLabel(promotionPlan?.nextResearchAt || '');
            const nextPromotionLabel = nextPromotionChannel?.name
                || (nextPromotionRefreshLabel && nextPromotionRefreshLabel !== '-'
                    ? `等待下次调研 ${nextPromotionRefreshLabel}`
                    : (totalPromotionChannels > 0 ? '当前候选渠道都已打开过' : '待生成宣传渠道'));
            const taskModeLabel = taskType === 'nurture'
                ? `养号频率 · ${formatFrequencyLabel(task.frequency || 'daily')} · 下次 ${formatLastRunLabel(task.nextRunAt)}`
                : isPromotionCampaign
                    ? `渠道流程 · 已打开 ${progressedPromotionChannels}/${totalPromotionChannels} · 调研 ${researchContext.queries?.length || 0} 组 · 识别 ${browserSuggestedCount} 个渠道 · 养号 ${promotionPlan.generatedNurtureTaskCount || 0}${nextPromotionRefreshLabel && nextPromotionRefreshLabel !== '-' ? ` · 下轮 ${nextPromotionRefreshLabel}` : ''}`
                    : taskType === 'research'
                        ? `调研计划 · 搜索 ${researchContext.queries?.length || 0} 组 · 渠道 ${researchResult.channels?.length || 0} · 识别 ${browserSuggestedCount}`
                        : taskType === 'promote'
                            ? `发帖推广 · ${getHostLabel(task.platformUrl)}`
                            : `${commentStyleLabel} · ${limitLabel}`;
            const subMeta = taskType === 'nurture'
                ? `${escapeHtml(task.platformUrl || task.website || '')} · 自动调度 · 最近 ${formatLastRunLabel(task.lastRunAt)}`
                : isPromotionCampaign
                    ? `${escapeHtml(task.website)} · ${escapeHtml(promotionPlan.summary || task.campaignBrief || '产品宣传主任务')}`
                    : taskType === 'research'
                        ? `${escapeHtml(task.website)} · ${escapeHtml(researchResult.summary || '调研/规划')}`
                        : `${escapeHtml(task.website)} · ${task.mode === 'full-auto' ? '全自动' : '半自动'}`;
            const runTitle = taskType !== 'publish'
                ? (taskType === 'nurture'
                    ? '执行一次养号会话'
                    : isPromotionCampaign
                        ? (progressedPromotionChannels > 0 ? '继续产品宣传流程' : '启动产品宣传流程')
                        : taskType === 'research'
                            ? '打开调研入口'
                            : '打开发帖入口')
                : (isActivePublish ? '停止发布' : '开始发布');
            const runIcon = taskType !== 'publish' ? '↗' : (isActivePublish ? '■' : '▶');
            const queueProgressPercent = sessionState?.total
                ? Math.min(100, Math.round((((sessionState.currentIndex || 0) + (isActivePublish ? 1 : 0)) / sessionState.total) * 100))
                : 0;
            const hasSessionLimit = Number(sessionState?.targetLimitCount || 0) > 0;
            const sessionLimitLabel = sessionState?.limitType === 'anchor-success'
                ? '本次成功锚文本'
                : '本次成功发布';
            const sessionLimitProgressPercent = hasSessionLimit
                ? Math.min(100, Math.round((Number(sessionState?.currentLimitCount || 0) / Number(sessionState?.targetLimitCount || 1)) * 100))
                : queueProgressPercent;
            const sessionAttemptCount = sessionState?.total
                ? Math.min((sessionState.currentIndex || 0) + (isActivePublish ? 1 : 0), sessionState.total)
                : 0;
            const sessionStatusText = hasSessionLimit
                ? `${sessionLimitLabel} ${Number(sessionState?.currentLimitCount || 0)} / ${Number(sessionState?.targetLimitCount || 0)}`
                : (sessionState?.total ? `${sessionAttemptCount} / ${sessionState.total}` : '未启动');
            const sessionSecondaryText = hasSessionLimit && sessionState?.total
                ? `队列进度 ${sessionAttemptCount} / ${sessionState.total}`
                : '';
            const sessionStageText = compactText(sessionState?.currentStageLabel || sessionState?.currentStage || '');
            const publishOverviewHtml = taskType === 'publish'
            ? `
                <div class="task-overview-toggle">${isExpanded ? '收起发布概览' : '展开发布概览'}</div>
                <div class="task-overview ${isExpanded ? 'expanded' : ''}" style="display:${isExpanded ? 'block' : 'none'}">
                    <div class="task-publish-stats">
                        <div class="task-publish-stat">
                            <span class="task-publish-num">${publishOverview.pending}</span>
                            <span class="task-publish-lbl">待发布</span>
                        </div>
                        <div class="task-publish-stat">
                            <span class="task-publish-num green">${publishOverview.published}</span>
                            <span class="task-publish-lbl">已发布</span>
                        </div>
                        <div class="task-publish-stat">
                            <span class="task-publish-num yellow">${publishOverview.skipped}</span>
                            <span class="task-publish-lbl">已跳过</span>
                        </div>
                        <div class="task-publish-stat">
                            <span class="task-publish-num red">${publishOverview.failed}</span>
                            <span class="task-publish-lbl">失败</span>
                        </div>
                    </div>
                    <div class="task-overview-bars">
                        <div class="task-overview-bar">
                            <span class="task-overview-bar-label">🔗 当前任务剩余免登录直发页</span>
                            <span class="task-overview-bar-value">${publishOverview.direct}</span>
                        </div>
                        <div class="task-overview-bar">
                            <span class="task-overview-bar-label">🧭 当前任务累计免登录直发 / 队列进度</span>
                            <span class="task-overview-bar-value">${publishOverview.directTotal}</span>
                        </div>
                        <div class="task-overview-bar anchor">
                            <span class="task-overview-bar-label">🔗 已提交锚文本</span>
                            <span class="task-overview-bar-value">${publishOverview.anchorSubmitted}</span>
                        </div>
                        <div class="task-overview-bar success">
                            <span class="task-overview-bar-label">✅ 成功锚文本外链</span>
                            <span class="task-overview-bar-value">${publishOverview.anchorSuccess}</span>
                        </div>
                    </div>
                    <div class="task-session-box ${isActivePublish ? 'active' : ''}">
                        <div class="task-session-label">${isWaitingContinue ? '当前任务等待继续' : (isSessionRunning ? '当前任务发布中' : '当前任务未运行')}</div>
                        <div class="task-session-url">${escapeHtml(sessionState?.currentUrl || '-')}</div>
                        <div class="task-session-progress">
                            <div class="task-session-progress-fill" style="width:${sessionLimitProgressPercent}%"></div>
                        </div>
                        ${sessionStageText ? `<div class="task-session-subtext">当前阶段：${escapeHtml(sessionStageText)}</div>` : ''}
                        <div class="task-session-foot">
                            <span class="task-session-text">${sessionStatusText}</span>
                            <div class="task-session-actions">
                                ${isWaitingContinue ? `<button class="task-inline-btn task-overview-action task-continue-btn">继续</button>` : ''}
                                ${isActivePublish ? `<button class="task-inline-btn danger task-overview-action task-stop-btn">停止</button>` : ''}
                            </div>
                        </div>
                        ${sessionSecondaryText ? `<div class="task-session-subtext">${sessionSecondaryText}</div>` : ''}
                    </div>
                </div>
            `
            : '';
            const marketingPreview = isPromotionCampaign && promotionPlan.channels?.length
                ? `
                        <div class="task-preview">
                            <div class="task-preview-title">候选渠道</div>
                            <div class="task-preview-list">${escapeHtml(promotionPlan.channels.slice(0, 3).map((item) => item.name || item.url || '').filter(Boolean).join(' · '))}</div>
                            <div class="task-preview-meta">浏览器调研：${researchContext.queries?.length || 0} 组搜索 · 读页 ${researchContext.pageReads?.length || 0} 个 · 识别渠道 ${browserSuggestedCount} 个${promotionMixSummary ? ` · ${escapeHtml(promotionMixSummary)}` : ''} · 待人工检查 ${pendingReviewItems.length} 个 · 下一步：${escapeHtml(nextPromotionLabel)}</div>
                        </div>
                `
                : taskType === 'research' && researchResult.channels?.length
                    ? `
                        <div class="task-preview">
                            <div class="task-preview-title">渠道建议</div>
                            <div class="task-preview-list">${escapeHtml(researchResult.channels.slice(0, 3).map((item) => item.name || item.url || '').filter(Boolean).join(' · '))}</div>
                            <div class="task-preview-meta">浏览器调研：${researchContext.queries?.length || 0} 组搜索 · 读页 ${researchContext.pageReads?.length || 0} 个 · 识别渠道 ${browserSuggestedCount} 个${promotionMixSummary ? ` · ${escapeHtml(promotionMixSummary)}` : ''} · 下一步：${escapeHtml((researchResult.nextSteps || []).slice(0, 2).join(' · ') || '已生成后续任务')}</div>
                        </div>
                    `
                    : '';
            const marketingOverviewHtml = taskType !== 'publish'
                ? `
                    <div class="task-overview-toggle">${isExpandedMarketing ? '收起任务概览' : '展开任务概览'}</div>
                    <div class="task-overview ${isExpandedMarketing ? 'expanded' : ''}" style="display:${isExpandedMarketing ? 'block' : 'none'}">
                        ${isPromotionCampaign ? `
                            <div class="task-publish-stats">
                                <div class="task-publish-stat">
                                    <span class="task-publish-num">${totalPromotionChannels}</span>
                                    <span class="task-publish-lbl">候选渠道</span>
                                </div>
                                <div class="task-publish-stat">
                                    <span class="task-publish-num green">${progressedPromotionChannels}</span>
                                    <span class="task-publish-lbl">已打开</span>
                                </div>
                                <div class="task-publish-stat">
                                    <span class="task-publish-num yellow">${pendingReviewItems.length}</span>
                                    <span class="task-publish-lbl">待人工检查</span>
                                </div>
                                <div class="task-publish-stat">
                                    <span class="task-publish-num">${checkedReviewItems.length}</span>
                                    <span class="task-publish-lbl">已检查</span>
                                </div>
                            </div>
                            <div class="task-overview-bars">
                                <div class="task-overview-bar">
                                    <span class="task-overview-bar-label">💬 社区候选</span>
                                    <span class="task-overview-bar-value">${Number(promotionMix['community-post-promote'] || 0)}</span>
                                </div>
                                <div class="task-overview-bar">
                                    <span class="task-overview-bar-label">📚 目录候选</span>
                                    <span class="task-overview-bar-value">${Number(promotionMix['directory-submit-promote'] || 0)}</span>
                                </div>
                                <div class="task-overview-bar anchor">
                                    <span class="task-overview-bar-label">🌱 养号渠道</span>
                                    <span class="task-overview-bar-value">${Number(promotionMix['account-nurture'] || 0)}</span>
                                </div>
                            </div>
                            <div class="task-session-box ${progressedPromotionChannels > 0 ? 'active' : ''}">
                                <div class="task-session-label">当前宣传状态</div>
                                <div class="task-session-url">${escapeHtml(nextPromotionChannel?.url || reviewItems[0]?.url || task.website || '-')}</div>
                                <div class="task-session-progress">
                                    <div class="task-session-progress-fill" style="width:${totalPromotionChannels ? Math.min(100, Math.round((progressedPromotionChannels / totalPromotionChannels) * 100)) : 0}%"></div>
                                </div>
                                <div class="task-session-foot">
                                    <span class="task-session-text">${totalPromotionChannels ? `${progressedPromotionChannels}/${totalPromotionChannels} · ${escapeHtml(nextPromotionLabel)}` : '待生成宣传渠道'}</span>
                                </div>
                            </div>
                            ${reviewItems.length ? `
                                <div class="marketing-review-list">
                                    ${reviewSummaryItems.map((item) => `
                                        <div class="marketing-review-item ${item.checkedAt ? 'checked' : ''}">
                                            <div class="marketing-review-content">
                                                <div class="marketing-review-name">${escapeHtml(item.name || getHostLabel(item.url || ''))}</div>
                                                <div class="marketing-review-meta">${escapeHtml(getHostLabel(item.url || ''))} · ${item.checkedAt ? `已检查 ${escapeHtml(formatLastRunLabel(item.checkedAt))}` : `已打开待检查 · ${escapeHtml(formatLastRunLabel(item.openedAt))}`}</div>
                                            </div>
                                            <button class="task-inline-btn marketing-review-open task-overview-action" data-url="${escapeHtml(item.url || '')}">打开检查</button>
                                        </div>
                                    `).join('')}
                                </div>
                            ` : ''}
                        ` : `
                            <div class="task-publish-stats">
                                <div class="task-publish-stat">
                                    <span class="task-publish-num">${Number(task.runCount || 0)}</span>
                                    <span class="task-publish-lbl">累计执行</span>
                                </div>
                                <div class="task-publish-stat">
                                    <span class="task-publish-num">${escapeHtml(getHostLabel(task.platformUrl || task.website || '-'))}</span>
                                    <span class="task-publish-lbl">目标平台</span>
                                </div>
                                <div class="task-publish-stat">
                                    <span class="task-publish-num">${escapeHtml(formatLastRunLabel(task.lastRunAt))}</span>
                                    <span class="task-publish-lbl">最近运行</span>
                                </div>
                                <div class="task-publish-stat">
                                    <span class="task-publish-num">${escapeHtml(formatLastRunLabel(task.nextRunAt))}</span>
                                    <span class="task-publish-lbl">下次执行</span>
                                </div>
                            </div>
                            <div class="task-session-box ${Number(task.runCount || 0) > 0 ? 'active' : ''}">
                                <div class="task-session-label">当前养号状态</div>
                                <div class="task-session-url">${escapeHtml(task.platformUrl || task.website || '-')}</div>
                                <div class="task-session-progress">
                                    <div class="task-session-progress-fill" style="width:${Number(task.runCount || 0) > 0 ? 100 : 0}%"></div>
                                </div>
                                <div class="task-session-foot">
                                    <span class="task-session-text">频率 ${escapeHtml(formatFrequencyLabel(task.frequency || 'daily'))} · 下次 ${escapeHtml(formatLastRunLabel(task.nextRunAt))}</span>
                                </div>
                            </div>
                        `}
                    </div>
                `
                : '';
            card.innerHTML = `
            <div class="task-head">
                <div class="task-info">
                    <div class="task-name">${escapeHtml(task.name || task.website)}</div>
                    <div class="task-meta">
                        ${subMeta}
                    </div>
                    <div class="task-workflow">
                        ${escapeHtml(getWorkflowLabel(task.workflowId || getDefaultWorkflowId()))}
                    </div>
                    <div class="task-stats-mini">
                        ${taskModeLabel}
                    </div>
                    <div class="task-stats-mini">
                        ✓${stats.success} · ✗${stats.failed} · Σ${stats.total}
                    </div>
                    ${marketingPreview}
                </div>
                <div class="task-actions">
                    <button class="task-btn task-run ${isActivePublish ? 'running' : ''}" title="${runTitle}">${runIcon}</button>
                    <button class="task-btn task-edit" title="编辑">✎</button>
                    <button class="task-btn task-del" title="删除">×</button>
                </div>
            </div>
            ${publishOverviewHtml}
            ${marketingOverviewHtml}
        `;

            if (taskType === 'publish' || taskType !== 'publish') {
                card.classList.add('task-card-collapsible');
                if ((taskType === 'publish' && isExpanded) || (taskType !== 'publish' && isExpandedMarketing)) {
                    card.classList.add('expanded');
                }
            }

            card.querySelector('.task-run').addEventListener('click', () => {
                if (taskType !== 'publish') {
                    chrome.runtime.sendMessage({ action: 'runMarketingTask', task }).then(async (result) => {
                        if (!result?.success) {
                            alert(result?.message || '任务启动失败');
                            return;
                        }
                        alert(result?.message || '任务已启动');
                        await refreshMarketingWorkspace();
                        await refreshTasks();
                    });
                } else if (isActivePublish) {
                    chrome.runtime.sendMessage({ action: 'stopPublish', taskId: task.id }).then(() => refreshTasks());
                } else {
                    chrome.runtime.sendMessage({ action: 'startPublish', task }).then(async (result) => {
                        if (!result?.success) {
                            alert(result?.message || '开始发布失败');
                            await refreshPublishState();
                            await refreshTasks();
                            await refreshPublishStats();
                            return;
                        }

                        expandedPublishTaskIds.add(task.id);
                        await refreshPublishState();
                        await refreshTasks();
                    });
                }
            });

            card.querySelectorAll('.marketing-review-open').forEach((btn) => {
                btn.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    const url = btn.dataset.url || '';
                    const result = await chrome.runtime.sendMessage({ action: 'inspectMarketingReview', taskId: task.id, url });
                    if (!result?.success) {
                        alert(result?.message || '打开待检查页面失败');
                        return;
                    }
                    await refreshMarketingWorkspace();
                    await refreshTasks();
                });
            });

            if (taskType === 'publish') {
                card.addEventListener('click', async (event) => {
                    if (event.target.closest('.task-actions') || event.target.closest('.task-overview-action')) {
                        return;
                    }
                    if (expandedPublishTaskIds.has(task.id)) {
                        expandedPublishTaskIds.delete(task.id);
                    } else {
                        expandedPublishTaskIds.add(task.id);
                    }
                    await refreshTasks();
                });

                const continueBtn = card.querySelector('.task-continue-btn');
                if (continueBtn) {
                    continueBtn.addEventListener('click', async () => {
                        await chrome.runtime.sendMessage({ action: 'continuePublish', taskId: task.id });
                        await refreshPublishState();
                        await refreshTasks();
                    });
                }

                const stopBtn = card.querySelector('.task-stop-btn');
                if (stopBtn) {
                    stopBtn.addEventListener('click', async () => {
                        await chrome.runtime.sendMessage({ action: 'stopPublish', taskId: task.id });
                        await refreshPublishState();
                        await refreshTasks();
                    });
                }
            } else {
                card.addEventListener('click', async (event) => {
                    if (event.target.closest('.task-actions') || event.target.closest('.task-overview-action')) {
                        return;
                    }
                    if (expandedMarketingTaskIds.has(task.id)) {
                        expandedMarketingTaskIds.delete(task.id);
                    } else {
                        expandedMarketingTaskIds.add(task.id);
                    }
                    await refreshTasks();
                });
            }

            card.querySelector('.task-edit').addEventListener('click', () => {
                openTaskEditor(task);
            });
            card.querySelector('.task-del').addEventListener('click', async () => {
                if (confirm(`确定删除任务 "${task.name || task.website}"？`)) {
                    await chrome.runtime.sendMessage({ action: 'deleteTask', taskId: task.id });
                    await refreshMarketingWorkspace();
                    refreshTasks();
                }
            });

            list.appendChild(card);
        } catch (error) {
            console.error('Failed to render task card', task, error);
            reportTaskRenderDiagnostic(task, error);
            appendFallbackTaskCard(list, task, error);
        }
    });
    renderTaskRenderDiagnostics();
}

function refreshWorkflowLibrary() {
    renderWorkflowLibrary('workflow-library', 'backlink');
    renderWorkflowLibrary('marketing-workflow-library', 'marketing');
}

function renderWorkflowLibrary(containerId, workspace) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const workflows = getAvailableWorkflows().filter((workflow) => {
        const meta = getWorkflowMeta(workflow.id) || workflow;
        if (meta.internal) return false;
        return workspace === 'marketing'
            ? (meta.taskType || 'publish') !== 'publish'
            : (meta.taskType || 'publish') === 'publish';
    });

    container.innerHTML = workflows.map((workflow) => {
        const meta = getWorkflowMeta(workflow.id) || workflow;
        const workflowTaskIds = workspace === 'backlink'
            ? (visiblePublishTaskIdsByWorkflow[workflow.id] || [])
            : [];
        const batchState = publishStateView.batch || {};
        const queuedBatchTaskIds = Array.isArray(batchState.queueTaskIds) ? batchState.queueTaskIds : [];
        const isWorkflowBatchRunning = workspace === 'backlink'
            && !!batchState.isRunning
            && workflowTaskIds.some((taskId) => queuedBatchTaskIds.includes(taskId));
        const isAnyBatchRunning = workspace === 'backlink' && !!batchState.isRunning;
        const workflowDoneCount = workflowTaskIds.filter((taskId) =>
            (batchState.completedTaskIds || []).includes(taskId)
            || (batchState.skippedTaskIds || []).includes(taskId)
            || (batchState.failedTaskIds || []).includes(taskId)
        ).length;
        const workflowBatchSummary = workspace === 'backlink' && workflowTaskIds.length
            ? `${workflowDoneCount}/${workflowTaskIds.length} · ${isWorkflowBatchRunning
                ? `执行中 ${escapeHtml(batchState.lastMessage || '')}`
                : '按当前任务列表顺序逐一执行'}`
            : '';
        const typeLabel = workflow.id === 'product-promote-campaign'
            ? '宣传'
            : meta.taskType === 'nurture'
                ? '养号'
                : meta.taskType === 'research'
                    ? '调研'
                    : meta.taskType === 'promote'
                        ? '发帖'
                        : '发布';
        const canRunWorkflowBatch = workspace === 'backlink' && workflowTaskIds.length > 0;
        const workflowActionLabel = isWorkflowBatchRunning ? '停止' : '发布';
        const workflowActionDisabled = workspace === 'backlink'
            ? (!canRunWorkflowBatch || (isAnyBatchRunning && !isWorkflowBatchRunning))
            : false;
        const workflowActionHint = !canRunWorkflowBatch
            ? '当前没有可执行的发布任务'
            : (isAnyBatchRunning && !isWorkflowBatchRunning)
                ? '另一批任务正在执行中'
                : (isWorkflowBatchRunning
                    ? '停止当前批量发布'
                    : '按当前任务顺序批量发布');

        return `
            <div class="workflow-card">
                <div class="workflow-card-head">
                    <div class="workflow-card-title-wrap">
                        <div class="workflow-card-title">${escapeHtml(workflow.name)}</div>
                        <div class="workflow-card-type">${typeLabel}</div>
                    </div>
                    ${workspace === 'backlink' ? `
                        <button
                            class="workflow-card-action ${isWorkflowBatchRunning ? 'running' : ''}"
                            data-workflow-id="${escapeHtml(workflow.id)}"
                            title="${escapeHtml(workflowActionHint)}"
                            ${workflowActionDisabled ? 'disabled' : ''}
                        >${workflowActionLabel}</button>
                    ` : ''}
                </div>
                <div class="workflow-card-desc">${escapeHtml(workflow.description || '')}</div>
                ${workflowBatchSummary ? `<div class="workflow-card-meta">${workflowBatchSummary}</div>` : ''}
            </div>
        `;
    }).join('');

    if (workspace === 'backlink') {
        container.querySelectorAll('.workflow-card-action').forEach((button) => {
            button.addEventListener('click', async () => {
                const workflowId = button.dataset.workflowId || '';
                const taskIds = visiblePublishTaskIdsByWorkflow[workflowId] || [];
                if (publishStateView.batch?.isRunning) {
                    const result = await chrome.runtime.sendMessage({ action: 'stopPublishBatch' });
                    if (!result?.success) {
                        alert(result?.message || '停止批量发布失败');
                    }
                    await refreshPublishState();
                    await refreshTasks();
                    return;
                }

                const result = await chrome.runtime.sendMessage({ action: 'startPublishBatch', taskIds });
                if (!result?.success) {
                    alert(result?.message || '启动批量发布失败');
                    await refreshPublishState();
                    await refreshTasks();
                    return;
                }
                await refreshPublishState();
                await refreshTasks();
            });
        });
    }
}

async function refreshMarketingWorkspace() {
    const resp = await chrome.runtime.sendMessage({ action: 'getTasks' });
    const allTasks = resp?.tasks || [];
    const tasks = allTasks.filter(isVisibleMarketingTask);

    document.getElementById('marketing-total-tasks').textContent = tasks.length;
    document.getElementById('marketing-promote-count').textContent = tasks.filter((task) => {
        const taskType = getWorkflowMeta(task.workflowId || getDefaultWorkflowId())?.taskType || task.taskType || 'publish';
        return taskType === 'promote' || task.workflowId === 'product-promote-campaign';
    }).length;
    document.getElementById('marketing-nurture-count').textContent = tasks.filter((task) => {
        const taskType = getWorkflowMeta(task.workflowId || getDefaultWorkflowId())?.taskType || task.taskType || 'publish';
        return taskType === 'nurture';
    }).length;
    document.getElementById('marketing-run-count').textContent = tasks.reduce((sum, task) => sum + Number(task.runCount || 0), 0);

    const lastRunAt = tasks
        .map((task) => task.lastRunAt)
        .filter(Boolean)
        .sort()
        .pop();
    document.getElementById('marketing-last-run').textContent = `最近运行：${formatLastRunLabel(lastRunAt)}`;

    if (currentWorkspace === 'marketing' || currentTab === 'marketing') {
        await refreshTasks();
    }
}

async function openTaskEditor(existingTask) {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';

    const task = existingTask || {};
    const settings = await StorageHelper.getSettings();
    const editorWorkspace = existingTask
        ? (isMarketingTask(existingTask) ? 'marketing' : 'backlink')
        : (currentWorkspace === 'marketing' ? 'marketing' : 'backlink');
    const availableWorkflows = getAvailableWorkflows().filter((workflow) => {
        const meta = getWorkflowMeta(workflow.id) || workflow;
        if (meta.internal && workflow.id !== (task.workflowId || '')) return false;
        return editorWorkspace === 'marketing'
            ? (meta.taskType || 'publish') !== 'publish'
            : (meta.taskType || 'publish') === 'publish';
    });
    const workflows = availableWorkflows.length > 0 ? availableWorkflows : [{
        id: getDefaultWorkflowIdForWorkspace(editorWorkspace),
        name: getWorkflowLabel(getDefaultWorkflowIdForWorkspace(editorWorkspace))
    }];
    const selectedWorkflowId = task.workflowId || getDefaultWorkflowIdForWorkspace(editorWorkspace);
    const selectedWorkflowMeta = getWorkflowMeta(selectedWorkflowId) || {};
    const workflowOptions = workflows.map(workflow => `
        <option value="${escapeHtml(workflow.id)}" ${workflow.id === selectedWorkflowId ? 'selected' : ''}>
            ${escapeHtml(workflow.name)}
        </option>
    `).join('');

    const renderWorkflowFields = (workflowId, currentTask = {}) => {
        const workflowMeta = getWorkflowMeta(workflowId) || {};
        const taskType = workflowMeta.taskType || 'publish';

        if (taskType === 'nurture') {
            return `
                <div class="settings-field">
                    <label>平台 URL</label>
                    <input class="input" id="task-platform-url" value="${escapeHtml(currentTask.platformUrl || '')}" placeholder="https://reddit.com/r/example">
                </div>
                <div class="settings-field">
                    <label>执行频率</label>
                    <select class="input" id="task-frequency">
                        <option value="daily" ${currentTask.frequency === 'daily' || !currentTask.frequency ? 'selected' : ''}>每天</option>
                        <option value="every-2-days" ${currentTask.frequency === 'every-2-days' ? 'selected' : ''}>每 2 天</option>
                        <option value="weekly" ${currentTask.frequency === 'weekly' ? 'selected' : ''}>每周</option>
                    </select>
                </div>
                <div class="settings-field">
                    <label>单次养号目标</label>
                    <input class="input" id="task-session-goal" value="${escapeHtml(currentTask.sessionGoal || '')}" placeholder="浏览 10 帖 + 点赞 3 次 + 评论 1 次">
                </div>
                <div class="settings-help">这类任务会作为长期任务保存，后续我会继续把自动调度和平台动作接进执行器。</div>
            `;
        }

        if (workflowId === 'product-promote-campaign') {
            return `
                <div class="settings-field">
                    <label>目标受众</label>
                    <input class="input" id="task-target-audience" value="${escapeHtml(currentTask.targetAudience || '')}" placeholder="独立开发者 / 游戏玩家 / 工具站站长">
                </div>
                <div class="settings-field">
                    <label>偏好渠道</label>
                    <input class="input" id="task-preferred-channels" value="${escapeHtml(currentTask.preferredChannels || '')}" placeholder="Reddit, Product Hunt, Dev.to, HN">
                </div>
                <div class="settings-field">
                    <label>宣传简报</label>
                    <textarea class="input" id="task-campaign-brief" rows="4" placeholder="描述产品、推广目标、限制和希望重点突破的平台">${escapeHtml(currentTask.campaignBrief || '')}</textarea>
                </div>
                <div class="settings-help">这个主任务会先自动调研，再把社区发帖、目录提交整合进同一个宣传流程；只有长期养号会拆成单独任务。</div>
            `;
        }

        if (taskType === 'research') {
            return `
                <div class="settings-field">
                    <label>目标受众</label>
                    <input class="input" id="task-target-audience" value="${escapeHtml(currentTask.targetAudience || '')}" placeholder="独立开发者 / 游戏玩家 / 工具站站长">
                </div>
                <div class="settings-field">
                    <label>偏好渠道</label>
                    <input class="input" id="task-preferred-channels" value="${escapeHtml(currentTask.preferredChannels || '')}" placeholder="Reddit, Product Hunt, Dev.to, HN">
                </div>
                <div class="settings-field">
                    <label>任务简报</label>
                    <textarea class="input" id="task-campaign-brief" rows="4" placeholder="描述产品、推广目标和限制">${escapeHtml(currentTask.campaignBrief || '')}</textarea>
                </div>
            `;
        }

        if (workflowId === 'community-post-promote' || workflowId === 'directory-submit-promote') {
            return `
                <div class="settings-field">
                    <label>平台 URL</label>
                    <input class="input" id="task-platform-url" value="${escapeHtml(currentTask.platformUrl || '')}" placeholder="https://reddit.com/r/example 或 https://www.producthunt.com">
                </div>
                <div class="settings-field">
                    <label>推广简报</label>
                    <textarea class="input" id="task-campaign-brief" rows="4" placeholder="一句话说明这个产品卖点、受众和你想发的平台风格">${escapeHtml(currentTask.campaignBrief || '')}</textarea>
                </div>
                <div class="settings-field">
                    <label>发帖角度 / 分类</label>
                    <input class="input" id="task-post-angle" value="${escapeHtml(currentTask.postAngle || currentTask.submitCategory || '')}" placeholder="Show HN / Launch story / 工具目录 / 游戏推荐">
                </div>
            `;
        }

        return `
            <div class="settings-field">
                <label>评论者名称</label>
                <input class="input" id="task-commenter" value="${escapeHtml(currentTask.name_commenter || '')}">
            </div>
            <div class="settings-field">
                <label>评论者邮箱</label>
                <input class="input" id="task-email" value="${escapeHtml(currentTask.email || '')}">
            </div>
            <div class="settings-field">
                <label>发布模式</label>
                <select class="input" id="task-mode">
                    <option value="semi-auto" ${currentTask.mode !== 'full-auto' ? 'selected' : ''}>半自动（逐个确认）</option>
                    <option value="full-auto" ${currentTask.mode === 'full-auto' ? 'selected' : ''}>全自动（自动提交）</option>
                </select>
            </div>
            <div class="settings-field">
                <label>评论模式</label>
                <select class="input" id="task-comment-style">
                    <option value="standard" ${!['anchor-html', 'anchor-prefer'].includes(currentTask.commentStyle) ? 'selected' : ''}>普通评论</option>
                    <option value="anchor-prefer" ${currentTask.commentStyle === 'anchor-prefer' ? 'selected' : ''}>锚文本优先（失败降级普通评论）</option>
                    <option value="anchor-html" ${currentTask.commentStyle === 'anchor-html' ? 'selected' : ''}>严格 HTML 锚文本模式（不支持即跳过）</option>
                </select>
            </div>
            <div class="settings-field">
                <label id="task-max-publishes-label">${escapeHtml(getTaskMaxPublishesFieldMeta(currentTask.commentStyle || 'standard').label)}</label>
                <input class="input" id="task-max-publishes" type="number" min="1" value="${currentTask.maxPublishes ? escapeHtml(String(currentTask.maxPublishes)) : ''}" placeholder="${escapeHtml(getTaskMaxPublishesFieldMeta(currentTask.commentStyle || 'standard').placeholder)}">
                <div class="settings-help" id="task-max-publishes-help">${escapeHtml(getTaskMaxPublishesFieldMeta(currentTask.commentStyle || 'standard').help)}</div>
            </div>
            <div class="settings-field">
                <label>锚文本关键词</label>
                <input class="input" id="task-anchor-keyword" value="${escapeHtml(currentTask.anchorKeyword || '')}" placeholder="${escapeHtml(settings.anchorKeyword || '留空则回退到设置页关键词')}">
            </div>
            <div class="settings-field">
                <label>锚文本目标 URL</label>
                <input class="input" id="task-anchor-url" value="${escapeHtml(currentTask.anchorUrl || '')}" placeholder="${escapeHtml(settings.anchorUrl || currentTask.website || '留空则回退到任务网站 URL')}">
                <div class="settings-help">${currentTask.commentStyle === 'anchor-html' ? '只有检测到当前平台支持 HTML 锚文本时才会发布；不支持会直接跳过，不会改成普通评论。' : currentTask.commentStyle === 'anchor-prefer' ? '会优先尝试 HTML 锚文本；如果当前页面不支持，则自动改走普通评论链路。' : '普通评论模式下会优先走 website 字段等常规留链方式。'}</div>
            </div>
        `;
    };

    overlay.innerHTML = `
        <h2>
            <button class="settings-back" id="task-back">← 返回</button>
            ${task.id ? '编辑任务' : (editorWorkspace === 'marketing' ? '新建营销任务' : '新建外链任务')}
        </h2>

        <div class="settings-section">
            <div class="settings-field">
                <label>任务名称</label>
                <input class="input" id="task-name" value="${escapeHtml(task.name || '')}" placeholder="例如：主站推广">
            </div>
            <div class="settings-field">
                <label>推广网站 URL</label>
                <input class="input" id="task-website" value="${escapeHtml(task.website || '')}" placeholder="https://mysite.com">
            </div>
            <div class="settings-field">
                <label>工作流</label>
                <select class="input" id="task-workflow">
                    ${workflowOptions}
                </select>
                <div class="settings-help" id="task-workflow-desc">${escapeHtml(getWorkflowDescription(selectedWorkflowId))}</div>
            </div>
            <div id="task-workflow-fields">
                ${renderWorkflowFields(selectedWorkflowId, task)}
            </div>
        </div>

        <button class="btn-save" id="btn-save-task">保存任务</button>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#task-back').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#task-workflow').addEventListener('change', (event) => {
        const workflowId = event.target.value;
        overlay.querySelector('#task-workflow-desc').textContent = getWorkflowDescription(workflowId);
        overlay.querySelector('#task-workflow-fields').innerHTML = renderWorkflowFields(workflowId, task);
    });
    const updateMaxPublishesFieldMeta = () => {
        const commentStyle = overlay.querySelector('#task-comment-style')?.value || 'standard';
        const fieldMeta = getTaskMaxPublishesFieldMeta(commentStyle);
        const labelEl = overlay.querySelector('#task-max-publishes-label');
        const inputEl = overlay.querySelector('#task-max-publishes');
        const helpEl = overlay.querySelector('#task-max-publishes-help');
        if (labelEl) labelEl.textContent = fieldMeta.label;
        if (inputEl) inputEl.placeholder = fieldMeta.placeholder;
        if (helpEl) helpEl.textContent = fieldMeta.help;
    };
    overlay.addEventListener('change', (event) => {
        if (event.target?.id === 'task-comment-style') {
            updateMaxPublishesFieldMeta();
        }
    });
    updateMaxPublishesFieldMeta();
    overlay.querySelector('#btn-save-task').addEventListener('click', async () => {
        const website = overlay.querySelector('#task-website').value.trim();
        if (!website) {
            overlay.querySelector('#task-website').focus();
            return;
        }

        const workflowId = overlay.querySelector('#task-workflow').value || getDefaultWorkflowIdForWorkspace(editorWorkspace);
        const workflowMeta = getWorkflowMeta(workflowId) || {};
        const taskType = workflowMeta.taskType || 'publish';

        const taskData = {
            id: task.id || undefined,
            name: overlay.querySelector('#task-name').value.trim() || website,
            website,
            workflowId,
            taskType
        };

        if (taskType === 'nurture') {
            taskData.platformUrl = overlay.querySelector('#task-platform-url')?.value.trim() || '';
            taskData.frequency = overlay.querySelector('#task-frequency')?.value || 'daily';
            taskData.sessionGoal = overlay.querySelector('#task-session-goal')?.value.trim() || '';
        } else if (workflowId === 'product-promote-campaign') {
            taskData.targetAudience = overlay.querySelector('#task-target-audience')?.value.trim() || '';
            taskData.preferredChannels = overlay.querySelector('#task-preferred-channels')?.value.trim() || '';
            taskData.campaignBrief = overlay.querySelector('#task-campaign-brief')?.value.trim() || '';
        } else if (taskType === 'research') {
            taskData.targetAudience = overlay.querySelector('#task-target-audience')?.value.trim() || '';
            taskData.preferredChannels = overlay.querySelector('#task-preferred-channels')?.value.trim() || '';
            taskData.campaignBrief = overlay.querySelector('#task-campaign-brief')?.value.trim() || '';
        } else if (taskType === 'promote' && workflowId !== 'blog-comment-backlink') {
            taskData.platformUrl = overlay.querySelector('#task-platform-url')?.value.trim() || '';
            taskData.campaignBrief = overlay.querySelector('#task-campaign-brief')?.value.trim() || '';
            taskData.postAngle = overlay.querySelector('#task-post-angle')?.value.trim() || '';
            if (workflowId === 'directory-submit-promote') {
                taskData.submitCategory = taskData.postAngle;
            }
        } else {
            taskData.name_commenter = overlay.querySelector('#task-commenter')?.value.trim() || '';
            taskData.email = overlay.querySelector('#task-email')?.value.trim() || '';
            taskData.maxPublishes = Number(overlay.querySelector('#task-max-publishes')?.value) > 0
                ? Number(overlay.querySelector('#task-max-publishes').value)
                : 0;
            taskData.mode = overlay.querySelector('#task-mode')?.value || 'semi-auto';
            taskData.commentStyle = overlay.querySelector('#task-comment-style')?.value || 'standard';
            taskData.anchorKeyword = overlay.querySelector('#task-anchor-keyword')?.value.trim() || '';
            taskData.anchorUrl = overlay.querySelector('#task-anchor-url')?.value.trim() || '';
        }

        await chrome.runtime.sendMessage({ action: 'saveTask', task: taskData });
        overlay.remove();
        refreshTasks();
    });
}

// ============================================================
// 日志 Tab
// ============================================================

async function refreshLogs() {
    const resp = await chrome.runtime.sendMessage({ action: 'getLogs' });
    const allLogs = resp?.logs || [];
    const filter = document.getElementById('log-filter').value;
    const logs = filter === 'all' ? allLogs : allLogs.filter(l => l.type === filter);

    const list = document.getElementById('logs-list');
    const empty = document.getElementById('logs-empty');

    if (logs.length === 0) {
        list.innerHTML = '';
        list.appendChild(empty);
        empty.style.display = 'block';
        return;
    }

    empty.style.display = 'none';
    list.innerHTML = '';

    const LOG_TYPE_ICONS = {
        collect: '📡', publish: '📤', ai: '🤖', error: '❌', system: 'ℹ️', analyze: '🔍'
    };

    logs.slice(0, 100).forEach(log => {
        const item = document.createElement('div');
        item.className = `log-item log-${log.type}`;
        const time = log.timestamp ? formatTime(log.timestamp) : '';
        item.innerHTML = `
            <span class="log-icon">${LOG_TYPE_ICONS[log.type] || '•'}</span>
            <span class="log-msg">${escapeHtml(log.message)}</span>
            <span class="log-time">${time}</span>
        `;
        list.appendChild(item);
    });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function normalizeHttpUrl(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function getHostLabel(url) {
    try {
        return new URL(normalizeHttpUrl(url)).hostname || '未设置平台';
    } catch {
        return url ? String(url) : '未设置平台';
    }
}

function formatFrequencyLabel(frequency) {
    switch (frequency) {
        case 'daily':
            return '每天';
        case 'every-2-days':
            return '每 2 天';
        case 'weekly':
            return '每周';
        default:
            return frequency || '未设置';
    }
}

function createEmptyAiUsageBucket() {
    return {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimatedCost: 0,
        lastUsedAt: ''
    };
}

function normalizeAiUsageStats(stats) {
    const normalized = {
        totals: createEmptyAiUsageBucket(),
        byTask: {},
        byModel: {},
        updatedAt: '',
        ...(stats || {})
    };

    normalized.totals = {
        ...createEmptyAiUsageBucket(),
        ...(stats?.totals || {})
    };
    normalized.byTask = { ...(stats?.byTask || {}) };
    normalized.byModel = { ...(stats?.byModel || {}) };

    Object.keys(normalized.byTask).forEach((key) => {
        normalized.byTask[key] = {
            ...createEmptyAiUsageBucket(),
            ...(normalized.byTask[key] || {})
        };
    });
    Object.keys(normalized.byModel).forEach((key) => {
        normalized.byModel[key] = {
            ...createEmptyAiUsageBucket(),
            ...(normalized.byModel[key] || {})
        };
    });

    return normalized;
}

function formatUsageNumber(value, fractionDigits = 0) {
    return Number(value || 0).toLocaleString('zh-CN', {
        minimumFractionDigits: 0,
        maximumFractionDigits: fractionDigits
    });
}

function formatUsageCurrency(value) {
    const amount = Number(value || 0);
    return amount >= 1
        ? `${formatUsageNumber(amount, 2)} 元`
        : `${formatUsageNumber(amount, 4)} 元`;
}

function buildAiUsageStatsMarkup(rawStats) {
    const stats = normalizeAiUsageStats(rawStats);
    const totals = stats.totals || createEmptyAiUsageBucket();
    const avgCostPerRequest = totals.requests > 0 ? (totals.estimatedCost / totals.requests) : 0;
    const modelLabelMap = {
        classify: '链接分类',
        formExtract: '表单识别',
        commentGen: '评论生成',
        linkDiscover: '链接发现',
        researchPlan: '调研计划'
    };

    const modelRows = Object.entries(stats.byModel || {})
        .sort((a, b) => (b[1]?.totalTokens || 0) - (a[1]?.totalTokens || 0))
        .slice(0, 6)
        .map(([model, bucket]) => `
            <div class="ai-usage-row">
              <div class="ai-usage-row-main">
                <div class="ai-usage-row-title">${escapeHtml(model)}</div>
                <div class="ai-usage-row-meta">${formatUsageNumber(bucket.requests)} 次 · ${formatUsageNumber(bucket.totalTokens)} tokens</div>
              </div>
              <div class="ai-usage-row-value">${formatUsageCurrency(bucket.estimatedCost)}</div>
            </div>
        `).join('');

    const taskRows = Object.entries(stats.byTask || {})
        .sort((a, b) => (b[1]?.estimatedCost || 0) - (a[1]?.estimatedCost || 0))
        .slice(0, 6)
        .map(([task, bucket]) => `
            <div class="ai-usage-row">
              <div class="ai-usage-row-main">
                <div class="ai-usage-row-title">${escapeHtml(modelLabelMap[task] || task)}</div>
                <div class="ai-usage-row-meta">${formatUsageNumber(bucket.requests)} 次 · 输入 ${formatUsageNumber(bucket.promptTokens)} / 输出 ${formatUsageNumber(bucket.completionTokens)}</div>
              </div>
              <div class="ai-usage-row-value">${formatUsageCurrency(bucket.estimatedCost)}</div>
            </div>
        `).join('');

    return `
      <div class="settings-section-head">
        <h4>📈 模型用量</h4>
        <button class="btn-inline danger" id="btn-reset-ai-usage">重置统计</button>
      </div>
      <div class="ai-usage-grid">
        <div class="ai-usage-card">
          <div class="ai-usage-label">总请求数</div>
          <div class="ai-usage-value">${formatUsageNumber(totals.requests)}</div>
        </div>
        <div class="ai-usage-card">
          <div class="ai-usage-label">总 Token</div>
          <div class="ai-usage-value">${formatUsageNumber(totals.totalTokens)}</div>
        </div>
        <div class="ai-usage-card">
          <div class="ai-usage-label">输入 / 输出</div>
          <div class="ai-usage-value small">${formatUsageNumber(totals.promptTokens)} / ${formatUsageNumber(totals.completionTokens)}</div>
        </div>
        <div class="ai-usage-card">
          <div class="ai-usage-label">估算花费</div>
          <div class="ai-usage-value">${formatUsageCurrency(totals.estimatedCost)}</div>
        </div>
      </div>
      <div class="ai-usage-summary">
        <span>平均每次请求：${formatUsageCurrency(avgCostPerRequest)}</span>
        <span>最近更新：${stats.updatedAt ? escapeHtml(formatTime(stats.updatedAt)) : '暂无'}</span>
      </div>
      <div class="ai-usage-panels">
        <div class="ai-usage-panel">
          <div class="ai-usage-panel-title">按模型</div>
          <div class="ai-usage-list">
            ${modelRows || '<div class="ai-usage-empty">暂无模型调用记录</div>'}
          </div>
        </div>
        <div class="ai-usage-panel">
          <div class="ai-usage-panel-title">按任务</div>
          <div class="ai-usage-list">
            ${taskRows || '<div class="ai-usage-empty">暂无任务调用记录</div>'}
          </div>
        </div>
      </div>
      <div class="settings-help">当前已对 qwen-plus / qwen-turbo 做估算，也会把 qwen3.5-plus / qwen3.5-flash 按对应档位近似估算；其他模型只统计 token。</div>
    `;
}

const QWEN_MODEL_OPTIONS = [
    'qwen3.5-flash',
    'qwen3.5-plus',
    'qwen3.5-flash-2026-02-23',
    'qwen3.5-plus-2026-02-15',
    'qwen3.5-35b-a3b',
    'qwen3.5-27b',
    'qwen3.5-122b-a10b',
    'qwen3.5-397b-a17b',
    'qwen-plus',
    'qwen-turbo'
];

function buildQwenModelSelectOptions(currentValue = '') {
    const options = [''].concat(QWEN_MODEL_OPTIONS);
    if (currentValue && !options.includes(currentValue)) {
        options.push(currentValue);
    }
    return options.map((model) => {
        const label = model || '未选择';
        const selected = model === currentValue ? 'selected' : '';
        return `<option value="${escapeHtml(model)}" ${selected}>${escapeHtml(label)}</option>`;
    }).join('');
}

// ============================================================
// 设置面板（含 AI + Google Sheets 配置）
// ============================================================

async function openSettings() {
    const settings = await StorageHelper.getSettings();
    const usageResponse = await chrome.runtime.sendMessage({ action: 'getAIUsageStats' }).catch(() => ({ stats: null }));
    const usageStats = usageResponse?.stats || null;
    const providerOptions = [
        { value: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
        { value: 'siliconflow', label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1' },
        { value: 'custom', label: '自定义 OpenAI 兼容接口', baseUrl: '' }
    ];
    const selectedProvider = settings.aiProvider || (settings.aiBaseUrl ? 'custom' : 'openrouter');
    const currentApiKey = settings.aiApiKey || settings.openrouterApiKey || '';
    const currentBaseUrl = settings.aiBaseUrl
        || providerOptions.find((item) => item.value === selectedProvider)?.baseUrl
        || providerOptions[0].baseUrl;

    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';

    const templatesHtml = (settings.commentTemplates || []).map((tpl, i) => `
    <div class="template-item" data-idx="${i}">
      <textarea class="tpl-text">${escapeHtml(tpl)}</textarea>
      <button class="template-remove" data-idx="${i}">×</button>
    </div>
  `).join('');

    overlay.innerHTML = `
    <h2>
      <button class="settings-back" id="settings-back">${i18n.t('settings.back')}</button>
      ${i18n.t('settings.title')}
    </h2>

    <div class="settings-section">
      <h4>🤖 AI 配置</h4>
      <div class="settings-field">
        <label>Provider</label>
        <select class="input" id="set-ai-provider">
          ${providerOptions.map((item) => `
            <option value="${item.value}" ${item.value === selectedProvider ? 'selected' : ''}>${item.label}</option>
          `).join('')}
        </select>
      </div>
      <div class="settings-field">
        <label>Base URL</label>
        <input class="input" id="set-ai-base-url" value="${escapeHtml(currentBaseUrl)}" placeholder="https://api.example.com/v1">
        <div class="settings-help" id="set-ai-provider-help"></div>
      </div>
      <div class="settings-field">
        <label>API Key</label>
        <input class="input" id="set-api-key" type="password" value="${escapeHtml(currentApiKey)}" placeholder="sk-...">
      </div>
      <div class="settings-help">下面四个模型都改成下拉栏，你自己从这批 Qwen 模型里选。</div>
      <div class="settings-field">
        <label>链接分类模型 (classify)</label>
        <select class="input" id="set-model-classify">
          ${buildQwenModelSelectOptions(settings.modelClassify || '')}
        </select>
      </div>
      <div class="settings-field">
        <label>表单识别模型 (formExtract)</label>
        <select class="input" id="set-model-form">
          ${buildQwenModelSelectOptions(settings.modelFormExtract || '')}
        </select>
      </div>
      <div class="settings-field">
        <label>评论生成模型 (commentGen)</label>
        <select class="input" id="set-model-comment">
          ${buildQwenModelSelectOptions(settings.modelCommentGen || '')}
        </select>
      </div>
      <div class="settings-field">
        <label>链接发现模型 (linkDiscover)</label>
        <select class="input" id="set-model-link">
          ${buildQwenModelSelectOptions(settings.modelLinkDiscover || '')}
        </select>
      </div>
      <button class="btn-test" id="btn-test-ai">🔌 测试 AI 连接</button>
      <div class="test-result" id="ai-test-result"></div>
    </div>

    <div class="settings-section" id="ai-usage-section">
      ${buildAiUsageStatsMarkup(usageStats)}
    </div>

    <div class="settings-section">
      <h4>📊 Google Sheets</h4>
      <div class="settings-field">
        <label>Google Sheet ID</label>
        <input class="input" id="set-sheet-id" value="${escapeHtml(settings.googleSheetId || '')}" placeholder="从 Sheet URL 中提取的 ID">
      </div>
      <button class="btn-test" id="btn-sync-sheets">☁ 同步到 Sheets</button>
      <div class="test-result" id="sheets-result"></div>
    </div>

    <div class="settings-section">
      <h4>${i18n.t('settings.userInfo')}</h4>
      <div class="settings-field">
        <label>${i18n.t('settings.name')}</label>
        <input class="input" id="set-name" value="${escapeHtml(settings.name || '')}">
      </div>
      <div class="settings-field">
        <label>${i18n.t('settings.email')}</label>
        <input class="input" id="set-email" type="email" value="${escapeHtml(settings.email || '')}">
      </div>
      <div class="settings-field">
        <label>${i18n.t('settings.website')}</label>
        <input class="input" id="set-website" value="${escapeHtml(settings.website || '')}">
      </div>
    </div>

    <div class="settings-section">
      <h4>${i18n.t('settings.anchor')}</h4>
      <div class="settings-field">
        <label>${i18n.t('settings.anchorKeyword')}</label>
        <input class="input" id="set-anchor-kw" value="${escapeHtml(settings.anchorKeyword || '')}">
      </div>
      <div class="settings-field">
        <label>${i18n.t('settings.anchorUrl')}</label>
        <input class="input" id="set-anchor-url" value="${escapeHtml(settings.anchorUrl || '')}">
      </div>
    </div>

    <div class="settings-section">
      <h4>${i18n.t('settings.templates')}</h4>
      <div style="font-size:11px;color:#8891a8;margin-bottom:8px">可用变量: {title} {greeting} {complement} {question} {domain} {keyword}</div>
      <div id="templates-list">${templatesHtml}</div>
      <button class="btn-add-template" id="btn-add-tpl">+ ${i18n.t('settings.addTemplate')}</button>
    </div>

    <div class="settings-section">
      <h4>🧪 发布调试</h4>
      <label class="settings-toggle">
        <input type="checkbox" id="set-publish-debug" ${settings.publishDebugMode ? 'checked' : ''}>
        <span class="settings-toggle-copy">
          <span class="settings-toggle-title">启用发布调试模式</span>
          <span class="settings-toggle-desc">开启后，即使任务是全自动，也会在提交前暂停。插件会高亮验证码/反垃圾复选框，并展示识别结果，方便你检查它是否正确过验证。</span>
        </span>
      </label>
    </div>

    <button class="btn-save" id="btn-save-settings">${i18n.t('settings.save')}</button>
    <div class="save-toast" id="save-toast">${i18n.t('settings.saved')}</div>
  `;

    document.body.appendChild(overlay);

    const providerMap = Object.fromEntries(providerOptions.map((item) => [item.value, item]));
    const providerSelect = overlay.querySelector('#set-ai-provider');
    const baseUrlInput = overlay.querySelector('#set-ai-base-url');
    const providerHelp = overlay.querySelector('#set-ai-provider-help');
    baseUrlInput.dataset.customValue = selectedProvider === 'custom' ? currentBaseUrl : '';

    const syncProviderUi = () => {
        const provider = providerMap[providerSelect.value] || providerOptions[0];
        if (provider.value === 'custom') {
            baseUrlInput.value = baseUrlInput.dataset.customValue || currentBaseUrl || '';
        } else if ((baseUrlInput.value || '').trim() === '' || baseUrlInput.dataset.autoManaged === 'true') {
            baseUrlInput.value = provider.baseUrl || '';
        }
        baseUrlInput.dataset.autoManaged = provider.value === 'custom' ? 'false' : 'true';
        baseUrlInput.readOnly = provider.value !== 'custom';
        providerHelp.textContent = provider.value === 'openrouter'
            ? 'OpenRouter 适合统一接多模型，Base URL 已自动填入。'
            : provider.value === 'siliconflow'
                ? 'SiliconFlow 是兼容 OpenAI 的国内平台，Base URL 已自动填入。'
                : '自定义模式下请填写你的 OpenAI 兼容接口基础地址，例如 https://api.example.com/v1';
    };

    // Back button
    overlay.querySelector('#settings-back').addEventListener('click', () => overlay.remove());

    providerSelect.addEventListener('change', () => {
        syncProviderUi();
    });
    baseUrlInput.addEventListener('input', () => {
        if (providerSelect.value === 'custom') {
            baseUrlInput.dataset.customValue = baseUrlInput.value.trim();
        }
    });
    syncProviderUi();

    const renderAiUsageSection = (stats) => {
        const section = overlay.querySelector('#ai-usage-section');
        if (!section) return;
        section.innerHTML = buildAiUsageStatsMarkup(stats);
        const resetBtn = section.querySelector('#btn-reset-ai-usage');
        if (resetBtn) {
            resetBtn.addEventListener('click', async () => {
                resetBtn.disabled = true;
                resetBtn.textContent = '重置中...';
                await chrome.runtime.sendMessage({ action: 'resetAIUsageStats' });
                renderAiUsageSection(null);
            });
        }
    };
    renderAiUsageSection(usageStats);

    // Remove template
    overlay.querySelectorAll('.template-remove').forEach(btn => {
        btn.addEventListener('click', () => btn.closest('.template-item').remove());
    });

    // Add template
    overlay.querySelector('#btn-add-tpl').addEventListener('click', () => {
        const list = overlay.querySelector('#templates-list');
        const item = document.createElement('div');
        item.className = 'template-item';
        item.innerHTML = `
      <textarea class="tpl-text" placeholder="${i18n.t('settings.templatePlaceholder')}"></textarea>
      <button class="template-remove">×</button>
    `;
        item.querySelector('.template-remove').addEventListener('click', () => item.remove());
        list.appendChild(item);
    });

    // Test AI Connection
    overlay.querySelector('#btn-test-ai').addEventListener('click', async () => {
        const resultEl = overlay.querySelector('#ai-test-result');
        resultEl.textContent = '测试中...';
        resultEl.className = 'test-result';

        // 先临时保存 key 和模型
        await saveCurrentSettings(overlay);

        const result = await chrome.runtime.sendMessage({ action: 'testAiConnection' });
        if (result.success) {
            resultEl.textContent = '✓ 连接成功: ' + result.message;
            resultEl.className = 'test-result success';
        } else {
            resultEl.textContent = '✗ 连接失败: ' + result.message;
            resultEl.className = 'test-result error';
        }
    });

    // Sync to Sheets
    overlay.querySelector('#btn-sync-sheets').addEventListener('click', async () => {
        const resultEl = overlay.querySelector('#sheets-result');
        resultEl.textContent = '同步中...';
        resultEl.className = 'test-result';

        await saveCurrentSettings(overlay);

        const result = await chrome.runtime.sendMessage({ action: 'syncToSheets' });
        if (result.success) {
            resultEl.textContent = '✓ ' + result.message;
            resultEl.className = 'test-result success';
        } else {
            resultEl.textContent = '✗ ' + result.message;
            resultEl.className = 'test-result error';
        }
    });

    // Save
    overlay.querySelector('#btn-save-settings').addEventListener('click', async () => {
        await saveCurrentSettings(overlay);

        const toast = overlay.querySelector('#save-toast');
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2000);
    });
}

async function saveCurrentSettings(overlay) {
    const templates = Array.from(overlay.querySelectorAll('.tpl-text'))
        .map(el => el.value.trim())
        .filter(Boolean);

    const newSettings = {
        // AI 配置
        aiProvider: overlay.querySelector('#set-ai-provider').value,
        aiBaseUrl: overlay.querySelector('#set-ai-base-url').value.trim(),
        aiApiKey: overlay.querySelector('#set-api-key').value.trim(),
        openrouterApiKey: overlay.querySelector('#set-api-key').value.trim(),
        modelClassify: overlay.querySelector('#set-model-classify').value.trim(),
        modelFormExtract: overlay.querySelector('#set-model-form').value.trim(),
        modelCommentGen: overlay.querySelector('#set-model-comment').value.trim(),
        modelLinkDiscover: overlay.querySelector('#set-model-link').value.trim(),
        // Google Sheets
        googleSheetId: overlay.querySelector('#set-sheet-id').value.trim(),
        // 用户信息
        name: overlay.querySelector('#set-name').value.trim(),
        email: overlay.querySelector('#set-email').value.trim(),
        website: overlay.querySelector('#set-website').value.trim(),
        anchorKeyword: overlay.querySelector('#set-anchor-kw').value.trim(),
        anchorUrl: overlay.querySelector('#set-anchor-url').value.trim(),
        publishDebugMode: overlay.querySelector('#set-publish-debug').checked,
        commentTemplates: templates,
        language: i18n.currentLang
    };

    await StorageHelper.saveSettings(newSettings);
}

// === 语言更新 ===

function updateUILanguage() {
    // Tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        if (btn.dataset.tab === 'publish' && btn.dataset.mode === 'backlink') {
            btn.textContent = i18n.t('tab.publishBacklink');
        } else if (btn.dataset.tab === 'publish' && btn.dataset.mode === 'marketing') {
            btn.textContent = i18n.t('tab.marketing');
        } else {
            btn.textContent = i18n.t('tab.' + btn.dataset.tab);
        }
    });

    // Collect tab
    document.querySelector('#panel-collect .field-label').textContent = i18n.t('collect.targetDomain');
    document.getElementById('domain-input').placeholder = i18n.t('collect.domainPlaceholder');
    document.getElementById('my-domain-input').placeholder = i18n.t('collect.myDomainPlaceholder');
    document.getElementById('btn-collect').textContent = i18n.t('collect.startContinuous');
    document.getElementById('btn-pause-collect').textContent = i18n.t('collect.pauseContinuous');
    document.getElementById('collect-engine-title').textContent = i18n.t('collect.idleStatus');
    document.getElementById('collect-engine-detail').textContent = i18n.t('collect.engineHint');
    document.getElementById('stats-caption').textContent = i18n.t('collect.waveCaption');
    document.getElementById('stat-backlinks-label').textContent = i18n.t('collect.backlinksFound');
    document.getElementById('stat-analyzed-label').textContent = i18n.t('collect.analyzed');
    document.getElementById('stat-blogs-label').textContent = i18n.t('collect.blogResources');
    document.getElementById('stat-queue-label').textContent = i18n.t('collect.inQueue');
    document.querySelector('.domain-frontier-card .panel-header h3').innerHTML =
        i18n.t('collect.domainFrontier') + ` <span class="badge" id="domain-frontier-count">${document.getElementById('domain-frontier-count')?.textContent || 0}</span>`;
    document.getElementById('domain-profiled-count').previousElementSibling.textContent = i18n.t('collect.domainProfiled');
    document.getElementById('domain-expanded-count').previousElementSibling.textContent = i18n.t('collect.domainExpanded');
    document.getElementById('domain-comment-count').previousElementSibling.textContent = i18n.t('collect.domainCommentFound');
    document.querySelector('#domain-frontier-empty p').textContent = i18n.t('collect.domainFrontierEmpty');

    updatePublishWorkspaceView();
    const marketingTitle = document.getElementById('marketing-panel-title');
    if (marketingTitle) {
        marketingTitle.textContent = i18n.t('tab.marketing');
    }

    // Resources tab
    resourcePanel?.updateHeaderCount(document.getElementById('res-count')?.textContent || 0);

    // Footer
    document.getElementById('btn-settings').textContent = i18n.t('footer.settings');
    document.getElementById('btn-clear').textContent = i18n.t('footer.clear');

    if (typeof window.__updateContinuousUI === 'function') {
        window.__updateContinuousUI();
    }
    if (currentTab === 'resources') {
        resourcePanel?.refresh();
    }
}
