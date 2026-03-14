const TaskStore = (() => {
    let writeQueue = Promise.resolve();
    let localTaskStoreReady = null;

    async function ensureLocalTaskStore() {
        if (typeof LocalDB === 'undefined') {
            return null;
        }

        if (!localTaskStoreReady) {
            localTaskStoreReady = (async () => {
                try {
                    if (typeof LocalDB.migrateFromChromeStorage === 'function') {
                        await LocalDB.migrateFromChromeStorage({ clearLegacy: true });
                    }
                    return LocalDB;
                } catch (error) {
                    console.warn('[BLA] LocalDB unavailable for publish tasks, falling back to chrome.storage.local', error);
                    return null;
                }
            })();
        }

        return await localTaskStoreReady;
    }

    function normalizeTasks(tasks) {
        return Array.isArray(tasks) ? tasks : [];
    }

    async function rawGetTasks() {
        const localStore = await ensureLocalTaskStore();
        if (localStore?.getPublishTasks) {
            return normalizeTasks(await localStore.getPublishTasks());
        }
        const data = await chrome.storage.local.get('publishTasks');
        return normalizeTasks(data.publishTasks);
    }

    async function rawSaveTasks(tasks) {
        const normalizedTasks = normalizeTasks(tasks);
        const localStore = await ensureLocalTaskStore();
        if (localStore?.setPublishTasks) {
            await localStore.setPublishTasks(normalizedTasks);
            try {
                await chrome.storage.local.remove('publishTasks');
            } catch {}
            return normalizedTasks;
        }
        await chrome.storage.local.set({ publishTasks: normalizedTasks });
        return normalizedTasks;
    }

    async function waitForPendingWrites() {
        try {
            await writeQueue;
        } catch {}
    }

    async function getTasks() {
        await waitForPendingWrites();
        return await rawGetTasks();
    }

    async function saveTasks(tasks) {
        return await updateTasks(() => normalizeTasks(tasks));
    }

    async function updateTasks(mutator) {
        const operation = writeQueue.then(async () => {
            const tasks = (await rawGetTasks()).map((task) => ({ ...task }));
            const result = await mutator(tasks);

            let nextTasks = tasks;
            let value = result;

            if (Array.isArray(result)) {
                nextTasks = result;
            } else if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'tasks')) {
                nextTasks = normalizeTasks(result.tasks);
                value = result.value;
            }

            const savedTasks = await rawSaveTasks(nextTasks);
            return {
                tasks: savedTasks,
                value: value === undefined ? savedTasks : value
            };
        });

        writeQueue = operation.then(() => undefined, () => undefined);
        const result = await operation;
        return result.value;
    }

    async function getTask(taskId) {
        if (!taskId) return null;
        const tasks = await getTasks();
        return tasks.find((task) => task.id === taskId) || null;
    }

    async function updateTask(taskId, updater) {
        if (!taskId) return null;
        return await updateTasks((tasks) => {
            const index = tasks.findIndex((task) => task.id === taskId);
            if (index < 0) {
                return { tasks, value: null };
            }

            const currentTask = tasks[index];
            const nextTask = updater({ ...currentTask }, tasks, index);
            if (!nextTask) {
                return { tasks, value: null };
            }

            tasks[index] = nextTask;
            return { tasks, value: nextTask };
        });
    }

    async function removeTask(taskId) {
        if (!taskId) return [];
        return await updateTasks((tasks) => tasks.filter((task) => task.id !== taskId));
    }

    return {
        getTasks,
        getTask,
        saveTasks,
        updateTasks,
        updateTask,
        removeTask
    };
})();

self.TaskStore = TaskStore;
