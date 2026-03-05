/**
 * Page Analyzer - 检测页面是否有评论表单
 * 注入到待分析的外链页面
 */

(function () {
    if (window.__pageAnalyzerLoaded) return;
    window.__pageAnalyzerLoaded = true;

    function analyzePage() {
        const result = {
            url: window.location.href,
            pageTitle: document.title || '',
            hasCommentForm: false,
            formType: 'unknown',
            linkMethod: 'text',     // text | html | website-field
            sources: []
        };

        // === 1. 检测 WordPress 评论表单 ===
        const wpSelectors = [
            '#commentform',
            '#respond',
            '.comment-form',
            '#comment-form',
            'form.comment-form',
            '#comments form',
            '.post-comments form',
            'form[action*="wp-comments-post"]'
        ];

        for (const sel of wpSelectors) {
            if (document.querySelector(sel)) {
                result.hasCommentForm = true;
                result.formType = 'wordpress';
                break;
            }
        }

        // === 2. 检测 Blogger / Blogspot 评论 ===
        if (!result.hasCommentForm) {
            const bloggerSelectors = [
                '#comment-editor',
                '.comment-form',
                'iframe[src*="blogger.com/comment"]',
                '#blogger-comment-from',
                '.blogger-comment-from'
            ];

            for (const sel of bloggerSelectors) {
                if (document.querySelector(sel)) {
                    result.hasCommentForm = true;
                    result.formType = 'blogger';
                    break;
                }
            }
        }

        // === 3. 检测 Disqus ===
        if (!result.hasCommentForm) {
            if (document.querySelector('#disqus_thread') ||
                document.querySelector('[class*="disqus"]') ||
                document.querySelector('iframe[src*="disqus.com"]')) {
                result.hasCommentForm = true;
                result.formType = 'disqus';
            }
        }

        // === 4. 通用评论表单检测 ===
        if (!result.hasCommentForm) {
            // 检查是否有 textarea + 提交按钮的组合
            const textareas = document.querySelectorAll('textarea');
            for (const ta of textareas) {
                const name = (ta.name || ta.id || '').toLowerCase();
                const placeholder = (ta.placeholder || '').toLowerCase();

                if (name.includes('comment') || name.includes('message') || name.includes('reply') ||
                    placeholder.includes('comment') || placeholder.includes('leave') ||
                    placeholder.includes('reply') || placeholder.includes('write') ||
                    placeholder.includes('评论') || placeholder.includes('留言')) {

                    // 检查附近是否有提交按钮
                    const form = ta.closest('form');
                    if (form && form.querySelector('button[type="submit"], input[type="submit"]')) {
                        result.hasCommentForm = true;
                        result.formType = 'generic';
                        break;
                    }
                }
            }
        }

        // === 5. 检测链接方式 ===
        if (result.hasCommentForm) {
            // 检查是否有 Website / URL 输入字段
            const websiteInputs = document.querySelectorAll(
                'input[name="url"], input[name="website"], input[id="url"], input[id="website"], input[type="url"]'
            );
            if (websiteInputs.length > 0) {
                result.linkMethod = 'website-field';
            }

            // 检查已有评论中是否允许 HTML
            const existingComments = document.querySelectorAll(
                '.comment-content a[href], .comment-body a[href], .comment-text a[href]'
            );
            if (existingComments.length > 0) {
                result.linkMethod = 'html';
            }
        }

        // === 6. 检查页面是否需要登录才能评论 ===
        if (result.hasCommentForm) {
            const loginRequired = document.querySelector(
                '.must-log-in, .login-required, [class*="login-to-comment"]'
            );
            if (loginRequired) {
                result.hasCommentForm = false; // 需要登录的不算
            }
        }

        console.log('[Backlink Analyzer] Page analysis:', result);

        // 发送结果回 background
        chrome.runtime.sendMessage({
            action: 'pageAnalysisResult',
            result
        });
    }

    // 延迟执行，等待页面完全渲染
    setTimeout(analyzePage, 1500);
})();
