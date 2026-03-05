/**
 * Logger - 记录所有关键操作
 * 存储在 chrome.storage.local 中
 */

const Logger = {
    MAX_LOGS: 500,

    /**
     * 添加日志
     * @param {string} type - 类型: collect | analyze | publish | ai | system | error
     * @param {string} message - 日志消息
     * @param {object} data - 附加数据（可选）
     */
    async log(type, message, data = null) {
        const logs = await this._getLogs();
        const entry = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 4),
            type,
            message,
            data,
            timestamp: new Date().toISOString()
        };

        logs.unshift(entry); // 最新的在前面

        // 超过上限则截断
        if (logs.length > this.MAX_LOGS) {
            logs.length = this.MAX_LOGS;
        }

        await chrome.storage.local.set({ logs });

        // 广播给 popup
        try {
            chrome.runtime.sendMessage({ action: 'newLog', log: entry }).catch(() => {});
        } catch {}
    },

    async info(message, data) { return this.log('system', message, data); },
    async collect(message, data) { return this.log('collect', message, data); },
    async analyze(message, data) { return this.log('analyze', message, data); },
    async publish(message, data) { return this.log('publish', message, data); },
    async ai(message, data) { return this.log('ai', message, data); },
    async error(message, data) { return this.log('error', message, data); },

    /**
     * 获取所有日志
     */
    async getAll() {
        return this._getLogs();
    },

    /**
     * 清空日志
     */
    async clear() {
        await chrome.storage.local.set({ logs: [] });
    },

    async _getLogs() {
        return new Promise((resolve) => {
            chrome.storage.local.get('logs', (data) => {
                resolve(data.logs || []);
            });
        });
    }
};

if (typeof self !== 'undefined') {
    self.Logger = Logger;
}
if (typeof window !== 'undefined') {
    window.Logger = Logger;
}
