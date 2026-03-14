(function (globalScope) {
    const DB_NAME = 'backlink-analyzer-local';
    const DB_VERSION = 2;
    const STORE_KV = 'kv';
    const KEY_RESOURCES = 'resources';
    const KEY_DOMAIN_INTEL = 'domain-intel';
    const KEY_PUBLISH_TASKS = 'publish-tasks';
    const KEY_PUBLISH_SESSIONS = 'publish-sessions';
    const KEY_LOGS = 'logs';
    const KEY_SETTINGS = 'settings';
    const KEY_COLLECT_SNAPSHOT = 'collect-snapshot';
    const KEY_DOMAIN_PUBLISH_POLICIES = 'domain-publish-policies';
    const KEY_AI_USAGE_STATS = 'ai-usage-stats';
    const KEY_SITE_TEMPLATES = 'site-templates';
    const KEY_PUBLISH_ATTEMPTS = 'publish-attempts';

    let dbPromise = null;

    function getIndexedDb() {
        if (typeof indexedDB === 'undefined') {
            throw new Error('IndexedDB is not available in this context');
        }
        return indexedDB;
    }

    function requestToPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
        });
    }

    function openDb() {
        if (dbPromise) return dbPromise;

        dbPromise = new Promise((resolve, reject) => {
            const request = getIndexedDb().open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_KV)) {
                    db.createObjectStore(STORE_KV, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB'));
        });

        return dbPromise;
    }

    async function getValue(key, fallbackValue) {
        const db = await openDb();
        const tx = db.transaction(STORE_KV, 'readonly');
        const store = tx.objectStore(STORE_KV);
        const result = await requestToPromise(store.get(key));
        return result?.value !== undefined ? result.value : fallbackValue;
    }

    async function setValue(key, value) {
        const db = await openDb();
        const tx = db.transaction(STORE_KV, 'readwrite');
        const store = tx.objectStore(STORE_KV);
        await requestToPromise(store.put({ key, value, updatedAt: new Date().toISOString() }));
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
            tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        });
    }

    async function deleteValue(key) {
        const db = await openDb();
        const tx = db.transaction(STORE_KV, 'readwrite');
        const store = tx.objectStore(STORE_KV);
        await requestToPromise(store.delete(key));
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
            tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        });
    }

    async function clearAll() {
        const db = await openDb();
        const tx = db.transaction(STORE_KV, 'readwrite');
        const store = tx.objectStore(STORE_KV);
        await requestToPromise(store.clear());
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
            tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
        });
    }

    async function getResources() {
        const value = await getValue(KEY_RESOURCES, []);
        return Array.isArray(value) ? value : [];
    }

    async function setResources(resources) {
        await setValue(KEY_RESOURCES, Array.isArray(resources) ? resources : []);
    }

    async function loadDomainIntel() {
        const value = await getValue(KEY_DOMAIN_INTEL, { frontier: [], profiles: {} });
        return {
            frontier: Array.isArray(value?.frontier) ? value.frontier : [],
            profiles: value?.profiles && typeof value.profiles === 'object' ? value.profiles : {}
        };
    }

    async function saveDomainIntel(frontier, profiles) {
        await setValue(KEY_DOMAIN_INTEL, {
            frontier: Array.isArray(frontier) ? frontier : [],
            profiles: profiles && typeof profiles === 'object' ? profiles : {}
        });
    }

    async function getPublishTasks() {
        const value = await getValue(KEY_PUBLISH_TASKS, []);
        return Array.isArray(value) ? value : [];
    }

    async function setPublishTasks(tasks) {
        await setValue(KEY_PUBLISH_TASKS, Array.isArray(tasks) ? tasks : []);
    }

    async function getPublishSessions() {
        const value = await getValue(KEY_PUBLISH_SESSIONS, {});
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    async function setPublishSessions(sessions) {
        await setValue(
            KEY_PUBLISH_SESSIONS,
            sessions && typeof sessions === 'object' && !Array.isArray(sessions) ? sessions : {}
        );
    }

    async function getLogs() {
        const value = await getValue(KEY_LOGS, []);
        return Array.isArray(value) ? value : [];
    }

    async function setLogs(logs) {
        await setValue(KEY_LOGS, Array.isArray(logs) ? logs : []);
    }

    async function getSettings() {
        const value = await getValue(KEY_SETTINGS, {});
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    async function setSettings(settings) {
        await setValue(KEY_SETTINGS, settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {});
    }

    async function getCollectSnapshot() {
        const value = await getValue(KEY_COLLECT_SNAPSHOT, { collectState: null, collectStats: null });
        return {
            collectState: value?.collectState && typeof value.collectState === 'object' ? value.collectState : null,
            collectStats: value?.collectStats && typeof value.collectStats === 'object' ? value.collectStats : null
        };
    }

    async function setCollectSnapshot(collectState, collectStats) {
        await setValue(KEY_COLLECT_SNAPSHOT, {
            collectState: collectState && typeof collectState === 'object' ? collectState : null,
            collectStats: collectStats && typeof collectStats === 'object' ? collectStats : null
        });
    }

    async function getDomainPublishPolicies() {
        const value = await getValue(KEY_DOMAIN_PUBLISH_POLICIES, {});
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    async function setDomainPublishPolicies(policies) {
        await setValue(
            KEY_DOMAIN_PUBLISH_POLICIES,
            policies && typeof policies === 'object' && !Array.isArray(policies) ? policies : {}
        );
    }

    async function getAIUsageStats() {
        const value = await getValue(KEY_AI_USAGE_STATS, null);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }

    async function setAIUsageStats(stats) {
        if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
            await deleteValue(KEY_AI_USAGE_STATS);
            return;
        }
        await setValue(KEY_AI_USAGE_STATS, stats);
    }

    async function getSiteTemplates() {
        const value = await getValue(KEY_SITE_TEMPLATES, {});
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    async function setSiteTemplates(templates) {
        await setValue(
            KEY_SITE_TEMPLATES,
            templates && typeof templates === 'object' && !Array.isArray(templates) ? templates : {}
        );
    }

    async function getPublishAttempts() {
        const value = await getValue(KEY_PUBLISH_ATTEMPTS, []);
        return Array.isArray(value) ? value : [];
    }

    async function setPublishAttempts(attempts) {
        await setValue(KEY_PUBLISH_ATTEMPTS, Array.isArray(attempts) ? attempts : []);
    }

    async function migrateFromChromeStorage(options = {}) {
        if (!globalScope.chrome?.storage?.local) return;

        const { clearLegacy = false } = options;
        const legacy = await globalScope.chrome.storage.local.get([
            'resources',
            'domainFrontier',
            'domainProfiles',
            'publishTasks',
            'publishSessions',
            'publishState',
            'logs',
            'settings',
            'collectState',
            'collectStats',
            'domainPublishPolicies',
            'aiUsageStats',
            'siteTemplates',
            'publishAttempts'
        ]);
        const legacyResources = Array.isArray(legacy.resources) ? legacy.resources : [];
        const legacyFrontier = Array.isArray(legacy.domainFrontier) ? legacy.domainFrontier : [];
        const legacyProfiles = legacy.domainProfiles && typeof legacy.domainProfiles === 'object' ? legacy.domainProfiles : {};
        const legacyTasks = Array.isArray(legacy.publishTasks) ? legacy.publishTasks : [];
        const legacySessions = legacy.publishSessions && typeof legacy.publishSessions === 'object'
            ? legacy.publishSessions
            : {};
        const legacyLogs = Array.isArray(legacy.logs) ? legacy.logs : [];
        const legacySettings = legacy.settings && typeof legacy.settings === 'object' ? legacy.settings : {};
        const legacyCollectState = legacy.collectState && typeof legacy.collectState === 'object' ? legacy.collectState : null;
        const legacyCollectStats = legacy.collectStats && typeof legacy.collectStats === 'object' ? legacy.collectStats : null;
        const legacyDomainPublishPolicies = legacy.domainPublishPolicies && typeof legacy.domainPublishPolicies === 'object'
            ? legacy.domainPublishPolicies
            : {};
        const legacyAIUsageStats = legacy.aiUsageStats && typeof legacy.aiUsageStats === 'object' ? legacy.aiUsageStats : null;
        const legacySiteTemplates = legacy.siteTemplates && typeof legacy.siteTemplates === 'object' ? legacy.siteTemplates : {};
        const legacyPublishAttempts = Array.isArray(legacy.publishAttempts) ? legacy.publishAttempts : [];

        const currentResources = await getResources();
        if (legacyResources.length > currentResources.length) {
            await setResources(legacyResources);
        }

        const currentDomainIntel = await loadDomainIntel();
        const currentProfileCount = Object.keys(currentDomainIntel.profiles || {}).length;
        const legacyProfileCount = Object.keys(legacyProfiles || {}).length;
        if (
            legacyFrontier.length > (currentDomainIntel.frontier || []).length
            || legacyProfileCount > currentProfileCount
        ) {
            await saveDomainIntel(legacyFrontier, legacyProfiles);
        }

        const currentTasks = await getPublishTasks();
        if (legacyTasks.length > currentTasks.length) {
            await setPublishTasks(legacyTasks);
        }

        const currentSessions = await getPublishSessions();
        const currentSessionCount = Object.keys(currentSessions || {}).length;
        let mergedLegacySessions = legacySessions;
        const legacyPublishState = legacy.publishState && typeof legacy.publishState === 'object'
            ? legacy.publishState
            : null;
        if (
            legacyPublishState?.currentTask?.id
            && !Object.prototype.hasOwnProperty.call(mergedLegacySessions, legacyPublishState.currentTask.id)
        ) {
            mergedLegacySessions = {
                ...mergedLegacySessions,
                [legacyPublishState.currentTask.id]: legacyPublishState
            };
        }
        if (Object.keys(mergedLegacySessions).length > currentSessionCount) {
            await setPublishSessions(mergedLegacySessions);
        }

        const currentLogs = await getLogs();
        if (legacyLogs.length > currentLogs.length) {
            await setLogs(legacyLogs);
        }

        const currentSettings = await getSettings();
        if (Object.keys(legacySettings).length > Object.keys(currentSettings || {}).length) {
            await setSettings(legacySettings);
        }

        const currentCollectSnapshot = await getCollectSnapshot();
        const currentCollectStateKeys = Object.keys(currentCollectSnapshot.collectState || {}).length;
        const currentCollectStatsKeys = Object.keys(currentCollectSnapshot.collectStats || {}).length;
        if (
            Object.keys(legacyCollectState || {}).length > currentCollectStateKeys
            || Object.keys(legacyCollectStats || {}).length > currentCollectStatsKeys
        ) {
            await setCollectSnapshot(legacyCollectState, legacyCollectStats);
        }

        const currentPolicies = await getDomainPublishPolicies();
        if (Object.keys(legacyDomainPublishPolicies).length > Object.keys(currentPolicies || {}).length) {
            await setDomainPublishPolicies(legacyDomainPublishPolicies);
        }

        const currentAIUsageStats = await getAIUsageStats();
        if (
            legacyAIUsageStats
            && Object.keys(legacyAIUsageStats).length > Object.keys(currentAIUsageStats || {}).length
        ) {
            await setAIUsageStats(legacyAIUsageStats);
        }

        const currentSiteTemplates = await getSiteTemplates();
        if (Object.keys(legacySiteTemplates).length > Object.keys(currentSiteTemplates || {}).length) {
            await setSiteTemplates(legacySiteTemplates);
        }

        const currentPublishAttempts = await getPublishAttempts();
        if (legacyPublishAttempts.length > currentPublishAttempts.length) {
            await setPublishAttempts(legacyPublishAttempts);
        }

        if (clearLegacy) {
            await globalScope.chrome.storage.local.remove([
                'resources',
                'domainFrontier',
                'domainProfiles',
                'publishTasks',
                'publishSessions',
                'publishState',
                'logs',
                'settings',
                'collectState',
                'collectStats',
                'domainPublishPolicies',
                'aiUsageStats',
                'siteTemplates',
                'publishAttempts'
            ]);
        }
    }

    const LocalDB = {
        open: openDb,
        getValue,
        setValue,
        deleteValue,
        clearAll,
        getResources,
        setResources,
        loadDomainIntel,
        saveDomainIntel,
        getPublishTasks,
        setPublishTasks,
        getPublishSessions,
        setPublishSessions,
        getLogs,
        setLogs,
        getSettings,
        setSettings,
        getCollectSnapshot,
        setCollectSnapshot,
        getDomainPublishPolicies,
        setDomainPublishPolicies,
        getAIUsageStats,
        setAIUsageStats,
        getSiteTemplates,
        setSiteTemplates,
        getPublishAttempts,
        setPublishAttempts,
        migrateFromChromeStorage
    };

    globalScope.LocalDB = LocalDB;
})(typeof self !== 'undefined' ? self : window);
