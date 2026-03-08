/**
 * 工具模块 - 存储、模板渲染、URL 处理
 */

const StorageHelper = {
    async get(key) {
        const result = await chrome.storage.local.get(key);
        return result[key];
    },

    async set(key, value) {
        await chrome.storage.local.set({ [key]: value });
    },

    async getResources() {
        return (await this.get('resources')) || [];
    },

    async addResource(resource) {
        const resources = await this.getResources();
        const existing = resources.find(r => normalizeUrl(r.url) === normalizeUrl(resource.url));
        if (existing) {
            // 合并来源标记
            if (resource.sources) {
                resource.sources.forEach(s => {
                    if (!existing.sources.includes(s)) existing.sources.push(s);
                });
            }
            await this.set('resources', resources);
            return false; // 非新增
        }
        resources.push({
            ...resource,
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
            discoveredAt: new Date().toISOString(),
            status: 'pending',
            sources: resource.sources || []
        });
        await this.set('resources', resources);
        return true;
    },

    async updateResource(id, updates) {
        const resources = await this.getResources();
        const idx = resources.findIndex(r => r.id === id);
        if (idx !== -1) {
            resources[idx] = { ...resources[idx], ...updates };
            await this.set('resources', resources);
        }
    },

    async deleteResource(id) {
        const resources = await this.getResources();
        await this.set('resources', resources.filter(r => r.id !== id));
    },

    async getStats() {
        return (await this.get('collectStats')) || {
            backlinksFound: 0, targetsFound: 0, analyzed: 0, blogResources: 0, inQueue: 0
        };
    },

    async updateStats(stats) {
        await this.set('collectStats', stats);
    },

    async getSettings() {
        return (await this.get('settings')) || {
            aiProvider: 'openrouter',
            aiBaseUrl: 'https://openrouter.ai/api/v1',
            aiApiKey: '',
            name: '',
            email: '',
            website: '',
            apiKey: '',
            openrouterApiKey: '',
            publishDebugMode: false,
            commentTemplates: [
                'Great article about {title}! This provides really valuable insights worth sharing.',
                'This is a very interesting perspective on {title}. Thanks for the detailed analysis!',
                'Thanks for sharing this comprehensive post about {title}. Very helpful for the community!'
            ],
            anchorKeyword: '',
            anchorUrl: '',
            publishMode: 'semi-auto',
            language: 'zh'
        };
    },

    async saveSettings(settings) {
        await this.set('settings', settings);
    },

    async getCollectState() {
        return (await this.get('collectState')) || {
            isCollecting: false, domain: '', myDomain: '',
            backlinks: [], currentIndex: 0, currentSource: ''
        };
    },

    async setCollectState(state) {
        await this.set('collectState', state);
    },

    async getPublishState() {
        return (await this.get('publishState')) || {
            isPublishing: false, currentIndex: 0, queue: []
        };
    },

    async setPublishState(state) {
        await this.set('publishState', state);
    },

    async clearAll() {
        await chrome.storage.local.clear();
    }
};

// === URL 工具 ===

function normalizeUrl(url) {
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

function normalizeDomain(domain) {
    if (!domain) return '';
    return domain.trim().toLowerCase()
        .replace(/^(https?:\/\/)?(www\.)?/, '')
        .replace(/\/.*$/, '');
}

function isValidUrl(str) {
    try {
        new URL(str.startsWith('http') ? str : 'https://' + str);
        return true;
    } catch { return false; }
}

function getDomainFromUrl(url) {
    try {
        if (!url.startsWith('http')) url = 'https://' + url;
        return new URL(url).hostname.replace(/^www\./, '');
    } catch { return ''; }
}

// === 模板工具 ===

function renderTemplate(template, vars) {
    let result = template;
    for (const [k, v] of Object.entries(vars)) {
        result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), v || '');
    }
    return result;
}

function pickRandomTemplate(templates) {
    if (!templates?.length) return '';
    return templates[Math.floor(Math.random() * templates.length)];
}

// === 时间格式化 ===

function formatTime(iso) {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// === 导出 CSV ===

function exportToCSV(resources) {
    const headers = ['URL', 'Sources', 'Type', 'Status', 'Link Method', 'Discovered'];
    const rows = resources.map(r => [
        r.url, (r.sources || []).join('+'), r.type || '-',
        r.status || 'pending', r.linkMethod || '-', r.discoveredAt || ''
    ]);
    const csv = [headers, ...rows]
        .map(row => row.map(c => `"${(c || '').replace(/"/g, '""')}"`).join(','))
        .join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `backlink-resources-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
}

if (typeof window !== 'undefined') {
    window.StorageHelper = StorageHelper;
    window.normalizeUrl = normalizeUrl;
    window.normalizeDomain = normalizeDomain;
    window.isValidUrl = isValidUrl;
    window.getDomainFromUrl = getDomainFromUrl;
    window.renderTemplate = renderTemplate;
    window.pickRandomTemplate = pickRandomTemplate;
    window.formatTime = formatTime;
    window.exportToCSV = exportToCSV;
}
