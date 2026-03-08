/**
 * AI Engine - 多 Provider LLM 封装
 * 兼容 OpenRouter / SiliconFlow / 自定义 OpenAI 兼容接口
 */

const AIEngine = {
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

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                ...(provider.extraHeaders || {})
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`${provider.label} API 错误 (${response.status}): ${errText}`);
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';
        return content.trim();
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

    // === 内部方法 ===

    _getModelForTask(task, settings) {
        const modelMap = {
            classify: settings.modelClassify,
            formExtract: settings.modelFormExtract,
            commentGen: settings.modelCommentGen,
            linkDiscover: settings.modelLinkDiscover,
        };
        return modelMap[task] || '';
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
        return new Promise((resolve) => {
            chrome.storage.local.get('settings', (data) => {
                resolve(data.settings || {});
            });
        });
    }
};

// Export for service worker (background.js)
if (typeof self !== 'undefined') {
    self.AIEngine = AIEngine;
}
