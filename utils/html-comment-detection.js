/**
 * HTML Comment Detection — 严格 WordPress 博客评论外链筛选
 *
 * 基于哥飞 226 条可用资源的实测特征：
 * 1. WordPress 站（wp-content / wordpress）
 * 2. 有 WP 评论表单（wp-comments-post / comment_post_ID）
 * 3. 有标准字段（name="author" + textarea）
 * 4. 有 URL 字段（name="url" / name="website"）
 * 5. 有已存在的评论（comment-list / comment-body / comment-author class）
 * 6. 不需要登录
 * 7. 评论未关闭
 * 8. 无验证码
 *
 * 只有同时满足以上条件才标记为可发布资源。
 * 不再检测论坛、注册表单、目录提交、wiki 等非核心类型。
 */

(function (globalScope) {
    if (globalScope.HtmlCommentDetection) return;

    function analyze(html, url = '', options = {}) {
        const text = String(html || '');
        const h = text.toLowerCase();

        // ── 8 条核心检测 ──────────────────────────────────────

        // 1. WordPress 站
        const isWordPress = h.includes('wp-content') || h.includes('wordpress');

        // 2. WP 评论表单
        const hasWpCommentForm =
            h.includes('wp-comments-post')
            || h.includes('comment_post_id')
            || (h.includes('id="respond"') && h.includes('commentform'));

        // 3. 标准字段
        const hasAuthorField =
            h.includes('name="author"')
            || h.includes('id="author"')
            || h.includes('comment-form-author');
        const hasTextarea = h.includes('<textarea');

        // 4. URL 字段（能留链接的关键）
        const hasUrlField =
            h.includes('name="url"')
            || h.includes('id="url"')
            || h.includes('name="website"')
            || h.includes('id="website"')
            || h.includes('type="url"');

        // 5. 已存在的评论（证明评论功能确实可用）
        const hasExistingComments =
            h.includes('comment-list')
            || h.includes('comment-body')
            || h.includes('comment-author')
            || h.includes('comments-area')
            || h.includes('comment-content')
            || /class="[^"]*comment[^"]*"[^>]*>.*?class="[^"]*comment[^"]*"/s.test(h.substring(0, 500000));

        // 6. 不需要登录
        const requiresLogin =
            h.includes('must be logged in to post a comment')
            || h.includes('you must be logged in to post a comment')
            || h.includes('log in to leave a comment')
            || h.includes('login to leave a comment')
            || h.includes('sign in to leave a comment')
            || h.includes('sign in to comment')
            || h.includes('log in to comment')
            || h.includes('please log in to comment')
            || h.includes('register to reply');

        // 7. 评论未关闭
        const commentsClosed =
            h.includes('comments are closed')
            || h.includes('commenting is closed')
            || h.includes('comments closed')
            || h.includes('discussion closed');

        // 8. 无验证码
        const hasCaptcha =
            h.includes('g-recaptcha')
            || h.includes('grecaptcha')
            || h.includes('hcaptcha')
            || h.includes('cf-turnstile')
            || h.includes('cloudflare-turnstile');
        // 注意：不检测泛 "captcha" 字符串，因为有些页面正文提到 captcha 但实际没有

        // ── 判定逻辑 ─────────────────────────────────────────

        // 核心条件：WP站 + WP评论表单 + 标准字段 + URL字段 + 无阻断
        // "已有评论"是加分项，不是必须条件（新文章/懒加载可能暂时没有）
        const isPublishable =
            isWordPress
            && hasWpCommentForm
            && hasAuthorField
            && hasTextarea
            && hasUrlField
            && !requiresLogin
            && !commentsClosed
            && !hasCaptcha;

        if (!isPublishable) {
            // 检查是否是"差一点就能发"的情况，给出具体原因
            const blockers = [];
            if (!isWordPress) blockers.push('not-wordpress');
            if (!hasWpCommentForm) blockers.push('no-wp-comment-form');
            if (!hasAuthorField) blockers.push('no-author-field');
            if (!hasTextarea) blockers.push('no-textarea');
            if (!hasUrlField) blockers.push('no-url-field');
            if (!hasExistingComments) blockers.push('no-existing-comments');
            if (requiresLogin) blockers.push('login-required');
            if (commentsClosed) blockers.push('comment-closed');
            if (hasCaptcha) blockers.push('captcha');

            // 如果是 WP 站但被某个条件拦截了，仍然返回结果（放入待后续处理池）
            if (isWordPress && hasWpCommentForm && blockers.length <= 2) {
                const pageTitle = text.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.trim()?.substring(0, 100) || '';
                return {
                    url,
                    pageTitle,
                    opportunities: ['comment'],
                    details: ['wordpress', ...blockers],
                    linkModes: hasUrlField ? ['website-field'] : [],
                    linkMethod: hasUrlField ? 'website-field' : 'text',
                    hasCaptcha,
                    hasUrlField,
                    requiresLoginToPost: requiresLogin,
                    commentsClosed,
                    resourceClass: 'weak',
                    frictionLevel: 'high',
                    directPublishReady: false
                };
            }

            return null;
        }

        // ── 构建资源信号 ─────────────────────────────────────

        const pageTitle = text.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.trim()?.substring(0, 100) || '';
        const details = ['wordpress', 'inline-submit-form', 'website-field'];
        if (hasExistingComments) {
            details.push('has-existing-comments');
        }
        const linkModes = ['website-field'];

        // 额外检测：是否支持 HTML 锚文本
        const hasExplicitHtmlAnchorHint =
            /(allowed html tags|html tags allowed|you may use these html tags|allowed tags)/i.test(text);
        if (hasExplicitHtmlAnchorHint) {
            details.push('allowed-html-anchor');
            linkModes.push('raw-html-anchor');
        }

        // 额外检测：是否有 email 字段
        const hasEmailField =
            h.includes('name="email"')
            || h.includes('id="email"')
            || h.includes('comment-form-email');
        if (hasEmailField) {
            details.push('has-email-field');
        }

        return {
            url,
            pageTitle,
            opportunities: ['comment'],
            details: Array.from(new Set(details)),
            linkModes: Array.from(new Set(linkModes)),
            linkMethod: linkModes.includes('raw-html-anchor') ? 'html' : 'website-field',
            hasCaptcha: false,
            hasUrlField: true,
            requiresLoginToPost: false,
            commentsClosed: false,
            resourceClass: 'blog-comment',
            frictionLevel: 'low',
            directPublishReady: true
        };
    }

    globalScope.HtmlCommentDetection = {
        analyze
    };
})(self);
