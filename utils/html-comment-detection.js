(function (globalScope) {
    if (globalScope.HtmlCommentDetection) return;

    function analyze(html, url = '', options = {}) {
        const text = String(html || '');
        const htmlLower = text.toLowerCase();
        const normalizedUrl = String(url || '').toLowerCase();
        const opportunities = [];
        const details = [];
        const linkModes = [];
        const hasTextarea = htmlLower.includes('<textarea');
        const hasSubmitControl = htmlLower.includes('type="submit"') || htmlLower.includes('<button');
        const hasUrlField =
            htmlLower.includes('type="url"')
            || htmlLower.includes('name="url"')
            || htmlLower.includes('id="url"')
            || htmlLower.includes('name="website"')
            || htmlLower.includes('id="website"')
            || htmlLower.includes('homepage');
        const hasCommentKeywords =
            htmlLower.includes('comment')
            || htmlLower.includes('reply')
            || htmlLower.includes('leave a reply')
            || htmlLower.includes('leave a comment')
            || htmlLower.includes('post comment')
            || htmlLower.includes('发表评论')
            || htmlLower.includes('留言');
        const hasIdentityFields =
            htmlLower.includes('name="author"')
            || htmlLower.includes('id="author"')
            || htmlLower.includes('comment-form-author')
            || htmlLower.includes('name="email"')
            || htmlLower.includes('id="email"')
            || htmlLower.includes('comment-form-email')
            || htmlLower.includes('name="comment"')
            || htmlLower.includes('id="comment"')
            || htmlLower.includes('comment-form-comment');
        const requiresLoginToPost =
            htmlLower.includes('must be logged in to post a comment')
            || htmlLower.includes('you must be logged in to post a comment')
            || htmlLower.includes('log in to leave a comment')
            || htmlLower.includes('login to leave a comment')
            || htmlLower.includes('sign in to leave a comment')
            || htmlLower.includes('sign in to comment')
            || htmlLower.includes('log in to comment')
            || htmlLower.includes('please log in to comment')
            || htmlLower.includes('register to reply');
        const commentsClosed =
            htmlLower.includes('comments are closed')
            || htmlLower.includes('commenting is closed')
            || htmlLower.includes('discussion closed');
        const hasCaptcha =
            htmlLower.includes('g-recaptcha')
            || htmlLower.includes('grecaptcha')
            || htmlLower.includes('hcaptcha')
            || htmlLower.includes('turnstile')
            || htmlLower.includes('cloudflare-turnstile')
            || htmlLower.includes('captcha');
        const supportsMarkdownLinks =
            hasTextarea
            && (
                /markdown|commonmark|marked|supports markdown|markdown editor|use markdown|支持markdown|使用markdown/i.test(text)
                || /\[[^\]]+\]\((https?:\/\/|\/)/i.test(text)
            );
        const supportsBbcodeLinks =
            hasTextarea
            && (
                /bbcode|ubb|bulletin board code|支持bbcode/i.test(text)
                || /\[url(?:=|\])/i.test(text)
            );
        const supportsPlainUrlLinks =
            hasTextarea
            && /autolink|linkify|plain url|bare url|paste a url|paste url|urls? will be linked|自动识别链接|自动转链接/i.test(text);
        const hasExplicitHtmlAnchorHint =
            /(allowed html tags|html tags allowed|you may use these html tags|allowed tags|comment html|html标签|允许使用html|可用标签)/i.test(text);
        const hasInlineSubmitForm = hasSubmitControl && (hasTextarea || hasIdentityFields || hasUrlField);
        const isAmebaOwnd =
            /powered by ownd|ameba ownd/i.test(text)
            || /(?:^|\/\/|\.)(shopinfo\.jp|themedia\.jp)\b/.test(normalizedUrl);

        if (
            htmlLower.includes('commentform')
            || htmlLower.includes('comment-form')
            || htmlLower.includes('comment-respond')
            || htmlLower.includes('id="respond"')
            || htmlLower.includes('wp-comments-post')
            || htmlLower.includes('leave a reply')
            || htmlLower.includes('leave a comment')
            || htmlLower.includes('发表评论')
            || htmlLower.includes('留下评论')
            || (hasTextarea && hasSubmitControl && (hasCommentKeywords || hasIdentityFields))
        ) {
            opportunities.push('comment');
            if (hasUrlField) {
                details.push('website-field');
                linkModes.push('website-field');
            }
            if (hasInlineSubmitForm) {
                details.push('inline-submit-form');
            }
            if (isAmebaOwnd) {
                details.push('ameba-ownd');
            }
            if (htmlLower.includes('wordpress') || htmlLower.includes('wp-content')) {
                details.push('wordpress');
            }
            if (hasExplicitHtmlAnchorHint) {
                details.push('allowed-html-anchor');
                linkModes.push('raw-html-anchor');
            }
            if (supportsMarkdownLinks) {
                details.push('markdown-link');
                linkModes.push('markdown-link');
            }
            if (supportsBbcodeLinks) {
                details.push('bbcode-link');
                linkModes.push('bbcode-link');
            }
            if (supportsPlainUrlLinks) {
                details.push('plain-url');
                linkModes.push('plain-url');
            }
            if (
                !hasUrlField
                && !hasIdentityFields
                && !hasExplicitHtmlAnchorHint
                && !supportsMarkdownLinks
                && !supportsBbcodeLinks
                && !supportsPlainUrlLinks
                && !htmlLower.includes('tinymce')
                && !htmlLower.includes('ckeditor')
                && !htmlLower.includes('quill')
                && !htmlLower.includes('contenteditable="true"')
            ) {
                details.push('comment-only');
            }
        }

        if (htmlLower.includes('disqus_thread') || htmlLower.includes('disqus.com')) {
            opportunities.push('disqus');
        }

        if (
            htmlLower.includes('phpbb')
            || htmlLower.includes('vbulletin')
            || htmlLower.includes('discourse')
            || htmlLower.includes('xenforo')
            || htmlLower.includes('class="forum"')
            || htmlLower.includes('id="forum"')
            || htmlLower.includes('new-topic')
            || htmlLower.includes('create-topic')
            || htmlLower.includes('reply to thread')
            || htmlLower.includes('post reply')
        ) {
            opportunities.push('forum');
        }

        if (
            (
                htmlLower.includes('sign up')
                || htmlLower.includes('register')
                || htmlLower.includes('create account')
                || htmlLower.includes('注册')
            )
            && (
                htmlLower.includes('website')
                || htmlLower.includes('url')
                || htmlLower.includes('homepage')
                || htmlLower.includes('profile')
            )
        ) {
            opportunities.push('register');
            details.push('profile-link');
            linkModes.push('profile-link');
        }

        if (
            htmlLower.includes('submit your site')
            || htmlLower.includes('submit a site')
            || htmlLower.includes('add your site')
            || htmlLower.includes('submit website')
            || htmlLower.includes('submit url')
            || htmlLower.includes('提交网站')
            || htmlLower.includes('add your link')
            || htmlLower.includes('submit listing')
        ) {
            opportunities.push('submit-site');
        }

        if (
            htmlLower.includes('write for us')
            || htmlLower.includes('guest post')
            || htmlLower.includes('guest article')
            || htmlLower.includes('contribute')
            || htmlLower.includes('submit a post')
            || htmlLower.includes('投稿')
        ) {
            opportunities.push('guest-post');
        }

        if (
            htmlLower.includes('list your')
            || htmlLower.includes('submit your startup')
            || htmlLower.includes('submit your product')
            || htmlLower.includes('发布网站')
        ) {
            opportunities.push('listing');
        }

        if (
            htmlLower.includes('tinymce')
            || htmlLower.includes('ckeditor')
            || htmlLower.includes('quill')
            || htmlLower.includes('contenteditable="true"')
        ) {
            opportunities.push('rich-editor');
            details.push('可插入链接');
            linkModes.push('rich-editor-anchor');
            if (hasInlineSubmitForm) {
                details.push('inline-submit-form');
            }
        }

        if (htmlLower.includes('mediawiki') || htmlLower.includes('action=edit')) {
            opportunities.push('wiki');
        }

        if (opportunities.length === 0) {
            const hasUrlInput = hasUrlField || htmlLower.includes('name="link"');
            if (hasTextarea && hasUrlInput && hasSubmitControl) {
                opportunities.push('form');
                details.push('textarea+url+submit');
                details.push('inline-submit-form');
                details.push('website-field');
                linkModes.push('website-field');
            }
        }

        if (opportunities.length === 0) {
            return null;
        }

        if (requiresLoginToPost) {
            details.push('login-required');
        }
        if (commentsClosed) {
            details.push('comment-closed');
        }
        if (hasCaptcha) {
            details.push('captcha');
        }

        const pageTitle = text.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.trim()?.substring(0, 100) || '';
        const resourceShape = {
            url,
            pageTitle,
            opportunities,
            details: Array.from(new Set(details)),
            linkModes: Array.from(new Set(linkModes))
        };
        const rules = options.resourceRules || globalScope.ResourceRules || null;
        const resourceClass = rules?.getResourceClass?.(resourceShape) || '';
        const frictionLevel = rules?.getResourceFrictionLevel?.(resourceShape) || '';
        const directPublishReady = !!rules?.isDirectPublishReady?.(resourceShape);

        return {
            url,
            pageTitle,
            opportunities: resourceShape.opportunities,
            details: resourceShape.details,
            linkModes: resourceShape.linkModes,
            linkMethod: resourceShape.linkModes.includes('raw-html-anchor') || resourceShape.linkModes.includes('rich-editor-anchor')
                ? 'html'
                : (resourceShape.linkModes.includes('website-field') ? 'website-field' : 'text'),
            hasCaptcha,
            hasUrlField,
            requiresLoginToPost,
            commentsClosed,
            resourceClass,
            frictionLevel,
            directPublishReady
        };
    }

    globalScope.HtmlCommentDetection = {
        analyze
    };
})(self);
