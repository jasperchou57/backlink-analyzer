/**
 * VerificationRuntime — orchestrates real-page verification via tabs.
 *
 * Opens a URL in a background tab, injects page-controller.js + page-verifier.js,
 * waits for verification result, then records it into domain intel.
 *
 * Uses LLM fallback when rule-based verification is inconclusive.
 */

const VerificationRuntime = {

    create(deps) {
        const {
            domainIntel,
            getDomain,
            normalizeUrl,
            AIEngine,
            Logger,
            delay,
            waitForTabLoad,
            resourceStore
        } = deps;

        const VERIFICATION_TIMEOUT_MS = 15000;
        const VERIFY_CONCURRENCY = 3;
        let verifyTabId = null;

        async function ensureVerifyTab() {
            if (verifyTabId !== null) {
                try {
                    await chrome.tabs.get(verifyTabId);
                    return verifyTabId;
                } catch {
                    verifyTabId = null;
                }
            }
            const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
            verifyTabId = tab.id;
            return verifyTabId;
        }

        async function closeVerifyTab() {
            if (verifyTabId === null) return;
            try { await chrome.tabs.remove(verifyTabId); } catch {}
            verifyTabId = null;
        }

        /**
         * Verify a single URL by opening it in a tab and running page-verifier.
         * Returns verification result or null on failure.
         */
        async function verifyUrl(url) {
            const normalized = normalizeUrl(url);
            if (!normalized) return null;

            const domain = getDomain(normalized);

            // Check domain archive first — skip if recently verified
            if (domain && domainIntel.shouldSkipVerification(domain)) {
                const cached = domainIntel.getVerificationStatus(domain);
                if (cached) {
                    return {
                        url: normalized,
                        domain,
                        cached: true,
                        ...cached
                    };
                }
            }

            const tabId = await ensureVerifyTab();

            try {
                await chrome.tabs.update(tabId, { url: normalized });
                await waitForTabLoad(tabId);
                await delay(1000);

                // Inject page-controller + page-verifier
                await chrome.scripting.executeScript({
                    target: { tabId },
                    files: ['content/page-controller.js']
                });
                await chrome.scripting.executeScript({
                    target: { tabId },
                    files: ['content/page-verifier.js']
                });

                // Wait for verification result via message
                const result = await waitForVerificationResult(tabId, VERIFICATION_TIMEOUT_MS);

                if (result) {
                    // Record into domain intel
                    await domainIntel.recordVerification(normalized, result);

                    // Optionally run LLM verification for ambiguous cases
                    if (result.quickSignals?.hasCommentForm && !result.quickSignals?.hasCaptcha && !result.quickSignals?.requiresLogin) {
                        // Clear positive — no LLM needed
                    } else if (result.simplifiedDom && result.elementCount > 3) {
                        // Ambiguous — use LLM to determine
                        try {
                            const llmResult = await verifyWithLLM(normalized, result);
                            if (llmResult) {
                                // Merge LLM insights into result
                                result.llmVerification = llmResult;
                                if (llmResult.hasCommentForm !== undefined) {
                                    result.quickSignals.hasCommentForm = llmResult.hasCommentForm;
                                }
                                if (llmResult.hasUrlField !== undefined) {
                                    result.quickSignals.hasUrlField = llmResult.hasUrlField;
                                }
                                if (llmResult.requiresLogin !== undefined) {
                                    result.quickSignals.requiresLogin = llmResult.requiresLogin;
                                }
                                // Re-record with LLM-enhanced data
                                await domainIntel.recordVerification(normalized, result);
                            }
                        } catch (e) {
                            await Logger.error(`LLM 验证失败: ${e.message}`, { url: normalized });
                        }
                    }

                    return {
                        url: normalized,
                        domain,
                        cached: false,
                        ...mapVerificationToStatus(result)
                    };
                }

                return null;
            } catch (e) {
                await Logger.error(`页面验证失败: ${e.message}`, { url: normalized });
                return null;
            }
        }

        function waitForVerificationResult(tabId, timeoutMs) {
            return new Promise((resolve) => {
                let resolved = false;
                const timer = setTimeout(() => {
                    if (resolved) return;
                    resolved = true;
                    chrome.runtime.onMessage.removeListener(listener);
                    resolve(null);
                }, timeoutMs);

                function listener(message, sender) {
                    if (resolved) return;
                    if (sender.tab?.id !== tabId) return;
                    if (message?.action !== 'pageVerificationResult') return;

                    resolved = true;
                    clearTimeout(timer);
                    chrome.runtime.onMessage.removeListener(listener);
                    resolve(message.data || null);
                }

                chrome.runtime.onMessage.addListener(listener);
            });
        }

        async function verifyWithLLM(url, pageResult) {
            if (!AIEngine || typeof AIEngine.call !== 'function') return null;

            const simplifiedDom = (pageResult.simplifiedDom || '').slice(0, 3000);
            if (!simplifiedDom) return null;

            const prompt = `你是一个网页分析助手。以下是一个网页的可交互元素列表（简化DOM）。请判断：

1. 这个页面是否有免登录的评论表单（comment form）？
2. 评论表单是否有 URL/Website 字段可以留外链？
3. 是否需要登录才能评论？
4. 是否有验证码（captcha）？
5. 评论是否已关闭？

网页 URL: ${url}
页面标题: ${pageResult.title || ''}

简化DOM元素列表:
${simplifiedDom}

请只返回JSON格式:
{"hasCommentForm": true/false, "hasUrlField": true/false, "requiresLogin": true/false, "hasCaptcha": true/false, "commentsClosed": true/false, "confidence": "high"/"medium"/"low", "reason": "简短说明"}`;

            try {
                const response = await AIEngine.call('verify-page', prompt, {
                    maxTokens: 300,
                    temperature: 0.1
                });
                if (!response) return null;

                const text = typeof response === 'string' ? response : (response.text || response.content || '');
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (!jsonMatch) return null;

                return JSON.parse(jsonMatch[0]);
            } catch {
                return null;
            }
        }

        function mapVerificationToStatus(result) {
            const signals = result.quickSignals || {};
            let status = 'no_form';
            if (signals.hasCommentForm) {
                if (signals.hasCaptcha) status = 'captcha';
                else if (signals.requiresLogin) status = 'login_required';
                else if (signals.commentsClosed) status = 'closed';
                else status = 'verified_ready';
            }

            return {
                status,
                verifiedPublishable: status === 'verified_ready',
                cms: signals.cms || null,
                hasCaptcha: !!signals.hasCaptcha,
                captchaType: signals.captchaType || null,
                requiresLogin: !!signals.requiresLogin,
                commentsClosed: !!signals.commentsClosed,
                formSignature: signals.formSignature || null,
                hasUrlField: !!signals.hasUrlField,
                hasRichEditor: !!signals.hasRichEditor
            };
        }

        /**
         * Batch-verify multiple resources. Uses domain-level dedup
         * to avoid verifying the same domain twice.
         */
        async function verifyBatch(resources = [], options = {}) {
            const maxItems = options.maxItems || 50;
            const domainsSeen = new Set();
            const toVerify = [];
            const results = [];

            await domainIntel.ensureLoaded();

            for (const resource of resources) {
                if (toVerify.length >= maxItems) break;

                const url = normalizeUrl(resource.url || '');
                if (!url) continue;

                const domain = getDomain(url);
                if (!domain) continue;

                // Domain-level dedup: only verify one URL per domain
                if (domainsSeen.has(domain)) {
                    // Use the domain's existing verification for this URL
                    const cached = domainIntel.getVerificationStatus(domain);
                    if (cached) {
                        results.push({ url, domain, cached: true, resourceId: resource.id, ...cached });
                    }
                    continue;
                }
                domainsSeen.add(domain);

                // Skip if domain already verified recently
                if (domainIntel.shouldSkipVerification(domain)) {
                    const cached = domainIntel.getVerificationStatus(domain);
                    if (cached) {
                        results.push({ url, domain, cached: true, resourceId: resource.id, ...cached });
                        continue;
                    }
                }

                toVerify.push({ url, domain, resourceId: resource.id });
            }

            // Process verification queue with concurrency limit
            const queue = [...toVerify];
            async function worker() {
                while (queue.length > 0) {
                    const item = queue.shift();
                    if (!item) break;

                    try {
                        const result = await verifyUrl(item.url);
                        if (result) {
                            results.push({ ...result, resourceId: item.resourceId });
                        }
                    } catch {}

                    // Small delay between verifications
                    await delay(500);
                }
            }

            // Run single worker (sequential) for tab-based verification
            await worker();

            await closeVerifyTab();

            return {
                total: resources.length,
                verified: results.length,
                domainsCovered: domainsSeen.size,
                results
            };
        }

        /**
         * Update resources in-place based on verification results.
         * Returns the modified resources array — caller is responsible for persisting.
         */
        async function applyVerificationToResources(verificationResults = [], getStoredResources) {
            if (!verificationResults.length || typeof getStoredResources !== 'function') return { updatedCount: 0 };

            const resources = await getStoredResources();
            const domainStatusMap = new Map();

            for (const result of verificationResults) {
                if (result.domain) {
                    domainStatusMap.set(result.domain, result);
                }
            }

            let updatedCount = 0;
            for (const resource of resources) {
                const domain = getDomain(resource.url || '');
                if (!domain) continue;

                const verification = domainStatusMap.get(domain);
                if (!verification) continue;

                let changed = false;

                // Add verification signals to resource details
                if (verification.status === 'verified_ready' && !resource.verifiedReady) {
                    resource.verifiedReady = true;
                    resource.details = [...(resource.details || []), 'page-verified-ready'].slice(0, 6);
                    changed = true;
                }
                if (verification.hasCaptcha && !resource.hasCaptcha) {
                    resource.hasCaptcha = true;
                    resource.details = [...(resource.details || []), 'captcha-detected'].slice(0, 6);
                    changed = true;
                }
                if (verification.requiresLogin) {
                    const hasLogin = (resource.details || []).some(d => /login-required/i.test(d));
                    if (!hasLogin) {
                        resource.details = [...(resource.details || []), 'login-required'].slice(0, 6);
                        changed = true;
                    }
                }
                if (verification.commentsClosed) {
                    const hasClosed = (resource.details || []).some(d => /comment-closed/i.test(d));
                    if (!hasClosed) {
                        resource.details = [...(resource.details || []), 'comment-closed'].slice(0, 6);
                        changed = true;
                    }
                }
                if (verification.hasUrlField && !resource.hasUrlField) {
                    resource.hasUrlField = true;
                    changed = true;
                }

                if (changed) updatedCount++;
            }

            return { updatedCount };
        }

        return {
            verifyUrl,
            verifyBatch,
            applyVerificationToResources,
            closeVerifyTab,
            ensureVerifyTab
        };
    }
};

self.VerificationRuntime = VerificationRuntime;
