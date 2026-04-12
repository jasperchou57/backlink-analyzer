(function (global) {
    const TYPE_LABELS = {
        comment: '评论',
        forum: '论坛',
        register: '注册',
        'submit-site': '提交网站',
        'guest-post': '投稿',
        listing: '展示平台',
        wiki: 'Wiki',
        'rich-editor': '编辑器',
        disqus: 'Disqus',
        form: '表单'
    };
    const RESOURCE_POOL_ORDER = {
        main: 0,
        legacy: 1,
        quarantine: 2
    };

    function create(config = {}) {
        const storageHelper = config.storageHelper;
        const workflowRegistry = config.workflowRegistry || global.WorkflowRegistry;
        const getWorkflowMeta = config.getWorkflowMeta || (() => ({}));
        const isPublishCandidateForTask = config.isPublishCandidateForTask || (() => false);
        const escapeHtml = config.escapeHtml || ((value) => String(value || ''));
        const i18n = config.i18n || { t: (key) => key };
        const getCurrentTab = config.getCurrentTab || (() => '');
        const refreshPublishStats = config.refreshPublishStats || (async () => {});
        const refreshTasks = config.refreshTasks || (async () => {});

        let headerSyncTimer = null;
        let listObserver = null;
        let refreshRequestId = 0;

        function getResourcePool(resource = {}) {
            const normalized = String(resource?.resourcePool || '').trim().toLowerCase();
            return RESOURCE_POOL_ORDER[normalized] !== undefined ? normalized : 'legacy';
        }

        function updateHeaderCount(countValue = 0) {
            const header = document.querySelector('#panel-resources .panel-header h3');
            if (!header) return;
            const nextCount = String(Number(countValue || 0));
            const badge = header.querySelector('#res-count');
            if (!badge) {
                header.innerHTML = `${i18n.t('resources.title')} <span class="badge" id="res-count">${nextCount}</span>`;
                return;
            }

            badge.textContent = nextCount;
            const titleNode = Array.from(header.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
            if (titleNode) {
                titleNode.textContent = `${i18n.t('resources.title')} `;
            } else {
                header.insertBefore(document.createTextNode(`${i18n.t('resources.title')} `), badge);
            }
        }

        function syncHeaderCountFromList(fallbackCount = null) {
            const list = document.getElementById('resources-list');
            if (!list) return;
            const renderedCount = list.querySelectorAll('.resource-item').length;
            const hasFallbackCount = fallbackCount !== null && fallbackCount !== undefined && fallbackCount !== '';
            const nextCount = hasFallbackCount ? Number(fallbackCount) : renderedCount;
            updateHeaderCount(Number.isFinite(nextCount) ? nextCount : renderedCount);
        }

        function scheduleHeaderSync(fallbackCount = null) {
            syncHeaderCountFromList(fallbackCount);

            if (headerSyncTimer) {
                clearTimeout(headerSyncTimer);
            }

            headerSyncTimer = setTimeout(() => {
                syncHeaderCountFromList(fallbackCount);
            }, 0);

            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => syncHeaderCountFromList(fallbackCount));
            }
        }

        function ensureListObserver() {
            if (listObserver) return;
            const list = document.getElementById('resources-list');
            if (!list || typeof MutationObserver === 'undefined') return;

            listObserver = new MutationObserver(() => {
                if (getCurrentTab() === 'resources') {
                    syncHeaderCountFromList();
                }
            });

            listObserver.observe(list, { childList: true });
        }

        async function refresh() {
            const requestId = ++refreshRequestId;
            const list = document.getElementById('resources-list');
            const empty = document.getElementById('resources-empty');
            const summary = document.getElementById('resource-filter-summary');

            const activeFilter = document.querySelector('.res-filter.active');
            const filter = activeFilter ? activeFilter.dataset.filter : 'all';
            const rawResources = await storageHelper.getResources();
            if (requestId !== refreshRequestId) return;

            // 全局过滤：被清理或硬失败下架的资源所有 tab 都不显示
            const allResources = (rawResources || []).filter(
                (resource) => String(resource?.status || '') !== 'unpublishable'
            );

            const directPublishTask = {
                workflowId: 'blog-comment-backlink',
                commentStyle: 'anchor-prefer'
            };
            const workflow = getWorkflowMeta('blog-comment-backlink') || {};
            const isDirectPublishCandidate = (resource) =>
                !!workflowRegistry?.supportsResource?.(workflow, resource, directPublishTask)
                && isPublishCandidateForTask(resource, directPublishTask);

            let resources;
            if (filter === 'comment') {
                resources = allResources.filter(isDirectPublishCandidate);
            } else if (filter === 'other') {
                resources = allResources.filter((resource) => !isDirectPublishCandidate(resource));
            } else {
                resources = allResources;
            }
            resources = [...resources].sort((left, right) => {
                const poolDelta = (RESOURCE_POOL_ORDER[getResourcePool(left)] ?? 9) - (RESOURCE_POOL_ORDER[getResourcePool(right)] ?? 9);
                if (poolDelta !== 0) return poolDelta;
                const statusPriority = {
                    pending: 0,
                    failed: 1,
                    skipped: 2,
                    published: 3
                };
                const statusDelta = (statusPriority[left?.status] ?? 9) - (statusPriority[right?.status] ?? 9);
                if (statusDelta !== 0) return statusDelta;
                return String(right?.discoveredAt || '').localeCompare(String(left?.discoveredAt || ''));
            });

            if (requestId !== refreshRequestId) return;
            updateHeaderCount(resources.length);
            if (summary) {
                const poolCounts = resources.reduce((counts, resource) => {
                    const pool = getResourcePool(resource);
                    counts[pool] = Number(counts[pool] || 0) + 1;
                    return counts;
                }, { main: 0, legacy: 0, quarantine: 0 });
                summary.textContent = `当前筛选 ${resources.length} · ${i18n.t('resources.pool.main')} ${poolCounts.main} · ${i18n.t('resources.pool.legacy')} ${poolCounts.legacy} · ${i18n.t('resources.pool.quarantine')} ${poolCounts.quarantine}`;
            }

            if (resources.length === 0) {
                if (empty) empty.style.display = 'block';
                if (list) list.innerHTML = '';
                scheduleHeaderSync(0);
                return;
            }

            if (empty) empty.style.display = 'none';
            const fragment = document.createDocumentFragment();

            for (const resource of resources) {
                if (requestId !== refreshRequestId) return;
                const item = document.createElement('div');
                item.className = 'resource-item';

                const sourceTags = (resource.sources || []).map((source) => {
                    const cls = source === 'A' ? 'source-a' : source === 'S' ? 'source-s' : 'source-w';
                    return `<span class="res-tag ${cls}">${source}</span>`;
                }).join('');

                const typeTags = (resource.opportunities || [resource.type] || []).map((type) => {
                    const label = TYPE_LABELS[type] || type;
                    return `<span class="res-tag type-${type}">${escapeHtml(label)}</span>`;
                }).join('');
                const candidateTag = resource.candidateType === 'backlink-page'
                    ? `<span class="res-tag scope-page">页面级</span>`
                    : (resource.candidateType === 'hybrid'
                        ? `<span class="res-tag scope-hybrid">混合级</span>`
                        : `<span class="res-tag scope-domain">域名级</span>`);

                const statusCls = 'status-' + (resource.status || 'pending');
                const pool = getResourcePool(resource);
                const poolTag = `<span class="res-tag pool-${pool}" title="${escapeHtml(resource.resourcePoolReason || '')}">${i18n.t('resources.pool.' + pool)}</span>`;
                const title = resource.pageTitle
                    ? `<div class="res-title" title="${escapeHtml(resource.pageTitle)}">${escapeHtml(resource.pageTitle)}</div>`
                    : '';
                const detail = resource.details && resource.details.length
                    ? `<div class="res-detail">${resource.details.map((value) => escapeHtml(String(value || ''))).join(' · ')}</div>`
                    : '';
                const publishMeta = resource.publishMeta || {};
                const historyCount = Object.keys(resource.publishHistory || {}).length;
                const historyTag = historyCount > 0
                    ? `<span class="res-tag status-history">历史发布 ${historyCount} 站</span>`
                    : '';
                const anchorTag = publishMeta.anchorVisible
                    ? `<span class="res-tag status-anchor-ok">锚文本已验证</span>`
                    : (resource.status === 'published' && publishMeta.anchorInjected
                        ? `<span class="res-tag status-anchor-submitted">锚文本已提交</span>`
                        : (resource.status === 'published' && publishMeta.anchorRequested
                            ? `<span class="res-tag status-anchor-miss">未检测到锚文本</span>`
                            : ''));

                const showRepublish = resource.status === 'published' || resource.status === 'failed' || resource.status === 'skipped';
                const showHardReset = showRepublish || historyCount > 0;

                item.innerHTML = `
      <div class="res-info">
        ${title}
        <div class="res-url">${escapeHtml(resource.url)}</div>
        <div class="res-meta">
          ${sourceTags}
          ${candidateTag}
          ${typeTags}
          <span class="res-tag ${statusCls}">${i18n.t('status.' + (resource.status || 'pending'))}</span>
          ${poolTag}
          ${historyTag}
          ${anchorTag}
        </div>
        ${detail}
      </div>
      <div class="res-actions">
        ${showRepublish ? `<button class="res-btn res-republish" data-id="${resource.id}" title="重新发布">🔄</button>` : ''}
        ${showHardReset ? `<button class="res-btn res-reset" data-id="${resource.id}" title="彻底重置这条资源并清除历史">↩</button>` : ''}
        <button class="res-del" data-id="${resource.id}" title="删除">×</button>
      </div>
    `;

                item.querySelector('.res-del').addEventListener('click', async () => {
                    await storageHelper.deleteResource(resource.id);
                    refresh();
                });

                const republishBtn = item.querySelector('.res-republish');
                if (republishBtn) {
                    republishBtn.addEventListener('click', () => {
                        global.chrome.runtime.sendMessage({ action: 'republish', resourceId: resource.id });
                    });
                }

                const resetBtn = item.querySelector('.res-reset');
                if (resetBtn) {
                    resetBtn.addEventListener('click', async () => {
                        const confirmed = global.confirm('这会把这条资源彻底重置为全新状态，并清除它对所有网站的历史记录。确定继续？');
                        if (!confirmed) return;
                        await global.chrome.runtime.sendMessage({ action: 'resetStatus', resourceId: resource.id });
                        await refreshPublishStats();
                        await refreshTasks();
                        await refresh();
                    });
                }

                item.querySelector('.res-url').style.cursor = 'pointer';
                item.querySelector('.res-url').addEventListener('click', () => {
                    global.chrome.tabs.create({ url: resource.url });
                });

                fragment.appendChild(item);
            }

            if (requestId !== refreshRequestId) return;
            list.replaceChildren(fragment);
            scheduleHeaderSync(resources.length);
        }

        return {
            refresh,
            updateHeaderCount,
            scheduleHeaderSync,
            ensureListObserver
        };
    }

    global.ResourcePanel = {
        create
    };
})(typeof self !== 'undefined' ? self : window);
