(function (globalScope) {
    if (globalScope.PublishBatchRuntime) return;

    function uniqueIds(values = []) {
        return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
    }

    function shouldSkipTask(result = {}) {
        return ['no_pending_resources', 'site_history_exhausted', 'domain_cooldown_active'].includes(result?.code || '');
    }

    function create(config = {}) {
        const taskManager = config.taskManager;
        const stateStore = config.stateStore;
        const taskStore = config.taskStore;
        const logger = config.logger;

        let state = taskManager.createDefaultPublishBatchState();
        let loaded = false;
        let advanceTimer = null;

        function normalizeState(nextState = {}) {
            const activeTaskIds = uniqueIds(nextState.activeTaskIds);
            return {
                ...taskManager.createDefaultPublishBatchState(),
                ...(nextState || {}),
                queueTaskIds: uniqueIds(nextState.queueTaskIds),
                activeTaskIds,
                currentTaskId: activeTaskIds[0] || nextState.currentTaskId || '',
                completedTaskIds: uniqueIds(nextState.completedTaskIds),
                skippedTaskIds: uniqueIds(nextState.skippedTaskIds),
                failedTaskIds: uniqueIds(nextState.failedTaskIds)
            };
        }

        function getState() {
            return state;
        }

        async function ensureLoaded() {
            if (loaded) return;
            state = normalizeState(
                await stateStore.loadPublishBatchState(taskManager.createDefaultPublishBatchState())
            );
            loaded = true;
        }

        async function flush() {
            await stateStore.savePublishBatchState(state);
        }

        function broadcast() {
            config.broadcast?.(taskManager.buildPublishBatchView(state));
        }

        function setState(nextState = {}) {
            state = normalizeState(nextState);
            loaded = true;
            flush().catch(() => {});
            broadcast();
        }

        function updateState(patch = {}) {
            setState({
                ...state,
                ...(patch || {}),
                updatedAt: new Date().toISOString()
            });
        }

        function getDoneTaskIds(snapshot = state) {
            return [...new Set([
                ...(snapshot.completedTaskIds || []),
                ...(snapshot.skippedTaskIds || []),
                ...(snapshot.failedTaskIds || [])
            ])];
        }

        function getRemainingTaskIds(snapshot = state) {
            const doneSet = new Set(getDoneTaskIds(snapshot));
            return (snapshot.queueTaskIds || []).filter((taskId) => !doneSet.has(taskId));
        }

        function isRunning() {
            return !!state?.isRunning;
        }

        const WATCHDOG_ALARM_NAME = 'publish-batch-watchdog';

        function clearAdvanceTimer() {
            if (advanceTimer) {
                clearTimeout(advanceTimer);
                advanceTimer = null;
            }
        }

        async function startWatchdog() {
            try {
                await chrome.alarms.create(WATCHDOG_ALARM_NAME, {
                    delayInMinutes: 0.5,
                    periodInMinutes: 0.5
                });
            } catch {}
        }

        async function stopWatchdog() {
            try { await chrome.alarms.clear(WATCHDOG_ALARM_NAME); } catch {}
        }

        async function handleWatchdogAlarm() {
            await ensureLoaded();
            if (!isRunning()) {
                await stopWatchdog();
                return;
            }
            const sessionView = await config.getPublishStateView();
            const queueTaskIdSet = new Set(state.queueTaskIds || []);
            const activeTaskIds = uniqueIds(
                (sessionView.activeTaskIds || []).filter((id) => queueTaskIdSet.has(id))
            );
            if (activeTaskIds.length === 0 && getRemainingTaskIds(state).length > 0) {
                await logger.publish('看门狗恢复：检测到批量发布停滞，重新接力', { reason: 'watchdog' });
                await advance('watchdog-recover').catch(async (error) => {
                    await logger.error(`看门狗接力失败: ${error.message}`);
                });
            }
        }

        function scheduleAdvance(reason = 'publish-done', delayMs = 700) {
            clearAdvanceTimer();
            advanceTimer = setTimeout(() => {
                advanceTimer = null;
                advance(reason).catch(async (error) => {
                    await logger.error(`批量发布接力失败: ${error.message}`, { reason });
                });
            }, Math.max(200, Number(delayMs || 0)));
        }

        function buildStatusMessage(task = {}, outcome = 'completed', detail = '') {
            const name = task?.name || task?.website || task?.id || '任务';
            if (outcome === 'skipped') {
                return detail ? `已跳过 ${name} · ${detail}` : `已跳过 ${name}`;
            }
            if (outcome === 'failed') {
                return detail ? `任务失败 ${name} · ${detail}` : `任务失败 ${name}`;
            }
            return detail ? `已完成 ${name} · ${detail}` : `已完成 ${name}`;
        }

        async function finalize(message = '批量发布已完成') {
            await stopWatchdog();
            await ensureLoaded();
            if (!state.queueTaskIds?.length) {
                setState({
                    ...taskManager.createDefaultPublishBatchState(),
                    isRunning: false,
                    isPaused: true,
                    updatedAt: new Date().toISOString(),
                    lastCompletedAt: new Date().toISOString(),
                    lastMessage: message
                });
            } else {
                setState({
                    ...state,
                    isRunning: false,
                    isPaused: true,
                    activeTaskIds: [],
                    currentTaskId: '',
                    updatedAt: new Date().toISOString(),
                    lastCompletedAt: new Date().toISOString(),
                    lastMessage: message
                });
            }
            await logger.publish(message, {
                totalTasks: state.queueTaskIds?.length || 0,
                completed: state.completedTaskIds?.length || 0,
                skipped: state.skippedTaskIds?.length || 0,
                failed: state.failedTaskIds?.length || 0
            });
            return { success: true, completed: true, state: taskManager.buildPublishBatchView(state) };
        }

        async function markTask(taskId, outcome = 'completed', detail = '', taskMap = new Map()) {
            await ensureLoaded();
            if (!taskId) return;

            const completedTaskIds = [...(state.completedTaskIds || [])];
            const skippedTaskIds = [...(state.skippedTaskIds || [])];
            const failedTaskIds = [...(state.failedTaskIds || [])];
            const removeTaskId = (list) => list.filter((id) => id !== taskId);
            const normalizedOutcome = outcome === 'failed' ? 'failed' : outcome === 'skipped' ? 'skipped' : 'completed';
            const nextCompleted = normalizedOutcome === 'completed' ? uniqueIds([...removeTaskId(completedTaskIds), taskId]) : removeTaskId(completedTaskIds);
            const nextSkipped = normalizedOutcome === 'skipped' ? uniqueIds([...removeTaskId(skippedTaskIds), taskId]) : removeTaskId(skippedTaskIds);
            const nextFailed = normalizedOutcome === 'failed' ? uniqueIds([...removeTaskId(failedTaskIds), taskId]) : removeTaskId(failedTaskIds);
            const task = taskMap.get(taskId) || {};
            const nextActiveTaskIds = removeTaskId(state.activeTaskIds || []);

            updateState({
                activeTaskIds: nextActiveTaskIds,
                currentTaskId: nextActiveTaskIds[0] || '',
                completedTaskIds: nextCompleted,
                skippedTaskIds: nextSkipped,
                failedTaskIds: nextFailed,
                lastCompletedAt: new Date().toISOString(),
                lastMessage: buildStatusMessage(task, normalizedOutcome, detail)
            });
        }

        async function advance(reason = 'task-finished') {
            await config.ensurePublishSessionsLoaded?.();
            await ensureLoaded();
            if (!isRunning()) {
                return { success: false, code: 'publish_batch_idle', message: '当前没有运行中的批量发布。' };
            }

            const sessionView = await config.getPublishStateView();
            const tasks = await taskStore.getTasks();
            const taskMap = new Map((tasks || []).map((task) => [task.id, task]));
            const queueTaskIdSet = new Set(state.queueTaskIds || []);
            const sessionActiveTaskIds = uniqueIds((sessionView.activeTaskIds || []).filter((taskId) => queueTaskIdSet.has(taskId)));
            const trackedActiveTaskIds = uniqueIds((state.activeTaskIds || []).filter((taskId) => queueTaskIdSet.has(taskId)));

            for (const taskId of trackedActiveTaskIds) {
                if (!sessionActiveTaskIds.includes(taskId) && !getDoneTaskIds(state).includes(taskId)) {
                    await markTask(taskId, 'completed', '', taskMap);
                }
            }

            const activeTaskIds = uniqueIds((await config.getPublishStateView())?.activeTaskIds?.filter((taskId) => queueTaskIdSet.has(taskId)) || []);
            if (
                activeTaskIds.join('::') !== (state.activeTaskIds || []).join('::')
                || (activeTaskIds[0] || '') !== (state.currentTaskId || '')
            ) {
                const doneCountSync = getDoneTaskIds(state).length;
                const totalCountSync = (state.queueTaskIds || []).length;
                updateState({
                    activeTaskIds,
                    currentTaskId: activeTaskIds[0] || '',
                    lastMessage: activeTaskIds.length > 0
                        ? `正在执行第 ${doneCountSync + 1}/${totalCountSync} 个发布任务`
                        : (state.lastMessage || '等待批量发布结果')
                });
            }

            const remainingTaskIds = getRemainingTaskIds(state).filter((taskId) => !activeTaskIds.includes(taskId));
            if (remainingTaskIds.length === 0) {
                if (activeTaskIds.length === 0) {
                    return await finalize('批量发布已全部完成');
                }
                return {
                    success: true,
                    waiting: true,
                    activeTaskIds,
                    message: `正在执行发布任务，等待完成`
                };
            }

            let startedTaskId = '';
            for (const taskId of remainingTaskIds) {
                const task = taskMap.get(taskId);
                if (!task || config.getTaskType(task) !== 'publish') {
                    await markTask(taskId, 'failed', '任务不存在或不是发布任务', taskMap);
                    continue;
                }

                const result = await config.startPublish(task, { fromBatch: true, batchReason: reason });
                if (result?.success) {
                    startedTaskId = taskId;
                    break;
                }

                if (shouldSkipTask(result)) {
                    await markTask(taskId, 'skipped', result?.message || '', taskMap);
                    continue;
                }

                await markTask(taskId, 'failed', result?.message || '启动失败', taskMap);
            }

            const refreshedSessionView = await config.getPublishStateView();
            const nextActiveTaskIds = uniqueIds((refreshedSessionView.activeTaskIds || []).filter((taskId) => queueTaskIdSet.has(taskId)));
            const doneCount = getDoneTaskIds(state).length;
            const totalCount = (state.queueTaskIds || []).length;
            updateState({
                activeTaskIds: nextActiveTaskIds,
                currentTaskId: nextActiveTaskIds[0] || '',
                lastMessage: nextActiveTaskIds.length > 0
                    ? `正在执行第 ${doneCount + 1}/${totalCount} 个发布任务`
                    : (startedTaskId ? '批量发布已启动，等待任务完成' : state.lastMessage || '')
            });

            if (getRemainingTaskIds(state).length === 0 && nextActiveTaskIds.length === 0) {
                return await finalize('批量发布已完成，剩余任务均已跳过或失败');
            }

            return {
                success: true,
                started: !!startedTaskId,
                startedTaskIds: startedTaskId ? [startedTaskId] : [],
                activeTaskIds: nextActiveTaskIds,
                message: nextActiveTaskIds.length > 0
                    ? `正在执行第 ${doneCount + 1}/${totalCount} 个发布任务`
                    : '批量发布没有新的可启动任务'
            };
        }

        async function start(taskIds = []) {
            await config.ensurePublishSessionsLoaded?.();
            await ensureLoaded();

            if (isRunning()) {
                return {
                    success: false,
                    code: 'publish_batch_running',
                    message: '当前已有批量发布在运行，请先停止后再启动新的批量任务。'
                };
            }

            const tasks = await taskStore.getTasks();
            const publishTasks = (tasks || []).filter((task) => config.getTaskType(task) === 'publish');
            const publishTaskMap = new Map(publishTasks.map((task) => [task.id, task]));
            const dedupedTaskIds = uniqueIds(taskIds);
            const queueTaskIds = (dedupedTaskIds.length > 0 ? dedupedTaskIds : publishTasks.map((task) => task.id))
                .filter((taskId) => publishTaskMap.has(taskId));

            if (queueTaskIds.length === 0) {
                return {
                    success: false,
                    code: 'no_publish_tasks',
                    message: '当前没有可执行的发布任务。'
                };
            }

            config.clearAutoPublishDispatchTimer?.();
            clearAdvanceTimer();
            const sessionView = await config.getPublishStateView();
            const activeTaskIds = uniqueIds((sessionView.activeTaskIds || []).filter((taskId) => queueTaskIds.includes(taskId)));

            const now = new Date().toISOString();
            setState({
                ...taskManager.createDefaultPublishBatchState(),
                isRunning: true,
                isPaused: false,
                queueTaskIds,
                activeTaskIds,
                currentTaskId: activeTaskIds[0] || '',
                startedAt: now,
                updatedAt: now,
                lastMessage: activeTaskIds.length > 0
                    ? `准备依次执行 ${queueTaskIds.length} 个发布任务`
                    : `准备依次执行 ${queueTaskIds.length} 个发布任务`
            });

            await startWatchdog();
            await logger.publish('启动批量发布', {
                totalTasks: queueTaskIds.length,
                activeTaskIds,
                taskIds: queueTaskIds
            });

            return await advance('manual-batch-start');
        }

        async function stop(options = {}) {
            await config.ensurePublishSessionsLoaded?.();
            await ensureLoaded();

            const wasRunning = isRunning();
            const activeTaskIds = uniqueIds(state.activeTaskIds || []);
            const message = options.message || '已停止批量发布';
            updateState({
                isRunning: false,
                isPaused: true,
                activeTaskIds: [],
                currentTaskId: '',
                lastMessage: message
            });

            clearAdvanceTimer();
            await stopWatchdog();

            if (options.stopActiveTask !== false && activeTaskIds.length > 0) {
                for (const activeTaskId of activeTaskIds) {
                    await config.stopPublish(activeTaskId, {
                        skipBatchStop: true,
                        skipAutoDispatchPause: true
                    });
                }
            }

            if (wasRunning) {
                await logger.publish(message, {
                    totalTasks: state.queueTaskIds?.length || 0,
                    activeCount: activeTaskIds.length,
                    completed: state.completedTaskIds?.length || 0,
                    skipped: state.skippedTaskIds?.length || 0,
                    failed: state.failedTaskIds?.length || 0
                });
            }

            return {
                success: true,
                stopped: wasRunning,
                state: taskManager.buildPublishBatchView(state)
            };
        }

        async function reset(options = {}) {
            clearAdvanceTimer();
            state = taskManager.createDefaultPublishBatchState();
            loaded = !!options.loaded;
            if (options.persist !== false) {
                await flush();
            }
            broadcast();
        }

        return {
            getState,
            ensureLoaded,
            flush,
            setState,
            updateState,
            broadcast,
            getDoneTaskIds,
            getRemainingTaskIds,
            isRunning,
            scheduleAdvance,
            finalize,
            markTask,
            advance,
            start,
            stop,
            reset,
            clearAdvanceTimer,
            handleWatchdogAlarm,
            WATCHDOG_ALARM_NAME
        };
    }

    globalScope.PublishBatchRuntime = { create };
})(typeof self !== 'undefined' ? self : window);
