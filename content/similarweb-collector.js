/**
 * SimilarWeb Collector - 在 3ue.co 共享平台的 SimilarWeb 页面抓取数据
 * 工作在 sim.3ue.co 页面
 */

(function () {
    if (window.__similarwebCollectorLoaded) return;
    window.__similarwebCollectorLoaded = true;

    let isMyDomain = false;

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'collectAsMyDomain') {
            isMyDomain = true;
        }
    });

    async function collectBacklinks() {
        console.log('[Backlink Analyzer] SimilarWeb collector started on 3ue.co');

        // SimilarWeb 加载较慢
        await delay(6000);

        const urls = new Set();

        for (let attempt = 0; attempt < 4; attempt++) {
            scrapeUrls(urls);

            window.scrollTo(0, document.body.scrollHeight);
            await delay(2000);
        }

        const urlArray = Array.from(urls);
        console.log(`[Backlink Analyzer] SimilarWeb: found ${urlArray.length} referring domains`);

        const source = isMyDomain ? 'my-similarweb' : 'similarweb';
        chrome.runtime.sendMessage({
            action: 'backlinkData',
            source: source,
            urls: urlArray
        });
    }

    function scrapeUrls(urls) {
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
                if (href && href.startsWith('http') &&
                    !href.includes('similarweb.com') &&
                    !href.includes('3ue.co') &&
                    !href.includes('javascript:') &&
                    !href.includes('google.com') &&
                    !href.includes('facebook.com') &&
                    !href.includes('twitter.com') &&
                    !href.includes('youtube.com')) {
                    urls.add(href);
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
                urls.add('https://' + text);
            }
        });
    }

    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    setTimeout(collectBacklinks, 4000);
})();
