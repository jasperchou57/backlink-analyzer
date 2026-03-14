(function (globalScope) {
    if (globalScope.CommentStandardFlow) return;

    const FORM_SELECTORS = [
        '#commentform',
        '#respond form',
        '.comment-form',
        'form[action*="wp-comments-post"]',
        '#comments form',
        '.comment-respond form'
    ];

    function compactText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
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

    function writeInputValue(el, value) {
        const nextValue = String(value || '');
        if (el instanceof HTMLInputElement) {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            if (descriptor?.set) descriptor.set.call(el, nextValue);
            else el.value = nextValue;
        } else if (el instanceof HTMLTextAreaElement) {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
            if (descriptor?.set) descriptor.set.call(el, nextValue);
            else el.value = nextValue;
        } else {
            el.value = nextValue;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function readInputValue(el) {
        if (!el) return '';
        return String(el.value || el.textContent || '');
    }

    function valueMatches(el, expectedValue) {
        return compactText(readInputValue(el)) === compactText(expectedValue || '');
    }

    function findFirstUsableField(form, selectors = []) {
        for (const selector of selectors) {
            const nodes = Array.from(form.querySelectorAll(selector));
            for (const node of nodes) {
                if (isVisible(node) && !node.disabled && !node.readOnly) {
                    return node;
                }
            }
        }
        return null;
    }

    function getClassicFormSignals(form) {
        const action = compactText(form.getAttribute?.('action') || '').toLowerCase();
        const idClass = compactText(`${form.id || ''} ${form.className || ''}`).toLowerCase();
        const text = compactText(form.textContent || '').toLowerCase();
        const commentField = findFirstUsableField(form, [
            'textarea#comment',
            'textarea[name="comment"]',
            'textarea[name*="comment" i]',
            'textarea[name="message"]',
            'textarea'
        ]);
        const nameField = findFirstUsableField(form, [
            'input#author',
            'input[name="author"]',
            'input[name="name"]',
            'input[name*="name" i]'
        ]);
        const emailField = findFirstUsableField(form, [
            'input#email',
            'input[name="email"]',
            'input[type="email"]',
            'input[name*="mail" i]'
        ]);
        const websiteField = findFirstUsableField(form, [
            'input#url',
            'input[name="url"]',
            'input[name="website"]',
            'input[type="url"]',
            'input[name*="site" i]',
            'input[name*="web" i]'
        ]);
        const submitField = findFirstUsableField(form, [
            'button[type="submit"]',
            'input[type="submit"]',
            'button#submit',
            'button[name="submit"]',
            '.submit button',
            '.submit input[type="submit"]',
            'button',
            'input[type="button"]'
        ]);
        const hasHiddenCommentPostId = !!form.querySelector('input[name="comment_post_ID"], input#comment_post_ID');

        return {
            action,
            idClass,
            text,
            commentField,
            nameField,
            emailField,
            websiteField,
            submitField,
            hasHiddenCommentPostId
        };
    }

    function scoreStandardCommentForm(form) {
        if (!form || !isVisible(form)) return -Infinity;
        const signals = getClassicFormSignals(form);
        if (!signals.commentField || !signals.submitField) {
            return -Infinity;
        }

        let score = 0;
        score += 100;
        if (/wp-comments-post|commentform|comment-form|comment-respond/.test(signals.action)) score += 80;
        if (/commentform|comment-form|comment-respond|comments-area|respond/.test(signals.idClass)) score += 60;
        if (signals.hasHiddenCommentPostId) score += 50;
        if (signals.nameField) score += 35;
        if (signals.emailField) score += 35;
        if (signals.websiteField) score += 18;
        if (/(leave a reply|leave a comment|commentaire|reactie|发表评论|发表回复|message)/.test(signals.text)) score += 35;
        if (signals.commentField.id === 'comment' || signals.commentField.name === 'comment') score += 55;
        if (signals.submitField.id === 'submit' || signals.submitField.name === 'submit') score += 18;
        if (form.querySelector('[contenteditable="true"], .ql-editor, .ProseMirror, .mce-content-body')) score -= 120;
        return score;
    }

    function isStandardCommentForm(form) {
        return scoreStandardCommentForm(form) >= 140;
    }

    function findStandardCommentForm() {
        const candidates = new Map();
        const addForm = (form, bonus = 0) => {
            if (!form || !(form instanceof HTMLFormElement)) return;
            const score = scoreStandardCommentForm(form);
            if (!Number.isFinite(score) || score === -Infinity) return;
            const previous = candidates.get(form) || -Infinity;
            candidates.set(form, Math.max(previous, score + bonus));
        };

        FORM_SELECTORS.forEach((selector) => {
            globalScope.document.querySelectorAll(selector).forEach((form) => addForm(form, 25));
        });
        globalScope.document.querySelectorAll('form').forEach((form) => addForm(form, 0));

        const ranked = Array.from(candidates.entries()).sort((left, right) => right[1] - left[1]);
        return ranked[0]?.[0] || null;
    }

    function buildFormSignature(form) {
        const signals = getClassicFormSignals(form);
        return compactText([
            form.id || '',
            form.className || '',
            form.getAttribute?.('action') || '',
            form.getAttribute?.('method') || '',
            signals.commentField ? 'comment-field' : '',
            signals.nameField ? 'name-field' : '',
            signals.emailField ? 'email-field' : '',
            signals.websiteField ? 'website-field' : ''
        ].join(' ')).toLowerCase();
    }

    function fillField(field, value) {
        if (!field || !compactText(value)) return false;
        writeInputValue(field, value);
        return valueMatches(field, value);
    }

    async function fillStandardCommentForm(form, values = {}) {
        const signals = getClassicFormSignals(form);
        const commentFilled = fillField(signals.commentField, values.comment);
        const nameFilled = fillField(signals.nameField, values.name);
        const emailFilled = fillField(signals.emailField, values.email);
        const websiteFilled = fillField(signals.websiteField, values.website);

        return {
            commentFilled,
            nameFilled,
            emailFilled,
            websiteFilled,
            commentSelector: describeElement(signals.commentField),
            nameSelector: describeElement(signals.nameField),
            emailSelector: describeElement(signals.emailField),
            websiteSelector: describeElement(signals.websiteField),
            formSignature: buildFormSignature(form)
        };
    }

    globalScope.CommentStandardFlow = {
        findStandardCommentForm,
        isStandardCommentForm,
        fillStandardCommentForm,
        buildFormSignature
    };
})(typeof self !== 'undefined' ? self : window);
