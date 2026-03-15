/**
 * Comment Publisher - 轻量 UI 层
 * 只负责：显示 Agent 状态浮层 + 用户确认弹窗 + ask_user 交互
 * 所有 AI 逻辑和 Agent 循环在 background.js 中运行
 */

(function () {
    if (window.__commentPublisherLoaded) return;
    window.__commentPublisherLoaded = true;

    let overlay = null;

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        switch (msg.action) {
            case 'agent:showStatus':
                showStatus(msg.step, msg.maxSteps, msg.text);
                break;
            case 'agent:askUser':
                askUser(msg.question).then(answer => sendResponse({ answer }));
                return true;
            case 'agent:confirmSubmit':
                confirmSubmit().then(confirmed => sendResponse({ confirmed }));
                return true;
            case 'agent:done':
                showDone(msg.success, msg.text);
                break;
            case 'agent:hide':
                removeOverlay();
                break;
        }
    });

    // ============================================================
    // 状态浮层 — 显示 Agent 当前在做什么
    // ============================================================

    function showStatus(step, maxSteps, text) {
        ensureOverlay();
        const content = overlay.querySelector('.bla-agent-content');
        if (content) {
            content.innerHTML = `
                <div class="bla-agent-step">Step ${step}/${maxSteps}</div>
                <div class="bla-agent-text">${escapeHtml(text)}</div>
                <div class="bla-agent-loader"><div class="bla-agent-loader-bar"></div></div>
            `;
        }
    }

    // ============================================================
    // ask_user — AI 遇到验证码等问题时询问用户
    // ============================================================

    function askUser(question) {
        return new Promise((resolve) => {
            ensureOverlay();
            const content = overlay.querySelector('.bla-agent-content');
            if (!content) { resolve(''); return; }

            content.innerHTML = `
                <div class="bla-agent-icon">❓</div>
                <div class="bla-agent-question">${escapeHtml(question)}</div>
                <input type="text" class="bla-agent-input" placeholder="输入你的回答..." autofocus />
                <div class="bla-agent-actions">
                    <button class="bla-agent-btn bla-agent-btn-skip">跳过</button>
                    <button class="bla-agent-btn bla-agent-btn-confirm">确认</button>
                </div>
            `;

            const input = content.querySelector('.bla-agent-input');
            const btnConfirm = content.querySelector('.bla-agent-btn-confirm');
            const btnSkip = content.querySelector('.bla-agent-btn-skip');

            const submit = () => {
                const answer = input.value.trim();
                resolve(answer);
            };

            btnConfirm.addEventListener('click', submit);
            btnSkip.addEventListener('click', () => resolve(''));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') submit();
            });

            input.focus();
        });
    }

    // ============================================================
    // 确认提交 — 半自动模式下，提交前让用户确认
    // ============================================================

    function confirmSubmit() {
        return new Promise((resolve) => {
            ensureOverlay();
            const content = overlay.querySelector('.bla-agent-content');
            if (!content) { resolve(false); return; }

            content.innerHTML = `
                <div class="bla-agent-icon">📝</div>
                <div class="bla-agent-question">表单已填写完毕，是否提交？</div>
                <div class="bla-agent-actions">
                    <button class="bla-agent-btn bla-agent-btn-skip">跳过</button>
                    <button class="bla-agent-btn bla-agent-btn-confirm">提交</button>
                </div>
            `;

            content.querySelector('.bla-agent-btn-confirm').addEventListener('click', () => resolve(true));
            content.querySelector('.bla-agent-btn-skip').addEventListener('click', () => resolve(false));
        });
    }

    // ============================================================
    // 完成状态
    // ============================================================

    function showDone(success, text) {
        ensureOverlay();
        const content = overlay.querySelector('.bla-agent-content');
        if (!content) return;

        content.innerHTML = `
            <div class="bla-agent-icon">${success ? '✅' : '❌'}</div>
            <div class="bla-agent-text">${escapeHtml(text || (success ? '评论已填写完成' : '未找到评论表单'))}</div>
        `;

        // 3 秒后自动消失
        setTimeout(removeOverlay, 3000);
    }

    // ============================================================
    // 浮层管理
    // ============================================================

    function ensureOverlay() {
        if (overlay && document.body.contains(overlay)) return;

        overlay = document.createElement('div');
        overlay.id = 'bla-agent-overlay';
        overlay.innerHTML = `<div class="bla-agent-panel"><div class="bla-agent-header">
                <span class="bla-agent-title">Backlink Analyzer</span>
                <button class="bla-agent-close">&times;</button>
            </div><div class="bla-agent-content"></div></div>`;

        // 注入样式
        if (!document.getElementById('bla-agent-styles')) {
            const style = document.createElement('style');
            style.id = 'bla-agent-styles';
            style.textContent = getStyles();
            document.head.appendChild(style);
        }

        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('bla-show'));

        overlay.querySelector('.bla-agent-close').addEventListener('click', () => {
            chrome.runtime.sendMessage({ action: 'agent:userClose' });
            removeOverlay();
        });
    }

    function removeOverlay() {
        if (overlay) {
            overlay.classList.remove('bla-show');
            setTimeout(() => { overlay?.remove(); overlay = null; }, 300);
        }
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function getStyles() {
        return `
            #bla-agent-overlay {
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 2147483647;
                opacity: 0;
                transform: translateY(-10px);
                transition: opacity 0.3s, transform 0.3s;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            }
            #bla-agent-overlay.bla-show {
                opacity: 1;
                transform: translateY(0);
            }
            .bla-agent-panel {
                width: 340px;
                background: #1a1a2e;
                border: 1px solid rgba(62, 207, 255, 0.3);
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 20px rgba(62, 207, 255, 0.1);
                overflow: hidden;
            }
            .bla-agent-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 16px;
                background: linear-gradient(135deg, #16213e, #1a1a2e);
                border-bottom: 1px solid rgba(62, 207, 255, 0.2);
            }
            .bla-agent-title {
                color: #3ecfff;
                font-size: 14px;
                font-weight: 600;
                letter-spacing: 0.5px;
            }
            .bla-agent-close {
                background: none;
                border: none;
                color: #666;
                font-size: 20px;
                cursor: pointer;
                padding: 0 4px;
                line-height: 1;
            }
            .bla-agent-close:hover { color: #ff4757; }
            .bla-agent-content {
                padding: 20px 16px;
                color: #e0e0e0;
                font-size: 13px;
                line-height: 1.6;
            }
            .bla-agent-step {
                color: #3ecfff;
                font-size: 11px;
                font-weight: 600;
                text-transform: uppercase;
                letter-spacing: 1px;
                margin-bottom: 8px;
            }
            .bla-agent-text {
                color: #ccc;
                font-size: 13px;
                margin-bottom: 12px;
            }
            .bla-agent-icon {
                font-size: 28px;
                text-align: center;
                margin-bottom: 12px;
            }
            .bla-agent-question {
                color: #fff;
                font-size: 14px;
                font-weight: 500;
                margin-bottom: 16px;
                text-align: center;
            }
            .bla-agent-input {
                width: 100%;
                padding: 10px 12px;
                background: #0f0f23;
                border: 1px solid rgba(62, 207, 255, 0.3);
                border-radius: 8px;
                color: #fff;
                font-size: 14px;
                outline: none;
                box-sizing: border-box;
                margin-bottom: 12px;
            }
            .bla-agent-input:focus {
                border-color: #3ecfff;
                box-shadow: 0 0 8px rgba(62, 207, 255, 0.2);
            }
            .bla-agent-actions {
                display: flex;
                gap: 10px;
                justify-content: flex-end;
            }
            .bla-agent-btn {
                padding: 8px 20px;
                border-radius: 8px;
                border: none;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
            }
            .bla-agent-btn-skip {
                background: #2a2a3e;
                color: #888;
            }
            .bla-agent-btn-skip:hover {
                background: #333350;
                color: #aaa;
            }
            .bla-agent-btn-confirm {
                background: linear-gradient(135deg, #3ecfff, #2196f3);
                color: #fff;
            }
            .bla-agent-btn-confirm:hover {
                background: linear-gradient(135deg, #5dd9ff, #42a5f5);
                box-shadow: 0 4px 12px rgba(62, 207, 255, 0.3);
            }
            .bla-agent-loader {
                height: 3px;
                background: #0f0f23;
                border-radius: 2px;
                overflow: hidden;
            }
            .bla-agent-loader-bar {
                height: 100%;
                width: 30%;
                background: linear-gradient(90deg, #3ecfff, #2196f3);
                border-radius: 2px;
                animation: bla-loader 1.5s infinite ease-in-out;
            }
            @keyframes bla-loader {
                0% { transform: translateX(-100%); }
                100% { transform: translateX(400%); }
            }
        `;
    }
})();
