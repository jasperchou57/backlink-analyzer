/**
 * Popup.js V3 - 主弹窗逻辑
 * 新增：日志 Tab、多任务管理、AI/Sheets 设置
 */

document.addEventListener('DOMContentLoaded', async () => {
    const surface = await detectSurface();
    document.body.dataset.surface = surface;

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
    updateUILanguage();

    langSelect.addEventListener('change', () => {
        i18n.setLanguage(langSelect.value);
        updateUILanguage();
    });

    // === Tab 切换 ===
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('panel-' + btn.dataset.tab).classList.add('active');

            if (btn.dataset.tab === 'resources') refreshResources();
            if (btn.dataset.tab === 'collect') refreshDomainIntel();
            if (btn.dataset.tab === 'publish') { refreshPublishStats(); refreshTasks(); }
            if (btn.dataset.tab === 'logs') refreshLogs();
        });
    });

    // === 资源库筛选按钮 ===
    document.querySelectorAll('.res-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.res-filter').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            refreshResources();
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
        } else {
            dot.className = 'status-dot done';
            text.textContent = i18n.t('collect.done');
            engineTitle.textContent = i18n.t('collect.idleStatus');
        }

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
    document.getElementById('btn-reset-publish-statuses').addEventListener('click', async () => {
        const confirmed = confirm('这会把所有已发布、已跳过的资源重置为待发布，并直接删除失败资源，供新网站任务重新使用。各网站历史记录会保留，用于后续避免重复发布。确定继续？');
        if (!confirmed) return;

        const result = await chrome.runtime.sendMessage({ action: 'resetAllStatuses' });
        if (!result?.success) {
            alert(result?.error || '重置失败');
            return;
        }

        await refreshPublishState();
        await refreshPublishStats();
        await refreshTasks();
        await refreshResources();
        alert(`已重置 ${result.count || 0} 个资源状态，并删除 ${result.deletedFailedCount || 0} 个失败资源。各网站历史记录已保留。`);
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
            refreshResources();
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
        }
        if (msg.action === 'continuousStateUpdate') {
            updateContinuousUI(msg.state || {});
        }
        if (msg.action === 'collectDone') {
            refreshContinuousDiscoveryState();
            refreshDomainIntel();
        }
        if (msg.action === 'publishProgress') {
            updatePublishProgress(msg);
        }
        if (msg.action === 'publishDone') {
            document.getElementById('publish-current').style.display = 'none';
            refreshPublishStats();
            refreshTasks();
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

    refreshPublishStats();
    await refreshDomainIntel();
    await refreshPublishState();
    refreshTasks();

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
    const container = document.getElementById('publish-current');
    container.style.display = 'block';
    document.getElementById('publish-empty').style.display = 'none';

    document.getElementById('current-url').textContent = msg.currentUrl || '-';
    document.getElementById('progress-fill').style.width =
        msg.total > 0 ? ((msg.current / msg.total) * 100) + '%' : '0%';
    document.getElementById('progress-text').textContent = msg.awaitingManualContinue
        ? `已提交，等待继续 · ${msg.current} / ${msg.total}`
        : `${msg.current} / ${msg.total}`;
    document.getElementById('btn-continue-publish').style.display = msg.awaitingManualContinue ? 'inline-flex' : 'none';

    refreshPublishStats();
}

async function refreshPublishState() {
    const state = await chrome.runtime.sendMessage({ action: 'getPublishState' });
    if (state?.isPublishing) {
        updatePublishProgress({
            currentUrl: state.currentUrl,
            current: (state.currentIndex || 0) + 1,
            total: state.total || 0,
            awaitingManualContinue: !!state.awaitingManualContinue
        });
    } else {
        document.getElementById('publish-current').style.display = 'none';
    }
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

function getDefaultWorkflowId() {
    return window.WorkflowRegistry?.DEFAULT_WORKFLOW_ID || 'blog-comment-backlink';
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

function computeTaskStats(task, resources) {
    return resources.reduce((stats, resource) => {
        const historyEntry = getTaskHistoryEntry(resource, task);
        if (!historyEntry) return stats;

        const attempts = getHistoryAttempts(historyEntry);
        stats.success += attempts.published;
        stats.failed += attempts.failed;
        stats.skipped += attempts.skipped;
        stats.total += attempts.published + attempts.failed + attempts.skipped;
        return stats;
    }, { total: 0, success: 0, failed: 0, skipped: 0 });
}

// ============================================================
// 多任务管理
// ============================================================

async function refreshTasks() {
    const resp = await chrome.runtime.sendMessage({ action: 'getTasks' });
    const tasks = resp?.tasks || [];
    const resources = await StorageHelper.getResources();
    const publishState = await chrome.runtime.sendMessage({ action: 'getPublishState' });
    const currentTaskId = publishState?.isPublishing ? publishState.taskId : '';
    const hasRunningTask = !!currentTaskId;
    const list = document.getElementById('task-list');
    list.innerHTML = '';

    if (tasks.length === 0) {
        list.innerHTML = '<div class="empty-hint">暂无发布任务，点击"新建任务"创建</div>';
        return;
    }

    tasks.forEach(task => {
        const card = document.createElement('div');
        card.className = 'task-card';
        const historyStats = computeTaskStats(task, resources);
        const hasHistoryStats = historyStats.total > 0;
        const stats = hasHistoryStats
            ? historyStats
            : (task.stats || { total: 0, success: 0, pending: 0, failed: 0 });
        const isRunning = currentTaskId && currentTaskId === task.id;
        const canStartTask = !hasRunningTask || isRunning;
        const commentStyleLabel = task.commentStyle === 'anchor-html' ? '锚文本模式' : '普通评论';
        const limitLabel = Number(task.maxPublishes) > 0 ? `上限 ${task.maxPublishes}` : '不限量';
        card.innerHTML = `
            <div class="task-info">
                <div class="task-name">${escapeHtml(task.name || task.website)}</div>
                <div class="task-meta">
                    ${escapeHtml(task.website)} · ${task.mode === 'full-auto' ? '全自动' : '半自动'}
                </div>
                <div class="task-workflow">
                    ${escapeHtml(getWorkflowLabel(task.workflowId || getDefaultWorkflowId()))}
                </div>
                <div class="task-stats-mini">
                    ${commentStyleLabel} · ${limitLabel}
                </div>
                <div class="task-stats-mini">
                    ✓${stats.success} · ✗${stats.failed} · Σ${stats.total}
                </div>
            </div>
            <div class="task-actions">
                <button class="task-btn task-run ${isRunning ? 'running' : ''}" ${canStartTask ? '' : 'disabled'} title="${isRunning ? '停止发布' : (canStartTask ? '开始发布' : '请先停止当前任务')}">${isRunning ? '■' : '▶'}</button>
                <button class="task-btn task-edit" title="编辑">✎</button>
                <button class="task-btn task-del" title="删除">×</button>
            </div>
        `;

        card.querySelector('.task-run').addEventListener('click', () => {
            if (isRunning) {
                chrome.runtime.sendMessage({ action: 'stopPublish' }).then(() => refreshTasks());
            } else if (!canStartTask) {
                return;
            } else {
                chrome.runtime.sendMessage({ action: 'startPublish', task }).then(async (result) => {
                    if (!result?.success) {
                        alert(result?.message || '开始发布失败');
                        await refreshPublishState();
                        await refreshTasks();
                        await refreshPublishStats();
                        return;
                    }

                    await refreshPublishState();
                    await refreshTasks();
                });
            }
        });
        card.querySelector('.task-edit').addEventListener('click', () => {
            openTaskEditor(task);
        });
        card.querySelector('.task-del').addEventListener('click', async () => {
            if (confirm(`确定删除任务 "${task.name || task.website}"？`)) {
                await chrome.runtime.sendMessage({ action: 'deleteTask', taskId: task.id });
                refreshTasks();
            }
        });

        list.appendChild(card);
    });
}

async function openTaskEditor(existingTask) {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';

    const task = existingTask || {};
    const settings = await StorageHelper.getSettings();
    const workflows = getAvailableWorkflows().length > 0 ? getAvailableWorkflows() : [{
        id: getDefaultWorkflowId(),
        name: getWorkflowLabel(getDefaultWorkflowId())
    }];
    const selectedWorkflowId = task.workflowId || getDefaultWorkflowId();
    const workflowOptions = workflows.map(workflow => `
        <option value="${escapeHtml(workflow.id)}" ${workflow.id === selectedWorkflowId ? 'selected' : ''}>
            ${escapeHtml(workflow.name)}
        </option>
    `).join('');

    overlay.innerHTML = `
        <h2>
            <button class="settings-back" id="task-back">← 返回</button>
            ${task.id ? '编辑任务' : '新建发布任务'}
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
                <label>评论者名称</label>
                <input class="input" id="task-commenter" value="${escapeHtml(task.name_commenter || '')}">
            </div>
            <div class="settings-field">
                <label>评论者邮箱</label>
                <input class="input" id="task-email" value="${escapeHtml(task.email || '')}">
            </div>
            <div class="settings-field">
                <label>本次最多发送</label>
                <input class="input" id="task-max-publishes" type="number" min="1" value="${task.maxPublishes ? escapeHtml(String(task.maxPublishes)) : ''}" placeholder="留空表示发送全部符合条件的资源">
            </div>
            <div class="settings-field">
                <label>发布模式</label>
                <select class="input" id="task-mode">
                    <option value="semi-auto" ${task.mode !== 'full-auto' ? 'selected' : ''}>半自动（逐个确认）</option>
                    <option value="full-auto" ${task.mode === 'full-auto' ? 'selected' : ''}>全自动（自动提交）</option>
                </select>
            </div>
            <div class="settings-field">
                <label>评论模式</label>
                <select class="input" id="task-comment-style">
                    <option value="standard" ${task.commentStyle !== 'anchor-html' ? 'selected' : ''}>普通评论</option>
                    <option value="anchor-html" ${task.commentStyle === 'anchor-html' ? 'selected' : ''}>锚文本模式（仅允许 HTML 链接时尝试）</option>
                </select>
            </div>
            <div class="settings-field">
                <label>锚文本关键词</label>
                <input class="input" id="task-anchor-keyword" value="${escapeHtml(task.anchorKeyword || '')}" placeholder="${escapeHtml(settings.anchorKeyword || '留空则回退到设置页关键词')}">
            </div>
            <div class="settings-field">
                <label>锚文本目标 URL</label>
                <input class="input" id="task-anchor-url" value="${escapeHtml(task.anchorUrl || '')}" placeholder="${escapeHtml(settings.anchorUrl || task.website || '留空则回退到任务网站 URL')}">
                <div class="settings-help">只有检测到当前平台支持 HTML 链接时，才会尝试在评论正文里插入锚文本链接。</div>
            </div>
            <div class="settings-field">
                <label>Workflow</label>
                <select class="input" id="task-workflow">
                    ${workflowOptions}
                </select>
                <div class="settings-help" id="task-workflow-desc">${escapeHtml(getWorkflowDescription(selectedWorkflowId))}</div>
            </div>
        </div>

        <button class="btn-save" id="btn-save-task">保存任务</button>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#task-back').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#task-workflow').addEventListener('change', (event) => {
        overlay.querySelector('#task-workflow-desc').textContent = getWorkflowDescription(event.target.value);
    });
    overlay.querySelector('#btn-save-task').addEventListener('click', async () => {
        const website = overlay.querySelector('#task-website').value.trim();
        if (!website) {
            overlay.querySelector('#task-website').focus();
            return;
        }

        const taskData = {
            id: task.id || undefined,
            name: overlay.querySelector('#task-name').value.trim() || website,
            website,
            name_commenter: overlay.querySelector('#task-commenter').value.trim(),
            email: overlay.querySelector('#task-email').value.trim(),
            maxPublishes: Number(overlay.querySelector('#task-max-publishes').value) > 0
                ? Number(overlay.querySelector('#task-max-publishes').value)
                : 0,
            mode: overlay.querySelector('#task-mode').value,
            commentStyle: overlay.querySelector('#task-comment-style').value,
            anchorKeyword: overlay.querySelector('#task-anchor-keyword').value.trim(),
            anchorUrl: overlay.querySelector('#task-anchor-url').value.trim(),
            workflowId: overlay.querySelector('#task-workflow').value || getDefaultWorkflowId()
        };

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

// ============================================================
// 资源库
// ============================================================

const TYPE_LABELS = {
    comment: '评论', forum: '论坛', register: '注册',
    'submit-site': '提交网站', 'guest-post': '投稿',
    listing: '展示平台', wiki: 'Wiki', 'rich-editor': '编辑器',
    disqus: 'Disqus', form: '表单'
};

async function refreshResources() {
    const allResources = await StorageHelper.getResources();
    const list = document.getElementById('resources-list');
    const empty = document.getElementById('resources-empty');
    const count = document.getElementById('res-count');

    const activeFilter = document.querySelector('.res-filter.active');
    const filter = activeFilter ? activeFilter.dataset.filter : 'all';

    let resources;
    if (filter === 'comment') {
        resources = allResources.filter(r =>
            (r.opportunities && r.opportunities.includes('comment')) || r.type === 'comment'
        );
    } else if (filter === 'other') {
        resources = allResources.filter(r =>
            !(r.opportunities && r.opportunities.includes('comment')) && r.type !== 'comment'
        );
    } else {
        resources = allResources;
    }

    count.textContent = allResources.length;

    if (resources.length === 0) {
        empty.style.display = 'block';
        list.querySelectorAll('.resource-item').forEach(el => el.remove());
        return;
    }

    empty.style.display = 'none';
    list.innerHTML = '';

    resources.forEach(res => {
        const item = document.createElement('div');
        item.className = 'resource-item';

        const sourceTags = (res.sources || []).map(s => {
            const cls = s === 'A' ? 'source-a' : s === 'S' ? 'source-s' : 'source-w';
            return `<span class="res-tag ${cls}">${s}</span>`;
        }).join('');

        const typeTags = (res.opportunities || [res.type] || []).map(t => {
            const label = TYPE_LABELS[t] || t;
            return `<span class="res-tag type-${t}">${label}</span>`;
        }).join('');
        const candidateTag = res.candidateType === 'backlink-page'
            ? `<span class="res-tag scope-page">页面级</span>`
            : (res.candidateType === 'hybrid'
                ? `<span class="res-tag scope-hybrid">混合级</span>`
                : `<span class="res-tag scope-domain">域名级</span>`);

        const statusCls = 'status-' + (res.status || 'pending');
        const title = res.pageTitle ? `<div class="res-title" title="${escapeHtml(res.pageTitle)}">${escapeHtml(res.pageTitle)}</div>` : '';
        const detail = res.details && res.details.length ? `<div class="res-detail">${res.details.join(' · ')}</div>` : '';
        const publishMeta = res.publishMeta || {};
        const historyCount = Object.keys(res.publishHistory || {}).length;
        const historyTag = historyCount > 0
            ? `<span class="res-tag status-history">历史发布 ${historyCount} 站</span>`
            : '';
        const anchorTag = publishMeta.anchorVisible
            ? `<span class="res-tag status-anchor-ok">锚文本已验证</span>`
            : (res.status === 'published' && publishMeta.anchorInjected
                ? `<span class="res-tag status-anchor-submitted">锚文本已提交</span>`
                : (res.status === 'published' && publishMeta.anchorRequested
                ? `<span class="res-tag status-anchor-miss">未检测到锚文本</span>`
                : ''));

        const showRepublish = res.status === 'published' || res.status === 'failed' || res.status === 'skipped';
        const showHardReset = showRepublish || historyCount > 0;

        item.innerHTML = `
      <div class="res-info">
        ${title}
        <div class="res-url">${escapeHtml(res.url)}</div>
        <div class="res-meta">
          ${sourceTags}
          ${candidateTag}
          ${typeTags}
          <span class="res-tag ${statusCls}">${i18n.t('status.' + (res.status || 'pending'))}</span>
          ${historyTag}
          ${anchorTag}
        </div>
        ${detail}
      </div>
      <div class="res-actions">
        ${showRepublish ? `<button class="res-btn res-republish" data-id="${res.id}" title="重新发布">🔄</button>` : ''}
        ${showHardReset ? `<button class="res-btn res-reset" data-id="${res.id}" title="彻底重置这条资源并清除历史">↩</button>` : ''}
        <button class="res-del" data-id="${res.id}" title="删除">×</button>
      </div>
    `;

        item.querySelector('.res-del').addEventListener('click', async () => {
            await StorageHelper.deleteResource(res.id);
            refreshResources();
        });

        const republishBtn = item.querySelector('.res-republish');
        if (republishBtn) {
            republishBtn.addEventListener('click', () => {
                chrome.runtime.sendMessage({ action: 'republish', resourceId: res.id });
            });
        }

        const resetBtn = item.querySelector('.res-reset');
        if (resetBtn) {
            resetBtn.addEventListener('click', async () => {
                const confirmed = confirm('这会把这条资源彻底重置为全新状态，并清除它对所有网站的历史记录。确定继续？');
                if (!confirmed) return;
                await chrome.runtime.sendMessage({ action: 'resetStatus', resourceId: res.id });
                await refreshPublishStats();
                await refreshTasks();
                await refreshResources();
            });
        }

        item.querySelector('.res-url').style.cursor = 'pointer';
        item.querySelector('.res-url').addEventListener('click', () => {
            chrome.tabs.create({ url: res.url });
        });

        list.appendChild(item);
    });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ============================================================
// 设置面板（含 AI + Google Sheets 配置）
// ============================================================

async function openSettings() {
    const settings = await StorageHelper.getSettings();
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
      <div class="settings-field">
        <label>链接分类模型 (classify)</label>
        <input class="input" id="set-model-classify" value="${escapeHtml(settings.modelClassify || '')}" placeholder="例如 google/gemini-2.0-flash-001">
      </div>
      <div class="settings-field">
        <label>表单识别模型 (formExtract)</label>
        <input class="input" id="set-model-form" value="${escapeHtml(settings.modelFormExtract || '')}" placeholder="例如 google/gemini-2.0-flash-001">
      </div>
      <div class="settings-field">
        <label>评论生成模型 (commentGen)</label>
        <input class="input" id="set-model-comment" value="${escapeHtml(settings.modelCommentGen || '')}" placeholder="例如 google/gemini-2.0-flash-001">
      </div>
      <div class="settings-field">
        <label>链接发现模型 (linkDiscover)</label>
        <input class="input" id="set-model-link" value="${escapeHtml(settings.modelLinkDiscover || '')}" placeholder="例如 google/gemini-2.0-flash-001">
      </div>
      <button class="btn-test" id="btn-test-ai">🔌 测试 AI 连接</button>
      <div class="test-result" id="ai-test-result"></div>
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
        btn.textContent = i18n.t('tab.' + btn.dataset.tab);
    });

    // Collect tab
    document.querySelector('#panel-collect .field-label').textContent = i18n.t('collect.targetDomain');
    document.getElementById('domain-input').placeholder = i18n.t('collect.domainPlaceholder');
    document.getElementById('my-domain-input').placeholder = i18n.t('collect.myDomainPlaceholder');
    document.getElementById('btn-collect').textContent = i18n.t('collect.startContinuous');
    document.getElementById('btn-pause-collect').textContent = i18n.t('collect.pauseContinuous');
    document.getElementById('collect-engine-title').textContent = i18n.t('collect.idleStatus');
    document.getElementById('collect-engine-detail').textContent = i18n.t('collect.engineHint');
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

    // Publish tab
    document.querySelector('#panel-publish .panel-header h3').textContent = i18n.t('publish.tasks');

    // Resources tab
    document.querySelector('#panel-resources .panel-header h3').innerHTML =
        i18n.t('resources.title') + ` <span class="badge" id="res-count">0</span>`;

    // Footer
    document.getElementById('btn-settings').textContent = i18n.t('footer.settings');
    document.getElementById('btn-clear').textContent = i18n.t('footer.clear');

    if (typeof window.__updateContinuousUI === 'function') {
        window.__updateContinuousUI();
    }
}
