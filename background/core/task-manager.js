const TaskManager = {
    createDefaultPublishState() {
        return {
            isPublishing: false,
            currentTask: null,
            currentIndex: 0,
            queue: [],
            currentWorkflowId: null,
            currentTabId: null,
            currentUrl: '',
            stopRequested: false,
            awaitingManualContinue: false,
            pendingSubmission: null,
            limitType: 'published',
            currentLimitCount: 0,
            targetLimitCount: 0,
            sessionPublishedCount: 0,
            sessionAnchorSuccessCount: 0
        };
    },

    createDefaultPublishSessions() {
        return {};
    },

    createDefaultPublishBatchState() {
        return {
            isRunning: false,
            isPaused: true,
            queueTaskIds: [],
            currentTaskId: '',
            completedTaskIds: [],
            skippedTaskIds: [],
            failedTaskIds: [],
            startedAt: '',
            updatedAt: '',
            lastCompletedAt: '',
            lastMessage: ''
        };
    },

    buildPublishStateView(state = {}) {
        return {
            isPublishing: !!state.isPublishing,
            currentIndex: state.currentIndex || 0,
            total: state.queue?.length || 0,
            currentUrl: state.currentUrl || '',
            taskId: state.currentTask?.id || '',
            taskName: state.currentTask?.name || state.currentTask?.website || '',
            stopRequested: !!state.stopRequested,
            awaitingManualContinue: !!state.awaitingManualContinue,
            limitType: state.limitType || 'published',
            currentLimitCount: Number(state.currentLimitCount || 0),
            targetLimitCount: Number(state.targetLimitCount || 0),
            sessionPublishedCount: Number(state.sessionPublishedCount || 0),
            sessionAnchorSuccessCount: Number(state.sessionAnchorSuccessCount || 0)
        };
    },

    buildPublishBatchView(state = {}) {
        const queueTaskIds = Array.isArray(state.queueTaskIds) ? state.queueTaskIds : [];
        const completedTaskIds = Array.isArray(state.completedTaskIds) ? state.completedTaskIds : [];
        const skippedTaskIds = Array.isArray(state.skippedTaskIds) ? state.skippedTaskIds : [];
        const failedTaskIds = Array.isArray(state.failedTaskIds) ? state.failedTaskIds : [];
        const doneCount = new Set([...completedTaskIds, ...skippedTaskIds, ...failedTaskIds]).size;

        return {
            isRunning: !!state.isRunning,
            isPaused: !!state.isPaused,
            currentTaskId: state.currentTaskId || '',
            queueTaskIds,
            totalTasks: queueTaskIds.length,
            completedTaskIds,
            skippedTaskIds,
            failedTaskIds,
            doneCount,
            remainingCount: Math.max(0, queueTaskIds.length - doneCount),
            startedAt: state.startedAt || '',
            updatedAt: state.updatedAt || '',
            lastCompletedAt: state.lastCompletedAt || '',
            lastMessage: state.lastMessage || ''
        };
    },

    buildPublishSessionsView(sessions = {}, batchState = {}) {
        const entries = Object.entries(sessions || {});
        const sessionViews = entries.reduce((map, [taskId, state]) => {
            map[taskId] = this.buildPublishStateView(state);
            return map;
        }, {});
        const activeTaskIds = entries
            .filter(([, state]) => !!state?.isPublishing || !!state?.awaitingManualContinue)
            .map(([taskId]) => taskId);

        return {
            isPublishing: activeTaskIds.length > 0,
            activeCount: activeTaskIds.length,
            activeTaskIds,
            sessions: sessionViews,
            batch: this.buildPublishBatchView(batchState)
        };
    },

    createDefaultContinuousDiscoveryState() {
        return {
            taskId: '',
            workflowId: 'continuous-discovery',
            isRunning: false,
            isPaused: true,
            seedDomain: '',
            myDomain: '',
            sources: [],
            seedInitialized: false,
            currentDomain: '',
            phase: 'idle',
            phaseLabel: '',
            stepIndex: 0,
            stepTotal: 0,
            lastSeedRunAt: '',
            lastFrontierRunAt: '',
            lastCompletedAt: '',
            lastMessage: ''
        };
    },

    normalizeContinuousDiscoveryPatch(current, patch = {}) {
        return {
            ...current,
            ...(patch || {})
        };
    },

    buildInterruptedContinuousDiscoveryPatch(current = {}) {
        return {
            ...current,
            phase: 'paused',
            phaseLabel: '等待继续',
            isRunning: false,
            isPaused: true,
            currentDomain: '',
            lastMessage: current.lastMessage || '上次持续发现已中断，可继续'
        };
    },

    buildStartContinuousDiscoveryPatch(current = {}, options = {}) {
        const normalizedDomain = options.normalizedDomain || '';
        const normalizedMyDomain = options.normalizedMyDomain || '';
        const normalizedSources = options.normalizedSources || [];
        const seedChanged = !!options.seedChanged;
        const pendingFrontierDomains = Number(options.pendingFrontierDomains || 0);

        return {
            ...current,
            taskId: seedChanged || !current.taskId ? `discover-${Date.now()}` : current.taskId,
            workflowId: 'continuous-discovery',
            isRunning: true,
            isPaused: false,
            seedDomain: normalizedDomain ? `https://${normalizedDomain}/` : '',
            myDomain: normalizedMyDomain ? `https://${normalizedMyDomain}/` : '',
            sources: normalizedSources,
            seedInitialized: (seedChanged || pendingFrontierDomains === 0) ? false : !!current.seedInitialized,
            currentDomain: '',
            phase: 'queued',
            phaseLabel: '准备启动',
            stepIndex: 0,
            stepTotal: 0,
            lastMessage: (seedChanged || pendingFrontierDomains === 0)
                ? '准备启动新的持续发现流程'
                : '继续持续发现流程'
        };
    },

    buildPauseContinuousDiscoveryPatch(current = {}) {
        return {
            ...current,
            phase: 'paused',
            phaseLabel: '等待继续',
            isRunning: false,
            isPaused: true,
            currentDomain: '',
            lastMessage: '已暂停持续发现'
        };
    },

    buildContinuousStepPatch(current = {}, task = {}, step = {}, stepIndex = 0, stepTotal = 0) {
        return {
            ...current,
            taskId: task.id || current.taskId || '',
            workflowId: task.workflowId || current.workflowId || 'continuous-discovery',
            phase: step.id || step.action || 'running',
            phaseLabel: step.label || step.id || step.action || '执行中',
            stepIndex: stepIndex + 1,
            stepTotal
        };
    },

    buildContinuousTaskCompletedPatch(current = {}, message = '持续发现已完成') {
        return {
            ...current,
            phase: 'completed',
            phaseLabel: '已完成',
            isRunning: false,
            currentDomain: '',
            lastCompletedAt: new Date().toISOString(),
            lastMessage: message
        };
    },

    buildContinuousDiscoveryView(state, metrics = {}) {
        return {
            ...(state || {}),
            pendingDomains: metrics.pendingDomains || 0,
            processedDomains: metrics.processedDomains || 0,
            failedDomains: metrics.failedDomains || 0
        };
    },

    createDefaultMarketingAutomationState() {
        return {
            taskId: '',
            workflowId: 'marketing-automation',
            isRunning: false,
            isPaused: true,
            pauseReason: '',
            currentTaskId: '',
            currentTaskName: '',
            currentTaskType: '',
            phase: 'idle',
            phaseLabel: '',
            processedTasks: 0,
            pendingTasks: 0,
            dueNurtureTasks: 0,
            scheduledPromotionTasks: 0,
            nextPromotionRefreshAt: '',
            lastStartedAt: '',
            lastCompletedAt: '',
            lastMessage: ''
        };
    },

    normalizeMarketingAutomationPatch(current, patch = {}) {
        return {
            ...current,
            ...(patch || {})
        };
    },

    buildInterruptedMarketingAutomationPatch(current = {}) {
        return {
            ...current,
            phase: 'paused',
            phaseLabel: '等待继续',
            isRunning: false,
            isPaused: true,
            pauseReason: 'interrupted',
            currentTaskId: '',
            currentTaskName: '',
            currentTaskType: '',
            lastMessage: current.lastMessage || '上次持续宣传已中断，可继续'
        };
    },

    buildStartMarketingAutomationPatch(current = {}, metrics = {}) {
        return {
            ...current,
            taskId: current.taskId || `marketing-${Date.now()}`,
            workflowId: 'marketing-automation',
            isRunning: true,
            isPaused: false,
            pauseReason: '',
            phase: 'queued',
            phaseLabel: '准备启动',
            pendingTasks: Number(metrics.pendingTasks || 0),
            dueNurtureTasks: Number(metrics.dueNurtureTasks || 0),
            scheduledPromotionTasks: Number(metrics.scheduledPromotionTasks || 0),
            nextPromotionRefreshAt: metrics.nextPromotionRefreshAt || '',
            lastStartedAt: new Date().toISOString(),
            lastMessage: current.lastCompletedAt ? '继续持续宣传流程' : '准备启动持续宣传流程'
        };
    },

    buildPauseMarketingAutomationPatch(current = {}) {
        return {
            ...current,
            phase: 'paused',
            phaseLabel: '等待继续',
            isRunning: false,
            isPaused: true,
            pauseReason: 'manual',
            currentTaskId: '',
            currentTaskName: '',
            currentTaskType: '',
            lastMessage: '已暂停持续宣传'
        };
    },

    buildMarketingAutomationView(state = {}, metrics = {}) {
        return {
            ...(state || {}),
            pendingTasks: Number(metrics.pendingTasks ?? state.pendingTasks ?? 0),
            dueNurtureTasks: Number(metrics.dueNurtureTasks ?? state.dueNurtureTasks ?? 0),
            scheduledPromotionTasks: Number(metrics.scheduledPromotionTasks ?? state.scheduledPromotionTasks ?? 0),
            nextPromotionRefreshAt: metrics.nextPromotionRefreshAt ?? state.nextPromotionRefreshAt ?? '',
            processedTasks: Number(metrics.processedTasks ?? state.processedTasks ?? 0)
        };
    }
};

self.TaskManager = TaskManager;
