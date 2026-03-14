const DiscoverWorkflow = {
    WORKFLOW_ID: 'continuous-discovery',

    buildTask(state = {}) {
        const steps = [];

        if (!state.seedInitialized) {
            steps.push({
                id: 'seed_collect',
                action: 'seed_collect',
                label: '初始化种子网站'
            });
        }

        steps.push({
            id: 'frontier_collect',
            action: 'frontier_collect',
            label: '处理持续发现池'
        });

        return {
            id: state.taskId || `discover-${Date.now()}`,
            type: 'discover',
            workflowId: this.WORKFLOW_ID,
            label: '持续发现任务',
            steps
        };
    }
};

self.DiscoverWorkflow = DiscoverWorkflow;
