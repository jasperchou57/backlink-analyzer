(function (globalScope) {
    if (globalScope.PageVerifier) return;

    // ── Helpers ──────────────────────────────────────────────────────────

    function compactText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function waitForDomReady() {
        return new Promise((resolve) => {
            if (globalScope.document.readyState === 'complete' || globalScope.document.readyState === 'interactive') {
                resolve();
            } else {
                globalScope.document.addEventListener('DOMContentLoaded', resolve, { once: true });
            }
        });
    }

    // ── CMS Detection ────────────────────────────────────────────────────

    function detectCms(doc) {
        var html = (doc.documentElement?.innerHTML || '').substring(0, 200000);
        var generators = Array.from(doc.querySelectorAll('meta[name="generator"]'))
            .map(function (el) { return compactText(el.getAttribute('content')).toLowerCase(); })
            .join(' ');

        // WordPress
        if (generators.includes('wordpress')
            || html.includes('wp-content')
            || html.includes('wp-includes')
            || doc.querySelector('link[href*="wp-content"], link[href*="wp-includes"], script[src*="wp-content"], script[src*="wp-includes"]')) {
            return 'wordpress';
        }

        // Ghost
        if (generators.includes('ghost')
            || html.includes('ghost/api')
            || doc.querySelector('link[href*="ghost"], script[src*="ghost"]')) {
            return 'ghost';
        }

        // Drupal
        if (generators.includes('drupal')
            || html.includes('drupal.js')
            || html.includes('Drupal.settings')
            || doc.querySelector('script[src*="drupal"]')) {
            return 'drupal';
        }

        // Squarespace
        if (generators.includes('squarespace')
            || html.includes('squarespace.com')
            || doc.querySelector('link[href*="squarespace"], script[src*="squarespace"]')) {
            return 'squarespace';
        }

        // Wix
        if (html.includes('wix.com')
            || html.includes('wixsite.com')
            || doc.querySelector('meta[name="generator"][content*="Wix"]')) {
            return 'wix';
        }

        // Hugo
        if (generators.includes('hugo')) {
            return 'hugo';
        }

        // Jekyll
        if (generators.includes('jekyll')) {
            return 'jekyll';
        }

        // Gatsby
        if (generators.includes('gatsby')
            || doc.querySelector('#___gatsby')) {
            return 'gatsby';
        }

        return null;
    }

    // ── Captcha Detection ────────────────────────────────────────────────

    function detectCaptcha(doc) {
        // reCAPTCHA
        if (doc.querySelector('.g-recaptcha, [data-sitekey], iframe[src*="recaptcha"], script[src*="recaptcha"]')) {
            return 'recaptcha';
        }

        // hCaptcha
        if (doc.querySelector('.h-captcha, iframe[src*="hcaptcha"], script[src*="hcaptcha"]')) {
            return 'hcaptcha';
        }

        // Cloudflare Turnstile
        if (doc.querySelector('.cf-turnstile, [data-sitekey][class*="turnstile"], iframe[src*="turnstile"], script[src*="turnstile"]')) {
            return 'turnstile';
        }

        // Generic captcha indicators
        var html = (doc.documentElement?.innerHTML || '').substring(0, 200000).toLowerCase();
        if (/g-recaptcha|grecaptcha/.test(html)) return 'recaptcha';
        if (/hcaptcha/.test(html)) return 'hcaptcha';
        if (/cf-turnstile|cloudflare.*turnstile|challenges\.cloudflare/.test(html)) return 'turnstile';

        return null;
    }

    // ── Login Requirement Detection ──────────────────────────────────────

    function detectLoginRequired(doc) {
        if (doc.querySelector('.must-log-in, .login-required, [class*="login-to-comment"]')) {
            return true;
        }
        var pageText = compactText(doc.body?.textContent || '').toLowerCase();
        return /(must be logged in|log in to (leave|post)|login to (leave|post)|sign in to (comment|post|leave|reply)|register to (comment|reply|post))/.test(pageText);
    }

    // ── Comments Closed Detection ────────────────────────────────────────

    function detectCommentsClosed(doc) {
        var pageText = compactText(doc.body?.textContent || '').toLowerCase();
        return /(comments are closed|comments closed|commenting is closed|discussion closed|comment period has ended)/.test(pageText);
    }

    // ── Rich Editor Detection ────────────────────────────────────────────

    function detectRichEditor(doc) {
        return !!doc.querySelector(
            '[contenteditable="true"], '
            + '.ql-editor, .ProseMirror, .mce-content-body, '
            + '.tox-edit-area, .note-editable, '
            + '.cke_editable, .fr-element, .trumbowyg-editor'
        );
    }

    // ── Comment Form Detection (selector-based) ──────────────────────────

    function hasCommentFormSelector(doc) {
        var selectors = [
            '#commentform',
            '#respond form',
            '.comment-form',
            'form[action*="wp-comments-post"]',
            'form[action*="comment"]',
            '#comments form',
            '.post-comments form',
            '.comment-respond form',
            '#disqus_thread',
            'textarea[name="comment"]',
            'textarea#comment'
        ];
        for (var i = 0; i < selectors.length; i++) {
            if (doc.querySelector(selectors[i])) return true;
        }
        return false;
    }

    // ── Form Summary Builder ─────────────────────────────────────────────

    function buildFormSummary(doc) {
        var forms = Array.from(doc.querySelectorAll('form'));
        var summaries = [];

        for (var fi = 0; fi < forms.length; fi++) {
            var form = forms[fi];
            var action = compactText(form.getAttribute('action') || '');
            var method = compactText(form.getAttribute('method') || 'get').toLowerCase();

            var fieldElements = Array.from(form.querySelectorAll('input, textarea, select, button'));
            var fields = [];
            var hasSubmit = false;
            var hasTextarea = false;
            var hasUrlField = false;
            var hasEmailField = false;
            var hasNameField = false;

            for (var ei = 0; ei < fieldElements.length; ei++) {
                var el = fieldElements[ei];
                var tag = (el.tagName || '').toLowerCase();
                var type = compactText(el.getAttribute('type') || '').toLowerCase();
                var name = compactText(el.getAttribute('name') || '');
                var placeholder = compactText(el.getAttribute('placeholder') || '');

                fields.push({
                    index: ei,
                    tag: tag,
                    type: type || null,
                    name: name || null,
                    placeholder: placeholder || null
                });

                if (tag === 'textarea') hasTextarea = true;

                if (tag === 'button' && (type === 'submit' || type === '' || !type)
                    || tag === 'input' && type === 'submit') {
                    hasSubmit = true;
                }

                var nameLower = name.toLowerCase();
                var typeLower = type.toLowerCase();

                if (typeLower === 'url'
                    || nameLower === 'url'
                    || nameLower === 'website'
                    || nameLower === 'homepage') {
                    hasUrlField = true;
                }

                if (typeLower === 'email'
                    || nameLower === 'email'
                    || nameLower === 'mail') {
                    hasEmailField = true;
                }

                if (nameLower === 'author'
                    || nameLower === 'name'
                    || nameLower === 'nickname'
                    || nameLower === 'display_name') {
                    hasNameField = true;
                }
            }

            // Detect submit via button text fallback
            if (!hasSubmit) {
                var buttons = Array.from(form.querySelectorAll('button, input[type="button"], a[role="button"]'));
                for (var bi = 0; bi < buttons.length; bi++) {
                    var btnText = compactText(
                        (buttons[bi].textContent || '') + ' ' + (buttons[bi].value || '')
                    ).toLowerCase();
                    if (/(submit|post comment|post|reply|send|publish)/.test(btnText)) {
                        hasSubmit = true;
                        break;
                    }
                }
            }

            summaries.push({
                formIndex: fi,
                action: action,
                method: method,
                fields: fields,
                hasSubmit: hasSubmit,
                hasTextarea: hasTextarea,
                hasUrlField: hasUrlField,
                hasEmailField: hasEmailField,
                hasNameField: hasNameField
            });
        }

        return summaries;
    }

    // ── Form Signature Builder ───────────────────────────────────────────

    function buildFormSignature(formSummary) {
        if (!formSummary) return null;

        // Detect WordPress standard 4-field comment form
        if (formSummary.hasTextarea && formSummary.hasNameField
            && formSummary.hasEmailField && formSummary.hasUrlField
            && (formSummary.action.includes('wp-comments-post') || formSummary.action.includes('comment'))) {
            var fieldCount = formSummary.fields.filter(function (f) {
                return f.tag === 'input' || f.tag === 'textarea';
            }).length;
            return 'wp-standard-' + fieldCount + 'field';
        }

        // Generic signature: method + field pattern
        var tags = formSummary.fields
            .filter(function (f) { return f.tag !== 'button'; })
            .map(function (f) { return f.tag + (f.type ? ':' + f.type : ''); })
            .join(',');
        return formSummary.method + ':' + tags;
    }

    // ── Quick Signals Builder ────────────────────────────────────────────

    function buildQuickSignals(doc, formSummaries) {
        var captchaType = detectCaptcha(doc);
        var cms = detectCms(doc);
        var hasCommentForm = hasCommentFormSelector(doc);
        var hasUrlField = false;

        for (var i = 0; i < formSummaries.length; i++) {
            if (formSummaries[i].hasUrlField) {
                hasUrlField = true;
                break;
            }
        }

        // Find the most likely comment form for signature
        var commentFormSummary = null;
        for (var j = 0; j < formSummaries.length; j++) {
            var fs = formSummaries[j];
            if (fs.action.includes('comment') || fs.action.includes('wp-comments-post')
                || fs.hasTextarea) {
                commentFormSummary = fs;
                break;
            }
        }

        return {
            hasCaptcha: captchaType !== null,
            captchaType: captchaType,
            requiresLogin: detectLoginRequired(doc),
            commentsClosed: detectCommentsClosed(doc),
            cms: cms,
            hasCommentForm: hasCommentForm,
            hasUrlField: hasUrlField,
            hasRichEditor: detectRichEditor(doc),
            formSignature: commentFormSummary ? buildFormSignature(commentFormSummary) : null
        };
    }

    // ── Core Verification ────────────────────────────────────────────────

    async function verifyPage() {
        await waitForDomReady();

        var doc = globalScope.document;
        var controller = globalScope.PageController;

        // Build simplified DOM via PageController
        var simplifiedDom = '';
        var elementCount = 0;
        if (controller && typeof controller.buildInteractiveElementTree === 'function') {
            try {
                var tree = controller.buildInteractiveElementTree();
                if (typeof tree === 'string') {
                    simplifiedDom = tree;
                    // Rough element count from tree output (count lines or tags)
                    elementCount = (tree.match(/<[^/][^>]*>/g) || []).length;
                } else if (tree && typeof tree === 'object') {
                    simplifiedDom = tree.html || tree.text || JSON.stringify(tree);
                    elementCount = tree.count || (tree.elements ? tree.elements.length : 0);
                }
            } catch (err) {
                console.warn('[PageVerifier] buildInteractiveElementTree failed:', err);
            }
        } else {
            console.warn('[PageVerifier] PageController not available, skipping interactive element tree.');
        }

        // Build form summary
        var formSummaries = buildFormSummary(doc);

        // Build quick signals
        var quickSignals = buildQuickSignals(doc, formSummaries);

        var result = {
            url: globalScope.location?.href || '',
            title: doc.title || '',
            simplifiedDom: simplifiedDom,
            elementCount: elementCount,
            formSummary: formSummaries,
            quickSignals: quickSignals
        };

        console.log('[PageVerifier] Verification complete:', result);

        try {
            chrome.runtime.sendMessage({
                action: 'pageVerificationResult',
                data: result
            });
        } catch (err) {
            console.warn('[PageVerifier] Failed to send verification result:', err);
        }

        return result;
    }

    // ── Message Listener ─────────────────────────────────────────────────

    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
        if (message && message.action === 'runPageVerification') {
            verifyPage().then(function (result) {
                sendResponse(result);
            }).catch(function (err) {
                console.error('[PageVerifier] Re-run verification failed:', err);
                sendResponse({ error: err.message });
            });
            return true; // keep channel open for async sendResponse
        }
    });

    // ── Public API ───────────────────────────────────────────────────────

    globalScope.PageVerifier = {
        verifyPage: verifyPage,
        buildFormSummary: buildFormSummary,
        detectCms: detectCms,
        detectCaptcha: detectCaptcha,
        detectLoginRequired: detectLoginRequired,
        detectCommentsClosed: detectCommentsClosed,
        buildQuickSignals: buildQuickSignals
    };

    // ── Auto-execute on injection ────────────────────────────────────────

    setTimeout(verifyPage, 800);

})(window);
