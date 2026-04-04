/**
 * Network Inspector - 网络响应拦截器
 * 注入到页面上下文，拦截 Fetch/XHR POST 请求，分析提交结果
 * 移植自 Autolink 的 network_hook.js，适配 Backlink Analyzer 架构
 */

(function () {
    if (window.__networkInspectorLoaded) return;
    window.__networkInspectorLoaded = true;

    // 不拦截安全站点的请求
    const SAFE_SITES = /gemini\.google\.com|google\.com\/search|facebook\.com|twitter\.com|linkedin\.com|github\.com|dashscope\.aliyuncs\.com/i;

    const MODERATION_PATTERNS = [
        /"status"\s*:\s*"(hold|moderation|unapproved|pending)"/i,
        /awaiting moderation/i,
        /pending approval/i,
        /comment is awaiting/i,
        /held for moderation/i,
        /待审核/i,
        /审核中/i,
        /your comment is being reviewed/i
    ];

    const SUCCESS_PATTERNS = [
        /"success"\s*:\s*true/i,
        /"comment_id"\s*:/i,
        /"status"\s*:\s*"(ok|approved|published)"/i,
        /"id"\s*:\s*\d+.*"status"/i,
        /comment submitted/i,
        /successfully posted/i,
        /thank you for your comment/i,
        /评论成功/i,
        /发表成功/i
    ];

    const FAILURE_PATTERNS = [
        /"error"/i,
        /"spam"/i,
        /"captcha"/i,
        /"duplicate"/i,
        /duplicate comment/i,
        /too many comments/i,
        /rate limit/i,
        /spam detected/i,
        /comment denied/i,
        /forbidden/i,
        /评论失败/i,
        /重复评论/i
    ];

    function analyzeResponseBody(body) {
        if (!body || typeof body !== 'string') return null;
        const trimmed = body.substring(0, 5000);

        for (const pattern of MODERATION_PATTERNS) {
            if (pattern.test(trimmed)) return 'moderation';
        }
        for (const pattern of FAILURE_PATTERNS) {
            if (pattern.test(trimmed)) return 'rejected';
        }
        for (const pattern of SUCCESS_PATTERNS) {
            if (pattern.test(trimmed)) return 'confirmed';
        }
        return null;
    }

    function shouldIntercept(url) {
        if (!url) return false;
        if (SAFE_SITES.test(url)) return false;
        return true;
    }

    function broadcastSignal(type, detail) {
        window.dispatchEvent(new CustomEvent('__bla_network_signal', {
            detail: { type, ...detail, timestamp: Date.now() }
        }));
    }

    // ─── 拦截 Fetch ───
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const request = args[0];
        const options = args[1] || {};
        const method = (options.method || (request instanceof Request ? request.method : 'GET')).toUpperCase();
        const url = typeof request === 'string' ? request : (request instanceof Request ? request.url : '');

        if (method !== 'POST' || !shouldIntercept(url)) {
            return originalFetch.apply(this, args);
        }

        try {
            const response = await originalFetch.apply(this, args);
            const cloned = response.clone();

            cloned.text().then(body => {
                const signal = analyzeResponseBody(body);
                if (signal) {
                    broadcastSignal(signal, { url, source: 'fetch', status: response.status });
                } else if (response.ok) {
                    broadcastSignal('success', { url, source: 'fetch', status: response.status });
                }
            }).catch(() => {});

            return response;
        } catch (e) {
            broadcastSignal('error', { url, source: 'fetch', error: e.message });
            throw e;
        }
    };

    // ─── 拦截 XMLHttpRequest ───
    const XHROpen = XMLHttpRequest.prototype.open;
    const XHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__bla_method = method;
        this.__bla_url = url;
        return XHROpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (body) {
        if (this.__bla_method?.toUpperCase() === 'POST' && shouldIntercept(this.__bla_url)) {
            this.addEventListener('load', function () {
                try {
                    const signal = analyzeResponseBody(this.responseText);
                    if (signal) {
                        broadcastSignal(signal, { url: this.__bla_url, source: 'xhr', status: this.status });
                    } else if (this.status >= 200 && this.status < 400) {
                        broadcastSignal('success', { url: this.__bla_url, source: 'xhr', status: this.status });
                    }
                } catch {}
            });
        }
        return XHRSend.call(this, body);
    };

    console.log('[BLA] Network Inspector loaded');
})();
