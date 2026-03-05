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
            }
        }

        // 多次尝试抓取结果（因为页面可能需要时间渲染）
        let urls = new Set();
        for (let attempt = 0; attempt < 3; attempt++) {
            await delay(3000);
            scrapeUrls(urls);

            // 尝试滚动加载更多
            window.scrollTo(0, document.body.scrollHeight);
            await delay(1500);
        }

        // 尝试抓取更多页面结果
        await tryLoadMore(urls);

        const urlArray = Array.from(urls);
        console.log(`[Backlink Analyzer] Ahrefs: found ${urlArray.length} backlinks`);

        const source = isMyDomain ? 'my-ahrefs' : 'ahrefs';
        chrome.runtime.sendMessage({
            action: 'backlinkData',
            source: source,
            urls: urlArray
        });
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

        // === 方法3: 页面中显示的域名文本 ===
        document.querySelectorAll('span, div, td').forEach(el => {
            if (el.children.length === 0) { // 只检查叶子节点
                const text = el.textContent.trim();
                if (text.match(/^[\w-]+\.[\w.-]+\.\w{2,}$/) && !text.includes('ahrefs')) {
                    urls.add('https://' + text);
                }
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

    setTimeout(collectBacklinks, 2000);
})();
