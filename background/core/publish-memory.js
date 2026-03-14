(function (global) {
    const STORAGE_KEYS = {
        siteTemplates: 'siteTemplates',
        publishAttempts: 'publishAttempts'
    };
    const ATTEMPT_LIMIT = 1600;

    let localStoreReady = null;

    function compactText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function trimText(value, max = 160) {
        return compactText(value).slice(0, max);
    }

    function normalizeHttpUrl(value) {
        const input = compactText(value);
        if (!input) return '';
        return /^https?:\/\//i.test(input) ? input : `https://${input}`;
    }

    function getHostFromUrl(value) {
        const normalized = normalizeHttpUrl(value);
        if (!normalized) return '';
        try {
            return new URL(normalized).hostname.replace(/^www\./i, '').toLowerCase();
        } catch {
            return '';
        }
    }

    async function ensureLocalStore() {
        if (typeof global.LocalDB === 'undefined') {
            return null;
        }

        if (!localStoreReady) {
            localStoreReady = (async () => {
                try {
                    if (typeof global.LocalDB.migrateFromChromeStorage === 'function') {
                        await global.LocalDB.migrateFromChromeStorage({ clearLegacy: true });
                    }
                    return global.LocalDB;
                } catch (error) {
                    console.warn('[BLA] LocalDB unavailable for publish memory, falling back to chrome.storage.local', error);
                    return null;
                }
            })();
        }

        return await localStoreReady;
    }

    async function getSiteTemplates() {
        const localStore = await ensureLocalStore();
        if (localStore?.getSiteTemplates) {
            return await localStore.getSiteTemplates();
        }

        const data = await global.chrome.storage.local.get(STORAGE_KEYS.siteTemplates);
        return data?.[STORAGE_KEYS.siteTemplates] && typeof data[STORAGE_KEYS.siteTemplates] === 'object'
            ? data[STORAGE_KEYS.siteTemplates]
            : {};
    }

    async function setSiteTemplates(templates) {
        const normalized = templates && typeof templates === 'object' && !Array.isArray(templates) ? templates : {};
        const localStore = await ensureLocalStore();
        if (localStore?.setSiteTemplates) {
            await localStore.setSiteTemplates(normalized);
            try {
                await global.chrome.storage.local.remove(STORAGE_KEYS.siteTemplates);
            } catch {}
            return;
        }

        await global.chrome.storage.local.set({ [STORAGE_KEYS.siteTemplates]: normalized });
    }

    async function getPublishAttempts() {
        const localStore = await ensureLocalStore();
        if (localStore?.getPublishAttempts) {
            return await localStore.getPublishAttempts();
        }

        const data = await global.chrome.storage.local.get(STORAGE_KEYS.publishAttempts);
        return Array.isArray(data?.[STORAGE_KEYS.publishAttempts]) ? data[STORAGE_KEYS.publishAttempts] : [];
    }

    async function setPublishAttempts(attempts) {
        const normalized = Array.isArray(attempts) ? attempts : [];
        const localStore = await ensureLocalStore();
        if (localStore?.setPublishAttempts) {
            await localStore.setPublishAttempts(normalized);
            try {
                await global.chrome.storage.local.remove(STORAGE_KEYS.publishAttempts);
            } catch {}
            return;
        }

        await global.chrome.storage.local.set({ [STORAGE_KEYS.publishAttempts]: normalized });
    }

    function sanitizeAttempt(attempt = {}) {
        return {
            id: trimText(attempt.id || '', 96),
            resourceId: trimText(attempt.resourceId || '', 80),
            resourceUrl: normalizeHttpUrl(attempt.resourceUrl || '').slice(0, 260),
            host: trimText(attempt.host || '', 120),
            taskId: trimText(attempt.taskId || '', 80),
            taskName: trimText(attempt.taskName || '', 120),
            status: trimText(attempt.status || '', 24),
            commentStyle: trimText(attempt.commentStyle || '', 32),
            linkMode: trimText(attempt.linkMode || '', 48),
            commentEditorType: trimText(attempt.commentEditorType || '', 32),
            commentFieldSelector: trimText(attempt.commentFieldSelector || '', 180),
            commentFieldFingerprint: trimText(attempt.commentFieldFingerprint || '', 180),
            formSignature: trimText(attempt.formSignature || '', 180),
            commentFieldVerified: !!attempt.commentFieldVerified,
            anchorRequested: !!attempt.anchorRequested,
            anchorInjected: !!attempt.anchorInjected,
            anchorVisible: !!attempt.anchorVisible,
            commentLocated: !!attempt.commentLocated,
            commentLocationMethod: trimText(attempt.commentLocationMethod || '', 48),
            reviewPending: !!attempt.reviewPending,
            reviewPolicy: trimText(attempt.reviewPolicy || '', 48),
            websitePolicy: trimText(attempt.websitePolicy || '', 48),
            submissionBlocked: !!attempt.submissionBlocked,
            submissionBlockReason: trimText(attempt.submissionBlockReason || '', 80),
            websiteFieldBlockedFirstComment: !!attempt.websiteFieldBlockedFirstComment,
            retryWithoutWebsite: !!attempt.retryWithoutWebsite,
            durationMs: Number(attempt.durationMs || 0) || 0,
            attemptedAt: attempt.attemptedAt || new Date().toISOString()
        };
    }

    function buildTemplateKey(host, formSignature, commentEditorType, linkMode) {
        return [
            trimText(host || '', 120) || 'unknown-host',
            trimText(formSignature || '', 180) || 'unknown-form',
            trimText(commentEditorType || '', 32) || 'unknown-editor',
            trimText(linkMode || '', 48) || 'unknown-link-mode'
        ].join('::');
    }

    function sanitizeTemplate(template = {}) {
        return {
            key: trimText(template.key || '', 420),
            host: trimText(template.host || '', 120),
            formSignature: trimText(template.formSignature || '', 180),
            commentEditorType: trimText(template.commentEditorType || '', 32),
            commentFieldSelector: trimText(template.commentFieldSelector || '', 180),
            commentFieldFingerprint: trimText(template.commentFieldFingerprint || '', 180),
            submitSelector: trimText(template.submitSelector || '', 180),
            linkMode: trimText(template.linkMode || '', 48),
            cms: trimText(template.cms || '', 32),
            resourceLinkMethod: trimText(template.resourceLinkMethod || '', 48),
            successCount: Number(template.successCount || 0) || 0,
            failureCount: Number(template.failureCount || 0) || 0,
            skippedCount: Number(template.skippedCount || 0) || 0,
            verifiedCount: Number(template.verifiedCount || 0) || 0,
            reviewPendingCount: Number(template.reviewPendingCount || 0) || 0,
            blockedCount: Number(template.blockedCount || 0) || 0,
            websiteFieldBlockedCount: Number(template.websiteFieldBlockedCount || 0) || 0,
            reviewPolicy: trimText(template.reviewPolicy || '', 48),
            websitePolicy: trimText(template.websitePolicy || '', 48),
            lastStatus: trimText(template.lastStatus || '', 24),
            firstSeenAt: template.firstSeenAt || '',
            lastSeenAt: template.lastSeenAt || '',
            updatedAt: template.updatedAt || ''
        };
    }

    function getTemplateScore(template = {}) {
        let score = 0;
        score += Number(template.successCount || 0) * 1000;
        score += Number(template.verifiedCount || 0) * 300;
        score += Number(template.failureCount || 0) * -120;
        score += Number(template.reviewPendingCount || 0) * -80;
        score += Number(template.blockedCount || 0) * -180;
        score += Number(template.websiteFieldBlockedCount || 0) * -60;
        score += Number(new Date(template.updatedAt || template.lastSeenAt || 0).getTime() || 0) / 1e9;
        return score;
    }

    function buildAttemptRecord(resource = {}, task = {}, status = '', publishMeta = {}) {
        const attemptedAt = publishMeta.updatedAt || new Date().toISOString();
        const host = getHostFromUrl(resource.url || publishMeta.pageUrlAfterSubmit || '');

        return sanitizeAttempt({
            id: `${resource.id || 'resource'}:${attemptedAt}:${status || 'unknown'}`,
            resourceId: resource.id || '',
            resourceUrl: resource.url || '',
            host,
            taskId: task.id || '',
            taskName: task.name || task.website || '',
            status,
            commentStyle: publishMeta.commentStyle || task.commentStyle || 'standard',
            linkMode: publishMeta.linkMode || resource.linkMethod || '',
            commentEditorType: publishMeta.commentEditorType || '',
            commentFieldSelector: publishMeta.commentFieldSelector || '',
            commentFieldFingerprint: publishMeta.commentFieldFingerprint || '',
            formSignature: publishMeta.formSignature || '',
            commentFieldVerified: !!publishMeta.commentFieldVerified,
            anchorRequested: !!publishMeta.anchorRequested,
            anchorInjected: !!publishMeta.anchorInjected,
            anchorVisible: !!publishMeta.anchorVisible,
            commentLocated: !!publishMeta.commentLocated,
            commentLocationMethod: publishMeta.commentLocationMethod || '',
            reviewPending: !!publishMeta.reviewPending,
            reviewPolicy: publishMeta.reviewPolicy || '',
            websitePolicy: publishMeta.websitePolicy || '',
            submissionBlocked: !!publishMeta.submissionBlocked,
            submissionBlockReason: publishMeta.submissionBlockReason || '',
            websiteFieldBlockedFirstComment: !!publishMeta.websiteFieldBlockedFirstComment,
            retryWithoutWebsite: !!publishMeta.retryWithoutWebsite,
            durationMs: Number(publishMeta.durationMs || 0) || 0,
            attemptedAt
        });
    }

    function mergeTemplate(existingTemplate = {}, resource = {}, status = '', publishMeta = {}) {
        const now = publishMeta.updatedAt || new Date().toISOString();
        const host = getHostFromUrl(resource.url || publishMeta.pageUrlAfterSubmit || '');
        const inferredCms = (resource.details || []).some((detail) => /wordpress/i.test(String(detail || '')))
            ? 'wordpress'
            : '';
        const key = buildTemplateKey(
            host,
            publishMeta.formSignature || '',
            publishMeta.commentEditorType || '',
            publishMeta.linkMode || resource.linkMethod || ''
        );

        const current = sanitizeTemplate(existingTemplate);

        return sanitizeTemplate({
            ...current,
            key,
            host,
            formSignature: publishMeta.formSignature || current.formSignature || '',
            commentEditorType: publishMeta.commentEditorType || current.commentEditorType || '',
            commentFieldSelector: publishMeta.commentFieldSelector || current.commentFieldSelector || '',
            commentFieldFingerprint: publishMeta.commentFieldFingerprint || current.commentFieldFingerprint || '',
            submitSelector: publishMeta.submitSelector || current.submitSelector || '',
            linkMode: publishMeta.linkMode || current.linkMode || resource.linkMethod || '',
            cms: publishMeta.cms || current.cms || inferredCms,
            resourceLinkMethod: resource.linkMethod || current.resourceLinkMethod || '',
            successCount: Number(current.successCount || 0) + (status === 'published' ? 1 : 0),
            failureCount: Number(current.failureCount || 0) + (status === 'failed' ? 1 : 0),
            skippedCount: Number(current.skippedCount || 0) + (status === 'skipped' ? 1 : 0),
            verifiedCount: Number(current.verifiedCount || 0) + (publishMeta.commentFieldVerified ? 1 : 0),
            reviewPendingCount: Number(current.reviewPendingCount || 0) + (publishMeta.reviewPending ? 1 : 0),
            blockedCount: Number(current.blockedCount || 0) + (publishMeta.submissionBlocked ? 1 : 0),
            websiteFieldBlockedCount: Number(current.websiteFieldBlockedCount || 0)
                + (publishMeta.websiteFieldBlockedFirstComment ? 1 : 0),
            reviewPolicy: publishMeta.reviewPolicy || current.reviewPolicy || '',
            websitePolicy: publishMeta.websitePolicy || current.websitePolicy || '',
            lastStatus: status || current.lastStatus || '',
            firstSeenAt: current.firstSeenAt || now,
            lastSeenAt: now,
            updatedAt: now
        });
    }

    async function appendPublishAttempt(resource = {}, task = {}, status = '', publishMeta = {}) {
        const attempts = await getPublishAttempts();
        const nextAttempt = buildAttemptRecord(resource, task, status, publishMeta);
        const nextAttempts = [nextAttempt, ...(attempts || [])].slice(0, ATTEMPT_LIMIT);
        await setPublishAttempts(nextAttempts);
        return nextAttempt;
    }

    async function rememberSiteTemplate(resource = {}, status = '', publishMeta = {}) {
        const host = getHostFromUrl(resource.url || publishMeta.pageUrlAfterSubmit || '');
        if (!host) return null;

        const hasTemplateSignals = !!(
            publishMeta.formSignature
            || publishMeta.commentFieldSelector
            || publishMeta.commentFieldFingerprint
            || publishMeta.commentEditorType
        );
        if (!hasTemplateSignals) return null;

        const templates = await getSiteTemplates();
        const key = buildTemplateKey(
            host,
            publishMeta.formSignature || '',
            publishMeta.commentEditorType || '',
            publishMeta.linkMode || resource.linkMethod || ''
        );
        templates[key] = mergeTemplate(templates[key] || {}, resource, status, publishMeta);
        await setSiteTemplates(templates);
        return templates[key];
    }

    async function rememberPublishOutcome(payload = {}) {
        const resource = payload.resource || {};
        const task = payload.task || {};
        const status = trimText(payload.status || '', 24);
        const publishMeta = payload.publishMeta && typeof payload.publishMeta === 'object' ? payload.publishMeta : {};

        const attempt = await appendPublishAttempt(resource, task, status, publishMeta);
        const template = await rememberSiteTemplate(resource, status, publishMeta);
        return { attempt, template };
    }

    async function getTemplateHint(url = '') {
        const host = getHostFromUrl(url);
        if (!host) return null;

        const templates = await getSiteTemplates();
        const candidates = Object.values(templates || {})
            .filter((template) => template?.host === host)
            .sort((left, right) => getTemplateScore(right) - getTemplateScore(left));

        const best = candidates[0];
        if (!best) return null;

        return {
            key: best.key || '',
            host: best.host || host,
            formSignature: best.formSignature || '',
            commentEditorType: best.commentEditorType || '',
            commentFieldSelector: best.commentFieldSelector || '',
            commentFieldFingerprint: best.commentFieldFingerprint || '',
            submitSelector: best.submitSelector || '',
            linkMode: best.linkMode || '',
            reviewPolicy: best.reviewPolicy || '',
            websitePolicy: best.websitePolicy || '',
            avoidWebsiteField: Number(best.websiteFieldBlockedCount || 0) > 0
                && Number(best.websiteFieldBlockedCount || 0) >= Number(best.successCount || 0)
        };
    }

    global.PublishMemory = {
        getSiteTemplates,
        setSiteTemplates,
        getPublishAttempts,
        setPublishAttempts,
        appendPublishAttempt,
        rememberSiteTemplate,
        rememberPublishOutcome,
        getTemplateHint
    };
})(self);
