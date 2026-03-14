const PublishWorkflowTask = {
    WORKFLOW_ID: 'publish-runtime',

    buildTask(task = {}) {
        return {
            id: `publish-${task?.id || Date.now()}`,
            type: 'publish',
            workflowId: this.WORKFLOW_ID,
            label: task?.name || task?.website || '发布任务',
            steps: [
                {
                    id: 'prepare_queue',
                    action: 'prepare_queue',
                    label: '准备发布队列'
                },
                {
                    id: 'dispatch_queue',
                    action: 'dispatch_queue',
                    label: '执行发布队列'
                }
            ]
        };
    }
};

self.PublishWorkflowTask = PublishWorkflowTask;
