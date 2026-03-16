(function (global) {
    function create(config = {}) {
        const strategy = {
            RESOURCE_HISTORY_LIMIT: 6,
            RESOURCE_URL_LIMIT: 260,
            RESOURCE_TITLE_LIMIT: 140,
            RESOURCE_DETAIL_LIMIT: 4,
            RESOURCE_DETAIL_TEXT_LIMIT: 80,
            RESOURCE_QUOTA_RETRY_LIMITS: [20000, 15000, 10000, 5000],
            ...(config.strategy || {})
        };
        const compactText = typeof config.compactText === 'function'
            ? config.compactText
            : (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const normalizeHttpUrl = typeof config.normalizeHttpUrl === 'function'
            ? config.normalizeHttpUrl
            : (value) => String(value || '').trim();
        const logger = config.logger || console;

        let localStoreReady = null;

        function trimStorageText(value, max = 160) {
            return compactText(value || '').slice(0, max);
        }

        function compactStorageList(values = [], limit = 4, maxText = 80) {
            const next = [];
            for (const value of values || []) {
                const normalized = trimStorageText(value, maxText);
                if (!normalized || next.includes(normalized)) continue;
                next.push(normalized);
                if (next.length >= limit) break;
            }
            return next;
        }

        function omitEmptyStorageValues(obj = {}) {
            return Object.fromEntries(Object.entries(obj).filter(([, value]) => {
                if (value === undefined || value === null || value === '') return false;
                if (Array.isArray(value)) return value.length > 0;
                if (typeof value === 'object') return Object.keys(value).length > 0;
                return true;
            }));
        }

        function sanitizePublishMetaForStorage(meta = {}) {
            return omitEmptyStorageValues({
                updatedAt: meta.updatedAt || '',
                commentStyle: trimStorageText(meta.commentStyle || '', 32),
                anchorRequested: meta.anchorRequested ? true : undefined,
                anchorInjected: meta.anchorInjected ? true : undefined,
                anchorVisible: meta.anchorVisible ? true : undefined,
                anchorVerified: meta.anchorVerified ? true : undefined,
                anchorText: trimStorageText(meta.anchorText || '', 80),
                anchorUrl: normalizeHttpUrl(meta.anchorUrl || '').slice(0, strategy.RESOURCE_URL_LIMIT),
                linkMode: trimStorageText(meta.linkMode || '', 48),
                retryWithoutWebsite: meta.retryWithoutWebsite ? true : undefined,
                websiteOmitted: meta.websiteOmitted ? true : undefined,
                reviewPending: meta.reviewPending ? true : undefined,
                reviewPolicy: trimStorageText(meta.reviewPolicy || '', 48),
                websitePolicy: trimStorageText(meta.websitePolicy || '', 48),
                commentLocated: meta.commentLocated ? true : undefined,
                commentLocationMethod: trimStorageText(meta.commentLocationMethod || '', 48),
                commentLocatedExcerpt: trimStorageText(meta.commentLocatedExcerpt || '', 180),
                websiteFieldBlockedFirstComment: meta.websiteFieldBlockedFirstComment ? true : undefined,
                commentFieldVerified: meta.commentFieldVerified ? true : undefined,
                commentEditorType: trimStorageText(meta.commentEditorType || '', 32),
                commentFieldSelector: trimStorageText(meta.commentFieldSelector || '', 180),
                commentFieldFingerprint: trimStorageText(meta.commentFieldFingerprint || '', 180),
                commentFillStrategy: trimStorageText(meta.commentFillStrategy || '', 24),
                commentCandidateCount: Number(meta.commentCandidateCount || 0) || undefined,
                formSignature: trimStorageText(meta.formSignature || '', 180),
                submitSelector: trimStorageText(meta.submitSelector || '', 180),
                submissionBlocked: meta.submissionBlocked ? true : undefined,
                submissionBlockReason: trimStorageText(meta.submissionBlockReason || '', 80),
                websiteRetryExhausted: meta.websiteRetryExhausted ? true : undefined,
                cooldownDeferred: meta.cooldownDeferred ? true : undefined,
                cooldownUntil: meta.cooldownUntil || '',
                durationMs: Number(meta.durationMs || 0) || undefined
            });
        }

        function sanitizePublishHistoryForStorage(history = {}) {
            return Object.fromEntries(Object.entries(history || {})
                .sort(([, left], [, right]) => String(right?.lastAttemptAt || '').localeCompare(String(left?.lastAttemptAt || '')))
                .slice(0, strategy.RESOURCE_HISTORY_LIMIT)
                .map(([key, entry]) => [key, omitEmptyStorageValues({
                    targetKey: entry?.targetKey || key,
                    targetUrl: normalizeHttpUrl(entry?.targetUrl || '').slice(0, strategy.RESOURCE_URL_LIMIT),
                    targetDomain: trimStorageText(entry?.targetDomain || '', 80),
                    taskId: trimStorageText(entry?.taskId || '', 80),
                    taskName: trimStorageText(entry?.taskName || '', 120),
                    lastStatus: trimStorageText(entry?.lastStatus || '', 24),
                    lastAttemptAt: entry?.lastAttemptAt || '',
                    lastPublishedAt: entry?.lastPublishedAt || '',
                    attempts: omitEmptyStorageValues({
                        published: Number(entry?.attempts?.published || 0) || undefined,
                        skipped: Number(entry?.attempts?.skipped || 0) || undefined,
                        failed: Number(entry?.attempts?.failed || 0) || undefined
                    }),
                    publishMeta: sanitizePublishMetaForStorage(entry?.publishMeta || {})
                })]));
        }

        function sanitizeSourceEvidenceForStorage(sourceEvidence = {}) {
            return omitEmptyStorageValues({
                historicalSuccess: Number(sourceEvidence?.historicalSuccess || 0) || undefined,
                commentObserved: Number(sourceEvidence?.commentObserved || 0) || undefined,
                competitorBacklink: Number(sourceEvidence?.competitorBacklink || 0) || undefined,
                ruleGuess: Number(sourceEvidence?.ruleGuess || 0) || undefined,
                aiGuess: Number(sourceEvidence?.aiGuess || 0) || undefined
            });
        }

        function sanitizeResourceForStorage(resource = {}) {
            return omitEmptyStorageValues({
                id: trimStorageText(resource.id || '', 80),
                url: normalizeHttpUrl(resource.url || '').slice(0, strategy.RESOURCE_URL_LIMIT),
                pageTitle: trimStorageText(resource.pageTitle || '', strategy.RESOURCE_TITLE_LIMIT),
                type: trimStorageText(resource.type || (resource.opportunities || []).join('+'), 120),
                opportunities: compactStorageList(resource.opportunities || [], 6, 32),
                details: compactStorageList(resource.details || [], strategy.RESOURCE_DETAIL_LIMIT, strategy.RESOURCE_DETAIL_TEXT_LIMIT),
                linkModes: compactStorageList(resource.linkModes || [], 6, 32),
                linkMethod: trimStorageText(resource.linkMethod || '', 24),
                signalVersion: Number(resource.signalVersion || 0) || undefined,
                resourceClass: trimStorageText(resource.resourceClass || '', 24),
                frictionLevel: trimStorageText(resource.frictionLevel || '', 16),
                resourcePool: trimStorageText(resource.resourcePool || '', 16),
                resourcePoolReason: trimStorageText(resource.resourcePoolReason || '', 48),
                directPublishReady: resource.directPublishReady ? true : undefined,
                hasCaptcha: resource.hasCaptcha ? true : undefined,
                hasUrlField: resource.hasUrlField ? true : undefined,
                sources: compactStorageList(resource.sources || [], 4, 8),
                sourceTypes: compactStorageList(resource.sourceTypes || [], 4, 24),
                sourceTier: trimStorageText(resource.sourceTier || '', 32),
                discoverySourceTier: trimStorageText(resource.discoverySourceTier || '', 32),
                sourceTiers: compactStorageList(resource.sourceTiers || [], 5, 32),
                sourceTierScore: Number(resource.sourceTierScore || 0) || undefined,
                discoveryEdges: compactStorageList(resource.discoveryEdges || [], 6, 120),
                sourceEvidence: sanitizeSourceEvidenceForStorage(resource.sourceEvidence || {}),
                candidateType: trimStorageText(resource.candidateType || '', 24),
                discoveredAt: resource.discoveredAt || '',
                status: trimStorageText(resource.status || 'pending', 24),
                publishedAt: resource.publishedAt || '',
                aiClassified: resource.aiClassified ? true : undefined,
                publishMeta: sanitizePublishMetaForStorage(resource.publishMeta || {}),
                publishHistory: sanitizePublishHistoryForStorage(resource.publishHistory || {})
            });
        }

        function cleanupResourcesForStorage(resources = []) {
            return (resources || [])
                .map((resource) => sanitizeResourceForStorage(resource))
                .filter((resource) => resource.id && resource.url);
        }

        function getResourceStoragePriority(resource = {}) {
            const historySize = Object.keys(resource.publishHistory || {}).length;
            const recency = new Date(resource.publishedAt || resource.discoveredAt || 0).getTime() || 0;
            let score = recency;
            if (resource.resourcePool === 'main') score += 2e15;
            if (resource.resourcePool === 'legacy') score += 8e14;
            if (resource.resourcePool === 'quarantine') score -= 4e14;
            if (resource.status === 'pending') score += 1e15;
            if (resource.status === 'failed') score += 5e14;
            score += Number(resource.sourceTierScore || 0) * 1e12;
            if (resource.publishMeta?.anchorVisible) score += 4e14;
            if (resource.publishMeta?.commentFieldVerified) score += 3e14;
            if (resource.publishMeta?.anchorInjected) score += 2e14;
            if (historySize > 0) score += historySize * 1e13;
            return score;
        }

        function compactResourcesForQuota(resources = [], limit = 20000) {
            return [...(resources || [])]
                .sort((left, right) => getResourceStoragePriority(right) - getResourceStoragePriority(left))
                .slice(0, Math.max(1, limit));
        }

        function getPreferredLinkMethod(current = '', next = '') {
            const priority = { html: 3, 'website-field': 2, text: 1 };
            return (priority[next] || 0) >= (priority[current] || 0) ? next : current;
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
                        logger.warn?.('[BLA] LocalDB unavailable for resources, falling back to chrome.storage.local', error);
                        return null;
                    }
                })();
            }

            return await localStoreReady;
        }

        async function getResources() {
            const localStore = await ensureLocalStore();
            if (localStore?.getResources) {
                const resources = await localStore.getResources();
                return Array.isArray(resources) ? resources : [];
            }

            const data = await global.chrome.storage.local.get('resources');
            return Array.isArray(data.resources) ? data.resources : [];
        }

        async function setResources(resources = []) {
            const normalizedResources = Array.isArray(resources) ? resources : [];
            const localStore = await ensureLocalStore();
            if (localStore?.setResources) {
                await localStore.setResources(normalizedResources);
                try {
                    await global.chrome.storage.local.remove('resources');
                } catch {}
                return;
            }

            await global.chrome.storage.local.set({ resources: normalizedResources });
        }

        async function writeResources(resources = []) {
            const sanitized = cleanupResourcesForStorage(resources);
            try {
                await setResources(sanitized);
                return sanitized;
            } catch (error) {
                for (const limit of strategy.RESOURCE_QUOTA_RETRY_LIMITS) {
                    if (sanitized.length <= limit) continue;
                    const compacted = compactResourcesForQuota(sanitized, limit);
                    try {
                        await setResources(compacted);
                        logger.warn?.(`[BLA] storage quota hit, compacted resources to ${compacted.length}`);
                        return compacted;
                    } catch {}
                }
                throw error;
            }
        }

        async function performMaintenance() {
            const localStore = await ensureLocalStore();
            if (localStore?.migrateFromChromeStorage) {
                await localStore.migrateFromChromeStorage({ clearLegacy: true });
            }
            const resources = await getResources();
            if (resources.length > 0) {
                await writeResources(resources);
            }
        }

        async function clearAll() {
            try {
                await global.chrome.storage.local.remove('resources');
            } catch {}
            const localStore = await ensureLocalStore();
            if (localStore?.setResources) {
                await localStore.setResources([]);
            }
        }

        return {
            ensureLocalStore,
            getResources,
            setResources,
            writeResources,
            performMaintenance,
            clearAll,
            getPreferredLinkMethod
        };
    }

    global.ResourceStore = {
        create
    };
})(self);
