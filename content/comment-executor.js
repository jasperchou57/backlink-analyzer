(function (globalScope) {
    if (globalScope.CommentExecutor) return;

    const RULE_SELECTORS = [
        'textarea[name="comment"]',
        'textarea#comment',
        'textarea[name="message"]',
        'textarea[name*="comment" i]',
        'textarea[name*="message" i]',
        'textarea[name*="reply" i]',
        '[contenteditable="true"]',
        '.ql-editor',
        '.ProseMirror',
        '.mce-content-body',
        '[role="textbox"]',
        'textarea'
    ];

    const RICH_EDITOR_SIGNATURE = /ql-editor|prosemirror|mce-content-body|tox-edit-area|ck-editor|editor|contenteditable/i;
    const COMMENT_SIGNATURE = /comment|reply|message|body|content|discussion|leave|respond|post/i;
    const BAD_SIGNATURE = /captcha|security|spam|search|filter|author|name|email|mail|url|website|site|title|subject|hidden/i;
    const MIRROR_SIGNATURE = /clone|mirror|ghost|dummy|fake|template|toolbar|preview/i;

    function compactText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function normalizeComparableText(value) {
        return compactText(value)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase();
    }

    function stripHtml(value) {
        return compactText(String(value || '').replace(/<[^>]+>/g, ' '));
    }

    function escapeSelector(value) {
        if (globalScope.CSS?.escape) return globalScope.CSS.escape(value);
        return String(value || '').replace(/["\\]/g, '\\$&');
    }

    function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function isVisible(el) {
        if (!el) return false;
        const style = globalScope.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect?.();
        return !!rect && rect.width > 0 && rect.height > 0;
    }

    function isElementOwnedByForm(el, form) {
        if (!el || !form) return false;
        if (form.contains(el)) return true;
        if (el.form && el.form === form) return true;
        return el.closest?.('form') === form;
    }

    function isCommentFieldElement(el, form) {
        if (!el || !(el instanceof HTMLElement)) return false;
        if (!isElementOwnedByForm(el, form)) return false;
        if (!isVisible(el) || el.disabled || el.readOnly) return false;

        const tagName = (el.tagName || '').toLowerCase();
        if (tagName === 'textarea') return true;
        if (el.isContentEditable) return true;
        if (RICH_EDITOR_SIGNATURE.test(buildElementFingerprint(el))) return true;
        return tagName === 'div' && el.getAttribute('role') === 'textbox';
    }

    function buildElementFingerprint(el) {
        return compactText([
            el.tagName || '',
            el.id || '',
            el.getAttribute?.('name') || '',
            el.className || '',
            el.getAttribute?.('placeholder') || '',
            el.getAttribute?.('aria-label') || '',
            el.getAttribute?.('role') || '',
            el.getAttribute?.('data-placeholder') || ''
        ].join(' ')).toLowerCase();
    }

    function buildElementSelector(el) {
        if (!el) return '';
        if (el.id) {
            return `#${escapeSelector(el.id)}`;
        }

        const name = el.getAttribute?.('name');
        if (name) {
            return `${el.tagName.toLowerCase()}[name="${String(name).replace(/"/g, '\\"')}"]`;
        }

        const classes = String(el.className || '')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 3);
        if (classes.length > 0) {
            return `${el.tagName.toLowerCase()}.${classes.map((item) => escapeSelector(item)).join('.')}`;
        }

        const parent = el.parentElement;
        if (!parent) return el.tagName.toLowerCase();
        const siblings = Array.from(parent.children).filter((child) => child.tagName === el.tagName);
        const index = siblings.indexOf(el);
        return `${el.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
    }

    function getContextText(el, form) {
        const texts = [];
        const addText = (value) => {
            const normalized = compactText(value);
            if (normalized) texts.push(normalized);
        };

        if (el.id) {
            addText(form.querySelector(`label[for="${escapeSelector(el.id)}"]`)?.textContent || '');
        }
        addText(el.closest?.('label')?.textContent || '');
        addText(el.getAttribute?.('placeholder') || '');
        addText(el.getAttribute?.('aria-label') || '');
        addText(el.getAttribute?.('data-placeholder') || '');
        addText(el.previousElementSibling?.textContent || '');
        addText(el.nextElementSibling?.textContent || '');
        addText(el.parentElement?.textContent || '');
        addText(el.closest?.('p, div, td, th, li, fieldset')?.textContent || '');

        return compactText(texts.sort((left, right) => left.length - right.length)[0] || '').toLowerCase();
    }

    function getElementArea(el) {
        const rect = el.getBoundingClientRect?.();
        if (!rect) return 0;
        return Math.round(Math.max(0, rect.width) * Math.max(0, rect.height));
    }

    function getCommentEditorType(el) {
        if (!el) return '';
        if (el.tagName?.toLowerCase() === 'textarea') return 'textarea';
        if (el.isContentEditable) return 'contenteditable';
        if (RICH_EDITOR_SIGNATURE.test(buildElementFingerprint(el))) return 'rich-editor';
        return (el.tagName || '').toLowerCase();
    }

    function getFormSignature(form) {
        if (!form) return '';
        return compactText([
            form.id || '',
            form.className || '',
            form.getAttribute?.('action') || '',
            form.getAttribute?.('method') || '',
            form.querySelector?.('textarea[name="comment"], textarea#comment, [contenteditable="true"], .ql-editor, .ProseMirror') ? 'comment-field' : '',
            form.querySelector?.('input[name="url"], input#url, input[name="website"], input[type="url"]') ? 'website-field' : ''
        ].join(' ')).toLowerCase();
    }

    function scoreCommentFieldCandidate(el, form, options = {}) {
        const fingerprint = buildElementFingerprint(el);
        const contextText = getContextText(el, form);
        const area = getElementArea(el);
        const rect = el.getBoundingClientRect?.() || { width: 0, height: 0 };
        let score = 0;

        if (options.templateHint?.commentFieldSelector && buildElementSelector(el) === options.templateHint.commentFieldSelector) {
            score += 220;
        }
        if (options.templateHint?.commentFieldFingerprint && fingerprint.includes(options.templateHint.commentFieldFingerprint.toLowerCase())) {
            score += 180;
        }
        if (options.aiSelector && buildElementSelector(el) === options.aiSelector) {
            score += 160;
        }

        score += 100;
        if (el.tagName?.toLowerCase() === 'textarea') score += 40;
        if (el.isContentEditable) score += 60;
        if (RICH_EDITOR_SIGNATURE.test(fingerprint)) score += 45;
        if (COMMENT_SIGNATURE.test(fingerprint)) score += 75;
        if (COMMENT_SIGNATURE.test(contextText)) score += 45;
        if ((el.getAttribute?.('name') || '').toLowerCase() === 'comment') score += 120;
        if ((el.id || '').toLowerCase() === 'comment') score += 120;
        if (el.required) score += 12;

        if (area >= 50000) score += 35;
        else if (area >= 15000) score += 22;
        else if (area >= 4000) score += 10;
        else score -= 45;

        if (rect.height >= 120) score += 25;
        else if (rect.height >= 70) score += 12;
        else if (rect.height <= 36) score -= 20;

        if (Number(el.getAttribute?.('rows') || 0) >= 4) score += 10;

        if (BAD_SIGNATURE.test(fingerprint)) score -= 120;
        if (BAD_SIGNATURE.test(contextText)) score -= 80;
        if (MIRROR_SIGNATURE.test(fingerprint)) score -= 70;
        if (el.closest?.('[hidden], template, .hidden, .sr-only, .screen-reader-text')) score -= 120;
        if (el.getAttribute?.('aria-hidden') === 'true') score -= 120;

        if (
            el.tagName?.toLowerCase() === 'textarea'
            && form.querySelector('[contenteditable="true"], .ql-editor, .ProseMirror, .mce-content-body')
            && !COMMENT_SIGNATURE.test(fingerprint)
        ) {
            score -= 35;
        }

        return score;
    }

    function queryScopedSelector(form, selector) {
        if (!selector) return [];
        try {
            return [
                form.querySelector(selector),
                globalScope.document.querySelector(selector)
            ].filter(Boolean);
        } catch {
            return [];
        }
    }

    function collectCommentFieldCandidates(form, options = {}) {
        const seen = new Set();
        const candidates = [];
        const addCandidate = (el, source = '') => {
            if (!el || seen.has(el) || !isCommentFieldElement(el, form)) return;
            seen.add(el);
            const selector = buildElementSelector(el);
            candidates.push({
                element: el,
                source,
                selector,
                fingerprint: buildElementFingerprint(el),
                editorType: getCommentEditorType(el),
                formSignature: getFormSignature(form),
                score: scoreCommentFieldCandidate(el, form, {
                    templateHint: options.templateHint || null,
                    aiSelector: options.aiSelector || ''
                })
            });
        };

        const aiCommentField = (options.aiFormInfo?.fields || []).find((field) => field.type === 'comment' && field.selector);
        const aiSelector = aiCommentField?.selector || '';

        if (options.templateHint?.commentFieldSelector) {
            queryScopedSelector(form, options.templateHint.commentFieldSelector).forEach((el) => addCandidate(el, 'template'));
        }

        if (aiSelector) {
            queryScopedSelector(form, aiSelector).forEach((el) => addCandidate(el, 'ai'));
        }

        RULE_SELECTORS.forEach((selector) => {
            form.querySelectorAll(selector).forEach((el) => addCandidate(el, 'rule'));
        });

        form.querySelectorAll('textarea, [contenteditable="true"], .ql-editor, .ProseMirror, .mce-content-body, [role="textbox"]')
            .forEach((el) => addCandidate(el, 'scan'));

        return candidates
            .sort((left, right) => right.score - left.score)
            .map((candidate, index) => ({ ...candidate, index }));
    }

    function dispatchInputEvents(el) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function focusElement(el) {
        try {
            el.focus?.();
        } catch {}
    }

    function blurElement(el) {
        try {
            el.blur?.();
        } catch {}
    }

    function writeCommentValue(el, value, options = {}) {
        const nextValue = String(value || '');
        if (el.tagName?.toLowerCase() === 'textarea') {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
            if (descriptor?.set) {
                descriptor.set.call(el, nextValue);
            } else {
                el.value = nextValue;
            }
        } else if (el.isContentEditable || RICH_EDITOR_SIGNATURE.test(buildElementFingerprint(el))) {
            if (options.preferHtmlWrite) {
                el.innerHTML = nextValue;
            } else {
                el.textContent = nextValue;
            }
        } else {
            el.textContent = nextValue;
        }
        dispatchInputEvents(el);
    }

    function readCommentValue(el, options = {}) {
        if (!el) return '';
        if (el.tagName?.toLowerCase() === 'textarea') {
            return String(el.value || '');
        }
        if (options.preferHtmlRead && (el.isContentEditable || RICH_EDITOR_SIGNATURE.test(buildElementFingerprint(el)))) {
            return String(el.innerHTML || '');
        }
        return String(el.textContent || '');
    }

    async function simulateTyping(el, value, options = {}) {
        const nextValue = String(value || '');
        if (!nextValue) return;

        focusElement(el);
        writeCommentValue(el, '', { preferHtmlWrite: false });

        const minDelay = Number(options.minDelay || 8);
        const maxDelay = Math.max(minDelay, Number(options.maxDelay || 18));
        for (const char of nextValue) {
            el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: char }));
            if (el.tagName?.toLowerCase() === 'textarea') {
                writeCommentValue(el, `${readCommentValue(el)}${char}`, { preferHtmlWrite: false });
            } else {
                el.textContent = `${readCommentValue(el)}${char}`;
                dispatchInputEvents(el);
            }
            el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: char }));
            await wait(Math.floor(minDelay + Math.random() * (maxDelay - minDelay + 1)));
        }
    }

    function valueLooksVerified(el, expectedValue, options = {}) {
        const expectedText = normalizeComparableText(stripHtml(expectedValue));
        const hasAnchorHtml = /<a\b[^>]*href\s*=/i.test(String(expectedValue || ''));
        const actualText = normalizeComparableText(readCommentValue(el, { preferHtmlRead: false }));

        if (actualText && actualText === expectedText) {
            return true;
        }

        if (hasAnchorHtml) {
            const actualHtml = String(readCommentValue(el, { preferHtmlRead: true }) || '');
            const hrefMatch = String(expectedValue || '').match(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/i);
            const targetHref = compactText(hrefMatch?.[1] || '').toLowerCase();
            if (targetHref && actualHtml.toLowerCase().includes(targetHref)) {
                return true;
            }
        }

        return false;
    }

    function resolveStrategy(candidate, comment, execution = {}) {
        const wantsTyping = execution?.preferHumanTypingForComment !== false;
        const hasAnchorHtml = /<a\b[^>]*href\s*=/i.test(String(comment || ''));
        if (candidate.editorType !== 'textarea') {
            return hasAnchorHtml ? 'direct' : (wantsTyping ? 'typing' : 'direct');
        }
        return wantsTyping ? 'typing' : 'direct';
    }

    function buildResult(candidate, strategy, verified, candidateCount) {
        return {
            filled: !!verified,
            verified: !!verified,
            element: candidate.element,
            selector: candidate.selector || '',
            fingerprint: candidate.fingerprint || '',
            editorType: candidate.editorType || '',
            strategy: strategy || '',
            candidateCount: Number(candidateCount || 0),
            formSignature: candidate.formSignature || ''
        };
    }

    async function applyCommentToCandidate(candidate, comment, options = {}) {
        const strategy = resolveStrategy(candidate, comment, options.execution || {});
        const hasAnchorHtml = /<a\b[^>]*href\s*=/i.test(String(comment || ''));
        const strategyOrder = strategy === 'typing' ? ['typing', 'direct'] : ['direct', 'typing'];

        for (const mode of strategyOrder) {
            if (mode === 'typing' && candidate.editorType !== 'textarea' && hasAnchorHtml) {
                continue;
            }

            focusElement(candidate.element);
            if (mode === 'typing') {
                await simulateTyping(candidate.element, comment, options);
            } else {
                writeCommentValue(candidate.element, comment, {
                    preferHtmlWrite: hasAnchorHtml && candidate.editorType !== 'textarea'
                });
            }

            if (valueLooksVerified(candidate.element, comment, options)) {
                blurElement(candidate.element);
                return buildResult(candidate, mode, true, options.candidateCount);
            }
        }

        blurElement(candidate.element);
        return buildResult(candidate, strategy, false, options.candidateCount);
    }

    async function fillCommentField(form, comment, options = {}) {
        const expected = compactText(comment);
        if (!form || !expected) return { filled: false };

        const candidates = collectCommentFieldCandidates(form, options);
        for (const candidate of candidates) {
            const result = await applyCommentToCandidate(candidate, comment, {
                ...options,
                candidateCount: candidates.length
            });
            if (result.filled) {
                return result;
            }
        }

        return {
            filled: false,
            verified: false,
            candidateCount: candidates.length,
            formSignature: getFormSignature(form)
        };
    }

    async function ensureCommentFieldValue(form, comment, options = {}) {
        const expected = compactText(comment);
        if (!form || !expected) return { filled: false };

        const previous = options.previousResolution || null;
        if (previous?.element && globalScope.document.contains(previous.element)) {
            if (valueLooksVerified(previous.element, comment, options)) {
                return {
                    ...previous,
                    filled: true,
                    verified: true,
                    candidateCount: previous.candidateCount || 1,
                    formSignature: previous.formSignature || getFormSignature(form)
                };
            }

            const reapplyResult = await applyCommentToCandidate({
                element: previous.element,
                selector: previous.selector || buildElementSelector(previous.element),
                fingerprint: previous.fingerprint || buildElementFingerprint(previous.element),
                editorType: previous.editorType || getCommentEditorType(previous.element),
                formSignature: previous.formSignature || getFormSignature(form),
                score: 999
            }, comment, {
                ...options,
                candidateCount: previous.candidateCount || 1
            });
            if (reapplyResult.filled) {
                return reapplyResult;
            }
        }

        return await fillCommentField(form, comment, options);
    }

    globalScope.CommentExecutor = {
        fillCommentField,
        ensureCommentFieldValue
    };
})(typeof self !== 'undefined' ? self : window);
