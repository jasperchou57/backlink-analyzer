/**
 * Comment Publisher V3 - AI 驱动
 * 智能表单识别 + 验证码处理 + AI 评论生成
 */

(function () {
    if (window.__commentPublisherLoaded) return;
    window.__commentPublisherLoaded = true;

    let currentResourceId = null;
    let currentTaskId = null;

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.action === 'fillComment') {
            fillCommentForm(msg.data);
        }
    });

    async function fillCommentForm(data) {
        currentResourceId = data.resourceId;
        currentTaskId = data.taskId;
        const { name, email, website, mode, useAI, pageTitle } = data;

        // === 1. 尝试 AI 表单识别 ===
        let aiFormInfo = null;
        if (useAI) {
            try {
                // 获取评论区 HTML（限制大小）
                const formAreaHtml = getCommentAreaHtml();
                if (formAreaHtml) {
                    aiFormInfo = await chrome.runtime.sendMessage({
                        action: 'aiExtractForm',
                        html: formAreaHtml
                    });
                }
            } catch (e) {
                console.log('[BLA] AI 表单识别失败，回退到规则匹配:', e);
            }
        }

        // === 2. 找到表单（AI 优先，规则回退） ===
        let form = null;
        if (aiFormInfo && aiFormInfo.hasForm && aiFormInfo.formSelector) {
            form = document.querySelector(aiFormInfo.formSelector);
        }
        if (!form) {
            form = findFormByRules();
        }

        if (!form) {
            console.log('[BLA] 未找到评论表单');
            reportResult('failed');
            return;
        }

        // 高亮表单
        form.style.outline = '2px dashed #3ecfff';
        form.style.outlineOffset = '8px';
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // === 3. 生成评论（AI 优先） ===
        let comment = '';
        if (useAI) {
            try {
                const pageContent = getPageContent();
                const result = await chrome.runtime.sendMessage({
                    action: 'aiGenerateComment',
                    pageTitle: pageTitle || document.title,
                    pageContent,
                    targetUrl: website
                });
                comment = result.comment || '';
            } catch (e) {
                console.log('[BLA] AI 评论生成失败:', e);
            }
        }

        // AI 失败时用后备方案
        if (!comment) {
            comment = generateFallbackComment(pageTitle || document.title);
        }

        // === 4. 填充字段 ===
        if (aiFormInfo && aiFormInfo.fields && aiFormInfo.fields.length > 0) {
            // AI 模式：按 AI 返回的字段结构填充
            fillFieldsFromAI(form, aiFormInfo, { comment, name, email, website });
        } else {
            // 规则模式：传统选择器填充
            fillFieldsByRules(form, { comment, name, email, website });
        }

        // === 5. 处理验证码和复选框 ===
        handleCaptchaAndCheckboxes(form, aiFormInfo);

        // === 6. 取消通知勾选 ===
        uncheckNotifications();

        // === 7. 根据模式操作 ===
        if (mode === 'full-auto') {
            setTimeout(() => submitForm(form), 1500);
        } else {
            showCommentReadyDialog(form);
        }
    }

    // === 表单查找（规则） ===
    function findFormByRules() {
        const selectors = [
            '#commentform', '#respond form', '.comment-form',
            'form[action*="wp-comments-post"]', 'form.comment-form',
            '#comments form', '.post-comments form'
        ];
        for (const sel of selectors) {
            const form = document.querySelector(sel);
            if (form) return form;
        }
        // 通用：通过 textarea 反推 form
        const textareas = document.querySelectorAll('textarea');
        for (const ta of textareas) {
            const nameAttr = (ta.name || ta.id || '').toLowerCase();
            const placeholder = (ta.placeholder || '').toLowerCase();
            if (nameAttr.includes('comment') || nameAttr.includes('message') ||
                placeholder.includes('comment') || placeholder.includes('leave') ||
                placeholder.includes('reply')) {
                const form = ta.closest('form');
                if (form) return form;
            }
        }
        return null;
    }

    // === AI 字段填充 ===
    function fillFieldsFromAI(form, aiFormInfo, values) {
        for (const field of aiFormInfo.fields) {
            try {
                let el = null;
                if (field.selector) {
                    el = form.querySelector(field.selector) || document.querySelector(field.selector);
                }

                if (!el) continue;

                switch (field.type) {
                    case 'comment':
                        setFieldValue(el, values.comment);
                        break;
                    case 'name':
                        if (values.name) setFieldValue(el, values.name);
                        break;
                    case 'email':
                        if (values.email) setFieldValue(el, values.email);
                        break;
                    case 'website':
                        if (values.website) setFieldValue(el, values.website);
                        break;
                    case 'captcha':
                        if (field.answer) setFieldValue(el, field.answer);
                        break;
                    case 'checkbox':
                        if (field.shouldCheck && !el.checked) {
                            el.checked = true;
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        break;
                }
            } catch (e) {
                console.log(`[BLA] 填充字段失败 (${field.type}):`, e);
            }
        }
    }

    // === 规则字段填充 ===
    function fillFieldsByRules(form, values) {
        // Comment
        const commentField = form.querySelector(
            'textarea[name="comment"], textarea#comment, textarea[name="message"], textarea'
        );
        if (commentField) setFieldValue(commentField, values.comment);

        // Name
        const nameField = form.querySelector(
            'input[name="author"], input#author, input[name="name"], input[placeholder*="name" i], input[placeholder*="名" i]'
        );
        if (nameField && values.name) setFieldValue(nameField, values.name);

        // Email
        const emailField = form.querySelector(
            'input[name="email"], input#email, input[type="email"]'
        );
        if (emailField && values.email) setFieldValue(emailField, values.email);

        // Website
        const websiteField = form.querySelector(
            'input[name="url"], input#url, input[name="website"], input[type="url"]'
        );
        if (websiteField && values.website) setFieldValue(websiteField, values.website);
    }

    // === 验证码和复选框处理 ===
    function handleCaptchaAndCheckboxes(form, aiFormInfo) {
        // AI 已处理的跳过
        if (aiFormInfo && aiFormInfo.fields) {
            const aiHandled = aiFormInfo.fields.some(f => f.type === 'captcha' || f.type === 'checkbox');
            if (aiHandled) return;
        }

        // 规则处理简单数学验证码
        const allLabels = form.querySelectorAll('label, span, div, p');
        for (const label of allLabels) {
            const text = label.textContent.trim();
            // 匹配 "Sum of X + Y ?" 或 "X + Y = ?" 等
            const mathMatch = text.match(/(\d+)\s*[\+\-\*×]\s*(\d+)/);
            if (mathMatch) {
                const a = parseInt(mathMatch[1]);
                const b = parseInt(mathMatch[2]);
                let answer;
                if (text.includes('+') || text.includes('Sum')) answer = a + b;
                else if (text.includes('-')) answer = a - b;
                else if (text.includes('*') || text.includes('×')) answer = a * b;
                else answer = a + b; // 默认加法

                // 找到临近的 input
                const input = label.querySelector('input') ||
                    label.nextElementSibling?.querySelector('input') ||
                    label.parentElement?.querySelector('input[type="text"], input[type="number"]');
                if (input) {
                    setFieldValue(input, String(answer));
                }
            }
        }

        // 处理反垃圾复选框
        const spamCheckboxes = form.querySelectorAll(
            'input[type="checkbox"]'
        );
        for (const cb of spamCheckboxes) {
            const label = cb.closest('label')?.textContent?.toLowerCase() ||
                cb.parentElement?.textContent?.toLowerCase() || '';
            if (label.includes('not a spammer') || label.includes('not spam') ||
                label.includes('human') || label.includes('robot') ||
                label.includes('confirm') || label.includes('agree')) {
                if (!cb.checked) {
                    cb.checked = true;
                    cb.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }
    }

    // === 取消通知勾选 ===
    function uncheckNotifications() {
        const notifySelectors = [
            'input[name="subscribe"]', 'input[name="subscribe_comments"]',
            'input[name="subscribe_blog"]', 'input[id*="subscribe"]',
            'input[id*="notify"]', 'input[name*="notify"]',
            'input[id*="follow"]', 'input[name*="follow"]',
            '#jetpack-subscribe-comment', '#jetpack-subscribe-blog',
            '.comment-form-subscribe input[type="checkbox"]',
            '#wp-comment-cookies-consent'
        ];
        for (const sel of notifySelectors) {
            document.querySelectorAll(sel).forEach(cb => { cb.checked = false; });
        }
    }

    // === 工具函数 ===
    function setFieldValue(el, value) {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function getCommentAreaHtml() {
        const selectors = [
            '#respond', '#commentform', '.comment-form', '#comments',
            'form[action*="wp-comments-post"]', '.comment-respond'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) return el.outerHTML.substring(0, 4000);
        }
        // 回退：找包含 textarea 的 form
        const form = findFormByRules();
        if (form) return form.outerHTML.substring(0, 4000);
        return '';
    }

    function getPageContent() {
        // 提取文章正文（限制长度）
        const selectors = [
            'article', '.post-content', '.entry-content',
            '.article-content', 'main', '.content'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) return el.textContent.substring(0, 2000);
        }
        return document.body?.textContent?.substring(0, 2000) || '';
    }

    function generateFallbackComment(title) {
        const templates = [
            `This is a really insightful article about ${title || 'this topic'}. I appreciate the detailed analysis and practical approach.`,
            `Thanks for sharing this comprehensive post. The examples make it much easier to understand the key concepts.`,
            `Really well explained! I've been looking for clear information on this topic and this article delivers exactly that.`,
            `Great breakdown of ${title || 'the topic'}. I found the practical insights particularly helpful for my own projects.`,
            `This clarifies a lot of things I was uncertain about. Looking forward to reading more content like this.`
        ];
        return templates[Math.floor(Math.random() * templates.length)];
    }

    // === 弹窗 ===
    function showCommentReadyDialog(form) {
        const overlay = document.createElement('div');
        overlay.id = 'bla-dialog-overlay';

        const dialog = document.createElement('div');
        dialog.id = 'bla-dialog';
        dialog.innerHTML = `
            <h3 class="bla-dialog-title">Comment Ready</h3>
            <p class="bla-dialog-message">
                The comment form has been filled. Please review the content and click Submit to post, or Skip to move to the next resource.
            </p>
            <div class="bla-dialog-actions">
                <button id="bla-skip" class="bla-btn bla-btn-skip">Skip</button>
                <button id="bla-submit" class="bla-btn bla-btn-submit">Submit</button>
            </div>
        `;

        document.body.appendChild(overlay);
        document.body.appendChild(dialog);

        requestAnimationFrame(() => {
            overlay.classList.add('bla-show');
            dialog.classList.add('bla-show');
        });

        dialog.querySelector('#bla-submit').addEventListener('click', () => {
            removeDialog();
            submitForm(form);
        });

        dialog.querySelector('#bla-skip').addEventListener('click', () => {
            removeDialog();
            form.style.outline = 'none';
            reportResult('skipped');
        });
    }

    function submitForm(form) {
        const submitBtn = form.querySelector(
            'button[type="submit"], input[type="submit"], button#submit, .submit, button[name="submit"]'
        );

        if (submitBtn) {
            submitBtn.click();
        } else {
            form.submit();
        }

        setTimeout(() => reportResult('submitted'), 2000);
    }

    function reportResult(result) {
        chrome.runtime.sendMessage({
            action: 'commentAction',
            resourceId: currentResourceId,
            taskId: currentTaskId,
            result
        });
    }

    function removeDialog() {
        const overlay = document.getElementById('bla-dialog-overlay');
        const dialog = document.getElementById('bla-dialog');
        if (overlay) overlay.remove();
        if (dialog) dialog.remove();
    }
})();
