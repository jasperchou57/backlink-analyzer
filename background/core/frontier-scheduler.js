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

    getNextPendingEntry(frontier = [], options = {}) {
        const seedDomain = options.seedDomain || '';
        const myDomain = options.myDomain || '';

        return [...frontier]
            .filter((entry) => {
                if (!entry?.domain) return false;
                if (entry.domain === seedDomain || entry.domain === myDomain) return false;
                return (entry.crawlStatus || 'pending') === 'pending';
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
