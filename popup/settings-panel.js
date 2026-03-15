/**
 * Settings Panel - 设置面板模块
 * 从 popup.js 提取，负责 AI 配置、Google Sheets、用户信息、评论模板
 */

// === AI 提供商配置 ===
const AI_PROVIDERS = {
    openrouter: { name: 'OpenRouter', keyPlaceholder: 'sk-or-...', modelPlaceholder: '例如 google/gemini-2.0-flash-001' },
    qwen:       { name: '通义千问 (DashScope)', keyPlaceholder: 'sk-...', modelPlaceholder: '例如 qwen-plus / qwen-turbo' },
    openai:     { name: 'OpenAI', keyPlaceholder: 'sk-...', modelPlaceholder: '例如 gpt-4o-mini' },
    deepseek:   { name: 'DeepSeek', keyPlaceholder: 'sk-...', modelPlaceholder: '例如 deepseek-chat' },
    custom:     { name: '自定义 (OpenAI兼容)', keyPlaceholder: 'API Key...', modelPlaceholder: '模型 ID' }
};

async function openSettings() {
    const settings = await StorageHelper.getSettings();

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
      <h4>AI 配置</h4>
      <div class="settings-field">
        <label>API 提供商</label>
        <select class="input" id="set-ai-provider">
          <option value="openrouter" ${(settings.aiProvider || 'openrouter') === 'openrouter' ? 'selected' : ''}>OpenRouter</option>
          <option value="qwen" ${settings.aiProvider === 'qwen' ? 'selected' : ''}>通义千问 (DashScope)</option>
          <option value="openai" ${settings.aiProvider === 'openai' ? 'selected' : ''}>OpenAI</option>
          <option value="deepseek" ${settings.aiProvider === 'deepseek' ? 'selected' : ''}>DeepSeek</option>
          <option value="custom" ${settings.aiProvider === 'custom' ? 'selected' : ''}>自定义 (OpenAI兼容)</option>
        </select>
      </div>
      <div class="settings-field" id="field-base-url" style="display:${settings.aiProvider === 'custom' ? 'block' : 'none'}">
        <label>API Base URL</label>
        <input class="input" id="set-base-url" value="${escapeHtml(settings.aiBaseUrl || '')}" placeholder="https://your-api.com/v1/chat/completions">
      </div>
      <div class="settings-field">
        <label>API Key</label>
        <input class="input" id="set-api-key" type="password" value="${escapeHtml(settings.aiApiKey || settings.openrouterApiKey || '')}" placeholder="${escapeHtml((AI_PROVIDERS[settings.aiProvider || 'openrouter'] || AI_PROVIDERS.openrouter).keyPlaceholder)}">
      </div>
      <div class="settings-field">
        <label>链接分类模型 (classify)</label>
        <input class="input" id="set-model-classify" value="${escapeHtml(settings.modelClassify || '')}" placeholder="${escapeHtml((AI_PROVIDERS[settings.aiProvider || 'openrouter'] || AI_PROVIDERS.openrouter).modelPlaceholder)}">
      </div>
      <div class="settings-field">
        <label>表单识别模型 (formExtract)</label>
        <input class="input" id="set-model-form" value="${escapeHtml(settings.modelFormExtract || '')}" placeholder="${escapeHtml((AI_PROVIDERS[settings.aiProvider || 'openrouter'] || AI_PROVIDERS.openrouter).modelPlaceholder)}">
      </div>
      <div class="settings-field">
        <label>评论生成模型 (commentGen)</label>
        <input class="input" id="set-model-comment" value="${escapeHtml(settings.modelCommentGen || '')}" placeholder="${escapeHtml((AI_PROVIDERS[settings.aiProvider || 'openrouter'] || AI_PROVIDERS.openrouter).modelPlaceholder)}">
      </div>
      <div class="settings-field">
        <label>链接发现模型 (linkDiscover)</label>
        <input class="input" id="set-model-link" value="${escapeHtml(settings.modelLinkDiscover || '')}" placeholder="${escapeHtml((AI_PROVIDERS[settings.aiProvider || 'openrouter'] || AI_PROVIDERS.openrouter).modelPlaceholder)}">
      </div>
      <button class="btn-test" id="btn-test-ai">测试 AI 连接</button>
      <div class="test-result" id="ai-test-result"></div>
    </div>

    <div class="settings-section">
      <h4>Google Sheets</h4>
      <div class="settings-field">
        <label>Google Sheet ID</label>
        <input class="input" id="set-sheet-id" value="${escapeHtml(settings.googleSheetId || '')}" placeholder="从 Sheet URL 中提取的 ID">
      </div>
      <button class="btn-test" id="btn-sync-sheets">同步到 Sheets</button>
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
      <h4>${i18n.t('settings.templates')}</h4>
      <div style="font-size:11px;color:#8891a8;margin-bottom:8px">可用变量: {title} {greeting} {complement} {question} {domain} {keyword}</div>
      <div id="templates-list">${templatesHtml}</div>
      <button class="btn-add-template" id="btn-add-tpl">+ ${i18n.t('settings.addTemplate')}</button>
    </div>

    <button class="btn-save" id="btn-save-settings">${i18n.t('settings.save')}</button>
    <div class="save-toast" id="save-toast">${i18n.t('settings.saved')}</div>
  `;

    document.body.appendChild(overlay);

    overlay.querySelector('#settings-back').addEventListener('click', () => overlay.remove());

    // 切换 API 提供商时更新 placeholder 和显示自定义 URL 字段
    overlay.querySelector('#set-ai-provider').addEventListener('change', (e) => {
        const provider = AI_PROVIDERS[e.target.value] || AI_PROVIDERS.openrouter;
        overlay.querySelector('#set-api-key').placeholder = provider.keyPlaceholder;
        overlay.querySelectorAll('#set-model-classify, #set-model-form, #set-model-comment, #set-model-link').forEach(el => {
            el.placeholder = provider.modelPlaceholder;
        });
        overlay.querySelector('#field-base-url').style.display = e.target.value === 'custom' ? 'block' : 'none';
    });

    overlay.querySelectorAll('.template-remove').forEach(btn => {
        btn.addEventListener('click', () => btn.closest('.template-item').remove());
    });

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

    overlay.querySelector('#btn-test-ai').addEventListener('click', async () => {
        const resultEl = overlay.querySelector('#ai-test-result');
        resultEl.textContent = '测试中...';
        resultEl.className = 'test-result';

        await saveCurrentSettings(overlay);

        const result = await chrome.runtime.sendMessage({ action: 'testAiConnection' });
        if (result.success) {
            resultEl.textContent = '连接成功: ' + result.message;
            resultEl.className = 'test-result success';
        } else {
            resultEl.textContent = '连接失败: ' + result.message;
            resultEl.className = 'test-result error';
        }
    });

    overlay.querySelector('#btn-sync-sheets').addEventListener('click', async () => {
        const resultEl = overlay.querySelector('#sheets-result');
        resultEl.textContent = '同步中...';
        resultEl.className = 'test-result';

        await saveCurrentSettings(overlay);

        const result = await chrome.runtime.sendMessage({ action: 'syncToSheets' });
        if (result.success) {
            resultEl.textContent = result.message;
            resultEl.className = 'test-result success';
        } else {
            resultEl.textContent = result.message;
            resultEl.className = 'test-result error';
        }
    });

    overlay.querySelector('#btn-save-settings').addEventListener('click', async () => {
        await saveCurrentSettings(overlay);

        const toast = overlay.querySelector('#save-toast');
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2000);
    });
}

async function saveCurrentSettings(overlay) {
    const templates = Array.from(overlay.querySelectorAll('.tpl-text'))
        .map(el => el.value.trim())
        .filter(Boolean);

    const newSettings = {
        aiProvider: overlay.querySelector('#set-ai-provider').value,
        aiApiKey: overlay.querySelector('#set-api-key').value.trim(),
        aiBaseUrl: overlay.querySelector('#set-base-url').value.trim(),
        modelClassify: overlay.querySelector('#set-model-classify').value.trim(),
        modelFormExtract: overlay.querySelector('#set-model-form').value.trim(),
        modelCommentGen: overlay.querySelector('#set-model-comment').value.trim(),
        modelLinkDiscover: overlay.querySelector('#set-model-link').value.trim(),
        googleSheetId: overlay.querySelector('#set-sheet-id').value.trim(),
        name: overlay.querySelector('#set-name').value.trim(),
        email: overlay.querySelector('#set-email').value.trim(),
        website: overlay.querySelector('#set-website').value.trim(),
        commentTemplates: templates,
        language: i18n.currentLang
    };

    await StorageHelper.saveSettings(newSettings);
}
