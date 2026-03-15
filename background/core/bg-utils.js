/**
 * Background utilities - shared helpers for background service worker.
 * Loaded early via importScripts so all other modules can use these globals.
 */

function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeUrlBg(url) {
    if (!url) return '';
    try {
        let u = url.trim().toLowerCase();
        if (!u.startsWith('http')) u = 'https://' + u;
        const parsed = new URL(u);
        let path = parsed.pathname.replace(/\/+$/, '') || '/';
        return parsed.hostname.replace(/^www\./, '') + path;
    } catch { return url.trim().toLowerCase(); }
}

function normalizeHttpUrlBg(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function getDomainBg(url) {
    try {
        if (!url.startsWith('http')) url = 'https://' + url;
        return new URL(url).hostname.replace(/^www\./, '');
    } catch { return ''; }
}

function inferDefaultSourceType(source = '') {
    const baseSource = String(source || '').replace(/^my-/, '');
    if (baseSource === 'ahrefs') return 'backlink-page';
    return 'ref-domain';
}

function resolveCollectedSourceType(source = '', sourceType = 'ref-domain') {
    const baseSource = String(source || '').replace(/^my-/, '');
    if (baseSource === 'semrush') return 'ref-domain';
    return sourceType || inferDefaultSourceType(source);
}

function normalizeSourceUrl(url, sourceType = 'ref-domain') {
    try {
        const prepared = String(url || '').trim();
        if (!prepared) return '';
        const normalized = prepared.startsWith('http') ? prepared : `https://${prepared}`;
        const parsed = new URL(normalized);
        const hostname = parsed.hostname.replace(/^www\./, '').toLowerCase();
        if (!hostname) return '';

        if (sourceType === 'ref-domain') {
            return `https://${hostname}/`;
        }

        const path = parsed.pathname.replace(/\/+$/, '') || '/';
        const search = parsed.search || '';
        return `https://${hostname}${path}${search}`;
    } catch {
        return '';
    }
}

function resolveCandidateType(sourceTypes = []) {
    const typeSet = new Set(sourceTypes || []);
    if (typeSet.has('backlink-page') && typeSet.has('ref-domain')) {
        return 'hybrid';
    }
    if (typeSet.has('backlink-page')) {
        return 'backlink-page';
    }
    return 'ref-domain';
}

function getSourceCode(source = '') {
    const baseSource = String(source || '').replace(/^my-/, '');
    switch (baseSource) {
        case 'ahrefs':
            return 'A';
        case 'semrush':
            return 'M';
        case 'similarweb':
            return 'W';
        default:
            return baseSource ? baseSource.charAt(0).toUpperCase() : 'U';
    }
}

function getAnalysisSeedScore(link = {}) {
    const sourceSet = new Set(link.sources || []);
    let score = (sourceSet.size || 0) * 20;
    if (link.candidateType === 'backlink-page') score += 90;
    if (link.candidateType === 'hybrid') score += 100;
    if (link.candidateType === 'ref-domain') score += 30;
    if (sourceSet.has('A')) score += 35;
    if (sourceSet.has('M')) score += 20;
    if (sourceSet.has('W')) score += 15;
    score += getSourceTierScore(link.sourceTier || '');
    return score;
}

function getAnalysisTargetScore(link = {}) {
    let score = getAnalysisSeedScore(link);
    if (link.analysisStage === 'direct-page') score += 40;
    if (link.analysisStage === 'domain-drilldown') score += 25;
    if (link.analysisStage === 'domain-homepage') score -= 10;
    score += Math.min((link.discoveryEdges || []).length * 2, 10);
    return score;
}

function normalizeCollectedItems(items = [], urls = [], source = '') {
    const defaultSourceType = inferDefaultSourceType(source);
    const rawItems = Array.isArray(items) && items.length > 0
        ? items
        : (urls || []).map((url) => ({ url }));

    const seen = new Set();
    const normalized = [];

    for (const rawItem of rawItems) {
        const value = typeof rawItem === 'string' ? rawItem : rawItem?.url;
        if (!value) continue;
        const sourceType = resolveCollectedSourceType(source, rawItem?.sourceType || defaultSourceType);
        const normalizedUrl = normalizeSourceUrl(value, sourceType);
        if (!normalizedUrl) continue;
        const dedupeKey = `${normalizedUrl}@@${sourceType}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const sourceTier = SOURCE_TIERS.COMPETITOR_BACKLINK;
        normalized.push({
            url: normalizedUrl,
            sourceType,
            sourceTier,
            discoveryEdges: [
                buildDiscoveryEdge(
                    sourceTier,
                    'collector-backlink',
                    `${String(source || '').replace(/^my-/, '')}:${sourceType}`
                )
            ]
        });
    }

    return normalized;
}

function mergeCollectedItemList(existing = [], incoming = []) {
    const merged = [...(existing || [])];
    const seen = new Set(
        merged.map((item) => `${normalizeUrlBg(item.url)}@@${item.sourceType || 'ref-domain'}`)
    );

    for (const item of incoming || []) {
        const key = `${normalizeUrlBg(item.url)}@@${item.sourceType || 'ref-domain'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
    }

    return merged;
}

function mergeUrlList(existing = [], incoming = []) {
    const merged = [...(existing || [])];
    const seen = new Set(merged.map((value) => normalizeUrlBg(value)));
    for (const value of incoming || []) {
        const normalized = normalizeUrlBg(value);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        merged.push(value);
    }
    return merged;
}

function getBestTemplateHostScore(host = '', siteTemplates = {}) {
    if (!host) return 0;

    let bestScore = 0;
    for (const template of Object.values(siteTemplates || {})) {
        if ((template?.host || '') !== host) continue;
        const score =
            Number(template.successCount || 0) * 18
            + Number(template.verifiedCount || 0) * 7
            - Number(template.failureCount || 0) * 4
            - Number(template.reviewPendingCount || 0) * 3
            - Number(template.blockedCount || 0) * 6;
        if (score > bestScore) bestScore = score;
    }

    return bestScore;
}

function getResourcePublishRankingScore(resource = {}, task = {}, siteTemplates = {}) {
    const basePriority = self.ResourceRules?.getPublishCandidatePriority?.(resource, task) || 0;
    const resourcePool = getResourcePool(resource);
    const resourceClass = self.ResourceRules?.getResourceClass?.(resource) || resource.resourceClass || 'weak';
    const frictionLevel = self.ResourceRules?.getResourceFrictionLevel?.(resource) || resource.frictionLevel || 'high';
    const hasWebsiteField = !!self.ResourceRules?.resourceSupportsWebsiteField?.(resource);
    const hasInlineSubmitForm = !!self.ResourceRules?.resourceHasInlineSubmitForm?.(resource);
    const hasCaptcha = !!self.ResourceRules?.resourceHasCaptcha?.(resource);
    const hasUrlField = !!self.ResourceRules?.resourceHasUrlField?.(resource);
    const directPublishReady = !!self.ResourceRules?.isDirectPublishReady?.(resource);
    const effectiveTier = getEffectiveResourceSourceTier(resource);
    const host = getDomainBg(resource.url || '');
    const templateScore = getBestTemplateHostScore(host, siteTemplates);
    const publishedSuccessCount = getResourcePublishedSuccessCount(resource);
    const anchorVerifiedCount = getResourceAnchorVerifiedCount(resource);
    const discoveryEdgeCount = (resource.discoveryEdges || []).length;
    const sourceEvidence = resource.sourceEvidence || {};
    const taskHistoryEntry = getResourcePublishHistoryEntry(resource, getTaskPublishTarget(task));
    const failureRecovery = taskHistoryEntry?.lastStatus === 'failed'
        ? getPublishFailureRecoveryPolicy(taskHistoryEntry?.publishMeta || {}, taskHistoryEntry)
        : null;
    const blockedPenalty = Number(resource.publishMeta?.submissionBlocked ? 1 : 0)
        + Number(resource.publishMeta?.websiteFieldBlockedFirstComment ? 1 : 0);
    const reviewPenalty = Number(resource.publishMeta?.reviewPending ? 1 : 0);
    const recencyScore = Number(new Date(resource.publishedAt || resource.discoveredAt || 0).getTime() || 0) / 1e11;
    const classScoreMap = {
        'blog-comment': 2800,
        profile: 1900,
        'inline-comment': 1600,
        weak: 0
    };
    const frictionScoreMap = {
        low: 3800,
        medium: 1200,
        high: -2200
    };

    let score = basePriority * 1e6;
    if (resourcePool === RESOURCE_POOLS.MAIN) score += 5200;
    if (resourcePool === RESOURCE_POOLS.LEGACY) score -= 1200;
    if (resourcePool === RESOURCE_POOLS.QUARANTINE) score -= 18000;
    score += getSourceTierScore(effectiveTier) * 1e4;
    score += publishedSuccessCount * 3500;
    score += anchorVerifiedCount * 5200;
    score += Number(classScoreMap[resourceClass] || 0);
    score += Number(frictionScoreMap[frictionLevel] || 0);
    if (directPublishReady) score += 2600;
    if (hasWebsiteField) score += 2400;
    if (hasUrlField) score += 1100;
    if (hasInlineSubmitForm) score += 1700;
    if (hasCaptcha) score -= 2800;
    score += Math.min(templateScore, 80) * 120;
    score += Math.min(discoveryEdgeCount, 8) * 90;
    score += Number(sourceEvidence.commentObserved || 0) * 240;
    score += Number(sourceEvidence.competitorBacklink || 0) * 120;
    score -= blockedPenalty * 1800;
    score -= reviewPenalty * 750;
    if (failureRecovery?.retryable) {
        score -= 4200 + Math.min(Number(failureRecovery.failedAttempts || 0), 6) * 1200;
    } else if (taskHistoryEntry?.lastStatus === 'failed') {
        score -= 12000;
    }
    score += recencyScore;

    return Math.round(score);
}

function buildDurationSummary(values = []) {
    const durations = (values || [])
        .map((value) => Number(value || 0))
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((left, right) => left - right);
    if (durations.length === 0) {
        return { count: 0, p50: 0, p90: 0, avg: 0 };
    }

    const getPercentile = (ratio) => {
        const index = Math.min(durations.length - 1, Math.max(0, Math.ceil(durations.length * ratio) - 1));
        return Math.round(durations[index] || 0);
    };

    const avg = durations.reduce((total, value) => total + value, 0) / durations.length;
    return {
        count: durations.length,
        p50: getPercentile(0.5),
        p90: getPercentile(0.9),
        avg: Math.round(avg)
    };
}

/**
 * Namespace for utilities that depend on globals (SOURCE_TIERS, buildDiscoveryEdge, etc.)
 */
const BgUtils = {
    compactText,
    normalizeUrlBg,
    normalizeHttpUrlBg,
    getDomainBg,
    normalizeCollectedItems,
    mergeCollectedItemList,
    mergeUrlList,
    inferDefaultSourceType,
    resolveCollectedSourceType,
    normalizeSourceUrl,
    resolveCandidateType,
    getSourceCode,
    getAnalysisSeedScore,
    getAnalysisTargetScore,
    getBestTemplateHostScore,
    getResourcePublishRankingScore,
    buildDurationSummary
};
