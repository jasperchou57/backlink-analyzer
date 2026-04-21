/**
 * Network Inspector - 网络响应拦截器
 * 注入到页面上下文，拦截 Fetch/XHR POST 请求，分析提交结果
 *
 * ⚠️ 关键约束（2026-04 准确率修复）
 *  - 默认 disarmed，只在 comment-publisher 显式 __bla_inspect_arm 之后才分析请求
 *  - armed 状态下只分析 URL 匹配 form.action（或评论提交端点路径）的 POST
 *  - armed 最长 30s，超时自动 disarm，防止 content script 崩溃时永远监听
 *  - 不再做 response.ok → success 的隐式兜底，只认 body pattern
 *  - Patterns 大幅收窄：去掉裸 /"error"/、/forbidden/、/"id":\d+.*"status"/ 这类无评论上下文的宽匹配
 */

(function () {
    if (window.__networkInspectorLoaded) return;
    window.__networkInspectorLoaded = true;

    // 大厂三方站点不拦截，避免拦截自家埋点/广告脚本
    const SAFE_SITES = /gemini\.google\.com|google\.com\/search|facebook\.com|twitter\.com|linkedin\.com|github\.com|dashscope\.aliyuncs\.com/i;

    // 已知评论提交端点路径关键字（armed 但 action 不匹配时的兜底）
    const KNOWN_COMMENT_ENDPOINT_RE = /\/(wp-comments-post|wp-json\/wp\/v2\/comments|comment|reply|publish[\-_]comment|submit[\-_]comment)/i;

    // ─── 收紧后的 pattern 集合 ───
    // 每条都带"评论"上下文，不再用裸关键字
    const MODERATION_PATTERNS = [
        /"status"\s*:\s*"(hold|moderation|unapproved|pending)"/i,
        /awaiting moderation/i,
        /pending approval/i,
        /comment is awaiting/i,
        /held for moderation/i,
        /en attente de modération/i,
        /en espera de moderación/i,
        /wartet auf moderation/i,
        /承認待ち/,
        /待审核/,
        /审核中/,
        /审核后显示/,
        /评论正在审核/,
        /留言正在审核/
    ];

    const SUCCESS_PATTERNS = [
        /"success"\s*:\s*true/i,
        /"comment_id"\s*:\s*\d+/i,
        /"status"\s*:\s*"(ok|approved|published)"/i,
        /comment (submitted|posted|published) successfully/i,
        /thank you for your comment/i,
        /<li[^>]*id="comment-\d+/i,
        /评论发布成功/,
        /评论已发表/,
        /发表成功/,
        /评论已提交/
    ];

    const FAILURE_PATTERNS = [
        /duplicate comment detected/i,
        /already said that/i,
        /comments too quickly/i,
        /posting comments too fast/i,
        /comment.*flagged as spam/i,
        /comment denied/i,
        /verification failed/i,
        /captcha.*(required|failed|invalid)/i,
        /评论失败/,
        /重复评论/,
        /评论过于频繁/,
        /评论被拒/,
        /操作过于频繁/
    ];

    function analyzeResponseBody(body) {
        if (!body || typeof body !== 'string') return null;
        const trimmed = body.substring(0, 5000);

        // 顺序：moderation > failure > success
        // 避免 "awaiting moderation" 的站点同时命中某个 success pattern
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

    // ─── Arm/disarm 状态机 ───
    // armedState = { actionHost, actionPath, expiresAt } 或 null
    let armedState = null;
    const ARM_MAX_DURATION_MS = 30000;
    let armTimer = null;

    function disarmInspector() {
        armedState = null;
        if (armTimer) {
            clearTimeout(armTimer);
            armTimer = null;
        }
    }

    window.addEventListener('__bla_inspect_arm', (event) => {
        const detail = event.detail || {};
        const actionUrl = String(detail.formAction || '').trim();
        try {
            // formAction 可能是相对路径，以当前页面为基底
            const u = actionUrl
                ? new URL(actionUrl, window.location.href)
                : new URL(window.location.href);
            armedState = {
                actionHost: u.hostname.replace(/^www\./i, '').toLowerCase(),
                actionPath: (u.pathname || '').toLowerCase(),
                expiresAt: Date.now() + ARM_MAX_DURATION_MS
            };
            if (armTimer) clearTimeout(armTimer);
            armTimer = setTimeout(disarmInspector, ARM_MAX_DURATION_MS);
        } catch {
            // parse 失败就 disarm，不兜底拦截
            disarmInspector();
        }
    });

    window.addEventListener('__bla_inspect_disarm', disarmInspector);

    function matchesArmedAction(reqUrl) {
        if (!armedState) return false;
        if (Date.now() > armedState.expiresAt) {
            disarmInspector();
            return false;
        }
        try {
            const u = new URL(reqUrl, window.location.href);
            const host = u.hostname.replace(/^www\./i, '').toLowerCase();
            const path = (u.pathname || '').toLowerCase();
            // 首要：与 armed action 的 host+path 完全一致
            if (host === armedState.actionHost) {
                if (path === armedState.actionPath) return true;
                // 兜底：armed action 为当前页面但真实提交端点是 wp-comments-post
                if (KNOWN_COMMENT_ENDPOINT_RE.test(path)) return true;
            }
            return false;
        } catch {
            return false;
        }
    }

    function shouldIntercept(url) {
        if (!url) return false;
        if (SAFE_SITES.test(url)) return false;
        // 必须 armed 且 URL 匹配评论提交端点
        return matchesArmedAction(url);
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
                }
                // 不再用 response.ok 做兜底成功判定。
                // 空 pattern = 未知，让 anchor verifier / navigation confirm 最终裁决。
            }).catch(() => {});

            return response;
        } catch (e) {
            // 网络错误不等于评论被拒，只记日志，不再广播 'error'
            return Promise.reject(e);
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
                    }
                    // 同 fetch：不再用 status 2xx 兜底 success
                } catch {}
            });
        }
        return XHRSend.call(this, body);
    };

    console.log('[BLA] Network Inspector loaded (armed-only mode)');
})();
