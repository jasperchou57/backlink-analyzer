const PublishRuntime = {
    TAB_PRIME_DELAY_MS: 3500,
    COMMENT_SECTION_HASH: 'comments',
    SUCCESS_REVIEW_DELAY_MS: 6000,
    PENDING_REVIEW_DELAY_MS: 8000,

    createSessionId() {
        if (globalThis.crypto?.randomUUID) {
            return globalThis.crypto.randomUUID();
        }
        return `publish-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    },

    createInitialState(task, queue, workflowId, overrides = {}) {
        return {
            ...TaskManager.createDefaultPublishState(),
            sessionId: overrides.sessionId || this.createSessionId(),
            currentTask: task || null,
            queue: queue || [],
            currentWorkflowId: workflowId || null,
            currentUrl: queue?.[0]?.url || '',
            isPublishing: true,
            ...overrides
        };
    },

    getPublishLimitMetric(task, state = {}) {
        // 锚文本相关模式（严格 anchor-html 或 优先 anchor-prefer）都按 anchor success 计数
        const isAnchorLimit = task?.commentStyle === 'anchor-html' || task?.commentStyle === 'anchor-prefer';
        return {
            isAnchorLimit,
            count: isAnchorLimit
                ? Number(state.sessionAnchorSuccessCount || 0)
                : Number(state.sessionPublishedCount || 0),
            label: isAnchorLimit ? '成功锚文本外链' : '成功发布'
        };
    },

    async start(ctx, task, options = {}) {
        const runtimeTask = ctx.buildWorkflowTask(task);
        let startResult = null;

        await TaskRunner.run(runtimeTask, {
            handlers: {
                prepare_queue: async () => {
                    startResult = await this.prepareQueue(ctx, task, options);
                    return { stop: !startResult?.success };
                },
                dispatch_queue: async () => {
                    if (!startResult?.success) {
                        return { stop: true };
                    }
                    await this.dispatchQueue(ctx);
                    return { stop: true };
                }
            }
        });

        return startResult || {
            success: false,
            code: 'publish_runtime_unavailable',
            message: '发布运行时未返回结果'
        };
    },

    async prepareQueue(ctx, task, options = {}) {
        if (ctx.getState().isPublishing) {
            await ctx.logger.publish('当前任务已有发布会话在运行，请先暂停当前任务后再启动新的任务');
            return {
                success: false,
                code: 'already_running',
                message: '当前任务已经在发布中。'
            };
        }

        const resources = await ctx.getResources();
        const workflow = ctx.getPublishWorkflow(task);
        const policies = await ctx.getAllDomainPublishPolicies();
        const siteTemplates = await ctx.getSiteTemplates?.() || {};
        const workflowSupported = resources.filter((resource) => ctx.workflowSupportsResource(workflow, resource, task));
        const workflowPending = workflowSupported.filter((resource) => (ctx.getResourcePool?.(resource) || '') !== 'quarantine');
        const pendingAll = workflowPending.filter((resource) => ctx.canPublishResourceForTask(resource, task));
        const pendingReadyBase = pendingAll.filter((resource) => !ctx.isResourceCoolingDown(resource, policies));
        const dispatchSelection = ctx.selectDispatchResources?.(pendingReadyBase) || {
            activePool: '',
            counts: {},
            resources: pendingReadyBase
        };
        const maxPublishes = Number(task?.maxPublishes) > 0 ? Number(task.maxPublishes) : 0;
        const pendingBase = [...(dispatchSelection.resources || [])]
            .map((resource) => ({
                resource,
                priority: Number(ctx.getPublishCandidatePriority(resource, task) || 0),
                ranking: Number(
                    ctx.getResourcePublishRankingScore?.(resource, task, siteTemplates)
                    ?? ctx.getPublishCandidatePriority(resource, task)
                    ?? 0
                )
            }))
            .sort((left, right) => {
                const rankingDiff = right.ranking - left.ranking;
                if (rankingDiff !== 0) return rankingDiff;
                const priorityDiff = right.priority - left.priority;
                if (priorityDiff !== 0) return priorityDiff;
                return String(right.resource.discoveredAt || '').localeCompare(String(left.resource.discoveredAt || ''));
            })
            .map((entry) => entry.resource);
        const pending = ctx.interleaveResourcesByDomain(pendingBase);

        if (pending.length === 0) {
            const hasWorkflowPending = workflowPending.length > 0;
            const targetUrl = ctx.getTaskPublishTarget(task).url || task.website || '';
            const hasOnlyCooldownBlocked = pendingAll.length > 0 && pendingReadyBase.length === 0;
            const hasOnlyQuarantine = workflowSupported.length > 0 && workflowPending.length === 0;
            const message = hasOnlyCooldownBlocked
                ? '当前可发资源都处于域名冷却中，请稍后再试。'
                : hasOnlyQuarantine
                    ? '当前资源都已进入隔离池，请先重建主池或人工复核旧池资源。'
                : hasWorkflowPending
                    ? '当前网站之前已经发过这些资源了，没有新的可发资源。'
                    : '当前没有可直接发布的外链页面资源。';

            await ctx.logger.publish('没有找到可用于当前网站且未发布过的资源', {
                workflowId: workflow?.id || ctx.defaultWorkflowId,
                target: targetUrl,
                workflowPending: workflowPending.length,
                cooldownBlocked: pendingAll.length - pendingReadyBase.length,
                poolCounts: dispatchSelection.counts
            });

            return {
                success: false,
                code: hasOnlyCooldownBlocked
                    ? 'domain_cooldown_active'
                    : hasOnlyQuarantine
                        ? 'resource_pool_quarantined'
                    : hasWorkflowPending
                        ? 'site_history_exhausted'
                        : 'no_pending_resources',
                message,
                workflowPending: workflowPending.length,
                eligiblePending: pendingAll.length,
                readyPending: pendingReadyBase.length,
                poolCounts: dispatchSelection.counts,
                target: targetUrl
            };
        }

        const previousState = ctx.getState();
        const shouldCarryRunCounts = (
            !!(options.autoDispatch || options.fromBatch)
            && previousState?.currentTask?.id === task?.id
            && !previousState?.stopRequested
        );
        const carriedPublishedCount = shouldCarryRunCounts
            ? Number(previousState.sessionPublishedCount || 0)
            : 0;
        const carriedAnchorSuccessCount = shouldCarryRunCounts
            ? Number(previousState.sessionAnchorSuccessCount || 0)
            : 0;

        const isAnchorLimit = task?.commentStyle === 'anchor-html' || task?.commentStyle === 'anchor-prefer';
        const dailyLimitCount = ctx.getTaskDailyLimitCount(task);

        if (
            maxPublishes > 0
            && dailyLimitCount >= maxPublishes
        ) {
            return {
                success: false,
                code: 'publish_limit_reached',
                message: isAnchorLimit
                    ? `今日已达到每日成功锚文本外链上限 ${maxPublishes}`
                    : `今日已达到每日成功发布上限 ${maxPublishes}`
            };
        }

        ctx.setState(this.createInitialState(
            task,
            pending,
            workflow?.id || ctx.defaultWorkflowId,
            {
                currentTabId: previousState.currentTabId || null,
                limitType: isAnchorLimit ? 'anchor-success' : 'published',
                currentLimitCount: dailyLimitCount,
                targetLimitCount: maxPublishes > 0 ? maxPublishes : 0,
                sessionPublishedCount: carriedPublishedCount,
                sessionAnchorSuccessCount: carriedAnchorSuccessCount
            }
        ));

        await ctx.logger.publish(`${shouldCarryRunCounts ? '继续发布' : '开始发布'}: ${task.name || task.website}`, {
            total: pending.length,
            workflowId: workflow?.id || ctx.defaultWorkflowId,
            maxPublishes,
            activePool: dispatchSelection.activePool || 'mixed',
            poolCounts: dispatchSelection.counts,
            limitType: isAnchorLimit ? 'anchor-success' : 'published',
            currentLimitCount: dailyLimitCount
        });

        return {
            success: true,
            queued: pending.length,
            resumed: shouldCarryRunCounts,
            currentLimitCount: dailyLimitCount
        };
    },

    async dispatchQueue(ctx) {
        const state = ctx.getState();
        if (!state.isPublishing || state.awaitingManualContinue) return;

        if (Number(state.targetLimitCount || 0) > 0 && Number(state.currentLimitCount || 0) >= Number(state.targetLimitCount || 0)) {
            ctx.releasePublishLease?.({ sessionId: state.sessionId || '' });
            ctx.updateState({ isPublishing: false });
            ctx.broadcastDone();
            await ctx.logger.publish(
                state.limitType === 'anchor-success'
                    ? `已达到每日成功锚文本外链上限 ${state.targetLimitCount}`
                    : `已达到每日成功发布上限 ${state.targetLimitCount}`
            );
            return;
        }

        const dispatchState = await ctx.rebalanceDispatchQueue();
        if (dispatchState.moved > 0) {
            const movedHints = [];
            if (dispatchState.cooldownBlockedCount > 0) {
                movedHints.push(`${dispatchState.cooldownBlockedCount} 个域名冷却`);
            }
            if (dispatchState.leaseBlockedCount > 0) {
                movedHints.push(`${dispatchState.leaseBlockedCount} 个并发锁占用`);
            }
            await ctx.logger.publish(`已重排 ${dispatchState.moved} 个暂不可发资源`, {
                taskId: ctx.getState().currentTask?.id || '',
                reasons: movedHints
            });
        }

        if (dispatchState.blocked) {
            const hasLeaseBlock = Number(dispatchState.leaseBlockedCount || 0) > 0;
            if (hasLeaseBlock) {
                const retryDelayMs = Number(dispatchState.retryDelayMs || 0) || 1800;
                ctx.updateState({
                    currentStage: 'waiting_lease',
                    currentStageLabel: '等待资源锁释放',
                    currentStageAt: new Date().toISOString(),
                    nextRetryAt: new Date(Date.now() + retryDelayMs).toISOString(),
                    waitingReason: dispatchState.waitingReason || 'lease-blocked'
                });
                ctx.broadcastProgress({
                    currentUrl: ctx.getState().currentUrl,
                    current: ctx.getState().currentIndex + 1,
                    total: ctx.getState().queue.length,
                    taskId: ctx.getState().currentTask?.id,
                    isPublishing: true,
                    awaitingManualContinue: !!ctx.getState().awaitingManualContinue,
                    currentStage: 'waiting_lease',
                    currentStageLabel: '等待资源锁释放',
                    currentStageAt: ctx.getState().currentStageAt || '',
                    currentLimitCount: Number(ctx.getState().currentLimitCount || 0),
                    targetLimitCount: Number(ctx.getState().targetLimitCount || 0),
                    limitType: ctx.getState().limitType || '',
                    sessionPublishedCount: Number(ctx.getState().sessionPublishedCount || 0),
                    sessionAnchorSuccessCount: Number(ctx.getState().sessionAnchorSuccessCount || 0)
                });
                ctx.scheduleDispatchRetry?.(retryDelayMs, dispatchState.waitingReason || 'lease-blocked');
                return;
            }

            ctx.releasePublishLease?.({ sessionId: ctx.getState().sessionId || '' });
            ctx.updateState({
                isPublishing: false,
                currentStage: 'cooldown_wait',
                currentStageLabel: '当前轮剩余资源全部进入域名冷却',
                currentStageAt: new Date().toISOString(),
                nextRetryAt: dispatchState.cooldownUntil || '',
                waitingReason: dispatchState.waitingReason || 'cooldown-only'
            });
            ctx.broadcastDone();
            await ctx.logger.publish('剩余资源全部处于域名冷却中，已暂停本轮发布', {
                taskId: ctx.getState().currentTask?.id || '',
                cooldownUntil: dispatchState.cooldownUntil || ''
            });
            return;
        }

        if (ctx.getState().currentIndex >= ctx.getState().queue.length) {
            ctx.releasePublishLease?.({ sessionId: ctx.getState().sessionId || '' });
            ctx.updateState({ isPublishing: false });
            ctx.broadcastDone();
            await ctx.logger.publish('发布完成');
            return;
        }

        const currentState = ctx.getState();
        const resource = currentState.queue[currentState.currentIndex];
        const task = currentState.currentTask;
        const workflow = ctx.getPublishWorkflow(task);
        const settings = await ctx.getSettings();
        const shouldFocus = ctx.shouldFocusPublishTab(task, settings);
        let url = resource.url;
        if (!url.startsWith('http')) url = 'https://' + url;

        ctx.updateState({
            currentUrl: resource.url,
            currentStage: '',
            currentStageLabel: '',
            currentStageAt: '',
            resultLock: null,
            nextRetryAt: '',
            waitingReason: ''
        });
        ctx.broadcastProgress({
            currentUrl: resource.url,
            current: currentState.currentIndex + 1,
            total: currentState.queue.length,
            taskId: task.id,
            isPublishing: true,
            currentStage: '',
            currentStageLabel: '',
            currentStageAt: '',
            currentLimitCount: Number(currentState.currentLimitCount || 0),
            targetLimitCount: Number(currentState.targetLimitCount || 0),
            limitType: currentState.limitType || '',
            sessionPublishedCount: Number(currentState.sessionPublishedCount || 0),
            sessionAnchorSuccessCount: Number(currentState.sessionAnchorSuccessCount || 0)
        });

        try {
            const leaseResult = ctx.acquirePublishLease?.(resource, {
                sessionId: currentState.sessionId || ''
            }) || { success: true };
            if (!leaseResult.success) {
                ctx.moveCurrentResourceToQueueTail();
                return await this.dispatchQueue(ctx);
            }

            const preferCommentViewport = !!ctx.shouldPreferCommentViewport?.(resource, task, workflow);
            const tab = await ctx.openOrReusePublishTab(url, {
                active: shouldFocus,
                preferCommentAnchor: preferCommentViewport,
                commentHash: this.COMMENT_SECTION_HASH
            });
            await ctx.delay(this.TAB_PRIME_DELAY_MS);

            if (!ctx.getState().isPublishing) {
                ctx.releasePublishLease?.({
                    sessionId: currentState.sessionId || '',
                    resourceId: resource.id
                });
                return;
            }

            // 检查页面是否加载成功（白屏/错误页/无法访问）
            try {
                const tabInfo = await chrome.tabs.get(tab.id);
                const tabUrl = tabInfo?.url || '';
                if (!tabUrl || tabUrl === 'about:blank' || tabUrl.startsWith('chrome-error://')) {
                    throw new Error('页面加载失败（无法访问或服务器无响应）');
                }
            } catch (tabErr) {
                if (tabErr.message.includes('页面加载失败')) throw tabErr;
                throw new Error('页面标签已关闭或无法访问');
            }

            await ctx.sendPublishToTab(tab.id, resource, task, workflow, settings);
        } catch (error) {
            ctx.releasePublishLease?.({
                sessionId: currentState.sessionId || '',
                resourceId: resource.id
            });
            await ctx.logger.error(`发布失败: ${resource.url}`, { error: error.message });

            // 向当前 Tab 注入并显示失败提示（不依赖 content script 已加载）
            try {
                const tabId = ctx.getState().currentTabId;
                if (tabId) {
                    const failMsg = `发布失败：${error.message || '页面无法加载或脚本注入失败'}`;
                    await chrome.scripting.executeScript({
                        target: { tabId },
                        func: (msg) => {
                            const overlay = document.createElement('div');
                            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999998;';
                            const toast = document.createElement('div');
                            toast.innerHTML = '<div style="font-size:28px;margin-bottom:8px;">⚠️</div><div style="font-size:18px;font-weight:600;line-height:1.5;">' + msg.replace(/</g,'&lt;') + '</div><div style="font-size:13px;color:rgba(255,255,255,0.7);margin-top:10px;">3 秒后自动继续...</div>';
                            toast.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;background:#dc2626;color:white;padding:30px 40px;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,0.4);text-align:center;min-width:320px;max-width:500px;';
                            document.body.appendChild(overlay);
                            document.body.appendChild(toast);
                            setTimeout(() => { overlay.remove(); toast.remove(); }, 3000);
                        },
                        args: [failMsg]
                    });
                    await new Promise(r => setTimeout(r, 3200));
                }
            } catch {}

            const errorText = String(error?.message || '');
            let submissionBlockReason = 'dispatch-message-failed';
            if (errorText.includes('页面标签已关闭')) {
                submissionBlockReason = 'tab-closed';
            } else if (errorText.includes('页面加载失败')) {
                submissionBlockReason = 'network-error';
            } else if (errorText.includes('发送发布消息失败')) {
                submissionBlockReason = 'dispatch-message-failed';
            }

            await this.handleAction(ctx, resource.id, 'failed', task.id, {
                reportedVia: 'dispatch-error',
                submissionBlocked: true,
                submissionBlockReason,
                dispatchError: errorText
            });
            return;
        }
    },

    async handleAction(ctx, resourceId, result, taskId, meta = {}) {
        const state = ctx.getState();
        const activeQueueIndex = Number(state.currentIndex || 0);
        const activeResourceId = state.queue?.[activeQueueIndex]?.id || '';
        if (activeResourceId && activeResourceId !== resourceId) {
            if (typeof self !== 'undefined' && typeof self.logPublishEvent === 'function') {
                self.logPublishEvent('handle-action-dropped', {
                    attemptId: state.currentAttemptId || meta?.attemptId || '',
                    taskId,
                    resourceId,
                    url: state.currentUrl || '',
                    data: {
                        reason: 'active-resource-mismatch',
                        activeResourceId,
                        queueIndex: activeQueueIndex,
                        result,
                        reportedVia: meta?.reportedVia || ''
                    }
                });
            }
            return;
        }

        const existingLock = state.resultLock;
        if (
            existingLock
            && existingLock.resourceId === resourceId
            && Number(existingLock.queueIndex || 0) === activeQueueIndex
        ) {
            if (typeof self !== 'undefined' && typeof self.logPublishEvent === 'function') {
                self.logPublishEvent('handle-action-dropped', {
                    attemptId: state.currentAttemptId || meta?.attemptId || '',
                    taskId,
                    resourceId,
                    url: state.currentUrl || '',
                    data: {
                        reason: 'result-lock-held',
                        lockResult: existingLock.result || '',
                        incomingResult: result,
                        reportedVia: meta?.reportedVia || ''
                    }
                });
            }
            return;
        }

        if (typeof self !== 'undefined' && typeof self.logPublishEvent === 'function') {
            self.logPublishEvent('handle-action-enter', {
                attemptId: state.currentAttemptId || meta?.attemptId || '',
                taskId,
                resourceId,
                url: state.currentUrl || '',
                data: {
                    result,
                    reportedVia: meta?.reportedVia || '',
                    hadPendingSubmit: !!state.pendingSubmission
                }
            });
        }

        ctx.updateState({
            resultLock: {
                resourceId,
                queueIndex: activeQueueIndex,
                acquiredAt: new Date().toISOString(),
                result: String(result || '')
            }
        });

        const currentTabId = state.currentTabId;
        if (currentTabId) {
            try {
                await ctx.sendStopMessage(currentTabId);
            } catch {}
        }

        if (state.pendingSubmission?.resourceId === resourceId) {
            ctx.updateState({ pendingSubmission: null });
        }

        ctx.updateState({
            currentStage: '',
            currentStageLabel: '',
            currentStageAt: ''
        });

        const statusMap = { submitted: 'published', skipped: 'skipped', failed: 'failed' };
        let status = statusMap[result] || result;
        const publishMeta = {
            ...(meta || {}),
            rawResult: String(result || ''),
            commentStyle: meta.commentStyle || state.currentTask?.commentStyle || 'standard',
            anchorRequested: !!meta.anchorRequested,
            anchorInjected: !!meta.anchorInjected,
            anchorText: meta.anchorText || state.currentTask?.anchorKeyword || '',
            anchorUrl: meta.anchorUrl || state.currentTask?.anchorUrl || state.currentTask?.website || '',
            updatedAt: new Date().toISOString()
        };
        const networkSignal = ctx.getLatestNetworkSignal?.({
            taskId,
            resourceId,
            tabId: currentTabId,
            url: state.currentUrl || '',
            consume: true
        }) || null;

        if (networkSignal) {
            publishMeta.networkSignal = networkSignal.type || '';
            publishMeta.networkSignalSource = networkSignal.source || '';
            publishMeta.networkSignalUrl = networkSignal.url || '';
            publishMeta.networkSignalReceivedAt = networkSignal.receivedAt || Date.now();

            if (networkSignal.type === 'rejected') {
                status = 'failed';
                publishMeta.submissionBlocked = true;
                publishMeta.submissionBlockReason = publishMeta.submissionBlockReason || 'network-rejected';
            } else if (status !== 'failed' && networkSignal.type === 'moderation') {
                status = 'published';
                publishMeta.reviewPending = true;
                publishMeta.reviewPolicy = publishMeta.reviewPolicy || 'moderated';
            } else if (status !== 'failed' && (networkSignal.type === 'confirmed' || networkSignal.type === 'success')) {
                status = 'published';
            }
        }

        if (status === 'published' && ctx.getState().currentTabId) {
            const verification = await ctx.verifyPublishedAnchor(ctx.getState().currentTabId, {
                anchorUrl: publishMeta.anchorUrl,
                anchorText: publishMeta.anchorText,
                commenterName: ctx.getState().currentTask?.name_commenter || '',
                commentPreview: publishMeta.commentPreview || ''
            });
            if (publishMeta.anchorRequested) {
                publishMeta.anchorVisible = !!verification?.anchorVisible;
                publishMeta.anchorVerified = !!verification;
                publishMeta.anchorVerification = verification || null;
                // 新增：rel 归类字段。dofollow 才是真正的 SEO 价值。
                // 老调用方只看 anchorVisible 仍然向前兼容，新指标看 anchorIsDofollow。
                publishMeta.anchorRel = verification?.anchorRel || '';
                publishMeta.anchorRelTokens = verification?.anchorRelTokens || [];
                publishMeta.anchorIsNofollow = !!verification?.anchorIsNofollow;
                publishMeta.anchorIsDofollow = !!verification?.anchorIsDofollow;
            }
            publishMeta.commentLocated = !!verification?.commentLocated;
            publishMeta.commentLocationMethod = verification?.commentLocationMethod || '';
            publishMeta.commentLocatedExcerpt = verification?.commentExcerpt || '';
            publishMeta.websiteFieldBlockedFirstComment = !!verification?.websiteFieldBlockedFirstComment;
            publishMeta.reviewPending = !!publishMeta.reviewPending || !!verification?.reviewPending;
            publishMeta.reviewPolicy = publishMeta.reviewPolicy || verification?.reviewPolicy || '';
            publishMeta.websitePolicy = publishMeta.websiteFieldBlockedFirstComment
                ? 'omit-first-comment-website'
                : (publishMeta.websiteOmitted ? 'website-optional' : 'website-field');
            if (verification?.noticeExcerpt) {
                publishMeta.websiteFieldNotice = verification.noticeExcerpt;
            }
            publishMeta.submissionBlocked = !!verification?.submissionBlocked;
            publishMeta.submissionBlockReason = verification?.submissionBlockReason || '';
            publishMeta.pageUrlAfterSubmit = verification?.pageUrl || '';
            if (publishMeta.reviewPending) {
                // 评论已提交成功，等待博主审核是正常的，保持 published 状态
                await ctx.logger.publish('评论已提交成功，站点显示待审核（这是正常的）', {
                    url: ctx.getState().currentUrl,
                    policy: publishMeta.reviewPolicy || 'moderated'
                });
            }
            if (typeof self !== 'undefined' && typeof self.logPublishEvent === 'function') {
                self.logPublishEvent('verifier-result', {
                    attemptId: state.currentAttemptId || meta?.attemptId || '',
                    taskId,
                    resourceId,
                    url: ctx.getState().currentUrl || '',
                    data: {
                        anchorVisible: !!verification?.anchorVisible,
                        anchorCount: verification?.anchorCount || 0,
                        anchorIsDofollow: !!verification?.anchorIsDofollow,
                        anchorIsNofollow: !!verification?.anchorIsNofollow,
                        anchorRel: verification?.anchorRel || '',
                        commentLocated: !!verification?.commentLocated,
                        reviewPending: !!verification?.reviewPending,
                        submissionBlocked: !!verification?.submissionBlocked,
                        submissionBlockReason: verification?.submissionBlockReason || '',
                        pageUrl: verification?.pageUrl || ''
                    }
                });
            }
            if (publishMeta.submissionBlocked) {
                status = 'failed';
                await ctx.logger.error('评论提交被站点拦截，已改判为失败', {
                    url: ctx.getState().currentUrl,
                    reason: publishMeta.submissionBlockReason || '',
                    pageUrl: publishMeta.pageUrlAfterSubmit || ''
                });
            }

            // Provisional 通道护栏：watchdog / alarm / navigation-confirm 等通道并不是
            // content script 主动确认"已提交"的信号，而是超时/导航推断。只有 verifier
            // 找到证据（anchor / 评论块 / 审核提示）才能留 published；否则一律改软失败，
            // 走 SOFT_RETRYABLE_REASONS 的有限重试路径。避免 SW 休眠后 alarm 先发 failed、
            // 以及导航到未识别错误页被当成功的两类误判。
            const reportedVia = String(publishMeta.reportedVia || '').toLowerCase();
            const isProvisionalChannel = /^(watchdog|alarm-watchdog|navigation-confirm)/.test(reportedVia);
            const verifierHasEvidence =
                !!verification?.anchorVisible
                || !!verification?.commentLocated
                || !!verification?.reviewPending;
            if (status === 'published' && isProvisionalChannel && !verifierHasEvidence && !publishMeta.submissionBlocked) {
                status = 'failed';
                publishMeta.submissionBlocked = true;
                publishMeta.submissionBlockReason = publishMeta.submissionBlockReason || 'publish-runtime-timeout';
                if (typeof self !== 'undefined' && typeof self.logPublishEvent === 'function') {
                    self.logPublishEvent('provisional-guard-flipped', {
                        attemptId: state.currentAttemptId || meta?.attemptId || '',
                        taskId,
                        resourceId,
                        url: ctx.getState().currentUrl || '',
                        data: {
                            reportedVia,
                            reason: publishMeta.submissionBlockReason
                        }
                    });
                }
                await ctx.logger.error('通道未直接确认且验证器未找到评论证据，改判为软可重试失败', {
                    url: ctx.getState().currentUrl,
                    reportedVia
                });
            }
        } else if (status === 'published') {
            // 没有 currentTabId → verifier 跑不起来。如果是 provisional 通道（watchdog/nav），
            // 不能信任 published；改判 tab-closed 软可重试。
            const reportedVia = String(publishMeta.reportedVia || '').toLowerCase();
            if (/^(watchdog|alarm-watchdog|navigation-confirm)/.test(reportedVia)) {
                status = 'failed';
                publishMeta.submissionBlocked = true;
                publishMeta.submissionBlockReason = publishMeta.submissionBlockReason || 'tab-closed';
                await ctx.logger.error('Provisional 通道进入 published 但无 currentTabId，改判软失败', {
                    url: ctx.getState().currentUrl,
                    reportedVia
                });
            }
        }

        if (publishMeta.websiteFieldBlockedFirstComment) {
            const currentState = ctx.getState();
            const resource = currentState.queue[currentState.currentIndex];
            const settings = await ctx.getSettings();
            const shouldFocus = ctx.shouldFocusPublishTab(currentState.currentTask, settings);
            await ctx.setDomainPublishPolicy(resource?.url || currentState.currentUrl || '', {
                omitWebsiteField: true,
                reason: 'first-comment-website-block',
                updatedAt: new Date().toISOString()
            });

            if (!meta.retryWithoutWebsite && currentState.currentTabId && resource && currentState.currentTask) {
                const workflow = ctx.getPublishWorkflow(currentState.currentTask);
                let retryUrl = resource.url;
                if (retryUrl && !retryUrl.startsWith('http')) retryUrl = 'https://' + retryUrl;

                await ctx.logger.publish('检测到首评禁止 Website 字段，已自动改为清空 Website 字段后重试', {
                    url: resource.url
                });

                const preferCommentViewport = !!ctx.shouldPreferCommentViewport?.(resource, currentState.currentTask, workflow);
                const tab = await ctx.openOrReusePublishTab(retryUrl, {
                    active: shouldFocus,
                    preferCommentAnchor: preferCommentViewport,
                    commentHash: this.COMMENT_SECTION_HASH
                });
                await ctx.delay(this.TAB_PRIME_DELAY_MS);

                if (!ctx.getState().isPublishing) return;

                await ctx.sendPublishToTab(tab.id, resource, currentState.currentTask, workflow, settings, {
                    website: '',
                    retryWithoutWebsite: true
                });
                return;
            }

            if (meta.retryWithoutWebsite) {
                status = 'failed';
                publishMeta.websiteRetryExhausted = true;
                await ctx.logger.error('清空 Website 字段后重试仍被站点拦截', {
                    url: ctx.getState().currentUrl,
                    notice: publishMeta.websiteFieldNotice || ''
                });
            }
        }

        if (publishMeta.reviewPending) {
            await ctx.setDomainPublishPolicy(ctx.getState().currentUrl || '', {
                reviewPolicy: publishMeta.reviewPolicy || 'moderated',
                updatedAt: new Date().toISOString()
            });
        }

        if (status === 'failed' && ctx.isRateLimitReason(publishMeta.submissionBlockReason)) {
            const cooldownUntil = new Date(Date.now() + ctx.publishStrategy.DOMAIN_RATE_LIMIT_COOLDOWN_MS).toISOString();
            await ctx.setDomainPublishPolicy(ctx.getState().currentUrl || '', {
                cooldownUntil,
                cooldownReason: publishMeta.submissionBlockReason,
                updatedAt: new Date().toISOString()
            });
            publishMeta.cooldownUntil = cooldownUntil;
            publishMeta.cooldownDeferred = true;
            status = 'pending';
            await ctx.logger.publish('站点触发评论限流，已自动进入域名冷却', {
                url: ctx.getState().currentUrl,
                cooldownUntil
            });
        }

        const publishTarget = ctx.getTaskPublishTarget(ctx.getState().currentTask || {});
        const currentResource = state.queue?.[state.currentIndex] || null;
        const currentTask = ctx.getState().currentTask || null;
        const currentHistoryEntry = publishTarget.key
            ? currentResource?.publishHistory?.[publishTarget.key] || null
            : null;

        if (status === 'failed') {
            const failureRecovery = ctx.getFailureRecoveryPolicy?.(publishMeta, currentHistoryEntry) || null;
            if (failureRecovery?.retryable) {
                const cooldownUntil = new Date(Date.now() + Number(failureRecovery.cooldownMs || 0)).toISOString();
                await ctx.setDomainPublishPolicy(ctx.getState().currentUrl || '', {
                    cooldownUntil,
                    cooldownReason: failureRecovery.reason || 'retryable_publish_failure',
                    updatedAt: new Date().toISOString()
                });
                publishMeta.cooldownUntil = cooldownUntil;
                publishMeta.cooldownDeferred = true;
                publishMeta.retryRecoveryReason = failureRecovery.reason || 'retryable_publish_failure';
                status = 'pending';
                await ctx.logger.publish('本次失败判定为可重试，已回退到待重试队列', {
                    url: ctx.getState().currentUrl,
                    reason: failureRecovery.reason || 'unknown',
                    cooldownUntil
                });
            } else if (failureRecovery?.terminalStatus && failureRecovery.terminalStatus !== status) {
                publishMeta.terminalFailureReason = failureRecovery.reason || publishMeta.submissionBlockReason || 'terminal-skip';
                status = failureRecovery.terminalStatus;
                await ctx.logger.publish('本次失败已转为终态处理', {
                    url: ctx.getState().currentUrl,
                    reason: failureRecovery.reason || 'unknown',
                    status
                });
            }
        }

        const submissionReason = String(
            publishMeta.terminalFailureReason
            || publishMeta.submissionBlockReason
            || ''
        ).trim().toLowerCase();
        publishMeta.statsStatus = status;
        if (publishMeta.rawResult === 'failed') {
            if (status === 'pending' || status === 'unpublishable') {
                publishMeta.statsStatus = 'failed';
            } else if (
                status === 'skipped'
                && submissionReason
                && !['duplicate_comment', 'website-field-blocked-exhausted'].includes(submissionReason)
            ) {
                publishMeta.statsStatus = 'failed';
            }
        }

        if (typeof self !== 'undefined' && typeof self.logPublishEvent === 'function') {
            self.logPublishEvent('status-transition', {
                attemptId: state.currentAttemptId || meta?.attemptId || '',
                taskId,
                resourceId,
                url: ctx.getState().currentUrl || '',
                data: {
                    rawResult: publishMeta.rawResult || '',
                    finalStatus: status,
                    statsStatus: publishMeta.statsStatus,
                    submissionBlockReason: publishMeta.submissionBlockReason || '',
                    terminalFailureReason: publishMeta.terminalFailureReason || '',
                    reviewPending: !!publishMeta.reviewPending,
                    anchorVisible: !!publishMeta.anchorVisible,
                    anchorIsDofollow: !!publishMeta.anchorIsDofollow,
                    reportedVia: publishMeta.reportedVia || ''
                }
            });
        }

        await ctx.updateResourceStatus(resourceId, status, {
            publishMeta,
            publishHistoryEntry: publishTarget.key ? { target: publishTarget } : null
        });
        await ctx.rememberPublishOutcome?.(currentResource || { id: resourceId, url: state.currentUrl || '' }, currentTask, status, publishMeta);
        await ctx.recordDomainPublishEvidence?.(currentResource?.url || state.currentUrl || '', status, publishMeta);
        const finalStatusLog = publishMeta.rawResult && publishMeta.rawResult !== status
            ? `评论最终状态: ${status}（原始结果: ${publishMeta.rawResult}）: ${resourceId}`
            : `评论最终状态: ${status}: ${resourceId}`;
        await ctx.logger.publish(finalStatusLog);

        await ctx.updateTaskStats(taskId, resourceId, status, currentTask, publishMeta);
        await ctx.syncPublishLog(resourceId, status, currentTask);

        let sessionPublishedCount = Number(ctx.getState().sessionPublishedCount || 0);
        let sessionAnchorSuccessCount = Number(ctx.getState().sessionAnchorSuccessCount || 0);
        let dailyLimitCount = Number(ctx.getState().currentLimitCount || 0);

        if (status === 'published') {
            sessionPublishedCount += 1;
            // Anchor 成功计数改成"有链接且不是 nofollow/ugc/sponsored"才算。
            // 以前只看 anchorVisible，rel=nofollow 的评论被当成成功 → SEO KPI 失真。
            // anchorIsDofollow 仅在 anchorRequested=true 时由 verifier 填充，
            // 对非 anchor 模式任务此字段为 undefined，不影响现有流程。
            const anchorCountsAsSuccess = !!publishMeta.anchorIsDofollow;
            if (anchorCountsAsSuccess) {
                sessionAnchorSuccessCount += 1;
            }
            dailyLimitCount = await ctx.incrementDailyPublishCount(
                ctx.getState().currentTask?.id,
                { published: true, anchorSuccess: anchorCountsAsSuccess }
            );
        }

        if (Number(ctx.getState().targetLimitCount || 0) > 0) {
            const sessionTaskStyle = ctx.getState().currentTask?.commentStyle || '';
            const sessionIsAnchorLimit = sessionTaskStyle === 'anchor-html' || sessionTaskStyle === 'anchor-prefer';
            ctx.updateState({
                currentLimitCount: dailyLimitCount,
                limitType: sessionIsAnchorLimit ? 'anchor-success' : 'published',
                sessionPublishedCount,
                sessionAnchorSuccessCount
            });
        } else {
            ctx.updateState({
                sessionPublishedCount,
                sessionAnchorSuccessCount
            });
        }

        const progressState = ctx.getState();
        ctx.broadcastProgress({
            currentUrl: progressState.currentUrl,
            current: progressState.currentIndex + 1,
            total: progressState.queue.length,
            taskId: progressState.currentTask?.id,
            isPublishing: progressState.isPublishing,
            awaitingManualContinue: !!progressState.awaitingManualContinue,
            currentLimitCount: Number(progressState.currentLimitCount || 0),
            targetLimitCount: Number(progressState.targetLimitCount || 0),
            limitType: progressState.limitType || '',
            sessionPublishedCount: Number(progressState.sessionPublishedCount || 0),
            sessionAnchorSuccessCount: Number(progressState.sessionAnchorSuccessCount || 0)
        });

        const limitState = ctx.getState();
        if (Number(limitState.targetLimitCount || 0) > 0 && Number(limitState.currentLimitCount || 0) >= Number(limitState.targetLimitCount || 0)) {
            ctx.releasePublishLease?.({
                sessionId: ctx.getState().sessionId || '',
                resourceId
            });
            ctx.updateState({
                isPublishing: false,
                awaitingManualContinue: false,
                resultLock: null,
                nextRetryAt: '',
                waitingReason: ''
            });
            ctx.broadcastDone();
            await ctx.logger.publish(
                limitState.limitType === 'anchor-success'
                    ? `已达到每日成功锚文本外链上限 ${limitState.targetLimitCount}`
                    : `已达到每日成功发布上限 ${limitState.targetLimitCount}`
            );
            return;
        }

        const isSubmittedOutcome = result === 'submitted' && (status === 'published' || status === 'pending');
        const settings = isSubmittedOutcome ? await ctx.getSettings() : null;
        const shouldHoldForReview = isSubmittedOutcome
            ? (ctx.getState().currentTask?.mode !== 'full-auto' || !!settings?.publishDebugMode)
            : false;

        if (shouldHoldForReview) {
            await ctx.focusPublishTab();
            ctx.updateState({
                awaitingManualContinue: true,
                resultLock: null,
                nextRetryAt: '',
                waitingReason: ''
            });
            ctx.broadcastProgress({
                currentUrl: ctx.getState().currentUrl,
                current: ctx.getState().currentIndex + 1,
                total: ctx.getState().queue.length,
                taskId: ctx.getState().currentTask?.id,
                isPublishing: true,
                awaitingManualContinue: true,
                currentStage: '',
                currentStageLabel: '',
                currentStageAt: '',
                currentLimitCount: Number(ctx.getState().currentLimitCount || 0),
                targetLimitCount: Number(ctx.getState().targetLimitCount || 0),
                limitType: ctx.getState().limitType || '',
                sessionPublishedCount: Number(ctx.getState().sessionPublishedCount || 0),
                sessionAnchorSuccessCount: Number(ctx.getState().sessionAnchorSuccessCount || 0)
            });
            await ctx.logger.publish('当前资源已提交，等待手动继续到下一个页面');
            return;
        }

        if (isSubmittedOutcome) {
            const reviewDelayMs = status === 'pending'
                ? this.PENDING_REVIEW_DELAY_MS
                : this.SUCCESS_REVIEW_DELAY_MS;
            await ctx.logger.publish(
                status === 'pending'
                    ? `评论已提交并识别为待审核，暂停 ${Math.round(reviewDelayMs / 1000)} 秒后继续`
                    : `评论已提交成功，暂停 ${Math.round(reviewDelayMs / 1000)} 秒后继续`
            );
            await ctx.delay(reviewDelayMs);
        }

        ctx.releasePublishLease?.({
            sessionId: ctx.getState().sessionId || '',
            resourceId
        });

        if (status === 'pending' && publishMeta.cooldownDeferred) {
            ctx.moveCurrentResourceToQueueTail();
            ctx.updateState({
                resultLock: null,
                nextRetryAt: '',
                waitingReason: ''
            });
        } else {
            ctx.updateState({
                currentIndex: ctx.getState().currentIndex + 1,
                resultLock: null,
                nextRetryAt: '',
                waitingReason: ''
            });
        }
        await this.dispatchQueue(ctx);
    },

    async stop(ctx) {
        const currentTabId = ctx.getState().currentTabId;
        const currentSessionId = ctx.getState().sessionId || '';
        const currentResourceId = ctx.getState().queue?.[ctx.getState().currentIndex]?.id || '';
        ctx.releasePublishLease?.({
            sessionId: currentSessionId,
            resourceId: currentResourceId
        });
        ctx.clearDispatchRetry?.();
        ctx.setState({
            ...TaskManager.createDefaultPublishState(),
            currentTabId,
            stopRequested: true
        });

        if (currentTabId) {
            try {
                await ctx.sendStopMessage(currentTabId);
            } catch {}
        }

        ctx.broadcastDone();
        await ctx.logger.publish('手动停止发布');
    },

    async continue(ctx) {
        const state = ctx.getState();
        if (!state.isPublishing || !state.awaitingManualContinue) return;
        ctx.releasePublishLease?.({
            sessionId: state.sessionId || '',
            resourceId: state.queue?.[state.currentIndex]?.id || ''
        });
        ctx.updateState({
            awaitingManualContinue: false,
            currentIndex: state.currentIndex + 1,
            resultLock: null,
            nextRetryAt: '',
            waitingReason: ''
        });
        await this.dispatchQueue(ctx);
    },

    async republish(ctx, resourceId, taskId) {
        const data = await ctx.getResourcesAndTasks();
        const resources = data.resources || [];
        const resource = resources.find((item) => item.id === resourceId);
        if (!resource) return;

        await ctx.resetResourcePublishState(resourceId, { preserveHistory: true });

        const tasks = data.publishTasks || [];
        const task = taskId ? tasks.find((item) => item.id === taskId) : tasks[0];
        if (!task) return;

        const previousState = ctx.getState();

        ctx.setState(this.createInitialState(
            task,
            [resource],
            ctx.getPublishWorkflow(task)?.id || ctx.defaultWorkflowId,
            {
                currentTabId: previousState.currentTabId || null
            }
        ));
        await this.dispatchQueue(ctx);
    }
};

self.PublishRuntime = PublishRuntime;
