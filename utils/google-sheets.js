/**
 * Google Sheets 同步模块
 * 通过 Chrome Identity API + Google OAuth2 授权读写 Sheet
 */

const GoogleSheets = {
    SHEETS_API: 'https://sheets.googleapis.com/v4/spreadsheets',

    /**
     * 获取 OAuth2 token
     */
    async getToken() {
        return new Promise((resolve, reject) => {
            chrome.identity.getAuthToken({ interactive: true }, (token) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(token);
                }
            });
        });
    },

    /**
     * 同步资源到 Google Sheet
     * @param {string} spreadsheetId - Google Sheet ID
     * @param {Array} resources - 资源列表
     */
    async syncResources(spreadsheetId, resources) {
        if (!spreadsheetId) throw new Error('Google Sheet ID 未配置');

        const token = await this.getToken();
        const sheetName = 'Resources';

        // 准备数据行
        const headers = ['ID', 'URL', 'Page Title', 'Type', 'Status', 'Sources', 'Link Method', 'Discovered At', 'Published At'];
        const rows = resources.map(r => [
            r.id || '',
            r.url || '',
            r.pageTitle || '',
            r.type || (r.opportunities || []).join('+'),
            r.status || 'pending',
            (r.sources || []).join('+'),
            r.linkMethod || '',
            r.discoveredAt || '',
            r.publishedAt || ''
        ]);

        const values = [headers, ...rows];

        // 清空旧数据并写入新数据
        const range = `${sheetName}!A1:I${values.length + 1}`;

        // 先尝试清空
        try {
            await this._clearSheet(token, spreadsheetId, `${sheetName}!A:I`);
        } catch {
            // Sheet 可能不存在，尝试创建
            await this._createSheet(token, spreadsheetId, sheetName);
        }

        // 写入数据
        const url = `${this.SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ values })
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`Google Sheets API 错误: ${err}`);
        }

        return { success: true, rows: rows.length };
    },

    /**
     * 更新单条资源状态
     */
    async updateResourceStatus(spreadsheetId, resourceId, status) {
        if (!spreadsheetId) return;

        const token = await this.getToken();
        const sheetName = 'Resources';

        // 读取所有数据找到行号
        const readUrl = `${this.SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(`${sheetName}!A:A`)}`;
        const readResp = await fetch(readUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!readResp.ok) return;
        const readData = await readResp.json();
        const values = readData.values || [];

        const rowIndex = values.findIndex(row => row[0] === resourceId);
        if (rowIndex < 0) return;

        // 更新状态列 (E) 和发布时间列 (I)
        const updateRange = `${sheetName}!E${rowIndex + 1}:E${rowIndex + 1}`;
        const updateUrl = `${this.SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(updateRange)}?valueInputOption=RAW`;

        await fetch(updateUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ values: [[status]] })
        });
    },

    /**
     * 同步发布日志
     */
    async syncPublishLog(spreadsheetId, logEntry) {
        if (!spreadsheetId) return;

        const token = await this.getToken();
        const sheetName = 'PostingLogs';

        const values = [[
            logEntry.timestamp || new Date().toISOString(),
            logEntry.url || '',
            logEntry.status || '',
            logEntry.taskName || '',
            logEntry.comment || ''
        ]];

        const url = `${this.SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(`${sheetName}!A:E`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

        try {
            await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ values })
            });
        } catch {
            // 如果 sheet 不存在，创建它
            await this._createSheet(token, spreadsheetId, sheetName);
            // 先写入表头
            const headerUrl = `${this.SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(`${sheetName}!A1:E1`)}?valueInputOption=RAW`;
            await fetch(headerUrl, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ values: [['Timestamp', 'URL', 'Status', 'Task', 'Comment']] })
            });
            // 再追加数据
            await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ values })
            });
        }
    },

    async _clearSheet(token, spreadsheetId, range) {
        const url = `${this.SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!resp.ok) throw new Error('Clear failed');
    },

    async _createSheet(token, spreadsheetId, sheetName) {
        const url = `${this.SHEETS_API}/${spreadsheetId}:batchUpdate`;
        await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                requests: [{
                    addSheet: {
                        properties: { title: sheetName }
                    }
                }]
            })
        });
    }
};

if (typeof self !== 'undefined') {
    self.GoogleSheets = GoogleSheets;
}
