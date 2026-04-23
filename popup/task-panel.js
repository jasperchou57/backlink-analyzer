(function (global) {
    function create(config = {}) {
        const escapeHtml = config.escapeHtml || ((v) => String(v || ''));
        const normalizeUrl = config.normalizeUrl || ((v) => String(v || ''));
        const formatTime = config.formatTime || ((v) => String(v || '-'));
        const getHostLabel = config.getHostLabel || ((v) => String(v || ''));
        const formatFrequencyLabel = config.formatFrequencyLabel || ((v) => String(v || ''));
        const StorageHelper = config.StorageHelper;
        const getCurrentWorkspace = config.getCurrentWorkspace || (() => 'home');
        const getCurrentTab = config.getCurrentTab || (() => '');
        const getExpandedPublishTaskIds = config.getExpandedPublishTaskIds || (() => new Set());
        const getExpandedMarketingTaskIds = config.getExpandedMarketingTaskIds || (() => new Set());
        const refreshPublishStats = config.refreshPublishStats || (async () => {});
        const refreshMarketingWorkspace = config.refreshMarketingWorkspace || (async () => {});
        const compactText = config.compactText || ((v) => String(v || '').replace(/\s+/g, ' ').trim());

        let publishStateView = {
            isPublishing: false,
            activeCount: 0,
            activeTaskIds: [],
            sessions: {},
            batch: {
                isRunning: false,
                isPaused: true,
                currentTaskId: '',
                queueTaskIds: [],
                activeTaskIds: [],
                activeCount: 0,
                totalTasks: 0,
                completedTaskIds: [],
                skippedTaskIds: [],
                failedTaskIds: [],
                doneCount: 0,
                remainingCount: 0,
                lastMessage: ''
            }
        };
        let visiblePublishTaskIds = [];
        let visiblePublishTaskIdsByWorkflow = {};
        let taskRenderDiagnostics = [];

        function updatePublishProgress(msg) {
            if (msg?.taskId) {
                const existing = publishStateView.sessions?.[msg.taskId] || {};
                const nextSessions = {
                    ...(publishStateView.sessions || {}),
                    [msg.taskId]: {
                        ...existing,
                        isPublishing: !!msg.isPublishing,
                        currentIndex: Math.max(0, Number(msg.current || 1) - 1),
                        total: Number(msg.total || existing.total || 0),
                        currentUrl: msg.currentUrl || existing.currentUrl || '',
                        taskId: msg.taskId,
                        awaitingManualContinue: !!msg.awaitingManualContinue,
                        currentLimitCount: Number(msg.currentLimitCount ?? existing.currentLimitCount ?? 0),
                        targetLimitCount: Number(msg.targetLimitCount ?? existing.targetLimitCount ?? 0),
                        limitType: msg.limitType || existing.limitType || '',
                        sessionPublishedCount: Number(msg.sessionPublishedCount ?? existing.sessionPublishedCount ?? 0),
                        sessionAnchorSuccessCount: Number(msg.sessionAnchorSuccessCount ?? existing.sessionAnchorSuccessCount ?? 0),
                        currentStage: msg.currentStage || existing.currentStage || '',
                        currentStageLabel: msg.currentStageLabel || existing.currentStageLabel || '',
                        currentStageAt: msg.currentStageAt || existing.currentStageAt || ''
                    }
                };
                const activeTaskIds = Object.entries(nextSessions)
                    .filter(([, state]) => !!state?.isPublishing || !!state?.awaitingManualContinue)
                    .map(([taskId]) => taskId);
                publishStateView = {
                    ...(publishStateView || {}),
                    isPublishing: activeTaskIds.length > 0,
                    activeCount: activeTaskIds.length,
                    activeTaskIds,
                    sessions: nextSessions
                };
            }
            if (getCurrentWorkspace() === 'backlink' && getCurrentTab() === 'publish') {
                refreshTasks();
            }
        }

        async function refreshPublishState() {
            const state = await chrome.runtime.sendMessage({ action: 'getPublishState' });
            publishStateView = state || {
                isPublishing: false,
                activeCount: 0,
                activeTaskIds: [],
                sessions: {},
                batch: {
                    isRunning: false,
                    isPaused: true,
                    currentTaskId: '',
                    queueTaskIds: [],
                    activeTaskIds: [],
                    activeCount: 0,
                    totalTasks: 0,
                    completedTaskIds: [],
                    skippedTaskIds: [],
                    failedTaskIds: [],
                    doneCount: 0,
                    remainingCount: 0,
                    lastMessage: ''
                }
            };
            document.getElementById('publish-current').style.display = 'none';
            return publishStateView;
        }

        function getAvailableWorkflows() {
            return global.WorkflowRegistry?.list?.() || [];
        }

        function getWorkflowLabel(workflowId) {
            return global.WorkflowRegistry?.getLabel?.(workflowId) || 'Default Workflow';
        }

        function getWorkflowDescription(workflowId) {
            return global.WorkflowRegistry?.get?.(workflowId)?.description || '';
        }

        function getWorkflowMeta(workflowId) {
            return global.WorkflowRegistry?.getMeta?.(workflowId)
                || global.WorkflowRegistry?.get?.(workflowId)
                || null;
        }

        function getDefaultWorkflowId() {
            return global.WorkflowRegistry?.DEFAULT_WORKFLOW_ID || 'blog-comment-backlink';
        }

        function isInternalWorkflow(workflowId) {
            return !!(getWorkflowMeta(workflowId)?.internal);
        }

        function isBacklinkTask(task) {
            const workflowMeta = getWorkflowMeta(task?.workflowId || getDefaultWorkflowId()) || {};
            return (workflowMeta.taskType || 'publish') === 'publish';
        }

        function isMarketingTask(task) {
            return !isBacklinkTask(task);
        }

        function isVisibleMarketingTask(task) {
            return isMarketingTask(task) && !isInternalWorkflow(task?.workflowId || getDefaultWorkflowId());
        }

        function getDefaultWorkflowIdForWorkspace(workspace) {
            if (workspace === undefined) workspace = getCurrentWorkspace();
            const workflows = getAvailableWorkflows();
            const wantedMarketing = workspace === 'marketing';
            const match = workflows.find((workflow) => {
                const meta = getWorkflowMeta(workflow.id) || workflow;
                if (meta.internal) return false;
                return wantedMarketing
                    ? (meta.taskType || 'publish') !== 'publish'
                    : (meta.taskType || 'publish') === 'publish';
            });
            return match?.id || getDefaultWorkflowId();
        }

        function updatePublishWorkspaceView() {
            const title = document.getElementById('task-panel-title');
            const resetBtn = document.getElementById('btn-reset-publish-statuses');
            const publishStats = document.querySelector('#panel-publish .publish-stats');
            const publishOverview = document.getElementById('publish-overview-global');
            const publishEmpty = document.getElementById('publish-empty');
            const blogBar = document.getElementById('blog-count-bar');
            const anchorBar = document.getElementById('anchor-count-bar');
            const currentBox = document.getElementById('publish-current');

            const isMarketing = getCurrentWorkspace() === 'marketing';
            if (title) {
                title.textContent = isMarketing ? '营销任务' : '外链发布任务';
            }
            if (resetBtn) resetBtn.style.display = isMarketing ? 'none' : 'inline-flex';
            if (publishOverview) publishOverview.style.display = 'none';
            if (publishStats) publishStats.style.display = 'none';
            if (blogBar) blogBar.style.display = 'none';
            if (anchorBar) anchorBar.style.display = 'none';
            if (currentBox) currentBox.style.display = 'none';
            if (publishEmpty) publishEmpty.style.display = 'none';
        }

        function formatLastRunLabel(value) {
            if (!value) return '-';
            return formatTime(value);
        }

        function getTaskPublishTargetKey(task) {
            const raw = task?.website || task?.anchorUrl || '';
            return normalizeTargetKey(raw);
        }

        // Must match background's normalizeUrlBg exactly:
        // strips protocol, www., trailing slashes → "hostname/path"
        function normalizeTargetKey(url) {
            if (!url) return '';
            try {
                let u = url.trim().toLowerCase();
                if (!u.startsWith('http')) u = 'https://' + u;
                const parsed = new URL(u);
                let path = parsed.pathname.replace(/\/+$/, '') || '/';
                return parsed.hostname.replace(/^www\./, '') + path;
            } catch {
                return url.trim().toLowerCase();
            }
        }

        function getTaskHistoryEntry(resource, task) {
            const targetKey = getTaskPublishTargetKey(task);
            if (!targetKey) return null;
            return resource?.publishHistory?.[targetKey] || null;
        }

        function getHistoryAttempts(entry) {
            if (!entry) {
                return { published: 0, failed: 0, skipped: 0 };
            }

            const attempts = entry.attempts || {};
            if (Object.keys(attempts).length > 0) {
                return {
                    published: attempts.published || 0,
                    failed: attempts.failed || 0,
                    skipped: attempts.skipped || 0
                };
            }

            return {
                published: entry.lastStatus === 'published' ? 1 : 0,
                failed: entry.lastStatus === 'failed' ? 1 : 0,
                skipped: entry.lastStatus === 'skipped' ? 1 : 0
            };
        }

        function getCurrentHistoryCounts(entry) {
            return {
                published: entry?.lastStatus === 'published' ? 1 : 0,
                failed: entry?.lastStatus === 'failed' ? 1 : 0,
                skipped: entry?.lastStatus === 'skipped' ? 1 : 0
            };
        }

        function isPublishCandidateForTaskUi(resource, task = {}) {
            if (String(resource?.resourcePool || '').trim().toLowerCase() === 'quarantine') {
                return false;
            }
            return !!global.ResourceRules?.isPublishCandidateForTask?.(resource, task);
        }

        function computeTaskPublishOverview(task, resources) {
            const workflow = getWorkflowMeta(task?.workflowId || getDefaultWorkflowId());
            return resources.reduce((stats, resource) => {
                let supported = true;
                try {
                    supported = !!global.WorkflowRegistry?.supportsResource?.(workflow, resource, task);
                } catch {
                    supported = false;
                }
                if (!supported) {
                    return stats;
                }

                const historyEntry = getTaskHistoryEntry(resource, task);
                const attempts = getHistoryAttempts(historyEntry);
                const currentOutcome = getCurrentHistoryCounts(historyEntry);
                const isDirectCandidate = isPublishCandidateForTaskUi(resource, task);
                const hasTaskHistory = !!historyEntry && (attempts.published + attempts.failed + attempts.skipped > 0);
                // directTotal 只计当前池子里的候选，不再把"历史上碰过但现在已出池"的
                // 加进分母。让"待发布进度 X / Y"里的 Y 跟"免登录直发"池大小对齐；
                // 同工作流的任务现在分母一致，清理池子时分母自动同步更新。
                if (isDirectCandidate) {
                    stats.directTotal++;
                }

                stats.published += currentOutcome.published;
                stats.failed += currentOutcome.failed;
                stats.skipped += currentOutcome.skipped;
                stats.total += currentOutcome.published + currentOutcome.failed + currentOutcome.skipped;

                const taskPending =
                    (!historyEntry || !['published', 'failed', 'skipped'].includes(historyEntry.lastStatus))
                    && isDirectCandidate;
                if (taskPending) {
                    stats.pending++;
                    stats.direct++;
                }

                if (
                    attempts.published > 0 &&
                    (historyEntry?.publishMeta?.anchorInjected || historyEntry?.publishMeta?.anchorVisible || historyEntry?.publishMeta?.anchorRequested)
                ) {
                    stats.anchorSubmitted++;
                }

                if (attempts.published > 0 && historyEntry?.publishMeta?.anchorVisible) {
                    stats.anchorSuccess++;
                }

                return stats;
            }, {
                pending: 0,
                published: 0,
                failed: 0,
                skipped: 0,
                direct: 0,
                directTotal: 0,
                anchorSubmitted: 0,
                anchorSuccess: 0,
                total: 0
            });
        }

        function resetTaskRenderDiagnostics() {
            taskRenderDiagnostics = [];
        }

        function reportTaskRenderDiagnostic(task = {}, error = null) {
            const message = String(error?.message || error || 'render-error').trim() || 'render-error';
            taskRenderDiagnostics.push({
                taskId: task?.id || '',
                taskName: task?.name || task?.website || task?.platformUrl || '未命名任务',
                message
            });
            taskRenderDiagnostics = taskRenderDiagnostics.slice(-6);
        }

        function renderTaskRenderDiagnostics() {
            const panel = document.getElementById('task-render-diagnostics');
            if (!panel) return;

            if (!taskRenderDiagnostics.length) {
                panel.style.display = 'none';
                panel.innerHTML = '';
                return;
            }

            panel.style.display = 'block';
            panel.innerHTML = `
                <div class="task-render-diag-head">任务渲染已降级 ${taskRenderDiagnostics.length} 条</div>
                <div class="task-render-diag-list">
                    ${taskRenderDiagnostics.map((item) => `
                        <div class="task-render-diag-item">
                            <span class="task-render-diag-name">${escapeHtml(item.taskName)}</span>
                            <span class="task-render-diag-msg">${escapeHtml(item.message)}</span>
                        </div>
                    `).join('')}
                </div>
            `;
        }

        function appendFallbackTaskCard(list, task, error) {
            if (!list) return;

            const card = document.createElement('div');
            card.className = 'task-card';
            const workflowId = task?.workflowId || getDefaultWorkflowId();
            const workflowMeta = getWorkflowMeta(workflowId) || {};
            const taskType = workflowMeta.taskType || task?.taskType || 'publish';
            const sessionState = publishStateView.sessions?.[task?.id] || null;
            const isWaitingContinue = !!sessionState?.awaitingManualContinue;
            const isActivePublish = !!sessionState?.isPublishing || isWaitingContinue;
            const runTitle = taskType === 'publish'
                ? (isActivePublish ? '停止发布' : '开始发布')
                : '启动任务';
            const runIcon = taskType === 'publish'
                ? (isActivePublish ? '■' : '▶')
                : '↗';

            card.innerHTML = `
                <div class="task-head">
                    <div class="task-info">
                        <div class="task-name">${escapeHtml(task?.name || task?.website || task?.id || '未命名任务')}</div>
                        <div class="task-meta">${escapeHtml(task?.website || task?.platformUrl || '-')}</div>
                        <div class="task-workflow">${escapeHtml(getWorkflowLabel(workflowId))}</div>
                        <div class="task-stats-mini">任务卡片渲染降级显示</div>
                        <div class="task-stats-mini">${escapeHtml(error?.message || 'render-error')}</div>
                    </div>
                    <div class="task-actions">
                        <button class="task-btn task-run" title="${runTitle}">${runIcon}</button>
                        <button class="task-btn task-edit" title="编辑">✎</button>
                        <button class="task-btn task-del" title="删除">×</button>
                    </div>
                </div>
            `;

            card.querySelector('.task-run')?.addEventListener('click', async () => {
                if (taskType === 'publish') {
                    if (isActivePublish) {
                        await chrome.runtime.sendMessage({ action: 'stopPublish', taskId: task.id });
                        await refreshPublishState();
                        await refreshTasks();
                        return;
                    }

                    const result = await chrome.runtime.sendMessage({ action: 'startPublish', task });
                    if (!result?.success) {
                        alert(result?.message || '开始发布失败');
                        await refreshPublishState();
                        await refreshTasks();
                        return;
                    }
                    getExpandedPublishTaskIds().add(task.id);
                    await refreshPublishState();
                    await refreshTasks();
                    return;
                }

                const result = await chrome.runtime.sendMessage({ action: 'runMarketingTask', task });
                if (!result?.success) {
                    alert(result?.message || '任务启动失败');
                    return;
                }
                await refreshMarketingWorkspace();
                await refreshTasks();
            });

            card.querySelector('.task-edit')?.addEventListener('click', () => {
                openTaskEditor(task);
            });
            card.querySelector('.task-del')?.addEventListener('click', async () => {
                if (confirm(`确定删除任务 "${task?.name || task?.website || task?.id || ''}"？`)) {
                    await chrome.runtime.sendMessage({ action: 'deleteTask', taskId: task.id });
                    await refreshMarketingWorkspace();
                    await refreshTasks();
                }
            });

            list.appendChild(card);
        }

        function getDailyPeriodStart(now) {
            const d = now || new Date();
            const boundary = new Date(Date.UTC(
                d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 9, 0, 0, 0
            ));
            if (d.getTime() < boundary.getTime()) {
                boundary.setUTCDate(boundary.getUTCDate() - 1);
            }
            return boundary.getTime();
        }

        function getNextDailyResetLabel() {
            const now = new Date();
            const periodStart = getDailyPeriodStart(now);
            const nextReset = new Date(periodStart + 24 * 60 * 60 * 1000);
            const isToday = nextReset.getUTCDate() === now.getUTCDate()
                && nextReset.getUTCMonth() === now.getUTCMonth()
                && nextReset.getUTCFullYear() === now.getUTCFullYear();
            return isToday ? '今天 17:00' : '明天 17:00';
        }

        function isAnchorLimitTask(task) {
            return task?.commentStyle === 'anchor-html' || task?.commentStyle === 'anchor-prefer';
        }

        function getTaskDailyCount(task) {
            const periodStart = getDailyPeriodStart();
            const isCurrentPeriod = Number(task?.dailyPeriodStart || 0) === periodStart;
            if (!isCurrentPeriod) return 0;
            return isAnchorLimitTask(task)
                ? Number(task?.dailyAnchorSuccessCount || 0)
                : Number(task?.dailyPublishedCount || 0);
        }

        function getTaskPublishLimitLabel(task) {
            if (Number(task?.maxPublishes) <= 0) return '不限量';
            const dailyCount = getTaskDailyCount(task);
            const resetLabel = getNextDailyResetLabel();
            return isAnchorLimitTask(task)
                ? `每日锚文本 ${dailyCount}/${task.maxPublishes} · 重置 ${resetLabel}`
                : `每日发布 ${dailyCount}/${task.maxPublishes} · 重置 ${resetLabel}`;
        }

        function getCommentStyleLabel(commentStyle = 'standard') {
            if (commentStyle === 'anchor-html') return '严格锚文本';
            if (commentStyle === 'anchor-prefer') return '锚文本优先';
            return '普通评论';
        }

        function getTaskMaxPublishesFieldMeta(commentStyle = 'standard') {
            if (commentStyle === 'anchor-html') {
                return {
                    label: '每日成功锚文本上限',
                    placeholder: '留空表示持续尝试，直到没有可发资源',
                    help: '只在检测到页面支持 HTML 锚文本时才发布；不支持会直接跳过，不会退化成普通评论。次日北京时间 17:00 自动重置。'
                };
            }
            if (commentStyle === 'anchor-prefer') {
                return {
                    label: '每日成功发布上限',
                    placeholder: '留空表示持续尝试，直到没有可发资源',
                    help: '优先尝试 HTML 锚文本；如果页面不支持，则自动降级为普通评论发布。次日北京时间 17:00 自动重置。'
                };
            }

            return {
                label: '每日成功发布上限',
                placeholder: '留空表示发送全部符合条件的资源',
                help: '达到每日成功发布上限后，当前任务会自动停止。次日北京时间 17:00 自动重置。'
            };
        }

        function computeTaskStats(task, resources) {
            return resources.reduce((stats, resource) => {
                const historyEntry = getTaskHistoryEntry(resource, task);
                if (!historyEntry) return stats;

                const currentOutcome = getCurrentHistoryCounts(historyEntry);
                stats.success += currentOutcome.published;
                stats.failed += currentOutcome.failed;
                stats.skipped += currentOutcome.skipped;
                stats.total += currentOutcome.published + currentOutcome.failed + currentOutcome.skipped;
                return stats;
            }, { total: 0, success: 0, failed: 0, skipped: 0 });
        }

        // ============================================================
        // 多任务管理
        // ============================================================

        async function refreshTasks() {
            const resp = await chrome.runtime.sendMessage({ action: 'getTasks' });
            const allTasks = resp?.tasks || [];
            const currentWorkspace = getCurrentWorkspace();
            const tasks = currentWorkspace === 'marketing'
                ? allTasks.filter(isVisibleMarketingTask)
                : currentWorkspace === 'backlink'
                    ? allTasks.filter(isBacklinkTask)
                    : allTasks;
            const resources = await StorageHelper.getResources();
            const publishState = await chrome.runtime.sendMessage({ action: 'getPublishState' });
            publishStateView = publishState || {
                isPublishing: false,
                activeCount: 0,
                activeTaskIds: [],
                sessions: {},
                batch: {
                    isRunning: false,
                    isPaused: true,
                    currentTaskId: '',
                    queueTaskIds: [],
                    activeTaskIds: [],
                    activeCount: 0,
                    totalTasks: 0,
                    completedTaskIds: [],
                    skippedTaskIds: [],
                    failedTaskIds: [],
                    doneCount: 0,
                    remainingCount: 0,
                    lastMessage: ''
                }
            };
            visiblePublishTaskIds = tasks
                .filter((task) => isBacklinkTask(task))
                .map((task) => task.id)
                .filter(Boolean);
            visiblePublishTaskIdsByWorkflow = tasks
                .filter((task) => isBacklinkTask(task))
                .reduce((map, task) => {
                    const workflowId = task.workflowId || getDefaultWorkflowId();
                    if (!map[workflowId]) {
                        map[workflowId] = [];
                    }
                    if (task.id) {
                        map[workflowId].push(task.id);
                    }
                    return map;
                }, {});
            refreshWorkflowLibrary();
            const list = currentWorkspace === 'marketing'
                ? document.getElementById('marketing-task-list')
                : document.getElementById('task-list');
            list.innerHTML = '';
            resetTaskRenderDiagnostics();

            const expandedPublishTaskIds = getExpandedPublishTaskIds();
            const expandedMarketingTaskIds = getExpandedMarketingTaskIds();

            const visibleTaskIds = new Set(tasks.map((task) => task.id).filter(Boolean));
            Array.from(expandedPublishTaskIds).forEach((taskId) => {
                if (!visibleTaskIds.has(taskId)) {
                    expandedPublishTaskIds.delete(taskId);
                }
            });
            Array.from(expandedMarketingTaskIds).forEach((taskId) => {
                if (!visibleTaskIds.has(taskId)) {
                    expandedMarketingTaskIds.delete(taskId);
                }
            });

            if (tasks.length === 0) {
                if (currentWorkspace === 'marketing') {
                    document.getElementById('marketing-empty').style.display = 'block';
                } else {
                    list.innerHTML = '<div class="empty-hint">暂无外链发布任务，点击"新建任务"创建</div>';
                }
                refreshWorkflowLibrary();
                renderTaskRenderDiagnostics();
                return;
            }

            if (currentWorkspace === 'marketing') {
                document.getElementById('marketing-empty').style.display = 'none';
            }

            tasks.forEach(task => {
                try {
                    const card = document.createElement('div');
                    card.className = 'task-card';
                    const workflowMeta = getWorkflowMeta(task.workflowId || getDefaultWorkflowId()) || {};
                    const researchResult = task.researchResult || {};
                    const researchContext = task.researchContext || {};
                    const promotionPlan = task.promotionPlan || {};
                    const promotionChannels = (promotionPlan.channels || []).filter((item) =>
                        item?.workflowId !== 'account-nurture' && item?.url
                    );
                    const totalPromotionChannels = Number(promotionPlan.totalOpenableChannels || promotionChannels.length || 0);
                    const progressedPromotionChannels = Math.min(
                        totalPromotionChannels,
                        Number(promotionPlan.progressedChannelCount || promotionPlan.nextChannelIndex || 0)
                    );
                    const nextPromotionChannel = totalPromotionChannels > progressedPromotionChannels
                        ? promotionChannels[progressedPromotionChannels]
                        : null;
                    const historyStats = computeTaskStats(task, resources);
                    const publishOverview = computeTaskPublishOverview(task, resources);
                    const sessionState = publishStateView.sessions?.[task.id] || null;
                    const isSessionRunning = !!sessionState?.isPublishing;
                    const isWaitingContinue = !!sessionState?.awaitingManualContinue;
                    const isActivePublish = isSessionRunning || isWaitingContinue;
                    const isExpanded = expandedPublishTaskIds.has(task.id);
                    const hasHistoryStats = historyStats.total > 0;
                    const stats = hasHistoryStats
                        ? historyStats
                        : (task.stats || { total: 0, success: 0, pending: 0, failed: 0 });
                    const commentStyleLabel = getCommentStyleLabel(task.commentStyle || 'standard');
                    const limitLabel = getTaskPublishLimitLabel(task);
                    const taskType = workflowMeta.taskType || 'publish';
                    const isPromotionCampaign = task.workflowId === 'product-promote-campaign';
                    const isExpandedMarketing = expandedMarketingTaskIds.has(task.id);
                    const browserSuggestedCount = Number(
                        promotionPlan?.browserSuggestedCount
                        || researchResult?.browserSuggestedCount
                        || 0
                    );
                    const promotionMix = promotionPlan?.channelMix || researchResult?.channelMix || {};
                    const reviewItems = Array.isArray(promotionPlan?.reviewItems) ? promotionPlan.reviewItems : [];
                    const pendingReviewItems = reviewItems.filter((item) => !item?.checkedAt);
                    const promotionMixSummary = [
                        Number(promotionMix['community-post-promote'] || 0) ? `社区 ${promotionMix['community-post-promote']}` : '',
                        Number(promotionMix['directory-submit-promote'] || 0) ? `目录 ${promotionMix['directory-submit-promote']}` : '',
                        Number(promotionMix['account-nurture'] || 0) ? `养号 ${promotionMix['account-nurture']}` : ''
                    ].filter(Boolean).join(' · ');
                    const checkedReviewItems = reviewItems.filter((item) => !!item?.checkedAt);
                    const reviewSummaryItems = reviewItems.slice(0, 3);
                    const nextPromotionRefreshLabel = formatLastRunLabel(promotionPlan?.nextResearchAt || '');
                    const nextPromotionLabel = nextPromotionChannel?.name
                        || (nextPromotionRefreshLabel && nextPromotionRefreshLabel !== '-'
                            ? `等待下次调研 ${nextPromotionRefreshLabel}`
                            : (totalPromotionChannels > 0 ? '当前候选渠道都已打开过' : '待生成宣传渠道'));
                    const taskModeLabel = taskType === 'nurture'
                        ? `养号频率 · ${formatFrequencyLabel(task.frequency || 'daily')} · 下次 ${formatLastRunLabel(task.nextRunAt)}`
                        : isPromotionCampaign
                            ? `渠道流程 · 已打开 ${progressedPromotionChannels}/${totalPromotionChannels} · 调研 ${researchContext.queries?.length || 0} 组 · 识别 ${browserSuggestedCount} 个渠道 · 养号 ${promotionPlan.generatedNurtureTaskCount || 0}${nextPromotionRefreshLabel && nextPromotionRefreshLabel !== '-' ? ` · 下轮 ${nextPromotionRefreshLabel}` : ''}`
                            : taskType === 'research'
                                ? `调研计划 · 搜索 ${researchContext.queries?.length || 0} 组 · 渠道 ${researchResult.channels?.length || 0} · 识别 ${browserSuggestedCount}`
                                : taskType === 'promote'
                                    ? `发帖推广 · ${getHostLabel(task.platformUrl)}`
                                    : `${commentStyleLabel} · ${limitLabel}`;
                    const subMeta = taskType === 'nurture'
                        ? `${escapeHtml(task.platformUrl || task.website || '')} · 自动调度 · 最近 ${formatLastRunLabel(task.lastRunAt)}`
                        : isPromotionCampaign
                            ? `${escapeHtml(task.website)} · ${escapeHtml(promotionPlan.summary || task.campaignBrief || '产品宣传主任务')}`
                            : taskType === 'research'
                                ? `${escapeHtml(task.website)} · ${escapeHtml(researchResult.summary || '调研/规划')}`
                                : `${escapeHtml(task.website)} · ${task.mode === 'full-auto' ? '全自动' : '半自动'}`;
                    const runTitle = taskType !== 'publish'
                        ? (taskType === 'nurture'
                            ? '执行一次养号会话'
                            : isPromotionCampaign
                                ? (progressedPromotionChannels > 0 ? '继续产品宣传流程' : '启动产品宣传流程')
                                : taskType === 'research'
                                    ? '打开调研入口'
                                    : '打开发帖入口')
                        : (isActivePublish ? '停止发布' : (task.autoDispatchPaused ? '手动启动并恢复自动接力' : '开始发布'));
                    const runIcon = taskType !== 'publish' ? '↗' : (isActivePublish ? '■' : '▶');
                    const autoDispatchPausedHint = taskType === 'publish' && task.autoDispatchPaused
                        ? `<div class="task-stats-mini">自动接力已暂停</div>`
                        : '';
                    const queueProgressPercent = sessionState?.total
                        ? Math.min(100, Math.round((((sessionState.currentIndex || 0) + (isActivePublish ? 1 : 0)) / sessionState.total) * 100))
                        : 0;
                    const hasSessionLimit = Number(sessionState?.targetLimitCount || 0) > 0;
                    const isAnchorLimitType = sessionState?.limitType === 'anchor-success'
                        || task?.commentStyle === 'anchor-html'
                        || task?.commentStyle === 'anchor-prefer';
                    const sessionLimitLabel = isAnchorLimitType ? '今日成功锚文本' : '今日成功发布';
                    // 始终用后端按日期自动重置的 currentLimitCount，不用历史累计的 anchorSuccess
                    const sessionLimitDisplayCount = Number(sessionState?.currentLimitCount || 0);
                    const sessionLimitProgressPercent = hasSessionLimit
                        ? Math.min(100, Math.round((sessionLimitDisplayCount / Number(sessionState?.targetLimitCount || 1)) * 100))
                        : queueProgressPercent;
                    const sessionAttemptCount = sessionState?.total
                        ? Math.min((sessionState.currentIndex || 0) + (isActivePublish ? 1 : 0), sessionState.total)
                        : 0;
                    const taskQueueTotalCount = Math.max(0, Number(publishOverview.directTotal || 0));
                    const taskQueuePendingCount = Math.max(0, Number(publishOverview.direct || 0));
                    const taskQueueProcessedCount = Math.max(0, taskQueueTotalCount - taskQueuePendingCount);
                    const sessionStatusText = hasSessionLimit
                        ? `${sessionLimitLabel} ${sessionLimitDisplayCount} / ${Number(sessionState?.targetLimitCount || 0)}`
                        : (taskQueueTotalCount > 0 ? `待发布进度 ${taskQueueProcessedCount} / ${taskQueueTotalCount}` : (sessionState?.total ? `${sessionAttemptCount} / ${sessionState.total}` : '未启动'));
                    const sessionSecondaryText = hasSessionLimit
                        ? (taskQueueTotalCount > 0 ? `待发布进度 ${taskQueueProcessedCount} / ${taskQueueTotalCount}` : (sessionState?.total ? `当前轮队列 ${sessionAttemptCount} / ${sessionState.total}` : ''))
                        : '';
                    const sessionStageText = compactText(sessionState?.currentStageLabel || sessionState?.currentStage || '');
                    const publishOverviewHtml = taskType === 'publish'
                    ? `
                        <div class="task-overview-toggle">${isExpanded ? '收起发布概览' : '展开发布概览'}</div>
                        <div class="task-overview ${isExpanded ? 'expanded' : ''}" style="display:${isExpanded ? 'block' : 'none'}">
                            <div class="task-publish-stats">
                                <div class="task-publish-stat">
                                    <span class="task-publish-num">${publishOverview.pending}</span>
                                    <span class="task-publish-lbl">待发布</span>
                                </div>
                                <div class="task-publish-stat">
                                    <span class="task-publish-num green">${publishOverview.anchorSubmitted > 0 ? publishOverview.anchorSubmitted : publishOverview.published}</span>
                                    <span class="task-publish-lbl">已发布</span>
                                </div>
                                <div class="task-publish-stat">
                                    <span class="task-publish-num yellow">${publishOverview.skipped}</span>
                                    <span class="task-publish-lbl">已跳过</span>
                                </div>
                                <div class="task-publish-stat">
                                    <span class="task-publish-num red">${publishOverview.failed}</span>
                                    <span class="task-publish-lbl">失败</span>
                                </div>
                            </div>
                            <div class="task-overview-bars">
                                <div class="task-overview-bar">
                                    <span class="task-overview-bar-label">🔗 当前任务剩余免登录直发页</span>
                                    <span class="task-overview-bar-value">${publishOverview.direct}</span>
                                </div>
                                <div class="task-overview-bar">
                                    <span class="task-overview-bar-label">🧭 免登录直发池候选</span>
                                    <span class="task-overview-bar-value">${publishOverview.directTotal}</span>
                                </div>
                                <div class="task-overview-bar anchor">
                                    <span class="task-overview-bar-label">🔗 已提交锚文本</span>
                                    <span class="task-overview-bar-value">${publishOverview.anchorSubmitted}</span>
                                </div>
                                <div class="task-overview-bar success">
                                    <span class="task-overview-bar-label">✅ 成功锚文本外链</span>
                                    <span class="task-overview-bar-value">${publishOverview.anchorSuccess}</span>
                                </div>
                            </div>
                            <div class="task-session-box ${isActivePublish ? 'active' : ''}">
                                <div class="task-session-label">${isWaitingContinue ? '当前任务等待继续' : (isSessionRunning ? '当前任务发布中' : '当前任务未运行')}</div>
                                <div class="task-session-url">${escapeHtml(sessionState?.currentUrl || '-')}</div>
                                <div class="task-session-progress">
                                    <div class="task-session-progress-fill" style="width:${sessionLimitProgressPercent}%"></div>
                                </div>
                                ${sessionStageText ? `<div class="task-session-subtext">当前阶段：${escapeHtml(sessionStageText)}</div>` : ''}
                                <div class="task-session-foot">
                                    <span class="task-session-text">${sessionStatusText}</span>
                                    <div class="task-session-actions">
                                        ${isWaitingContinue ? `<button class="task-inline-btn task-overview-action task-continue-btn">继续</button>` : ''}
                                        ${isActivePublish ? `<button class="task-inline-btn danger task-overview-action task-stop-btn">停止</button>` : ''}
                                    </div>
                                </div>
                                ${sessionSecondaryText ? `<div class="task-session-subtext">${sessionSecondaryText}</div>` : ''}
                            </div>
                        </div>
                    `
                    : '';
                    const marketingPreview = isPromotionCampaign && promotionPlan.channels?.length
                        ? `
                                <div class="task-preview">
                                    <div class="task-preview-title">候选渠道</div>
                                    <div class="task-preview-list">${escapeHtml(promotionPlan.channels.slice(0, 3).map((item) => item.name || item.url || '').filter(Boolean).join(' · '))}</div>
                                    <div class="task-preview-meta">浏览器调研：${researchContext.queries?.length || 0} 组搜索 · 读页 ${researchContext.pageReads?.length || 0} 个 · 识别渠道 ${browserSuggestedCount} 个${promotionMixSummary ? ` · ${escapeHtml(promotionMixSummary)}` : ''} · 待人工检查 ${pendingReviewItems.length} 个 · 下一步：${escapeHtml(nextPromotionLabel)}</div>
                                </div>
                        `
                        : taskType === 'research' && researchResult.channels?.length
                            ? `
                                <div class="task-preview">
                                    <div class="task-preview-title">渠道建议</div>
                                    <div class="task-preview-list">${escapeHtml(researchResult.channels.slice(0, 3).map((item) => item.name || item.url || '').filter(Boolean).join(' · '))}</div>
                                    <div class="task-preview-meta">浏览器调研：${researchContext.queries?.length || 0} 组搜索 · 读页 ${researchContext.pageReads?.length || 0} 个 · 识别渠道 ${browserSuggestedCount} 个${promotionMixSummary ? ` · ${escapeHtml(promotionMixSummary)}` : ''} · 下一步：${escapeHtml((researchResult.nextSteps || []).slice(0, 2).join(' · ') || '已生成后续任务')}</div>
                                </div>
                            `
                            : '';
                    const marketingOverviewHtml = taskType !== 'publish'
                        ? `
                            <div class="task-overview-toggle">${isExpandedMarketing ? '收起任务概览' : '展开任务概览'}</div>
                            <div class="task-overview ${isExpandedMarketing ? 'expanded' : ''}" style="display:${isExpandedMarketing ? 'block' : 'none'}">
                                ${isPromotionCampaign ? `
                                    <div class="task-publish-stats">
                                        <div class="task-publish-stat">
                                            <span class="task-publish-num">${totalPromotionChannels}</span>
                                            <span class="task-publish-lbl">候选渠道</span>
                                        </div>
                                        <div class="task-publish-stat">
                                            <span class="task-publish-num green">${progressedPromotionChannels}</span>
                                            <span class="task-publish-lbl">已打开</span>
                                        </div>
                                        <div class="task-publish-stat">
                                            <span class="task-publish-num yellow">${pendingReviewItems.length}</span>
                                            <span class="task-publish-lbl">待人工检查</span>
                                        </div>
                                        <div class="task-publish-stat">
                                            <span class="task-publish-num">${checkedReviewItems.length}</span>
                                            <span class="task-publish-lbl">已检查</span>
                                        </div>
                                    </div>
                                    <div class="task-overview-bars">
                                        <div class="task-overview-bar">
                                            <span class="task-overview-bar-label">💬 社区候选</span>
                                            <span class="task-overview-bar-value">${Number(promotionMix['community-post-promote'] || 0)}</span>
                                        </div>
                                        <div class="task-overview-bar">
                                            <span class="task-overview-bar-label">📚 目录候选</span>
                                            <span class="task-overview-bar-value">${Number(promotionMix['directory-submit-promote'] || 0)}</span>
                                        </div>
                                        <div class="task-overview-bar anchor">
                                            <span class="task-overview-bar-label">🌱 养号渠道</span>
                                            <span class="task-overview-bar-value">${Number(promotionMix['account-nurture'] || 0)}</span>
                                        </div>
                                    </div>
                                    <div class="task-session-box ${progressedPromotionChannels > 0 ? 'active' : ''}">
                                        <div class="task-session-label">当前宣传状态</div>
                                        <div class="task-session-url">${escapeHtml(nextPromotionChannel?.url || reviewItems[0]?.url || task.website || '-')}</div>
                                        <div class="task-session-progress">
                                            <div class="task-session-progress-fill" style="width:${totalPromotionChannels ? Math.min(100, Math.round((progressedPromotionChannels / totalPromotionChannels) * 100)) : 0}%"></div>
                                        </div>
                                        <div class="task-session-foot">
                                            <span class="task-session-text">${totalPromotionChannels ? `${progressedPromotionChannels}/${totalPromotionChannels} · ${escapeHtml(nextPromotionLabel)}` : '待生成宣传渠道'}</span>
                                        </div>
                                    </div>
                                    ${reviewItems.length ? `
                                        <div class="marketing-review-list">
                                            ${reviewSummaryItems.map((item) => `
                                                <div class="marketing-review-item ${item.checkedAt ? 'checked' : ''}">
                                                    <div class="marketing-review-content">
                                                        <div class="marketing-review-name">${escapeHtml(item.name || getHostLabel(item.url || ''))}</div>
                                                        <div class="marketing-review-meta">${escapeHtml(getHostLabel(item.url || ''))} · ${item.checkedAt ? `已检查 ${escapeHtml(formatLastRunLabel(item.checkedAt))}` : `已打开待检查 · ${escapeHtml(formatLastRunLabel(item.openedAt))}`}</div>
                                                    </div>
                                                    <button class="task-inline-btn marketing-review-open task-overview-action" data-url="${escapeHtml(item.url || '')}">打开检查</button>
                                                </div>
                                            `).join('')}
                                        </div>
                                    ` : ''}
                                ` : `
                                    <div class="task-publish-stats">
                                        <div class="task-publish-stat">
                                            <span class="task-publish-num">${Number(task.runCount || 0)}</span>
                                            <span class="task-publish-lbl">累计执行</span>
                                        </div>
                                        <div class="task-publish-stat">
                                            <span class="task-publish-num">${escapeHtml(getHostLabel(task.platformUrl || task.website || '-'))}</span>
                                            <span class="task-publish-lbl">目标平台</span>
                                        </div>
                                        <div class="task-publish-stat">
                                            <span class="task-publish-num">${escapeHtml(formatLastRunLabel(task.lastRunAt))}</span>
                                            <span class="task-publish-lbl">最近运行</span>
                                        </div>
                                        <div class="task-publish-stat">
                                            <span class="task-publish-num">${escapeHtml(formatLastRunLabel(task.nextRunAt))}</span>
                                            <span class="task-publish-lbl">下次执行</span>
                                        </div>
                                    </div>
                                    <div class="task-session-box ${Number(task.runCount || 0) > 0 ? 'active' : ''}">
                                        <div class="task-session-label">当前养号状态</div>
                                        <div class="task-session-url">${escapeHtml(task.platformUrl || task.website || '-')}</div>
                                        <div class="task-session-progress">
                                            <div class="task-session-progress-fill" style="width:${Number(task.runCount || 0) > 0 ? 100 : 0}%"></div>
                                        </div>
                                        <div class="task-session-foot">
                                            <span class="task-session-text">频率 ${escapeHtml(formatFrequencyLabel(task.frequency || 'daily'))} · 下次 ${escapeHtml(formatLastRunLabel(task.nextRunAt))}</span>
                                        </div>
                                    </div>
                                `}
                            </div>
                        `
                        : '';
                    card.innerHTML = `
                    <div class="task-head">
                        <div class="task-info">
                            <div class="task-name">${escapeHtml(task.name || task.website)}</div>
                            <div class="task-meta">
                                ${subMeta}
                            </div>
                            <div class="task-workflow">
                                ${escapeHtml(getWorkflowLabel(task.workflowId || getDefaultWorkflowId()))}
                            </div>
                            <div class="task-stats-mini">
                                ${taskModeLabel}
                            </div>
                            <div class="task-stats-mini">
                                ✓${stats.success} · ✗${stats.failed} · Σ${stats.total}
                            </div>
                            ${autoDispatchPausedHint}
                            ${marketingPreview}
                        </div>
                        <div class="task-actions">
                            <button class="task-btn task-run ${isActivePublish ? 'running' : ''}" title="${runTitle}">${runIcon}</button>
                            <button class="task-btn task-edit" title="编辑">✎</button>
                            <button class="task-btn task-del" title="删除">×</button>
                        </div>
                    </div>
                    ${publishOverviewHtml}
                    ${marketingOverviewHtml}
                `;

                    if (taskType === 'publish' || taskType !== 'publish') {
                        card.classList.add('task-card-collapsible');
                        if ((taskType === 'publish' && isExpanded) || (taskType !== 'publish' && isExpandedMarketing)) {
                            card.classList.add('expanded');
                        }
                    }

                    card.querySelector('.task-run').addEventListener('click', () => {
                        if (taskType !== 'publish') {
                            chrome.runtime.sendMessage({ action: 'runMarketingTask', task }).then(async (result) => {
                        if (!result?.success) {
                            alert(result?.message || '任务启动失败');
                            return;
                        }
                        alert(result?.message || '任务已启动');
                                await refreshMarketingWorkspace();
                                await refreshTasks();
                            });
                        } else if (isActivePublish) {
                            chrome.runtime.sendMessage({ action: 'stopPublish', taskId: task.id }).then(async () => {
                                await refreshPublishState();
                                await refreshTasks();
                            });
                        } else {
                            chrome.runtime.sendMessage({ action: 'startPublish', task }).then(async (result) => {
                                if (!result?.success) {
                                    alert(result?.message || '开始发布失败');
                                    await refreshPublishState();
                                    await refreshTasks();
                                    await refreshPublishStats();
                                    return;
                                }

                                expandedPublishTaskIds.add(task.id);
                                await refreshPublishState();
                                await refreshTasks();
                            });
                        }
                    });

                    card.querySelectorAll('.marketing-review-open').forEach((btn) => {
                        btn.addEventListener('click', async (event) => {
                            event.stopPropagation();
                            const url = btn.dataset.url || '';
                            const result = await chrome.runtime.sendMessage({ action: 'inspectMarketingReview', taskId: task.id, url });
                            if (!result?.success) {
                                alert(result?.message || '打开待检查页面失败');
                                return;
                            }
                            await refreshMarketingWorkspace();
                            await refreshTasks();
                        });
                    });

                    if (taskType === 'publish') {
                        card.addEventListener('click', async (event) => {
                            if (event.target.closest('.task-actions') || event.target.closest('.task-overview-action')) {
                                return;
                            }
                            if (expandedPublishTaskIds.has(task.id)) {
                                expandedPublishTaskIds.delete(task.id);
                            } else {
                                expandedPublishTaskIds.add(task.id);
                            }
                            await refreshTasks();
                        });

                        const continueBtn = card.querySelector('.task-continue-btn');
                        if (continueBtn) {
                            continueBtn.addEventListener('click', async () => {
                                await chrome.runtime.sendMessage({ action: 'continuePublish', taskId: task.id });
                                await refreshPublishState();
                                await refreshTasks();
                            });
                        }

                        const stopBtn = card.querySelector('.task-stop-btn');
                        if (stopBtn) {
                            stopBtn.addEventListener('click', async () => {
                                await chrome.runtime.sendMessage({ action: 'stopPublish', taskId: task.id });
                                await refreshPublishState();
                                await refreshTasks();
                            });
                        }
                    } else {
                        card.addEventListener('click', async (event) => {
                            if (event.target.closest('.task-actions') || event.target.closest('.task-overview-action')) {
                                return;
                            }
                            if (expandedMarketingTaskIds.has(task.id)) {
                                expandedMarketingTaskIds.delete(task.id);
                            } else {
                                expandedMarketingTaskIds.add(task.id);
                            }
                            await refreshTasks();
                        });
                    }

                    card.querySelector('.task-edit').addEventListener('click', () => {
                        openTaskEditor(task);
                    });
                    card.querySelector('.task-del').addEventListener('click', async () => {
                        if (confirm(`确定删除任务 "${task.name || task.website}"？`)) {
                            await chrome.runtime.sendMessage({ action: 'deleteTask', taskId: task.id });
                            await refreshMarketingWorkspace();
                            refreshTasks();
                        }
                    });

                    list.appendChild(card);
                } catch (error) {
                    console.error('Failed to render task card', task, error);
                    reportTaskRenderDiagnostic(task, error);
                    appendFallbackTaskCard(list, task, error);
                }
            });
            renderTaskRenderDiagnostics();
        }

        function refreshWorkflowLibrary() {
            renderWorkflowLibrary('workflow-library', 'backlink');
            renderWorkflowLibrary('marketing-workflow-library', 'marketing');
        }

        function renderWorkflowLibrary(containerId, workspace) {
            const container = document.getElementById(containerId);
            if (!container) return;

            const workflows = getAvailableWorkflows().filter((workflow) => {
                const meta = getWorkflowMeta(workflow.id) || workflow;
                if (meta.internal) return false;
                return workspace === 'marketing'
                    ? (meta.taskType || 'publish') !== 'publish'
                    : (meta.taskType || 'publish') === 'publish';
            });

            container.innerHTML = workflows.map((workflow) => {
                const meta = getWorkflowMeta(workflow.id) || workflow;
                const workflowTaskIds = workspace === 'backlink'
                    ? (visiblePublishTaskIdsByWorkflow[workflow.id] || [])
                    : [];
                const batchState = publishStateView.batch || {};
                const queuedBatchTaskIds = Array.isArray(batchState.queueTaskIds) ? batchState.queueTaskIds : [];
                const activeBatchTaskIds = Array.isArray(batchState.activeTaskIds) ? batchState.activeTaskIds : [];
                const isWorkflowBatchRunning = workspace === 'backlink'
                    && !!batchState.isRunning
                    && workflowTaskIds.some((taskId) => queuedBatchTaskIds.includes(taskId));
                const isAnyBatchRunning = workspace === 'backlink' && !!batchState.isRunning;
                const workflowDoneCount = workflowTaskIds.filter((taskId) =>
                    (batchState.completedTaskIds || []).includes(taskId)
                    || (batchState.skippedTaskIds || []).includes(taskId)
                    || (batchState.failedTaskIds || []).includes(taskId)
                ).length;
                const workflowActiveCount = workflowTaskIds.filter((taskId) =>
                    activeBatchTaskIds.includes(taskId)
                ).length;
                const workflowBatchSummary = workspace === 'backlink' && workflowTaskIds.length
                    ? `${workflowDoneCount}/${workflowTaskIds.length} · ${isWorkflowBatchRunning
                        ? `执行中 ${workflowActiveCount} 个 · ${escapeHtml(batchState.lastMessage || '')}`
                        : '按当前任务批量依次执行'}`
                    : '';
                const typeLabel = workflow.id === 'product-promote-campaign'
                    ? '宣传'
                    : meta.taskType === 'nurture'
                        ? '养号'
                        : meta.taskType === 'research'
                            ? '调研'
                            : meta.taskType === 'promote'
                                ? '发帖'
                                : '发布';
                const canRunWorkflowBatch = workspace === 'backlink' && workflowTaskIds.length > 0;
                const workflowActionLabel = isWorkflowBatchRunning ? '停止' : '发布';
                const workflowActionDisabled = workspace === 'backlink'
                    ? (!canRunWorkflowBatch || (isAnyBatchRunning && !isWorkflowBatchRunning))
                    : false;
                const workflowActionHint = !canRunWorkflowBatch
                    ? '当前没有可执行的发布任务'
                    : (isAnyBatchRunning && !isWorkflowBatchRunning)
                        ? '另一批任务正在执行中'
                        : (isWorkflowBatchRunning
                            ? '停止当前批量发布'
                            : '按当前任务批量依次发布');

                return `
                    <div class="workflow-card">
                        <div class="workflow-card-head">
                            <div class="workflow-card-title-wrap">
                                <div class="workflow-card-title">${escapeHtml(workflow.name)}</div>
                                <div class="workflow-card-type">${typeLabel}</div>
                            </div>
                            ${workspace === 'backlink' ? `
                                <button
                                    class="workflow-card-action ${isWorkflowBatchRunning ? 'running' : ''}"
                                    data-workflow-id="${escapeHtml(workflow.id)}"
                                    title="${escapeHtml(workflowActionHint)}"
                                    ${workflowActionDisabled ? 'disabled' : ''}
                                >${workflowActionLabel}</button>
                            ` : ''}
                        </div>
                        <div class="workflow-card-desc">${escapeHtml(workflow.description || '')}</div>
                        ${workflowBatchSummary ? `<div class="workflow-card-meta">${workflowBatchSummary}</div>` : ''}
                    </div>
                `;
            }).join('');

            if (workspace === 'backlink') {
                container.querySelectorAll('.workflow-card-action').forEach((button) => {
                    button.addEventListener('click', async () => {
                        const workflowId = button.dataset.workflowId || '';
                        const taskIds = visiblePublishTaskIdsByWorkflow[workflowId] || [];
                        if (publishStateView.batch?.isRunning) {
                            const result = await chrome.runtime.sendMessage({ action: 'stopPublishBatch' });
                            if (!result?.success) {
                                alert(result?.message || '停止批量发布失败');
                            }
                            await refreshPublishState();
                            await refreshTasks();
                            return;
                        }

                        const result = await chrome.runtime.sendMessage({ action: 'startPublishBatch', taskIds });
                        if (!result?.success) {
                            alert(result?.message || '启动批量发布失败');
                            await refreshPublishState();
                            await refreshTasks();
                            return;
                        }
                        await refreshPublishState();
                        await refreshTasks();
                    });
                });
            }
        }

        async function openTaskEditor(existingTask) {
            const overlay = document.createElement('div');
            overlay.className = 'settings-overlay';

            const task = existingTask || {};
            const settings = await StorageHelper.getSettings();
            const editorWorkspace = existingTask
                ? (isMarketingTask(existingTask) ? 'marketing' : 'backlink')
                : (getCurrentWorkspace() === 'marketing' ? 'marketing' : 'backlink');
            const availableWorkflows = getAvailableWorkflows().filter((workflow) => {
                const meta = getWorkflowMeta(workflow.id) || workflow;
                if (meta.internal && workflow.id !== (task.workflowId || '')) return false;
                return editorWorkspace === 'marketing'
                    ? (meta.taskType || 'publish') !== 'publish'
                    : (meta.taskType || 'publish') === 'publish';
            });
            const workflows = availableWorkflows.length > 0 ? availableWorkflows : [{
                id: getDefaultWorkflowIdForWorkspace(editorWorkspace),
                name: getWorkflowLabel(getDefaultWorkflowIdForWorkspace(editorWorkspace))
            }];
            const selectedWorkflowId = task.workflowId || getDefaultWorkflowIdForWorkspace(editorWorkspace);
            const workflowOptions = workflows.map(workflow => `
                <option value="${escapeHtml(workflow.id)}" ${workflow.id === selectedWorkflowId ? 'selected' : ''}>
                    ${escapeHtml(workflow.name)}
                </option>
            `).join('');

            const renderWorkflowFields = (workflowId, currentTask = {}) => {
                const workflowMeta = getWorkflowMeta(workflowId) || {};
                const taskType = workflowMeta.taskType || 'publish';

                if (taskType === 'nurture') {
                    return `
                        <div class="settings-field">
                            <label>平台 URL</label>
                            <input class="input" id="task-platform-url" value="${escapeHtml(currentTask.platformUrl || '')}" placeholder="https://reddit.com/r/example">
                        </div>
                        <div class="settings-field">
                            <label>执行频率</label>
                            <select class="input" id="task-frequency">
                                <option value="daily" ${currentTask.frequency === 'daily' || !currentTask.frequency ? 'selected' : ''}>每天</option>
                                <option value="every-2-days" ${currentTask.frequency === 'every-2-days' ? 'selected' : ''}>每 2 天</option>
                                <option value="weekly" ${currentTask.frequency === 'weekly' ? 'selected' : ''}>每周</option>
                            </select>
                        </div>
                        <div class="settings-field">
                            <label>单次养号目标</label>
                            <input class="input" id="task-session-goal" value="${escapeHtml(currentTask.sessionGoal || '')}" placeholder="浏览 10 帖 + 点赞 3 次 + 评论 1 次">
                        </div>
                        <div class="settings-help">这类任务会作为长期任务保存，后续我会继续把自动调度和平台动作接进执行器。</div>
                    `;
                }

                if (workflowId === 'product-promote-campaign') {
                    return `
                        <div class="settings-field">
                            <label>目标受众</label>
                            <input class="input" id="task-target-audience" value="${escapeHtml(currentTask.targetAudience || '')}" placeholder="独立开发者 / 游戏玩家 / 工具站站长">
                        </div>
                        <div class="settings-field">
                            <label>偏好渠道</label>
                            <input class="input" id="task-preferred-channels" value="${escapeHtml(currentTask.preferredChannels || '')}" placeholder="Reddit, Product Hunt, Dev.to, HN">
                        </div>
                        <div class="settings-field">
                            <label>宣传简报</label>
                            <textarea class="input" id="task-campaign-brief" rows="4" placeholder="描述产品、推广目标、限制和希望重点突破的平台">${escapeHtml(currentTask.campaignBrief || '')}</textarea>
                        </div>
                        <div class="settings-help">这个主任务会先自动调研，再把社区发帖、目录提交整合进同一个宣传流程；只有长期养号会拆成单独任务。</div>
                    `;
                }

                if (taskType === 'research') {
                    return `
                        <div class="settings-field">
                            <label>目标受众</label>
                            <input class="input" id="task-target-audience" value="${escapeHtml(currentTask.targetAudience || '')}" placeholder="独立开发者 / 游戏玩家 / 工具站站长">
                        </div>
                        <div class="settings-field">
                            <label>偏好渠道</label>
                            <input class="input" id="task-preferred-channels" value="${escapeHtml(currentTask.preferredChannels || '')}" placeholder="Reddit, Product Hunt, Dev.to, HN">
                        </div>
                        <div class="settings-field">
                            <label>任务简报</label>
                            <textarea class="input" id="task-campaign-brief" rows="4" placeholder="描述产品、推广目标和限制">${escapeHtml(currentTask.campaignBrief || '')}</textarea>
                        </div>
                    `;
                }

                if (workflowId === 'community-post-promote' || workflowId === 'directory-submit-promote') {
                    return `
                        <div class="settings-field">
                            <label>平台 URL</label>
                            <input class="input" id="task-platform-url" value="${escapeHtml(currentTask.platformUrl || '')}" placeholder="https://reddit.com/r/example 或 https://www.producthunt.com">
                        </div>
                        <div class="settings-field">
                            <label>推广简报</label>
                            <textarea class="input" id="task-campaign-brief" rows="4" placeholder="一句话说明这个产品卖点、受众和你想发的平台风格">${escapeHtml(currentTask.campaignBrief || '')}</textarea>
                        </div>
                        <div class="settings-field">
                            <label>发帖角度 / 分类</label>
                            <input class="input" id="task-post-angle" value="${escapeHtml(currentTask.postAngle || currentTask.submitCategory || '')}" placeholder="Show HN / Launch story / 工具目录 / 游戏推荐">
                        </div>
                    `;
                }

                return `
                    <div class="settings-field">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                            <label style="margin:0">评论者名称（支持多条，一行一个，每次发布随机抽一个）</label>
                            <button type="button" class="btn-test" id="task-gen-identity-pool" style="padding:4px 10px;font-size:11px;margin:0">🎲 AI 生成 10 组</button>
                        </div>
                        <textarea class="input" id="task-commenter" rows="6" style="font-family:inherit;resize:vertical" placeholder="单条：Slime Seas Wiki&#10;多条（防反垃圾指纹识别）：&#10;Emily Chen&#10;Marcus Rodriguez&#10;Sarah Johnson">${escapeHtml(currentTask.name_commenter || '')}</textarea>
                    </div>
                    <div class="settings-field">
                        <label>评论者邮箱（多条时须与名称同顺序同数量，按索引配对）</label>
                        <textarea class="input" id="task-email" rows="6" style="font-family:inherit;resize:vertical" placeholder="单条：hello@slimeseas.com&#10;多条（与名称同顺序）：&#10;emily.chen@outlook.com&#10;marcus.r@gmail.com&#10;sarah.j@yahoo.com">${escapeHtml(currentTask.email || '')}</textarea>
                        <div style="font-size:11px;color:#8891a8;margin-top:4px">💡 用池子能让 Akismet / JetPack 反垃圾识别不到固定指纹。点右上"🎲 AI 生成 10 组"让 AI 自动生成一批身份，省去手动填的麻烦。</div>
                        <div class="test-result" id="task-gen-identity-result" style="margin-top:6px"></div>
                    </div>
                    <div class="settings-field">
                        <label>发布模式</label>
                        <select class="input" id="task-mode">
                            <option value="semi-auto" ${currentTask.mode !== 'full-auto' ? 'selected' : ''}>半自动（逐个确认）</option>
                            <option value="full-auto" ${currentTask.mode === 'full-auto' ? 'selected' : ''}>全自动（自动提交）</option>
                        </select>
                    </div>
                    <div class="settings-field">
                        <label>评论模式</label>
                        <select class="input" id="task-comment-style">
                            <option value="standard" ${!['anchor-html', 'anchor-prefer'].includes(currentTask.commentStyle) ? 'selected' : ''}>普通评论</option>
                            <option value="anchor-prefer" ${currentTask.commentStyle === 'anchor-prefer' ? 'selected' : ''}>锚文本优先（失败降级普通评论）</option>
                            <option value="anchor-html" ${currentTask.commentStyle === 'anchor-html' ? 'selected' : ''}>严格 HTML 锚文本模式（不支持即跳过）</option>
                        </select>
                    </div>
                    <div class="settings-field">
                        <label id="task-max-publishes-label">${escapeHtml(getTaskMaxPublishesFieldMeta(currentTask.commentStyle || 'standard').label)}</label>
                        <input class="input" id="task-max-publishes" type="number" min="1" value="${currentTask.maxPublishes ? escapeHtml(String(currentTask.maxPublishes)) : ''}" placeholder="${escapeHtml(getTaskMaxPublishesFieldMeta(currentTask.commentStyle || 'standard').placeholder)}">
                        <div class="settings-help" id="task-max-publishes-help">${escapeHtml(getTaskMaxPublishesFieldMeta(currentTask.commentStyle || 'standard').help)}</div>
                    </div>
                    <div class="settings-field">
                        <label>锚文本关键词</label>
                        <input class="input" id="task-anchor-keyword" value="${escapeHtml(currentTask.anchorKeyword || '')}" placeholder="${escapeHtml(settings.anchorKeyword || '留空则回退到设置页关键词')}">
                    </div>
                    <div class="settings-field">
                        <label>锚文本目标 URL</label>
                        <input class="input" id="task-anchor-url" value="${escapeHtml(currentTask.anchorUrl || '')}" placeholder="${escapeHtml(settings.anchorUrl || currentTask.website || '留空则回退到任务网站 URL')}">
                        <div class="settings-help">${currentTask.commentStyle === 'anchor-html' ? '只有检测到当前平台支持 HTML 锚文本时才会发布；不支持会直接跳过，不会改成普通评论。' : currentTask.commentStyle === 'anchor-prefer' ? '会优先尝试 HTML 锚文本；如果当前页面不支持，则自动改走普通评论链路。' : '普通评论模式下会优先走 website 字段等常规留链方式。'}</div>
                    </div>
                `;
            };

            overlay.innerHTML = `
                <h2>
                    <button class="settings-back" id="task-back">← 返回</button>
                    ${task.id ? '编辑任务' : (editorWorkspace === 'marketing' ? '新建营销任务' : '新建外链任务')}
                </h2>

                <div class="settings-section">
                    <div class="settings-field">
                        <label>任务名称</label>
                        <input class="input" id="task-name" value="${escapeHtml(task.name || '')}" placeholder="例如：主站推广">
                    </div>
                    <div class="settings-field">
                        <label>推广网站 URL</label>
                        <input class="input" id="task-website" value="${escapeHtml(task.website || '')}" placeholder="https://mysite.com">
                    </div>
                    <div class="settings-field">
                        <label>工作流</label>
                        <select class="input" id="task-workflow">
                            ${workflowOptions}
                        </select>
                        <div class="settings-help" id="task-workflow-desc">${escapeHtml(getWorkflowDescription(selectedWorkflowId))}</div>
                    </div>
                    <div id="task-workflow-fields">
                        ${renderWorkflowFields(selectedWorkflowId, task)}
                    </div>
                </div>

                <button class="btn-save" id="btn-save-task">保存任务</button>
            `;

            document.body.appendChild(overlay);

            overlay.querySelector('#task-back').addEventListener('click', () => overlay.remove());
            overlay.querySelector('#task-workflow').addEventListener('change', (event) => {
                const workflowId = event.target.value;
                overlay.querySelector('#task-workflow-desc').textContent = getWorkflowDescription(workflowId);
                overlay.querySelector('#task-workflow-fields').innerHTML = renderWorkflowFields(workflowId, task);
            });
            const updateMaxPublishesFieldMeta = () => {
                const commentStyle = overlay.querySelector('#task-comment-style')?.value || 'standard';
                const fieldMeta = getTaskMaxPublishesFieldMeta(commentStyle);
                const labelEl = overlay.querySelector('#task-max-publishes-label');
                const inputEl = overlay.querySelector('#task-max-publishes');
                const helpEl = overlay.querySelector('#task-max-publishes-help');
                if (labelEl) labelEl.textContent = fieldMeta.label;
                if (inputEl) inputEl.placeholder = fieldMeta.placeholder;
                if (helpEl) helpEl.textContent = fieldMeta.help;
            };
            overlay.addEventListener('change', (event) => {
                if (event.target?.id === 'task-comment-style') {
                    updateMaxPublishesFieldMeta();
                }
            });
            updateMaxPublishesFieldMeta();

            // AI 生成评论者身份池。用事件代理，因为 workflow 切换时字段会重新渲染。
            overlay.addEventListener('click', async (event) => {
                if (event.target?.id !== 'task-gen-identity-pool') return;
                const btn = event.target;
                const nameEl = overlay.querySelector('#task-commenter');
                const emailEl = overlay.querySelector('#task-email');
                const resultEl = overlay.querySelector('#task-gen-identity-result');
                if (!nameEl || !emailEl) return;

                // 如果已有内容，确认覆盖
                if ((nameEl.value.trim() || emailEl.value.trim())) {
                    if (!confirm('当前已填写了名称/邮箱，AI 生成会覆盖现有内容。确认继续？')) return;
                }

                btn.disabled = true;
                const originalText = btn.textContent;
                btn.textContent = '生成中...';
                resultEl.textContent = '正在调用 AI 生成 10 组身份（约 5-15 秒）...';
                resultEl.className = 'test-result';

                try {
                    const result = await chrome.runtime.sendMessage({ action: 'generateIdentityPool', count: 10 });
                    if (!result?.success) {
                        resultEl.innerHTML = `✗ ${escapeHtml(result?.message || '生成失败')}${result?.hint ? '<br><span style="color:#8891a8">' + escapeHtml(result.hint) + '</span>' : ''}`;
                        resultEl.className = 'test-result error';
                        return;
                    }
                    nameEl.value = result.names.join('\n');
                    emailEl.value = result.emails.join('\n');
                    resultEl.innerHTML = `✓ 已生成 ${result.count} 组身份，已填入上面两个框。看着觉得行就继续保存任务；不满意点"🎲 AI 生成"再换一批。`;
                    resultEl.className = 'test-result success';
                } catch (e) {
                    resultEl.textContent = '✗ ' + (e?.message || 'AI 调用失败');
                    resultEl.className = 'test-result error';
                } finally {
                    btn.disabled = false;
                    btn.textContent = originalText;
                }
            });
            overlay.querySelector('#btn-save-task').addEventListener('click', async () => {
                const website = overlay.querySelector('#task-website').value.trim();
                if (!website) {
                    overlay.querySelector('#task-website').focus();
                    return;
                }

                const workflowId = overlay.querySelector('#task-workflow').value || getDefaultWorkflowIdForWorkspace(editorWorkspace);
                const workflowMeta = getWorkflowMeta(workflowId) || {};
                const taskType = workflowMeta.taskType || 'publish';

                const taskData = {
                    id: task.id || undefined,
                    name: overlay.querySelector('#task-name').value.trim() || website,
                    website,
                    workflowId,
                    taskType
                };

                if (taskType === 'nurture') {
                    taskData.platformUrl = overlay.querySelector('#task-platform-url')?.value.trim() || '';
                    taskData.frequency = overlay.querySelector('#task-frequency')?.value || 'daily';
                    taskData.sessionGoal = overlay.querySelector('#task-session-goal')?.value.trim() || '';
                } else if (workflowId === 'product-promote-campaign') {
                    taskData.targetAudience = overlay.querySelector('#task-target-audience')?.value.trim() || '';
                    taskData.preferredChannels = overlay.querySelector('#task-preferred-channels')?.value.trim() || '';
                    taskData.campaignBrief = overlay.querySelector('#task-campaign-brief')?.value.trim() || '';
                } else if (taskType === 'research') {
                    taskData.targetAudience = overlay.querySelector('#task-target-audience')?.value.trim() || '';
                    taskData.preferredChannels = overlay.querySelector('#task-preferred-channels')?.value.trim() || '';
                    taskData.campaignBrief = overlay.querySelector('#task-campaign-brief')?.value.trim() || '';
                } else if (taskType === 'promote' && workflowId !== 'blog-comment-backlink') {
                    taskData.platformUrl = overlay.querySelector('#task-platform-url')?.value.trim() || '';
                    taskData.campaignBrief = overlay.querySelector('#task-campaign-brief')?.value.trim() || '';
                    taskData.postAngle = overlay.querySelector('#task-post-angle')?.value.trim() || '';
                    if (workflowId === 'directory-submit-promote') {
                        taskData.submitCategory = taskData.postAngle;
                    }
                } else {
                    taskData.name_commenter = overlay.querySelector('#task-commenter')?.value.trim() || '';
                    taskData.email = overlay.querySelector('#task-email')?.value.trim() || '';
                    taskData.maxPublishes = Number(overlay.querySelector('#task-max-publishes')?.value) > 0
                        ? Number(overlay.querySelector('#task-max-publishes').value)
                        : 0;
                    taskData.mode = overlay.querySelector('#task-mode')?.value || 'semi-auto';
                    taskData.commentStyle = overlay.querySelector('#task-comment-style')?.value || 'standard';
                    taskData.anchorKeyword = overlay.querySelector('#task-anchor-keyword')?.value.trim() || '';
                    taskData.anchorUrl = overlay.querySelector('#task-anchor-url')?.value.trim() || '';
                }

                await chrome.runtime.sendMessage({ action: 'saveTask', task: taskData });
                overlay.remove();
                refreshTasks();
            });
        }

        return {
            updatePublishProgress,
            refreshPublishState,
            refreshTasks,
            refreshWorkflowLibrary,
            openTaskEditor,
            getAvailableWorkflows,
            getWorkflowLabel,
            getWorkflowMeta,
            getDefaultWorkflowId,
            isBacklinkTask,
            isMarketingTask,
            isVisibleMarketingTask,
            getDefaultWorkflowIdForWorkspace,
            updatePublishWorkspaceView,
            formatLastRunLabel,
            isPublishCandidateForTaskUi,
            computeTaskPublishOverview,
            getTaskMaxPublishesFieldMeta,
            getCommentStyleLabel,
            getPublishStateView: () => publishStateView,
            setPublishStateView: (v) => { publishStateView = v; },
            getVisiblePublishTaskIds: () => visiblePublishTaskIds,
            getVisiblePublishTaskIdsByWorkflow: () => visiblePublishTaskIdsByWorkflow,
            getTaskPublishTargetKey,
            getTaskHistoryEntry,
            getHistoryAttempts,
            getCurrentHistoryCounts
        };
    }

    global.TaskPanel = { create };
})(typeof self !== 'undefined' ? self : window);
