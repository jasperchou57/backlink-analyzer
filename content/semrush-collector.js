/**
 * SEMrush Collector - 在 3ue.co 共享平台的 SEMrush 页面抓取外链
 * 工作在 sem.3ue.co 页面
 */

(function () {
    if (window.__semrushCollectorLoaded) return;
    window.__semrushCollectorLoaded = true;

    let isMyDomain = false;

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'collectAsMyDomain') {
            isMyDomain = true;
        }
    });

    async function collectBacklinks() {
        console.log('[Backlink Analyzer] SEMrush collector started on 3ue.co');

        // 等待页面加载（3ue.co 代理可能较慢）
        await delay(5000);

        const urls = new Set();

        // 多次尝试（页面可能需要时间渲染）
        for (let attempt = 0; attempt < 4; attempt++) {
            scrapeUrls(urls);

            // 滚动触发懒加载
            window.scrollTo(0, document.body.scrollHeight);
            await delay(2000);
        }

        // 尝试翻页
        await tryPagination(urls);

        const urlArray = Array.from(urls);
        console.log(`[Backlink Analyzer] SEMrush: found ${urlArray.length} backlinks`);

        const source = isMyDomain ? 'my-semrush' : 'semrush';
        chrome.runtime.sendMessage({
            action: 'backlinkData',
            source: source,
            urls: urlArray
        });
    }

    function scrapeUrls(urls) {
        // SEMrush 外链表格中的链接
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
                if (href && href.startsWith('http') &&
                    !href.includes('semrush.com') &&
                    !href.includes('3ue.co') &&
                    !href.includes('sentry.io') &&
                    !href.includes('javascript:')) {
                    urls.add(href);
                }
            });
        }

        // 从表格单元格中提取域名文本
        document.querySelectorAll('td, [class*="cell"]').forEach(cell => {
            const text = cell.textContent.trim();
            // 匹配 URL 或域名
            const urlMatch = text.match(/https?:\/\/[^\s<>"')\]]+/);
            if (urlMatch && !urlMatch[0].includes('semrush') && !urlMatch[0].includes('3ue.co')) {
                urls.add(urlMatch[0]);
            }
            // 匹配纯域名
            if (text.match(/^[\w-]+\.[\w.-]+$/) &&
                !text.includes('semrush') && !text.includes('3ue') &&
                text.includes('.')) {
                urls.add('https://' + text);
            }
        });
    }

    async function tryPagination(urls) {
        // SEMrush 分页
        const nextBtns = document.querySelectorAll(
            '[data-test="pagination-next"], button[aria-label="Next"], ' +
            '[class*="pagination"] [class*="next"], button[class*="next"]'
        );

        for (const btn of nextBtns) {
            if (!btn.disabled && btn.offsetParent !== null) {
                btn.click();
                await delay(3000);
                scrapeUrls(urls);
            }
        }
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    setTimeout(collectBacklinks, 3000);
})();
