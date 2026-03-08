/**
 * Comment Publisher V3 - AI 驱动
 * 智能表单识别 + 验证码处理 + AI 评论生成
 */

(function () {
    if (window.__commentPublisherLoaded) return;
    window.__commentPublisherLoaded = true;

    let currentResourceId = null;
    let currentTaskId = null;
    let currentDebugMode = false;
    let currentDebugInfo = null;
    let publishStopped = false;
    let autoSubmitTimer = null;
    let currentPublishMeta = null;

    const NUMBER_WORDS = {
        zero: 0,
        one: 1,
        two: 2,
        three: 3,
        four: 4,
        five: 5,
        six: 6,
        seven: 7,
        eight: 8,
        nine: 9,
        ten: 10,
        eleven: 11,
        twelve: 12,
        thirteen: 13,
        fourteen: 14,
        fifteen: 15,
        sixteen: 16,
        seventeen: 17,
        eighteen: 18,
        nineteen: 19,
        twenty: 20
    };

    const LOCAL_DEFAULT_WORKFLOW = {
        id: 'blog-comment-backlink',
        name: 'Blog Comment Backlink',
        steps: [
            { id: 'find_form', action: 'findForm', useAI: true },
            { id: 'generate_comment', action: 'generateComment', useAI: true },
            { id: 'fill_primary_fields', action: 'fillFields', fields: ['comment', 'name', 'email', 'website'] },
            { id: 'solve_captcha', action: 'solveCaptcha' },
            { id: 'check_antispam', action: 'checkAntiSpam' },
            { id: 'clear_notifications', action: 'uncheckNotifications' },
            { id: 'finalize', action: 'reviewOrSubmit' }
        ]
    };

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.action === 'fillComment') {
            fillCommentForm(msg.data);
        }
        if (msg.action === 'stopPublishSession') {
            cancelCurrentPublish();
        }
    });

    async function fillCommentForm(data) {
        currentResourceId = data.resourceId;
        currentTaskId = data.taskId;
        currentDebugMode = !!data.debugMode;
        currentDebugInfo = { mode: data.mode || 'semi-auto', actions: [] };
        publishStopped = false;
        clearAutoSubmitTimer();
        currentPublishMeta = {
            commentStyle: data.commentStyle || 'standard',
            anchorRequested: data.commentStyle === 'anchor-html',
            anchorInjected: false,
            anchorText: '',
            anchorUrl: '',
            commentPreview: '',
            retryWithoutWebsite: !!data.retryWithoutWebsite,
            websiteOmitted: !data.website
        };

        removeDebugArtifacts();

        const workflow = resolveWorkflow(data.workflow);
        const context = {
            workflow,
            data,
            mode: data.mode || 'semi-auto',
            useAI: data.useAI !== false,
            pageTitle: data.pageTitle || document.title,
            resource: data.resource || {},
            values: {
                name: data.name || '',
                email: data.email || '',
                website: data.website || ''
            },
            aiFormInfo: null,
            form: null,
            comment: '',
            anchorOptions: {
                mode: data.commentStyle || 'standard',
                anchorText: data.anchorKeyword || '',
                anchorUrl: data.anchorUrl || data.website || '',
                allowAnchorHtml: false
            }
        };

        addDebugEvent('field', `Workflow: ${workflow.name || workflow.id}`);
        addDebugEvent('field', `Publish mode: ${context.mode}${currentDebugMode ? ' (debug pause enabled)' : ''}`);

        try {
            await executeWorkflow(context);
        } catch (e) {
            console.log('[BLA] 工作流执行失败:', e);
            addDebugEvent('field', `Workflow failed: ${e.message}`);
            reportResult('failed');
        }
    }

    async function executeWorkflow(context) {
        const steps = Array.isArray(context.workflow?.steps) ? context.workflow.steps : [];
        for (const step of steps) {
            if (publishStopped) return;
            await executeWorkflowStep(step, context);
        }
    }

    async function executeWorkflowStep(step, context) {
        if (publishStopped) return;

        switch (step.action) {
            case 'findForm':
                await executeFindFormStep(step, context);
                break;
            case 'generateComment':
                await executeGenerateCommentStep(step, context);
                break;
            case 'fillFields':
                executeFillFieldsStep(step, context);
                break;
            case 'solveCaptcha':
                executeSolveCaptchaStep(context);
                break;
            case 'checkAntiSpam':
                executeAntiSpamStep(context);
                break;
            case 'uncheckNotifications':
                executeUncheckNotificationsStep(context);
                break;
            case 'reviewOrSubmit':
                executeFinalizeStep(context);
                break;
            default:
                addDebugEvent('field', `Skipped unknown workflow step: ${step.action}`);
        }
    }

    async function executeFindFormStep(step, context) {
        if (context.useAI && step.useAI !== false) {
            try {
                const formAreaHtml = getCommentAreaHtml();
                if (formAreaHtml) {
                    context.aiFormInfo = await chrome.runtime.sendMessage({
                        action: 'aiExtractForm',
                        html: formAreaHtml
                    });
                    if (context.aiFormInfo?.hasForm) {
                        addDebugEvent('field', `AI detected form selector: ${context.aiFormInfo.formSelector || 'unknown'}`);
                    }
                }
            } catch (e) {
                console.log('[BLA] AI 表单识别失败，回退到规则匹配:', e);
            }
        }

        if (context.aiFormInfo?.hasForm && context.aiFormInfo.formSelector) {
            context.form = document.querySelector(context.aiFormInfo.formSelector);
        }
        if (!context.form) {
            context.form = findFormByRules();
        }

        if (!context.form) {
            addDebugEvent('field', 'Comment form not found');
            throw new Error('Comment form not found');
        }

        context.form.style.outline = '2px dashed #3ecfff';
        context.form.style.outlineOffset = '8px';
        context.form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        markDebugElement(context.form, 'form');
    }

    async function executeGenerateCommentStep(step, context) {
        context.anchorOptions = resolveAnchorOptions(context);
        if (context.useAI && step.useAI !== false) {
            try {
                const pageContent = getPageContent();
                const result = await chrome.runtime.sendMessage({
                    action: 'aiGenerateComment',
                    pageTitle: context.pageTitle,
                    pageContent,
                    targetUrl: context.anchorOptions.anchorUrl || context.values.website,
                    options: context.anchorOptions
                });
                context.comment = result.comment || '';
            } catch (e) {
                console.log('[BLA] AI 评论生成失败:', e);
            }
        }

        if (!context.comment) {
            context.comment = generateFallbackComment(context.pageTitle, context.anchorOptions);
        }

        context.comment = ensureAnchorComment(context.comment, context.anchorOptions);
        currentPublishMeta = {
            ...(currentPublishMeta || {}),
            commentStyle: context.anchorOptions.mode,
            anchorRequested: context.anchorOptions.mode === 'anchor-html',
            anchorInjected: /<a\b[^>]*href\s*=/i.test(context.comment),
            anchorText: context.anchorOptions.anchorText || '',
            anchorUrl: context.anchorOptions.anchorUrl || '',
            commentPreview: truncateText(compactText(context.comment || ''), 180)
        };

        if (context.anchorOptions.allowAnchorHtml) {
            addDebugEvent('field', `Anchor mode enabled: ${context.anchorOptions.anchorText} -> ${context.anchorOptions.anchorUrl}`);
        } else if (context.anchorOptions.mode === 'anchor-html') {
            addDebugEvent('field', 'Anchor mode requested but current page was not judged as HTML-link-safe');
        }
    }

    function executeFillFieldsStep(step, context) {
        const values = {
            comment: context.comment,
            name: context.values.name,
            email: context.values.email,
            website: context.values.website
        };
        const allowedFields = Array.isArray(step.fields) && step.fields.length > 0
            ? step.fields
            : ['comment', 'name', 'email', 'website'];

        if (context.aiFormInfo?.fields?.length) {
            fillFieldsFromAI(context.form, context.aiFormInfo, values, allowedFields);
        } else {
            fillFieldsByRules(context.form, values, allowedFields);
        }
    }

    function executeSolveCaptchaStep(context) {
        const aiHandledCount = applyAiSpecialFields(context.form, context.aiFormInfo, 'captcha');
        if (aiHandledCount === 0) {
            solveCaptchaByRules(context.form);
        }
    }

    function executeAntiSpamStep(context) {
        const aiHandledCount = applyAiSpecialFields(context.form, context.aiFormInfo, 'checkbox');
        if (aiHandledCount === 0) {
            checkAntiSpamBoxes(context.form);
        }
    }

    function executeUncheckNotificationsStep(context) {
        const uncheckedCount = uncheckNotifications(context.form);
        if (uncheckedCount > 0) {
            addDebugEvent('checkbox', `Unchecked ${uncheckedCount} notification checkbox${uncheckedCount > 1 ? 'es' : ''}`);
        }
    }

    function executeFinalizeStep(context) {
        if (publishStopped) return;

        if (context.mode === 'full-auto' && !currentDebugMode) {
            autoSubmitTimer = setTimeout(() => {
                autoSubmitTimer = null;
                if (!publishStopped) {
                    submitForm(context.form);
                }
            }, 1500);
        } else {
            showCommentReadyDialog(context.form);
        }
    }

    // === 表单查找（规则） ===
    function findFormByRules() {
        const selectors = [
            '#commentform', '#respond form', '.comment-form',
            'form[action*="wp-comments-post"]', 'form.comment-form',
            '#comments form', '.post-comments form'
        ];
        for (const sel of selectors) {
            const form = document.querySelector(sel);
            if (form) return form;
        }
        // 通用：通过 textarea 反推 form
        const textareas = document.querySelectorAll('textarea');
        for (const ta of textareas) {
            const nameAttr = (ta.name || ta.id || '').toLowerCase();
            const placeholder = (ta.placeholder || '').toLowerCase();
            if (nameAttr.includes('comment') || nameAttr.includes('message') ||
                placeholder.includes('comment') || placeholder.includes('leave') ||
                placeholder.includes('reply')) {
                const form = ta.closest('form');
                if (form) return form;
            }
        }
        return null;
    }

    // === AI 字段填充 ===
    function fillFieldsFromAI(form, aiFormInfo, values, allowedFields) {
        const allowed = new Set(allowedFields || ['comment', 'name', 'email', 'website']);
        for (const field of aiFormInfo.fields) {
            try {
                if (!allowed.has(field.type)) continue;

                let el = null;
                if (field.selector) {
                    el = form.querySelector(field.selector) || document.querySelector(field.selector);
                }

                if (!el) continue;

                switch (field.type) {
                    case 'comment':
                        setFieldValue(el, values.comment);
                        recordFilledField(el, 'comment', values.comment);
                        break;
                    case 'name':
                        if (values.name) {
                            setFieldValue(el, values.name);
                            recordFilledField(el, 'name', values.name);
                        }
                        break;
                    case 'email':
                        if (values.email) {
                            setFieldValue(el, values.email);
                            recordFilledField(el, 'email', values.email);
                        }
                        break;
                    case 'website':
                        if (values.website) {
                            setFieldValue(el, values.website);
                            recordFilledField(el, 'website', values.website);
                        }
                        break;
                }
            } catch (e) {
                console.log(`[BLA] 填充字段失败 (${field.type}):`, e);
            }
        }
    }

    // === 规则字段填充 ===
    function fillFieldsByRules(form, values, allowedFields) {
        const allowed = new Set(allowedFields || ['comment', 'name', 'email', 'website']);

        // Comment
        if (allowed.has('comment')) {
            const commentField = form.querySelector(
                'textarea[name="comment"], textarea#comment, textarea[name="message"], textarea'
            );
            if (commentField) {
                setFieldValue(commentField, values.comment);
                recordFilledField(commentField, 'comment', values.comment);
            }
        }

        // Name
        if (allowed.has('name')) {
            const nameField = form.querySelector(
                'input[name="author"], input#author, input[name="name"], input[placeholder*="name" i], input[placeholder*="名" i]'
            );
            if (nameField && values.name) {
                setFieldValue(nameField, values.name);
                recordFilledField(nameField, 'name', values.name);
            }
        }

        // Email
        if (allowed.has('email')) {
            const emailField = form.querySelector(
                'input[name="email"], input#email, input[type="email"]'
            );
            if (emailField && values.email) {
                setFieldValue(emailField, values.email);
                recordFilledField(emailField, 'email', values.email);
            }
        }

        // Website
        if (allowed.has('website')) {
            const websiteField = form.querySelector(
                'input[name="url"], input#url, input[name="website"], input[type="url"]'
            );
            if (websiteField && values.website) {
                setFieldValue(websiteField, values.website);
                recordFilledField(websiteField, 'website', values.website);
            }
        }
    }

    // === 取消通知勾选 ===
    function uncheckNotifications(form) {
        const notifySelectors = [
            'input[name="subscribe"]', 'input[name="subscribe_comments"]',
            'input[name="subscribe_blog"]', 'input[id*="subscribe"]',
            'input[id*="notify"]', 'input[name*="notify"]',
            'input[id*="follow"]', 'input[name*="follow"]',
            '#jetpack-subscribe-comment', '#jetpack-subscribe-blog',
            '.comment-form-subscribe input[type="checkbox"]',
            '#wp-comment-cookies-consent'
        ];
        let uncheckedCount = 0;
        for (const sel of notifySelectors) {
            document.querySelectorAll(sel).forEach(cb => {
                if (cb.checked) {
                    uncheckedCount++;
                    setCheckboxValue(cb, false);
                }
            });
        }

        const allCheckboxes = form.querySelectorAll('input[type="checkbox"]');
        allCheckboxes.forEach((checkbox) => {
            const contextText = getInputContextText(checkbox, form).toLowerCase();
            if (!contextText || !isNotificationCheckbox(contextText)) return;
            if (checkbox.checked) {
                uncheckedCount++;
                setCheckboxValue(checkbox, false);
            }
        });

        return uncheckedCount;
    }

    // === 工具函数 ===
    function setFieldValue(el, value) {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setCheckboxValue(el, checked) {
        el.checked = checked;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function getCommentAreaHtml() {
        const selectors = [
            '#respond', '#commentform', '.comment-form', '#comments',
            'form[action*="wp-comments-post"]', '.comment-respond'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) return el.outerHTML.substring(0, 4000);
        }
        // 回退：找包含 textarea 的 form
        const form = findFormByRules();
        if (form) return form.outerHTML.substring(0, 4000);
        return '';
    }

    function getPageContent() {
        // 提取文章正文（限制长度）
        const selectors = [
            'article', '.post-content', '.entry-content',
            '.article-content', 'main', '.content'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) return el.textContent.substring(0, 2000);
        }
        return document.body?.textContent?.substring(0, 2000) || '';
    }

    function generateFallbackComment(title, anchorOptions = {}) {
        if (anchorOptions.allowAnchorHtml && anchorOptions.anchorText && anchorOptions.anchorUrl) {
            const anchorTag = `<a href="${anchorOptions.anchorUrl}">${anchorOptions.anchorText}</a>`;
            const templates = [
                `This was a thoughtful article about ${title || 'this topic'}. I also found ${anchorTag} useful for readers exploring the same area.`,
                `Thanks for sharing such a clear breakdown of ${title || 'the topic'}. For anyone comparing perspectives, ${anchorTag} is another helpful reference.`,
                `I enjoyed this post and the practical angle you took. ${anchorTag} adds another useful viewpoint for people digging deeper into this subject.`
            ];
            return templates[Math.floor(Math.random() * templates.length)];
        }

        const templates = [
            `This is a really insightful article about ${title || 'this topic'}. I appreciate the detailed analysis and practical approach.`,
            `Thanks for sharing this comprehensive post. The examples make it much easier to understand the key concepts.`,
            `Really well explained! I've been looking for clear information on this topic and this article delivers exactly that.`,
            `Great breakdown of ${title || 'the topic'}. I found the practical insights particularly helpful for my own projects.`,
            `This clarifies a lot of things I was uncertain about. Looking forward to reading more content like this.`
        ];
        return templates[Math.floor(Math.random() * templates.length)];
    }

    // === 弹窗 ===
    function showCommentReadyDialog(form) {
        removeDialog();

        const overlay = document.createElement('div');
        overlay.id = 'bla-dialog-overlay';

        const message = currentDebugMode
            ? 'The form has been filled and auto-submit is paused because debug mode is enabled. Review the captcha or anti-spam handling, then click Submit or Skip.'
            : 'The comment form has been filled. Please review the content and click Submit to post, or Skip to move to the next resource.';

        const dialog = document.createElement('div');
        dialog.id = 'bla-dialog';
        dialog.innerHTML = `
            <h3 class="bla-dialog-title">Comment Ready</h3>
            <p class="bla-dialog-message">
                ${escapeHtml(message)}
            </p>
            ${buildDebugSummaryHtml()}
            <div class="bla-dialog-actions">
                <button id="bla-skip" class="bla-btn bla-btn-skip">Skip</button>
                <button id="bla-submit" class="bla-btn bla-btn-submit">Submit</button>
            </div>
        `;

        document.body.appendChild(overlay);
        document.body.appendChild(dialog);

        requestAnimationFrame(() => {
            overlay.classList.add('bla-show');
            dialog.classList.add('bla-show');
        });

        dialog.querySelector('#bla-submit').addEventListener('click', () => {
            if (publishStopped) return;
            addDebugEvent('field', 'User confirmed submit');
            removeDialog();
            submitForm(form);
        });

        dialog.querySelector('#bla-skip').addEventListener('click', () => {
            if (publishStopped) return;
            addDebugEvent('field', 'User skipped this resource');
            removeDialog();
            form.style.outline = 'none';
            reportResult('skipped');
        });
    }

    function submitForm(form) {
        if (publishStopped) return;

        const submitBtn = form.querySelector(
            'button[type="submit"], input[type="submit"], button#submit, .submit, button[name="submit"]'
        );

        addDebugEvent('field', 'Submitting form');
        chrome.runtime.sendMessage({
            action: 'commentSubmitting',
            resourceId: currentResourceId,
            taskId: currentTaskId,
            meta: currentPublishMeta || {}
        }).catch(() => {});

        if (submitBtn) {
            submitBtn.click();
        } else {
            form.submit();
        }

        setTimeout(() => reportResult('submitted', { reportedVia: 'timeout-fallback' }), 8000);
    }

    function reportResult(result, extraMeta = {}) {
        chrome.runtime.sendMessage({
            action: 'commentAction',
            resourceId: currentResourceId,
            taskId: currentTaskId,
            result,
            meta: { ...(currentPublishMeta || {}), ...(extraMeta || {}) }
        });
    }

    function removeDialog() {
        const overlay = document.getElementById('bla-dialog-overlay');
        const dialog = document.getElementById('bla-dialog');
        if (overlay) overlay.remove();
        if (dialog) dialog.remove();
    }

    function cancelCurrentPublish() {
        publishStopped = true;
        clearAutoSubmitTimer();
        addDebugEvent('field', 'Publish session stopped by user');
        removeDialog();
    }

    function clearAutoSubmitTimer() {
        if (autoSubmitTimer) {
            clearTimeout(autoSubmitTimer);
            autoSubmitTimer = null;
        }
    }

    function resolveWorkflow(workflow) {
        if (workflow?.steps?.length) {
            return cloneValue(workflow);
        }
        return cloneValue(LOCAL_DEFAULT_WORKFLOW);
    }

    function removeDebugArtifacts() {
        clearAutoSubmitTimer();
        removeDialog();
        document.querySelectorAll('.bla-debug-target').forEach((el) => {
            el.classList.remove('bla-debug-target', 'bla-debug-form', 'bla-debug-field', 'bla-debug-captcha', 'bla-debug-checkbox');
        });
    }

    function resolveAnchorOptions(context) {
        const mode = context.data.commentStyle || 'standard';
        const anchorText = deriveAnchorText(context.data.anchorKeyword || '', context.data.anchorUrl || context.values.website || '');
        const anchorUrl = compactText(context.data.anchorUrl || context.values.website || '');
        const allowAnchorHtml = mode === 'anchor-html'
            && !!anchorText
            && !!anchorUrl
            && pageAllowsHtmlLinks(context.form, context.resource, context.aiFormInfo);

        return {
            mode,
            anchorText,
            anchorUrl,
            allowAnchorHtml
        };
    }

    function deriveAnchorText(preferredText, anchorUrl) {
        const preferred = compactText(preferredText || '');
        if (preferred) return preferred;

        try {
            const parsed = new URL(anchorUrl);
            const host = parsed.hostname.replace(/^www\./i, '');
            const primaryLabel = host.split('.').find(Boolean) || '';
            const normalized = primaryLabel
                .replace(/[-_]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            return normalized
                ? normalized.replace(/\b\w/g, (char) => char.toUpperCase())
                : '';
        } catch {
            return '';
        }
    }

    function ensureAnchorComment(comment, anchorOptions) {
        const baseComment = compactText(comment || '');
        if (!anchorOptions.allowAnchorHtml || !anchorOptions.anchorText || !anchorOptions.anchorUrl) {
            return baseComment;
        }

        const anchorTag = `<a href="${escapeHtml(anchorOptions.anchorUrl)}">${escapeHtml(anchorOptions.anchorText)}</a>`;
        if (/<a\b[^>]*href\s*=/i.test(baseComment)) {
            return baseComment.replace(
                /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/i,
                anchorTag
            );
        }

        const variants = buildAnchorUrlVariants(anchorOptions.anchorUrl);
        for (const variant of variants) {
            const replaced = replaceFirstCaseInsensitive(baseComment, variant, anchorTag);
            if (replaced !== baseComment) {
                return replaced;
            }
        }

        const replacedAnchorText = replaceFirstCaseInsensitive(baseComment, anchorOptions.anchorText, anchorTag);
        if (replacedAnchorText !== baseComment) {
            return replacedAnchorText;
        }

        const anchorSentence = `For readers exploring this further, ${anchorTag} is worth a look.`;
        if (!baseComment) {
            return anchorSentence;
        }
        if (/[.!?]["']?$/.test(baseComment)) {
            return `${baseComment} ${anchorSentence}`;
        }
        return `${baseComment}. ${anchorSentence}`;
    }

    function buildAnchorUrlVariants(anchorUrl) {
        const variants = new Set();
        const normalized = compactText(anchorUrl || '');
        if (!normalized) return [];

        variants.add(normalized);
        variants.add(normalized.replace(/^https?:\/\//i, ''));
        variants.add(normalized.replace(/^https?:\/\/(www\.)?/i, ''));
        variants.add(normalized.replace(/^www\./i, ''));

        try {
            const parsed = new URL(normalized);
            variants.add(parsed.hostname);
            variants.add(parsed.hostname.replace(/^www\./i, ''));
        } catch {}

        return Array.from(variants).filter(Boolean);
    }

    function replaceFirstCaseInsensitive(text, target, replacement) {
        if (!text || !target) return text;
        return text.replace(new RegExp(escapeRegExp(target), 'i'), replacement);
    }

    function pageAllowsHtmlLinks(form, resource, aiFormInfo) {
        if (!form) return false;

        const formAction = compactText(form.getAttribute('action') || '').toLowerCase();
        if (formAction.includes('wp-comments-post')) {
            return true;
        }

        if (form.id === 'commentform' && form.querySelector('input[name="comment_post_ID"]')) {
            return true;
        }

        if (resource?.linkMethod === 'html') return true;
        if (Array.isArray(resource?.opportunities) && resource.opportunities.includes('rich-editor')) return true;
        if (Array.isArray(resource?.details) && resource.details.some((item) => /html|链接|可插入/i.test(String(item)))) return true;

        if (form.querySelector('[contenteditable="true"], .ql-editor, .ProseMirror, .mce-content-body')) {
            return true;
        }

        const aiFields = aiFormInfo?.fields || [];
        if (aiFields.some((field) => /contenteditable|ql-editor|prosemirror|tinymce|ckeditor/i.test(field.selector || ''))) {
            return true;
        }

        const formText = compactText(form.textContent || '').toLowerCase();
        if (/(allowed html tags|html tags allowed|you may use these html tags|allowed tags|<a href|comment html|html标签|允许使用html|可用标签)/.test(formText)) {
            return true;
        }

        return false;
    }

    function addDebugEvent(type, message) {
        if (!currentDebugInfo) return;
        currentDebugInfo.actions.push({ type, message });
        if (currentDebugMode) {
            console.log(`[BLA:${type}] ${message}`);
        }
    }

    function recordFilledField(el, fieldType, value) {
        markDebugElement(el, 'field');
        addDebugEvent('field', `Filled ${fieldType}${value ? `: ${truncateText(String(value), 80)}` : ''}`);
    }

    function markDebugElement(el, kind) {
        if (!currentDebugMode || !el) return;
        el.classList.add('bla-debug-target', `bla-debug-${kind}`);
    }

    function applyAiSpecialFields(form, aiFormInfo, fieldType) {
        const aiFields = aiFormInfo?.fields || [];
        let handledCount = 0;

        for (const field of aiFields) {
            if (field.type !== fieldType) continue;

            let el = null;
            if (field.selector) {
                el = form.querySelector(field.selector) || document.querySelector(field.selector);
            }
            if (!el) continue;

            if (fieldType === 'captcha' && field.answer) {
                setFieldValue(el, field.answer);
                markDebugElement(el, 'captcha');
                addDebugEvent('captcha', `AI solved "${field.question || field.label || 'captcha'}" -> ${field.answer}`);
                handledCount++;
            }

            if (fieldType === 'checkbox' && field.shouldCheck) {
                setCheckboxValue(el, true);
                markDebugElement(el, 'checkbox');
                addDebugEvent('checkbox', `AI checked "${field.label || getInputContextText(el, form) || field.selector || 'checkbox'}"`);
                handledCount++;
            }
        }

        return handledCount;
    }

    function solveCaptchaByRules(form) {
        const seenInputs = new Set();
        const textNodes = form.querySelectorAll('label, legend, p, span, div, td, th, li, strong');
        let solvedCount = 0;

        textNodes.forEach((node) => {
            const text = compactText(node.textContent || '');
            if (!text || text.length < 3 || text.length > 180) return;

            const solved = solveSimpleCaptcha(text);
            if (!solved) return;

            const input = findNearbyCaptchaInput(node, form);
            if (!input || seenInputs.has(input)) return;

            seenInputs.add(input);
            setFieldValue(input, solved.answer);
            markDebugElement(input, 'captcha');
            addDebugEvent('captcha', `Solved "${truncateText(text, 80)}" -> ${solved.answer}`);
            solvedCount++;
        });

        if (currentDebugMode && solvedCount === 0) {
            addDebugEvent('captcha', 'No simple captcha matched by rules');
        }
    }

    function checkAntiSpamBoxes(form) {
        const checkboxes = form.querySelectorAll('input[type="checkbox"]');
        let checkedCount = 0;

        checkboxes.forEach((checkbox) => {
            const contextText = getInputContextText(checkbox, form).toLowerCase();
            if (!contextText) return;
            if (isNotificationCheckbox(contextText)) return;

            if (/(not a spammer|not spam|anti spam|anti-spam|human|robot|i am human|i'm human|confirm[^.]*spammer|confirm[^.]*human|agree[^.]*spammer|agree[^.]*human)/.test(contextText)) {
                setCheckboxValue(checkbox, true);
                markDebugElement(checkbox, 'checkbox');
                addDebugEvent('checkbox', `Checked "${truncateText(contextText, 80)}"`);
                checkedCount++;
            }
        });

        if (currentDebugMode && checkedCount === 0) {
            addDebugEvent('checkbox', 'No anti-spam checkbox matched by rules');
        }
    }

    function solveSimpleCaptcha(text) {
        const normalized = replaceNumberWords(text.toLowerCase())
            .replace(/\s+/g, ' ')
            .replace(/[=：:]/g, ' ')
            .trim();

        const hasMathExpression = /-?\d+\s*(\+|plus|-|minus|\*|x|×|times|\/|÷|divided by)\s*-?\d+/.test(normalized);
        const looksLikeCaptchaPrompt = /(\?|\bcaptcha\b|\bspam\b|\bhuman\b|\bsecurity\b|\bsum of\b|\bwhat is\b|\bsolve\b)/.test(normalized);
        if (!(looksLikeCaptchaPrompt || (hasMathExpression && normalized.length <= 40))) {
            return null;
        }

        let match = normalized.match(/(-?\d+)\s*(\+|plus|-|minus|\*|x|×|times|\/|÷|divided by)\s*(-?\d+)/);
        if (!match) {
            match = normalized.match(/sum of\s+(-?\d+)\s+(?:and|with)\s+(-?\d+)/);
            if (match) {
                return { answer: String(Number(match[1]) + Number(match[2])) };
            }
            return null;
        }

        const left = Number(match[1]);
        const operator = match[2];
        const right = Number(match[3]);

        let answer = null;
        if (operator === '+' || operator === 'plus') answer = left + right;
        else if (operator === '-' || operator === 'minus') answer = left - right;
        else if (operator === '*' || operator === 'x' || operator === '×' || operator === 'times') answer = left * right;
        else if (operator === '/' || operator === '÷' || operator === 'divided by') {
            if (right === 0 || left % right !== 0) return null;
            answer = left / right;
        }

        return answer === null ? null : { answer: String(answer) };
    }

    function findNearbyCaptchaInput(anchor, form) {
        const candidates = [];
        const pushCandidates = (root) => {
            if (!root) return;
            if (root.matches?.('input, textarea')) {
                candidates.push(root);
                return;
            }
            root.querySelectorAll?.('input, textarea').forEach((input) => candidates.push(input));
        };

        if (anchor.matches?.('label[for]') && anchor.htmlFor) {
            const linked = form.querySelector(`#${escapeSelector(anchor.htmlFor)}`);
            if (linked) candidates.push(linked);
        }

        pushCandidates(anchor);
        pushCandidates(anchor.nextElementSibling);
        pushCandidates(anchor.previousElementSibling);
        pushCandidates(anchor.parentElement);
        pushCandidates(anchor.parentElement?.nextElementSibling);
        pushCandidates(anchor.closest('p, div, td, th, li, tr, fieldset, label'));
        pushCandidates(anchor.closest('p, div, td, th, li, tr, fieldset, label')?.nextElementSibling);

        form.querySelectorAll(
            'input[name*="captcha" i], input[id*="captcha" i], ' +
            'input[name*="spam" i], input[id*="spam" i], ' +
            'input[name*="security" i], input[id*="security" i], ' +
            'input[name*="answer" i], input[id*="answer" i], ' +
            'input[name*="human" i], input[id*="human" i], ' +
            'input[name*="quiz" i], input[id*="quiz" i], ' +
            'input[name*="math" i], input[id*="math" i]'
        ).forEach((input) => candidates.push(input));

        for (const input of candidates) {
            if (isLikelyCaptchaInput(input)) {
                return input;
            }
        }
        return null;
    }

    function isLikelyCaptchaInput(input) {
        if (!input || input.disabled || input.readOnly) return false;
        if (!isVisible(input)) return false;

        const type = (input.type || 'text').toLowerCase();
        if (['hidden', 'checkbox', 'radio', 'submit', 'button', 'email', 'url'].includes(type)) {
            return false;
        }

        const signature = compactText(
            `${input.name || ''} ${input.id || ''} ${input.placeholder || ''} ${input.className || ''}`
        ).toLowerCase();

        if (/(author|name|email|mail|url|website|site|comment|message|search)/.test(signature)) {
            return false;
        }

        return true;
    }

    function getInputContextText(input, form) {
        const texts = [];

        if (input.id) {
            const labelByFor = form.querySelector(`label[for="${escapeAttribute(input.id)}"]`);
            if (labelByFor) texts.push(labelByFor.textContent || '');
        }
        if (input.closest('label')) texts.push(input.closest('label').textContent || '');
        if (input.previousElementSibling) texts.push(input.previousElementSibling.textContent || '');
        if (input.nextElementSibling) texts.push(input.nextElementSibling.textContent || '');
        if (input.parentElement) texts.push(input.parentElement.textContent || '');
        if (input.closest('p, div, td, th, li, tr, fieldset')) {
            texts.push(input.closest('p, div, td, th, li, tr, fieldset').textContent || '');
        }

        return texts
            .map((text) => compactText(text))
            .filter(Boolean)
            .sort((a, b) => a.length - b.length)[0] || '';
    }

    function isNotificationCheckbox(text) {
        return /(subscribe|notify|follow|save my name|remember me|cookies|cookie consent|save.*browser)/.test(text);
    }

    function buildDebugSummaryHtml() {
        if (!currentDebugMode || !currentDebugInfo?.actions?.length) return '';

        const items = currentDebugInfo.actions
            .filter((action) => action.type === 'captcha' || action.type === 'checkbox' || action.type === 'field')
            .slice(-6);

        if (items.length === 0) return '';

        const labels = {
            captcha: 'Captcha',
            checkbox: 'Checkbox',
            field: 'Field'
        };

        return `
            <div class="bla-debug-summary">
                <div class="bla-debug-summary-title">Debug Checks</div>
                ${items.map((item) => `
                    <div class="bla-debug-summary-item">
                        <span class="bla-debug-badge bla-debug-badge-${item.type}">${labels[item.type] || 'Info'}</span>
                        <span>${escapeHtml(item.message)}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }

    function compactText(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    function truncateText(text, length) {
        return text.length > length ? `${text.slice(0, length - 1)}…` : text;
    }

    function escapeRegExp(text) {
        return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function replaceNumberWords(text) {
        let result = text;
        for (const [word, value] of Object.entries(NUMBER_WORDS)) {
            result = result.replace(new RegExp(`\\b${word}\\b`, 'g'), String(value));
        }
        return result;
    }

    function isVisible(el) {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    }

    function escapeSelector(value) {
        if (window.CSS?.escape) return window.CSS.escape(value);
        return String(value).replace(/["\\]/g, '\\$&');
    }

    function escapeAttribute(value) {
        return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function cloneValue(value) {
        return JSON.parse(JSON.stringify(value));
    }
})();
