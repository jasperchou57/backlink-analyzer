const PublishRuntime = {
    TAB_PRIME_DELAY_MS: 700,
    COMMENT_SECTION_HASH: 'comments',
    SUCCESS_REVIEW_DELAY_MS: 4200,
    PENDING_REVIEW_DELAY_MS: 6200,

    createInitialState(task, queue, workflowId, overrides = {}) {
        return {
            ...TaskManager.createDefaultPublishState(),
            currentTask: task || null,
            queue: queue || [],
            currentWorkflowId: workflowId || null,
            currentUrl: queue?.[0]?.url || '',
            isPublishing: true,
            ...overrides
        };
    },

    getPublishLimitMetric(task, state = {}) {
        const isAnchorLimit = task?.commentStyle === 'anchor-html';
        return {
            isAnchorLimit,
            count: isAnchorLimit
                ? Number(state.sessionAnchorSuccessCount || 0)
                : Number(state.sessionPublishedCount || 0),
            label: isAnchorLimit ? '成功锚文本外链' : '成功发布'
        };
    },

    async start(ctx, task) {
        const runtimeTask = ctx.buildWorkflowTask(task);
        let startResult = null;

        await TaskRunner.run(runtimeTask, {
            handlers: {
                prepare_queue: async () => {
                    startResult = await this.prepareQueue(ctx, task);
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

    async prepareQueue(ctx, task) {
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
        const limitMetric = this.getPublishLimitMetric(task, TaskManager.createDefaultPublishState());
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

        ctx.setState(this.createInitialState(
            task,
            pending,
            workflow?.id || ctx.defaultWorkflowId,
            {
                limitType: limitMetric.isAnchorLimit ? 'anchor-success' : 'published',
                currentLimitCount: 0,
                targetLimitCount: maxPublishes > 0 ? maxPublishes : 0,
                sessionPublishedCount: 0,
                sessionAnchorSuccessCount: 0
            }
        ));

        await ctx.logger.publish(`开始发布: ${task.name || task.website}`, {
            total: pending.length,
            workflowId: workflow?.id || ctx.defaultWorkflowId,
            maxPublishes,
            activePool: dispatchSelection.activePool || 'mixed',
            poolCounts: dispatchSelection.counts,
            limitType: limitMetric.isAnchorLimit ? 'anchor-success' : 'published',
            currentLimitCount: 0
        });

        return {
            success: true,
            queued: pending.length
        };
    },

    async dispatchQueue(ctx) {
        const state = ctx.getState();
        if (!state.isPublishing || state.awaitingManualContinue) return;

        if (Number(state.targetLimitCount || 0) > 0 && Number(state.currentLimitCount || 0) >= Number(state.targetLimitCount || 0)) {
            ctx.updateState({ isPublishing: false });
            ctx.broadcastDone();
            await ctx.logger.publish(
                state.limitType === 'anchor-success'
                    ? `已达到本次成功锚文本外链上限 ${state.targetLimitCount}`
                    : `已达到本次成功发布上限 ${state.targetLimitCount}`
            );
            return;
        }

        const cooldownState = await ctx.rebalanceCooldownQueue();
        if (cooldownState.moved > 0) {
            await ctx.logger.publish(`已重排 ${cooldownState.moved} 个处于域名冷却中的资源`, {
                taskId: ctx.getState().currentTask?.id || ''
            });
        }

        if (cooldownState.blocked) {
            ctx.updateState({ isPublishing: false });
            ctx.broadcastDone();
            await ctx.logger.publish('剩余资源全部处于域名冷却中，已暂停本轮发布', {
                taskId: ctx.getState().currentTask?.id || '',
                cooldownUntil: cooldownState.cooldownUntil || ''
            });
            return;
        }

        if (ctx.getState().currentIndex >= ctx.getState().queue.length) {
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
            resultLock: null
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
            const preferCommentViewport = !!ctx.shouldPreferCommentViewport?.(resource, task, workflow);
            const tab = await ctx.openOrReusePublishTab(url, {
                active: shouldFocus,
                preferCommentAnchor: preferCommentViewport,
                commentHash: this.COMMENT_SECTION_HASH
            });
            await ctx.delay(this.TAB_PRIME_DELAY_MS);

            if (!ctx.getState().isPublishing) {
                return;
            }

            await ctx.sendPublishToTab(tab.id, resource, task, workflow, settings);
        } catch (error) {
            await ctx.logger.error(`发布失败: ${resource.url}`, { error: error.message });
            await ctx.updateResourceStatus(resource.id, 'failed');
            ctx.updateState({ currentIndex: ctx.getState().currentIndex + 1 });
            await this.dispatchQueue(ctx);
        }
    },

    async handleAction(ctx, resourceId, result, taskId, meta = {}) {
        const state = ctx.getState();
        const activeQueueIndex = Number(state.currentIndex || 0);
        const activeResourceId = state.queue?.[activeQueueIndex]?.id || '';
        if (activeResourceId && activeResourceId !== resourceId) {
            return;
        }

        const existingLock = state.resultLock;
        if (
            existingLock
            && existingLock.resourceId === resourceId
            && Number(existingLock.queueIndex || 0) === activeQueueIndex
        ) {
            return;
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
            commentStyle: meta.commentStyle || state.currentTask?.commentStyle || 'standard',
            anchorRequested: !!meta.anchorRequested,
            anchorInjected: !!meta.anchorInjected,
            anchorText: meta.anchorText || state.currentTask?.anchorKeyword || '',
            anchorUrl: meta.anchorUrl || state.currentTask?.anchorUrl || state.currentTask?.website || '',
            updatedAt: new Date().toISOString()
        };

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
            }
            publishMeta.commentLocated = !!verification?.commentLocated;
            publishMeta.commentLocationMethod = verification?.commentLocationMethod || '';
            publishMeta.commentLocatedExcerpt = verification?.commentExcerpt || '';
            publishMeta.websiteFieldBlockedFirstComment = !!verification?.websiteFieldBlockedFirstComment;
            publishMeta.reviewPending = !!verification?.reviewPending;
            publishMeta.reviewPolicy = verification?.reviewPolicy || '';
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
                status = 'pending';
                await ctx.logger.publish('评论已提交，但站点提示仍在审核中，已改判为待确认', {
                    url: ctx.getState().currentUrl,
                    policy: publishMeta.reviewPolicy || 'moderated'
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

        await ctx.updateResourceStatus(resourceId, status, {
            publishMeta,
            publishHistoryEntry: publishTarget.key ? { target: publishTarget } : null
        });
        await ctx.rememberPublishOutcome?.(currentResource || { id: resourceId, url: state.currentUrl || '' }, currentTask, status, publishMeta);
        await ctx.recordDomainPublishEvidence?.(currentResource?.url || state.currentUrl || '', status, publishMeta);
        await ctx.logger.publish(`评论${result}: ${resourceId}`);

        await ctx.updateTaskStats(taskId, resourceId, status, currentTask);
        await ctx.syncPublishLog(resourceId, status, currentTask);

        let sessionPublishedCount = Number(ctx.getState().sessionPublishedCount || 0);
        let sessionAnchorSuccessCount = Number(ctx.getState().sessionAnchorSuccessCount || 0);

        if (status === 'published') {
            sessionPublishedCount += 1;
            if (publishMeta.anchorVisible) {
                sessionAnchorSuccessCount += 1;
            }
        }

        if (Number(ctx.getState().targetLimitCount || 0) > 0) {
            const limitMetric = this.getPublishLimitMetric(ctx.getState().currentTask, {
                sessionPublishedCount,
                sessionAnchorSuccessCount
            });
            ctx.updateState({
                currentLimitCount: limitMetric.count,
                limitType: limitMetric.isAnchorLimit ? 'anchor-success' : 'published',
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
            ctx.updateState({
                isPublishing: false,
                awaitingManualContinue: false
            });
            ctx.broadcastDone();
            await ctx.logger.publish(
                limitState.limitType === 'anchor-success'
                    ? `已达到本次成功锚文本外链上限 ${limitState.targetLimitCount}`
                    : `已达到本次成功发布上限 ${limitState.targetLimitCount}`
            );
            return;
        }

        if (result === 'submitted' && (status === 'published' || status === 'pending')) {
            const settings = await ctx.getSettings();
            const shouldHoldForReview = ctx.getState().currentTask?.mode !== 'full-auto' || !!settings.publishDebugMode;

            if (shouldHoldForReview) {
                await ctx.focusPublishTab();
                ctx.updateState({ awaitingManualContinue: true });
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

        if (status === 'pending' && publishMeta.cooldownDeferred) {
            ctx.moveCurrentResourceToQueueTail();
            ctx.updateState({ resultLock: null });
        } else {
            ctx.updateState({
                currentIndex: ctx.getState().currentIndex + 1,
                resultLock: null
            });
        }
        await this.dispatchQueue(ctx);
    },

    async stop(ctx) {
        const currentTabId = ctx.getState().currentTabId;
        ctx.setState({
            ...TaskManager.createDefaultPublishState(),
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
        ctx.updateState({
            awaitingManualContinue: false,
            currentIndex: state.currentIndex + 1,
            resultLock: null
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

        ctx.setState(this.createInitialState(
            task,
            [resource],
            ctx.getPublishWorkflow(task)?.id || ctx.defaultWorkflowId
        ));
        await this.dispatchQueue(ctx);
    }
};

self.PublishRuntime = PublishRuntime;
