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

    // ============================================================
    // Agent 模式 — 带工具调用的 AI 步骤
    // ============================================================

    /**
     * Agent 步骤调用 — 发送页面状态给 AI，返回工具调用指令
     * @param {object} params
     * @param {string} params.elements - 页面元素列表（[index]<type>text 格式）
     * @param {string} params.url - 当前页面 URL
     * @param {string} params.title - 当前页面标题
     * @param {string} params.task - 用户任务描述
     * @param {Array} params.history - 之前步骤的历史记录
     * @param {number} params.step - 当前步骤号
     * @param {number} params.maxSteps - 最大步骤数
     * @returns {object} { action, params, evaluation, memory, nextGoal, done, success }
     */
    async agentStep(params) {
        const settings = await this._getSettings();
        const apiKey = settings.openrouterApiKey;
        if (!apiKey) throw new Error('OpenRouter API Key 未配置');

        const model = settings.modelCommentGen || settings.modelFormExtract;
        if (!model) throw new Error('AI 模型未配置');

        const systemPrompt = this._buildAgentSystemPrompt();
        const userPrompt = this._buildAgentUserPrompt(params);

        const body = {
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            tools: this._getAgentTools(),
            tool_choice: { type: 'function', function: { name: 'agent_action' } },
            max_tokens: 1024,
            temperature: 0.3,
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
            throw new Error(`API 错误 (${response.status}): ${errText}`);
        }

        const data = await response.json();
        return this._parseAgentResponse(data);
    },

    _buildAgentSystemPrompt() {
        return `You are a browser automation agent that fills comment forms on blog pages.

You operate in a loop: observe the page → decide an action → execute → observe again.

<input_format>
You receive a list of interactive page elements in this format:
[index]<tagName attributes>visible text />
Use the index number to interact with elements.
</input_format>

<rules>
1. Only interact with elements by their [index] number
2. Fill the comment form fields: comment text, author name, email, website URL
3. Generate a genuine, relevant comment based on the page title (2-4 sentences, not spammy)
4. Uncheck notification/subscription checkboxes if checked
5. Check anti-spam checkboxes (e.g. "I am not a spammer")
6. Solve simple math captchas (e.g. "3 + 7 = ?") by calculating the answer
7. If you encounter a CAPTCHA you cannot solve, use ask_user
8. After filling all fields, use done with success=true
9. If there is no comment form on the page, use done with success=false
10. Do NOT click submit buttons — just fill the form
11. If the page needs scrolling to find the comment form, scroll down first
12. Maximum 3 attempts per action — if something fails 3 times, skip it
</rules>

<output_format>
Always respond with a single tool call to agent_action containing:
- evaluation: brief assessment of what happened in the last step
- next_goal: what you plan to do next
- action_name: one of click_element_by_index, input_text, select_dropdown_option, scroll, wait, ask_user, done
- action_params: parameters for the action
</output_format>`;
    },

    _buildAgentUserPrompt(params) {
        const { elements, url, title, task, history, step, maxSteps } = params;

        let prompt = `<task>${task}</task>\n`;
        prompt += `<step>Step ${step} of ${maxSteps}</step>\n`;
        prompt += `<page url="${url}" title="${title}">\n`;
        prompt += elements;
        prompt += `\n</page>\n`;

        if (history && history.length > 0) {
            prompt += `<history>\n`;
            for (const h of history.slice(-5)) { // 只保留最近 5 步
                prompt += `Step ${h.step}: ${h.action}(${JSON.stringify(h.params)}) → ${h.result}\n`;
            }
            prompt += `</history>\n`;
        }

        return prompt;
    },

    _getAgentTools() {
        return [{
            type: 'function',
            function: {
                name: 'agent_action',
                description: 'Execute the next browser action',
                parameters: {
                    type: 'object',
                    required: ['action_name', 'action_params'],
                    properties: {
                        evaluation: {
                            type: 'string',
                            description: 'Brief assessment of the previous step result'
                        },
                        next_goal: {
                            type: 'string',
                            description: 'What you plan to do in this step'
                        },
                        action_name: {
                            type: 'string',
                            enum: ['click_element_by_index', 'input_text', 'select_dropdown_option',
                                   'scroll', 'wait', 'ask_user', 'done'],
                            description: 'The action to perform'
                        },
                        action_params: {
                            type: 'object',
                            description: 'Parameters for the action. For click: {index}. For input_text: {index, text}. For select: {index, text}. For scroll: {down, num_pages}. For wait: {seconds}. For ask_user: {question}. For done: {text, success}.',
                            properties: {
                                index: { type: 'integer' },
                                text: { type: 'string' },
                                down: { type: 'boolean' },
                                num_pages: { type: 'number' },
                                seconds: { type: 'number' },
                                question: { type: 'string' },
                                success: { type: 'boolean' }
                            }
                        }
                    }
                }
            }
        }];
    },

    _parseAgentResponse(data) {
        const message = data.choices?.[0]?.message;
        if (!message) throw new Error('AI 无响应');

        // 优先解析 tool_calls
        if (message.tool_calls && message.tool_calls.length > 0) {
            const call = message.tool_calls[0];
            let args;
            try {
                args = JSON.parse(call.function.arguments);
            } catch {
                throw new Error('AI 返回的参数格式错误');
            }
            return {
                action: args.action_name,
                params: args.action_params || {},
                evaluation: args.evaluation || '',
                nextGoal: args.next_goal || '',
                done: args.action_name === 'done',
                success: args.action_name === 'done' ? (args.action_params?.success ?? false) : null,
                doneText: args.action_name === 'done' ? (args.action_params?.text || '') : ''
            };
        }

        // 回退：尝试从 content 中解析 JSON
        const content = message.content || '';
        try {
            const json = JSON.parse(content.replace(/```json\n?|```\n?/g, ''));
            return {
                action: json.action_name || 'done',
                params: json.action_params || {},
                evaluation: json.evaluation || '',
                nextGoal: json.next_goal || '',
                done: json.action_name === 'done',
                success: json.action_params?.success ?? false,
                doneText: json.action_params?.text || ''
            };
        } catch {
            return { action: 'done', params: { success: false, text: 'AI 返回格式无法解析' }, done: true, success: false, doneText: content };
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
