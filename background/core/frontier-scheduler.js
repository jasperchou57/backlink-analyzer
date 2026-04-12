const FrontierScheduler = {
    createEntry(domain) {
        const now = new Date().toISOString();
        return {
            domain,
            status: 'discovered',
            crawlStatus: 'pending',
            firstSeenAt: now,
            lastSeenAt: now,
            sources: [],
            sourceTypes: [],
            sourceTier: '',
            sourceTiers: [],
            discoveryMethods: [],
            discoveryEdges: [],
            seedTargets: [],
            discoveredFromUrls: [],
            sampleUrls: [],
            seenCount: 0,
            commentMentions: 0,
            domainSeedCount: 0,
            pageSeedCount: 0,
            drilldownPages: 0,
            commentOpportunityCount: 0,
            publishSuccessCount: 0,
            blockedPublishCount: 0,
            verifiedAnchorCount: 0,
            crawlAttempts: 0,
            crawlDepth: 0,
            lastCollectedAt: '',
            lastExpandedAt: '',
            lastPublishedAt: '',
            profileUpdatedAt: '',
            qualityScore: 0
        };
    },

    mergeStatus(current = 'discovered', next = 'discovered') {
        const order = {
            discovered: 1,
            queued: 2,
            profiled: 3,
            expanded: 4
        };
        return (order[next] || 0) > (order[current] || 0) ? next : current;
    },

    shouldQueueForRecursiveCollection(context = {}) {
        const method = String(context.discoveryMethod || '');
        return [
            'collector-merge',
            'recursive-collector-merge',
            'commenter-domain',
            'recursive-discovery'
        ].includes(method);
    },

    markEntryCrawlPending(entry, context = {}, options = {}) {
        if (!entry) return;

        const seedDomain = options.seedDomain || '';
        const myDomain = options.myDomain || '';
        if (entry.domain === seedDomain || entry.domain === myDomain) {
            entry.crawlStatus = 'completed';
            return;
        }

        if (entry.crawlStatus === 'processing') return;
        if (!entry.lastCollectedAt || entry.crawlStatus !== 'completed') {
            entry.crawlStatus = 'pending';
        }
        const depth = Number.isFinite(context.recursiveDepth) ? Number(context.recursiveDepth) : 0;
        entry.crawlDepth = Math.max(entry.crawlDepth || 0, depth);
    },

    /**
     * 判断域名是否因连续失败而应被跳过
     * 条件：blockedPublishCount >= 3 且 publishSuccessCount == 0 且已经分析过足够多次
     */
    shouldSkipDomain(entry) {
        if (!entry) return false;
        const blocked = Number(entry.blockedPublishCount || 0);
        const success = Number(entry.publishSuccessCount || 0);
        const analyzed = Number(entry.commentOpportunityCount || 0) + blocked;

        // 至少有 3 次失败记录，且从未成功过，且已分析过至少 3 次
        if (blocked >= 3 && success === 0 && analyzed >= 3) return true;

        return false;
    },

    /**
     * 不值得递归分析的域名（.edu/.gov/社交媒体等）
     */
    isUnwantedDomain(domain) {
        if (!domain) return true;
        if (/\.(edu|gov|mil)$/i.test(domain)) return true;
        if (/^(facebook|twitter|x|instagram|linkedin|youtube|tiktok|pinterest|reddit|medium|tumblr|flickr|vimeo|t\.co|gravatar|wordpress\.com|blogger\.com)\./i.test(domain)) return true;
        return false;
    },

    getNextPendingEntry(frontier = [], options = {}) {
        const seedDomain = options.seedDomain || '';
        const myDomain = options.myDomain || '';

        return [...frontier]
            .filter((entry) => {
                if (!entry?.domain) return false;
                if (entry.domain === seedDomain || entry.domain === myDomain) return false;
                if ((entry.crawlStatus || 'pending') !== 'pending') return false;
                // 跳过不值得分析的域名
                if (this.isUnwantedDomain(entry.domain)) return false;
                // 跳过连续失败的域名
                if (this.shouldSkipDomain(entry)) return false;
                return true;
            })
            .sort((a, b) => {
                const depthDiff = (a.crawlDepth || 0) - (b.crawlDepth || 0);
                if (depthDiff !== 0) return depthDiff;
                const scoreDiff = (b.qualityScore || 0) - (a.qualityScore || 0);
                if (scoreDiff !== 0) return scoreDiff;
                return String(a.lastSeenAt || '').localeCompare(String(b.lastSeenAt || ''));
            })[0] || null;
    }
};

self.FrontierScheduler = FrontierScheduler;
