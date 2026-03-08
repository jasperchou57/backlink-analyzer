/**
 * Ahrefs Collector - 在 Ahrefs 免费版 Backlink Checker 页面抓取外链
 * 工作在 ahrefs.com/backlink-checker 页面
 */

(function () {
    if (window.__ahrefsCollectorLoaded) return;
    window.__ahrefsCollectorLoaded = true;

    let isMyDomain = false;

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'collectAsMyDomain') {
            isMyDomain = true;
        }
    });

    async function collectBacklinks() {
        console.log('[Backlink Analyzer] Ahrefs collector started');

        // 等待页面加载和可能的自动查询
        await delay(3000);
        await trySolveVerification();

        // 检查是否已经有结果，如果没有则尝试触发查询
        let hasResults = checkForResults();

        if (!hasResults) {
            // 尝试点击 "Check backlinks" 按钮
            const checkBtn = document.querySelector(
                'button[data-testid="check-backlinks"], button.css-1qplz20, input[type="submit"], button[type="submit"]'
            );
            if (checkBtn) {
                checkBtn.click();
                console.log('[Backlink Analyzer] Clicked check button');
                await delay(8000); // 等待结果加载
                await trySolveVerification();
            }
        }

        // 多次尝试抓取结果（因为页面可能需要时间渲染）
        const urls = new Set();
        for (let attempt = 0; attempt < 3; attempt++) {
            await delay(3000);
            scrapeUrls(urls);

            // 尝试滚动加载更多
            window.scrollTo(0, document.body.scrollHeight);
            await delay(1500);
        }

        // 尝试抓取更多页面结果
        await tryLoadMore(urls);

        const items = Array.from(urls).map((url) => ({
            url,
            sourceType: 'backlink-page'
        }));
        console.log(`[Backlink Analyzer] Ahrefs: found ${items.length} backlinks`);

        const source = isMyDomain ? 'my-ahrefs' : 'ahrefs';
        chrome.runtime.sendMessage({
            action: 'backlinkData',
            source: source,
            urls: items.map((item) => item.url),
            items
        });
    }

    async function trySolveVerification() {
        for (let attempt = 0; attempt < 6; attempt++) {
            const solved = clickCloudflareWidget();
            if (solved) {
                console.log('[Backlink Analyzer] Attempted Cloudflare verification click');
                await delay(2500);
            }

            if (checkForResults() || !hasVerificationPrompt()) {
                return;
            }

            await delay(2000);
        }
    }

    function hasVerificationPrompt() {
        const pageText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
        if (/确认您是真人|verify you are human|confirm you are human|cloudflare/i.test(pageText)) {
            return true;
        }
        return !!document.querySelector(
            'iframe[src*="cloudflare"], iframe[title*="challenge" i], iframe[src*="turnstile"], ' +
            'input[type="checkbox"][name*="cf"], [class*="turnstile"], [class*="challenge"]'
        );
    }

    function clickCloudflareWidget() {
        const candidates = [
            ...document.querySelectorAll('label, input[type="checkbox"], iframe, div, span, button')
        ].filter((el) => {
            const text = `${el.getAttribute?.('title') || ''} ${el.getAttribute?.('aria-label') || ''} ${el.textContent || ''}`.toLowerCase();
            const src = (el.getAttribute?.('src') || '').toLowerCase();
            const cls = (el.className || '').toString().toLowerCase();
            return /cloudflare|turnstile|verify|human|真人|challenge/.test(text)
                || /cloudflare|turnstile|challenge/.test(src)
                || /turnstile|challenge/.test(cls);
        });

        for (const el of candidates) {
            if (!isVisible(el)) continue;
            clickElementLikeUser(el);
            return true;
        }

        return false;
    }

    function checkForResults() {
        // 检查页面上是否已有结果表格
        return document.querySelector(
            'table, [class*="result"], [class*="backlink"], [data-testid*="result"]'
        ) !== null;
    }

    function scrapeUrls(urls) {
        // === 方法1: 表格中的外部链接 ===
        const selectors = [
            'a[href*="http"]:not([href*="ahrefs.com"])',
            'table a[href]',
            '[class*="BacklinkRow"] a',
            '[class*="backlink"] a',
            'td a[href*="http"]'
        ];

        for (const selector of selectors) {
            document.querySelectorAll(selector).forEach(link => {
                const href = link.href || link.getAttribute('href') || '';
                if (href && href.startsWith('http') &&
                    !href.includes('ahrefs.com') &&
                    !href.includes('javascript:') &&
                    !href.includes('google.com/analytics')) {
                    urls.add(href);
                }
            });
        }

        // === 方法2: 从 "Referring page" 列中提取 URL 文本 ===
        document.querySelectorAll('td, [class*="cell"], [class*="column"]').forEach(el => {
            const text = el.textContent.trim();
            // 匹配 URL 格式的文本
            const urlMatch = text.match(/https?:\/\/[^\s<>"')\]]+/);
            if (urlMatch && !urlMatch[0].includes('ahrefs.com')) {
                urls.add(urlMatch[0]);
            }
        });

    }

    async function tryLoadMore(urls) {
        // 尝试点击 "Show more" 或分页按钮
        const moreButtons = document.querySelectorAll(
            'button, a[role="button"]'
        );

        for (const btn of moreButtons) {
            const text = btn.textContent.toLowerCase();
            if (text.includes('more') || text.includes('next') ||
                text.includes('show') || text.includes('load') ||
                text.includes('下一')) {
                btn.click();
                await delay(3000);
                scrapeUrls(urls);
            }
        }
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isVisible(el) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden';
    }

    function clickElementLikeUser(el) {
        try {
            const rect = el.getBoundingClientRect();
            const clientX = rect.left + rect.width / 2;
            const clientY = rect.top + rect.height / 2;
            const target = document.elementFromPoint(clientX, clientY) || el;
            ['mouseover', 'mousedown', 'mouseup', 'click'].forEach((type) => {
                target.dispatchEvent(new MouseEvent(type, {
                    view: window,
                    bubbles: true,
                    cancelable: true,
                    clientX,
                    clientY
                }));
            });
            el.click?.();
        } catch {}
    }

    setTimeout(collectBacklinks, 2000);
})();
