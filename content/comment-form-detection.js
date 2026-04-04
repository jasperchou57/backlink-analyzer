(function (globalScope) {
    if (globalScope.CommentFormDetection) return;

    // ─── 多语言表单字段关键词（30+ 语言覆盖）───
    const ML_KEYWORDS = {
        author: [
            'author', 'name', 'nickname', 'user', 'username', 'login',
            '姓名', '名字', '昵称', '用户名', '稱呼', '署名',
            '名前', 'お名前', 'ニックネーム', '성함', '닉네임', '이름',
            'имя', 'ник', 'автор', 'الاسم', 'اسم المستخدم',
            'nombre', 'apodo', 'usuario', 'nom', 'pseudo', 'auteur',
            'vorname', 'nachname', 'benutzer', 'naam', 'gebruikersnaam',
            'isim', 'ad', 'kullanıcı', 'imię', 'nazwisko', 'użytkownik',
            'tên', 'biệt danh', 'nome', 'utente', 'namn', 'användarnamn',
            'नाम', 'ชื่อ', 'نام', 'שם', 'όνομα', 'nume', 'név', 'jméno', 'navn', 'nimi'
        ],
        email: [
            'email', 'mail', 'e-mail', 'address', 'mailbox',
            '邮箱', '邮件', '电子邮箱', 'メール', 'メールアドレス',
            '이메일', '메일', 'электронная почта', 'почта',
            'البريد الإلكتروني', 'correo', 'courriel', 'e-posta',
            'emailadres', 'e-mail', 'thư điện tử', 'posta elettronica',
            'ईमेल', 'อีเมล', 'ایمیل', 'דוא"ל', 'email'
        ],
        url: [
            'url', 'website', 'site', 'web', 'link', 'homepage', 'blog',
            '网址', '网站', '主页', 'ウェブサイト', 'ホームページ',
            '웹사이트', '홈페이지', 'веб-сайт', 'сайт',
            'الموقع', 'sitio web', 'site web', 'webseite',
            'web sitesi', 'strona internetowa', 'trang web',
            'sito web', 'webbplats', 'वेबसाइट', 'เว็บไซต์',
            'وب‌سایت', 'אתר', 'ιστότοπος', 'weboldal'
        ],
        comment: [
            'comment', 'message', 'text', 'content', 'reply', 'feedback', 'respond',
            '评论', '留言', '内容', '回复', 'コメント', 'メッセージ',
            '댓글', '메시지', '답글', 'комментарий', 'сообщение', 'отзыв',
            'تعليق', 'رسالة', 'comentario', 'mensaje', 'commentaire',
            'kommentar', 'nachricht', 'reactie', 'bericht',
            'yorum', 'mesaj', 'komentarz', 'bình luận',
            'commento', 'messaggio', 'kommentar', 'meddelande',
            'टिप्पणी', 'ความคิดเห็น', 'نظر', 'תגובה', 'σχόλιο',
            'comentariu', 'hozzászólás', 'komentář'
        ],
        submit: [
            'post', 'submit', 'publish', 'send', 'comment', 'add', 'save',
            '发布', '提交', '发表', '回复', '发送', '投稿', '送信', 'コメントを書く',
            '게시', '등록', '댓글 달기', 'отправить', 'опубликовать',
            'إرسال', 'نشر', 'publicar', 'enviar', 'publier', 'envoyer',
            'absenden', 'veröffentlichen', 'plaatsen', 'verzenden',
            'gönder', 'yayınla', 'dodaj', 'wyślij', 'gửi', 'đăng',
            'pubblica', 'invia', 'skicka', 'publicera',
            'जमा करें', 'ส่ง', 'ارسال', 'שלח', 'υποβολή', 'trimite', 'küldés', 'odeslat'
        ]
    };

    function compactText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function isVisible(el) {
        if (!(el instanceof HTMLElement)) return false;
        const style = globalScope.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect?.();
        return !!rect && rect.width > 0 && rect.height > 0;
    }

    function describeElement(el) {
        if (!el) return '';
        if (el.id) return `#${el.id}`;
        const name = compactText(el.getAttribute?.('name') || '');
        if (name) return `${(el.tagName || '').toLowerCase()}[name="${name.replace(/"/g, '\\"')}"]`;
        const classes = compactText(el.className || '')
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 3)
            .join('.');
        if (classes) return `${(el.tagName || '').toLowerCase()}.${classes}`;
        return (el.tagName || '').toLowerCase();
    }

    function findBasicSubmitButton(form) {
        if (!form) return null;

        const selectorCandidates = [
            'button[type="submit"]',
            'input[type="submit"]',
            'button#submit',
            'button[name="submit"]',
            '.submit button',
            '.submit input[type="submit"]'
        ];

        for (const selector of selectorCandidates) {
            const match = form.querySelector(selector);
            if (match && isVisible(match)) {
                return match;
            }
        }

        const controls = Array.from(form.querySelectorAll('button, input[type="button"], input[type="submit"], a[role="button"]'));
        return controls.find((el) => {
            if (!isVisible(el)) return false;
            const text = compactText(
                `${el.textContent || ''} ${el.value || ''} ${el.getAttribute?.('aria-label') || ''}`
            ).toLowerCase();
            return /(submit|post comment|post|reply|send|publish|发表评论|提交|发送|评论|antworten|kommentar|laisser un commentaire)/.test(text);
        }) || null;
    }

    function formHasInteractiveFields(form) {
        if (!form) return false;
        const hasCommentEditor = !!form.querySelector('textarea, [contenteditable="true"], .ql-editor, .ProseMirror, .mce-content-body');
        const hasTextInput = !!form.querySelector('input[type="text"], input[type="email"], input[type="url"], input:not([type])');
        const hasSubmit = !!findBasicSubmitButton(form);
        return (hasCommentEditor || hasTextInput) && hasSubmit;
    }

    function formHasWebsiteField(form) {
        if (!form) return false;
        return !!form.querySelector('input[name="url"], input#url, input[name="website"], input#website, input[type="url"], input[name="homepage"]');
    }

    function formHasIdentityFields(form) {
        if (!form) return false;
        return !!form.querySelector(
            'input[name="author"], input#author, input[name="name"], input#name, input[name="email"], input#email, input[type="email"]'
        );
    }

    function formHasCommentEditor(form) {
        if (!form) return false;
        return !!form.querySelector('textarea, [contenteditable="true"], .ql-editor, .ProseMirror, .mce-content-body');
    }

    function getStandardCommentFlow() {
        return globalScope.CommentStandardFlow || null;
    }

    function buildFormSignature(form) {
        const standardSignature = getStandardCommentFlow()?.buildFormSignature?.(form);
        if (standardSignature) return standardSignature;
        if (!form) return '';
        return compactText([
            form.id || '',
            form.className || '',
            form.getAttribute?.('action') || '',
            form.getAttribute?.('method') || '',
            formHasCommentEditor(form) ? 'comment-editor' : '',
            formHasWebsiteField(form) ? 'website-field' : ''
        ].join(' ')).toLowerCase();
    }

    /**
     * 多语言关键词匹配：检查表单元素的属性/文本是否命中关键词
     */
    function matchesMultiLangKeywords(el, category) {
        if (!el || !ML_KEYWORDS[category]) return false;
        const attrs = compactText(
            `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.getAttribute?.('aria-label') || ''} ${el.className || ''}`
        ).toLowerCase();
        return ML_KEYWORDS[category].some(kw => attrs.includes(kw.toLowerCase()));
    }

    function scoreCommentForm(form) {
        if (!form) return -Infinity;

        const standardFlow = getStandardCommentFlow();
        if (standardFlow?.isStandardCommentForm?.(form)) {
            return 220;
        }

        const signature = compactText(
            `${form.id || ''} ${form.className || ''} ${form.getAttribute?.('action') || ''}`
        ).toLowerCase();
        const text = compactText(form.textContent || '').toLowerCase();
        let score = 0;

        if (isVisible(form)) score += 20;
        if (/comment|respond|reply/.test(signature)) score += 35;
        if (/wp-comments-post/.test(signature)) score += 30;
        if (/(deja un comentario|leave a comment|leave a reply|发表评论|发表回复|reply|comentario|reactie|laisser un commentaire|message)/.test(text)) score += 25;
        if (form.querySelector('textarea')) score += 10;
        if (form.querySelector('textarea[name="comment"], textarea#comment, textarea[name*="comment" i], textarea[name*="message" i]')) score += 25;
        if (form.querySelector('input[name="author"], input#author, input[name="name"], input[name*="name" i]')) score += 12;
        if (form.querySelector('input[name="email"], input#email, input[type="email"], input[name*="mail" i]')) score += 12;
        if (form.querySelector('input[name="url"], input#url, input[name="website"], input[type="url"], input[name*="web" i]')) score += 8;
        if (findBasicSubmitButton(form)) score += 10;

        // ─── 多语言关键词加分 ───
        const textareas = form.querySelectorAll('textarea');
        for (const ta of textareas) {
            if (matchesMultiLangKeywords(ta, 'comment')) { score += 15; break; }
        }
        const inputs = form.querySelectorAll('input[type="text"], input:not([type]), input[type="email"], input[type="url"]');
        for (const inp of inputs) {
            if (matchesMultiLangKeywords(inp, 'author')) { score += 8; break; }
        }
        for (const inp of inputs) {
            if (matchesMultiLangKeywords(inp, 'email')) { score += 8; break; }
        }
        for (const inp of inputs) {
            if (matchesMultiLangKeywords(inp, 'url')) { score += 6; break; }
        }
        // 多语言提交按钮检测
        const buttons = form.querySelectorAll('button, input[type="submit"], input[type="button"]');
        for (const btn of buttons) {
            const btnText = compactText(`${btn.textContent || ''} ${btn.value || ''}`).toLowerCase();
            if (ML_KEYWORDS.submit.some(kw => btnText.includes(kw.toLowerCase()))) { score += 8; break; }
        }
        // 社交证据：页面已有评论列表
        const root = form.ownerDocument || globalScope.document;
        const existingComments = root.querySelectorAll('.comment-list > *, .comment-body, li.comment, ol.commentlist > li');
        if (existingComments.length > 0) score += 15;

        return score;
    }

    function findRuleBasedCommentForm(root = globalScope.document) {
        const standardForm = getStandardCommentFlow()?.findStandardCommentForm?.();
        if (standardForm) {
            return standardForm;
        }

        const candidates = new Map();
        const addCandidate = (form, bonus = 0) => {
            if (!form || !(form instanceof HTMLFormElement)) return;
            const previous = candidates.get(form) || 0;
            candidates.set(form, previous + scoreCommentForm(form) + bonus);
        };

        const selectors = [
            '#commentform',
            '#respond form',
            '.comment-form',
            'form[action*="wp-comments-post"]',
            'form.comment-form',
            '#comments form',
            '.post-comments form',
            '.comment-respond form'
        ];

        selectors.forEach((selector) => {
            root.querySelectorAll(selector).forEach((form) => addCandidate(form, 30));
        });

        root.querySelectorAll('form').forEach((form) => addCandidate(form, 0));

        root.querySelectorAll('textarea').forEach((textarea) => {
            const nameAttr = compactText(textarea.name || textarea.id || '').toLowerCase();
            const placeholder = compactText(textarea.placeholder || '').toLowerCase();
            const combined = `${nameAttr} ${placeholder}`;
            // 原有匹配 + 多语言关键词匹配
            if (
                nameAttr.includes('comment')
                || nameAttr.includes('message')
                || nameAttr.includes('reply')
                || placeholder.includes('comment')
                || placeholder.includes('leave')
                || placeholder.includes('reply')
                || placeholder.includes('write')
                || placeholder.includes('评论')
                || placeholder.includes('留言')
                || ML_KEYWORDS.comment.some(kw => combined.includes(kw.toLowerCase()))
            ) {
                addCandidate(textarea.closest('form'), 20);
            }
        });

        return Array.from(candidates.entries())
            .filter(([form]) => formHasInteractiveFields(form))
            .sort((left, right) => right[1] - left[1])[0]?.[0] || null;
    }

    function pageShowsExistingCommentBodyAnchors(root = globalScope.document) {
        const excludedSelectors = [
            '.comment-author',
            '.fn',
            '.avatar',
            '.reply',
            '.comment-reply-link',
            '.comment-meta',
            '.commentmetadata',
            '.comment-edit-link',
            '.says',
            '.navigation',
            '.nav-links'
        ].join(', ');
        const selectors = [
            '.comment-content a[href]',
            '.comment-body a[href]',
            '.comments-area p a[href]',
            '#comments p a[href]',
            'li.comment p a[href]',
            'article.comment p a[href]'
        ].join(', ');

        const anchors = Array.from(root.querySelectorAll(selectors));
        for (const anchor of anchors) {
            if (!(anchor instanceof HTMLAnchorElement)) continue;
            const href = compactText(anchor.getAttribute('href') || '');
            const text = compactText(anchor.textContent || '');
            if (!href || /^#|^(javascript|mailto|tel):/i.test(href)) continue;
            if (anchor.closest(excludedSelectors)) continue;
            if (text.length < 2) continue;
            const block = anchor.closest('.comment-content, .comment-body, li.comment, article.comment, .comment, p, div');
            const blockText = compactText(block?.textContent || '');
            if (blockText.length < 24) continue;
            return true;
        }
        return false;
    }

    function pageAllowsHtmlLinks(form, root = globalScope.document) {
        if (!form) return false;

        if (form.querySelector('[contenteditable="true"], .ql-editor, .ProseMirror, .mce-content-body, .tox-edit-area, .note-editable')) {
            return true;
        }

        if (form.querySelector('[aria-label*="link" i], [title*="link" i], [data-command="link"], .ql-link, .mce-i-link')) {
            return true;
        }

        const formText = compactText(form.textContent || '').toLowerCase();
        if (/(allowed html tags|html tags allowed|you may use these html tags|allowed tags|<a href|comment html|html标签|允许使用html|可用标签)/.test(formText)) {
            return true;
        }

        return pageShowsExistingCommentBodyAnchors(root);
    }

    function getRuntimeSupportedInlineModes(form, root = globalScope.document) {
        const modes = [];
        const formText = compactText(form?.textContent || '').toLowerCase();

        if (pageAllowsHtmlLinks(form, root)) {
            if (form?.querySelector('[contenteditable="true"], .ql-editor, .ProseMirror, .mce-content-body, .tox-edit-area, .note-editable')) {
                modes.push('rich-editor-anchor');
            } else {
                modes.push('raw-html-anchor');
            }
        }

        if (/markdown|commonmark|supports markdown|markdown editor|use markdown|支持markdown|使用markdown/.test(formText)) {
            modes.push('markdown-link');
        }

        if (/bbcode|ubb|bulletin board code|支持bbcode|\[url/.test(formText)) {
            modes.push('bbcode-link');
        }

        if (/autolink|linkify|plain url|bare url|paste a url|paste url|urls? will be linked|自动识别链接|自动转链接/.test(formText)) {
            modes.push('plain-url');
        }

        if (formHasWebsiteField(form)) {
            modes.push('website-field');
        }

        return Array.from(new Set(modes));
    }

    function detectPageCommentCapabilities(root = globalScope.document) {
        const result = {
            url: globalScope.location?.href || '',
            pageTitle: globalScope.document?.title || '',
            hasCommentForm: false,
            formType: 'unknown',
            formScore: 0,
            formSignature: '',
            commentFormSelector: '',
            linkMethod: 'text',
            linkModes: [],
            opportunities: [],
            details: [],
            sources: [],
            hasCaptcha: false,
            hasUrlField: false,
            directPublishReady: false,
            requiresLogin: false,
            commentsClosed: false,
            resourceClass: '',
            frictionLevel: ''
        };

        const pageText = compactText(root.body?.textContent || root.documentElement?.textContent || '').toLowerCase();
        const loginRequired = !!root.querySelector('.must-log-in, .login-required, [class*="login-to-comment"]')
            || /(must be logged in to post a comment|log in to leave a comment|login to leave a comment|sign in to comment|register to reply)/.test(pageText);
        const commentsClosed = /(comments are closed|commenting is closed|discussion closed)/.test(pageText);
        const hasCaptcha = !!root.querySelector('.g-recaptcha, .h-captcha, [data-sitekey], iframe[src*="captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [name*="captcha" i], [id*="captcha" i]')
            || /g-recaptcha|grecaptcha|hcaptcha|turnstile|cloudflare-turnstile|captcha/.test(root.documentElement?.innerHTML || '');

        const form = findRuleBasedCommentForm(root);
        const disqusDetected = !!root.querySelector('#disqus_thread, [class*="disqus"], iframe[src*="disqus.com"]');
        const bloggerDetected = !!root.querySelector('#comment-editor, iframe[src*="blogger.com/comment"], #blogger-comment-from, .blogger-comment-from');

        // 检查是否有已存在的评论（证明评论功能确实可用）
        const existingCommentNodes = root.querySelectorAll('.comment-list > *, .comment-body, li.comment, .comment-content, ol.commentlist > li, .comments-area .comment');
        const hasExistingComments = existingCommentNodes.length > 0;
        result.hasExistingComments = hasExistingComments;

        result.requiresLogin = loginRequired;
        result.commentsClosed = commentsClosed;
        result.hasCaptcha = hasCaptcha;

        if (form) {
            result.hasCommentForm = true;
            result.formScore = scoreCommentForm(form);
            result.formSignature = buildFormSignature(form);
            result.commentFormSelector = describeElement(form);
            result.hasUrlField = formHasWebsiteField(form);

            const standardForm = getStandardCommentFlow()?.isStandardCommentForm?.(form);
            if (standardForm) {
                result.formType = 'wordpress';
                result.details.push('wordpress');
            } else if (bloggerDetected) {
                result.formType = 'blogger';
                result.details.push('blogger');
            } else {
                result.formType = 'generic';
            }

            result.opportunities.push('comment');
            const linkModes = getRuntimeSupportedInlineModes(form, root);
            result.linkModes = linkModes;
            if (linkModes.includes('website-field')) {
                result.details.push('website-field');
                result.linkMethod = 'website-field';
            }
            if (linkModes.includes('raw-html-anchor') || linkModes.includes('rich-editor-anchor')) {
                result.details.push('allowed-html-anchor');
                result.linkMethod = 'html';
            }
            if (linkModes.includes('markdown-link')) result.details.push('markdown-link');
            if (linkModes.includes('bbcode-link')) result.details.push('bbcode-link');
            if (linkModes.includes('plain-url')) result.details.push('plain-url');
            if (formHasCommentEditor(form) && findBasicSubmitButton(form)) {
                result.details.push('inline-submit-form');
            }
            if (
                formHasCommentEditor(form)
                && !result.hasUrlField
                && !formHasIdentityFields(form)
                && !linkModes.some((mode) => mode !== 'website-field')
            ) {
                result.details.push('comment-only');
            }
        } else if (disqusDetected) {
            result.hasCommentForm = true;
            result.formType = 'disqus';
            result.opportunities.push('disqus');
            result.details.push('disqus');
        } else if (bloggerDetected) {
            result.hasCommentForm = true;
            result.formType = 'blogger';
            result.opportunities.push('comment');
            result.details.push('blogger');
        }

        if (loginRequired) result.details.push('login-required');
        if (commentsClosed) result.details.push('comment-closed');
        if (hasCaptcha) result.details.push('captcha');

        if (result.opportunities.length === 0 && result.hasCommentForm) {
            result.opportunities.push('comment');
        }

        const resourceShape = {
            url: result.url,
            pageTitle: result.pageTitle,
            opportunities: Array.from(new Set(result.opportunities)),
            details: Array.from(new Set(result.details)),
            linkModes: Array.from(new Set(result.linkModes))
        };
        result.opportunities = resourceShape.opportunities;
        result.details = resourceShape.details;
        result.linkModes = resourceShape.linkModes;
        result.directPublishReady = !!globalScope.ResourceRules?.isDirectPublishReady?.(resourceShape);
        result.resourceClass = globalScope.ResourceRules?.getResourceClass?.(resourceShape) || '';
        result.frictionLevel = globalScope.ResourceRules?.getResourceFrictionLevel?.(resourceShape) || '';

        // 没有已有评论作为降权信号，不阻断发布（新文章/懒加载可能暂时没有评论）
        if (!hasExistingComments) {
            result.details.push('no-existing-comments');
        }

        if ((result.linkModes.includes('raw-html-anchor') || result.linkModes.includes('rich-editor-anchor'))) {
            result.linkMethod = 'html';
        } else if (result.linkModes.includes('website-field')) {
            result.linkMethod = 'website-field';
        }

        return result;
    }

    globalScope.CommentFormDetection = {
        compactText,
        isVisible,
        describeElement,
        findBasicSubmitButton,
        formHasInteractiveFields,
        formHasWebsiteField,
        formHasIdentityFields,
        formHasCommentEditor,
        buildFormSignature,
        scoreCommentForm,
        findRuleBasedCommentForm,
        pageAllowsHtmlLinks,
        getRuntimeSupportedInlineModes,
        detectPageCommentCapabilities
    };
})(window);
