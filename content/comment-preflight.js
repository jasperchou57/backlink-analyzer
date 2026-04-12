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

    async function doProgressiveBottomScroll(context = {}, options = {}) {
        const immediate = options.immediate !== false;
        const body = globalScope.document.body;
        const doc = globalScope.document.documentElement;
        const viewportHeight = Math.max(globalScope.innerHeight || 0, 600);
        const scrollHeight = Math.max(body?.scrollHeight || 0, doc?.scrollHeight || 0);
        if (scrollHeight <= viewportHeight + 80) {
            return false;
        }

        const nextStep = Math.min(Number(context.commentScrollStep || 0) + 1, 5);
        context.commentScrollStep = nextStep;
        const forceProgressiveScroll = !!options.forceProgressiveScroll;

        // 5 步渐进滚动：50% → 70% → 85% → 95% → 底部
        const scrollRatios = [
            forceProgressiveScroll ? 0.50 : 0.45,
            0.70,
            0.85,
            0.95,
            1.0
        ];
        const ratio = scrollRatios[Math.min(nextStep - 1, scrollRatios.length - 1)];
        const targetY = ratio >= 1.0
            ? Math.max(0, scrollHeight - viewportHeight - 40)
            : Math.max(0, Math.round(scrollHeight * ratio));

        if (Math.abs((globalScope.scrollY || 0) - targetY) < 80) {
            return false;
        }

        try {
            globalScope.scrollTo({ top: targetY, behavior: immediate ? 'auto' : 'smooth' });
        } catch {
            globalScope.scrollTo(0, targetY);
        }
        // 越靠近底部，等待越长（懒加载评论组件常需 1-2 秒渲染）
        const baseWait = immediate ? 400 : 800;
        const lazyExtra = ratio >= 0.85 ? 700 : 0;
        await wait(baseWait + lazyExtra);
        return true;
    }

    async function primeCommentSectionSearch(context = {}, options = {}) {
        const immediate = options.immediate !== false;

        // 第一步：找一个"真正像样"的评论区目标（带 textarea/可编辑区或严格 form）
        // 找到了就 scrollIntoView 过去
        const commentTarget = findLikelyCommentSection();
        if (commentTarget && !context.commentSectionPrimed) {
            try {
                commentTarget.scrollIntoView({ behavior: immediate ? 'auto' : 'smooth', block: 'center' });
            } catch {}
            context.commentSectionPrimed = true;
            await wait(immediate ? 300 : 600);
            return true;
        }

        // 第二步：没找到真目标 OR 已经 prime 过但还没找到表单 → 强制渐进滚动到底
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
