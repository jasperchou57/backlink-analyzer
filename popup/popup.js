/**
 * Popup.js V5 - 主弹窗逻辑（精简版）
 * 设置面板 → settings-panel.js | 资源库 → resource-library.js
 */

document.addEventListener('DOMContentLoaded', async () => {
    // === 关闭按钮 ===
    const btnClose = document.getElementById('btn-close');
    if (btnClose) {
        btnClose.addEventListener('click', () => window.close());
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
            if (btn.dataset.tab === 'publish') refreshTasks();
            if (btn.dataset.tab === 'logs') refreshLogs();
        });
    });

    // === 资源库筛选按钮 ===
    document.querySelectorAll('.res-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.res-filter').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            resCurrentPage = 1;
            refreshResources();
        });
    });

    // === 资源库搜索 ===
    const searchInput = document.getElementById('res-search');
    let searchTimer;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            resSearchQuery = searchInput.value.trim().toLowerCase();
            resCurrentPage = 1;
            refreshResources();
        }, 300);
    });

    // === 资源库每页数 ===
    document.getElementById('res-page-size').addEventListener('change', (e) => {
        resPageSize = parseInt(e.target.value);
        resCurrentPage = 1;
        refreshResources();
    });

    // === 收藏按钮 ===
    document.getElementById('btn-favorites-view').addEventListener('click', () => {
        const btn = document.getElementById('btn-favorites-view');
        const isActive = btn.classList.toggle('active');
        if (isActive) {
            document.querySelectorAll('.res-filter').forEach(b => b.classList.remove('active'));
        } else {
            document.querySelector('.res-filter[data-filter="all"]').classList.add('active');
        }
        resCurrentPage = 1;
        refreshResources(isActive ? 'favorites' : undefined);
    });

    // === 收集按钮 ===
    const btnCollect = document.getElementById('btn-collect');
    let isCollecting = false;

    btnCollect.addEventListener('click', async () => {
        if (isCollecting) {
            chrome.runtime.sendMessage({ action: 'stopCollect' });
            setCollectingUI(false);
            return;
        }

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

        setCollectingUI(true);

        chrome.runtime.sendMessage({
            action: 'startCollect',
            domain,
            myDomain,
            sources
        });
    });

    function setCollectingUI(collecting) {
        isCollecting = collecting;
        btnCollect.textContent = collecting ? i18n.t('collect.stop') : i18n.t('collect.start');
        btnCollect.classList.toggle('collecting', collecting);

        const dot = document.getElementById('status-dot');
        const text = document.getElementById('status-text');
        if (collecting) {
            dot.className = 'status-dot active';
            text.textContent = i18n.t('collect.analyzing');
        } else {
            dot.className = 'status-dot done';
            text.textContent = i18n.t('collect.done');
        }
    }

    // === 新建任务 ===
    document.getElementById('btn-add-task').addEventListener('click', () => {
        openTaskEditor();
    });

    // === 停止发布 ===
    document.getElementById('btn-stop-publish').addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'stopPublish' });
        document.getElementById('publish-current').style.display = 'none';
    });

    // === 导入数据库 ===
    document.getElementById('btn-import-db').addEventListener('click', importBacklinkDatabase);

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
            await StorageHelper.clearAll();
            updateStats({ backlinksFound: 0, analyzed: 0, blogResources: 0, inQueue: 0 });
            refreshResources();
            refreshTasks();
        }
    });

    // === 监听 background 消息 ===
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'statsUpdate') {
            updateStats(msg.stats);
        }
        if (msg.action === 'collectDone') {
            setCollectingUI(false);
        }
        if (msg.action === 'publishProgress') {
            updatePublishProgress(msg);
        }
        if (msg.action === 'publishDone') {
            document.getElementById('publish-current').style.display = 'none';
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
            if (resp.isCollecting) setCollectingUI(true);
        }
    } catch { }

    const collectState = await StorageHelper.getCollectState();
    if (collectState.isCollecting) {
        document.getElementById('domain-input').value = collectState.domain || '';
        document.getElementById('my-domain-input').value = collectState.myDomain || '';
        setCollectingUI(true);
    }

    refreshTasks();
    checkImportStatus();

    // === 定时轮询最新状态（每 2 秒） ===
    setInterval(async () => {
        try {
            const resp = await chrome.runtime.sendMessage({ action: 'getStats' });
            if (resp && resp.stats) {
                updateStats(resp.stats);
            }
        } catch { }
    }, 2000);
});

// === UI 更新函数 ===

function updateStats(stats) {
    document.getElementById('stat-backlinks').textContent = stats.backlinksFound || 0;
    document.getElementById('stat-analyzed').textContent = stats.analyzed || 0;
    document.getElementById('stat-blogs').textContent = stats.blogResources || 0;
    document.getElementById('stat-queue').textContent = stats.inQueue || 0;
}

async function checkImportStatus() {
    const dbImported = await StorageHelper.get('dbImported');
    if (dbImported) {
        document.getElementById('import-bar').style.display = 'none';
    }
}

// ============================================================
// 发布 Tab - 项目进度仪表盘
// ============================================================

function getResourceCategory(r) {
    const opps = r.opportunities || [r.type] || [];
    if (opps.includes('comment')) return 'comment';
    if (opps.includes('submit-site')) return 'submit-site';
    if (opps.includes('forum')) return 'forum';
    return 'listing';
}

async function refreshTasks() {
    const resp = await chrome.runtime.sendMessage({ action: 'getTasks' });
    const tasks = resp?.tasks || [];
    const list = document.getElementById('task-list');
    const emptyHint = document.getElementById('task-empty');
    list.innerHTML = '';

    if (tasks.length === 0) {
        emptyHint.style.display = 'block';
        return;
    }

    emptyHint.style.display = 'none';

    // 获取所有资源用于统计
    const resources = await StorageHelper.getResources();

    tasks.forEach(task => {
        const card = document.createElement('div');
        card.className = 'task-project-card';

        // 按分类统计资源
        const catStats = {
            comment:      { total: 0, success: 0, failed: 0 },
            'submit-site':{ total: 0, success: 0, failed: 0 },
            forum:        { total: 0, success: 0, failed: 0 },
            listing:      { total: 0, success: 0, failed: 0 }
        };
        let totalAll = 0, successAll = 0, failedAll = 0;

        resources.forEach(r => {
            const cat = getResourceCategory(r);
            catStats[cat].total++;
            totalAll++;
            if (r.status === 'published') { catStats[cat].success++; successAll++; }
            if (r.status === 'failed') { catStats[cat].failed++; failedAll++; }
        });

        const initial = (task.name || task.website || '?')[0].toUpperCase();

        card.innerHTML = `
            <div class="task-project-header">
                <div class="task-project-avatar">${escapeHtml(initial)}</div>
                <div class="task-project-info">
                    <div class="task-project-name">${escapeHtml(task.name || task.website)}</div>
                    <div class="task-project-url">${escapeHtml(task.website)}</div>
                </div>
                <div class="task-project-actions">
                    <button class="task-btn task-edit" title="编辑">✎</button>
                    <button class="task-btn task-del" title="删除">×</button>
                </div>
            </div>
            <div class="task-project-stats">
                <div class="task-stat-box">
                    <span class="task-stat-num">${totalAll}</span>
                    <span class="task-stat-label">外链总数</span>
                </div>
                <div class="task-stat-box stat-green">
                    <span class="task-stat-num">${successAll}</span>
                    <span class="task-stat-label">成功</span>
                </div>
                <div class="task-stat-box stat-red">
                    <span class="task-stat-num">${failedAll}</span>
                    <span class="task-stat-label">失败</span>
                </div>
            </div>
            <div class="task-category-grid">
                <div class="task-cat-row">
                    <span class="task-cat-label">评论</span>
                    <div class="task-cat-bar-wrap">
                        <div class="task-cat-bar" style="width:${catStats.comment.total ? (catStats.comment.success / catStats.comment.total * 100) : 0}%"></div>
                    </div>
                    <span class="task-cat-count">${catStats.comment.success}/${catStats.comment.total}</span>
                    <button class="task-cat-run" data-category="comment" title="发布评论">▶</button>
                </div>
                <div class="task-cat-row">
                    <span class="task-cat-label">目录提交</span>
                    <div class="task-cat-bar-wrap">
                        <div class="task-cat-bar" style="width:${catStats['submit-site'].total ? (catStats['submit-site'].success / catStats['submit-site'].total * 100) : 0}%"></div>
                    </div>
                    <span class="task-cat-count">${catStats['submit-site'].success}/${catStats['submit-site'].total}</span>
                    <button class="task-cat-run" data-category="submit-site" title="发布目录提交">▶</button>
                </div>
                <div class="task-cat-row">
                    <span class="task-cat-label">论坛</span>
                    <div class="task-cat-bar-wrap">
                        <div class="task-cat-bar" style="width:${catStats.forum.total ? (catStats.forum.success / catStats.forum.total * 100) : 0}%"></div>
                    </div>
                    <span class="task-cat-count">${catStats.forum.success}/${catStats.forum.total}</span>
                    <button class="task-cat-run" data-category="forum" title="发布论坛">▶</button>
                </div>
                <div class="task-cat-row">
                    <span class="task-cat-label">综合</span>
                    <div class="task-cat-bar-wrap">
                        <div class="task-cat-bar" style="width:${catStats.listing.total ? (catStats.listing.success / catStats.listing.total * 100) : 0}%"></div>
                    </div>
                    <span class="task-cat-count">${catStats.listing.success}/${catStats.listing.total}</span>
                    <button class="task-cat-run" data-category="listing" title="发布综合">▶</button>
                </div>
            </div>
        `;

        // 事件绑定
        card.querySelector('.task-edit').addEventListener('click', () => openTaskEditor(task));
        card.querySelector('.task-del').addEventListener('click', async () => {
            if (confirm(`确定删除任务 "${task.name || task.website}"？`)) {
                await chrome.runtime.sendMessage({ action: 'deleteTask', taskId: task.id });
                refreshTasks();
            }
        });

        card.querySelectorAll('.task-cat-run').forEach(btn => {
            btn.addEventListener('click', () => {
                const category = btn.dataset.category;
                const t = { ...task, categoryFilter: category };
                chrome.runtime.sendMessage({ action: 'startPublish', task: t });
                document.getElementById('publish-current').style.display = 'block';
            });
        });

        list.appendChild(card);
    });
}

async function importBacklinkDatabase() {
    const btn = document.getElementById('btn-import-db');
    btn.disabled = true;
    btn.textContent = '导入中...';

    try {
        const url = chrome.runtime.getURL('data/backlink-database.json');
        const resp = await fetch(url);
        const data = await resp.json();

        let added = 0;
        for (const item of data) {
            const resource = {
                url: item.u,
                pageTitle: item.n,
                sources: ['DB'],
                opportunities: [item.o],
                category: item.c,
                dr: item.d,
                language: item.l,
                isPaid: item.p === 1
            };
            const isNew = await StorageHelper.addResource(resource);
            if (isNew) added++;
        }

        await StorageHelper.set('dbImported', true);
        btn.textContent = `已导入 ${added} 条`;
        setTimeout(() => {
            document.getElementById('import-bar').style.display = 'none';
        }, 2000);

        refreshTasks();
        refreshResources();
    } catch (e) {
        btn.textContent = '导入失败: ' + e.message;
        btn.disabled = false;
    }
}

function updatePublishProgress(msg) {
    const container = document.getElementById('publish-current');
    container.style.display = 'block';

    document.getElementById('current-url').textContent = msg.currentUrl || '-';
    document.getElementById('progress-fill').style.width =
        msg.total > 0 ? ((msg.current / msg.total) * 100) + '%' : '0%';
    document.getElementById('progress-text').textContent = `${msg.current} / ${msg.total}`;
}

// ============================================================
// 任务编辑器（含锚文本）
// ============================================================

function openTaskEditor(existingTask) {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';

    const task = existingTask || {};

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
        </div>

        <div class="settings-section">
            <h4>锚文本设置</h4>
            <div class="settings-field">
                <label>锚文本关键词</label>
                <input class="input" id="task-anchor-kw" value="${escapeHtml(task.anchorKeyword || '')}" placeholder="例如：SEO工具">
            </div>
            <div class="settings-field">
                <label>锚文本链接 URL</label>
                <input class="input" id="task-anchor-url" value="${escapeHtml(task.anchorUrl || '')}" placeholder="https://mysite.com/page">
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-field">
                <label>发布模式</label>
                <select class="input" id="task-mode">
                    <option value="semi-auto" ${task.mode !== 'full-auto' ? 'selected' : ''}>半自动（逐个确认）</option>
                    <option value="full-auto" ${task.mode === 'full-auto' ? 'selected' : ''}>全自动（自动提交）</option>
                </select>
            </div>
        </div>

        <button class="btn-save" id="btn-save-task">保存任务</button>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#task-back').addEventListener('click', () => overlay.remove());
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
            anchorKeyword: overlay.querySelector('#task-anchor-kw').value.trim(),
            anchorUrl: overlay.querySelector('#task-anchor-url').value.trim(),
            mode: overlay.querySelector('#task-mode').value
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

// === 通用工具 ===

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// === 语言更新 ===

function updateUILanguage() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.textContent = i18n.t('tab.' + btn.dataset.tab);
    });

    document.querySelector('#panel-collect .field-label').textContent = i18n.t('collect.targetDomain');
    document.getElementById('domain-input').placeholder = i18n.t('collect.domainPlaceholder');
    document.getElementById('my-domain-input').placeholder = i18n.t('collect.myDomainPlaceholder');
    document.getElementById('btn-collect').textContent = i18n.t('collect.start');

    document.getElementById('btn-settings').textContent = i18n.t('footer.settings');
    document.getElementById('btn-clear').textContent = i18n.t('footer.clear');
}
