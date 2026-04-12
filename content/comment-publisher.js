/**
 * Comment Publisher V3 - AI 驱动
 * 智能表单识别 + 验证码处理 + AI 评论生成
 */

(function () {
    if (window.__commentPublisherLoaded) return;
    window.__commentPublisherLoaded = true;

    // 暴露 pokeWorkflowStallTimer 到 window，供 comment-executor.js 等模块调用
    window.pokeWorkflowStallTimer = function () {};  // 占位，armWorkflowStallTimer 初始化后会被覆盖

    let currentResourceId = null;
    let currentTaskId = null;
    let currentSessionId = null;
    let currentDebugMode = false;
    let currentDebugInfo = null;
    let publishStopped = false;
    let fillCommentInProgress = false;
    let publishResultReported = false;
    let autoSubmitTimer = null;
    let submissionFallbackTimer = null;
    let workflowStallTimer = null;
    let currentPublishMeta = null;
    const WORKFLOW_STALL_TIMEOUT_MS = 18000;

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

    const EXECUTION_PROFILES = {
        fast: {
            id: 'fast',
            useAIForForm: false,
            useAIForComment: false,
            preferHumanTypingForComment: true,
            formTimeoutMs: 6000,
            formPollMs: 400,
            aiFormTimeoutMs: 0,
            aiCommentTimeoutMs: 0,
            submitDelayMs: 2500,
            workflowStallTimeoutMs: 15000
        },
        hybrid: {
            id: 'hybrid',
            useAIForForm: true,
            useAIForComment: false,
            preferHumanTypingForComment: true,
            formTimeoutMs: 10000,
            formPollMs: 700,
            aiFormTimeoutMs: 2200,
            aiCommentTimeoutMs: 0,
            submitDelayMs: 3000,
            workflowStallTimeoutMs: 20000
        },
        ai: {
            id: 'ai',
            useAIForForm: true,
            useAIForComment: true,
            preferHumanTypingForComment: true,
            formTimeoutMs: 16000,
            formPollMs: 900,
            aiFormTimeoutMs: 3000,
            aiCommentTimeoutMs: 4500,
            submitDelayMs: 3500,
            workflowStallTimeoutMs: 25000
        }
    };

    const WORKFLOW_STAGE_TIMEOUTS = {
        bootstrap: { fast: 12000, hybrid: 15000, ai: 18000 },
        preflight: { fast: 10000, hybrid: 12000, ai: 15000 },
        finding_form: { fast: 12000, hybrid: 15000, ai: 20000 },
        form_detected: { fast: 8000, hybrid: 10000, ai: 12000 },
        generating_comment: { fast: 6000, hybrid: 8000, ai: 10000 },
        comment_ready: { fast: 6000, hybrid: 8000, ai: 10000 },
        filling_form: { fast: 45000, hybrid: 55000, ai: 65000 },
        form_filled: { fast: 8000, hybrid: 10000, ai: 12000 },
        pre_submit: { fast: 8000, hybrid: 10000, ai: 12000 },
        submitting: { fast: 15000, hybrid: 18000, ai: 20000 }
    };

    function isStrictAnchorCommentStyle(value) {
        return compactText(value || '') === 'anchor-html';
    }

    function isPreferredAnchorCommentStyle(value) {
        return compactText(value || '') === 'anchor-prefer';
    }

    function isAnyAnchorCommentStyle(value) {
        return isStrictAnchorCommentStyle(value) || isPreferredAnchorCommentStyle(value);
    }

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.action === 'fillComment') {
            fillCommentForm(msg.data);
        }
        if (msg.action === 'stopPublishSession') {
            if (msg.sessionId && currentSessionId && msg.sessionId !== currentSessionId) {
                return;
            }
            cancelCurrentPublish();
        }
    });

    async function fillCommentForm(data) {
        const incomingRunKey = `${data?.taskId || ''}:${data?.sessionId || ''}:${data?.resourceId || ''}`;
        const activeRunKey = `${currentTaskId || ''}:${currentSessionId || ''}:${currentResourceId || ''}`;
        if (fillCommentInProgress) {
            if (incomingRunKey === activeRunKey) {
                return;
            }
            // Tab 复用时上一轮可能没正常结束，强制重置
            cancelCurrentPublish();
            fillCommentInProgress = false;
            await wait(300);
        }

        // 拦截浏览器原生 alert/confirm 弹窗，注入到页面上下文（main world）
        // content script 的覆盖只影响 isolated world，不影响页面 JS 触发的 alert
        if (!window.__blaAlertIntercepted) {
            window.__blaAlertIntercepted = true;
            const script = document.createElement('script');
            script.textContent = `
                (function() {
                    if (window.__blaAlertBlocked) return;
                    window.__blaAlertBlocked = true;
                    window.alert = function(msg) {
                        console.log('[BLA] 拦截页面 alert:', msg);
                    };
                    var origConfirm = window.confirm;
                    window.confirm = function(msg) {
                        console.log('[BLA] 拦截页面 confirm:', msg);
                        return true;
                    };
                })();
            `;
            (document.head || document.documentElement).appendChild(script);
            script.remove();
        }

        fillCommentInProgress = true;
        currentResourceId = data.resourceId;
        currentTaskId = data.taskId;
        currentSessionId = data.sessionId || null;
        currentDebugMode = !!data.debugMode;
        currentDebugInfo = { mode: data.mode || 'semi-auto', actions: [] };
        publishStopped = false;
        window.__blaPublishStopped = false;
        publishResultReported = false;
        clearAutoSubmitTimer();
        clearSubmissionFallbackTimer();
        clearWorkflowStallTimer();
        currentPublishMeta = {
            commentStyle: data.commentStyle || 'standard',
            anchorRequested: isAnyAnchorCommentStyle(data.commentStyle),
            anchorInjected: false,
            anchorText: '',
            anchorUrl: '',
            inlineLinkMode: '',
            commentPreview: '',
            retryWithoutWebsite: !!data.retryWithoutWebsite,
            websiteOmitted: !data.website,
            publishStartedAt: new Date().toISOString()
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
            siteTemplate: data.siteTemplate || null,
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
                allowAnchorHtml: false,
                linkMode: '',
                useInlineLink: false
            }
        };
        context.execution = resolveExecutionProfile(context);

        updateWorkflowProgress(context, 'bootstrap', '初始化页面发布上下文');
        await primeCommentSectionSearch(context, { immediate: true, forceProgressiveScroll: true });
        updateWorkflowProgress(context, 'preflight', '定位评论区并预处理页面');

        addDebugEvent('field', `Workflow: ${workflow.name || workflow.id}`);
        addDebugEvent('field', `Publish mode: ${context.mode}${currentDebugMode ? ' (debug pause enabled)' : ''}`);
        addDebugEvent('field', `Execution profile: ${context.execution.id}`);

        try {
            // 硬信号预检：评论已关闭 / 必须登录 / 验证码 → 直接标为永久不可发，踢出队列
            const hardSignal = detectHardUnpublishableSignal();
            if (hardSignal) {
                addDebugEvent('field', `Hard unpublishable signal: ${hardSignal}`);
                reportResult('failed', {
                    reason: hardSignal,
                    submissionBlocked: true,
                    submissionBlockReason: hardSignal,
                    unpublishable: true
                });
                return;
            }

            if (await maybeExecuteStandardCommentFastFlow(context)) {
                return;
            }
            await executeWorkflow(context);
        } catch (e) {
            console.log('[BLA] 工作流执行失败:', e);
            addDebugEvent('field', `Workflow failed: ${e.message}`);
            // 工作流内部失败前再查一次硬信号（可能进入页面后才检测到）
            const lateHardSignal = detectHardUnpublishableSignal();
            let reason;
            let unpublishable = false;
            if (lateHardSignal) {
                reason = lateHardSignal;
                unpublishable = true;
            } else if (/form not found/i.test(e.message)) {
                reason = 'comment-form-not-found';
            } else {
                reason = e.message || 'unknown';
            }
            reportResult('failed', {
                reason,
                submissionBlocked: true,
                submissionBlockReason: reason,
                unpublishable
            });
        } finally {
            fillCommentInProgress = false;
        }
    }

    function detectHardUnpublishableSignal() {
        try {
            const detection = getCommentFormDetection();
            if (!detection?.detectPageCommentCapabilities) return '';
            const caps = detection.detectPageCommentCapabilities(document);
            if (caps?.commentsClosed) return 'comments-closed';
            if (caps?.requiresLogin) return 'login-required';
            if (caps?.hasCaptcha) return 'captcha-blocked';
            return '';
        } catch (e) {
            console.log('[BLA] detectHardUnpublishableSignal 失败:', e);
            return '';
        }
    }

    async function executeWorkflow(context) {
        const steps = Array.isArray(context.workflow?.steps) ? context.workflow.steps : [];
        for (const step of steps) {
            if (publishStopped) return;
            await executeWorkflowStep(step, context);
            if (context.workflowAborted) return;
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
                await executeFillFieldsStep(step, context);
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

    async function maybeExecuteStandardCommentFastFlow(context) {
        if (publishStopped || !context) return false;

        const form = findStandardCommentForm();
        if (!form) {
            return false;
        }

        context.form = form;
        updateWorkflowProgress(context, 'form_detected', '识别到标准评论表单');
        prepareFormForInteraction(context.form);
        context.form.style.outline = '2px dashed #3ecfff';
        context.form.style.outlineOffset = '8px';
        markDebugElement(context.form, 'form');
        currentPublishMeta = {
            ...(currentPublishMeta || {}),
            executionPath: 'standard-comment-fast-flow'
        };
        addDebugEvent('field', 'Using standard comment fast flow');

        if (handleDuplicateCommentSkip(context)) {
            return true;
        }

        await prepareCommentContent(context, { useAI: true });
        if (context.workflowAborted) {
            return true;
        }

        await fillStandardCommentFormDirectly(context);
        if (context.workflowAborted) {
            return true;
        }
        updateWorkflowProgress(context, 'form_filled', '标准评论表单已填写');
        executeSolveCaptchaStep(context);
        executeAntiSpamStep(context);
        executeUncheckNotificationsStep(context);
        updateWorkflowProgress(context, 'pre_submit', '正在检查验证码和提交前状态');
        executeFinalizeStep(context);
        return true;
    }

    async function executeFindFormStep(step, context) {
        updateWorkflowProgress(context, 'finding_form', '正在识别评论表单');
        await primeCommentSectionSearch(context, { immediate: true, forceProgressiveScroll: true });
        context.form = await waitForCommentForm(context, {
            useAI: context.useAI && step.useAI !== false && context.execution.useAIForForm,
            timeoutMs: context.execution.formTimeoutMs,
            pollMs: context.execution.formPollMs,
            aiTimeoutMs: context.execution.aiFormTimeoutMs
        });

        if (!context.form) {
            addDebugEvent('field', 'Comment form not found');
            throw new Error('Comment form not found');
        }

        updateWorkflowProgress(context, 'form_detected', '已识别评论表单');
        prepareFormForInteraction(context.form);
        context.form.style.outline = '2px dashed #3ecfff';
        context.form.style.outlineOffset = '8px';
        context.form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        markDebugElement(context.form, 'form');
        handleDuplicateCommentSkip(context);
    }

    async function fillStandardCommentFormDirectly(context) {
        const form = context?.form;
        const values = {
            comment: context?.comment || '',
            name: context?.values?.name || '',
            email: context?.values?.email || '',
            website: context?.values?.website || ''
        };
        updateWorkflowProgress(
            context,
            'filling_form',
            '正在填写标准评论表单',
            { timeoutMs: estimateFormFillTimeoutMs(context, values) }
        );

        // 整个填写阶段暂停超时计时器
        pokeWorkflowStallTimer();

        const standardFlow = getStandardCommentFlow();
        const standardFill = standardFlow?.fillStandardCommentForm
            ? await standardFlow.fillStandardCommentForm(form, values)
            : null;

        let commentFilled = !!standardFill?.commentFilled;
        let richEditorFilled = false;

        if (commentFilled) {
            currentPublishMeta = {
                ...(currentPublishMeta || {}),
                commentFieldVerified: true,
                commentEditorType: 'textarea',
                commentFieldSelector: standardFill?.commentSelector || currentPublishMeta?.commentFieldSelector || '',
                commentFillStrategy: 'standard-direct',
                formSignature: standardFill?.formSignature || buildFormSignature(form) || currentPublishMeta?.formSignature || ''
            };
            addDebugEvent('field', 'Standard comment form direct-filled');
        }

        // 富文本 iframe 路径必须无条件运行 —— 即使 standardFlow 声称
        // commentFilled=true，那个 fill 也只是写到了隐藏 textarea，TinyMCE
        // 提交时会用 iframe 内容覆盖 textarea，导致提交空评论。
        // 必须在 standardFlow 之后（且无视 commentFilled）写到 iframe body。
        if (values.comment) {
            const richTarget = findRichEditorTargetInForm(form);
            if (richTarget && fillRichEditorTarget(richTarget, values.comment)) {
                commentFilled = true;
                richEditorFilled = true;
                currentPublishMeta = {
                    ...(currentPublishMeta || {}),
                    commentFieldVerified: true,
                    commentEditorType: 'rich-iframe',
                    commentFieldSelector: 'iframe[contenteditable]',
                    commentFillStrategy: 'rich-iframe',
                    formSignature: buildFormSignature(form) || currentPublishMeta?.formSignature || ''
                };
                addDebugEvent('field', 'Rich editor iframe (TinyMCE/CKEditor) filled directly');
            }
        }

        if (!commentFilled && values.comment) {
            commentFilled = await fillCommentFieldWithExecutor(form, values.comment, context);
        }

        if (!commentFilled && values.comment) {
            addDebugEvent('field', 'Standard comment form comment field could not be verified');
            pokeWorkflowStallTimer();
            reportResult('failed', {
                reason: 'comment-field-empty',
                submissionBlocked: true
            });
            context.workflowAborted = true;
            return;
        }

        // 富文本 iframe 路径已经写入并镜像到 textarea，常规 ensureCommentFieldValue
        // 走的是 findBestField + isVisible，跨不进 iframe 也找不到隐藏 textarea，
        // 直接跳过验证（fillRichEditorTarget 自身保证写入成功）
        if (values.comment && !richEditorFilled) {
            const ensuredComment = await ensureCommentFieldValue(form, values.comment, context, {
                allowTypingFallback: true
            });
            if (!ensuredComment) {
                addDebugEvent('field', 'Standard comment form comment verification failed after fallback');
                pokeWorkflowStallTimer();
                reportResult('failed', {
                    reason: 'comment-field-empty',
                    submissionBlocked: true
                });
                context.workflowAborted = true;
                return;
            }
        }

        const missingRequiredFields = [];
        if (values.name) {
            const nameField = findBestField(form, [
                'input[name="author"]',
                'input#author',
                'input[name="name"]',
                'input[name*="name" i]'
            ], 'name');
            if (nameField && !fieldValueMatches(nameField, values.name)) {
                missingRequiredFields.push('name');
            }
        }
        if (values.email) {
            const emailField = findBestField(form, [
                'input[name="email"]',
                'input#email',
                'input[type="email"]',
                'input[name*="mail" i]'
            ], 'email');
            if (emailField && !fieldValueMatches(emailField, values.email)) {
                missingRequiredFields.push('email');
            }
        }
        if (values.website) {
            const websiteField = findBestField(form, [
                'input[name="url"]',
                'input#url',
                'input[name="website"]',
                'input[type="url"]',
                'input[name*="site" i]',
                'input[name*="web" i]'
            ], 'website');
            if (websiteField && !fieldValueMatches(websiteField, values.website)) {
                missingRequiredFields.push('website');
            }
        }

        if (missingRequiredFields.length > 0) {
            addDebugEvent('field', `Standard form missed fields: ${missingRequiredFields.join(', ')}`);
            await fillFieldsByRules(form, values, missingRequiredFields, {
                execution: context.execution
            });
        }

        // 标准表单填写完成，恢复超时计时器
        pokeWorkflowStallTimer();
    }

    async function executeGenerateCommentStep(step, context) {
        updateWorkflowProgress(context, 'generating_comment', '正在准备评论内容');
        await prepareCommentContent(context, step);
    }

    function handleDuplicateCommentSkip(context) {
        const existingComment = findExistingCommentByCommenter(context);
        if (!existingComment) {
            return false;
        }

        const matchedToken = compactText(existingComment.matchedToken || '');
        addDebugEvent(
            'field',
            `Existing comment detected for ${context?.values?.name || 'current commenter'}; skipping${matchedToken ? ` (${matchedToken})` : ''}`
        );
        currentPublishMeta = {
            ...(currentPublishMeta || {}),
            duplicateCommentDetected: true,
            duplicateCommentExcerpt: truncateText(compactText(existingComment.text || ''), 180),
            duplicateCommentSelector: existingComment.selector || '',
            duplicateCommentMatchedToken: matchedToken
        };
        context.workflowAborted = true;
        reportResult('skipped', {
            reason: 'duplicate-comment-detected',
            terminalFailureReason: 'duplicate_comment',
            submissionBlockReason: 'duplicate_comment'
        });
        return true;
    }

    async function prepareCommentContent(context, step = {}) {
        context.anchorOptions = resolveAnchorOptions(context);

        if (shouldSkipUnavailableAnchorPublish(context)) {
            currentPublishMeta = {
                ...(currentPublishMeta || {}),
                commentStyle: context.anchorOptions.mode,
                anchorRequested: true,
                anchorInjected: false,
                inlineLinkMode: '',
                websiteOmitted: false,
                linkMode: '',
                anchorUnavailable: true
            };
            addDebugEvent('field', 'Anchor mode requested but verified inline HTML anchor capability was not found; skipping');
            reportResult('skipped', {
                reason: 'anchor-mode-unavailable',
                terminalFailureReason: 'anchor_mode_unavailable',
                linkMode: '',
                anchorRequested: true,
                anchorInjected: false
            });
            context.workflowAborted = true;
            return;
        }

        if (shouldSkipCommentOnlyDirectPublish(context)) {
            currentPublishMeta = {
                ...(currentPublishMeta || {}),
                commentStyle: context.anchorOptions.mode,
                anchorRequested: isAnyAnchorCommentStyle(context.anchorOptions.mode),
                inlineLinkMode: '',
                websiteOmitted: true,
                linkMode: 'comment-only'
            };
            addDebugEvent('field', 'Comment-only form detected; skipping current direct-link task');
            reportResult('skipped', {
                reason: 'comment-only-form',
                terminalFailureReason: 'comment_only_form',
                linkMode: 'comment-only',
                websiteOmitted: true
            });
            context.workflowAborted = true;
            return;
        }

        context.comment = generateFallbackComment(context.pageTitle, context.anchorOptions);
        if (context.useAI && step.useAI !== false && context.execution.useAIForComment) {
            try {
                const pageContent = getPageContent();
                addDebugEvent('field', 'Generating comment with AI');
                pokeWorkflowStallTimer(); // 正在请求 AI，重置超时
                const result = await sendRuntimeMessageWithTimeout({
                    action: 'aiGenerateComment',
                    pageTitle: context.pageTitle,
                    pageContent,
                    targetUrl: context.anchorOptions.anchorUrl || context.values.website,
                    options: context.anchorOptions
                }, context.execution.aiCommentTimeoutMs, 'AI comment generation');
                pokeWorkflowStallTimer(); // AI 响应完成，重置超时
                if (compactText(result?.comment || '')) {
                    context.comment = result.comment;
                }
            } catch (e) {
                console.log('[BLA] AI 评论生成失败:', e);
                addDebugEvent('field', `AI comment unavailable, keeping fast fallback: ${e.message}`);
            }
        }

        context.comment = ensureLinkComment(context.comment, context.anchorOptions);
        if (!compactText(context.comment)) {
            context.comment = generateFallbackComment(context.pageTitle, {
                mode: 'standard',
                anchorText: '',
                anchorUrl: '',
                allowAnchorHtml: false,
                linkMode: '',
                useInlineLink: false
            });
        }
        currentPublishMeta = {
            ...(currentPublishMeta || {}),
            commentStyle: context.anchorOptions.mode,
            anchorRequested: isAnyAnchorCommentStyle(context.anchorOptions.mode),
            anchorInjected: commentContainsInlineLink(context.comment),
            anchorText: context.anchorOptions.anchorText || '',
            anchorUrl: context.anchorOptions.anchorUrl || '',
            inlineLinkMode: context.anchorOptions.linkMode || '',
            commentPreview: truncateText(compactText(context.comment || ''), 180)
        };
        updateWorkflowProgress(context, 'comment_ready', '评论内容已准备好');

        if (context.anchorOptions.useInlineLink) {
            addDebugEvent(
                'field',
                `Inline link mode: ${context.anchorOptions.linkMode || 'unknown'} -> ${context.anchorOptions.anchorUrl}`
            );
        } else if (isAnyAnchorCommentStyle(context.anchorOptions.mode)) {
            addDebugEvent('field', 'Anchor mode requested but current page was not judged as inline-link-safe');
        }
    }

    async function executeFillFieldsStep(step, context) {
        prepareFormForInteraction(context.form);
        const values = {
            comment: context.comment,
            name: context.values.name,
            email: context.values.email,
            website: context.values.website
        };
        updateWorkflowProgress(
            context,
            'filling_form',
            '正在填写评论表单',
            { timeoutMs: estimateFormFillTimeoutMs(context, values) }
        );

        // 填写阶段开始，重置超时（不暂停，用 poke 保活）
        pokeWorkflowStallTimer();
        const allowedFields = Array.isArray(step.fields) && step.fields.length > 0
            ? step.fields
            : ['comment', 'name', 'email', 'website'];
        const nonCommentFields = allowedFields.filter((fieldType) => fieldType !== 'comment');

        let commentFilled = false;
        if (shouldUseClassicCommentFastPath(context.form)) {
            const fastFill = await fillClassicCommentFormFast(context.form, values);
            if (fastFill.commentFilled) {
                commentFilled = true;
                currentPublishMeta = {
                    ...(currentPublishMeta || {}),
                    commentFieldVerified: true,
                    commentEditorType: 'textarea',
                    commentFieldSelector: fastFill.commentSelector || currentPublishMeta?.commentFieldSelector || '',
                    commentFillStrategy: 'classic-direct',
                    formSignature: buildFormSignature(context.form) || currentPublishMeta?.formSignature || ''
                };
                addDebugEvent('field', 'Classic comment form fast-filled');
            }
        }
        if (allowedFields.includes('comment') && values.comment) {
            if (!commentFilled) {
                commentFilled = await fillCommentFieldWithExecutor(context.form, values.comment, context);
            }
        }

        let aiFilledFields = new Set();
        if (context.aiFormInfo?.fields?.length && nonCommentFields.length > 0) {
            aiFilledFields = await fillFieldsFromAI(context.form, context.aiFormInfo, values, nonCommentFields, {
                execution: context.execution
            });
        }

        const fallbackFields = nonCommentFields.filter((fieldType) => {
            if (aiFilledFields.has(fieldType)) return false;
            return !!values[fieldType];
        });

        if (fallbackFields.length > 0) {
            if (context.aiFormInfo?.fields?.length) {
                addDebugEvent('field', `Fallback rule fill for: ${fallbackFields.join(', ')}`);
            }
            await fillFieldsByRules(context.form, values, fallbackFields, {
                execution: context.execution
            });
        }

        // 富文本 iframe 路径必须无条件运行（TinyMCE/CKEditor），写到 iframe body
        // 否则即使前面 fill 链"成功"，也只是把值写到了隐藏 textarea，提交时会被
        // TinyMCE 用 iframe 内容覆盖。详见 fillStandardCommentFormDirectly 的注释。
        let richEditorFilled = false;
        if (values.comment) {
            const richTarget = findRichEditorTargetInForm(context.form);
            if (richTarget && fillRichEditorTarget(richTarget, values.comment)) {
                commentFilled = true;
                richEditorFilled = true;
                currentPublishMeta = {
                    ...(currentPublishMeta || {}),
                    commentFieldVerified: true,
                    commentEditorType: 'rich-iframe',
                    commentFieldSelector: 'iframe[contenteditable]',
                    commentFillStrategy: 'rich-iframe',
                    formSignature: buildFormSignature(context.form) || currentPublishMeta?.formSignature || ''
                };
                addDebugEvent('field', 'Rich editor iframe (TinyMCE/CKEditor) filled directly (workflow path)');
            }
        }

        // 富文本 iframe 路径已经写入，常规 ensureCommentFieldValue 跨不进 iframe，跳过验证
        if (values.comment && !richEditorFilled) {
            const ensuredComment = await ensureCommentFieldValue(context.form, values.comment, context, {
                allowTypingFallback: true
            });
            if (ensuredComment) {
                addDebugEvent('field', 'Verified comment field is populated');
                if (!commentFilled) {
                    addDebugEvent('field', 'Comment field recovered by dedicated executor verification');
                }
            } else {
                addDebugEvent('field', 'Comment field still empty after fill attempts');
            }
        }

        // 填写阶段全部完成，恢复超时计时器
        pokeWorkflowStallTimer();
        updateWorkflowProgress(context, 'form_filled', '评论表单已填写完成');
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
        updateWorkflowProgress(context, 'pre_submit', context.mode === 'full-auto' && !currentDebugMode ? '准备自动提交评论' : '等待人工确认提交');

        if (context.mode === 'full-auto' && !currentDebugMode) {
            autoSubmitTimer = setTimeout(() => {
                autoSubmitTimer = null;
                if (!publishStopped) {
                    submitForm(context);
                }
            }, context.execution.submitDelayMs);
        } else {
            showCommentReadyDialog(context);
        }
    }

    // === 表单查找（规则） ===
    function findFormByRules() {
        const detection = getCommentFormDetection();
        if (detection?.findRuleBasedCommentForm) {
            return detection.findRuleBasedCommentForm(document);
        }
        return null;
    }

    function findStandardCommentForm() {
        return getStandardCommentFlow()?.findStandardCommentForm?.() || null;
    }

    // === AI 字段填充 ===
    async function fillFieldsFromAI(form, aiFormInfo, values, allowedFields, options = {}) {
        const allowed = new Set(allowedFields || ['comment', 'name', 'email', 'website']);
        const filledFields = new Set();
        for (const field of aiFormInfo.fields) {
            try {
                if (!allowed.has(field.type)) continue;

                let el = null;
                if (field.selector) {
                    el = form.querySelector(field.selector) || document.querySelector(field.selector);
                }

                if (!isUsableFieldElement(el, form, field.type)) continue;

                const value = values[field.type];
                if (!value) continue;

                const filled = await fillResolvedField(el, field.type, value, {
                    execution: options.execution
                });
                if (filled) {
                    filledFields.add(field.type);
                }
            } catch (e) {
                console.log(`[BLA] 填充字段失败 (${field.type}):`, e);
            }
        }
        return filledFields;
    }

    // === 规则字段填充 ===
    async function fillFieldsByRules(form, values, allowedFields, options = {}) {
        const allowed = new Set(allowedFields || ['comment', 'name', 'email', 'website']);

        // Comment
        if (allowed.has('comment')) {
            const commentField = findBestField(form, [
                'textarea[name="comment"]',
                'textarea#comment',
                'textarea[name="message"]',
                'textarea[name*="comment" i]',
                'textarea[name*="message" i]',
                'textarea'
            ], 'comment');
            if (commentField && values.comment) {
                await fillResolvedField(commentField, 'comment', values.comment, {
                    execution: options.execution
                });
            }
        }

        // 字段间模拟真人切换延迟（防止 Cloudflare 反机器人拦截）
        await wait(Math.floor(100 + Math.random() * 200));

        // Name
        if (allowed.has('name')) {
            const nameField = findBestField(form, [
                'input[name="author"]',
                'input#author',
                'input[name="name"]',
                'input[name*="name" i]',
                'input[placeholder*="name" i]',
                'input[placeholder*="nombre" i]',
                'input[placeholder*="名" i]'
            ], 'name');
            if (nameField && values.name) {
                await fillResolvedField(nameField, 'name', values.name, {
                    execution: options.execution
                });
            }
        }

        await wait(Math.floor(100 + Math.random() * 200));

        // Email
        if (allowed.has('email')) {
            const emailField = findBestField(form, [
                'input[name="email"]',
                'input#email',
                'input[type="email"]',
                'input[name*="mail" i]',
                'input[placeholder*="correo" i]'
            ], 'email');
            if (emailField && values.email) {
                await fillResolvedField(emailField, 'email', values.email, {
                    execution: options.execution
                });
            }
        }

        await wait(Math.floor(100 + Math.random() * 200));

        // Website
        if (allowed.has('website')) {
            const websiteField = findBestField(form, [
                'input[name="url"]',
                'input#url',
                'input[name="website"]',
                'input[type="url"]',
                'input[name*="site" i]',
                'input[name*="web" i]',
                'input[placeholder*="web" i]',
                'input[placeholder*="site" i]'
            ], 'website');
            if (websiteField && values.website) {
                await fillResolvedField(websiteField, 'website', values.website, {
                    execution: options.execution
                });
            }
        }
    }

    async function fillCommentFieldWithExecutor(form, comment, context) {
        const executor = window.CommentExecutor;
        if (!executor?.fillCommentField) {
            return false;
        }

        const result = await executor.fillCommentField(form, comment, {
            aiFormInfo: context.aiFormInfo,
            templateHint: context.siteTemplate || null,
            execution: context.execution
        });

        if (!result?.filled) {
            updateCommentPublishMeta(form, result || {}, { filled: false });
            return false;
        }

        context.commentFieldResolution = result;
        updateCommentPublishMeta(form, result, { filled: true });
        recordFilledField(result.element, 'comment', comment);
        addDebugEvent('field', `Comment executor matched ${result.editorType || 'field'} via ${result.strategy || 'unknown'} strategy`);
        return true;
    }

    function updateCommentPublishMeta(form, result = {}, options = {}) {
        currentPublishMeta = {
            ...(currentPublishMeta || {}),
            commentFieldVerified: !!options.filled,
            commentEditorType: result.editorType || currentPublishMeta?.commentEditorType || '',
            commentFieldSelector: result.selector || currentPublishMeta?.commentFieldSelector || '',
            commentFieldFingerprint: result.fingerprint || currentPublishMeta?.commentFieldFingerprint || '',
            commentFillStrategy: result.strategy || currentPublishMeta?.commentFillStrategy || '',
            commentCandidateCount: Number(result.candidateCount || currentPublishMeta?.commentCandidateCount || 0) || 0,
            formSignature: result.formSignature || buildFormSignature(form) || currentPublishMeta?.formSignature || '',
            linkMode: derivePublishLinkMode(result, currentPublishMeta?.commentStyle || 'standard', currentPublishMeta?.anchorRequested)
        };
    }

    function buildFormSignature(form) {
        const standardSignature = getStandardCommentFlow()?.buildFormSignature?.(form);
        if (standardSignature) return standardSignature;
        if (!form) return '';
        return compactText([
            form.id || '',
            form.className || '',
            form.getAttribute('action') || '',
            form.getAttribute('method') || '',
            form.querySelector('textarea[name="comment"], textarea#comment, [contenteditable="true"], .ql-editor, .ProseMirror')
                ? 'comment-editor'
                : '',
            form.querySelector('input[name="url"], input#url, input[name="website"], input[type="url"]')
                ? 'website-field'
                : ''
        ].join(' ')).toLowerCase();
    }

    function derivePublishLinkMode(result = {}, commentStyle, anchorRequested) {
        const explicitInlineMode = compactText(currentPublishMeta?.inlineLinkMode || '');
        if (explicitInlineMode) {
            return explicitInlineMode;
        }
        if ((isAnyAnchorCommentStyle(commentStyle) || anchorRequested) && currentPublishMeta?.anchorInjected) {
            return result?.editorType && result.editorType !== 'textarea'
                ? 'rich-editor-anchor'
                : 'raw-html-anchor';
        }
        return currentPublishMeta?.websiteOmitted ? 'comment-only' : 'website-field';
    }

    async function fillResolvedField(el, fieldType, value, options = {}) {
        if (!el || !value) return false;

        const strategy = resolveFieldExecutionStrategy(fieldType, options.execution);
        const filled = await applyFieldValue(el, value, {
            strategy,
            allowTypingFallback: fieldType === 'comment',
            verifyValue: true
        });

        if (filled) {
            recordFilledField(el, fieldType, value);
        }

        return filled;
    }

    function resolveFieldExecutionStrategy(fieldType, execution = {}) {
        if (fieldType === 'comment') {
            return execution?.preferHumanTypingForComment === false ? 'direct' : 'typing';
        }
        // 所有字段都用逐字输入，防止 Cloudflare 等反机器人拦截
        return 'typing';
    }

    function findBestField(form, selectors = [], fieldType = 'text') {
        const candidates = [];
        selectors.forEach((selector) => {
            form.querySelectorAll(selector).forEach((el) => candidates.push(el));
        });
        const usable = candidates.filter((el) => isUsableFieldElement(el, form, fieldType));
        return usable[0] || null;
    }

    function isUsableFieldElement(el, form, fieldType = 'text') {
        if (!el) return false;
        if (!(el instanceof HTMLElement)) return false;
        if (!isVisible(el) || el.disabled || el.readOnly) return false;
        if (!isElementOwnedByForm(el, form)) return false;

        const tagName = (el.tagName || '').toLowerCase();
        const inputType = (el.getAttribute('type') || '').toLowerCase();

        if (fieldType === 'comment') {
            return tagName === 'textarea' || el.isContentEditable;
        }

        if (tagName !== 'input' && tagName !== 'textarea') return false;
        if (tagName === 'textarea') return fieldType === 'comment';

        if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(inputType)) {
            return false;
        }

        if (fieldType === 'email') return inputType === 'email' || inputType === '' || inputType === 'text';
        if (fieldType === 'website') return inputType === 'url' || inputType === '' || inputType === 'text';
        return inputType === '' || inputType === 'text' || inputType === 'search';
    }

    function isElementOwnedByForm(el, form) {
        if (!el || !form) return false;
        if (form.contains(el)) return true;
        if (el.form && el.form === form) return true;
        const ownerForm = el.closest?.('form');
        return ownerForm === form;
    }

    function fieldValueMatches(el, expectedValue) {
        return compactText(readElementValue(el)) === compactText(expectedValue || '');
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
    async function applyFieldValue(el, value, options = {}) {
        const expected = compactText(value || '');
        if (!el || !expected) return false;

        const strategy = options.strategy || 'direct';
        if (strategy === 'typing') {
            await simulateFieldTyping(el, value, options);
            if (!options.verifyValue) return true;
            if (fieldValueMatches(el, expected)) return true;
        } else {
            setFieldValue(el, value);
            if (!options.verifyValue) return true;
            if (fieldValueMatches(el, expected)) return true;
        }

        if (options.allowTypingFallback && strategy !== 'typing') {
            await simulateFieldTyping(el, value, options);
            if (!options.verifyValue) return true;
            if (fieldValueMatches(el, expected)) return true;
        }

        return !options.verifyValue ? true : fieldValueMatches(el, expected);
    }

    function writeElementValue(el, value) {
        if (el instanceof HTMLInputElement) {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            if (descriptor?.set) {
                descriptor.set.call(el, value);
            } else {
                el.value = value;
            }
            return;
        }

        if (el instanceof HTMLTextAreaElement) {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
            if (descriptor?.set) {
                descriptor.set.call(el, value);
            } else {
                el.value = value;
            }
            return;
        }

        if (el?.isContentEditable) {
            el.innerHTML = value;
            return;
        }

        el.value = value;
    }

    function readElementValue(el) {
        if (!el) return '';
        if (el?.isContentEditable) return el.textContent || '';
        return el.value || el.textContent || '';
    }

    function dispatchFieldInputEvents(el) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function dispatchFieldChangeEvents(el) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setFieldValue(el, value) {
        writeElementValue(el, value);
        dispatchFieldInputEvents(el);
        dispatchFieldChangeEvents(el);
    }

    // ===  富文本编辑器 (TinyMCE / CKEditor) iframe 处理 ===
    // 这类编辑器把原生 textarea 隐藏掉（display:none），真正的可编辑区在 iframe 内部。
    // 常规 form.querySelector 跨不进 iframe，导致评论字段完全找不到。
    function inspectIframeAsRichEditor(iframe, hiddenTextarea = null) {
        try {
            const doc = iframe.contentDocument || iframe.contentWindow?.document;
            if (!doc) return null;
            const body = doc.body;
            if (!body) return null;
            const isEditor =
                body.isContentEditable
                || body.classList?.contains('mce-content-body')
                || body.id === 'tinymce'
                || !!doc.querySelector?.('[contenteditable="true"]');
            if (!isEditor) return null;
            // TinyMCE 4: iframe id 是 <textareaId>_ifr
            if (!hiddenTextarea && iframe.id && iframe.id.endsWith('_ifr')) {
                const baseId = iframe.id.replace(/_ifr$/, '');
                const ta = document.getElementById(baseId);
                if (ta instanceof HTMLTextAreaElement) hiddenTextarea = ta;
            }
            // 富文本 body 可能是 iframe.body 的子节点
            const editable = body.isContentEditable ? body : doc.querySelector('[contenteditable="true"]');
            return { iframe, body: editable || body, hiddenTextarea };
        } catch {
            return null;
        }
    }

    function findRichEditorTargetInForm(form) {
        if (!form) return null;
        // 1. 表单内直接找 iframe（TinyMCE 5/6 把 iframe 包在 .tox-tinymce 内）
        const iframes = form.querySelectorAll('iframe');
        for (const iframe of iframes) {
            const target = inspectIframeAsRichEditor(iframe);
            if (target) return target;
        }
        // 2. TinyMCE 4 经典模式：表单内有隐藏 <textarea id="comment">，
        //    iframe 在文档其他位置，id 为 "comment_ifr"
        const textareas = form.querySelectorAll('textarea');
        for (const ta of textareas) {
            if (!ta.id) continue;
            const iframe = document.getElementById(`${ta.id}_ifr`);
            if (iframe instanceof HTMLIFrameElement) {
                const target = inspectIframeAsRichEditor(iframe, ta);
                if (target) return target;
            }
        }
        return null;
    }

    function fillRichEditorTarget(target, value) {
        if (!target?.body) return false;
        try {
            const text = String(value || '');
            const looksLikeHtml = /<[a-z][^>]*>/i.test(text);
            const html = looksLikeHtml
                ? text
                : text.split(/\n\n+/)
                    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
                    .join('');

            target.body.innerHTML = html;

            // iframe 内部的 input/change/keyup 让编辑器内部 MutationObserver/handler 触发
            try {
                target.body.dispatchEvent(new Event('input', { bubbles: true }));
                target.body.dispatchEvent(new Event('change', { bubbles: true }));
                target.body.dispatchEvent(new Event('keyup', { bubbles: true }));
            } catch {}

            // 镜像到隐藏 textarea，保证 form submit 时服务端能拿到值
            if (target.hiddenTextarea) {
                try {
                    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
                    if (descriptor?.set) {
                        descriptor.set.call(target.hiddenTextarea, text);
                    } else {
                        target.hiddenTextarea.value = text;
                    }
                    target.hiddenTextarea.dispatchEvent(new Event('input', { bubbles: true }));
                    target.hiddenTextarea.dispatchEvent(new Event('change', { bubbles: true }));
                } catch {}
            }
            return true;
        } catch (e) {
            console.log('[BLA] fillRichEditorTarget 失败:', e);
            return false;
        }
    }

    async function ensureCommentFieldValue(form, comment, contextOrOptions = {}, extraOptions = {}) {
        const expected = compactText(comment || '');
        if (!form || !expected) return false;

        const hasContext = !!contextOrOptions?.values || !!contextOrOptions?.resource || !!contextOrOptions?.execution;
        const context = hasContext ? contextOrOptions : null;
        const options = hasContext ? extraOptions : contextOrOptions;
        const executor = window.CommentExecutor;

        if (executor?.ensureCommentFieldValue) {
            const result = await executor.ensureCommentFieldValue(form, comment, {
                aiFormInfo: context?.aiFormInfo || null,
                templateHint: context?.siteTemplate || null,
                execution: context?.execution || null,
                previousResolution: context?.commentFieldResolution || null,
                ...(options || {})
            });
            if (result?.filled) {
                if (context) {
                    context.commentFieldResolution = result;
                }
                updateCommentPublishMeta(form, result, { filled: true });
                return true;
            }
        }

        const commentField = findBestField(form, [
            'textarea[name="comment"]',
            'textarea#comment',
            'textarea[name="message"]',
            'textarea[name*="comment" i]',
            'textarea[name*="message" i]',
            'textarea'
        ], 'comment');
        if (!commentField) return false;
        if (fieldValueMatches(commentField, expected)) return true;

        return applyFieldValue(commentField, comment, {
            strategy: 'typing',
            allowTypingFallback: true,
            verifyValue: true,
            ...(options || {})
        });
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
        if (anchorOptions.useInlineLink && anchorOptions.anchorUrl) {
            const anchorTag = buildInlineLinkMarkup(anchorOptions);
            if (!anchorTag) {
                return generateFallbackComment(title, { mode: 'standard', useInlineLink: false });
            }
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
    function showCommentReadyDialog(context) {
        const form = context.form;
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
            submitForm(context);
        });

        dialog.querySelector('#bla-skip').addEventListener('click', () => {
            if (publishStopped) return;
            addDebugEvent('field', 'User skipped this resource');
            removeDialog();
            form.style.outline = 'none';
            reportResult('skipped');
        });
    }

    async function submitForm(context) {
        const form = context.form;
        if (publishStopped) return;
        updateWorkflowProgress(context, 'submitting', '正在提交评论');

        const fallbackComment = compactText(context.comment || '')
            || generateFallbackComment(context.pageTitle, {
                mode: 'standard',
                anchorText: '',
                anchorUrl: '',
                allowAnchorHtml: false
            });
        if (!(await ensureCommentFieldValue(form, fallbackComment, context, { allowTypingFallback: true }))) {
            addDebugEvent('field', 'Comment field is still empty before submit; aborting submission');
            reportResult('failed', {
                reason: 'comment-field-empty',
                submissionBlocked: true
            });
            return;
        }

        let submitBtn = findSubmitButton(form, context.aiFormInfo);

        // 规则找不到提交按钮时，调 AI 识别
        if (!submitBtn) {
            addDebugEvent('field', 'Rule-based submit button not found, trying AI detection');
            submitBtn = await findSubmitButtonWithAI(form);
        }

        currentPublishMeta = {
            ...(currentPublishMeta || {}),
            submitSelector: submitBtn ? describeElementForMeta(submitBtn) : (currentPublishMeta?.submitSelector || '')
        };

        addDebugEvent('field', 'Submitting form');
        clearWorkflowStallTimer();
        chrome.runtime.sendMessage({
            action: 'commentSubmitting',
            resourceId: currentResourceId,
            taskId: currentTaskId,
            sessionId: currentSessionId,
            meta: currentPublishMeta || {}
        }).catch(() => {});

        const triggered = await triggerSubmitAction(form, submitBtn);
        if (!triggered) {
            addDebugEvent('field', 'Submit action could not be triggered');
            reportResult('failed', {
                reason: 'submit-trigger-failed',
                submissionBlocked: true
            });
            return;
        }

        clearSubmissionFallbackTimer();

        // 监听网络拦截信号（来自 network-inspector-bridge.js）
        let networkSignalReceived = false;
        const networkSignalHandler = (event) => {
            const detail = event.detail;
            if (!detail || !detail.type || networkSignalReceived) return;
            networkSignalReceived = true;
            clearSubmissionFallbackTimer();
            window.removeEventListener('__bla_network_signal', networkSignalHandler);

            if (detail.type === 'confirmed') {
                reportResult('submitted', { reportedVia: 'network-confirmed', networkSignal: detail.type });
            } else if (detail.type === 'moderation') {
                reportResult('submitted', { reportedVia: 'network-moderation', networkSignal: detail.type, reviewPending: true });
            } else if (detail.type === 'rejected') {
                reportResult('failed', { reportedVia: 'network-rejected', networkSignal: detail.type, submissionBlocked: true, submissionBlockReason: 'network-rejected' });
            } else if (detail.type === 'success') {
                reportResult('submitted', { reportedVia: 'network-success', networkSignal: detail.type });
            }
        };
        window.addEventListener('__bla_network_signal', networkSignalHandler);

        // 8 秒超时兜底：如果没收到网络信号，走原有逻辑
        submissionFallbackTimer = setTimeout(() => {
            window.removeEventListener('__bla_network_signal', networkSignalHandler);
            if (!networkSignalReceived) {
                reportResult('submitted', { reportedVia: 'timeout-fallback' });
            }
        }, 8000);
    }

    const FAILURE_REASON_CN = {
        'comment-form-not-found': '找不到评论表单（可能需要滚动到底部或表单被隐藏）',
        'comment-field-empty': '评论框无法填入内容',
        'submit-trigger-failed': '找不到提交按钮或无法点击',
        'workflow-stall-timeout': '操作超时（页面响应太慢）',
        'duplicate-comment-detected': '该页面已经发过相同评论',
        'anchor-mode-unavailable': '该页面不支持锚文本链接',
        'comment-only-form': '该评论区不支持留链接',
        'network-rejected': '评论被网站拒绝（可能触发了反垃圾）',
        'publish-runtime-timeout': '发布超时（页面加载太慢）',
        'submit-confirm-timeout': '提交后等待确认超时',
        'timeout-bootstrap': '页面加载太慢，无法初始化',
        'timeout-preflight': '无法定位评论区（页面可能太长或评论区被隐藏）',
        'timeout-finding_form': '找不到评论表单（可能被懒加载或 JS 动态渲染）',
        'timeout-filling_form': '表单填写超时（字段无法填入）',
        'timeout-generating_comment': 'AI 评论生成超时',
        'timeout-submitting': '提交后等待响应超时'
    };

    function reportResult(result, extraMeta = {}) {
        if (publishResultReported) {
            return;
        }
        publishResultReported = true;
        publishStopped = true;
        clearAutoSubmitTimer();
        clearSubmissionFallbackTimer();
        clearWorkflowStallTimer();
        const startedAt = currentPublishMeta?.publishStartedAt || '';
        const durationMs = startedAt ? Math.max(0, Date.now() - new Date(startedAt).getTime()) : 0;

        // 跳过或失败时显示中文提示
        if (result === 'skipped' || result === 'failed') {
            const reason = extraMeta.reason || extraMeta.submissionBlockReason || extraMeta.terminalFailureReason || '';
            const blockReason = extraMeta.submissionBlockReason || '';
            // 优先匹配更具体的 submissionBlockReason（如 timeout-bootstrap）
            const reasonText = FAILURE_REASON_CN[blockReason] || FAILURE_REASON_CN[reason] || reason || '未知原因';
            const statusText = result === 'skipped' ? '已跳过' : '发布失败';
            showFailureToast(`${statusText}：${reasonText}`);
        }

        chrome.runtime.sendMessage({
            action: 'commentAction',
            resourceId: currentResourceId,
            taskId: currentTaskId,
            sessionId: currentSessionId,
            result,
            meta: { ...(currentPublishMeta || {}), durationMs, ...(extraMeta || {}) }
        });
    }

    function showFailureToast(message) {
        const existing = document.getElementById('bla-failure-toast');
        if (existing) existing.remove();
        const existingOverlay = document.getElementById('bla-failure-overlay');
        if (existingOverlay) existingOverlay.remove();

        const overlay = document.createElement('div');
        overlay.id = 'bla-failure-overlay';
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.5); z-index: 999998;
        `;

        const toast = document.createElement('div');
        toast.id = 'bla-failure-toast';
        toast.innerHTML = `
            <div style="font-size: 28px; margin-bottom: 8px;">⚠️</div>
            <div style="font-size: 18px; font-weight: 600; line-height: 1.5;">${message.replace(/</g, '&lt;')}</div>
            <div style="font-size: 13px; color: rgba(255,255,255,0.7); margin-top: 10px;">3 秒后自动继续...</div>
        `;
        toast.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            z-index: 999999; background: #dc2626; color: white;
            padding: 30px 40px; border-radius: 16px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4);
            text-align: center; min-width: 320px; max-width: 500px;
        `;

        document.body.appendChild(overlay);
        document.body.appendChild(toast);

        setTimeout(() => {
            overlay.style.opacity = '0';
            toast.style.opacity = '0';
            overlay.style.transition = 'opacity 0.3s';
            toast.style.transition = 'opacity 0.3s';
            setTimeout(() => { overlay.remove(); toast.remove(); }, 300);
        }, 3000);
    }

    // 监听来自后台的失败/跳过通知（后台直接跳过时 content script 的 reportResult 不会触发）
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'showPublishFailure' && msg.message) {
            showFailureToast(msg.message);
        }
    });

    async function triggerSubmitAction(form, submitBtn) {
        const readySubmitBtn = await waitForSubmitButtonReady(submitBtn);

        if (readySubmitBtn) {
            readySubmitBtn.focus?.();
            try {
                readySubmitBtn.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
            } catch {}
            dispatchSubmitPointerEvents(readySubmitBtn);
        }

        if (typeof form?.requestSubmit === 'function') {
            try {
                form.requestSubmit(readySubmitBtn || undefined);
                return true;
            } catch {}
        }

        if (readySubmitBtn) {
            try {
                readySubmitBtn.click();
                return true;
            } catch {}
        }

        try {
            const accepted = form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            if (!accepted) {
                return false;
            }
        } catch {}

        try {
            HTMLFormElement.prototype.submit.call(form);
            return true;
        } catch {}

        try {
            form.submit();
            return true;
        } catch {}

        return false;
    }

    async function waitForSubmitButtonReady(submitBtn, timeoutMs = 1800) {
        if (!submitBtn) return null;
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (!isSubmitControlDisabled(submitBtn)) {
                return submitBtn;
            }
            await wait(120);
        }
        return submitBtn;
    }

    function isSubmitControlDisabled(el) {
        if (!el) return true;
        if (el.disabled) return true;
        const ariaDisabled = compactText(el.getAttribute?.('aria-disabled') || '').toLowerCase();
        if (ariaDisabled === 'true') return true;
        const className = compactText(el.className || '').toLowerCase();
        if (/\bdisabled\b/.test(className)) return true;
        return false;
    }

    function dispatchSubmitPointerEvents(el) {
        if (!el) return;
        const mouseOptions = { bubbles: true, cancelable: true, view: window };
        const pointerOptions = { bubbles: true, cancelable: true, pointerType: 'mouse', isPrimary: true };
        const events = [
            () => typeof PointerEvent === 'function' ? new PointerEvent('pointerdown', pointerOptions) : null,
            () => new MouseEvent('mousedown', mouseOptions),
            () => typeof PointerEvent === 'function' ? new PointerEvent('pointerup', pointerOptions) : null,
            () => new MouseEvent('mouseup', mouseOptions),
            () => new MouseEvent('click', mouseOptions)
        ];

        for (const createEvent of events) {
            try {
                const event = createEvent();
                if (event) {
                    el.dispatchEvent(event);
                }
            } catch {}
        }
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
        clearSubmissionFallbackTimer();
        clearWorkflowStallTimer();
        addDebugEvent('field', 'Publish session stopped by user');
        removeDialog();
    }

    function clearAutoSubmitTimer() {
        if (autoSubmitTimer) {
            clearTimeout(autoSubmitTimer);
            autoSubmitTimer = null;
        }
    }

    function clearSubmissionFallbackTimer() {
        if (submissionFallbackTimer) {
            clearTimeout(submissionFallbackTimer);
            submissionFallbackTimer = null;
        }
    }

    function clearWorkflowStallTimer() {
        if (workflowStallTimer) {
            clearTimeout(workflowStallTimer);
            workflowStallTimer = null;
        }
    }

    // 保存当前超时参数，供 poke 时重新启动
    let _stallTimerContext = null;
    let _stallTimerTimeoutMs = 0;

    function armWorkflowStallTimer(context, overrideTimeoutMs = null) {
        if (!context || context.mode !== 'full-auto' || currentDebugMode) {
            return;
        }
        clearWorkflowStallTimer();
        const timeoutMs = Number(overrideTimeoutMs || 0)
            || Number(context.execution?.workflowStallTimeoutMs || 0)
            || WORKFLOW_STALL_TIMEOUT_MS;
        _stallTimerContext = context;
        _stallTimerTimeoutMs = timeoutMs;
        _startStallTimeout(timeoutMs);
    }

    function _startStallTimeout(timeoutMs) {
        workflowStallTimer = setTimeout(() => {
            workflowStallTimer = null;
            if (publishStopped) return;
            const currentStage = currentPublishMeta?.workflowStage || 'unknown';
            const stageReasons = {
                'bootstrap': '页面加载太慢，无法初始化',
                'preflight': '无法定位评论区（页面可能太长或评论区被隐藏）',
                'finding_form': '找不到评论表单（可能被懒加载或 JS 动态渲染）',
                'form_detected': '表单已找到但无法交互',
                'generating_comment': 'AI 评论生成超时',
                'comment_ready': '评论内容准备超时',
                'filling_form': '表单填写超时（字段无法填入）',
                'form_filled': '表单填写后验证超时',
                'pre_submit': '提交前准备超时',
                'submitting': '提交后等待响应超时'
            };
            addDebugEvent('field', `Workflow stalled at ${currentStage}; aborting current resource`);
            reportResult('failed', {
                reason: 'workflow-stall-timeout',
                terminalFailureReason: 'workflow_stall_timeout',
                submissionBlocked: true,
                submissionBlockReason: `timeout-${currentStage}`
            });
        }, timeoutMs);
    }

    /**
     * 活动心跳：只要插件还在干活（打字、填字段、等 AI），就重置超时计时器。
     * 只有真正卡死不动时才会超时。
     */
    function pokeWorkflowStallTimer() {
        if (!workflowStallTimer || !_stallTimerContext) return;
        clearTimeout(workflowStallTimer);
        _startStallTimeout(_stallTimerTimeoutMs);
    }

    /**
     * 暂停超时计时器（打字期间调用）。
     * 打字过程中不允许超时触发，因为正在打字说明一切正常。
     */
    function pauseWorkflowStallTimer() {
        if (workflowStallTimer) {
            clearTimeout(workflowStallTimer);
            // 不清空 workflowStallTimer 引用，这样 resume 时知道之前有计时器
        }
    }

    /**
     * 恢复超时计时器（打字完成后调用）。
     */
    function resumeWorkflowStallTimer() {
        if (_stallTimerContext && _stallTimerTimeoutMs > 0) {
            clearWorkflowStallTimer();
            _startStallTimeout(_stallTimerTimeoutMs);
        }
    }

    // 暴露到 window，供 comment-executor.js 调用
    window.pokeWorkflowStallTimer = pokeWorkflowStallTimer;
    window.pauseWorkflowStallTimer = pauseWorkflowStallTimer;
    window.resumeWorkflowStallTimer = resumeWorkflowStallTimer;

    function getStageTimeoutMs(context, stage = '') {
        const profileId = compactText(context?.execution?.id || 'ai') || 'ai';
        return Number(WORKFLOW_STAGE_TIMEOUTS[stage]?.[profileId] || 0)
            || Number(context?.execution?.workflowStallTimeoutMs || 0)
            || WORKFLOW_STALL_TIMEOUT_MS;
    }

    function estimateFormFillTimeoutMs(context, values = {}) {
        const profileId = compactText(context?.execution?.id || 'ai') || 'ai';
        const baseTimeoutMs = getStageTimeoutMs(context, 'filling_form');
        const commentLength = compactText(values?.comment || '').length;
        const activeFieldCount = ['name', 'email', 'website']
            .reduce((count, field) => count + (compactText(values?.[field] || '') ? 1 : 0), 0);
        const perCharMs = context?.execution?.preferHumanTypingForComment === false ? 8 : 24;
        const typingCostMs = Math.min(16000, commentLength * perCharMs);
        const fieldCostMs = activeFieldCount * 1200;
        const minByProfile = profileId === 'fast' ? 12000 : profileId === 'hybrid' ? 16000 : 22000;
        return Math.max(baseTimeoutMs, minByProfile, 3000 + typingCostMs + fieldCostMs);
    }

    function updateWorkflowProgress(context, stage = '', stageLabel = '', options = {}) {
        const normalizedStage = compactText(stage || '');
        const normalizedLabel = compactText(stageLabel || '');
        if (!normalizedStage) return;

        currentPublishMeta = {
            ...(currentPublishMeta || {}),
            workflowStage: normalizedStage,
            workflowStageLabel: normalizedLabel,
            workflowStageAt: new Date().toISOString()
        };

        const timeoutMs = Number(options.timeoutMs || 0) || getStageTimeoutMs(context, normalizedStage);
        armWorkflowStallTimer(context, timeoutMs);

        chrome.runtime.sendMessage({
            action: 'commentProgress',
            resourceId: currentResourceId,
            taskId: currentTaskId,
            sessionId: currentSessionId,
            stage: normalizedStage,
            stageLabel: normalizedLabel,
            stageTimeoutMs: timeoutMs
        }).catch(() => {});
    }

    function resolveWorkflow(workflow) {
        if (workflow?.steps?.length) {
            return cloneValue(workflow);
        }
        return cloneValue(LOCAL_DEFAULT_WORKFLOW);
    }

    function resolveExecutionProfile(context) {
        if (!context?.useAI) {
            return { ...EXECUTION_PROFILES.fast };
        }

        const resource = context?.resource || {};
        const opportunities = new Set(resource?.opportunities || []);
        const linkModes = new Set(resource?.linkModes || []);
        const detailsText = compactText((resource?.details || []).join(' ')).toLowerCase();
        const linkMethod = compactText(resource?.linkMethod || '').toLowerCase();
        const wantsStrictAnchorHtml = isStrictAnchorCommentStyle(context?.data?.commentStyle);
        const explicitComplexSignals =
            resource?.aiClassified
            || opportunities.has('rich-editor')
            || opportunities.has('disqus')
            || /contenteditable|rich-editor|prosemirror|tinymce|ckeditor|captcha|disqus|iframe|shadow-root/i.test(detailsText);
        const looksLikeStandardCommentResource =
            opportunities.has('comment')
            && (
                linkMethod === 'website-field'
                || linkMethod === 'html'
                || linkModes.has('markdown-link')
                || linkModes.has('bbcode-link')
                || linkModes.has('plain-url')
                || /inline-submit-form|textarea\+url\+submit|commentform|wp-comments-post|website-field/.test(detailsText)
            );

        if (looksLikeStandardCommentResource && !wantsStrictAnchorHtml && !explicitComplexSignals) {
            return { ...EXECUTION_PROFILES.fast };
        }

        if (!explicitComplexSignals) {
            return { ...EXECUTION_PROFILES.hybrid };
        }

        return { ...EXECUTION_PROFILES.ai };
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
        const linkMode = resolveInlineLinkMode(context, anchorText, anchorUrl);
        const allowAnchorHtml = linkMode === 'raw-html-anchor' || linkMode === 'rich-editor-anchor';

        return {
            mode,
            anchorText,
            anchorUrl,
            allowAnchorHtml,
            linkMode,
            useInlineLink: !!linkMode
        };
    }

    function resolveInlineLinkMode(context, anchorText, anchorUrl) {
        if (!anchorUrl) return '';

        const resourceModes = Array.from(new Set((context?.resource?.linkModes || []).filter(Boolean)));
        const templateMode = compactText(context?.siteTemplate?.linkMode || '');
        const wantsAnchorMode = isAnyAnchorCommentStyle(context?.data?.commentStyle);
        const runtimeModes = getRuntimeSupportedInlineModes(context.form, context.aiFormInfo, context.siteTemplate);
        const supportedModes = resourceModes.filter((mode) =>
            isSupportedInlineLinkMode(mode) && runtimeModes.includes(mode)
        );
        const wantedModes = wantsAnchorMode
            ? ['raw-html-anchor', 'rich-editor-anchor']
            : ['markdown-link', 'bbcode-link', 'plain-url', 'raw-html-anchor', 'rich-editor-anchor'];
        const eligibleModes = supportedModes.filter((mode) => wantedModes.includes(mode));
        const shouldForceInlineLink = wantsAnchorMode || (!!currentPublishMeta?.websiteOmitted && supportedModes.length > 0);

        if (!shouldForceInlineLink) {
            return '';
        }

        if (eligibleModes.length === 0) {
            if (wantsAnchorMode && pageAllowsHtmlLinks(context.form, context.resource, context.aiFormInfo, context.siteTemplate)) {
                return 'raw-html-anchor';
            }
            return '';
        }

        if (templateMode && eligibleModes.includes(templateMode)) {
            return templateMode;
        }

        for (const mode of wantedModes) {
            if (eligibleModes.includes(mode)) {
                if ((mode === 'raw-html-anchor' || mode === 'rich-editor-anchor')
                    && !pageAllowsHtmlLinks(context.form, context.resource, context.aiFormInfo, context.siteTemplate)) {
                    continue;
                }
                if (!anchorText && mode !== 'plain-url') {
                    continue;
                }
                return mode;
            }
        }

        return '';
    }

    function formHasWebsiteField(form) {
        if (!form) return false;
        return !!form.querySelector('input[name="url"], input#url, input[name="website"], input#website, input[type="url"], input[name="homepage"]');
    }

    function formHasIdentityFields(form) {
        if (!form) return false;
        return !!form.querySelector(
            'input[name="author"], input#author, input[name="name"], input#name, input[name="email"], input#email'
        );
    }

    function formHasCommentEditor(form) {
        if (!form) return false;
        return !!form.querySelector('textarea, [contenteditable="true"], .ql-editor, .ProseMirror, .mce-content-body');
    }

    function hasVerifiedInlineCapability(form, context) {
        return getRuntimeSupportedInlineModes(form, context?.aiFormInfo, context?.siteTemplate).length > 0;
    }

    function shouldSkipCommentOnlyDirectPublish(context) {
        const form = context?.form;
        if (!form) return false;

        const wantsDirectLink = !!compactText(context?.values?.website || '')
            || isAnyAnchorCommentStyle(context?.data?.commentStyle);
        if (!wantsDirectLink) return false;

        if (!formHasCommentEditor(form)) return false;
        if (formHasWebsiteField(form)) return false;
        if (formHasIdentityFields(form)) return false;
        if (hasVerifiedInlineCapability(form, context)) return false;

        return true;
    }

    function shouldSkipUnavailableAnchorPublish(context) {
        if (!isStrictAnchorCommentStyle(context?.data?.commentStyle)) return false;
        const form = context?.form;
        if (!form) return false;
        const runtimeModes = getRuntimeSupportedInlineModes(form, context?.aiFormInfo, context?.siteTemplate);
        const resolvedMode = compactText(context?.anchorOptions?.linkMode || '');
        const htmlCapable = runtimeModes.includes('raw-html-anchor') || runtimeModes.includes('rich-editor-anchor');
        return !htmlCapable || !['raw-html-anchor', 'rich-editor-anchor'].includes(resolvedMode);
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

    function ensureLinkComment(comment, anchorOptions) {
        const baseComment = compactText(comment || '');
        if (!anchorOptions.useInlineLink || !anchorOptions.anchorUrl) {
            return baseComment;
        }

        const inlineMarkup = buildInlineLinkMarkup(anchorOptions);
        if (!inlineMarkup) {
            return baseComment;
        }

        if (anchorOptions.linkMode === 'raw-html-anchor' || anchorOptions.linkMode === 'rich-editor-anchor') {
            if (/<a\b[^>]*href\s*=/i.test(baseComment)) {
                return baseComment.replace(
                    /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/i,
                    inlineMarkup
                );
            }
        }
        if (anchorOptions.linkMode === 'markdown-link' && /\[[^\]]+\]\(([^)]+)\)/i.test(baseComment)) {
            return baseComment.replace(/\[[^\]]+\]\(([^)]+)\)/i, inlineMarkup);
        }
        if (anchorOptions.linkMode === 'bbcode-link' && /\[url(?:=[^\]]+)?\][\s\S]*?\[\/url\]/i.test(baseComment)) {
            return baseComment.replace(/\[url(?:=[^\]]+)?\][\s\S]*?\[\/url\]/i, inlineMarkup);
        }

        const variants = buildAnchorUrlVariants(anchorOptions.anchorUrl);
        for (const variant of variants) {
            const replaced = replaceFirstCaseInsensitive(baseComment, variant, inlineMarkup);
            if (replaced !== baseComment) {
                return replaced;
            }
        }

        if (anchorOptions.anchorText && anchorOptions.linkMode !== 'plain-url') {
            const replacedAnchorText = replaceFirstCaseInsensitive(baseComment, anchorOptions.anchorText, inlineMarkup);
            if (replacedAnchorText !== baseComment) {
                return replacedAnchorText;
            }
        }

        const anchorSentence = buildInlineLinkSentence(anchorOptions, inlineMarkup);
        if (!baseComment) {
            return anchorSentence;
        }
        if (/[.!?]["']?$/.test(baseComment)) {
            return `${baseComment} ${anchorSentence}`;
        }
        return `${baseComment}. ${anchorSentence}`;
    }

    function buildInlineLinkMarkup(anchorOptions = {}) {
        const anchorText = compactText(anchorOptions.anchorText || '');
        const anchorUrl = compactText(anchorOptions.anchorUrl || '');
        if (!anchorUrl) return '';

        switch (anchorOptions.linkMode) {
            case 'raw-html-anchor':
            case 'rich-editor-anchor':
                if (!anchorText) return '';
                return `<a href="${escapeHtml(anchorUrl)}">${escapeHtml(anchorText)}</a>`;
            case 'markdown-link':
                if (!anchorText) return '';
                return `[${anchorText}](${anchorUrl})`;
            case 'bbcode-link':
                if (!anchorText) return '';
                return `[url=${anchorUrl}]${anchorText}[/url]`;
            case 'plain-url':
                return anchorUrl;
            default:
                return '';
        }
    }

    function buildInlineLinkSentence(anchorOptions = {}, inlineMarkup = '') {
        if (!inlineMarkup) return '';
        if (anchorOptions.linkMode === 'plain-url') {
            if (anchorOptions.anchorText) {
                return `For readers exploring this further, ${anchorOptions.anchorText}: ${inlineMarkup}`;
            }
            return `For readers exploring this further, ${inlineMarkup}`;
        }
        return `For readers exploring this further, ${inlineMarkup} is worth a look.`;
    }

    function isSupportedInlineLinkMode(mode) {
        return [
            'raw-html-anchor',
            'rich-editor-anchor',
            'markdown-link',
            'bbcode-link',
            'plain-url'
        ].includes(compactText(mode || ''));
    }

    function commentContainsInlineLink(comment = '') {
        const normalized = String(comment || '');
        return (
            /<a\b[^>]*href\s*=/i.test(normalized)
            || /\[[^\]]+\]\(([^)]+)\)/i.test(normalized)
            || /\[url(?:=[^\]]+)?\][\s\S]*?\[\/url\]/i.test(normalized)
            || /\bhttps?:\/\/[^\s<>"')\]]+/i.test(normalized)
        );
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

    function pageShowsExistingCommentBodyAnchors(form) {
        const roots = [];
        const scopedRoot = form?.closest?.('#comments, .comments-area, .commentlist, .comment-list, .post-comments, article, main');
        if (scopedRoot) roots.push(scopedRoot);
        roots.push(document);

        const excludedSelectors = [
            '.comment-author',
            '.fn',
            '.avatar',
            '.reply',
            '.comment-reply-link',
            '.comment-meta',
            '.commentmetadata',
            '.comment-edit-link',
            '.says',
            '.navigation',
            '.nav-links'
        ].join(', ');

        const selectors = [
            '.comment-content a[href]',
            '.comment-body a[href]',
            '.comments-area p a[href]',
            '#comments p a[href]',
            'li.comment p a[href]',
            'article.comment p a[href]'
        ].join(', ');

        for (const root of roots) {
            const anchors = Array.from(root.querySelectorAll(selectors));
            for (const anchor of anchors) {
                if (!(anchor instanceof HTMLAnchorElement)) continue;
                const href = compactText(anchor.getAttribute('href') || '');
                const text = compactText(anchor.textContent || '');
                if (!href || /^#|^(javascript|mailto|tel):/i.test(href)) continue;
                if (anchor.closest(excludedSelectors)) continue;
                if (text.length < 2) continue;
                const block = anchor.closest('.comment-content, .comment-body, li.comment, article.comment, .comment, p, div');
                const blockText = compactText(block?.textContent || '');
                if (blockText.length < 24) continue;
                return true;
            }
        }

        return false;
    }

    function pageAllowsHtmlLinks(form, resource, aiFormInfo, siteTemplate) {
        if (!form) return false;

        const templateMode = compactText(siteTemplate?.linkMode || '');
        if (templateMode === 'raw-html-anchor' || templateMode === 'rich-editor-anchor') {
            return true;
        }

        if (form.querySelector('[contenteditable="true"], .ql-editor, .ProseMirror, .mce-content-body, .tox-edit-area, .note-editable')) {
            return true;
        }

        if (form.querySelector(
            '[aria-label*="link" i], [title*="link" i], [data-command="link"], .ql-link, .mce-i-link, .note-btn[data-event="showLinkDialog"]'
        )) {
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

        if (pageShowsExistingCommentBodyAnchors(form)) {
            return true;
        }

        return false;
    }

    function getRuntimeSupportedInlineModes(form, aiFormInfo, siteTemplate) {
        const modes = [];
        const formText = compactText(form?.textContent || '').toLowerCase();

        if (pageAllowsHtmlLinks(form, null, aiFormInfo, siteTemplate)) {
            if (form?.querySelector('[contenteditable="true"], .ql-editor, .ProseMirror, .mce-content-body, .tox-edit-area, .note-editable')) {
                modes.push('rich-editor-anchor');
            } else {
                modes.push('raw-html-anchor');
            }
        }

        if (/markdown|commonmark|supports markdown|markdown editor|use markdown|支持markdown|使用markdown/.test(formText)) {
            modes.push('markdown-link');
        }

        if (/bbcode|ubb|bulletin board code|支持bbcode|\[url/.test(formText)) {
            modes.push('bbcode-link');
        }

        if (/autolink|linkify|plain url|bare url|paste a url|paste url|urls? will be linked|自动识别链接|自动转链接/.test(formText)) {
            modes.push('plain-url');
        }

        return Array.from(new Set(modes));
    }

    async function waitForCommentForm(context, options = {}) {
        const timeoutMs = Number(options.timeoutMs || 0) || 20000;
        const pollMs = Number(options.pollMs || 0) || 1200;
        const aiTimeoutMs = Number(options.aiTimeoutMs || 0) || 3000;
        const maxTimeoutMs = timeoutMs + 10000; // 硬性上限，防止无限循环
        const start = Date.now();
        let aiAttempted = false;

        while (!publishStopped && Date.now() - start < maxTimeoutMs) {
            const standardForm = findStandardCommentForm();
            if (standardForm) {
                return standardForm;
            }
            await primeCommentSectionSearch(context, {
                immediate: Date.now() - start < 2400,
                forceProgressiveScroll: Date.now() - start < 4000
            });
            const dismissed = dismissConsentAndCookieBanners();
            if (dismissed > 0) {
                await wait(250);
            }
            const ruleForm = findFormByRules();
            if (ruleForm && formHasInteractiveFields(ruleForm)) {
                return ruleForm;
            }

            if (options.useAI) {
                const shouldRefreshAI = !aiAttempted || !context.aiFormInfo?.hasForm;
                if (shouldRefreshAI) {
                    try {
                        const formAreaHtml = getCommentAreaHtml();
                        if (formAreaHtml) {
                            addDebugEvent('field', 'Analyzing form with AI');
                            context.aiFormInfo = await sendRuntimeMessageWithTimeout({
                                action: 'aiExtractForm',
                                html: formAreaHtml
                            }, aiTimeoutMs, 'AI form extraction');
                            aiAttempted = true;
                            if (context.aiFormInfo?.hasForm) {
                                addDebugEvent('field', `AI detected form selector: ${context.aiFormInfo.formSelector || 'unknown'}`);
                            }
                        }
                    } catch (e) {
                        aiAttempted = true;
                        console.log('[BLA] AI 表单识别失败，回退到规则匹配:', e);
                        addDebugEvent('field', `AI form analysis unavailable, using rules: ${e.message}`);
                    }
                }
            }

            let form = null;
            if (context.aiFormInfo?.hasForm && context.aiFormInfo.formSelector) {
                form = document.querySelector(context.aiFormInfo.formSelector);
            }
            if (!form) {
                form = findFormByRules();
            }
            if (form && formHasInteractiveFields(form)) {
                return form;
            }

            await wait(pollMs);
        }

        // 最后一搏 #1：页面上只有一个"像样的"带 textarea 表单 → 直接用
        // 规则打分把所有候选都判负时救回来（常见于非标准评论系统）
        try {
            const allForms = Array.from(document.querySelectorAll('form')).filter((f) => {
                if (!formHasInteractiveFields(f)) return false;
                if (!f.querySelector('textarea, [contenteditable="true"], .ql-editor, .ProseMirror, .mce-content-body')) return false;
                const sig = `${f.id || ''} ${f.className || ''} ${f.getAttribute?.('action') || ''}`.toLowerCase();
                if (/search|login|signin|register/.test(sig)) return false;
                return true;
            });
            if (allForms.length === 1) {
                addDebugEvent('field', 'Last-ditch: using sole textarea form on page');
                return allForms[0];
            }
        } catch (e) {
            console.log('[BLA] Last-ditch textarea scan failed:', e);
        }

        // 最后一搏 #2：强制 AI 兜底一次（即使执行档位默认关 AI）
        // 规则完全失败时，一次 AI 调用换一个资源比直接放弃更划算
        if (!aiAttempted && !publishStopped) {
            try {
                const formAreaHtml = getCommentAreaHtml();
                if (formAreaHtml) {
                    addDebugEvent('field', 'Last-ditch AI form extraction');
                    const aiInfo = await sendRuntimeMessageWithTimeout({
                        action: 'aiExtractForm',
                        html: formAreaHtml
                    }, Math.max(aiTimeoutMs, 3500), 'AI form extraction (last-ditch)');
                    context.aiFormInfo = aiInfo || context.aiFormInfo;
                    if (aiInfo?.hasForm && aiInfo.formSelector) {
                        const aiForm = document.querySelector(aiInfo.formSelector);
                        if (aiForm && formHasInteractiveFields(aiForm)) {
                            addDebugEvent('field', `Last-ditch AI located form: ${aiInfo.formSelector}`);
                            return aiForm;
                        }
                    }
                }
            } catch (e) {
                console.log('[BLA] Last-ditch AI 兜底失败:', e);
                addDebugEvent('field', `Last-ditch AI failed: ${e.message}`);
            }
        }

        return null;
    }

    function getCommentPreflight() {
        return window.CommentPreflight || null;
    }

    function getStandardCommentFlow() {
        return window.CommentStandardFlow || null;
    }

    function getCommentFormDetection() {
        return window.CommentFormDetection || null;
    }

    async function primeCommentSectionSearch(context = {}, options = {}) {
        const preflight = getCommentPreflight();
        if (!preflight?.primeCommentSectionSearch) {
            return false;
        }
        return await preflight.primeCommentSectionSearch(context, options);
    }

    function findExistingCommentByCommenter(context = {}) {
        return getCommentPreflight()?.findExistingCommentByCommenter?.(context) || null;
    }

    function prepareFormForInteraction(form) {
        return getCommentPreflight()?.prepareFormForInteraction?.(form);
    }

    function dismissConsentAndCookieBanners() {
        return getCommentPreflight()?.dismissConsentAndCookieBanners?.() || 0;
    }

    function formHasInteractiveFields(form) {
        const detection = getCommentFormDetection();
        if (detection?.formHasInteractiveFields) {
            return detection.formHasInteractiveFields(form);
        }
        return false;
    }

    function shouldUseClassicCommentFastPath(form) {
        return !!getStandardCommentFlow()?.isStandardCommentForm?.(form);
    }

    async function fillClassicCommentFormFast(form, values = {}) {
        return await getStandardCommentFlow()?.fillStandardCommentForm?.(form, values) || {
            commentFilled: false,
            commentSelector: ''
        };
    }

    function findSubmitButton(form, aiFormInfo) {
        const candidates = [];

        // 1. AI 已识别的提交按钮选择器
        if (aiFormInfo?.submitSelector) {
            candidates.push(form.querySelector(aiFormInfo.submitSelector) || document.querySelector(aiFormInfo.submitSelector));
        }

        // 2. CSS 选择器规则匹配
        const selectorCandidates = [
            'button[type="submit"]',
            'input[type="submit"]',
            'button#submit',
            'button[name="submit"]',
            '.submit button',
            '.submit input[type="submit"]',
            '.comment-form button',
            '.comment-respond button'
        ];
        selectorCandidates.forEach((selector) => {
            candidates.push(form.querySelector(selector));
        });

        // 3. 关键词文字匹配
        const textButtons = Array.from(form.querySelectorAll('button, input[type="button"], input[type="submit"], a[role="button"]'))
            .filter((el) => {
                if (!isVisible(el)) return false;
                const text = compactText(
                    `${el.textContent || ''} ${el.value || ''} ${el.getAttribute?.('aria-label') || ''}`
                ).toLowerCase();
                return /(submit|post comment|post|reply|send|publish|发表评论|提交|发送|评论|antworten|kommentar)/.test(text);
            });
        candidates.push(...textButtons);

        const ruleResult = candidates.find(Boolean);
        if (ruleResult) return ruleResult;

        // 4. 规则都找不到时，用表单内唯一可见按钮兜底
        const allVisibleButtons = Array.from(form.querySelectorAll('button, input[type="submit"], input[type="button"]'))
            .filter((el) => isVisible(el) && !el.disabled);
        if (allVisibleButtons.length === 1) {
            addDebugEvent('field', `Submit button found by single-button fallback: ${describeElementForMeta(allVisibleButtons[0])}`);
            return allVisibleButtons[0];
        }

        return null;
    }

    /**
     * AI 识别提交按钮（当规则找不到时调用）
     * 截取表单 HTML 发给 AI，让 AI 返回提交按钮的 CSS 选择器
     */
    async function findSubmitButtonWithAI(form) {
        if (!form) return null;
        try {
            const formHtml = form.outerHTML.substring(0, 3000);
            const result = await sendRuntimeMessageWithTimeout({
                action: 'aiExtractForm',
                html: formHtml
            }, 3500, 'AI submit button detection');
            if (result?.submitSelector) {
                const btn = form.querySelector(result.submitSelector) || document.querySelector(result.submitSelector);
                if (btn && isVisible(btn)) {
                    addDebugEvent('field', `Submit button found by AI: ${result.submitSelector}`);
                    return btn;
                }
            }
        } catch (e) {
            addDebugEvent('field', `AI submit detection failed: ${e.message}`);
        }
        return null;
    }

    function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function simulateFieldTyping(el, value, options = {}) {
        const nextValue = String(value || '');
        if (!el || !nextValue) return;

        el.focus?.();
        if (el.setSelectionRange) {
            try {
                const end = Number(el.value?.length || 0);
                el.setSelectionRange(0, end);
            } catch {}
        }

        writeElementValue(el, '');
        dispatchFieldInputEvents(el);

        const minDelay = Number(options.minDelay || 10);
        const maxDelay = Math.max(minDelay, Number(options.maxDelay || 40));
        for (const character of nextValue) {
            el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: character }));
            writeElementValue(el, `${readElementValue(el)}${character}`);
            dispatchFieldInputEvents(el);
            el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: character }));
            await wait(Math.floor(minDelay + Math.random() * (maxDelay - minDelay + 1)));
        }

        dispatchFieldChangeEvents(el);
        el.blur?.();
    }

    function sendRuntimeMessageWithTimeout(message, timeoutMs, label = 'runtime message') {
        const timeout = Number(timeoutMs || 0) || 10000;
        return Promise.race([
            chrome.runtime.sendMessage(message),
            new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`${label} timed out after ${timeout}ms`));
                }, timeout);
            })
        ]);
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

            // 反垃圾复选框（英文）
            const isAntiSpam = /(not a spammer|not spam|anti spam|anti-spam|human|robot|i am human|i'm human|confirm[^.]*spammer|confirm[^.]*human|agree[^.]*spammer|agree[^.]*human)/.test(contextText);

            // 隐私/数据保护/同意复选框（多语言）
            const isPrivacyConsent = /(datenschutz|privacy|daten.*schutz|datenschutzbestimmungen|datenschutzerklärung|privacidad|protección de datos|politique de confidentialité|protezione dei dati|privacybeleid|gegevensbescherming|política de privacidade|polityka prywatności|gizlilik|zasady|gdpr|rgpd|dsgvo|cookie|consent|i agree|i accept|agree to|accept the|akzeptier|accepteer|acepto|accetto|j'accepte|zgadzam|kabul|同意|接受|同意する|동의|согласен|أوافق|隐私|privacy policy|terms|条款)/.test(contextText);

            if (isAntiSpam || isPrivacyConsent) {
                setCheckboxValue(checkbox, true);
                markDebugElement(checkbox, 'checkbox');
                addDebugEvent('checkbox', `Checked "${truncateText(contextText, 80)}"`);
                checkedCount++;
            }
        });

        if (currentDebugMode && checkedCount === 0) {
            addDebugEvent('checkbox', 'No anti-spam/privacy checkbox matched by rules');
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

    function describeElementForMeta(el) {
        if (!el) return '';
        if (el.id) return `#${el.id}`;
        if (el.name) return `${(el.tagName || '').toLowerCase()}[name="${el.name}"]`;
        const className = compactText(String(el.className || '').split(/\s+/).slice(0, 3).join('.'));
        if (className) {
            return `${(el.tagName || '').toLowerCase()}.${className}`;
        }
        return (el.tagName || '').toLowerCase();
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
