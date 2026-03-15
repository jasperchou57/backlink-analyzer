/**
 * Resource Library - 资源库模块
 * 从 popup.js 提取，负责资源列表浏览、筛选、分页、收藏
 */

// === 资源库分页状态 ===
let resCurrentPage = 1;
let resPageSize = 20;
let resSearchQuery = '';

const TYPE_LABELS = {
    comment: '评论', forum: '论坛', register: '注册',
    'submit-site': '提交网站', 'guest-post': '投稿',
    listing: '综合', wiki: 'Wiki', 'rich-editor': '编辑器',
    disqus: 'Disqus', form: '表单'
};

async function refreshResources(overrideFilter) {
    const allResources = await StorageHelper.getResources();
    const list = document.getElementById('resources-list');
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
        list.innerHTML = '<div class="empty-state"><p>暂无资源数据</p></div>';
        renderPager(totalPages);
        return;
    }

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

        // 开始发布
        item.querySelector('.res-start-btn').addEventListener('click', async () => {
            const resp = await chrome.runtime.sendMessage({ action: 'getTasks' });
            const tasks = resp?.tasks || [];
            if (tasks.length === 0) {
                alert('请先在"发布"页面创建一个任务，设置网站URL和锚文本等信息。');
                return;
            }
            // 用第一个任务的设置，发布这单个资源
            const task = tasks[0];
            chrome.runtime.sendMessage({
                action: 'startPublish',
                task,
                resourceIds: [res.id]
            });
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
