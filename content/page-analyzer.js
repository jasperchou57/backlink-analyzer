/**
 * Page Analyzer - 基于共享评论表单检测模块
 * 注入到待分析的外链页面
 */

(function () {
    if (window.__pageAnalyzerLoaded) return;
    window.__pageAnalyzerLoaded = true;

    function buildFallbackResult() {
        const hasCommentForm = !!document.querySelector('form textarea, textarea#comment, textarea[name="comment"]');
        const hasUrlField = !!document.querySelector('input[name="url"], input#url, input[name="website"], input[type="url"]');
        return {
            url: window.location.href,
            pageTitle: document.title || '',
            hasCommentForm,
            formType: hasCommentForm ? 'generic' : 'unknown',
            formScore: hasCommentForm ? 20 : 0,
            formSignature: '',
            commentFormSelector: '',
            linkMethod: hasUrlField ? 'website-field' : 'text',
            linkModes: hasUrlField ? ['website-field'] : [],
            opportunities: hasCommentForm ? ['comment'] : [],
            details: ['detector-missing'],
            sources: [],
            hasCaptcha: false,
            hasUrlField,
            directPublishReady: hasCommentForm && hasUrlField,
            requiresLogin: false,
            commentsClosed: false,
            resourceClass: '',
            frictionLevel: ''
        };
    }

    function analyzePage() {
        const detector = window.CommentFormDetection;
        const result = detector?.detectPageCommentCapabilities
            ? detector.detectPageCommentCapabilities(document)
            : buildFallbackResult();

        console.log('[Backlink Analyzer] Page analysis:', result);

        chrome.runtime.sendMessage({
            action: 'pageAnalysisResult',
            result
        });
    }

    setTimeout(analyzePage, 1200);
})();
