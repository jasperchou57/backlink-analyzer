(function (globalScope) {
    if (globalScope.ResourcePoolUtils) return;

    const DEFAULT_POOLS = {
        MAIN: 'main',
        LEGACY: 'legacy',
        QUARANTINE: 'quarantine'
    };

    function create(config = {}) {
        const pools = {
            ...DEFAULT_POOLS,
            ...(config.pools || {})
        };
        const getSourceTierScore = typeof config.getSourceTierScore === 'function'
            ? config.getSourceTierScore
            : () => 0;
        const getDomainVerificationStatus = typeof config.getDomainVerificationStatus === 'function'
            ? config.getDomainVerificationStatus
            : () => null;
        const getResourcePublishedSuccessCount = typeof config.getResourcePublishedSuccessCount === 'function'
            ? config.getResourcePublishedSuccessCount
            : (resource = {}) => Object.values(resource.publishHistory || {}).reduce((total, entry) => {
                return total + Number(entry?.attempts?.published || 0);
            }, 0) + (resource.status === 'published' ? 1 : 0);
        const getResourceAnchorVerifiedCount = typeof config.getResourceAnchorVerifiedCount === 'function'
            ? config.getResourceAnchorVerifiedCount
            : (resource = {}) => {
                let count = resource.publishMeta?.anchorVisible ? 1 : 0;
                for (const entry of Object.values(resource.publishHistory || {})) {
                    if (entry?.publishMeta?.anchorVisible) count += 1;
                }
                return count;
            };

        function normalizePool(value = '') {
            const normalized = String(value || '').trim().toLowerCase();
            return Object.values(pools).includes(normalized) ? normalized : '';
        }

        function getRule(name, fallback = null) {
            const rules = config.resourceRules || globalScope.ResourceRules || {};
            return typeof rules[name] === 'function' ? rules[name] : fallback;
        }

        function getResourceClass(resource = {}) {
            return getRule('getResourceClass', () => String(resource.resourceClass || '').trim() || 'weak')(resource);
        }

        function getResourceFrictionLevel(resource = {}) {
            return getRule('getResourceFrictionLevel', () => String(resource.frictionLevel || '').trim() || 'high')(resource);
        }

        function getDirectPublishReady(resource = {}) {
            return !!getRule('isDirectPublishReady', () => !!resource.directPublishReady)(resource);
        }

        function getPublishPriority(resource = {}, task = {}) {
            return Number(getRule('getPublishCandidatePriority', () => 0)(resource, task) || 0);
        }

        function resourceIsCommentOnly(resource = {}) {
            return !!getRule('resourceIsCommentOnly', () => false)(resource);
        }

        function resourceHasCaptcha(resource = {}) {
            return !!getRule('resourceHasCaptcha', () => !!resource.hasCaptcha)(resource);
        }

        function resourceRequiresLogin(resource = {}) {
            return !!getRule('resourceRequiresLogin', () => false)(resource);
        }

        function resourceCommentsClosed(resource = {}) {
            return !!getRule('resourceCommentsClosed', () => false)(resource);
        }

        function resourceSupportsDirectLink(resource = {}) {
            return !!getRule('resourceSupportsDirectLink', () => false)(resource);
        }

        function resourceSupportsFormLikeLink(resource = {}) {
            return !!getRule('resourceSupportsFormLikeLink', () => false)(resource);
        }

        function isLowQualityCommentUrl(resource = {}) {
            return !!getRule('isLowQualityCommentUrl', () => false)(resource.url || '', resource.pageTitle || '');
        }

        function getEvidenceState(resource = {}) {
            const sourceEvidence = resource.sourceEvidence || {};
            const sourceTier = String(resource.sourceTier || resource.discoverySourceTier || '').trim().toLowerCase();
            const publishedSuccessCount = getResourcePublishedSuccessCount(resource);
            const anchorVerifiedCount = getResourceAnchorVerifiedCount(resource);
            const commentFieldVerified = !!resource.publishMeta?.commentFieldVerified;
            const sourceTierScore = Number(resource.sourceTierScore || getSourceTierScore(sourceTier) || 0);
            const verified = publishedSuccessCount > 0 || anchorVerifiedCount > 0 || commentFieldVerified;
            const sourceBacked =
                sourceTierScore >= 60
                || Number(sourceEvidence.historicalSuccess || 0) > 0
                || Number(sourceEvidence.commentObserved || 0) > 0
                || Number(sourceEvidence.competitorBacklink || 0) > 0;

            return {
                publishedSuccessCount,
                anchorVerifiedCount,
                commentFieldVerified,
                sourceTier,
                sourceTierScore,
                verified,
                sourceBacked
            };
        }

        function getDomainFromUrl(url = '') {
            try {
                return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./i, '').toLowerCase();
            } catch {
                return '';
            }
        }

        function classify(resource = {}) {
            const evidence = getEvidenceState(resource);
            const publishPriority = getPublishPriority(resource, {
                workflowId: 'blog-comment-backlink',
                commentStyle: 'anchor-prefer'
            });
            const resourceClass = getResourceClass(resource);
            const frictionLevel = getResourceFrictionLevel(resource);
            const directPublishReady = getDirectPublishReady(resource);
            const directCapability = resourceSupportsDirectLink(resource) || resourceSupportsFormLikeLink(resource) || directPublishReady;
            const commentOnly = resourceIsCommentOnly(resource);
            const captcha = resourceHasCaptcha(resource);
            const loginRequired = resourceRequiresLogin(resource);
            const commentsClosed = resourceCommentsClosed(resource);
            const lowQualityArchive = isLowQualityCommentUrl(resource);
            const highRiskBlocker = captcha || loginRequired || commentsClosed;
            const hasEvidence = evidence.verified || evidence.sourceBacked;
            const standardCommentCandidate = resourceClass === 'blog-comment' || resourceClass === 'inline-comment';

            // ── Submify-verified seeds: trust pre-assigned pool ───
            if (resource.submifySeed && resource.resourcePool && resource.resourcePoolReason) {
                return {
                    pool: resource.resourcePool,
                    reason: resource.resourcePoolReason
                };
            }

            // ── Domain-level verification reuse ───────────────────
            const domain = getDomainFromUrl(resource.url || '');
            const domainVerification = domain ? getDomainVerificationStatus(domain) : null;

            // If domain was verified as blocked, fast-track to quarantine
            if (domainVerification && !domainVerification.verifiedPublishable) {
                if (domainVerification.status === 'captcha' || domainVerification.status === 'login_required' || domainVerification.status === 'closed' || domainVerification.status === 'no_form') {
                    if (!evidence.verified) {
                        return {
                            pool: pools.QUARANTINE,
                            reason: `domain_verified_${domainVerification.status}`
                        };
                    }
                }
            }

            // If domain was verified as publishable, boost to main pool
            if (domainVerification && domainVerification.verifiedPublishable && !commentOnly && !lowQualityArchive) {
                if (publishPriority > 0 || directCapability || standardCommentCandidate) {
                    return {
                        pool: pools.MAIN,
                        reason: 'domain_verified_publishable'
                    };
                }
            }

            // ── Original classification logic ─────────────────────
            let pool = '';
            let reason = '';

            if (commentOnly) {
                pool = pools.QUARANTINE;
                reason = 'comment_only_form';
            } else if (lowQualityArchive) {
                pool = pools.QUARANTINE;
                reason = 'low_quality_archive';
            } else if ((resourceClass === 'weak' || publishPriority <= 0 || !directCapability) && !hasEvidence) {
                pool = pools.QUARANTINE;
                reason = 'weak_no_evidence';
            } else if (highRiskBlocker && !evidence.verified) {
                pool = pools.QUARANTINE;
                reason = 'blocked_publish_path';
            } else if (
                standardCommentCandidate
                && directPublishReady
                && frictionLevel === 'low'
                && publishPriority > 0
                && !highRiskBlocker
                && hasEvidence
            ) {
                pool = pools.MAIN;
                reason = evidence.verified ? 'verified_standard_comment' : 'high_evidence_low_friction';
            } else if (
                standardCommentCandidate
                && directPublishReady
                && frictionLevel === 'low'
                && publishPriority >= 4
                && !highRiskBlocker
            ) {
                pool = pools.MAIN;
                reason = 'standard_comment_fast_lane';
            } else if (publishPriority > 0 && directCapability && resourceClass !== 'weak') {
                pool = pools.LEGACY;
                reason = hasEvidence ? 'needs_manual_review' : 'legacy_candidate';
            } else if (evidence.verified) {
                pool = pools.LEGACY;
                reason = 'historical_but_not_main';
            } else {
                pool = pools.QUARANTINE;
                reason = 'no_publish_path';
            }

            return {
                pool,
                reason
            };
        }

        function apply(resource = {}) {
            const decision = classify(resource);
            return {
                ...resource,
                resourcePool: decision.pool,
                resourcePoolReason: decision.reason
            };
        }

        function getResourcePool(resource = {}) {
            return normalizePool(resource.resourcePool || '') || classify(resource).pool;
        }

        function countByPool(resources = []) {
            return (resources || []).reduce((counts, resource) => {
                const pool = getResourcePool(resource) || pools.LEGACY;
                counts[pool] = Number(counts[pool] || 0) + 1;
                return counts;
            }, {
                [pools.MAIN]: 0,
                [pools.LEGACY]: 0,
                [pools.QUARANTINE]: 0
            });
        }

        function selectDispatchResources(resources = []) {
            const counts = countByPool(resources);
            const mainResources = [];
            const legacyResources = [];
            const quarantineResources = [];

            for (const resource of resources || []) {
                const pool = getResourcePool(resource);
                if (pool === pools.MAIN) {
                    mainResources.push(resource);
                    continue;
                }
                if (pool === pools.LEGACY) {
                    legacyResources.push(resource);
                    continue;
                }
                quarantineResources.push(resource);
            }

            const activePool = mainResources.length > 0
                ? pools.MAIN
                : legacyResources.length > 0
                    ? pools.LEGACY
                    : '';

            return {
                activePool,
                resources: activePool === pools.MAIN
                    ? mainResources
                    : activePool === pools.LEGACY
                        ? legacyResources
                        : [],
                counts,
                quarantineResources
            };
        }

        return {
            pools,
            normalizePool,
            classify,
            apply,
            getResourcePool,
            countByPool,
            selectDispatchResources
        };
    }

    globalScope.ResourcePoolUtils = {
        DEFAULT_POOLS,
        create
    };
})(self);
