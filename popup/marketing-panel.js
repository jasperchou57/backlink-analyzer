(function (global) {
    function create(config = {}) {
        const getWorkflowMeta = config.getWorkflowMeta;
        const getDefaultWorkflowId = config.getDefaultWorkflowId;
        const isVisibleMarketingTask = config.isVisibleMarketingTask;
        const formatLastRunLabel = config.formatLastRunLabel;
        const getCurrentWorkspace = config.getCurrentWorkspace;
        const getCurrentTab = config.getCurrentTab;
        const refreshTasks = config.refreshTasks;

        async function refreshMarketingWorkspace() {
            const resp = await chrome.runtime.sendMessage({ action: 'getTasks' });
            const allTasks = resp?.tasks || [];
            const tasks = allTasks.filter(isVisibleMarketingTask);

            document.getElementById('marketing-total-tasks').textContent = tasks.length;
            document.getElementById('marketing-promote-count').textContent = tasks.filter((task) => {
                const taskType = getWorkflowMeta(task.workflowId || getDefaultWorkflowId())?.taskType || task.taskType || 'publish';
                return taskType === 'promote' || task.workflowId === 'product-promote-campaign';
            }).length;
            document.getElementById('marketing-nurture-count').textContent = tasks.filter((task) => {
                const taskType = getWorkflowMeta(task.workflowId || getDefaultWorkflowId())?.taskType || task.taskType || 'publish';
                return taskType === 'nurture';
            }).length;
            document.getElementById('marketing-run-count').textContent = tasks.reduce((sum, task) => sum + Number(task.runCount || 0), 0);

            const lastRunAt = tasks
                .map((task) => task.lastRunAt)
                .filter(Boolean)
                .sort()
                .pop();
            document.getElementById('marketing-last-run').textContent = `最近运行：${formatLastRunLabel(lastRunAt)}`;

            if (getCurrentWorkspace() === 'marketing' || getCurrentTab() === 'marketing') {
                await refreshTasks();
            }
        }

        let marketingAutomationState = {
            isRunning: false,
            isPaused: true,
            currentTaskName: '',
            phaseLabel: '',
            pendingTasks: 0,
            dueNurtureTasks: 0,
            processedTasks: 0,
            lastMessage: ''
        };

        async function refreshMarketingAutomationState() {
            const resp = await chrome.runtime.sendMessage({ action: 'getMarketingAutomationState' });
            updateMarketingAutomationUI(resp?.state || {});
        }

        function updateMarketingAutomationUI(state = {}) {
            marketingAutomationState = {
                ...marketingAutomationState,
                ...(state || {})
            };

            const btnStart = document.getElementById('btn-start-marketing-automation');
            const btnPause = document.getElementById('btn-pause-marketing-automation');
            const stateEl = document.getElementById('marketing-session-state');
            const taskEl = document.getElementById('marketing-current-task');
            const phaseEl = document.getElementById('marketing-current-phase');
            const pendingEl = document.getElementById('marketing-pending-count');
            const nurtureEl = document.getElementById('marketing-due-nurture-count');
            const messageEl = document.getElementById('marketing-session-message');

            const isRunning = !!marketingAutomationState.isRunning;
            const isPaused = !!marketingAutomationState.isPaused;
            const isScheduled = marketingAutomationState.phase === 'scheduled' || marketingAutomationState.pauseReason === 'scheduled';
            btnStart.disabled = isRunning;
            btnPause.disabled = !isRunning;
            btnStart.textContent = (marketingAutomationState.pendingTasks || marketingAutomationState.dueNurtureTasks || marketingAutomationState.processedTasks)
                ? '继续持续宣传'
                : '开始持续宣传';

            if (isRunning) {
                stateEl.textContent = '运行中';
            } else if (isScheduled) {
                stateEl.textContent = '等待调研';
            } else if (isPaused && (marketingAutomationState.pendingTasks || marketingAutomationState.dueNurtureTasks || marketingAutomationState.processedTasks)) {
                stateEl.textContent = '已暂停';
            } else {
                stateEl.textContent = '未启动';
            }

            taskEl.textContent = marketingAutomationState.currentTaskName || '-';
            phaseEl.textContent = marketingAutomationState.phaseLabel || '-';
            pendingEl.textContent = Number(marketingAutomationState.pendingTasks || 0);
            nurtureEl.textContent = Number(marketingAutomationState.dueNurtureTasks || 0);
            const nextRefreshLabel = formatLastRunLabel(marketingAutomationState.nextPromotionRefreshAt);
            const scheduledHint = isScheduled && nextRefreshLabel && nextRefreshLabel !== '-'
                ? `下次调研：${nextRefreshLabel}`
                : '';
            messageEl.textContent = [marketingAutomationState.lastMessage || '等待开始', scheduledHint].filter(Boolean).join(' · ');
        }

        return {
            refreshMarketingWorkspace,
            refreshMarketingAutomationState,
            updateMarketingAutomationUI
        };
    }

    global.MarketingPanel = { create };
})(typeof self !== 'undefined' ? self : window);
