/**
 * AI Engine - OpenRouter API 封装
 * 4 个 AI 任务各自可配置不同模型
 */

const AIEngine = {
    // OpenRouter API 端点
    API_URL: 'https://openrouter.ai/api/v1/chat/completions',

    /**
     * 调用 OpenRouter API
     * @param {string} task - 任务类型: classify | formExtract | commentGen | linkDiscover
     * @param {string} prompt - 用户 prompt
     * @param {object} options - 可选参数
     * @returns {string} AI 返回的文本
     */
    async call(task, prompt, options = {}) {
        const settings = await this._getSettings();
        const apiKey = settings.openrouterApiKey;
        if (!apiKey) {
            throw new Error('OpenRouter API Key 未配置，请在设置中填入');
        }

        const model = this._getModelForTask(task, settings);
        if (!model) {
            throw new Error(`任务 "${task}" 的模型未配置，请在设置中填入模型 ID`);
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

        const response = await fetch(this.API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'chrome-extension://backlink-analyzer',
                'X-Title': 'Backlink Analyzer'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`OpenRouter API 错误 (${response.status}): ${errText}`);
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
    async generateComment(pageTitle, pageContent, targetUrl) {
        const prompt = `Write a genuine, helpful blog comment for this article. The comment should:
- Be relevant to the article content
- Sound natural and human-written
- Be 2-4 sentences long
- NOT include any links or promotional content
- NOT be generic/spammy (avoid "Great post!" only)
- Show you actually read the article

Article title: ${pageTitle}
Article content (excerpt): ${(pageContent || '').substring(0, 1500)}

Write ONLY the comment text, nothing else.`;

        return await this.call('commentGen', prompt, {
            system: 'You are a thoughtful blog reader who writes genuine, relevant comments. Write only in English unless the article is in another language, in which case match the article language.',
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
            const result = await this.call('commentGen', 'Say "OK" if you can read this.', {
                maxTokens: 10,
                temperature: 0
            });
            return { success: true, message: result };
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
