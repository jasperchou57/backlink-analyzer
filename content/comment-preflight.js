(function (globalScope) {
    if (globalScope.CommentPreflight) return;

    function compactText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function normalizeComparableText(value) {
        return compactText(value)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
    }

    function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function getDocumentScrollMetrics() {
        const body = globalScope.document.body;
        const doc = globalScope.document.documentElement;
        const viewportHeight = Math.max(globalScope.innerHeight || 0, doc?.clientHeight || 0, 600);
        const scrollHeight = Math.max(body?.scrollHeight || 0, doc?.scrollHeight || 0, viewportHeight);
        const scrollY = Math.max(globalScope.scrollY || globalScope.pageYOffset || doc?.scrollTop || 0, 0);
        return { body, doc, viewportHeight, scrollHeight, scrollY };
    }

    function markCommentSearchProgress(context = {}, reason = '', meta = {}) {
        if (!context || typeof context !== 'object') return;
        context.commentSearchProgressAt = Date.now();
        context.commentSearchProgressReason = compactText(reason || '');
        context.commentSearchProgressMeta = {
            ...(context.commentSearchProgressMeta || {}),
            ...meta
        };
    }

    function isVisible(el) {
        if (!(el instanceof HTMLElement)) return false;
        const style = globalScope.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect?.();
        return !!rect && rect.width > 0 && rect.height > 0;
    }

    function describeElement(el) {
        if (!el) return '';
        if (el.id) return `#${el.id}`;
        const name = el.getAttribute?.('name');
        if (name) return `${(el.tagName || '').toLowerCase()}[name="${String(name).replace(/"/g, '\\"')}"]`;
        const classes = String(el.className || '')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 3)
            .join('.');
        if (classes) return `${(el.tagName || '').toLowerCase()}.${classes}`;
        return (el.tagName || '').toLowerCase();
    }

    function findLikelyCommentSection() {
        const selectors = [
            globalScope.location?.hash || '',
            '#respond',
            '#comments',
            '#commentform',
            'form[action*="comment" i]',
            'form[action*="wp-comments-post" i]',
            'textarea[name="comment"]',
            'textarea#comment',
            '.comment-respond',
            '.comments-area',
            '.comment-form',
            '.post-comments',
            '[id*="comment" i]',
            '[class*="comment" i]'
        ].filter(Boolean);

        const candidates = [];
        selectors.forEach((selector) => {
            globalScope.document.querySelectorAll(selector).forEach((el) => {
                if (!(el instanceof HTMLElement)) return;

                // 严格门槛：必须真有可写入的输入控件，否则只是装饰性的"comment"小工具
                // （比如 Recent Comments 侧栏 widget），它会骗过文字关键字打分。
                const hasRealInput = !!el.querySelector(
                    'textarea, [contenteditable="true"], .ql-editor, .ProseMirror, .mce-content-body'
                );
                const isStrictFormElement = el.matches?.(
                    'textarea[name="comment"], textarea#comment, form[action*="comment" i], form[action*="wp-comments-post" i]'
                );
                if (!hasRealInput && !isStrictFormElement) return;

                const text = compactText(el.textContent || '').toLowerCase();
                const score =
                    (isVisible(el) ? 20 : 0)
                    + (/comment|reply|leave a comment|leave a reply|reactie|laat een reactie|发表评论|留言|评论/.test(text) ? 30 : 0)
                    + (hasRealInput ? 40 : 0)
                    + (isStrictFormElement ? 28 : 0)
                    + (el.querySelector('button[type="submit"], input[type="submit"], button, input[type="button"]') ? 10 : 0);
                candidates.push({ el, score });
            });
        });

        candidates.sort((left, right) => right.score - left.score);
        return candidates.find((item) => item.score >= 35)?.el || null;
    }

    function findLikelyCommentAnchorTarget() {
        const candidates = [];
        const selectors = [
            'a[href="#comments"]',
            'a[href="#respond"]',
            'a[href="#commentform"]',
            'a[href*="#comments"]',
            'a[href*="#respond"]',
            'a[href*="#commentform"]',
            'a[href*="#comment-"]',
            'a[href*="#reply"]',
            '[data-scroll-target*="comment"]'
        ];

        selectors.forEach((selector) => {
            globalScope.document.querySelectorAll(selector).forEach((el) => {
                if (!(el instanceof HTMLElement)) return;
                if (!isVisible(el)) return;

                const href = compactText(el.getAttribute('href') || '');
                const dataTarget = compactText(el.getAttribute('data-scroll-target') || '');
                const rawTarget = href.includes('#') ? href.slice(href.indexOf('#')) : dataTarget;
                if (!rawTarget || !rawTarget.startsWith('#')) return;

                let target = null;
                try {
                    target = globalScope.document.querySelector(rawTarget);
                } catch {}

                const text = compactText(
                    el.textContent
                    || el.getAttribute('aria-label')
                    || el.getAttribute('title')
                    || ''
                ).toLowerCase();
                const score =
                    (isVisible(el) ? 20 : 0)
                    + (target instanceof HTMLElement ? 35 : 0)
                    + (/(comment|reply|respond|leave a comment|leave a reply|发表评论|留言|评论)/.test(text) ? 40 : 0)
                    + (/^#(comments|respond|commentform|comment)/i.test(rawTarget) ? 18 : 0);

                candidates.push({ el, target, hash: rawTarget, score, text });
            });
        });

        candidates.sort((left, right) => right.score - left.score);
        return candidates.find((item) => item.score >= 45) || null;
    }

    async function doProgressiveBottomScroll(context = {}, options = {}) {
        const immediate = options.immediate !== false;
        const metrics = getDocumentScrollMetrics();
        const { body, doc, viewportHeight, scrollHeight, scrollY } = metrics;
        if (scrollHeight <= viewportHeight + 80) {
            return false;
        }

        const longPageMode = !!(
            options.longPageMode
            || context.commentLongPageMode
            || scrollHeight > viewportHeight * 2.5
        );
        context.commentLongPageMode = longPageMode;

        const scrollRatios = longPageMode
            ? [0.60, 0.80, 0.92, 0.98, 1.0]
            : [
                options.forceProgressiveScroll ? 0.50 : 0.45,
                0.70,
                0.85,
                0.95,
                1.0
            ];
        const nextStep = Math.min(Number(context.commentScrollStep || 0) + 1, scrollRatios.length);
        context.commentScrollStep = nextStep;

        const ratio = scrollRatios[Math.min(nextStep - 1, scrollRatios.length - 1)];
        const targetY = ratio >= 1.0
            ? Math.max(0, scrollHeight - viewportHeight - 40)
            : Math.max(0, Math.round(scrollHeight * ratio));

        const nearBottom = Math.abs(scrollY - targetY) < 80;
        if (nearBottom) {
            if (!context.commentBottomSettled && ratio >= 0.98) {
                context.commentBottomSettled = true;
                markCommentSearchProgress(context, 'bottom-settle', {
                    step: nextStep,
                    ratio,
                    scrollY,
                    scrollHeight,
                    viewportHeight
                });
                await wait(immediate ? 900 : 1500);
                return true;
            }
            return false;
        }

        try {
            globalScope.scrollTo({ top: targetY, behavior: immediate ? 'auto' : 'smooth' });
        } catch {
            globalScope.scrollTo(0, targetY);
        }
        markCommentSearchProgress(context, 'progressive-scroll', {
            step: nextStep,
            ratio,
            targetY,
            scrollHeight,
            viewportHeight
        });

        // 越靠近底部，等待越长（懒加载评论组件常需 1-2 秒渲染）
        const baseWait = immediate ? (longPageMode ? 500 : 400) : (longPageMode ? 950 : 800);
        const lazyExtra = ratio >= 0.92 ? 1000 : ratio >= 0.80 ? 600 : 0;
        await wait(baseWait + lazyExtra);

        const updatedMetrics = getDocumentScrollMetrics();
        if (updatedMetrics.scrollHeight > scrollHeight + 40) {
            context.commentBottomSettled = false;
            markCommentSearchProgress(context, 'content-expanded', {
                previousScrollHeight: scrollHeight,
                scrollHeight: updatedMetrics.scrollHeight
            });
        }
        return true;
    }

    /**
     * 强制展开"评论区默认折叠"主题的容器。
     *
     * 大量主题（prodsens / hackaday / 各种 WordPress.com 风格）把 commentform
     * 包在 <div class="comments-collapse" id="comments-hidden"> 类容器里，CSS
     * 默认 display:none 或 height:0。用户必须点"View Comments"才展开。
     *
     * 我们的 isVisible() 检查 boundingClientRect.width/height > 0，折叠状态
     * 直接判定 form 不可见 → scoreStandardCommentForm 返回 -Infinity →
     * fast-flow-check ran=false 100% 失败。整批资源 fast-flow 命中率仅 1.5%
     * 就是这个原因。
     *
     * 修法：preflight 早期扫描所有"看着像折叠 wrapper"的容器，强行 inline
     * style 解除折叠 + 移除常见 hidden class + 取消 hidden attribute。也尝试
     * 点击常见 toggle 按钮（aria-expanded="false" 的）。
     */
    function forceExpandCollapsedComments(context = {}) {
        const candidates = new Set();
        const wrapperSelectors = [
            '[id*="comments-hidden" i]',
            '[id*="comments-collapsed" i]',
            '[class*="comments-hidden" i]',
            '[class*="comments-collapsed" i]',
            '[class*="comments-collapse" i]',
            '[class*="comment-collapsed" i]',
            '[id*="comment-toggle" i]',
            '[class*="comment-toggle" i][aria-hidden="true"]',
            '.cs-entry__comments-collapse',     // prodsens (Convex theme 系)
            '.entry-comments-collapse',
            '.collapsed-comments',
            '.commentlist-hidden'
        ];
        for (const selector of wrapperSelectors) {
            try {
                globalScope.document.querySelectorAll(selector).forEach((el) => candidates.add(el));
            } catch {}
        }

        let expanded = 0;
        for (const el of candidates) {
            if (!(el instanceof HTMLElement)) continue;
            try {
                el.style.removeProperty('display');
                el.style.removeProperty('height');
                el.style.removeProperty('max-height');
                el.style.removeProperty('overflow');
                el.style.removeProperty('visibility');
                el.style.maxHeight = 'none';
                el.style.height = 'auto';
                el.style.display = 'block';
                el.style.visibility = 'visible';
                el.removeAttribute('hidden');
                if (el.getAttribute('aria-hidden') === 'true') el.setAttribute('aria-hidden', 'false');
                if (el.getAttribute('aria-expanded') === 'false') el.setAttribute('aria-expanded', 'true');
                ['hidden', 'is-hidden', 'd-none', 'collapsed', 'is-collapsed'].forEach((cls) => el.classList.remove(cls));
                expanded++;
            } catch {}
        }

        // 主题里典型的 toggle 按钮：aria-expanded="false" + 点击展开评论
        const toggleSelectors = [
            'button[aria-expanded="false"][aria-controls*="comments" i]',
            'button[aria-expanded="false"][aria-controls*="respond" i]',
            'a[aria-expanded="false"][href*="#comments"]',
            'a[aria-expanded="false"][href*="#respond"]',
            '.comments-toggle[aria-expanded="false"]',
            '.show-comments[aria-expanded="false"]'
        ];
        for (const selector of toggleSelectors) {
            try {
                globalScope.document.querySelectorAll(selector).forEach((btn) => {
                    try { btn.click(); expanded++; } catch {}
                });
            } catch {}
        }

        if (expanded > 0) {
            markCommentSearchProgress(context, 'collapsed-expanded', { count: expanded });
        }
        return expanded;
    }

    async function primeCommentSectionSearch(context = {}, options = {}) {
        const immediate = options.immediate !== false;
        const metrics = getDocumentScrollMetrics();
        context.commentLongPageMode = !!(
            context.commentLongPageMode
            || options.longPageMode
            || metrics.scrollHeight > metrics.viewportHeight * 2.5
        );

        // 第 0 步：强制展开默认折叠的评论区。这一步必须在所有"找元素"之前跑，
        // 否则 isVisible 会因为父容器 display:none 把所有候选都判为不可见。
        if (!context.collapsedExpanded) {
            forceExpandCollapsedComments(context);
            context.collapsedExpanded = true;
        }

        // 第一步：找一个"真正像样"的评论区目标（带 textarea/可编辑区或严格 form）
        // 找到了就 scrollIntoView 过去
        const commentTarget = findLikelyCommentSection();
        if (commentTarget && !context.commentSectionPrimed) {
            try {
                commentTarget.scrollIntoView({ behavior: immediate ? 'auto' : 'smooth', block: 'center' });
            } catch {}
            context.commentSectionPrimed = true;
            markCommentSearchProgress(context, 'comment-target-found', {
                selector: describeElement(commentTarget)
            });
            await wait(immediate ? 300 : 600);
            return true;
        }

        // 第二步：页面有明显“去评论区”锚点时，优先跳过去，通常比盲目滚到底更快
        const commentAnchorTarget = findLikelyCommentAnchorTarget();
        if (commentAnchorTarget && !context.commentAnchorPrimed) {
            try {
                if (commentAnchorTarget.target instanceof HTMLElement) {
                    commentAnchorTarget.target.scrollIntoView({ behavior: immediate ? 'auto' : 'smooth', block: 'center' });
                } else {
                    commentAnchorTarget.el.click?.();
                }
            } catch {}
            context.commentAnchorPrimed = true;
            markCommentSearchProgress(context, 'comment-anchor-jump', {
                anchorHash: commentAnchorTarget.hash,
                anchorText: commentAnchorTarget.text
            });
            await wait(immediate ? 350 : 700);
            return true;
        }

        // 第三步：没找到真目标 OR 已经 prime 过但还没找到表单 → 强制渐进滚动到底
        // 触发底部懒加载的评论组件
        return await doProgressiveBottomScroll(context, options);
    }

    function getCommentAuthorText(node) {
        const authorSelectors = [
            '.fn',
            '.comment-author',
            '.comment-meta-header',
            '.comment-meta',
            '.commentmetadata',
            'cite',
            'strong',
            'b'
        ];

        for (const selector of authorSelectors) {
            const matches = Array.from(node.querySelectorAll(selector));
            for (const match of matches) {
                const text = compactText(match.textContent || '');
                if (text) {
                    return text;
                }
            }
        }
        return '';
    }

    function buildDuplicateTargetTokens(context = {}) {
        const tokens = new Set();
        const anchorUrl = compactText(context?.data?.anchorUrl || context?.values?.website || '');
        const anchorText = compactText(context?.data?.anchorKeyword || '');

        if (anchorText && anchorText.length >= 3) {
            tokens.add(normalizeComparableText(anchorText));
        }

        if (!anchorUrl) {
            return Array.from(tokens);
        }

        try {
            const parsed = new URL(anchorUrl);
            const hostname = normalizeComparableText(parsed.hostname.replace(/^www\./i, ''));
            const primaryLabel = normalizeComparableText((parsed.hostname.replace(/^www\./i, '').split('.')[0] || '').replace(/[-_]+/g, ' '));
            const pathname = normalizeComparableText(parsed.pathname.replace(/\/+$/, ''));
            const normalizedUrl = normalizeComparableText(anchorUrl)
                .replace(/^https?:\/\//, '')
                .replace(/^www\./, '')
                .replace(/\/+$/, '');

            if (hostname) tokens.add(hostname);
            if (primaryLabel && primaryLabel.length >= 3) tokens.add(primaryLabel);
            if (pathname && pathname.length >= 6) tokens.add(pathname);
            if (normalizedUrl) tokens.add(normalizedUrl);
        } catch {
            const normalized = normalizeComparableText(anchorUrl)
                .replace(/^https?:\/\//, '')
                .replace(/^www\./, '')
                .replace(/\/+$/, '');
            if (normalized) tokens.add(normalized);
        }

        return Array.from(tokens).filter((token) => token.length >= 3);
    }

    function findExistingCommentByCommenter(context = {}) {
        const commenterName = normalizeComparableText(context?.values?.name || context?.data?.name || '');
        if (!commenterName) return null;
        const duplicateTokens = buildDuplicateTargetTokens(context);
        if (duplicateTokens.length === 0) return null;

        const commentsRoot = globalScope.document.querySelector('#comments, .comments-area, .comment-list, .commentlist');
        if (!commentsRoot) return null;

        const nodes = Array.from(commentsRoot.querySelectorAll(
            '.comment, li.comment, .comment-body, .comment-content, .comment-text, article.comment'
        ));

        const candidates = nodes
            .filter((node) => node instanceof HTMLElement && isVisible(node))
            .map((node) => {
                const authorText = getCommentAuthorText(node);
                const normalizedAuthor = normalizeComparableText(authorText);
                if (!normalizedAuthor) return null;
                if (!normalizedAuthor.includes(commenterName) && !commenterName.includes(normalizedAuthor)) {
                    return null;
                }
                const normalizedText = normalizeComparableText(node.textContent || '');
                const matchedToken = duplicateTokens.find((token) => normalizedText.includes(token));
                if (!matchedToken) {
                    return null;
                }
                return {
                    node,
                    text: compactText(node.textContent || ''),
                    selector: describeElement(node),
                    authorText,
                    matchedToken
                };
            })
            .filter(Boolean);

        return candidates[0] || null;
    }

    function dismissConsentAndCookieBanners() {
        const containers = new Set();
        const containerSelectors = [
            '[id*="cookie" i]',
            '[class*="cookie" i]',
            '[id*="consent" i]',
            '[class*="consent" i]',
            '[id*="gdpr" i]',
            '[class*="gdpr" i]',
            '[id*="cmp" i]',
            '[class*="cmp" i]',
            '[aria-label*="consent" i]',
            '[data-nosnippet*="cookie" i]'
        ];

        const overlayPattern = /(cookie|consent|gdpr|privacy|cmp|borlabs)/i;
        const containerTextPattern = /(cookie|consent|gdpr|privacy preferences?|manage consent|accept cookies|cookie settings|cookies gebruiken|accepteer|akkoord|toestaan)/i;
        const acceptPattern = /\b(accept|agree|allow|save consent|got it|continue|accepteer|akkoord|toestaan|begrepen|同意|接受|确定|继续)\b/i;
        const preferPattern = /(accept all|accept cookies|accept only essential|allow all|allow selected|save consent|i agree|got it|akkoord|accepteer|toestaan|同意|接受|继续)/i;
        const rejectPattern = /(decline|reject|deny|manage|settings|preferences|weigeren|afwijzen|拒绝|设置)/i;

        const isOverlayLike = (el) => {
            if (!el || !isVisible(el)) return false;
            const role = (el.getAttribute?.('role') || '').toLowerCase();
            if (role === 'dialog' || role === 'alertdialog') return true;
            if (String(el.getAttribute?.('aria-modal') || '').toLowerCase() === 'true') return true;

            const idClass = `${el.id || ''} ${el.className || ''}`.toLowerCase();
            if (!overlayPattern.test(idClass)) return false;

            try {
                const style = globalScope.getComputedStyle(el);
                return /(fixed|sticky)/i.test(style.position || '');
            } catch {
                return false;
            }
        };

        const isSafeConsentControl = (control) => {
            if (!control || !isVisible(control) || control.disabled) return false;
            const tag = (control.tagName || '').toLowerCase();
            if (!['button', 'input'].includes(tag)) return false;

            const type = (control.getAttribute?.('type') || '').toLowerCase();
            if (tag === 'input' && !['button', 'submit'].includes(type)) return false;

            const href = (control.getAttribute?.('href') || '').trim();
            if (href) return false;

            const text = compactText(
                `${control.textContent || ''} ${control.value || ''} ${control.getAttribute?.('aria-label') || ''}`
            ).toLowerCase();
            if (!text || text.length > 80) return false;
            if (!acceptPattern.test(text)) return false;
            if (rejectPattern.test(text)) return false;
            if (!preferPattern.test(text) && !/^(accept|agree|allow|got it|save consent|continue|accepteer|akkoord|toestaan|同意|接受|确定|继续)/i.test(text)) {
                return false;
            }

            const action = `${control.getAttribute?.('onclick') || ''} ${control.getAttribute?.('data-action') || ''}`.toLowerCase();
            if (/borlabs\.io|privacy-policy|documentation|help|learn more/.test(`${href} ${action}`)) {
                return false;
            }

            return true;
        };

        containerSelectors.forEach((selector) => {
            globalScope.document.querySelectorAll(selector).forEach((el) => {
                if (isOverlayLike(el)) {
                    containers.add(el);
                }
            });
        });

        globalScope.document.querySelectorAll('div, section, aside, form, dialog').forEach((el) => {
            if (!isVisible(el)) return;
            if (!isOverlayLike(el) && !(el.matches?.('dialog,[role="dialog"],[aria-modal="true"]'))) return;
            const text = compactText(el.textContent || '').toLowerCase();
            if (containerTextPattern.test(text)) {
                containers.add(el);
            }
        });

        let clicked = 0;

        const tryClick = (el) => {
            if (!isSafeConsentControl(el)) return false;
            try {
                el.click?.();
                return true;
            } catch {
                return false;
            }
        };

        containers.forEach((container) => {
            const controls = container.matches?.('button, input[type="button"], input[type="submit"]')
                ? [container]
                : Array.from(container.querySelectorAll('button, input[type="button"], input[type="submit"]'));

            for (const control of controls) {
                if (tryClick(control)) {
                    clicked++;
                    break;
                }
            }
        });

        return clicked;
    }

    function prepareFormForInteraction(form) {
        dismissConsentAndCookieBanners();
        if (!form) return;
        try {
            form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch {}

        const primaryField = form.querySelector('textarea, [contenteditable="true"], .ql-editor, .ProseMirror, .mce-content-body');
        if (!primaryField) return;

        try {
            primaryField.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch {}
        try {
            primaryField.focus?.();
            primaryField.click?.();
            primaryField.blur?.();
        } catch {}
    }

    globalScope.CommentPreflight = {
        primeCommentSectionSearch,
        findLikelyCommentSection,
        findExistingCommentByCommenter,
        dismissConsentAndCookieBanners,
        prepareFormForInteraction
    };
})(window);
