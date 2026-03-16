const DOMAIN_INTEL_STORAGE_STRATEGY = {
    FRONTIER_QUOTA_RETRY_LIMITS: [20000, 15000, 10000, 5000]
};

let localDomainIntelStoreReady = null;

async function ensureLocalDomainIntelStore() {
    if (typeof LocalDB === 'undefined') {
        return null;
    }

    if (!localDomainIntelStoreReady) {
        localDomainIntelStoreReady = (async () => {
            try {
                if (typeof LocalDB.migrateFromChromeStorage === 'function') {
                    await LocalDB.migrateFromChromeStorage({ clearLegacy: true });
                }
                return LocalDB;
            } catch (error) {
                console.warn('[BLA] LocalDB unavailable for domain intel, falling back to chrome.storage.local', error);
                return null;
            }
        })();
    }

    return await localDomainIntelStoreReady;
}

function trimStateText(value, max = 120) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function compactStateList(values = [], limit = 2, maxText = 80) {
    const next = [];
    for (const value of values || []) {
        const normalized = trimStateText(value, maxText);
        if (!normalized || next.includes(normalized)) continue;
        next.push(normalized);
        if (next.length >= limit) break;
    }
    return next;
}

function omitEmptyStateValues(obj = {}) {
    return Object.fromEntries(Object.entries(obj).filter(([, value]) => {
        if (value === undefined || value === null || value === '') return false;
        if (Array.isArray(value)) return value.length > 0;
        if (typeof value === 'object') return Object.keys(value).length > 0;
        return true;
    }));
}

function compactDomainFrontierEntry(entry = {}) {
    return omitEmptyStateValues({
        domain: trimStateText(entry.domain || '', 120),
        status: trimStateText(entry.status || 'discovered', 24),
        crawlStatus: trimStateText(entry.crawlStatus || 'pending', 24),
        lastSeenAt: entry.lastSeenAt || '',
        lastCollectedAt: entry.lastCollectedAt || '',
        lastExpandedAt: entry.lastExpandedAt || '',
        profileUpdatedAt: entry.profileUpdatedAt || '',
        sources: compactStateList(entry.sources || [], 3, 12),
        sourceTypes: compactStateList(entry.sourceTypes || [], 3, 24),
        sourceTier: trimStateText(entry.sourceTier || '', 32),
        sourceTiers: compactStateList(entry.sourceTiers || [], 4, 32),
        discoveryMethods: compactStateList(entry.discoveryMethods || [], 2, 32),
        discoveryEdges: compactStateList(entry.discoveryEdges || [], 4, 120),
        seedTargets: compactStateList(entry.seedTargets || [], 2, 48),
        discoveredFromUrls: compactStateList(entry.discoveredFromUrls || [], 3, 160),
        sampleUrls: compactStateList(entry.sampleUrls || [], 2, 160),
        seenCount: Number(entry.seenCount || 0),
        commentMentions: Number(entry.commentMentions || 0),
        domainSeedCount: Number(entry.domainSeedCount || 0),
        pageSeedCount: Number(entry.pageSeedCount || 0),
        drilldownPages: Number(entry.drilldownPages || 0),
        commentOpportunityCount: Number(entry.commentOpportunityCount || 0),
        publishSuccessCount: Number(entry.publishSuccessCount || 0),
        blockedPublishCount: Number(entry.blockedPublishCount || 0),
        verifiedAnchorCount: Number(entry.verifiedAnchorCount || 0),
        crawlAttempts: Number(entry.crawlAttempts || 0),
        crawlDepth: Number(entry.crawlDepth || 0),
        lastPublishedAt: entry.lastPublishedAt || '',
        qualityScore: Number(entry.qualityScore || 0)
    });
}

function compactDomainProfile(profile = {}) {
    return omitEmptyStateValues({
        title: trimStateText(profile.title || '', 140),
        language: trimStateText(profile.language || '', 16),
        cms: trimStateText(profile.cms || '', 24),
        siteType: trimStateText(profile.siteType || '', 24),
        topic: trimStateText(profile.topic || '', 24),
        trafficLabel: trimStateText(profile.trafficLabel || '', 32),
        commentCapable: profile.commentCapable ? true : undefined,
        profiledAt: profile.profiledAt || ''
    });
}

function getFrontierStoragePriority(entry = {}) {
    const recency = new Date(entry.lastSeenAt || entry.lastCollectedAt || 0).getTime() || 0;
    let score = recency;
    if (entry.crawlStatus === 'pending' || entry.crawlStatus === 'processing') score += 1e15;
    score += Number(entry.qualityScore || 0) * 1e10;
    score += Number(entry.commentOpportunityCount || 0) * 1e9;
    score += Number(entry.commentMentions || 0) * 1e8;
    return score;
}

function buildCompactedDomainIntel(frontier = [], profiles = {}, limit = Infinity) {
    const compactedFrontier = (frontier || [])
        .map((entry) => compactDomainFrontierEntry(entry))
        .filter((entry) => entry.domain)
        .sort((left, right) => getFrontierStoragePriority(right) - getFrontierStoragePriority(left))
        .slice(0, limit);
    const compactedProfiles = {};
    compactedFrontier.forEach((entry) => {
        if (profiles?.[entry.domain]) {
            compactedProfiles[entry.domain] = compactDomainProfile(profiles[entry.domain]);
        }
    });
    return {
        domainFrontier: compactedFrontier,
        domainProfiles: compactedProfiles
    };
}

const StateStore = {
    async get(keys) {
        return await chrome.storage.local.get(keys);
    },

    async set(patch) {
        await chrome.storage.local.set(patch);
    },

    async clearAll() {
        await chrome.storage.local.clear();
        const localStore = await ensureLocalDomainIntelStore();
        if (localStore?.clearAll) {
            await localStore.clearAll();
        }
    },

    async loadDomainIntel() {
        const localStore = await ensureLocalDomainIntelStore();
        if (localStore?.loadDomainIntel) {
            return await localStore.loadDomainIntel();
        }
        const data = await this.get(['domainFrontier', 'domainProfiles']);
        return {
            frontier: data.domainFrontier || [],
            profiles: data.domainProfiles || {}
        };
    },

    async saveDomainIntel(frontier, profiles) {
        const compacted = buildCompactedDomainIntel(frontier, profiles);
        try {
            const localStore = await ensureLocalDomainIntelStore();
            if (localStore?.saveDomainIntel) {
                await localStore.saveDomainIntel(compacted.domainFrontier, compacted.domainProfiles);
                try {
                    await chrome.storage.local.remove(['domainFrontier', 'domainProfiles']);
                } catch {}
            } else {
                await this.set(compacted);
            }
        } catch (error) {
            for (const limit of DOMAIN_INTEL_STORAGE_STRATEGY.FRONTIER_QUOTA_RETRY_LIMITS) {
                if ((compacted.domainFrontier || []).length <= limit) continue;
                try {
                    const retryPayload = buildCompactedDomainIntel(frontier, profiles, limit);
                    const localStore = await ensureLocalDomainIntelStore();
                    if (localStore?.saveDomainIntel) {
                        await localStore.saveDomainIntel(retryPayload.domainFrontier, retryPayload.domainProfiles);
                    } else {
                        await this.set(retryPayload);
                    }
                    console.warn(`[BLA] storage quota hit, compacted domain intel to ${limit} entries`);
                    return;
                } catch {}
            }
            throw error;
        }
    },

    async loadContinuousDiscoveryState(defaultState) {
        const data = await this.get(['continuousDiscoveryState']);
        return {
            ...(defaultState || {}),
            ...(data.continuousDiscoveryState || {})
        };
    },

    async saveContinuousDiscoveryState(state) {
        await this.set({ continuousDiscoveryState: state });
    },

    async loadMarketingAutomationState(defaultState) {
        const data = await this.get(['marketingAutomationState']);
        return {
            ...(defaultState || {}),
            ...(data.marketingAutomationState || {})
        };
    },

    async saveMarketingAutomationState(state) {
        await this.set({ marketingAutomationState: state });
    },

    async loadPublishState(defaultState) {
        const data = await this.get(['publishState']);
        return {
            ...(defaultState || {}),
            ...(data.publishState || {})
        };
    },

    async savePublishState(state) {
        await this.set({ publishState: state });
    },

    async loadPublishSessions(defaultSessions) {
        const localStore = await ensureLocalDomainIntelStore();
        if (localStore?.getPublishSessions) {
            const sessions = await localStore.getPublishSessions();
            if (sessions && typeof sessions === 'object' && !Array.isArray(sessions) && Object.keys(sessions).length > 0) {
                return {
                    ...(defaultSessions || {}),
                    ...sessions
                };
            }
        }

        const data = await this.get(['publishSessions', 'publishState']);
        if (data.publishSessions && typeof data.publishSessions === 'object') {
            return {
                ...(defaultSessions || {}),
                ...data.publishSessions
            };
        }

        const legacyState = data.publishState || null;
        if (legacyState?.currentTask?.id) {
            return {
                ...(defaultSessions || {}),
                [legacyState.currentTask.id]: legacyState
            };
        }

        return { ...(defaultSessions || {}) };
    },

    async savePublishSessions(sessions) {
        const localStore = await ensureLocalDomainIntelStore();
        if (localStore?.setPublishSessions) {
            await localStore.setPublishSessions(sessions);
            try {
                await chrome.storage.local.remove(['publishSessions', 'publishState']);
            } catch {}
            return;
        }

        await this.set({ publishSessions: sessions });
        await chrome.storage.local.remove('publishState');
    },

    async loadPublishBatchState(defaultState) {
        const data = await this.get(['publishBatchState']);
        return {
            ...(defaultState || {}),
            ...(data.publishBatchState || {})
        };
    },

    async savePublishBatchState(state) {
        await this.set({ publishBatchState: state });
    },

    async loadAutoPublishControlState(defaultState) {
        const data = await this.get(['autoPublishControlState']);
        return {
            ...(defaultState || {}),
            ...(data.autoPublishControlState || {})
        };
    },

    async saveAutoPublishControlState(state) {
        await this.set({ autoPublishControlState: state });
    },

    async loadCollectView(fallbackStats, fallbackCollecting) {
        const localStore = await ensureLocalDomainIntelStore();
        if (localStore?.getCollectSnapshot) {
            const snapshot = await localStore.getCollectSnapshot();
            if (snapshot.collectState || snapshot.collectStats) {
                return {
                    stats: snapshot.collectStats || fallbackStats,
                    isCollecting: snapshot.collectState?.isCollecting || fallbackCollecting
                };
            }
        }

        const data = await this.get(['collectState', 'collectStats']);
        return {
            stats: data.collectStats || fallbackStats,
            isCollecting: data.collectState?.isCollecting || fallbackCollecting
        };
    },

    async saveCollectSnapshot(snapshot) {
        const localStore = await ensureLocalDomainIntelStore();
        if (localStore?.setCollectSnapshot) {
            await localStore.setCollectSnapshot(snapshot.collectState, snapshot.collectStats);
            try {
                await chrome.storage.local.remove(['collectState', 'collectStats']);
            } catch {}
            return;
        }
        await this.set({
            collectState: snapshot.collectState,
            collectStats: snapshot.collectStats
        });
    }
};

self.StateStore = StateStore;
