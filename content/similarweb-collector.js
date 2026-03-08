/**
 * SimilarWeb Collector - 在 3ue.co 共享平台的 SimilarWeb 页面抓取数据
 * 工作在 sim.3ue.co 页面
 */

(function () {
    if (window.__similarwebCollectorLoaded) return;
    window.__similarwebCollectorLoaded = true;

    let isMyDomain = false;
    const MAX_PAGES = 20;
    const MAX_ITEMS = 600;
    const INITIAL_SCROLL_PASSES = 2;
    const STALE_PAGE_LIMIT = 3;

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'collectAsMyDomain') {
            isMyDomain = true;
        }
    });

    async function collectBacklinks() {
        console.log('[Backlink Analyzer] SimilarWeb collector started on 3ue.co');

        // SimilarWeb 加载较慢
        await delay(6000);

        const domains = new Set();
        await collectCurrentPage(domains, INITIAL_SCROLL_PASSES);
        await tryPagination(domains);

        const items = Array.from(domains).map((url) => ({
            url,
            sourceType: 'ref-domain'
        }));
        console.log(`[Backlink Analyzer] SimilarWeb: found ${items.length} referring domains`);

        const source = isMyDomain ? 'my-similarweb' : 'similarweb';
        chrome.runtime.sendMessage({
            action: 'backlinkData',
            source: source,
            urls: items.map((item) => item.url),
            items
        });
    }

    async function collectCurrentPage(domains, scrollPasses = 1) {
        const before = domains.size;
        scrapeUrls(domains);

        for (let pass = 0; pass < scrollPasses; pass++) {
            await scrollResultsArea();
            await delay(1200);
            scrapeUrls(domains);
            if (domains.size >= MAX_ITEMS) break;
        }

        return domains.size - before;
    }

    function scrapeUrls(domains) {
        // SimilarWeb 的引荐来源和竞争对手列表
        const selectors = [
            'a[href*="http"]:not([href*="similarweb"]):not([href*="3ue.co"])',
            'table a[href*="http"]',
            'td a[href]',
            '[class*="referral"] a[href]',
            '[class*="competitor"] a[href]',
            '[class*="domain"] a[href]',
            '[class*="site-name"] a[href]'
        ];

        for (const selector of selectors) {
            document.querySelectorAll(selector).forEach(link => {
                const href = link.href || link.getAttribute('href') || '';
                const domainUrl = toDomainUrl(href);
                if (domainUrl) {
                    domains.add(domainUrl);
                }
            });
        }

        // 从表格/列表元素中提取域名
        document.querySelectorAll('td, [class*="domain"], [class*="site"], span, div').forEach(el => {
            if (el.children.length > 1) return; // 跳过容器元素
            const text = el.textContent.trim();
            // 匹配域名格式 (e.g. "example.com")
            if (text.match(/^[\w-]+\.[\w.-]{2,}$/) &&
                !text.includes('similarweb') && !text.includes('3ue') &&
                !text.includes('google') && !text.includes('facebook') &&
                text.length < 100) {
                const domainUrl = toDomainUrl(text);
                if (domainUrl) {
                    domains.add(domainUrl);
                }
            }
        });
    }

    async function tryPagination(domains) {
        let stalePages = 0;

        for (let page = 1; page < MAX_PAGES && domains.size < MAX_ITEMS; page++) {
            const currentPage = getCurrentPageNumber() || page;
            const pageSignature = getPageSignature();
            const nextButton = findNextPageButton();
            if (!nextButton) {
                console.log('[Backlink Analyzer] SimilarWeb: no next page button found');
                return;
            }

            await scrollPaginationIntoView();
            clickElement(nextButton);

            const pageChanged = await waitForNextPage(currentPage, pageSignature, 12000);
            if (!pageChanged) {
                console.log('[Backlink Analyzer] SimilarWeb: pagination did not advance, stop at page', page);
                return;
            }

            await delay(1800);
            const added = await collectCurrentPage(domains, 1);
            if (added <= 0) {
                stalePages++;
            } else {
                stalePages = 0;
            }

            if (stalePages >= STALE_PAGE_LIMIT) {
                console.log('[Backlink Analyzer] SimilarWeb: stop early due to stale pages');
                return;
            }
        }
    }

    function findNextPageButton() {
        const paginationStatus = getPaginationStatus();
        if (paginationStatus && !paginationStatus.hasMorePages) {
            return null;
        }

        const pagination = findPaginationContainer();
        if (pagination) {
            const scopedButtons = pagination.querySelectorAll('button, a, [role="button"]');
            for (const element of scopedButtons) {
                if (!isVisible(element) || isDisabled(element)) continue;
                const text = compactText(
                    `${element.getAttribute('aria-label') || ''} ` +
                    `${element.getAttribute('title') || ''} ` +
                    `${element.textContent || ''}`
                ).toLowerCase();
                if (/(next|下一|›|»|→)/.test(text)) {
                    return element;
                }
            }
        }

        const containerButton = findNextButtonInContainer(paginationStatus?.container);
        if (containerButton) {
            return containerButton;
        }

        const selectors = [
            'button[aria-label*="next" i]',
            'button[aria-label*="下一" i]',
            'button[title*="next" i]',
            'button[title*="下一" i]',
            '[class*="pagination"] button',
            '[class*="pager"] button',
            '[class*="pagination"] a',
            '[class*="pager"] a'
        ];

        for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            for (const element of elements) {
                if (!isVisible(element) || isDisabled(element)) continue;

                const text = compactText(
                    `${element.getAttribute('aria-label') || ''} ` +
                    `${element.getAttribute('title') || ''} ` +
                    `${element.textContent || ''}`
                ).toLowerCase();

                if (/(next|下一|›|»|→|>\s*$)/.test(text)) {
                    return element;
                }
            }
        }

        const buttons = document.querySelectorAll('button, a[role="button"], a');
        for (const element of buttons) {
            if (!isVisible(element) || isDisabled(element)) continue;

            const text = compactText(
                `${element.getAttribute('aria-label') || ''} ` +
                `${element.getAttribute('title') || ''} ` +
                `${element.textContent || ''}`
            ).toLowerCase();

            if (/(^next$|下一页|next page|›|»|→)/.test(text)) {
                return element;
            }
        }

        return null;
    }

    function findPaginationContainer() {
        return Array.from(document.querySelectorAll('[class*="pagination"], [class*="pager"], nav, [role="navigation"]'))
            .find((container) => isVisible(container) && /next|of|\/|\d/.test(compactText(container.textContent || '')));
    }

    function getPaginationStatus() {
        const containers = document.querySelectorAll('[class*="pagination"], [class*="pager"], nav, [role="navigation"]');
        for (const container of containers) {
            if (!isVisible(container)) continue;
            const text = compactText(container.textContent || '');
            const slashMatch = text.match(/(\d+)\s*\/\s*(\d+)/);
            if (slashMatch) {
                const current = Number(slashMatch[1]);
                const total = Number(slashMatch[2]);
                return {
                    container,
                    current,
                    total,
                    hasMorePages: current < total
                };
            }

            const ofMatch = text.match(/page\s*(\d+)\s*of\s*(\d+)/i);
            if (ofMatch) {
                const current = Number(ofMatch[1]);
                const total = Number(ofMatch[2]);
                return {
                    container,
                    current,
                    total,
                    hasMorePages: current < total
                };
            }
        }
        return null;
    }

    function findNextButtonInContainer(container) {
        if (!container) return null;

        const controls = Array.from(container.querySelectorAll('button, a[role="button"], a'))
            .filter((element) => isVisible(element) && !isDisabled(element));

        for (const element of controls) {
            const text = compactText(
                `${element.getAttribute('aria-label') || ''} ` +
                `${element.getAttribute('title') || ''} ` +
                `${element.textContent || ''}`
            ).toLowerCase();

            if (/(next|下一|›|»|→)/.test(text)) {
                return element;
            }
        }

        const nonNumericControls = controls.filter((element) => {
            const text = compactText(element.textContent || '');
            return !/^\d+$/.test(text);
        });

        const candidates = nonNumericControls.length > 0 ? nonNumericControls : controls;
        if (candidates.length === 0) return null;

        return candidates.sort((left, right) => {
            const leftRect = left.getBoundingClientRect();
            const rightRect = right.getBoundingClientRect();
            return rightRect.left - leftRect.left;
        })[0];
    }

    async function waitForPageChange(previousSignature, timeout) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const currentSignature = getPageSignature();
            if (currentSignature && currentSignature !== previousSignature) {
                return true;
            }
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

    function getPageSignature() {
        const tableText = compactText(
            Array.from(document.querySelectorAll('table tbody tr'))
                .slice(0, 5)
                .map((row) => row.textContent || '')
                .join(' | ')
        );
        const pagerText = compactText(
            Array.from(document.querySelectorAll('[class*="pagination"], [class*="pager"], nav'))
                .slice(0, 4)
                .map((el) => el.textContent || '')
                .join(' | ')
        );
        return `${tableText} @@ ${pagerText}`;
    }

    function getCurrentPageNumber() {
        const paginationStatus = getPaginationStatus();
        if (paginationStatus?.current) {
            return paginationStatus.current;
        }

        const pagination = findPaginationContainer();
        if (!pagination) return 0;
        const text = compactText(pagination.textContent || '');
        const slashMatch = text.match(/(\d+)\s*\/\s*\d+/);
        if (slashMatch) return Number(slashMatch[1]);
        const ofMatch = text.match(/page\s*(\d+)\s*of\s*\d+/i);
        if (ofMatch) return Number(ofMatch[1]);
        return 0;
    }

    async function scrollResultsArea() {
        const scrollTargets = getScrollTargets();

        for (const target of scrollTargets) {
            const maxScroll = Math.max((target.scrollHeight || 0) - (target.clientHeight || 0), 0);
            for (let top = 0; top <= maxScroll; top += Math.max(500, Math.floor((target.clientHeight || 800) * 0.8))) {
                try {
                    target.scrollTo?.({ top, behavior: 'instant' });
                    target.scrollTop = top;
                    target.dispatchEvent(new WheelEvent('wheel', {
                        deltaY: 600,
                        bubbles: true,
                        cancelable: true
                    }));
                } catch {}
                await delay(180);
            }
        }

        await scrollPaginationIntoView();
    }

    function getScrollTargets() {
        return [
            ...document.querySelectorAll('[class*="table"] [class*="scroll"], [class*="grid"] [class*="scroll"], [class*="virtual"], [role="grid"]')
        ].filter((target) => {
            try {
                const style = window.getComputedStyle(target);
                return (target.scrollHeight || 0) > (target.clientHeight || 0)
                    && /(auto|scroll)/.test(style.overflowY || '');
            } catch {
                return false;
            }
        }).concat([document.scrollingElement, document.body].filter(Boolean));
    }

    async function scrollPaginationIntoView() {
        const pagination = findPaginationContainer();
        if (!pagination) return;

        try {
            pagination.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch {}
        await delay(300);
    }

    function compactText(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    function toDomainUrl(value) {
        const raw = compactText(value || '');
        if (!raw) return '';

        try {
            const normalized = raw.startsWith('http') ? raw : `https://${raw}`;
            const hostname = new URL(normalized).hostname.replace(/^www\./, '').toLowerCase();
            if (!hostname || hostname.includes('similarweb') || hostname.includes('3ue.co')) {
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
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    }

    function isDisabled(el) {
        const ariaDisabled = (el.getAttribute('aria-disabled') || '').toLowerCase();
        const className = (el.className || '').toString().toLowerCase();
        return !!el.disabled ||
            ariaDisabled === 'true' ||
            /\bdisabled\b/.test(className);
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    setTimeout(collectBacklinks, 4000);
})();
