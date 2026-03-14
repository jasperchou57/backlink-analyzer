const TaskRunner = {
    async run(task, ctx = {}) {
        const steps = Array.isArray(task?.steps) ? task.steps : [];
        const handlers = ctx.handlers || {};

        for (let index = 0; index < steps.length; index++) {
            const step = steps[index];
            if (ctx.shouldStop?.(task, step, index)) {
                break;
            }

            await ctx.onStepStart?.(step, index, steps.length, task);

            const handler = handlers[step.id] || handlers[step.action];
            if (typeof handler !== 'function') {
                throw new Error(`Missing task handler for step: ${step.id || step.action}`);
            }

            const result = await handler(step, index, steps.length, task);
            await ctx.onStepComplete?.(step, index, steps.length, result, task);

            if (result?.stop) {
                break;
            }
        }

        await ctx.onComplete?.(task);
    }
};

self.TaskRunner = TaskRunner;
