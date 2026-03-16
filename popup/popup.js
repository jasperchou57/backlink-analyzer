/**
 * Popup.js V3 - 主弹窗逻辑
 * 模块化后的精简版本：任务管理委托 TaskPanel，营销面板委托 MarketingPanel，设置委托 SettingsPanel
 */

let currentWorkspace = 'home';
let currentTab = '';
let resourcePanel = null;

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

    // === 网站管理 ===
    const siteSelect = document.getElementById('site-select');
    let sites = [];
    let activeSiteId = '';

    async function loadSites() {
        const data = await chrome.storage.local.get(['sites', 'activeSiteId']);
        sites = data.sites || [];
        activeSiteId = data.activeSiteId || '';

        // If no sites, create default from settings
        if (sites.length === 0) {
            const settingsData = await chrome.storage.local.get('settings');
            const settings = settingsData.settings || {};
            if (settings.website) {
                const defaultSite = {
                    id: crypto.randomUUID(),
                    name: settings.name || getHostLabel(settings.website),
                    url: normalizeHttpUrl(settings.website),
                    createdAt: new Date().toISOString()
                };
                sites = [defaultSite];
                activeSiteId = defaultSite.id;
                await chrome.storage.local.set({ sites, activeSiteId });
            }
        }

        renderSiteSelect();
    }

    function renderSiteSelect() {
        siteSelect.innerHTML = '';
        if (sites.length === 0) {
            // Disabled placeholder so selecting "添加网站" triggers change event
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = '选择网站...';
            placeholder.disabled = true;
            placeholder.selected = true;
            siteSelect.appendChild(placeholder);
            const addOpt = document.createElement('option');
            addOpt.value = '__add__';
            addOpt.textContent = '+ 添加网站';
            siteSelect.appendChild(addOpt);
            return;
        }
        sites.forEach(site => {
            const opt = document.createElement('option');
            opt.value = site.id;
            opt.textContent = site.name || getHostLabel(site.url);
            siteSelect.appendChild(opt);
        });
        const addOpt = document.createElement('option');
        addOpt.value = '__add__';
        addOpt.textContent = '+ 添加网站...';
        siteSelect.appendChild(addOpt);
        siteSelect.value = activeSiteId;
    }

    async function triggerAddSite() {
        const name = prompt('网站名称（如 My Blog）');
        if (!name) { siteSelect.value = activeSiteId; return; }
        const url = prompt('网站地址（如 https://myblog.com）');
        if (!url) { siteSelect.value = activeSiteId; return; }
        const newSite = {
            id: crypto.randomUUID(),
            name: name.trim(),
            url: normalizeHttpUrl(url.trim()),
            createdAt: new Date().toISOString()
        };
        sites.push(newSite);
        activeSiteId = newSite.id;
        await chrome.storage.local.set({ sites, activeSiteId });
        renderSiteSelect();
    }

    siteSelect.addEventListener('change', async () => {
        const val = siteSelect.value;
        if (val === '__add__') {
            await triggerAddSite();
            return;
        }
        activeSiteId = val;
        await chrome.storage.local.set({ activeSiteId });
    });

    await loadSites();

    // === Submify marketing cards click handlers ===
    document.querySelectorAll('.mkt-submit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const card = btn.closest('.mkt-card');
            const workflowId = card?.dataset.workflow;
            if (workflowId) {
                switchWorkspace('marketing', 'marketing');
            }
        });
    });

    // === 持久化展开状态（不会在 refreshTasks 时丢失） ===
    const expandedPublishTaskIds = new Set();
    const expandedMarketingTaskIds = new Set();

    // === 初始化模块 ===
    const taskPanel = TaskPanel.create({
        escapeHtml,
        normalizeUrl: normalizeHttpUrl,
        formatTime,
        getHostLabel,
        formatFrequencyLabel,
        StorageHelper,
        getCurrentWorkspace: () => currentWorkspace,
        getCurrentTab: () => currentTab,
        getExpandedPublishTaskIds: () => expandedPublishTaskIds,
        getExpandedMarketingTaskIds: () => expandedMarketingTaskIds,
        refreshPublishStats,
        refreshMarketingWorkspace: () => marketingPanel.refreshMarketingWorkspace(),
        compactText
    });

    const marketingPanel = MarketingPanel.create({
        getWorkflowMeta: (id) => taskPanel.getWorkflowMeta(id),
        getDefaultWorkflowId: () => taskPanel.getDefaultWorkflowId(),
        isVisibleMarketingTask: (t) => taskPanel.isVisibleMarketingTask(t),
        formatLastRunLabel: (v) => taskPanel.formatLastRunLabel(v),
        getCurrentWorkspace: () => currentWorkspace,
        getCurrentTab: () => currentTab,
        refreshTasks: () => taskPanel.refreshTasks()
    });

    resourcePanel = ResourcePanel.create({
        storageHelper: StorageHelper,
        workflowRegistry: window.WorkflowRegistry,
        getWorkflowMeta: (id) => taskPanel.getWorkflowMeta(id),
        isPublishCandidateForTask: (resource, task) => taskPanel.isPublishCandidateForTaskUi(resource, task),
        escapeHtml,
        i18n,
        getCurrentTab: () => currentTab,
        refreshPublishStats,
        refreshTasks: () => taskPanel.refreshTasks()
    });

    // Wire global delegates so modules that still reference globals keep working
    window.__taskPanel = taskPanel;
    window.__marketingPanel = marketingPanel;

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
            taskPanel.updatePublishWorkspaceView();
            taskPanel.refreshTasks();
            taskPanel.refreshWorkflowLibrary();
            return;
        }

        const visibleButtons = Array.from(document.querySelectorAll('.tab-btn')).filter((btn) => btn.style.display !== 'none');
        const fallbackTab = workspace === 'marketing' ? 'marketing-home' : 'collect';
        const nextTab = targetTab || fallbackTab;
        const activeButton = visibleButtons.find((btn) => btn.dataset.tab === nextTab) || visibleButtons[0];
        if (!activeButton) return;

        currentTab = activeButton.dataset.tab;
        activeButton.classList.add('active');

        const targetPanel = document.getElementById('panel-' + currentTab);
        if (targetPanel) {
            targetPanel.classList.add('active');
        }

        taskPanel.updatePublishWorkspaceView();
        taskPanel.refreshWorkflowLibrary();
        taskPanel.refreshTasks();

        if (currentTab === 'resources') {
            resourcePanel?.refresh();
            resourcePanel?.scheduleHeaderSync();
        }
        if (currentTab === 'collect') await refreshDomainIntel();
        if (currentTab === 'publish') {
            refreshPublishStats();
            await taskPanel.refreshPublishState();
        }
        if (currentTab === 'marketing') {
            await marketingPanel.refreshMarketingAutomationState();
            await marketingPanel.refreshMarketingWorkspace();
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
        await switchWorkspace('marketing', 'marketing-home');
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
    document.getElementById('btn-add-task').addEventListener('click', () => taskPanel.openTaskEditor());
    document.getElementById('btn-add-marketing-task').addEventListener('click', () => taskPanel.openTaskEditor());
    document.getElementById('btn-start-marketing-automation').addEventListener('click', async () => {
        const result = await chrome.runtime.sendMessage({ action: 'startMarketingAutomation' });
        if (!result?.success) {
            alert(result?.message || '启动持续宣传失败');
            await marketingPanel.refreshMarketingAutomationState();
            return;
        }
        await marketingPanel.refreshMarketingAutomationState();
        await marketingPanel.refreshMarketingWorkspace();
    });
    document.getElementById('btn-pause-marketing-automation').addEventListener('click', async () => {
        const result = await chrome.runtime.sendMessage({ action: 'pauseMarketingAutomation' });
        if (!result?.success) {
            alert(result?.message || '暂停持续宣传失败');
            return;
        }
        await marketingPanel.refreshMarketingAutomationState();
    });
    document.getElementById('btn-reset-publish-statuses').addEventListener('click', async () => {
        const confirmed = confirm('"重置资源状态"会把当前所有发布尝试恢复成初始待发状态。\n\n已发布 / 已跳过 / 失败：统一回到待发布\n历史记录：清空\n任务累计统计：清零\n\n确定继续？');
        if (!confirmed) return;

        const result = await chrome.runtime.sendMessage({ action: 'resetAllStatuses' });
        if (!result?.success) {
            alert(result?.error || '重置失败');
            return;
        }

        await taskPanel.refreshPublishState();
        await refreshPublishStats();
        await taskPanel.refreshTasks();
        await resourcePanel?.refresh();
        alert(`已重置 ${result.count || 0} 个资源状态，并清空 ${result.clearedHistoryCount || 0} 条发布历史。\n当前任务统计已归零。`);
    });
    document.getElementById('btn-stop-publish').addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ action: 'stopPublish' });
        await taskPanel.refreshPublishState();
        taskPanel.refreshTasks();
    });
    document.getElementById('btn-continue-publish').addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ action: 'continuePublish' });
        await taskPanel.refreshPublishState();
        taskPanel.refreshTasks();
    });

    // === 资源导出 CSV ===
    document.getElementById('btn-export').addEventListener('click', async () => {
        const resources = await StorageHelper.getResources();
        if (resources.length === 0) return;
        exportToCSV(resources);
    });

    // === 资源导出 JSON（完整备份） ===
    document.getElementById('btn-export-json').addEventListener('click', async () => {
        const resources = await StorageHelper.getResources();
        if (resources.length === 0) { alert('没有资源可导出'); return; }
        const blob = new Blob([JSON.stringify(resources, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `backlink-resources-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    // === 资源导入 JSON ===
    document.getElementById('btn-import-json').addEventListener('click', () => {
        document.getElementById('file-import-json').click();
    });
    document.getElementById('file-import-json').addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const text = await file.text();
            const imported = JSON.parse(text);
            if (!Array.isArray(imported)) { alert('JSON 格式错误：应为数组'); return; }
            const existing = await StorageHelper.getResources();
            const existingUrls = new Set(existing.map(r => (r.url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase()));
            let added = 0;
            for (const r of imported) {
                if (!r.url) continue;
                const normUrl = r.url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();
                if (!existingUrls.has(normUrl)) {
                    existing.push(r);
                    existingUrls.add(normUrl);
                    added++;
                }
            }
            // 逐个添加新资源，利用 StorageHelper.addResource 的去重逻辑
            // 但为了效率，直接写入整个数组
            const localStore = typeof LocalDB !== 'undefined' ? LocalDB : null;
            if (localStore?.setResources) {
                await localStore.setResources(existing);
            } else {
                await StorageHelper.set('resources', existing);
            }
            alert(`导入完成：新增 ${added} 个资源，跳过 ${imported.length - added} 个重复资源，当前总计 ${existing.length} 个`);
            e.target.value = '';
            resourcePanel?.refresh?.();
        } catch (err) {
            alert('导入失败：' + err.message);
            e.target.value = '';
        }
    });

    // === 日志 ===
    document.getElementById('btn-clear-logs').addEventListener('click', async () => {
        await chrome.runtime.sendMessage({ action: 'clearLogs' });
        refreshLogs();
    });
    document.getElementById('log-filter').addEventListener('change', () => refreshLogs());

    // === 设置 ===
    document.getElementById('btn-settings').addEventListener('click', () => SettingsPanel.open());

    // === 清空数据 ===
    document.getElementById('btn-clear').addEventListener('click', async () => {
        if (confirm(i18n.t('footer.clearConfirm'))) {
            const result = await chrome.runtime.sendMessage({ action: 'clearAllData' });
            if (!result?.success) {
                alert(result?.error || result?.message || '清空资源池失败');
                return;
            }
            updateStats({ backlinksFound: 0, targetsFound: 0, analyzed: 0, blogResources: 0, inQueue: 0 });
            await refreshDomainIntel();
            await taskPanel.refreshPublishState();
            await resourcePanel?.refresh();
            await refreshPublishStats();
            await taskPanel.refreshTasks();
            alert(`已清空 ${result.clearedResources || 0} 条资源。\n保留：模板记忆 ${result.preservedTemplates || 0} 条、发布经验 ${result.preservedAttempts || 0} 条、任务配置与设置。`);
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
                taskPanel.refreshTasks();
            }
        }
        if (msg.action === 'continuousStateUpdate') {
            updateContinuousUI(msg.state || {});
        }
        if (msg.action === 'marketingStateUpdate') {
            marketingPanel.updateMarketingAutomationUI(msg.state || {});
        }
        if (msg.action === 'collectDone') {
            refreshContinuousDiscoveryState();
            refreshDomainIntel();
            const publishPanel = document.getElementById('panel-publish');
            if (publishPanel.classList.contains('active')) {
                taskPanel.refreshTasks();
            }
        }
        if (msg.action === 'publishProgress') {
            taskPanel.updatePublishProgress(msg);
            // Also refresh global stats so per-task overview picks up latest resource statuses
            refreshPublishStats();
        }
        if (msg.action === 'publishDone') {
            taskPanel.refreshPublishState().then(() => {
                taskPanel.refreshTasks();
                refreshPublishStats();
            });
        }
        if (msg.action === 'publishBatchUpdate') {
            taskPanel.refreshPublishState().then(() => {
                taskPanel.refreshTasks();
                refreshPublishStats();
            });
        }
        if (msg.action === 'resourceStatsUpdate') {
            // 发布结果返回后实时刷新任务卡片的统计数字
            taskPanel.refreshTasks();
            refreshPublishStats();
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
    taskPanel.refreshWorkflowLibrary();
    refreshPublishStats();
    await refreshDomainIntel();
    await taskPanel.refreshPublishState();
    await marketingPanel.refreshMarketingAutomationState();
    taskPanel.refreshTasks();
    await marketingPanel.refreshMarketingWorkspace();
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
            await taskPanel.refreshPublishState();
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
                await taskPanel.refreshTasks();
            }
        } catch { }

        try {
            const mktPanel = document.getElementById('panel-marketing');
            if (mktPanel.classList.contains('active')) {
                await marketingPanel.refreshMarketingAutomationState();
                await marketingPanel.refreshMarketingWorkspace();
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
        if (empty) empty.style.display = 'block';
        if (list) list.querySelectorAll('.frontier-item').forEach((node) => node.remove());
        return;
    }

    if (empty) empty.style.display = 'none';
    if (!list) return;
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

// ============================================================
// 通用工具函数
// ============================================================

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

// === 语言更新 ===

function updateUILanguage() {
    const taskPanel = window.__taskPanel;

    // Tab buttons
    const tabLabelMap = {
        'collect': i18n.t('tab.collect'),
        'publish': i18n.t('tab.publishBacklink'),
        'resources': i18n.t('tab.resources'),
        'marketing-home': '首页',
        'marketing': i18n.t('tab.marketing'),
        'logs': i18n.t('tab.logs')
    };
    document.querySelectorAll('.tab-btn').forEach(btn => {
        const label = tabLabelMap[btn.dataset.tab];
        if (label) btn.textContent = label;
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

    taskPanel?.updatePublishWorkspaceView();
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
