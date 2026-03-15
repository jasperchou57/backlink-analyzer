/**
 * Popup.js V4 - 主弹窗逻辑
 * 发布tab: 项目进度仪表盘 | 资源库tab: Submify风格资源浏览
 */

// === 资源库分页状态 ===
let resCurrentPage = 1;
let resPageSize = 20;
let resSearchQuery = '';

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
        // 切换收藏筛选
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

// ============================================================
// 资源库 - Submify风格资源浏览
// ============================================================

const TYPE_LABELS = {
    comment: '评论', forum: '论坛', register: '注册',
    'submit-site': '提交网站', 'guest-post': '投稿',
    listing: '综合', wiki: 'Wiki', 'rich-editor': '编辑器',
    disqus: 'Disqus', form: '表单'
};

async function refreshResources(overrideFilter) {
    const allResources = await StorageHelper.getResources();
    const list = document.getElementById('resources-list');
    const empty = document.getElementById('resources-empty');
    const countEl = document.getElementById('res-count');
    const resultsText = document.getElementById('res-results-text');

    // 判断收藏模式
    const favBtn = document.getElementById('btn-favorites-view');
    const isFavMode = overrideFilter === 'favorites' || favBtn.classList.contains('active');

    const activeFilter = document.querySelector('.res-filter.active');
    const filter = isFavMode ? 'favorites' : (activeFilter ? activeFilter.dataset.filter : 'all');

    // 筛选
    let resources = allResources;
    if (filter === 'favorites') {
        resources = resources.filter(r => r.favorited);
    } else if (filter === 'comment') {
        resources = resources.filter(r =>
            (r.opportunities && r.opportunities.includes('comment')) || r.type === 'comment'
        );
    } else if (filter === 'submit-site') {
        resources = resources.filter(r =>
            (r.opportunities && r.opportunities.includes('submit-site')) || r.type === 'submit-site'
        );
    } else if (filter === 'forum') {
        resources = resources.filter(r =>
            (r.opportunities && r.opportunities.includes('forum')) || r.type === 'forum'
        );
    } else if (filter === 'listing') {
        resources = resources.filter(r => {
            const opps = r.opportunities || [r.type] || [];
            return !opps.includes('comment') && !opps.includes('submit-site') && !opps.includes('forum');
        });
    }

    // 搜索
    if (resSearchQuery) {
        resources = resources.filter(r =>
            (r.url && r.url.toLowerCase().includes(resSearchQuery)) ||
            (r.pageTitle && r.pageTitle.toLowerCase().includes(resSearchQuery))
        );
    }

    countEl.textContent = allResources.length;
    const totalFiltered = resources.length;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / resPageSize));
    if (resCurrentPage > totalPages) resCurrentPage = totalPages;

    resultsText.textContent = `共 ${totalFiltered} 条`;

    // 分页
    const startIdx = (resCurrentPage - 1) * resPageSize;
    const pageResources = resources.slice(startIdx, startIdx + resPageSize);

    if (pageResources.length === 0) {
        empty.style.display = 'block';
        list.querySelectorAll('.resource-card').forEach(el => el.remove());
        renderPager(totalPages);
        return;
    }

    empty.style.display = 'none';
    list.innerHTML = '';

    pageResources.forEach(res => {
        const item = document.createElement('div');
        item.className = 'resource-card';

        const opps = res.opportunities || [res.type] || [];
        const mainType = opps[0] || 'listing';
        const typeLabel = TYPE_LABELS[mainType] || mainType;
        const paidBadge = res.isPaid
            ? '<span class="res-badge res-badge-paid">付费</span>'
            : '<span class="res-badge res-badge-free">免费</span>';

        const drInfo = res.dr ? `DR: ${res.dr}` : '';
        const langInfo = res.language ? `语言: ${res.language}` : '';
        const catInfo = res.category ? `分类: ${res.category}` : '';
        const metaParts = [catInfo, langInfo, drInfo].filter(Boolean).join('  ');

        const favClass = res.favorited ? 'res-fav-btn active' : 'res-fav-btn';

        item.innerHTML = `
            <div class="resource-card-main">
                <div class="resource-card-top">
                    <div class="resource-card-name">${escapeHtml(res.pageTitle || new URL(res.url).hostname)}</div>
                    ${paidBadge}
                </div>
                <a class="resource-card-url" href="${escapeHtml(res.url)}" target="_blank">${escapeHtml(res.url)}</a>
                ${metaParts ? `<div class="resource-card-meta">${escapeHtml(metaParts)}</div>` : ''}
            </div>
            <div class="resource-card-side">
                <button class="${favClass}" data-id="${res.id}" title="收藏">☆</button>
                <button class="res-start-btn" data-id="${res.id}" title="开始发布">▶ 开始</button>
            </div>
        `;

        // 收藏
        item.querySelector('.res-fav-btn').addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const newFav = !res.favorited;
            await StorageHelper.updateResource(res.id, { favorited: newFav });
            res.favorited = newFav;
            btn.classList.toggle('active', newFav);
        });

        // 开始发布（打开该URL）
        item.querySelector('.res-start-btn').addEventListener('click', () => {
            chrome.tabs.create({ url: res.url });
        });

        // 点击URL打开
        item.querySelector('.resource-card-url').addEventListener('click', (e) => {
            e.preventDefault();
            chrome.tabs.create({ url: res.url });
        });

        list.appendChild(item);
    });

    renderPager(totalPages);
}

function renderPager(totalPages) {
    const pager = document.getElementById('res-pager');
    if (totalPages <= 1) {
        pager.innerHTML = '';
        return;
    }

    let html = '';
    // Previous
    html += `<button class="pager-btn" data-page="${resCurrentPage - 1}" ${resCurrentPage <= 1 ? 'disabled' : ''}>‹</button>`;

    // Page numbers (show max 5)
    let start = Math.max(1, resCurrentPage - 2);
    let end = Math.min(totalPages, start + 4);
    if (end - start < 4) start = Math.max(1, end - 4);

    for (let i = start; i <= end; i++) {
        html += `<button class="pager-btn ${i === resCurrentPage ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }

    // Next
    html += `<button class="pager-btn" data-page="${resCurrentPage + 1}" ${resCurrentPage >= totalPages ? 'disabled' : ''}>›</button>`;

    pager.innerHTML = html;

    pager.querySelectorAll('.pager-btn:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => {
            resCurrentPage = parseInt(btn.dataset.page);
            refreshResources();
        });
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
      <h4>AI 配置 (OpenRouter)</h4>
      <div class="settings-field">
        <label>OpenRouter API Key</label>
        <input class="input" id="set-api-key" type="password" value="${escapeHtml(settings.openrouterApiKey || '')}" placeholder="sk-or-...">
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
      <button class="btn-test" id="btn-test-ai">测试 AI 连接</button>
      <div class="test-result" id="ai-test-result"></div>
    </div>

    <div class="settings-section">
      <h4>Google Sheets</h4>
      <div class="settings-field">
        <label>Google Sheet ID</label>
        <input class="input" id="set-sheet-id" value="${escapeHtml(settings.googleSheetId || '')}" placeholder="从 Sheet URL 中提取的 ID">
      </div>
      <button class="btn-test" id="btn-sync-sheets">同步到 Sheets</button>
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
      <h4>${i18n.t('settings.templates')}</h4>
      <div style="font-size:11px;color:#8891a8;margin-bottom:8px">可用变量: {title} {greeting} {complement} {question} {domain} {keyword}</div>
      <div id="templates-list">${templatesHtml}</div>
      <button class="btn-add-template" id="btn-add-tpl">+ ${i18n.t('settings.addTemplate')}</button>
    </div>

    <button class="btn-save" id="btn-save-settings">${i18n.t('settings.save')}</button>
    <div class="save-toast" id="save-toast">${i18n.t('settings.saved')}</div>
  `;

    document.body.appendChild(overlay);

    overlay.querySelector('#settings-back').addEventListener('click', () => overlay.remove());

    overlay.querySelectorAll('.template-remove').forEach(btn => {
        btn.addEventListener('click', () => btn.closest('.template-item').remove());
    });

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

    overlay.querySelector('#btn-test-ai').addEventListener('click', async () => {
        const resultEl = overlay.querySelector('#ai-test-result');
        resultEl.textContent = '测试中...';
        resultEl.className = 'test-result';

        await saveCurrentSettings(overlay);

        const result = await chrome.runtime.sendMessage({ action: 'testAiConnection' });
        if (result.success) {
            resultEl.textContent = '连接成功: ' + result.message;
            resultEl.className = 'test-result success';
        } else {
            resultEl.textContent = '连接失败: ' + result.message;
            resultEl.className = 'test-result error';
        }
    });

    overlay.querySelector('#btn-sync-sheets').addEventListener('click', async () => {
        const resultEl = overlay.querySelector('#sheets-result');
        resultEl.textContent = '同步中...';
        resultEl.className = 'test-result';

        await saveCurrentSettings(overlay);

        const result = await chrome.runtime.sendMessage({ action: 'syncToSheets' });
        if (result.success) {
            resultEl.textContent = result.message;
            resultEl.className = 'test-result success';
        } else {
            resultEl.textContent = result.message;
            resultEl.className = 'test-result error';
        }
    });

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
        openrouterApiKey: overlay.querySelector('#set-api-key').value.trim(),
        modelClassify: overlay.querySelector('#set-model-classify').value.trim(),
        modelFormExtract: overlay.querySelector('#set-model-form').value.trim(),
        modelCommentGen: overlay.querySelector('#set-model-comment').value.trim(),
        modelLinkDiscover: overlay.querySelector('#set-model-link').value.trim(),
        googleSheetId: overlay.querySelector('#set-sheet-id').value.trim(),
        name: overlay.querySelector('#set-name').value.trim(),
        email: overlay.querySelector('#set-email').value.trim(),
        website: overlay.querySelector('#set-website').value.trim(),
        commentTemplates: templates,
        language: i18n.currentLang
    };

    await StorageHelper.saveSettings(newSettings);
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
