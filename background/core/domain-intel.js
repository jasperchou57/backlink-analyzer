/**
 * Domain Intelligence Management
 *
 * Manages the domain frontier and domain profiles (discovery, profiling,
 * publish evidence, drilldown enrichment, scoring).
 *
 * Factory: DomainIntel.create(deps) → instance with mutable cache.
 */

/* global self */

const DomainIntel = {
    create(deps) {
        const {
            FrontierScheduler,
            StateStore,
            getDomain,
            mergeStringArrays,
            mergeSourceTierArrays,
            preferHigherSourceTier,
            mergeDiscoveryEdges,
            buildDiscoveryEdge,
            buildDomainProfileFromHtml,
            calculateDomainQualityScore,
            SOURCE_TIERS,
            // These two helpers reach into background.js mutable state;
            // the caller supplies closures that capture the live values.
            getCollectState,
            getContinuousSeedDomain,
            getContinuousMyDomain
        } = deps;

        let cache = { frontier: [], profiles: {} };
        let loaded = false;

        // ── persistence ─────────────────────────────────────────

        async function ensureLoaded() {
            if (loaded) return;
            cache = await StateStore.loadDomainIntel();
            loaded = true;
        }

        async function flush() {
            if (!loaded) return;
            await StateStore.saveDomainIntel(cache.frontier, cache.profiles);
        }

        // ── low-level helpers ───────────────────────────────────

        function createDomainFrontierEntry(domain) {
            return FrontierScheduler.createEntry(domain);
        }

        function mergeDomainStatus(current = 'discovered', next = 'discovered') {
            return FrontierScheduler.mergeStatus(current, next);
        }

        function ensureDomainFrontierEntry(domain) {
            let entry = cache.frontier.find((item) => item.domain === domain);
            if (!entry) {
                entry = createDomainFrontierEntry(domain);
                cache.frontier.push(entry);
            }
            return entry;
        }

        function shouldQueueDomainForRecursiveCollection(context = {}) {
            return FrontierScheduler.shouldQueueForRecursiveCollection(context);
        }

        function getContextRecursiveDepth(context = {}) {
            if (Number.isFinite(context.recursiveDepth)) return Number(context.recursiveDepth);
            const collectState = getCollectState();
            return Number(collectState.discoveryDepth || 0);
        }

        function markEntryCrawlPending(entry, context = {}) {
            const collectState = getCollectState();
            FrontierScheduler.markEntryCrawlPending(entry, {
                ...context,
                recursiveDepth: getContextRecursiveDepth(context)
            }, {
                seedDomain: getContinuousSeedDomain() || getDomain(collectState.domain || ''),
                myDomain: getContinuousMyDomain() || getDomain(collectState.myDomain || '')
            });
        }

        async function markDomainCrawlState(domain, patch = {}) {
            if (!domain) return;
            await ensureLoaded();
            const entry = ensureDomainFrontierEntry(domain);
            Object.assign(entry, patch);
            recalculateDomainIntelScores();
            await flush();
        }

        function getNextPendingFrontierDomain() {
            const collectState = getCollectState();
            return FrontierScheduler.getNextPendingEntry(cache.frontier, {
                seedDomain: getContinuousSeedDomain() || getDomain(collectState.domain || ''),
                myDomain: getContinuousMyDomain() || getDomain(collectState.myDomain || '')
            });
        }

        // ── recording ───────────────────────────────────────────

        async function recordDomainIntel(items = [], context = {}) {
            if (!items.length) return;
            await ensureLoaded();
            const now = new Date().toISOString();
            const collectState = getCollectState();

            for (const item of items) {
                const domain = getDomain(item.domain || item.url || item);
                if (!domain) continue;

                const entry = ensureDomainFrontierEntry(domain);
                entry.lastSeenAt = now;
                entry.seenCount = (entry.seenCount || 0) + 1;
                entry.status = mergeDomainStatus(entry.status, context.status || 'discovered');
                entry.sources = mergeStringArrays(entry.sources, item.sources || context.sources || [], 8);
                entry.sourceTypes = mergeStringArrays(entry.sourceTypes, item.sourceTypes || (item.sourceType ? [item.sourceType] : []) || [], 4);
                entry.sourceTiers = mergeSourceTierArrays(entry.sourceTiers || [], [
                    item.sourceTier || '',
                    ...(item.sourceTiers || []),
                    context.sourceTier || ''
                ]);
                entry.sourceTier = preferHigherSourceTier(
                    entry.sourceTier || '',
                    item.sourceTier || context.sourceTier || ''
                );
                entry.discoveryMethods = mergeStringArrays(entry.discoveryMethods, [context.discoveryMethod || 'collector'], 6);
                entry.discoveryEdges = mergeDiscoveryEdges(entry.discoveryEdges || [], item.discoveryEdges || []);
                entry.seedTargets = mergeStringArrays(entry.seedTargets, [context.seedTarget || collectState.domain || ''], 6);
                entry.discoveredFromUrls = mergeStringArrays(entry.discoveredFromUrls, [context.discoveredFromUrl || ''], 6);
                entry.sampleUrls = mergeStringArrays(entry.sampleUrls, [item.url || ''], 6);
                if (item.sourceType === 'ref-domain' || entry.sourceTypes.includes('ref-domain')) {
                    entry.domainSeedCount = (entry.domainSeedCount || 0) + 1;
                }
                if (item.sourceType === 'backlink-page' || entry.sourceTypes.includes('backlink-page')) {
                    entry.pageSeedCount = (entry.pageSeedCount || 0) + 1;
                }
                if (context.commentMention) {
                    entry.commentMentions = (entry.commentMentions || 0) + 1;
                }
                if (shouldQueueDomainForRecursiveCollection(context)) {
                    markEntryCrawlPending(entry, context);
                }
            }

            recalculateDomainIntelScores();
            await flush();
        }

        async function recordDomainPublishEvidence(url, status, publishMeta = {}) {
            const domain = getDomain(url);
            if (!domain) return;

            await ensureLoaded();
            const entry = ensureDomainFrontierEntry(domain);
            entry.sourceTiers = mergeSourceTierArrays(entry.sourceTiers || [], [
                status === 'published' ? SOURCE_TIERS.HISTORICAL_SUCCESS : ''
            ]);
            entry.sourceTier = preferHigherSourceTier(entry.sourceTier || '', status === 'published' ? SOURCE_TIERS.HISTORICAL_SUCCESS : '');

            if (status === 'published') {
                entry.lastPublishedAt = publishMeta.updatedAt || new Date().toISOString();
                entry.publishSuccessCount = Number(entry.publishSuccessCount || 0) + 1;
                if (publishMeta.anchorVisible) {
                    entry.verifiedAnchorCount = Number(entry.verifiedAnchorCount || 0) + 1;
                }
                entry.discoveryEdges = mergeDiscoveryEdges(entry.discoveryEdges || [], [
                    buildDiscoveryEdge(SOURCE_TIERS.HISTORICAL_SUCCESS, 'publish-success', url)
                ]);
            }

            if (publishMeta.submissionBlocked) {
                entry.blockedPublishCount = Number(entry.blockedPublishCount || 0) + 1;
            }

            // Update domain archive from publish evidence
            const profile = cache.profiles[domain] || {};
            if (status === 'published') {
                profile.verifiedPublishable = true;
                profile.lastVerifiedAt = new Date().toISOString();
                profile.publishSuccessCount = Number(profile.publishSuccessCount || 0) + 1;
                if (publishMeta.formSignature) {
                    profile.formSignature = publishMeta.formSignature;
                }
                if (publishMeta.cms) {
                    profile.cms = publishMeta.cms;
                }
                if (publishMeta.formFields) {
                    profile.formFields = publishMeta.formFields;
                }
                profile.lastPublishFailureReason = '';
            } else if (status === 'failed' || publishMeta.submissionBlocked) {
                profile.publishFailureCount = Number(profile.publishFailureCount || 0) + 1;
                const reason = publishMeta.terminalFailureReason
                    || publishMeta.failureReason || '';
                if (reason) {
                    profile.lastPublishFailureReason = reason;
                }
                if (publishMeta.hasCaptcha) {
                    profile.hasCaptcha = true;
                    profile.captchaType = publishMeta.captchaType || 'unknown';
                }
                if (publishMeta.requiresLogin) {
                    profile.requiresLogin = true;
                }
            }
            cache.profiles[domain] = profile;

            recalculateDomainIntelScores();
            await flush();
        }

        // ── domain archive (verification) ─────────────────────────

        async function recordDomainVerification(url, verificationResult = {}) {
            const domain = getDomain(url);
            if (!domain) return;

            await ensureLoaded();
            const entry = ensureDomainFrontierEntry(domain);
            const profile = cache.profiles[domain] || {};
            const now = new Date().toISOString();

            const signals = verificationResult.quickSignals || {};

            // Store verification result into domain profile
            profile.lastVerifiedAt = now;
            profile.verificationStatus = signals.hasCommentForm
                ? (signals.hasCaptcha ? 'captcha' : (signals.requiresLogin ? 'login_required' : (signals.commentsClosed ? 'closed' : 'verified_ready')))
                : 'no_form';

            if (signals.cms) profile.cms = signals.cms;
            if (signals.captchaType) profile.captchaType = signals.captchaType;
            if (signals.hasCaptcha) profile.hasCaptcha = true;
            if (signals.requiresLogin) profile.requiresLogin = true;
            if (signals.commentsClosed) profile.commentsClosed = true;
            if (signals.formSignature) profile.formSignature = signals.formSignature;
            if (signals.hasUrlField) profile.hasUrlField = true;
            if (signals.hasRichEditor) profile.hasRichEditor = true;

            // Store form field mapping for reuse across same-domain URLs
            if (Array.isArray(verificationResult.formSummary)) {
                const commentForm = verificationResult.formSummary.find(
                    (f) => f.hasTextarea && f.hasSubmit
                );
                if (commentForm) {
                    profile.formFields = commentForm.fields || [];
                    profile.formAction = commentForm.action || '';
                    profile.verifiedPublishable = profile.verificationStatus === 'verified_ready';
                }
            }

            profile.verificationCount = Number(profile.verificationCount || 0) + 1;

            cache.profiles[domain] = profile;
            entry.profileUpdatedAt = now;
            entry.status = mergeDomainStatus(entry.status, 'profiled');

            recalculateDomainIntelScores();
            await flush();
        }

        function getDomainVerificationStatus(domain) {
            if (!domain || !loaded) return null;
            const profile = cache.profiles[domain];
            if (!profile || !profile.lastVerifiedAt) return null;
            return {
                status: profile.verificationStatus || null,
                cms: profile.cms || null,
                hasCaptcha: !!profile.hasCaptcha,
                captchaType: profile.captchaType || null,
                requiresLogin: !!profile.requiresLogin,
                commentsClosed: !!profile.commentsClosed,
                formSignature: profile.formSignature || null,
                hasUrlField: !!profile.hasUrlField,
                hasRichEditor: !!profile.hasRichEditor,
                formFields: profile.formFields || null,
                verifiedPublishable: !!profile.verifiedPublishable,
                lastVerifiedAt: profile.lastVerifiedAt || '',
                publishSuccessCount: Number(profile.publishSuccessCount || 0),
                publishFailureCount: Number(profile.publishFailureCount || 0)
            };
        }

        function shouldSkipVerification(domain) {
            if (!domain || !loaded) return false;
            const profile = cache.profiles[domain];
            if (!profile || !profile.lastVerifiedAt) return false;

            // If domain was verified within last 7 days, reuse the result
            const verifiedAt = new Date(profile.lastVerifiedAt).getTime();
            const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
            if (verifiedAt < sevenDaysAgo) return false;

            // Always re-verify if we have no clear status
            if (!profile.verificationStatus) return false;

            return true;
        }

        function getDomainFormTemplate(domain) {
            if (!domain || !loaded) return null;
            const profile = cache.profiles[domain];
            if (!profile || !profile.verifiedPublishable) return null;
            if (!profile.formFields || !Array.isArray(profile.formFields)) return null;
            return {
                cms: profile.cms || null,
                formSignature: profile.formSignature || null,
                formFields: profile.formFields,
                formAction: profile.formAction || '',
                hasUrlField: !!profile.hasUrlField,
                hasRichEditor: !!profile.hasRichEditor
            };
        }

        async function recordDomainDrilldown(seed, finalUrl, html, pages = []) {
            const domain = seed?.domain || getDomain(seed?.url || finalUrl);
            if (!domain) return;

            await ensureLoaded();
            const entry = ensureDomainFrontierEntry(domain);
            const profile = buildDomainProfileFromHtml(finalUrl, html, {
                sampleUrls: pages
            });
            const existingProfile = cache.profiles[domain] || {};

            cache.profiles[domain] = {
                ...existingProfile,
                ...profile,
                trafficLabel: existingProfile.trafficLabel || profile.trafficLabel || '',
                pageSamples: mergeStringArrays(existingProfile.pageSamples || [], pages, 8)
            };

            entry.status = mergeDomainStatus(entry.status, pages.length > 0 ? 'expanded' : 'profiled');
            entry.lastExpandedAt = new Date().toISOString();
            entry.profileUpdatedAt = new Date().toISOString();
            entry.drilldownPages = Math.max(entry.drilldownPages || 0, pages.length);
            entry.sampleUrls = mergeStringArrays(entry.sampleUrls, [finalUrl, ...pages], 8);
            entry.discoveryMethods = mergeStringArrays(entry.discoveryMethods, ['domain-drilldown'], 6);

            recalculateDomainIntelScores();
            await flush();
        }

        async function enrichDomainProfileFromPage(url, html, ruleResult = null) {
            const domain = getDomain(url);
            if (!domain) return;

            await ensureLoaded();
            const entry = ensureDomainFrontierEntry(domain);
            const existingProfile = cache.profiles[domain] || {};
            const profilePatch = buildDomainProfileFromHtml(url, html, {
                sampleUrls: [url],
                trafficLabel: existingProfile.trafficLabel || ''
            });

            const nextProfile = {
                ...existingProfile,
                ...profilePatch,
                pageSamples: mergeStringArrays(existingProfile.pageSamples || [], [url], 8)
            };
            if (ruleResult?.opportunities?.includes('comment')) {
                nextProfile.commentCapable = true;
                entry.commentOpportunityCount = (entry.commentOpportunityCount || 0) + 1;
            }

            cache.profiles[domain] = nextProfile;
            entry.profileUpdatedAt = new Date().toISOString();
            entry.status = mergeDomainStatus(entry.status, 'profiled');
            entry.sampleUrls = mergeStringArrays(entry.sampleUrls, [url], 8);

            recalculateDomainIntelScores();
            await flush();
        }

        // ── scoring / views ─────────────────────────────────────

        function recalculateDomainIntelScores() {
            for (const entry of cache.frontier) {
                const profile = cache.profiles[entry.domain] || {};
                entry.qualityScore = calculateDomainQualityScore(entry, profile);
            }
        }

        async function getDomainIntelView() {
            await ensureLoaded();
            const items = [...cache.frontier]
                .map((entry) => ({
                    ...entry,
                    profile: cache.profiles[entry.domain] || {}
                }))
                .sort((a, b) => (b.qualityScore || 0) - (a.qualityScore || 0) || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));

            const stats = {
                total: items.length,
                profiled: items.filter((item) => item.profile?.profiledAt).length,
                expanded: items.filter((item) => item.status === 'expanded').length,
                commentDiscovered: items.filter((item) => (item.commentMentions || 0) > 0).length
            };

            return { items, stats };
        }

        // ── public API ──────────────────────────────────────────

        return {
            ensureLoaded,
            flush,
            getCache: () => cache,
            setCache: (c) => { cache = c; loaded = !!c; },
            resetCache: () => { cache = { frontier: [], profiles: {} }; loaded = false; },
            ensureFrontierEntry: (domain) => ensureDomainFrontierEntry(domain),
            recordIntel: async (items, ctx) => recordDomainIntel(items, ctx),
            recordPublishEvidence: async (url, status, meta) => recordDomainPublishEvidence(url, status, meta),
            recordDrilldown: async (seed, finalUrl, html, pages) => recordDomainDrilldown(seed, finalUrl, html, pages),
            enrichProfile: async (url, html, ruleResult) => enrichDomainProfileFromPage(url, html, ruleResult),
            recalculateScores: () => recalculateDomainIntelScores(),
            getView: async () => getDomainIntelView(),
            // domain archive (verification & reuse)
            recordVerification: async (url, result) => recordDomainVerification(url, result),
            getVerificationStatus: (domain) => getDomainVerificationStatus(domain),
            shouldSkipVerification: (domain) => shouldSkipVerification(domain),
            getFormTemplate: (domain) => getDomainFormTemplate(domain),
            // low-level helpers needed by background.js
            createEntry: (d) => createDomainFrontierEntry(d),
            mergeStatus: (c, n) => mergeDomainStatus(c, n),
            shouldQueueForRecursive: (ctx) => shouldQueueDomainForRecursiveCollection(ctx),
            markCrawlState: async (domain, patch) => markDomainCrawlState(domain, patch),
            getNextPending: () => getNextPendingFrontierDomain(),
            markEntryCrawlPending: (entry, ctx) => markEntryCrawlPending(entry, ctx),
            getContextRecursiveDepth: (ctx) => getContextRecursiveDepth(ctx)
        };
    }
};

self.DomainIntel = DomainIntel;
