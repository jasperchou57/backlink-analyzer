/**
 * SEMrush Collector - 在 3ue.co 共享平台的 SEMrush 页面抓取外链
 * 工作在 sem.3ue.co 页面
 */

(function () {
    if (window.__semrushCollectorLoaded) return;
    window.__semrushCollectorLoaded = true;

    let isMyDomain = false;
    const MAX_PAGES = 36;
    const MAX_ITEMS = 1500;
    const MAX_PAGES_PER_DOMAIN = 8;
    const INITIAL_SCROLL_PASSES = 2;
    const STALE_PAGE_LIMIT = 5;
    const PRIORITY_SEGMENTS = [
        { key: 'best', labels: ['最佳', 'best', 'top'], maxPages: 3 },
        { key: 'latest', labels: ['最新', 'latest', 'recent', 'new'], maxPages: 2 }
    ];

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'collectAsMyDomain') {
            isMyDomain = true;
        }
    });

    async function collectBacklinks() {
        console.log('[Backlink Analyzer] SEMrush collector started on 3ue.co');

        // 等待页面加载（3ue.co 代理可能较慢）
        await delay(5000);
        await ensureReportView();

        const items = new Map();
        await collectPrioritySegments(items);
        await activateSegment('all');
        await collectCurrentPage(items, INITIAL_SCROLL_PASSES);

        // 尝试翻页
        await tryPagination(items);

        const resultItems = Array.from(items.entries()).map(([url, sourceType]) => ({
            url,
            sourceType
        }));
        console.log(`[Backlink Analyzer] SEMrush: found ${resultItems.length} results`);

        const source = isMyDomain ? 'my-semrush' : 'semrush';
        chrome.runtime.sendMessage({
            action: 'backlinkData',
            source: source,
            urls: resultItems.map((item) => item.url),
            items: resultItems
        });
    }

    async function ensureReportView() {
        for (let attempt = 0; attempt < 4; attempt++) {
            if (isBacklinksReportView() || isRefDomainsReportView()) {
                return true;
            }

            const backlinksTab = findBacklinksEntry();
            if (backlinksTab) {
                clickElement(backlinksTab);
                await delay(4500);
            }

            if (isBacklinksReportView() || isRefDomainsReportView()) {
                return true;
            }

            const fullReportButton = findFullReportButton('backlinks');
            if (fullReportButton) {
                clickElement(fullReportButton);
                await delay(5500);
            }

            if (isBacklinksReportView() || isRefDomainsReportView()) {
                return true;
            }

            const refDomainsTab = findRefDomainsEntry();
            if (refDomainsTab) {
                clickElement(refDomainsTab);
                await delay(4500);
            }

            if (isRefDomainsReportView()) {
                return true;
            }

            const refDomainsReportButton = findFullReportButton('refdomains');
            if (refDomainsReportButton) {
                clickElement(refDomainsReportButton);
                await delay(5500);
            }

            if (isBacklinksReportView() || isRefDomainsReportView()) {
                return true;
            }

            await delay(1500);
        }

        return isBacklinksReportView() || isRefDomainsReportView();
    }

    function scrapeCurrentView(items) {
        if (isBacklinksReportView()) {
            scrapeBacklinkPages(items);
            return;
        }

        scrapeDomains(items);
    }

    function scrapeBacklinkPages(items) {
        const selectors = [
            'a[href*="http"]:not([href*="semrush"]):not([href*="3ue.co"])',
            'table a[href*="http"]',
            'td a[href*="http"]',
            '[class*="backlink"] a[href]',
            '[data-test*="backlink"] a[href]',
            '.cl-table a[href*="http"]'
        ];

        for (const selector of selectors) {
            document.querySelectorAll(selector).forEach(link => {
                const href = link.href || link.getAttribute('href') || '';
                const pageUrl = toBacklinkPageUrl(href);
                if (pageUrl) {
                    registerItem(items, pageUrl, 'backlink-page');
                }
            });
        }

        document.querySelectorAll('td, [class*="cell"]').forEach(cell => {
            const text = cell.textContent.trim();
            const urlMatch = text.match(/https?:\/\/[^\s<>"')\]]+/);
            if (urlMatch) {
                const pageUrl = toBacklinkPageUrl(urlMatch[0]);
                if (pageUrl) {
                    registerItem(items, pageUrl, 'backlink-page');
                }
            }
        });
    }

    function scrapeDomains(items) {
        const selectors = [
            'a[href]:not([href*="semrush"]):not([href*="3ue.co"])',
            'table a[href]',
            'td a[href]',
            '[class*="domain"] a[href]',
            '[class*="ref"] a[href]',
            '.cl-table a[href]'
        ];

        for (const selector of selectors) {
            document.querySelectorAll(selector).forEach(link => {
                const href = link.href || link.getAttribute('href') || '';
                const domainUrl = toDomainUrl(href);
                if (domainUrl) {
                    registerItem(items, domainUrl, 'ref-domain');
                }
            });
        }

        // 从表格单元格中提取域名文本
        document.querySelectorAll('td, [class*="cell"]').forEach(cell => {
            const text = cell.textContent.trim();
            const urlMatch = text.match(/https?:\/\/[^\s<>"')\]]+/);
            if (urlMatch) {
                const domainUrl = toDomainUrl(urlMatch[0]);
                if (domainUrl) {
                    registerItem(items, domainUrl, 'ref-domain');
                }
            }

            const domainMatches = text.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi) || [];
            for (const match of domainMatches) {
                const domainUrl = toDomainUrl(match);
                if (domainUrl) {
                    registerItem(items, domainUrl, 'ref-domain');
                }
            }
        });
    }

    async function collectCurrentPage(items, scrollPasses = 1) {
        const before = items.size;
        scrapeCurrentView(items);

        for (let pass = 0; pass < scrollPasses; pass++) {
            await scrollLikeUser();
            await delay(1200);
            scrapeCurrentView(items);
            if (items.size >= MAX_ITEMS) break;
        }

        return items.size - before;
    }

    async function collectPrioritySegments(items) {
        for (const segment of PRIORITY_SEGMENTS) {
            const activated = await activateSegment(segment.key);
            if (!activated) continue;

            await delay(1200);
            await collectCurrentPage(items, 1);
            await tryPagination(items, segment.maxPages);

            if (items.size >= MAX_ITEMS) {
                return;
            }
        }
    }

    async function tryPagination(items, maxPages = MAX_PAGES) {
        let stalePages = 0;

        for (let page = 1; page < maxPages && items.size < MAX_ITEMS; page++) {
            const currentPage = getCurrentPageNumber() || page;
            const signature = getPageSignature();
            const changed = await advanceToNextPage(currentPage, signature);
            if (!changed) return;

            await delay(1800);
            const added = await collectCurrentPage(items, 1);
            if (added <= 0) {
                stalePages++;
            } else {
                stalePages = 0;
            }

            if (stalePages >= STALE_PAGE_LIMIT) {
                console.log('[Backlink Analyzer] SEMrush: stop early due to stale pages');
                return;
            }
        }
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function compactText(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    function normalizeLabel(text) {
        return compactText(text).toLowerCase();
    }

    function isBacklinksReportView() {
        const path = (window.location.pathname || '').toLowerCase();
        if (path.includes('/analytics/backlinks/backlinks')) {
            return true;
        }

        return tableLooksLikeBacklinkReport();
    }

    function isRefDomainsReportView() {
        const path = (window.location.pathname || '').toLowerCase();
        if (path.includes('/analytics/backlinks/refdomains')) {
            return true;
        }

        return tableLooksLikeRefDomainReport();
    }

    function tableLooksLikeBacklinkReport() {
        const headerText = compactText(
            Array.from(document.querySelectorAll('table thead th, [role="columnheader"]'))
                .map((cell) => cell.textContent || '')
                .join(' | ')
        ).toLowerCase();

        const rowCount = document.querySelectorAll('table tbody tr, [role="row"]').length;
        if (rowCount < 3) {
            return false;
        }

        return /(source page|referring page|target url|anchor|源页面|引荐页面|目标网址|目标网站|锚文本)/.test(headerText);
    }

    function tableLooksLikeRefDomainReport() {
        const headerText = compactText(
            Array.from(document.querySelectorAll('table thead th, [role="columnheader"]'))
                .map((cell) => cell.textContent || '')
                .join(' | ')
        ).toLowerCase();

        const rowCount = document.querySelectorAll('table tbody tr, [role="row"]').length;
        if (rowCount < 3) {
            return false;
        }

        return /(referring domains|ref domains|ref\\. domains|引荐域名|域名分布|域名)/.test(headerText);
    }

    function findRefDomainsEntry() {
        const candidates = Array.from(document.querySelectorAll('a, button, [role="tab"]'))
            .filter((el) => isVisible(el) && !isDisabled(el));

        const scored = candidates.map((el) => {
            const text = compactText(el.textContent || '').toLowerCase();
            const href = (el.getAttribute('href') || '').toLowerCase();
            let score = 0;

            if (/引荐域名|referring domains|ref domains/.test(text)) score += 6;
            if (href.includes('/analytics/backlinks/refdomains/')) score += 8;
            if (el.getAttribute('role') === 'tab') score += 2;

            return { el, score };
        }).filter((entry) => entry.score > 0);

        scored.sort((left, right) => right.score - left.score);
        return scored[0]?.el || null;
    }

    function findBacklinksEntry() {
        const candidates = Array.from(document.querySelectorAll('a, button, [role="tab"]'))
            .filter((el) => isVisible(el) && !isDisabled(el));

        const scored = candidates.map((el) => {
            const text = compactText(el.textContent || '').toLowerCase();
            const href = (el.getAttribute('href') || '').toLowerCase();
            let score = 0;

            if (/反向链接|backlinks/.test(text)) score += 6;
            if (href.includes('/analytics/backlinks/backlinks/')) score += 8;
            if (el.getAttribute('role') === 'tab') score += 2;

            return { el, score };
        }).filter((entry) => entry.score > 0);

        scored.sort((left, right) => right.score - left.score);
        return scored[0]?.el || null;
    }

    function findSegmentButton(key) {
        const labelsByKey = {
            all: ['所有', 'all'],
            best: ['最佳', 'best', 'top'],
            latest: ['最新', 'latest', 'recent', 'new']
        };
        const labels = labelsByKey[key] || [key];

        const candidates = Array.from(document.querySelectorAll('button, a, [role="tab"], [role="button"], div'))
            .filter((el) => {
                if (!isVisible(el) || isDisabled(el)) return false;
                const text = normalizeLabel(el.textContent || '');
                if (!text || text.length > 40) return false;
                return labels.some((label) => text.includes(label));
            });

        const scored = candidates.map((el) => {
            const text = normalizeLabel(el.textContent || '');
            let score = 0;
            if (labels.some((label) => text.startsWith(label))) score += 8;
            if (labels.some((label) => text.includes(label))) score += 4;
            if (el.getAttribute('role') === 'tab') score += 3;
            if (/^\D+\s*\d+/.test(text)) score += 2;
            return { el, score };
        }).filter((entry) => entry.score > 0);

        scored.sort((left, right) => right.score - left.score);
        return scored[0]?.el || null;
    }

    function isSegmentActive(key) {
        const button = findSegmentButton(key);
        if (!button) return false;
        const ariaSelected = (button.getAttribute('aria-selected') || '').toLowerCase();
        const className = String(button.className || '').toLowerCase();
        const dataState = String(button.getAttribute('data-state') || '').toLowerCase();
        return ariaSelected === 'true' ||
            /active|selected|checked|current/.test(className) ||
            /active|selected|checked|current/.test(dataState);
    }

    async function activateSegment(key) {
        const button = findSegmentButton(key);
        if (!button) {
            return key === 'all';
        }

        const previousSignature = getPageSignature();
        const previousPage = getCurrentPageNumber();
        if (!isSegmentActive(key)) {
            clickElement(button);
            await waitForSegmentChange(key, previousPage, previousSignature, 10000);
        }

        const pageInput = findPageInput();
        if (pageInput && Number(pageInput.value) > 1) {
            await jumpToPage(pageInput, 1, getPageSignature());
            await delay(1000);
        }

        return true;
    }

    async function waitForSegmentChange(key, previousPage, previousSignature, timeout) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (isSegmentActive(key)) return true;

            const currentPage = getCurrentPageNumber();
            const currentSignature = getPageSignature();
            if ((currentPage && previousPage && currentPage !== previousPage) ||
                (currentSignature && currentSignature !== previousSignature)) {
                return true;
            }
            await delay(350);
        }
        return false;
    }

    function findFullReportButton(mode = 'backlinks') {
        const candidates = Array.from(document.querySelectorAll('a, button'))
            .filter((el) => isVisible(el) && !isDisabled(el));

        const reportLink = candidates.find((el) => {
            const href = (el.getAttribute('href') || '').toLowerCase();
            return mode === 'refdomains'
                ? href.includes('/analytics/backlinks/refdomains/')
                : href.includes('/analytics/backlinks/backlinks/');
        });
        if (reportLink) {
            return reportLink;
        }

        return candidates.find((el) => {
            const text = compactText(el.textContent || '').toLowerCase();
            if (mode === 'refdomains') {
                return /查看完整报告|完整报告|view full report|full report|引荐域名/.test(text);
            }
            return /查看完整报告|完整报告|view full report|full report|反向链接|backlinks/.test(text);
        }) || null;
    }

    function toBacklinkPageUrl(value) {
        const raw = compactText(value || '');
        if (!raw) return '';

        try {
            const normalized = raw.startsWith('http') ? raw : `https://${raw}`;
            const parsed = new URL(normalized);
            const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
            if (!hostname || hostname.includes('semrush') || hostname.includes('3ue.co')) {
                return '';
            }
            if (/(google|facebook|twitter|youtube|instagram|linkedin)\.com$/.test(hostname)) {
                return '';
            }
            const path = parsed.pathname.replace(/\/+$/, '') || '/';
            const search = parsed.search || '';
            return `https://${hostname}${path}${search}`;
        } catch {
            return '';
        }
    }

    function toDomainUrl(value) {
        const raw = compactText(value || '');
        if (!raw) return '';

        try {
            const normalized = raw.startsWith('http') ? raw : `https://${raw}`;
            const hostname = new URL(normalized).hostname.replace(/^www\./, '').toLowerCase();
            if (!hostname || hostname.includes('semrush') || hostname.includes('3ue.co')) {
                return '';
            }
            if (/(google|facebook|twitter|youtube|instagram|linkedin)\.com$/.test(hostname)) {
                return '';
            }
            return `https://${hostname}/`;
        } catch {
            return '';
        }
    }

    function getDomain(value) {
        try {
            const normalized = String(value || '').startsWith('http') ? String(value) : `https://${value}`;
            return new URL(normalized).hostname.replace(/^www\./, '').toLowerCase();
        } catch {
            return '';
        }
    }

    function registerItem(items, url, sourceType) {
        if (!url || items.size >= MAX_ITEMS) return;
        if (items.has(url)) return;

        if (sourceType === 'backlink-page') {
            const domain = getDomain(url);
            if (domain) {
                let count = 0;
                for (const [existingUrl, existingType] of items.entries()) {
                    if (existingType !== 'backlink-page') continue;
                    if (getDomain(existingUrl) === domain) count++;
                    if (count >= MAX_PAGES_PER_DOMAIN) return;
                }
            }
        }

        items.set(url, sourceType);
    }

    async function scrollLikeUser() {
        const targets = [
            document.querySelector('[class*="table"] [class*="scroll"]'),
            document.querySelector('[class*="virtual"]'),
            document.querySelector('[role="grid"]'),
        ].filter(Boolean);

        if (targets.length === 0) {
            targets.push(document.scrollingElement || document.body);
        }

        for (const target of targets) {
            const maxScroll = Math.max((target.scrollHeight || 0) - (target.clientHeight || 0), 0);
            for (let top = 0; top <= maxScroll; top += Math.max(500, Math.floor((target.clientHeight || 800) * 0.9))) {
                try {
                    target.scrollTo?.({ top, behavior: 'instant' });
                    target.scrollTop = top;
                } catch {}
                await delay(150);
            }
        }

        await scrollPaginationIntoView();
    }

    function getPageSignature() {
        return compactText(
            Array.from(document.querySelectorAll('table tbody tr, [role="row"]'))
                .slice(0, 10)
                .map((row) => row.textContent || '')
                .join(' | ')
        );
    }

    function findNextPageButton() {
        const pagination = findPaginationContainer();
        if (pagination) {
            const scopedButtons = pagination.querySelectorAll('button, a, [role="button"]');
            for (const el of scopedButtons) {
                if (!isVisible(el) || isDisabled(el)) continue;
                const text = compactText(`${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`).toLowerCase();
                if (/^next$|下一|›|»|→/.test(text)) {
                    return el;
                }
            }
        }

        const selectors = [
            '[data-test="pagination-next"]',
            'button[aria-label*="next" i]',
            'button[aria-label*="下一" i]',
            '[class*="pagination"] button',
            '[class*="pagination"] a',
            'button[class*="next"]'
        ];

        for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            for (const el of elements) {
                if (!isVisible(el) || isDisabled(el)) continue;
                const text = compactText(`${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`).toLowerCase();
                if (/next|下一|›|»|→/.test(text) || selector === '[data-test="pagination-next"]') {
                    return el;
                }
            }
        }
        return null;
    }

    async function advanceToNextPage(currentPage, previousSignature) {
        await scrollPaginationIntoView();

        const nextBtn = findNextPageButton();
        if (nextBtn) {
            clickElement(nextBtn);
            const changed = await waitForNextPage(currentPage, previousSignature, 10000);
            if (changed) return true;
        }

        const pageInput = findPageInput();
        if (pageInput) {
            const nextPage = currentPage + 1;
            const jumped = await jumpToPage(pageInput, nextPage, previousSignature);
            if (jumped) return true;
        }

        return false;
    }

    async function waitForPageChange(previousSignature, timeout) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const current = getPageSignature();
            if (current && current !== previousSignature) return true;
            await delay(500);
        }
        return false;
    }

    async function waitForNextPage(previousPage, previousSignature, timeout) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const currentPage = getCurrentPageNumber();
            const currentSignature = getPageSignature();
            if ((currentPage && currentPage > previousPage) ||
                (currentSignature && currentSignature !== previousSignature)) {
                return true;
            }
            await delay(400);
        }
        return false;
    }

    async function jumpToPage(input, pageNumber, previousSignature) {
        try {
            input.focus();
            input.value = String(pageNumber);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        } catch {}

        return waitForNextPage(pageNumber - 1, previousSignature, 10000);
    }

    function getCurrentPageNumber() {
        const input = findPageInput();
        if (input?.value) {
            const value = Number(String(input.value).replace(/[^\d]/g, ''));
            if (Number.isFinite(value) && value > 0) return value;
        }

        const pagination = findPaginationContainer();
        if (pagination) {
            const text = compactText(pagination.textContent || '');
            const match = text.match(/page:\s*(\d+)/i) || text.match(/(\d+)\s*of\s*\d+/i);
            if (match) return Number(match[1]);
        }

        return 0;
    }

    function findPageInput() {
        const pagination = findPaginationContainer();
        if (pagination) {
            const scopedInput = pagination.querySelector('input[type="text"], input[type="number"], input:not([type])');
            if (scopedInput && isVisible(scopedInput)) {
                return scopedInput;
            }
        }

        return Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])'))
            .find((input) => {
                if (!isVisible(input)) return false;
                const marker = compactText(`${input.value || ''} ${input.placeholder || ''}`);
                return /^\d+$/.test(marker) || /page/i.test(marker);
            }) || null;
    }

    function findPaginationContainer() {
        return Array.from(document.querySelectorAll('[class*="pagination"], [class*="pager"], nav, [role="navigation"]'))
            .find((container) => isVisible(container) && /page|prev|next|of/i.test(compactText(container.textContent || '')));
    }

    async function scrollPaginationIntoView() {
        const pagination = findPaginationContainer();
        if (!pagination) return;

        try {
            pagination.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch {}
        await delay(300);
    }

    function clickElement(el) {
        try {
            el.click?.();
            ['mousedown', 'mouseup', 'click'].forEach((type) => {
                el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            });
        } catch {}
    }

    function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function isDisabled(el) {
        const ariaDisabled = (el.getAttribute('aria-disabled') || '').toLowerCase();
        return !!el.disabled || ariaDisabled === 'true';
    }

    setTimeout(collectBacklinks, 3000);
})();
