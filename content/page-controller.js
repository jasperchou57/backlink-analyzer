(function (globalScope) {
    if (globalScope.PageController) return;

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    function compactText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function truncate(value, max) {
        const str = compactText(value);
        return str.length > max ? str.slice(0, max) + '...' : str;
    }

    function escapeSelector(value) {
        if (globalScope.CSS?.escape) return globalScope.CSS.escape(value);
        return String(value || '').replace(/["\\]/g, '\\$&');
    }

    // ---------------------------------------------------------------------------
    // Visibility
    // ---------------------------------------------------------------------------

    function isVisible(el) {
        if (!(el instanceof HTMLElement)) return false;
        const style = globalScope.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        if (el.getAttribute('aria-hidden') === 'true') return false;
        if (el.closest('[hidden], template, .hidden, .sr-only, .screen-reader-text')) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    // ---------------------------------------------------------------------------
    // Interactive element detection
    // ---------------------------------------------------------------------------

    const INTERACTIVE_TAGS = new Set(['input', 'textarea', 'select', 'button']);
    const SKIP_INPUT_TYPES = new Set(['hidden']);

    function isInteractiveElement(el) {
        if (!(el instanceof HTMLElement)) return false;
        const tag = (el.tagName || '').toLowerCase();

        if (INTERACTIVE_TAGS.has(tag)) {
            if (tag === 'input' && SKIP_INPUT_TYPES.has((el.type || '').toLowerCase())) return false;
            return true;
        }
        if (tag === 'a' && el.hasAttribute('href')) return true;
        if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link' || el.getAttribute('role') === 'textbox') return true;
        if (el.getAttribute('contenteditable') === 'true') return true;
        return false;
    }

    // ---------------------------------------------------------------------------
    // Selector builder
    // ---------------------------------------------------------------------------

    function buildSelector(el) {
        if (!el || !el.tagName) return '';
        const tag = el.tagName.toLowerCase();

        if (el.id) return `#${escapeSelector(el.id)}`;

        const name = el.getAttribute('name');
        if (name) return `${tag}[name="${name.replace(/"/g, '\\"')}"]`;

        const classes = compactText(el.className || '').split(/\s+/).filter(Boolean).slice(0, 3);
        if (classes.length) return `${tag}.${classes.map(c => escapeSelector(c)).join('.')}`;

        const parent = el.parentElement;
        if (!parent) return tag;
        const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        if (siblings.length === 1) return tag;
        return `${tag}:nth-of-type(${siblings.indexOf(el) + 1})`;
    }

    // ---------------------------------------------------------------------------
    // Element descriptor (short text representation)
    // ---------------------------------------------------------------------------

    function getElementDescriptor(el) {
        const tag = (el.tagName || '').toLowerCase();
        const parts = [`<${tag}`];

        const attrs = ['type', 'name', 'id', 'placeholder', 'role', 'href', 'value', 'aria-label', 'contenteditable'];
        for (const attr of attrs) {
            const val = el.getAttribute(attr);
            if (val != null && val !== '') {
                let display = val;
                if (attr === 'href') display = truncate(val, 60);
                else display = truncate(val, 40);
                parts.push(`${attr}="${display}"`);
            }
        }

        parts.push('/>');
        let descriptor = parts.join(' ');

        // Add text content for buttons, links, options
        if (['button', 'a', 'option'].includes(tag) || el.getAttribute('role') === 'button') {
            const text = truncate(el.textContent, 50);
            if (text) descriptor = descriptor.replace('/>', `>${text}</${tag}>`);
        }

        return descriptor;
    }

    // ---------------------------------------------------------------------------
    // Element info extractor
    // ---------------------------------------------------------------------------

    function extractElementInfo(el, index) {
        const tag = (el.tagName || '').toLowerCase();
        const rect = el.getBoundingClientRect();
        const text = ['button', 'a', 'option'].includes(tag) || el.getAttribute('role') === 'button'
            ? truncate(el.textContent, 50)
            : '';

        return {
            index,
            tag,
            type: el.getAttribute('type') || '',
            name: el.getAttribute('name') || '',
            id: el.id || '',
            placeholder: el.getAttribute('placeholder') || '',
            text,
            role: el.getAttribute('role') || '',
            href: el.getAttribute('href') || '',
            isVisible: isVisible(el),
            rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
            },
            selector: buildSelector(el)
        };
    }

    // ---------------------------------------------------------------------------
    // Build interactive element tree
    // ---------------------------------------------------------------------------

    function buildInteractiveElementTree() {
        const elements = [];
        const lines = [];
        let index = 0;
        const elementMap = new Map(); // index -> DOM element

        function walk(node) {
            if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
            const tag = (node.tagName || '').toLowerCase();

            // Skip script/style/noscript/svg internals
            if (['script', 'style', 'noscript', 'link', 'meta'].includes(tag)) return;

            const isForm = tag === 'form';
            if (isForm) {
                const formDesc = compactText([
                    node.id ? `id="${node.id}"` : '',
                    node.getAttribute('action') ? `action="${truncate(node.getAttribute('action'), 60)}"` : '',
                    node.getAttribute('method') ? `method="${node.getAttribute('method')}"` : ''
                ].filter(Boolean).join(' '));
                lines.push(`--- FORM ${formDesc} ---`);
            }

            if (isInteractiveElement(node) && isVisible(node)) {
                const info = extractElementInfo(node, index);
                elements.push(info);
                elementMap.set(index, node);
                lines.push(`[${index}]${getElementDescriptor(node)}`);
                index++;
            }

            // Recurse into children (skip SVG internals)
            if (tag !== 'svg') {
                for (const child of node.children) {
                    walk(child);
                }
            }

            if (isForm) {
                lines.push('--- /FORM ---');
            }
        }

        walk(globalScope.document.body);

        // Build meta
        const allForms = Array.from(globalScope.document.querySelectorAll('form'));
        const commentSelectors = [
            '#respond', '#commentform', '.comment-respond', '.comments',
            'form[action*="comment"]', 'form[action*="wp-comments-post"]',
            '.comment-form', '#comments form', '.post-comments form',
            '.comment-respond form'
        ];
        const hasCommentForm = commentSelectors.some(sel => {
            try { return !!globalScope.document.querySelector(sel); } catch { return false; }
        });

        const loginSelectors = ['.must-log-in', '.login-required', '[class*="login-to-comment"]', 'form[action*="login"]', 'form[action*="signin"]'];
        const hasLoginForm = loginSelectors.some(sel => {
            try { return !!globalScope.document.querySelector(sel); } catch { return false; }
        });

        const captchaSelectors = [
            '.g-recaptcha', '.h-captcha', '[data-sitekey]',
            'iframe[src*="captcha"]', 'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]',
            '[name*="captcha" i]', '[id*="captcha" i]'
        ];
        const hasCaptcha = captchaSelectors.some(sel => {
            try { return !!globalScope.document.querySelector(sel); } catch { return false; }
        });

        return {
            elements,
            simplifiedDom: lines.join('\n'),
            meta: {
                url: globalScope.location.href,
                title: globalScope.document.title || '',
                formCount: allForms.length,
                hasCommentForm,
                hasLoginForm,
                hasCaptcha
            },
            _elementMap: elementMap
        };
    }

    // ---------------------------------------------------------------------------
    // Find all forms (with field summaries)
    // ---------------------------------------------------------------------------

    function findAllForms() {
        const forms = Array.from(globalScope.document.querySelectorAll('form'));
        return forms.map(form => {
            const fields = Array.from(form.querySelectorAll('input, textarea, select, button')).map(el => {
                const tag = (el.tagName || '').toLowerCase();
                return {
                    tag,
                    type: el.getAttribute('type') || '',
                    name: el.getAttribute('name') || '',
                    id: el.id || '',
                    placeholder: el.getAttribute('placeholder') || '',
                    isVisible: isVisible(el)
                };
            });

            return {
                id: form.id || '',
                action: form.getAttribute('action') || '',
                method: form.getAttribute('method') || '',
                className: compactText(form.className || ''),
                fieldCount: fields.length,
                fields,
                selector: buildSelector(form)
            };
        });
    }

    // ---------------------------------------------------------------------------
    // Find comment section
    // ---------------------------------------------------------------------------

    function findCommentSection() {
        const selectors = [
            '#respond',
            '#commentform',
            '.comment-respond',
            '.comments',
            '#comments',
            '.post-comments',
            'form[action*="comment"]',
            'form[action*="wp-comments-post"]',
            '.comment-form',
            '#comments form',
            '.comment-respond form',
            '#disqus_thread',
            '[class*="disqus"]',
            'iframe[src*="disqus.com"]',
            '#comment-editor',
            'iframe[src*="blogger.com/comment"]'
        ];

        for (const sel of selectors) {
            try {
                const el = globalScope.document.querySelector(sel);
                if (el && isVisible(el)) {
                    return {
                        element: el,
                        selector: sel,
                        type: /disqus/i.test(sel) ? 'disqus'
                            : /blogger/i.test(sel) ? 'blogger'
                            : /wp-comments-post|commentform|comment-respond/.test(sel) ? 'wordpress'
                            : 'generic'
                    };
                }
            } catch { /* invalid selector, skip */ }
        }

        return null;
    }

    // ---------------------------------------------------------------------------
    // Cached tree (rebuilt on demand)
    // ---------------------------------------------------------------------------

    let _cachedTree = null;
    let _cacheTimestamp = 0;
    const CACHE_TTL = 2000; // 2 seconds

    function getTree() {
        const now = Date.now();
        if (!_cachedTree || (now - _cacheTimestamp) > CACHE_TTL) {
            _cachedTree = buildInteractiveElementTree();
            _cacheTimestamp = now;
        }
        return _cachedTree;
    }

    function invalidateCache() {
        _cachedTree = null;
        _cacheTimestamp = 0;
    }

    function resolveElement(index) {
        const tree = getTree();
        return tree._elementMap.get(index) || null;
    }

    // ---------------------------------------------------------------------------
    // Click simulation (realistic event sequence)
    // ---------------------------------------------------------------------------

    function clickElement(index) {
        const el = resolveElement(index);
        if (!el) return { success: false, error: `Element at index ${index} not found` };

        try {
            const rect = el.getBoundingClientRect();
            const cx = rect.x + rect.width / 2;
            const cy = rect.y + rect.height / 2;

            const commonInit = {
                bubbles: true,
                cancelable: true,
                view: globalScope,
                clientX: cx,
                clientY: cy
            };

            el.dispatchEvent(new MouseEvent('mouseenter', { ...commonInit, bubbles: false }));
            el.dispatchEvent(new MouseEvent('mouseover', commonInit));
            el.dispatchEvent(new MouseEvent('mousedown', { ...commonInit, button: 0 }));

            if (typeof el.focus === 'function') {
                try { el.focus(); } catch { /* ignore */ }
            }

            el.dispatchEvent(new MouseEvent('mouseup', { ...commonInit, button: 0 }));
            el.dispatchEvent(new MouseEvent('click', { ...commonInit, button: 0 }));

            invalidateCache();
            return { success: true, index, selector: buildSelector(el) };
        } catch (err) {
            return { success: false, error: String(err.message || err) };
        }
    }

    // ---------------------------------------------------------------------------
    // Text input (native value setter for React compatibility)
    // ---------------------------------------------------------------------------

    function inputText(index, text) {
        const el = resolveElement(index);
        if (!el) return { success: false, error: `Element at index ${index} not found` };

        try {
            const tag = (el.tagName || '').toLowerCase();
            const value = String(text || '');

            // Focus first
            if (typeof el.focus === 'function') {
                try { el.focus(); } catch { /* ignore */ }
            }

            if (tag === 'textarea' || tag === 'input') {
                // Use native value setter to bypass React/Vue controlled components
                const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
                if (descriptor?.set) {
                    descriptor.set.call(el, value);
                } else {
                    el.value = value;
                }
            } else if (el.getAttribute('contenteditable') === 'true' || el.isContentEditable) {
                el.textContent = value;
            } else {
                el.value = value;
            }

            // Dispatch events in the order React/frameworks expect
            el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

            // Optional blur to trigger validation
            el.dispatchEvent(new Event('blur', { bubbles: true }));

            invalidateCache();
            return { success: true, index, value };
        } catch (err) {
            return { success: false, error: String(err.message || err) };
        }
    }

    // ---------------------------------------------------------------------------
    // Select option by text
    // ---------------------------------------------------------------------------

    function selectOption(index, optionText) {
        const el = resolveElement(index);
        if (!el) return { success: false, error: `Element at index ${index} not found` };

        const tag = (el.tagName || '').toLowerCase();
        if (tag !== 'select') return { success: false, error: 'Element is not a <select>' };

        try {
            const normalizedTarget = compactText(optionText).toLowerCase();
            const options = Array.from(el.options);
            const match = options.find(opt => compactText(opt.textContent).toLowerCase() === normalizedTarget)
                || options.find(opt => compactText(opt.textContent).toLowerCase().includes(normalizedTarget))
                || options.find(opt => opt.value.toLowerCase() === normalizedTarget);

            if (!match) {
                return {
                    success: false,
                    error: `Option "${optionText}" not found`,
                    availableOptions: options.map(o => compactText(o.textContent)).filter(Boolean)
                };
            }

            // Use native setter
            const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
            if (descriptor?.set) {
                descriptor.set.call(el, match.value);
            } else {
                el.value = match.value;
            }

            el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));

            invalidateCache();
            return { success: true, index, selectedValue: match.value, selectedText: compactText(match.textContent) };
        } catch (err) {
            return { success: false, error: String(err.message || err) };
        }
    }

    // ---------------------------------------------------------------------------
    // Scroll to element
    // ---------------------------------------------------------------------------

    function scrollToElement(index) {
        const el = resolveElement(index);
        if (!el) return { success: false, error: `Element at index ${index} not found` };

        try {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            invalidateCache();
            return { success: true, index };
        } catch (err) {
            return { success: false, error: String(err.message || err) };
        }
    }

    // ---------------------------------------------------------------------------
    // Action dispatcher
    // ---------------------------------------------------------------------------

    function executeAction(action) {
        if (!action || !action.type) {
            return { success: false, error: 'No action type provided' };
        }

        switch (action.type) {
            case 'click':
                return clickElement(action.index);

            case 'input':
                return inputText(action.index, action.text || '');

            case 'select':
                return selectOption(action.index, action.text || action.optionText || '');

            case 'scroll':
                return scrollToElement(action.index);

            case 'getBrowserState':
                return { success: true, state: getBrowserState() };

            case 'buildTree':
                invalidateCache();
                return { success: true, tree: getBrowserState() };

            case 'findCommentSection': {
                const section = findCommentSection();
                return { success: !!section, section };
            }

            case 'findAllForms': {
                const forms = findAllForms();
                return { success: true, forms };
            }

            default:
                return { success: false, error: `Unknown action type: ${action.type}` };
        }
    }

    // ---------------------------------------------------------------------------
    // getBrowserState
    // ---------------------------------------------------------------------------

    function getBrowserState() {
        invalidateCache();
        const tree = getTree();
        return {
            url: globalScope.location.href,
            title: globalScope.document.title || '',
            viewport: {
                width: globalScope.innerWidth,
                height: globalScope.innerHeight
            },
            scroll: {
                x: globalScope.scrollX,
                y: globalScope.scrollY,
                maxX: globalScope.document.documentElement.scrollWidth - globalScope.innerWidth,
                maxY: globalScope.document.documentElement.scrollHeight - globalScope.innerHeight
            },
            elements: tree.elements,
            simplifiedDom: tree.simplifiedDom,
            meta: tree.meta
        };
    }

    // ---------------------------------------------------------------------------
    // Message listener (chrome.runtime.onMessage)
    // ---------------------------------------------------------------------------

    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            if (message?.type !== 'PAGE_CONTROL') return false;

            try {
                const result = executeAction(message.action || message);
                sendResponse({ success: true, ...result });
            } catch (err) {
                sendResponse({ success: false, error: String(err.message || err) });
            }

            // Return true to indicate async response (even though we respond synchronously,
            // this prevents channel closing issues in some Chrome versions)
            return true;
        });
    }

    // ---------------------------------------------------------------------------
    // Expose public API
    // ---------------------------------------------------------------------------

    globalScope.PageController = {
        // Core
        buildInteractiveElementTree,
        getBrowserState,

        // Detection helpers
        isInteractiveElement,
        isVisible,
        getElementDescriptor,
        findAllForms,
        findCommentSection,

        // Actions
        clickElement,
        inputText,
        selectOption,
        scrollToElement,
        executeAction,

        // Internal (exposed for testing/debugging)
        _resolveElement: resolveElement,
        _invalidateCache: invalidateCache,
        _buildSelector: buildSelector
    };
})(typeof self !== 'undefined' ? self : window);
