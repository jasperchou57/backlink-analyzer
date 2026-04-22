/**
 * Settings Panel - AI config, user info, Google Sheets, templates, debug mode
 */
(function (global) {

    const QWEN_MODEL_OPTIONS = [
        'qwen3.5-flash',
        'qwen3.5-plus',
        'qwen3.5-flash-2026-02-23',
        'qwen3.5-plus-2026-02-15',
        'qwen3.5-35b-a3b',
        'qwen3.5-27b',
        'qwen3.5-122b-a10b',
        'qwen3.5-397b-a17b',
        'qwen-plus',
        'qwen-turbo'
    ];

    function createEmptyAiUsageBucket() {
        return {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            estimatedCost: 0,
            lastUsedAt: ''
        };
    }

    function normalizeAiUsageStats(stats) {
        const normalized = {
            totals: createEmptyAiUsageBucket(),
            byTask: {},
            byModel: {},
            updatedAt: '',
            ...(stats || {})
        };

        normalized.totals = {
            ...createEmptyAiUsageBucket(),
            ...(stats?.totals || {})
        };
        normalized.byTask = { ...(stats?.byTask || {}) };
        normalized.byModel = { ...(stats?.byModel || {}) };

        Object.keys(normalized.byTask).forEach((key) => {
            normalized.byTask[key] = {
                ...createEmptyAiUsageBucket(),
                ...(normalized.byTask[key] || {})
            };
        });
        Object.keys(normalized.byModel).forEach((key) => {
            normalized.byModel[key] = {
                ...createEmptyAiUsageBucket(),
                ...(normalized.byModel[key] || {})
            };
        });

        return normalized;
    }

    function formatUsageNumber(value, fractionDigits = 0) {
        return Number(value || 0).toLocaleString('zh-CN', {
            minimumFractionDigits: 0,
            maximumFractionDigits: fractionDigits
        });
    }

    function formatUsageCurrency(value) {
        const amount = Number(value || 0);
        return amount >= 1
            ? `${formatUsageNumber(amount, 2)} 元`
            : `${formatUsageNumber(amount, 4)} 元`;
    }

    function buildAiUsageStatsMarkup(rawStats) {
        const stats = normalizeAiUsageStats(rawStats);
        const totals = stats.totals || createEmptyAiUsageBucket();
        const avgCostPerRequest = totals.requests > 0 ? (totals.estimatedCost / totals.requests) : 0;
        const modelLabelMap = {
            classify: '链接分类',
            formExtract: '表单识别',
            commentGen: '评论生成',
            linkDiscover: '链接发现',
            researchPlan: '调研计划'
        };

        const modelRows = Object.entries(stats.byModel || {})
            .sort((a, b) => (b[1]?.totalTokens || 0) - (a[1]?.totalTokens || 0))
            .slice(0, 6)
            .map(([model, bucket]) => `
                <div class="ai-usage-row">
                  <div class="ai-usage-row-main">
                    <div class="ai-usage-row-title">${escapeHtml(model)}</div>
                    <div class="ai-usage-row-meta">${formatUsageNumber(bucket.requests)} 次 · ${formatUsageNumber(bucket.totalTokens)} tokens</div>
                  </div>
                  <div class="ai-usage-row-value">${formatUsageCurrency(bucket.estimatedCost)}</div>
                </div>
            `).join('');

        const taskRows = Object.entries(stats.byTask || {})
            .sort((a, b) => (b[1]?.estimatedCost || 0) - (a[1]?.estimatedCost || 0))
            .slice(0, 6)
            .map(([task, bucket]) => `
                <div class="ai-usage-row">
                  <div class="ai-usage-row-main">
                    <div class="ai-usage-row-title">${escapeHtml(modelLabelMap[task] || task)}</div>
                    <div class="ai-usage-row-meta">${formatUsageNumber(bucket.requests)} 次 · 输入 ${formatUsageNumber(bucket.promptTokens)} / 输出 ${formatUsageNumber(bucket.completionTokens)}</div>
                  </div>
                  <div class="ai-usage-row-value">${formatUsageCurrency(bucket.estimatedCost)}</div>
                </div>
            `).join('');

        return `
          <div class="settings-section-head">
            <h4>📈 模型用量</h4>
            <button class="btn-inline danger" id="btn-reset-ai-usage">重置统计</button>
          </div>
          <div class="ai-usage-grid">
            <div class="ai-usage-card">
              <div class="ai-usage-label">总请求数</div>
              <div class="ai-usage-value">${formatUsageNumber(totals.requests)}</div>
            </div>
            <div class="ai-usage-card">
              <div class="ai-usage-label">总 Token</div>
              <div class="ai-usage-value">${formatUsageNumber(totals.totalTokens)}</div>
            </div>
            <div class="ai-usage-card">
              <div class="ai-usage-label">输入 / 输出</div>
              <div class="ai-usage-value small">${formatUsageNumber(totals.promptTokens)} / ${formatUsageNumber(totals.completionTokens)}</div>
            </div>
            <div class="ai-usage-card">
              <div class="ai-usage-label">估算花费</div>
              <div class="ai-usage-value">${formatUsageCurrency(totals.estimatedCost)}</div>
            </div>
          </div>
          <div class="ai-usage-summary">
            <span>平均每次请求：${formatUsageCurrency(avgCostPerRequest)}</span>
            <span>最近更新：${stats.updatedAt ? escapeHtml(formatTime(stats.updatedAt)) : '暂无'}</span>
          </div>
          <div class="ai-usage-panels">
            <div class="ai-usage-panel">
              <div class="ai-usage-panel-title">按模型</div>
              <div class="ai-usage-list">
                ${modelRows || '<div class="ai-usage-empty">暂无模型调用记录</div>'}
              </div>
            </div>
            <div class="ai-usage-panel">
              <div class="ai-usage-panel-title">按任务</div>
              <div class="ai-usage-list">
                ${taskRows || '<div class="ai-usage-empty">暂无任务调用记录</div>'}
              </div>
            </div>
          </div>
          <div class="settings-help">当前已对 qwen-plus / qwen-turbo 做估算，也会把 qwen3.5-plus / qwen3.5-flash 按对应档位近似估算；其他模型只统计 token。</div>
        `;
    }

    function buildQwenModelSelectOptions(currentValue = '') {
        const options = [''].concat(QWEN_MODEL_OPTIONS);
        if (currentValue && !options.includes(currentValue)) {
            options.push(currentValue);
        }
        return options.map((model) => {
            const label = model || '未选择';
            const selected = model === currentValue ? 'selected' : '';
            return `<option value="${escapeHtml(model)}" ${selected}>${escapeHtml(label)}</option>`;
        }).join('');
    }

    async function saveCurrentSettings(overlay) {
        const templates = Array.from(overlay.querySelectorAll('.tpl-text'))
            .map(el => el.value.trim())
            .filter(Boolean);

        const newSettings = {
            // AI 配置
            aiProvider: overlay.querySelector('#set-ai-provider').value,
            aiBaseUrl: overlay.querySelector('#set-ai-base-url').value.trim(),
            aiApiKey: overlay.querySelector('#set-api-key').value.trim(),
            openrouterApiKey: overlay.querySelector('#set-api-key').value.trim(),
            modelClassify: overlay.querySelector('#set-model-classify').value.trim(),
            modelFormExtract: overlay.querySelector('#set-model-form').value.trim(),
            modelCommentGen: overlay.querySelector('#set-model-comment').value.trim(),
            modelLinkDiscover: overlay.querySelector('#set-model-link').value.trim(),
            // Google Sheets
            googleSheetId: overlay.querySelector('#set-sheet-id').value.trim(),
            // 用户信息
            name: overlay.querySelector('#set-name').value.trim(),
            email: overlay.querySelector('#set-email').value.trim(),
            website: overlay.querySelector('#set-website').value.trim(),
            anchorKeyword: overlay.querySelector('#set-anchor-kw').value.trim(),
            anchorUrl: overlay.querySelector('#set-anchor-url').value.trim(),
            publishDebugMode: overlay.querySelector('#set-publish-debug').checked,
            commentTemplates: templates,
            language: i18n.currentLang
        };

        await StorageHelper.saveSettings(newSettings);
    }

    async function openSettings() {
        const settings = await StorageHelper.getSettings();
        const usageResponse = await chrome.runtime.sendMessage({ action: 'getAIUsageStats' }).catch(() => ({ stats: null }));
        const usageStats = usageResponse?.stats || null;
        const providerOptions = [
            { value: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
            { value: 'siliconflow', label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1' },
            { value: 'custom', label: '自定义 OpenAI 兼容接口', baseUrl: '' }
        ];
        const selectedProvider = settings.aiProvider || (settings.aiBaseUrl ? 'custom' : 'openrouter');
        const currentApiKey = settings.aiApiKey || settings.openrouterApiKey || '';
        const currentBaseUrl = settings.aiBaseUrl
            || providerOptions.find((item) => item.value === selectedProvider)?.baseUrl
            || providerOptions[0].baseUrl;

        const overlay = document.createElement('div');
        overlay.className = 'settings-overlay';

        const templatesHtml = (settings.commentTemplates || []).map((tpl, i) => `
        <div class="template-item" data-idx="${i}">
          <textarea class="tpl-text">${escapeHtml(tpl)}</textarea>
          <button class="template-remove" data-idx="${i}">×</button>
        </div>
      `).join('');

        overlay.innerHTML = `
        <h2>
          <button class="settings-back" id="settings-back">${i18n.t('settings.back')}</button>
          ${i18n.t('settings.title')}
        </h2>

        <div class="settings-section">
          <h4>🤖 AI 配置</h4>
          <div class="settings-field">
            <label>Provider</label>
            <select class="input" id="set-ai-provider">
              ${providerOptions.map((item) => `
                <option value="${item.value}" ${item.value === selectedProvider ? 'selected' : ''}>${item.label}</option>
              `).join('')}
            </select>
          </div>
          <div class="settings-field">
            <label>Base URL</label>
            <input class="input" id="set-ai-base-url" value="${escapeHtml(currentBaseUrl)}" placeholder="https://api.example.com/v1">
            <div class="settings-help" id="set-ai-provider-help"></div>
          </div>
          <div class="settings-field">
            <label>API Key</label>
            <input class="input" id="set-api-key" type="password" value="${escapeHtml(currentApiKey)}" placeholder="sk-...">
          </div>
          <div class="settings-help">下面四个模型都改成下拉栏，你自己从这批 Qwen 模型里选。</div>
          <div class="settings-field">
            <label>链接分类模型 (classify)</label>
            <select class="input" id="set-model-classify">
              ${buildQwenModelSelectOptions(settings.modelClassify || '')}
            </select>
          </div>
          <div class="settings-field">
            <label>表单识别模型 (formExtract)</label>
            <select class="input" id="set-model-form">
              ${buildQwenModelSelectOptions(settings.modelFormExtract || '')}
            </select>
          </div>
          <div class="settings-field">
            <label>评论生成模型 (commentGen)</label>
            <select class="input" id="set-model-comment">
              ${buildQwenModelSelectOptions(settings.modelCommentGen || '')}
            </select>
          </div>
          <div class="settings-field">
            <label>链接发现模型 (linkDiscover)</label>
            <select class="input" id="set-model-link">
              ${buildQwenModelSelectOptions(settings.modelLinkDiscover || '')}
            </select>
          </div>
          <button class="btn-test" id="btn-test-ai">🔌 测试 AI 连接</button>
          <div class="test-result" id="ai-test-result"></div>
        </div>

        <div class="settings-section" id="ai-usage-section">
          ${buildAiUsageStatsMarkup(usageStats)}
        </div>

        <div class="settings-section">
          <h4>📊 Google Sheets</h4>
          <div class="settings-field">
            <label>Google Sheet ID</label>
            <input class="input" id="set-sheet-id" value="${escapeHtml(settings.googleSheetId || '')}" placeholder="从 Sheet URL 中提取的 ID">
          </div>
          <button class="btn-test" id="btn-sync-sheets">☁ 同步到 Sheets</button>
          <div class="test-result" id="sheets-result"></div>
        </div>

        <div class="settings-section">
          <h4>${i18n.t('settings.userInfo')}</h4>
          <div class="settings-field">
            <label>${i18n.t('settings.name')}</label>
            <input class="input" id="set-name" value="${escapeHtml(settings.name || '')}">
          </div>
          <div class="settings-field">
            <label>${i18n.t('settings.email')}</label>
            <input class="input" id="set-email" type="email" value="${escapeHtml(settings.email || '')}">
          </div>
          <div class="settings-field">
            <label>${i18n.t('settings.website')}</label>
            <input class="input" id="set-website" value="${escapeHtml(settings.website || '')}">
          </div>
        </div>

        <div class="settings-section">
          <h4>${i18n.t('settings.anchor')}</h4>
          <div class="settings-field">
            <label>${i18n.t('settings.anchorKeyword')}</label>
            <input class="input" id="set-anchor-kw" value="${escapeHtml(settings.anchorKeyword || '')}">
          </div>
          <div class="settings-field">
            <label>${i18n.t('settings.anchorUrl')}</label>
            <input class="input" id="set-anchor-url" value="${escapeHtml(settings.anchorUrl || '')}">
          </div>
        </div>

        <div class="settings-section">
          <h4>${i18n.t('settings.templates')}</h4>
          <div style="font-size:11px;color:#8891a8;margin-bottom:8px">可用变量: {title} {greeting} {complement} {question} {domain} {keyword}</div>
          <div id="templates-list">${templatesHtml}</div>
          <button class="btn-add-template" id="btn-add-tpl">+ ${i18n.t('settings.addTemplate')}</button>
        </div>

        <div class="settings-section">
          <h4>🧹 队列清理（中档策略）</h4>
          <div style="font-size:11px;color:#8891a8;margin-bottom:8px">
            扫描现有资源，把"发了 Google 也看不到"和"彻底发不了"的标记为不可发布：edu/gov/社交媒体、评论关闭、登录/验证码、连续失败、<b>仅有审核中的记录</b>（Google 爬不到）、<b>已触达 duplicate_comment 终态</b>（已发过）、<b>评论总数 1-2 条且无已验证成功</b>（站不活跃）。≥3 条带链接评论的高质量资源加排序权重。不删除数据，随时可手动改回。
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn-test" id="btn-cleanup-preview">🔍 预览清理</button>
            <button class="btn-test" id="btn-cleanup-apply" style="background:#2b4a2b;color:#d0ffd0;display:none">✅ 确认应用清理</button>
          </div>
          <div class="test-result" id="cleanup-result"></div>
          <div id="cleanup-preview-detail" style="display:none;margin-top:10px;max-height:320px;overflow:auto;border:1px solid #2a2f3a;border-radius:6px;padding:10px;font-size:11px;background:#1a1d26"></div>
        </div>

        <div class="settings-section">
          <h4>🧪 发布调试</h4>
          <label class="settings-toggle">
            <input type="checkbox" id="set-publish-debug" ${settings.publishDebugMode ? 'checked' : ''}>
            <span class="settings-toggle-copy">
              <span class="settings-toggle-title">启用发布调试模式</span>
              <span class="settings-toggle-desc">开启后，即使任务是全自动，也会在提交前暂停。插件会高亮验证码/反垃圾复选框，并展示识别结果，方便你检查它是否正确过验证。</span>
            </span>
          </label>
          <div style="font-size:11px;color:#8891a8;margin:10px 0 6px">
            黑匣子事件日志：背景/内容脚本两层所有关键事件都按 attemptId 关联记录。卡死或误判时点"导出"把最近 2000 条事件存成 JSON，发给研发定位问题。
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn-test" id="btn-export-publish-events">📦 导出发布事件日志</button>
            <button class="btn-test" id="btn-clear-publish-events" style="background:#3a2a2a;color:#ffcac0">🗑️ 清空</button>
          </div>
          <div class="test-result" id="publish-events-result"></div>
        </div>

        <button class="btn-save" id="btn-save-settings">${i18n.t('settings.save')}</button>
        <div class="save-toast" id="save-toast">${i18n.t('settings.saved')}</div>
      `;

        document.body.appendChild(overlay);

        const providerMap = Object.fromEntries(providerOptions.map((item) => [item.value, item]));
        const providerSelect = overlay.querySelector('#set-ai-provider');
        const baseUrlInput = overlay.querySelector('#set-ai-base-url');
        const providerHelp = overlay.querySelector('#set-ai-provider-help');
        baseUrlInput.dataset.customValue = selectedProvider === 'custom' ? currentBaseUrl : '';

        const syncProviderUi = () => {
            const provider = providerMap[providerSelect.value] || providerOptions[0];
            if (provider.value === 'custom') {
                baseUrlInput.value = baseUrlInput.dataset.customValue || currentBaseUrl || '';
            } else if ((baseUrlInput.value || '').trim() === '' || baseUrlInput.dataset.autoManaged === 'true') {
                baseUrlInput.value = provider.baseUrl || '';
            }
            baseUrlInput.dataset.autoManaged = provider.value === 'custom' ? 'false' : 'true';
            baseUrlInput.readOnly = provider.value !== 'custom';
            providerHelp.textContent = provider.value === 'openrouter'
                ? 'OpenRouter 适合统一接多模型，Base URL 已自动填入。'
                : provider.value === 'siliconflow'
                    ? 'SiliconFlow 是兼容 OpenAI 的国内平台，Base URL 已自动填入。'
                    : '自定义模式下请填写你的 OpenAI 兼容接口基础地址，例如 https://api.example.com/v1';
        };

        // Back button
        overlay.querySelector('#settings-back').addEventListener('click', () => overlay.remove());

        providerSelect.addEventListener('change', () => {
            syncProviderUi();
        });
        baseUrlInput.addEventListener('input', () => {
            if (providerSelect.value === 'custom') {
                baseUrlInput.dataset.customValue = baseUrlInput.value.trim();
            }
        });
        syncProviderUi();

        const renderAiUsageSection = (stats) => {
            const section = overlay.querySelector('#ai-usage-section');
            if (!section) return;
            section.innerHTML = buildAiUsageStatsMarkup(stats);
            const resetBtn = section.querySelector('#btn-reset-ai-usage');
            if (resetBtn) {
                resetBtn.addEventListener('click', async () => {
                    resetBtn.disabled = true;
                    resetBtn.textContent = '重置中...';
                    await chrome.runtime.sendMessage({ action: 'resetAIUsageStats' });
                    renderAiUsageSection(null);
                });
            }
        };
        renderAiUsageSection(usageStats);

        // Remove template
        overlay.querySelectorAll('.template-remove').forEach(btn => {
            btn.addEventListener('click', () => btn.closest('.template-item').remove());
        });

        // Add template
        overlay.querySelector('#btn-add-tpl').addEventListener('click', () => {
            const list = overlay.querySelector('#templates-list');
            const item = document.createElement('div');
            item.className = 'template-item';
            item.innerHTML = `
          <textarea class="tpl-text" placeholder="${i18n.t('settings.templatePlaceholder')}"></textarea>
          <button class="template-remove">×</button>
        `;
            item.querySelector('.template-remove').addEventListener('click', () => item.remove());
            list.appendChild(item);
        });

        // Test AI Connection
        overlay.querySelector('#btn-test-ai').addEventListener('click', async () => {
            const resultEl = overlay.querySelector('#ai-test-result');
            resultEl.textContent = '测试中...';
            resultEl.className = 'test-result';

            // 先临时保存 key 和模型
            await saveCurrentSettings(overlay);

            const result = await chrome.runtime.sendMessage({ action: 'testAiConnection' });
            if (result.success) {
                resultEl.textContent = '✓ 连接成功: ' + result.message;
                resultEl.className = 'test-result success';
            } else {
                resultEl.textContent = '✗ 连接失败: ' + result.message;
                resultEl.className = 'test-result error';
            }
        });

        // Sync to Sheets
        overlay.querySelector('#btn-sync-sheets').addEventListener('click', async () => {
            const resultEl = overlay.querySelector('#sheets-result');
            resultEl.textContent = '同步中...';
            resultEl.className = 'test-result';

            await saveCurrentSettings(overlay);

            const result = await chrome.runtime.sendMessage({ action: 'syncToSheets' });
            if (result.success) {
                resultEl.textContent = '✓ ' + result.message;
                resultEl.className = 'test-result success';
            } else {
                resultEl.textContent = '✗ ' + result.message;
                resultEl.className = 'test-result error';
            }
        });

        const escapeHtmlText = (s) => String(s || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

        const renderCleanupResult = (result, { applied = false } = {}) => {
            const resultEl = overlay.querySelector('#cleanup-result');
            const detailEl = overlay.querySelector('#cleanup-preview-detail');
            const applyBtn = overlay.querySelector('#btn-cleanup-apply');

            if (!result?.success) {
                resultEl.textContent = '✗ ' + (result?.message || '清理失败');
                resultEl.className = 'test-result error';
                detailEl.style.display = 'none';
                applyBtn.style.display = 'none';
                return;
            }

            const c = result.counts || {};
            const label = applied ? '✅ 已应用' : '🔍 预览';
            resultEl.innerHTML = `${label}：总计 ${c.total} · 新下架 ${c.markedUnpublishable} · 已下架 ${c.alreadyUnpublishable} · 加权 ${c.boosted} · 保留 ${c.kept}`;
            resultEl.className = 'test-result success';

            const reasonStats = result.reasonStats || {};
            const reasonSamples = result.reasonSamples || {};
            const reasonEntries = Object.entries(reasonStats).sort((a, b) => b[1] - a[1]);

            if (reasonEntries.length === 0) {
                detailEl.style.display = 'none';
                applyBtn.style.display = 'none';
                return;
            }

            const blocks = reasonEntries.map(([reason, n]) => {
                const urls = (reasonSamples[reason] || []).slice(0, 5);
                const urlList = urls.length
                    ? urls.map((u) => `<li style="color:#8891a8;margin:2px 0;word-break:break-all">${escapeHtmlText(u)}</li>`).join('')
                    : '<li style="color:#555">（无样本）</li>';
                return `<div style="margin-bottom:10px">
                    <div style="color:#eee;font-weight:600">${escapeHtmlText(reason)} · ${n} 条</div>
                    <ul style="margin:4px 0 0 18px;padding:0">${urlList}</ul>
                </div>`;
            }).join('');
            detailEl.innerHTML = blocks;
            detailEl.style.display = 'block';

            // 只有 dryRun 且有东西可删时才暴露"应用"按钮
            applyBtn.style.display = (!applied && c.markedUnpublishable > 0) ? 'inline-block' : 'none';
        };

        overlay.querySelector('#btn-cleanup-preview').addEventListener('click', async () => {
            const resultEl = overlay.querySelector('#cleanup-result');
            resultEl.textContent = '扫描中...';
            resultEl.className = 'test-result';
            try {
                const result = await chrome.runtime.sendMessage({
                    action: 'cleanupResourceQueue',
                    dryRun: true
                });
                renderCleanupResult(result, { applied: false });
            } catch (e) {
                resultEl.textContent = '✗ ' + (e?.message || '扫描失败');
                resultEl.className = 'test-result error';
            }
        });

        overlay.querySelector('#btn-cleanup-apply').addEventListener('click', async () => {
            const applyBtn = overlay.querySelector('#btn-cleanup-apply');
            const resultEl = overlay.querySelector('#cleanup-result');
            if (!confirm('即将把预览中列出的资源全部标记为"不可发布"。确认继续？')) return;
            applyBtn.disabled = true;
            resultEl.textContent = '应用中...';
            resultEl.className = 'test-result';
            try {
                const result = await chrome.runtime.sendMessage({
                    action: 'cleanupResourceQueue',
                    dryRun: false
                });
                renderCleanupResult(result, { applied: true });
            } catch (e) {
                resultEl.textContent = '✗ ' + (e?.message || '应用失败');
                resultEl.className = 'test-result error';
            } finally {
                applyBtn.disabled = false;
            }
        });

        overlay.querySelector('#btn-export-publish-events').addEventListener('click', async () => {
            const resultEl = overlay.querySelector('#publish-events-result');
            resultEl.textContent = '导出中...';
            resultEl.className = 'test-result';
            try {
                const payload = await chrome.runtime.sendMessage({ action: 'exportPublishEventLog' });
                if (!payload || !Array.isArray(payload.events)) {
                    resultEl.textContent = '✗ 导出失败：无返回数据';
                    resultEl.className = 'test-result error';
                    return;
                }
                const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const ts = new Date().toISOString().replace(/[:.]/g, '-');
                const a = document.createElement('a');
                a.href = url;
                a.download = `publish-events-${ts}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 5000);
                resultEl.innerHTML = `✓ 已导出 ${payload.events.length} / ${payload.maxEvents} 条事件（extension v${payload.extensionVersion || '?'}）`;
                resultEl.className = 'test-result success';
            } catch (e) {
                resultEl.textContent = '✗ ' + (e?.message || '导出失败');
                resultEl.className = 'test-result error';
            }
        });

        overlay.querySelector('#btn-clear-publish-events').addEventListener('click', async () => {
            const resultEl = overlay.querySelector('#publish-events-result');
            if (!confirm('确定清空黑匣子事件日志？之后再出问题就没有历史证据了。')) return;
            resultEl.textContent = '清空中...';
            resultEl.className = 'test-result';
            try {
                await chrome.runtime.sendMessage({ action: 'clearPublishEventLog' });
                resultEl.textContent = '✓ 已清空';
                resultEl.className = 'test-result success';
            } catch (e) {
                resultEl.textContent = '✗ ' + (e?.message || '清空失败');
                resultEl.className = 'test-result error';
            }
        });

        // Save
        overlay.querySelector('#btn-save-settings').addEventListener('click', async () => {
            await saveCurrentSettings(overlay);

            const toast = overlay.querySelector('#save-toast');
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 2000);
        });
    }

    function create(config = {}) {
        return {
            openSettings
        };
    }

    global.SettingsPanel = {
        open: openSettings,
        create
    };

})(self);
