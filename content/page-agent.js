/**
 * Page Agent - DOM 元素索引器 + 工具执行器
 * 借鉴 Submify/page-agent 架构：扫描页面交互元素，生成索引列表，执行 AI 工具调用
 */

(function () {
    if (window.__pageAgentLoaded) return;
    window.__pageAgentLoaded = true;

    // === 状态 ===
    let selectorMap = new Map(); // index → { ref: HTMLElement, tagName, text, attributes }

    // === 原生 setter（兼容 React/Vue） ===
    const nativeInputSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, 'value'
    ).set;
    const nativeTextareaSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, 'value'
    ).set;

    // === 消息监听 ===
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type !== 'PAGE_AGENT') return;

        const handler = handlers[msg.action];
        if (handler) {
            Promise.resolve(handler(msg.payload))
                .then(result => sendResponse(result))
                .catch(err => sendResponse({ success: false, error: err.message }));
            return true;
        }
    });

    const handlers = {
        scan: () => scanPage(),
        click_element_by_index: (p) => clickByIndex(p.index),
        input_text: (p) => inputTextByIndex(p.index, p.text),
        select_dropdown_option: (p) => selectByIndex(p.index, p.text),
        scroll: (p) => scrollPage(p),
        wait: (p) => waitSeconds(p.seconds || 1),
        execute_javascript: (p) => executeJS(p.script),
        get_page_info: () => getPageInfo(),
    };

    // ============================================================
    // 扫描页面 → 生成 [index]<type>text</type> 格式
    // ============================================================

    function scanPage() {
        selectorMap.clear();
        let index = 0;
        const lines = [];

        const url = window.location.href;
        const title = document.title;

        // 交互元素选择器
        const interactiveSelectors = [
            'a[href]',
            'button',
            'input:not([type="hidden"])',
            'textarea',
            'select',
            '[role="button"]',
            '[role="link"]',
            '[role="menuitem"]',
            '[role="tab"]',
            '[role="checkbox"]',
            '[role="radio"]',
            '[role="textbox"]',
            '[contenteditable="true"]',
            'summary',
            'label[for]',
        ];

        const allElements = document.querySelectorAll(interactiveSelectors.join(','));

        for (const el of allElements) {
            if (!isVisible(el)) continue;
            if (!isInViewportExpanded(el)) continue;

            const info = getElementInfo(el);
            selectorMap.set(index, { ref: el, ...info });

            // 构建 [index]<type attrs>text</type> 格式
            let line = `[${index}]<${info.tagName}`;
            if (info.attrs) line += ` ${info.attrs}`;
            line += `>`;
            if (info.text) line += info.text;
            line += ` />`;

            lines.push(line);
            index++;
        }

        return {
            success: true,
            url,
            title,
            elementCount: index,
            elements: lines.join('\n'),
            pageInfo: getPageInfo()
        };
    }

    function getElementInfo(el) {
        const tagName = el.tagName.toLowerCase();
        const text = getVisibleText(el).substring(0, 80);
        const attrParts = [];

        // 收集关键属性
        const importantAttrs = [
            'type', 'name', 'placeholder', 'value', 'href',
            'role', 'aria-label', 'id', 'for', 'alt', 'title',
            'checked', 'selected', 'disabled', 'required'
        ];

        for (const attr of importantAttrs) {
            let val = el.getAttribute(attr);
            if (val === null) continue;
            if (attr === 'href' && val.length > 60) val = val.substring(0, 60) + '...';
            if (attr === 'value' && val.length > 30) val = val.substring(0, 30) + '...';
            attrParts.push(`${attr}="${val}"`);
        }

        // checkbox/radio 的 checked 状态
        if ((el.type === 'checkbox' || el.type === 'radio') && el.checked) {
            if (!attrParts.some(a => a.startsWith('checked='))) {
                attrParts.push('checked="true"');
            }
        }

        return {
            tagName,
            text: text.trim(),
            attrs: attrParts.join(' ')
        };
    }

    function getVisibleText(el) {
        // 对于 input/textarea，返回 placeholder 或 value
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            return el.placeholder || el.value || '';
        }
        if (el instanceof HTMLSelectElement) {
            const selected = el.options[el.selectedIndex];
            return selected ? selected.text : '';
        }
        // 其他元素：获取直接文本，不含子交互元素的文本
        let text = '';
        for (const child of el.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                text += child.textContent;
            } else if (child.nodeType === Node.ELEMENT_NODE) {
                const tag = child.tagName.toLowerCase();
                if (!['a', 'button', 'input', 'textarea', 'select'].includes(tag)) {
                    text += child.textContent || '';
                }
            }
        }
        return text.substring(0, 80);
    }

    // ============================================================
    // 工具函数：点击
    // ============================================================

    async function clickByIndex(index) {
        const entry = selectorMap.get(index);
        if (!entry || !entry.ref) {
            return { success: false, error: `元素 [${index}] 不存在` };
        }
        const el = entry.ref;

        try {
            await scrollIntoView(el);
            await simulateClick(el);
            return { success: true, message: `已点击 [${index}] <${entry.tagName}>${entry.text}` };
        } catch (e) {
            return { success: false, error: `点击失败: ${e.message}` };
        }
    }

    async function simulateClick(el) {
        // 完整事件链，模拟真实用户操作
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
        await wait(50);
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        el.focus();
        await wait(50);
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await wait(200);
    }

    // ============================================================
    // 工具函数：输入文本
    // ============================================================

    async function inputTextByIndex(index, text) {
        const entry = selectorMap.get(index);
        if (!entry || !entry.ref) {
            return { success: false, error: `元素 [${index}] 不存在` };
        }
        const el = entry.ref;

        if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement) &&
            !el.isContentEditable) {
            return { success: false, error: `元素 [${index}] 不是输入框` };
        }

        try {
            await scrollIntoView(el);

            // 先点击聚焦
            await simulateClick(el);

            if (el.isContentEditable) {
                // contentEditable 元素
                el.textContent = text;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                // 使用原生 setter（兼容 React/Vue）
                if (el instanceof HTMLTextAreaElement) {
                    nativeTextareaSetter.call(el, text);
                } else {
                    nativeInputSetter.call(el, text);
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }

            // blur 触发验证
            el.dispatchEvent(new Event('blur', { bubbles: true }));

            return { success: true, message: `已输入 [${index}]: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"` };
        } catch (e) {
            return { success: false, error: `输入失败: ${e.message}` };
        }
    }

    // ============================================================
    // 工具函数：选择下拉选项
    // ============================================================

    async function selectByIndex(index, text) {
        const entry = selectorMap.get(index);
        if (!entry || !entry.ref) {
            return { success: false, error: `元素 [${index}] 不存在` };
        }
        const el = entry.ref;

        if (!(el instanceof HTMLSelectElement)) {
            return { success: false, error: `元素 [${index}] 不是下拉框` };
        }

        try {
            const option = Array.from(el.options).find(
                o => o.textContent.trim().toLowerCase() === text.trim().toLowerCase()
            );
            if (!option) {
                const available = Array.from(el.options).map(o => o.textContent.trim()).join(', ');
                return { success: false, error: `选项 "${text}" 不存在，可用选项: ${available}` };
            }

            el.value = option.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));

            return { success: true, message: `已选择 [${index}]: "${text}"` };
        } catch (e) {
            return { success: false, error: `选择失败: ${e.message}` };
        }
    }

    // ============================================================
    // 工具函数：滚动
    // ============================================================

    async function scrollPage(params) {
        const { down = true, num_pages = 0.5 } = params;
        const pixels = params.pixels || Math.round(window.innerHeight * num_pages);
        const amount = down ? pixels : -pixels;

        // 如果指定了 index，滚动该元素的容器
        if (params.index !== undefined) {
            const entry = selectorMap.get(params.index);
            if (entry && entry.ref) {
                entry.ref.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await wait(500);
                return { success: true, message: `已滚动到元素 [${params.index}]` };
            }
        }

        window.scrollBy({ top: amount, behavior: 'smooth' });
        await wait(500);

        const scrollY = window.scrollY;
        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
        const position = maxScroll > 0 ? Math.round((scrollY / maxScroll) * 100) : 0;

        return {
            success: true,
            message: `已${down ? '向下' : '向上'}滚动 ${Math.abs(amount)}px，当前位置 ${position}%`
        };
    }

    // ============================================================
    // 工具函数：等待
    // ============================================================

    async function waitSeconds(seconds) {
        const s = Math.min(Math.max(seconds, 0.5), 10);
        await wait(s * 1000);
        return { success: true, message: `已等待 ${s} 秒` };
    }

    // ============================================================
    // 工具函数：执行 JS
    // ============================================================

    async function executeJS(script) {
        try {
            const result = await eval(script);
            return {
                success: true,
                message: `JS 执行结果: ${String(result).substring(0, 500)}`
            };
        } catch (e) {
            return { success: false, error: `JS 执行失败: ${e.message}` };
        }
    }

    // ============================================================
    // 页面信息
    // ============================================================

    function getPageInfo() {
        return {
            url: window.location.href,
            title: document.title,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            pageHeight: document.documentElement.scrollHeight,
            scrollY: Math.round(window.scrollY),
            scrollPercent: Math.round(
                (window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)) * 100
            )
        };
    }

    // ============================================================
    // 辅助函数
    // ============================================================

    function isVisible(el) {
        if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') {
            // fixed/sticky 元素的 offsetParent 可能为 null
            const style = getComputedStyle(el);
            if (style.position !== 'fixed' && style.position !== 'sticky') return false;
        }
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    }

    function isInViewportExpanded(el, expansion = 500) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        return (
            rect.bottom >= -expansion &&
            rect.top <= window.innerHeight + expansion &&
            rect.right >= -expansion &&
            rect.left <= window.innerWidth + expansion
        );
    }

    function scrollIntoView(el) {
        return new Promise(resolve => {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(resolve, 300);
        });
    }

    function wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
})();
