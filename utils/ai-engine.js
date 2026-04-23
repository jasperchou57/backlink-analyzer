/**
 * AI Engine - 多 Provider LLM 封装
 * 兼容 OpenRouter / SiliconFlow / 自定义 OpenAI 兼容接口
 */

const AIEngine = {
    USAGE_STORAGE_KEY: 'aiUsageStats',
    PRICE_TABLE: {
        'qwen-plus': { input: 0.0008, output: 0.002 },
        'qwen-turbo': { input: 0.0003, output: 0.0006 }
    },
    _usageWriteQueue: Promise.resolve(),

    PROVIDERS: {
        openrouter: {
            label: 'OpenRouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            extraHeaders: {
                'HTTP-Referer': 'chrome-extension://backlink-analyzer',
                'X-Title': 'Backlink Analyzer'
            }
        },
        siliconflow: {
            label: 'SiliconFlow',
            baseUrl: 'https://api.siliconflow.cn/v1',
            extraHeaders: {}
        },
        custom: {
            label: 'Custom OpenAI Compatible',
            baseUrl: '',
            extraHeaders: {}
        }
    },

    /**
     * 调用 LLM API
     * @param {string} task - 任务类型: classify | formExtract | commentGen | linkDiscover
     * @param {string} prompt - 用户 prompt
     * @param {object} options - 可选参数
     * @returns {string} AI 返回的文本
     */
    async call(task, prompt, options = {}) {
        const settings = await this._getSettings();
        const provider = this._resolveProvider(settings);
        const apiKey = this._getApiKey(settings);
        if (!apiKey) {
            throw new Error(`${provider.label} API Key 未配置，请在设置中填入`);
        }

        const model = this._getModelForTask(task, settings);
        if (!model) {
            throw new Error(`任务 "${task}" 的模型未配置，请在设置中填入模型 ID`);
        }

        const apiUrl = this._resolveApiUrl(provider, settings);
        if (!apiUrl) {
            throw new Error(`Provider "${provider.label}" 的 Base URL 未配置`);
        }

        const systemPrompt = options.system || '';
        const messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push({ role: 'user', content: prompt });

        const body = {
            model,
            messages,
            max_tokens: options.maxTokens || 1024,
            temperature: options.temperature !== undefined ? options.temperature : 0.7,
        };

        const timeoutMs = this._getTimeoutForTask(task, options);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        let response;
        try {
            response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    ...(provider.extraHeaders || {})
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });
        } catch (error) {
            if (error?.name === 'AbortError') {
                throw new Error(`${provider.label} API 请求超时 (${timeoutMs}ms)`);
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`${provider.label} API 错误 (${response.status}): ${errText}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';
        const usage = this._extractUsage(data);
        if (usage.totalTokens > 0) {
            this._recordUsage({
                task,
                model,
                providerId: settings.aiProvider || (settings.aiBaseUrl ? 'custom' : 'openrouter'),
                usage
            }).catch(() => {});
        }
        return content.trim();
    },

    _getTimeoutForTask(task, options = {}) {
        const explicitTimeout = Number(options.timeoutMs || 0);
        if (explicitTimeout > 0) return explicitTimeout;

        switch (task) {
            case 'formExtract':
                return 3500;
            case 'commentGen':
                return 5000;
            case 'classify':
            case 'linkDiscover':
                return 4000;
            default:
                return 5000;
        }
    },

    /**
     * 链接分类 - 判断 URL 是否为博客文章、是否有评论区
     */
    async classifyLink(url, htmlSnippet) {
        const prompt = `Analyze this webpage and determine:
1. Is this a blog post or article? (yes/no)
2. Does it have a comment section that allows posting without login? (yes/no)
3. What type of site is this? (blog/forum/directory/wiki/other)
4. Can we leave a backlink here? (yes/no)

URL: ${url}
HTML snippet (first 2000 chars):
${htmlSnippet.substring(0, 2000)}

Respond in JSON format:
{"isBlog": true/false, "hasComments": true/false, "siteType": "...", "canLeaveLink": true/false, "reason": "brief explanation"}`;

        const result = await this.call('classify', prompt, {
            system: 'You are a backlink opportunity analyzer. Respond only in valid JSON.',
            temperature: 0.3,
            maxTokens: 256
        });

        try {
            return JSON.parse(result.replace(/```json\n?|```\n?/g, ''));
        } catch {
            return { isBlog: false, hasComments: false, siteType: 'unknown', canLeaveLink: false, reason: 'Parse error' };
        }
    },

    /**
     * 表单提取 - 识别页面评论表单结构
     */
    async extractFormStructure(htmlSnippet) {
        const prompt = `Analyze this HTML and identify the comment form structure.
For each form field, provide:
- field type (comment/name/email/website/captcha/checkbox)
- CSS selector to target it
- For captcha: the question and answer

HTML:
${htmlSnippet.substring(0, 3000)}

Respond in JSON format:
{
  "hasForm": true/false,
  "formSelector": "CSS selector for the form",
  "fields": [
    {"type": "comment", "selector": "textarea#comment", "required": true},
    {"type": "name", "selector": "input#author", "required": true},
    {"type": "email", "selector": "input#email", "required": true},
    {"type": "website", "selector": "input#url", "required": false},
    {"type": "captcha", "selector": "input#captcha", "question": "1+10=?", "answer": "11"},
    {"type": "checkbox", "selector": "input#not-spam", "label": "Confirm you are NOT a spammer", "shouldCheck": true}
  ],
  "submitSelector": "CSS selector for submit button"
}`;

        const result = await this.call('formExtract', prompt, {
            system: 'You are an HTML form analyzer. Identify comment form fields precisely. Respond only in valid JSON.',
            temperature: 0.2,
            maxTokens: 512
        });

        try {
            return JSON.parse(result.replace(/```json\n?|```\n?/g, ''));
        } catch {
            return { hasForm: false, fields: [], formSelector: '', submitSelector: '' };
        }
    },

    /**
     * 评论生成 - 根据页面内容生成相关评论
     */
    async generateComment(pageTitle, pageContent, targetUrl, options = {}) {
        const anchorText = String(options.anchorText || '').trim();
        const anchorUrl = String(options.anchorUrl || '').trim();
        const allowAnchorHtml = !!options.allowAnchorHtml && !!anchorText && !!anchorUrl;

        const prompt = `Write a genuine, helpful blog comment for this article. The comment should:
- Be relevant to the article content
- Sound natural and human-written
- Be 2-4 sentences long
- ${allowAnchorHtml
                ? `Include exactly one natural HTML anchor tag using this exact target URL: ${anchorUrl} and this exact anchor text: ${anchorText}`
                : 'NOT include any links or promotional content'}
- ${allowAnchorHtml
                ? 'Only include a single <a href="...">...</a> tag once, no other links'
                : 'NOT be generic/spammy (avoid "Great post!" only)'}
- Show you actually read the article
- ${allowAnchorHtml
                ? 'Keep the anchor subtle and contextually relevant, not salesy'
                : 'Avoid sounding generic or spammy'}

Article title: ${pageTitle}
Article content (excerpt): ${(pageContent || '').substring(0, 1500)}

Write ONLY the comment text, nothing else.`;

        return await this.call('commentGen', prompt, {
            system: allowAnchorHtml
                ? 'You are a thoughtful blog reader. Write a natural comment and, only when requested, include exactly one valid HTML anchor tag with the specified href and anchor text. Do not add markdown fences or explanations.'
                : 'You are a thoughtful blog reader who writes genuine, relevant comments. Write only in English unless the article is in another language, in which case match the article language.',
            temperature: 0.8,
            maxTokens: 256
        });
    },

    /**
     * 链接发现 - 从评论内容中提取有效域名
     */
    async discoverLinks(commentsHtml) {
        const prompt = `Extract all unique website domains from these blog comments. 
These are websites left by other commenters in their profile links.
Only include domains that look like real websites (not social media, not email providers).

Comments HTML:
${commentsHtml.substring(0, 3000)}

Respond in JSON format:
{"domains": ["example.com", "another-site.io"]}`;

        const result = await this.call('linkDiscover', prompt, {
            system: 'You are a domain extractor. Extract real website domains from blog comments. Respond only in valid JSON.',
            temperature: 0.2,
            maxTokens: 512
        });

        try {
            const parsed = JSON.parse(result.replace(/```json\n?|```\n?/g, ''));
            return parsed.domains || [];
        } catch {
            return [];
        }
    },

    /**
     * 营销调研计划 - 生成渠道、平台与后续动作建议
     */
    async generateResearchPlan(options = {}) {
        const website = String(options.website || '').trim();
        const targetAudience = String(options.targetAudience || '').trim();
        const preferredChannels = String(options.preferredChannels || '').trim();
        const campaignBrief = String(options.campaignBrief || '').trim();
        const researchContext = options.researchContext || null;
        const snapshot = researchContext?.snapshot || null;
        const searchQueries = Array.isArray(researchContext?.queries) ? researchContext.queries : [];
        const pageReads = Array.isArray(researchContext?.pageReads) ? researchContext.pageReads : [];
        const evidenceLines = searchQueries.flatMap((entry) => {
            const query = String(entry?.query || '').trim();
            const results = Array.isArray(entry?.results) ? entry.results : [];
            if (!query || results.length === 0) return [];
            return [
                `Query: ${query}`,
                ...results.slice(0, 5).map((item, index) => `  ${index + 1}. ${item.title || item.url} | ${item.url} | ${item.snippet || ''}`)
            ];
        });
        const pageReadLines = pageReads.flatMap((page, index) => {
            const title = String(page?.title || page?.url || '').trim();
            const url = String(page?.url || '').trim();
            if (!title || !url) return [];
            return [
                `${index + 1}. ${title} | ${url}`,
                `   host: ${page.host || 'N/A'}`,
                `   description: ${page.description || 'N/A'}`,
                `   summary: ${page.summary || 'N/A'}`
            ];
        });
        const snapshotBlock = snapshot
            ? `\nLive product snapshot:
- title: ${snapshot.title || 'N/A'}
- description: ${snapshot.description || 'N/A'}
- headings: ${(snapshot.headings || []).join(' | ') || 'N/A'}
- summary: ${snapshot.summary || 'N/A'}`
            : '';
        const evidenceBlock = evidenceLines.length
            ? `\nBrowser search evidence:\n${evidenceLines.join('\n')}`
            : '\nBrowser search evidence:\n- No live search results available';
        const pageReadBlock = pageReadLines.length
            ? `\nVisited candidate platform pages:\n${pageReadLines.join('\n')}`
            : '\nVisited candidate platform pages:\n- No candidate platform pages were opened';

        const prompt = `Build a practical browser-marketing research plan for this product.

Product URL: ${website}
Target audience: ${targetAudience || 'Not specified'}
Preferred channels: ${preferredChannels || 'Not specified'}
Campaign brief: ${campaignBrief || 'Not specified'}
${snapshotBlock}
${evidenceBlock}
${pageReadBlock}

Return a JSON object with:
- summary: one concise paragraph
- channels: an array of 5 to 8 specific promotion targets
- nextSteps: 3 to 5 concrete next actions
- cautions: 2 to 4 risks or constraints

For each channel include:
- name
- url
- workflowId (must be one of: community-post-promote, directory-submit-promote, account-nurture)
- angle
- reason

Rules:
- Prefer real, well-known communities, directories, or platforms
- Include a mix of community posting, directory submission, and long-term account building when relevant
- Prefer channels supported by the live browser search evidence when available
- Strongly prefer channels whose pages were actually visited in the browser when they look relevant
- If a URL is uncertain, omit the channel instead of inventing it
- Keep the plan execution-oriented, not generic

Respond with valid JSON only.`;

        const result = await this.call('researchPlan', prompt, {
            system: 'You are a product marketing strategist for browser-based workflow agents. Return only valid JSON. Do not use markdown fences.',
            temperature: 0.5,
            maxTokens: 1200
        });

        try {
            const parsed = JSON.parse(result.replace(/```json\n?|```\n?/g, ''));
            return {
                summary: parsed.summary || '',
                channels: Array.isArray(parsed.channels) ? parsed.channels : [],
                nextSteps: Array.isArray(parsed.nextSteps) ? parsed.nextSteps : [],
                cautions: Array.isArray(parsed.cautions) ? parsed.cautions : []
            };
        } catch {
            return {
                summary: result.trim(),
                channels: [],
                nextSteps: [],
                cautions: []
            };
        }
    },

    /**
     * 测试 API 连接
     */
    async testConnection() {
        try {
            const settings = await this._getSettings();
            const provider = this._resolveProvider(settings);
            const result = await this.call('commentGen', 'Say "OK" if you can read this.', {
                maxTokens: 10,
                temperature: 0
            });
            return { success: true, message: `${provider.label}: ${result}` };
        } catch (e) {
            return { success: false, message: e.message };
        }
    },

    async getUsageStats() {
        if (typeof LocalDB !== 'undefined' && typeof LocalDB.getAIUsageStats === 'function') {
            try {
                if (typeof LocalDB.migrateFromChromeStorage === 'function') {
                    await LocalDB.migrateFromChromeStorage({ clearLegacy: true });
                }
                const stats = await LocalDB.getAIUsageStats();
                if (stats && typeof stats === 'object') {
                    return this._normalizeUsageStats(stats);
                }
            } catch {}
        }
        if (!chrome?.storage?.local) {
            return this._normalizeUsageStats(null);
        }
        const data = await chrome.storage.local.get(this.USAGE_STORAGE_KEY);
        return this._normalizeUsageStats(data[this.USAGE_STORAGE_KEY]);
    },

    async resetUsageStats() {
        if (typeof LocalDB !== 'undefined' && typeof LocalDB.setAIUsageStats === 'function') {
            try {
                await LocalDB.setAIUsageStats(null);
                if (chrome?.storage?.local) {
                    await chrome.storage.local.remove(this.USAGE_STORAGE_KEY);
                }
                return;
            } catch {}
        }
        if (!chrome?.storage?.local) return;
        await chrome.storage.local.remove(this.USAGE_STORAGE_KEY);
    },

    // === 内部方法 ===

    _getModelForTask(task, settings) {
        const modelMap = {
            classify: settings.modelClassify,
            formExtract: settings.modelFormExtract,
            commentGen: settings.modelCommentGen,
            linkDiscover: settings.modelLinkDiscover,
            researchPlan: settings.modelCommentGen || settings.modelClassify,
            identityPool: settings.modelCommentGen || settings.modelClassify
        };
        if (modelMap[task]) return modelMap[task];
        // 未在 modelMap 里的新任务类型：回退到任何一个已配置的模型，避免因 task
        // 名没对上而整条路径拒绝工作。优先级 commentGen > classify > formExtract > linkDiscover。
        return settings.modelCommentGen
            || settings.modelClassify
            || settings.modelFormExtract
            || settings.modelLinkDiscover
            || '';
    },

    _resolveProvider(settings) {
        const providerId = settings.aiProvider || (settings.aiBaseUrl ? 'custom' : 'openrouter');
        return this.PROVIDERS[providerId] || this.PROVIDERS.openrouter;
    },

    _getApiKey(settings) {
        return settings.aiApiKey || settings.openrouterApiKey || '';
    },

    _resolveApiUrl(provider, settings) {
        const configuredBase = (settings.aiBaseUrl || provider.baseUrl || '').trim();
        if (!configuredBase) return '';

        const normalized = configuredBase.replace(/\/+$/, '');
        if (normalized.endsWith('/chat/completions')) {
            return normalized;
        }
        return `${normalized}/chat/completions`;
    },

    async _getSettings() {
        if (typeof LocalDB !== 'undefined' && typeof LocalDB.getSettings === 'function') {
            try {
                if (typeof LocalDB.migrateFromChromeStorage === 'function') {
                    await LocalDB.migrateFromChromeStorage({ clearLegacy: true });
                }
                const settings = await LocalDB.getSettings();
                if (settings && typeof settings === 'object' && Object.keys(settings).length > 0) {
                    return settings;
                }
            } catch {}
        }
        return new Promise((resolve) => {
            chrome.storage.local.get('settings', (data) => {
                resolve(data.settings || {});
            });
        });
    },

    _extractUsage(data) {
        const usage = data?.usage || {};
        const promptTokens = Number(
            usage.prompt_tokens
            ?? usage.input_tokens
            ?? usage.promptTokens
            ?? usage.inputTokens
            ?? 0
        ) || 0;
        const completionTokens = Number(
            usage.completion_tokens
            ?? usage.output_tokens
            ?? usage.completionTokens
            ?? usage.outputTokens
            ?? 0
        ) || 0;
        const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? (promptTokens + completionTokens)) || (promptTokens + completionTokens);

        return {
            promptTokens,
            completionTokens,
            totalTokens
        };
    },

    _createEmptyUsageBucket() {
        return {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            estimatedCost: 0,
            lastUsedAt: ''
        };
    },

    _createEmptyUsageStats() {
        return {
            totals: this._createEmptyUsageBucket(),
            byTask: {},
            byModel: {},
            updatedAt: '',
            currency: 'CNY',
            pricingBasis: 'per-1k-tokens'
        };
    },

    _normalizeUsageStats(stats) {
        const normalized = {
            ...this._createEmptyUsageStats(),
            ...(stats || {})
        };

        normalized.totals = {
            ...this._createEmptyUsageBucket(),
            ...(stats?.totals || {})
        };
        normalized.byTask = { ...(stats?.byTask || {}) };
        normalized.byModel = { ...(stats?.byModel || {}) };

        for (const [key, bucket] of Object.entries(normalized.byTask)) {
            normalized.byTask[key] = {
                ...this._createEmptyUsageBucket(),
                ...(bucket || {})
            };
        }
        for (const [key, bucket] of Object.entries(normalized.byModel)) {
            normalized.byModel[key] = {
                ...this._createEmptyUsageBucket(),
                ...(bucket || {})
            };
        }

        return normalized;
    },

    _resolvePricing(model) {
        const normalized = String(model || '').trim().toLowerCase();
        if (!normalized) return null;

        if (normalized.includes('qwen-plus')) {
            return this.PRICE_TABLE['qwen-plus'];
        }
        if (normalized.includes('qwen3.5-plus')) {
            return this.PRICE_TABLE['qwen-plus'];
        }
        if (normalized.includes('qwen-turbo')) {
            return this.PRICE_TABLE['qwen-turbo'];
        }
        if (normalized.includes('qwen3.5-flash')) {
            return this.PRICE_TABLE['qwen-turbo'];
        }
        return null;
    },

    _estimateCost(model, promptTokens, completionTokens) {
        const pricing = this._resolvePricing(model);
        if (!pricing) return 0;
        return (promptTokens / 1000) * pricing.input + (completionTokens / 1000) * pricing.output;
    },

    _applyUsageBucket(bucket, usage, estimatedCost) {
        bucket.requests += 1;
        bucket.promptTokens += usage.promptTokens;
        bucket.completionTokens += usage.completionTokens;
        bucket.totalTokens += usage.totalTokens;
        bucket.estimatedCost += estimatedCost;
        bucket.lastUsedAt = new Date().toISOString();
    },

    async _recordUsage({ task, model, providerId, usage }) {
        if (!usage?.totalTokens) return;

        this._usageWriteQueue = this._usageWriteQueue.then(async () => {
            let storedStats = null;
            if (typeof LocalDB !== 'undefined' && typeof LocalDB.getAIUsageStats === 'function') {
                try {
                    storedStats = await LocalDB.getAIUsageStats();
                } catch {}
            }
            if (!storedStats && chrome?.storage?.local) {
                const data = await chrome.storage.local.get(this.USAGE_STORAGE_KEY);
                storedStats = data[this.USAGE_STORAGE_KEY];
            }

            const stats = this._normalizeUsageStats(storedStats);
            const estimatedCost = this._estimateCost(model, usage.promptTokens, usage.completionTokens);

            this._applyUsageBucket(stats.totals, usage, estimatedCost);

            const taskKey = String(task || 'unknown');
            if (!stats.byTask[taskKey]) {
                stats.byTask[taskKey] = this._createEmptyUsageBucket();
            }
            this._applyUsageBucket(stats.byTask[taskKey], usage, estimatedCost);

            const modelKey = String(model || 'unknown');
            if (!stats.byModel[modelKey]) {
                stats.byModel[modelKey] = {
                    ...this._createEmptyUsageBucket(),
                    providerId: providerId || ''
                };
            }
            stats.byModel[modelKey].providerId = providerId || stats.byModel[modelKey].providerId || '';
            this._applyUsageBucket(stats.byModel[modelKey], usage, estimatedCost);

            stats.updatedAt = new Date().toISOString();
            if (typeof LocalDB !== 'undefined' && typeof LocalDB.setAIUsageStats === 'function') {
                try {
                    await LocalDB.setAIUsageStats(stats);
                    if (chrome?.storage?.local) {
                        await chrome.storage.local.remove(this.USAGE_STORAGE_KEY);
                    }
                    return;
                } catch {}
            }
            if (chrome?.storage?.local) {
                await chrome.storage.local.set({ [this.USAGE_STORAGE_KEY]: stats });
            }
        }).catch(() => {});

        return this._usageWriteQueue;
    }
};

// Export for service worker (background.js)
if (typeof self !== 'undefined') {
    self.AIEngine = AIEngine;
}
