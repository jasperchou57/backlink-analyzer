/**
 * Popup.js V3 - 主弹窗逻辑
 * 新增：日志 Tab、多任务管理、AI/Sheets 设置
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

    // === 多任务发布 ===
    document.getElementById('btn-add-task').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openTaskEditor();
    });

    // === 发布卡片按钮 ===
    document.querySelectorAll('.pub-card-btn[data-action="publish"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const category = btn.dataset.category;
            startCategoryPublish(category);
        });
    });

    const viewFavBtn = document.querySelector('[data-action="view-favorites"]');
    if (viewFavBtn) {
        viewFavBtn.addEventListener('click', () => {
            // 切到资源库 Tab 并筛选收藏
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            document.querySelector('[data-tab="resources"]').classList.add('active');
            document.getElementById('panel-resources').classList.add('active');
            refreshResources('favorites');
        });
    }

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
            refreshPublishStats();
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
            if (resp.isCollecting) setCollectingUI(true);
        }
    } catch { }

    const collectState = await StorageHelper.getCollectState();
    if (collectState.isCollecting) {
        document.getElementById('domain-input').value = collectState.domain || '';
        document.getElementById('my-domain-input').value = collectState.myDomain || '';
        setCollectingUI(true);
    }

    refreshPublishStats();
    refreshTasks();

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

async function refreshPublishStats() {
    const resources = await StorageHelper.getResources();
    const counts = { pending: 0, published: 0, skipped: 0, failed: 0 };
    resources.forEach(r => { if (counts[r.status] !== undefined) counts[r.status]++; });

    document.getElementById('pub-pending').textContent = counts.pending;
    document.getElementById('pub-published').textContent = counts.published;
    document.getElementById('pub-skipped').textContent = counts.skipped;
    document.getElementById('pub-failed').textContent = counts.failed;

    // Update category card counts
    const catCounts = { comment: 0, 'submit-site': 0, forum: 0, listing: 0, favorites: 0 };
    resources.forEach(r => {
        if (r.status !== 'pending') return;
        const opps = r.opportunities || [r.type] || [];
        if (opps.includes('comment')) catCounts.comment++;
        else if (opps.includes('submit-site')) catCounts['submit-site']++;
        else if (opps.includes('forum')) catCounts.forum++;
        else catCounts.listing++;
        if (r.favorited) catCounts.favorites++;
    });

    const el = id => document.getElementById(id);
    el('count-comment').textContent = catCounts.comment + ' 个待发布';
    el('count-submit-site').textContent = catCounts['submit-site'] + ' 个待发布';
    el('count-forum').textContent = catCounts.forum + ' 个待发布';
    el('count-listing').textContent = catCounts.listing + ' 个待发布';

    // Count all favorites regardless of status
    const favCount = resources.filter(r => r.favorited).length;
    el('count-favorites').textContent = favCount + ' 个';

    // Hide import button if database already imported
    const dbImported = await StorageHelper.get('dbImported');
    const importBar = document.getElementById('import-bar');
    if (dbImported) {
        importBar.style.display = 'none';
    }
}

async function startCategoryPublish(category) {
    // Check if there's a task, if not create one on the fly
    const resp = await chrome.runtime.sendMessage({ action: 'getTasks' });
    const tasks = resp?.tasks || [];

    if (tasks.length === 0) {
        openTaskEditor(null, category);
        return;
    }

    // Use first task and start publishing with category filter
    const task = tasks[0];
    task.categoryFilter = category;
    chrome.runtime.sendMessage({ action: 'startPublish', task });

    const current = document.getElementById('publish-current');
    current.style.display = 'block';
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

        refreshPublishStats();
        refreshResources();
    } catch (e) {
        btn.textContent = '导入失败: ' + e.message;
        btn.disabled = false;
    }
}

function updatePublishProgress(msg) {
    const container = document.getElementById('publish-current');
    container.style.display = 'block';
    document.getElementById('publish-empty').style.display = 'none';

    document.getElementById('current-url').textContent = msg.currentUrl || '-';
    document.getElementById('progress-fill').style.width =
        msg.total > 0 ? ((msg.current / msg.total) * 100) + '%' : '0%';
    document.getElementById('progress-text').textContent = `${msg.current} / ${msg.total}`;

    refreshPublishStats();
}

// ============================================================
// 多任务管理
// ============================================================

async function refreshTasks() {
    const resp = await chrome.runtime.sendMessage({ action: 'getTasks' });
    const tasks = resp?.tasks || [];
    const list = document.getElementById('task-list');
    list.innerHTML = '';

    if (tasks.length === 0) {
        list.innerHTML = '<div class="empty-hint">暂无发布任务，点击"新建任务"创建</div>';
        return;
    }

    tasks.forEach(task => {
        const card = document.createElement('div');
        card.className = 'task-card';
        const stats = task.stats || { total: 0, success: 0, pending: 0, failed: 0 };
        card.innerHTML = `
            <div class="task-info">
                <div class="task-name">${escapeHtml(task.name || task.website)}</div>
                <div class="task-meta">
                    ${escapeHtml(task.website)} · ${task.mode === 'full-auto' ? '全自动' : '半自动'}
                </div>
                <div class="task-stats-mini">
                    ✓${stats.success} · ✗${stats.failed} · Σ${stats.total}
                </div>
            </div>
            <div class="task-actions">
                <button class="task-btn task-run" title="开始发布">▶</button>
                <button class="task-btn task-edit" title="编辑">✎</button>
                <button class="task-btn task-del" title="删除">×</button>
            </div>
        `;

        card.querySelector('.task-run').addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'startPublish', task });
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

function openTaskEditor(existingTask, categoryFilter) {
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
// 资源库
// ============================================================

const TYPE_LABELS = {
    comment: '评论', forum: '论坛', register: '注册',
    'submit-site': '提交网站', 'guest-post': '投稿',
    listing: '展示平台', wiki: 'Wiki', 'rich-editor': '编辑器',
    disqus: 'Disqus', form: '表单'
};

async function refreshResources(overrideFilter) {
    const allResources = await StorageHelper.getResources();
    const list = document.getElementById('resources-list');
    const empty = document.getElementById('resources-empty');
    const count = document.getElementById('res-count');

    const activeFilter = document.querySelector('.res-filter.active');
    const filter = overrideFilter || (activeFilter ? activeFilter.dataset.filter : 'all');

    let resources;
    if (filter === 'comment') {
        resources = allResources.filter(r =>
            (r.opportunities && r.opportunities.includes('comment')) || r.type === 'comment'
        );
    } else if (filter === 'favorites') {
        resources = allResources.filter(r => r.favorited);
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

        const statusCls = 'status-' + (res.status || 'pending');
        const title = res.pageTitle ? `<div class="res-title" title="${escapeHtml(res.pageTitle)}">${escapeHtml(res.pageTitle)}</div>` : '';
        const detail = res.details && res.details.length ? `<div class="res-detail">${res.details.join(' · ')}</div>` : '';

        const showRepublish = res.status === 'published' || res.status === 'failed' || res.status === 'skipped';

        item.innerHTML = `
      <div class="res-info">
        ${title}
        <div class="res-url">${escapeHtml(res.url)}</div>
        <div class="res-meta">
          ${sourceTags}
          ${typeTags}
          <span class="res-tag ${statusCls}">${i18n.t('status.' + (res.status || 'pending'))}</span>
        </div>
        ${detail}
      </div>
      <div class="res-actions">
        ${showRepublish ? `<button class="res-btn res-republish" data-id="${res.id}" title="重新发布">🔄</button>` : ''}
        ${showRepublish ? `<button class="res-btn res-reset" data-id="${res.id}" title="重置为待发布">↩</button>` : ''}
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
                chrome.runtime.sendMessage({ action: 'resetStatus', resourceId: res.id });
                setTimeout(refreshResources, 500);
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
      <h4>🤖 AI 配置 (OpenRouter)</h4>
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

    <button class="btn-save" id="btn-save-settings">${i18n.t('settings.save')}</button>
    <div class="save-toast" id="save-toast">${i18n.t('settings.saved')}</div>
  `;

    document.body.appendChild(overlay);

    // Back button
    overlay.querySelector('#settings-back').addEventListener('click', () => overlay.remove());

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
    document.getElementById('btn-collect').textContent = i18n.t('collect.start');

    // Publish tab
    document.querySelector('#panel-publish .panel-header h3').textContent = i18n.t('publish.tasks');

    // Resources tab
    document.querySelector('#panel-resources .panel-header h3').innerHTML =
        i18n.t('resources.title') + ` <span class="badge" id="res-count">0</span>`;

    // Footer
    document.getElementById('btn-settings').textContent = i18n.t('footer.settings');
    document.getElementById('btn-clear').textContent = i18n.t('footer.clear');
}
