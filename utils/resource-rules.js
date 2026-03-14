(function (globalScope) {
    function normalizeHttpUrl(url) {
        const value = String(url || '').trim();
        if (!value) return '';
        return /^https?:\/\//i.test(value) ? value : `https://${value}`;
    }

    function getResourceHostAndPath(resource = {}) {
        const normalized = normalizeHttpUrl(resource?.url || '');
        if (!normalized) return { host: '', path: '' };
        try {
            const parsed = new URL(normalized);
            return {
                host: parsed.hostname.replace(/^www\./i, '').toLowerCase(),
                path: (parsed.pathname || '/').toLowerCase()
            };
        } catch {
            return { host: '', path: '' };
        }
    }

    function isStrictAnchorCommentStyle(task = {}) {
        return String(task?.commentStyle || '').trim() === 'anchor-html';
    }

    function isPreferredAnchorCommentStyle(task = {}) {
        return String(task?.commentStyle || '').trim() === 'anchor-prefer';
    }

    function getResourceOpportunities(resource = {}) {
        if (Array.isArray(resource?.opportunities)) {
            return resource.opportunities.filter(Boolean);
        }

        return String(resource?.type || '')
            .split('+')
            .map((item) => item.trim())
            .filter(Boolean);
    }

    function getResourceLinkModes(resource = {}) {
        if (resourceIsCommentOnly(resource)) {
            return [];
        }

        if (Array.isArray(resource?.linkModes) && resource.linkModes.length > 0) {
            return resource.linkModes.filter(Boolean);
        }

        const derived = [];
        if (resource?.linkMethod === 'website-field') {
            derived.push('website-field');
        }
        if (resource?.linkMethod === 'html') {
            derived.push('raw-html-anchor');
        }
        if (resourceHasOpportunity(resource, 'rich-editor')) {
            derived.push('rich-editor-anchor');
        }
        if ((resource?.details || []).some((detail) => /website-field|url|website/i.test(String(detail || '')))) {
            derived.push('website-field');
        }
        if ((resource?.details || []).some((detail) => /allowed-html-anchor|html标签|允许使用html|可用标签/i.test(String(detail || '')))) {
            derived.push('raw-html-anchor');
        }
        if ((resource?.details || []).some((detail) => /可插入链接|rich-editor|contenteditable|html/i.test(String(detail || '')))) {
            derived.push('rich-editor-anchor');
        }
        if ((resource?.details || []).some((detail) => /markdown-link|markdown|commonmark/i.test(String(detail || '')))) {
            derived.push('markdown-link');
        }
        if ((resource?.details || []).some((detail) => /bbcode-link|bbcode|\[url/i.test(String(detail || '')))) {
            derived.push('bbcode-link');
        }
        if ((resource?.details || []).some((detail) => /plain-url|autolink|linkify|bare url/i.test(String(detail || '')))) {
            derived.push('plain-url');
        }
        if ((resource?.details || []).some((detail) => /profile-link/i.test(String(detail || '')))) {
            derived.push('profile-link');
        }
        return Array.from(new Set(derived));
    }

    function resourceHasRawLinkMode(resource = {}, wanted = '') {
        const normalizedWanted = compactMode(wanted);
        if (!normalizedWanted) return false;

        if (Array.isArray(resource?.linkModes) && resource.linkModes.some((mode) => compactMode(mode) === normalizedWanted)) {
            return true;
        }

        const detailText = (resource?.details || []).map((detail) => String(detail || '')).join(' ');
        if (normalizedWanted === 'profile-link') {
            return /profile-link/i.test(detailText);
        }

        return false;
    }

    function compactMode(value = '') {
        return String(value || '').trim().toLowerCase();
    }

    function resourceHasLinkMode(resource, wanted) {
        return getResourceLinkModes(resource).includes(wanted);
    }

    function resourceIsCommentOnly(resource = {}) {
        const { host, path } = getResourceHostAndPath(resource);
        const historyEntries = Object.values(resource?.publishHistory || {});
        const hasVerifiedPublish =
            historyEntries.some((entry) => entry?.lastStatus === 'published')
            || resource?.status === 'published'
            || !!resource?.publishMeta?.anchorVisible;

        if ((resource?.details || []).some((detail) => /comment-only/i.test(String(detail || '')))) {
            return true;
        }

        if (String(resource?.publishMeta?.terminalFailureReason || '').trim() === 'comment_only_form') {
            return true;
        }

        if (resource?.publishMeta?.commentOnlyDetected) {
            return true;
        }

        if (historyEntries.some((entry) => String(entry?.publishMeta?.terminalFailureReason || '').trim() === 'comment_only_form')) {
            return true;
        }

        const looksLikeAmebaOwnd =
            /(shopinfo\.jp|themedia\.jp)$/i.test(host)
            || /(ameba-ownd|powered-by-ownd|powered by ownd)/i.test((resource?.details || []).join(' '))
            || String(resource?.publishMeta?.cms || '').trim() === 'ameba-ownd';
        if (
            looksLikeAmebaOwnd
            && /\/posts\//.test(path)
            && !resourceHasRawLinkMode(resource, 'profile-link')
            && !hasVerifiedPublish
        ) {
            return true;
        }

        return false;
    }

    function resourceHasOpportunity(resource, wanted) {
        return getResourceOpportunities(resource).includes(wanted);
    }

    function resourceLooksLikeComment(resource) {
        return resourceHasOpportunity(resource, 'comment');
    }

    function resourceSupportsAnchorHtml(resource) {
        if (resourceIsCommentOnly(resource)) return false;
        return resourceHasLinkMode(resource, 'raw-html-anchor')
            || resourceHasLinkMode(resource, 'rich-editor-anchor');
    }

    function resourceSupportsWebsiteField(resource) {
        if (resourceIsCommentOnly(resource)) return false;
        return resourceHasLinkMode(resource, 'website-field');
    }

    function resourceSupportsInlineCommentLink(resource) {
        if (resourceIsCommentOnly(resource)) return false;
        return resourceHasLinkMode(resource, 'raw-html-anchor')
            || resourceHasLinkMode(resource, 'rich-editor-anchor')
            || resourceHasLinkMode(resource, 'markdown-link')
            || resourceHasLinkMode(resource, 'bbcode-link')
            || resourceHasLinkMode(resource, 'plain-url');
    }

    function resourceSupportsFormLikeLink(resource) {
        if (resourceHasLinkMode(resource, 'profile-link')) return true;
        if (resourceHasOpportunity(resource, 'form')) return true;
        if (resourceHasOpportunity(resource, 'register')) return true;
        if (resourceHasOpportunity(resource, 'submit-site')) return true;
        if (resourceHasOpportunity(resource, 'listing')) return true;
        if (resourceHasOpportunity(resource, 'guest-post')) return true;
        return (resource?.details || []).some((detail) =>
            /profile-link|submission|directory|register|guest post|投稿|注册/i.test(String(detail || ''))
        );
    }

    function resourceHasCaptcha(resource) {
        if (typeof resource?.hasCaptcha === 'boolean') {
            return resource.hasCaptcha;
        }
        return (resource?.details || []).some((detail) =>
            /captcha|recaptcha|hcaptcha|turnstile|cloudflare-turnstile/i.test(String(detail || ''))
        );
    }

    function resourceHasUrlField(resource) {
        if (typeof resource?.hasUrlField === 'boolean') {
            return resource.hasUrlField;
        }
        if (resourceSupportsWebsiteField(resource)) return true;
        return (resource?.details || []).some((detail) =>
            /website-field|url field|homepage|website|name="url"|id="url"/i.test(String(detail || ''))
        );
    }

    function resourceLooksLikeArticlePage(resource) {
        const normalized = normalizeHttpUrl(resource?.url || '');
        if (!normalized) return false;

        try {
            const parsed = new URL(normalized);
            const pathname = (parsed.pathname || '/').toLowerCase();
            const pathParts = pathname.split('/').filter(Boolean);

            if (pathParts.length === 0) return false;
            if (pathParts.length >= 2) return true;

            const pageTitle = String(resource?.pageTitle || '').toLowerCase();
            return /blog|news|guide|review|update|article|post|tips|tutorial|wiki|how to/i.test(pageTitle);
        } catch {
            return false;
        }
    }

    function resourceLooksLikeArticleComment(resource) {
        if (!resourceLooksLikeComment(resource)) return false;
        return resourceLooksLikeArticlePage(resource);
    }

    function getResourceClass(resource = {}) {
        const normalizedClass = String(resource?.resourceClass || '').trim();
        if (normalizedClass) {
            return normalizedClass;
        }

        if (resourceIsCommentOnly(resource)) return 'weak';
        if (resourceLooksLikeArticleComment(resource)) return 'blog-comment';
        if (resourceHasLinkMode(resource, 'profile-link')) return 'profile';
        if (!resourceLooksLikeComment(resource) && resourceSupportsFormLikeLink(resource)) return 'profile';
        if (resourceLooksLikeComment(resource) && resourceSupportsInlineCommentLink(resource)) return 'inline-comment';
        return 'weak';
    }

    function getResourceFrictionLevel(resource = {}) {
        const normalizedFriction = String(resource?.frictionLevel || '').trim();
        if (normalizedFriction) {
            return normalizedFriction;
        }

        if (resourceIsCommentOnly(resource)) return 'high';
        const hasPublishCapability =
            resourceSupportsDirectLink(resource)
            || resourceSupportsFormLikeLink(resource);
        if (!hasPublishCapability) return 'high';
        if (resourceCommentsClosed(resource) || resourceRequiresLogin(resource) || resourceHasCaptcha(resource)) {
            return 'high';
        }
        if (
            resourceHasInlineSubmitForm(resource)
            && (resourceHasUrlField(resource) || resourceSupportsInlineCommentLink(resource) || resourceSupportsFormLikeLink(resource))
        ) {
            return 'low';
        }
        return 'medium';
    }

    function isDirectPublishReady(resource = {}) {
        if (resourceIsCommentOnly(resource)) return false;
        return getResourceFrictionLevel(resource) === 'low'
            && !resourceRequiresLogin(resource)
            && !resourceCommentsClosed(resource)
            && !resourceHasCaptcha(resource)
            && (resourceSupportsDirectLink(resource) || resourceSupportsFormLikeLink(resource));
    }

    function resourceSupportsDirectLink(resource) {
        return resourceSupportsWebsiteField(resource) || resourceSupportsInlineCommentLink(resource);
    }

    function resourceHasInlineSubmitForm(resource) {
        return (resource?.details || []).some((detail) =>
            /inline-submit-form|textarea\+url\+submit|commentform|wp-comments-post/i.test(String(detail || ''))
        );
    }

    function resourceRequiresLogin(resource) {
        if (resourceHasOpportunity(resource, 'register')) return true;
        if (resourceHasOpportunity(resource, 'disqus')) return true;
        return (resource?.details || []).some((detail) =>
            /login-required|sign-in-required|auth-required|must-log-in/i.test(String(detail || ''))
        );
    }

    function resourceCommentsClosed(resource) {
        return (resource?.details || []).some((detail) =>
            /comment-closed|comments-closed|discussion-closed/i.test(String(detail || ''))
        );
    }

    function resourceLooksLikeNoAuthDirectPublish(resource) {
        return isDirectPublishReady(resource)
            && getResourceClass(resource) !== 'profile'
            && !isLowQualityCommentUrl(resource?.url || '', resource?.pageTitle || '');
    }

    function getPublishCandidatePriority(resource, task = {}) {
        if (resourceIsCommentOnly(resource)) return 0;

        const workflowId = task?.workflowId || '';
        const resourceClass = getResourceClass(resource);
        const frictionLevel = getResourceFrictionLevel(resource);
        const hasAnchor = resourceSupportsAnchorHtml(resource);
        const hasWebsiteField = resourceSupportsWebsiteField(resource);
        const hasInlineCommentLink = resourceSupportsInlineCommentLink(resource);
        const hasFormLikeLink = resourceSupportsFormLikeLink(resource);
        const looksLikeArticleComment = resourceLooksLikeArticleComment(resource);
        const looksLikeArticlePage = resourceLooksLikeArticlePage(resource);
        const hasDirectLinkCapability = hasInlineCommentLink || hasWebsiteField || hasFormLikeLink;

        if (workflowId === 'blog-comment-backlink') {
            if (!resourceLooksLikeNoAuthDirectPublish(resource)) return 0;
            if (isStrictAnchorCommentStyle(task)) {
                if (hasAnchor && resourceClass === 'blog-comment' && frictionLevel === 'low') return 6;
                if (hasAnchor && frictionLevel === 'low') return 5;
                if (hasAnchor) return 4;
                return 0;
            }
            if (isPreferredAnchorCommentStyle(task)) {
                if (hasAnchor && resourceClass === 'blog-comment' && frictionLevel === 'low') return 7;
                if (hasAnchor && frictionLevel === 'low') return 6;
                if (hasAnchor) return 5;
                if (resourceClass === 'blog-comment' && hasWebsiteField && frictionLevel === 'low') return 4;
                if (hasWebsiteField && frictionLevel === 'low') return 3;
                if (hasWebsiteField) return 2;
                if (hasFormLikeLink && frictionLevel !== 'high') return 1;
                return 0;
            }

            if (resourceClass === 'blog-comment' && hasWebsiteField && frictionLevel === 'low') return 6;
            if (hasWebsiteField && frictionLevel === 'low') return 5;
            if (resourceClass === 'blog-comment' && hasInlineCommentLink && frictionLevel === 'low') return 4;
            if (hasWebsiteField) return 4;
            if (hasAnchor) return 3;
            if (hasFormLikeLink && frictionLevel !== 'high') return 2;
            return 0;
        }

        if (isStrictAnchorCommentStyle(task)) {
            if (hasAnchor && frictionLevel === 'low') return 5;
            if (hasAnchor) return 3;
            return 0;
        }
        if (isPreferredAnchorCommentStyle(task)) {
            if (hasAnchor && frictionLevel === 'low') return 6;
            if (hasAnchor) return 4;
            if (resourceClass === 'blog-comment' && hasWebsiteField && frictionLevel === 'low') return 4;
            if (hasWebsiteField && frictionLevel === 'low') return 3;
            if (hasWebsiteField) return 2;
        }

        if (resourceClass === 'blog-comment' && hasWebsiteField && frictionLevel === 'low') return 5;
        if (resourceClass === 'profile' && hasFormLikeLink && frictionLevel === 'low') return 5;
        if (hasWebsiteField && frictionLevel === 'low') return 4;
        if (hasInlineCommentLink && frictionLevel === 'low') return 4;
        if (hasFormLikeLink && frictionLevel === 'low') return 4;
        if (hasWebsiteField) return 3;
        if (hasInlineCommentLink) return 3;
        if (hasFormLikeLink) return 3;
        if (hasAnchor) return 1;
        if (looksLikeArticleComment) return 1;
        if (looksLikeArticlePage) return 1;
        return 0;
    }

    function isLowQualityCommentUrl(url = '', pageTitle = '') {
        const normalized = normalizeHttpUrl(url || '');
        if (!normalized) return true;

        let parsed;
        try {
            parsed = new URL(normalized);
        } catch {
            return true;
        }

        const pathname = (parsed.pathname || '/').toLowerCase();
        const title = String(pageTitle || '').toLowerCase();
        const query = (parsed.search || '').toLowerCase();
        const pathParts = pathname.split('/').filter(Boolean);
        const firstPart = pathParts[0] || '';

        if (['category', 'tag', 'author', 'search', 'feed'].includes(firstPart)) return true;
        if (/\/(category|tag|author|search|feed)\//.test(pathname)) return true;
        if (/\/page\/\d+\/?$/.test(pathname) && pathParts.length <= 2) return true;
        if (/[?&](s|search|q)=/.test(query)) return true;
        if (/category archive|tag archive|author archive|search results|archives?/i.test(title)) return true;

        return false;
    }

    function isPublishCandidateForTask(resource, task = {}) {
        if (resourceIsCommentOnly(resource)) return false;

        const workflowId = task?.workflowId || '';
        const hasDirectLinkCapability =
            resourceSupportsWebsiteField(resource)
            || resourceSupportsAnchorHtml(resource)
            || resourceSupportsFormLikeLink(resource);
        const aiCommentFallback = !!resource?.aiClassified && hasDirectLinkCapability;
        const softArticleFallback = resourceLooksLikeArticlePage(resource);
        if (workflowId === 'blog-comment-backlink') {
            return resourceLooksLikeNoAuthDirectPublish(resource) && getPublishCandidatePriority(resource, task) > 0;
        }
        if (isStrictAnchorCommentStyle(task)) {
            if (!resourceSupportsAnchorHtml(resource)) return false;
            if (isLowQualityCommentUrl(resource?.url || '', resource?.pageTitle || '')) return false;
            return getPublishCandidatePriority(resource, task) > 0;
        }
        if (
            !resourceLooksLikeComment(resource)
            && !hasDirectLinkCapability
            && !aiCommentFallback
            && !softArticleFallback
        ) return false;
        if (isLowQualityCommentUrl(resource?.url || '', resource?.pageTitle || '')) return false;

        return getPublishCandidatePriority(resource, task) > 0;
    }

    globalScope.ResourceRules = {
        normalizeHttpUrl,
        getResourceOpportunities,
        getResourceLinkModes,
        resourceHasOpportunity,
        resourceHasLinkMode,
        resourceIsCommentOnly,
        resourceLooksLikeComment,
        resourceSupportsAnchorHtml,
        resourceSupportsWebsiteField,
        resourceSupportsInlineCommentLink,
        resourceSupportsFormLikeLink,
        resourceSupportsDirectLink,
        resourceHasInlineSubmitForm,
        resourceRequiresLogin,
        resourceCommentsClosed,
        resourceLooksLikeArticlePage,
        resourceLooksLikeArticleComment,
        resourceHasCaptcha,
        resourceHasUrlField,
        getResourceClass,
        getResourceFrictionLevel,
        isDirectPublishReady,
        resourceLooksLikeNoAuthDirectPublish,
        getPublishCandidatePriority,
        isLowQualityCommentUrl,
        isPublishCandidateForTask
    };
})(typeof self !== 'undefined' ? self : window);
