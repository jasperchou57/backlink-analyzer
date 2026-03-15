/**
 * Auto-publish dispatch - schedules and runs automatic publish task dispatch.
 * Uses a factory pattern since it manages runtime state (timers, running flag).
 */
const AutoPublishDispatch = {
    create(deps) {
        const {
            getTaskType,
            getPublishWorkflow,
            canPublishResourceForTask,
            WorkflowRegistry,
            getResourcePool,
            selectDispatchResources,
            getAllDomainPublishPolicies,
            isResourceCoolingDown,
            getResourcePublishRankingScore,
            getEffectiveResourceSourceTier,
            getResourceAnchorVerifiedCount,
            getSourceTierScore,
            isPublishBatchRunning,
            getPublishStateView,
            getAutoPublishControlState,
            setManualPublishFocusTask,
            startPublish,
            TaskStore,
            Logger,
            PublishMemory,
            compactText,
            ensurePublishSessionsLoaded,
            ensurePublishBatchStateLoaded,
            ensureAutoPublishControlLoaded,
            getStoredResources
        } = deps;

        let dispatchTimer = null;
        let dispatchRunning = false;

        function isAutoPublishTask(task = {}) {
            return getTaskType(task) === 'publish'
                && task.workflowId === 'blog-comment-backlink'
                && task.mode === 'full-auto'
                && !task.autoDispatchPaused
                && !!compactText(task.website || task.anchorUrl || '');
        }

        function getAutoPublishTaskScore(summary = {}) {
            let score = Number(summary.topScore || 0);
            score += Math.min(Number(summary.readyCount || 0), 40) * 800;
            score += Math.min(Number(summary.verifiedCount || 0), 12) * 1200;
            score += Math.min(Number(summary.commentObservedCount || 0), 12) * 220;
            if (summary.commentStyle === 'anchor-html') {
                score += 1600;
            } else if (summary.commentStyle === 'anchor-prefer') {
                score += 900;
            }
            return Math.round(score);
        }

        function summarizeAutoPublishTask(task = {}, resources = [], policies = {}, siteTemplates = {}) {
            if (!isAutoPublishTask(task)) return null;

            const workflow = getPublishWorkflow(task);
            const readyResources = (resources || [])
                .filter((resource) =>
                    canPublishResourceForTask(resource, task)
                    && WorkflowRegistry.supportsResource(workflow, resource, task)
                    && !isResourceCoolingDown(resource, policies)
                );
            const dispatchSelection = selectDispatchResources(readyResources);
            const selectedResources = (dispatchSelection.resources || [])
                .map((resource) => ({
                    resource,
                    score: getResourcePublishRankingScore(resource, task, siteTemplates)
                }))
                .sort((left, right) => right.score - left.score);

            if (selectedResources.length === 0) return null;

            const top = selectedResources[0];
            const topResource = top?.resource || {};
            const topSourceEvidence = topResource.sourceEvidence || {};
            const summary = {
                task,
                readyCount: selectedResources.length,
                poolCounts: dispatchSelection.counts,
                activePool: dispatchSelection.activePool || '',
                topScore: Number(top?.score || 0),
                topResourceId: topResource.id || '',
                topResourceUrl: topResource.url || '',
                verifiedCount: getResourceAnchorVerifiedCount(topResource),
                commentObservedCount: Number(topSourceEvidence.commentObserved || 0),
                commentStyle: task.commentStyle || 'standard'
            };
            summary.dispatchScore = getAutoPublishTaskScore(summary);
            return summary;
        }

        function schedule(reason = 'resource-update', delayMs = 1200) {
            if (isPublishBatchRunning()) {
                return;
            }
            if (dispatchTimer) {
                clearTimeout(dispatchTimer);
            }
            dispatchTimer = setTimeout(() => {
                dispatchTimer = null;
                run({ reason }).catch(async (error) => {
                    await Logger.error(`自动发布调度失败: ${error.message}`, { reason });
                });
            }, Math.max(200, Number(delayMs || 0)));
        }

        async function run(options = {}) {
            if (dispatchRunning) {
                return { success: false, code: 'auto_dispatch_running', message: '自动调度已在执行中。' };
            }

            dispatchRunning = true;
            try {
                await ensurePublishSessionsLoaded();
                await ensurePublishBatchStateLoaded();
                await ensureAutoPublishControlLoaded();
                if (isPublishBatchRunning()) {
                    return { success: false, code: 'publish_batch_busy', message: '批量发布进行中，自动调度暂不接管。' };
                }
                const sessionView = getPublishStateView();
                const activeTaskIdSet = new Set(sessionView.activeTaskIds || []);
                const controlState = getAutoPublishControlState();
                const manualFocusTaskId = controlState.manualFocusTaskId || '';

                const [tasks, resources, policies, siteTemplates] = await Promise.all([
                    TaskStore.getTasks(),
                    getStoredResources(),
                    getAllDomainPublishPolicies(),
                    self.PublishMemory?.getSiteTemplates?.() || {}
                ]);
                if (
                    manualFocusTaskId
                    && !(tasks || []).some((task) => task?.id === manualFocusTaskId && isAutoPublishTask(task))
                ) {
                    await setManualPublishFocusTask('', 'focus-task-inactive');
                }
                const effectiveManualFocusTaskId = getAutoPublishControlState().manualFocusTaskId || '';

                const candidates = (tasks || [])
                    .map((task) => summarizeAutoPublishTask(task, resources, policies, siteTemplates))
                    .filter(Boolean)
                    .filter((item) => !activeTaskIdSet.has(item.task.id))
                    .filter((item) => !effectiveManualFocusTaskId || options.reason === 'manual-trigger' || item.task.id === effectiveManualFocusTaskId)
                    .sort((left, right) => right.dispatchScore - left.dispatchScore);

                if (candidates.length === 0) {
                    if (effectiveManualFocusTaskId && options.reason !== 'manual-trigger') {
                        return {
                            success: false,
                            code: 'manual_focus_locked',
                            message: '当前处于手动单任务模式，不会自动切换到其他发布任务。',
                            taskId: effectiveManualFocusTaskId
                        };
                    }
                    return { success: false, code: 'no_auto_publish_task', message: '当前没有可自动接力的全自动发布任务。' };
                }

                await Logger.publish('自动调度开始补齐可发任务', {
                    reason: options.reason || '',
                    candidateTaskIds: candidates.map((item) => item.task.id || ''),
                    activeTaskIds: [...activeTaskIdSet],
                    manualFocusTaskId: effectiveManualFocusTaskId
                });

                const startedTaskIds = [];
                const failedResults = [];
                for (const candidate of candidates) {
                    const result = await startPublish(candidate.task, { autoDispatch: true });
                    if (result?.success) {
                        startedTaskIds.push(candidate.task.id || '');
                        continue;
                    }
                    failedResults.push({
                        taskId: candidate.task.id || '',
                        code: result?.code || '',
                        message: result?.message || ''
                    });
                }

                if (startedTaskIds.length === 0) {
                    return {
                        success: false,
                        code: failedResults[0]?.code || 'auto_dispatch_noop',
                        message: failedResults[0]?.message || '自动调度没有启动新的发布任务。',
                        failures: failedResults
                    };
                }

                return {
                    success: true,
                    startedCount: startedTaskIds.length,
                    taskIds: startedTaskIds,
                    failures: failedResults
                };
            } finally {
                dispatchRunning = false;
            }
        }

        return {
            isAutoPublishTask,
            summarizeAutoPublishTask,
            getAutoPublishTaskScore,
            schedule,
            run,
            clearTimer: () => {
                if (dispatchTimer) {
                    clearTimeout(dispatchTimer);
                    dispatchTimer = null;
                }
            },
            isRunning: () => dispatchRunning
        };
    }
};
