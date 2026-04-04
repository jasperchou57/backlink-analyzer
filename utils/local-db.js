(function (globalScope) {
    const API_BASE = 'http://127.0.0.1:21891/api';

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

    // ─── 内部 HTTP 工具 ───

    async function apiGet(path) {
        try {
            const resp = await fetch(`${API_BASE}${path}`);
            return await resp.json();
        } catch (e) {
            console.error(`[LocalDB] GET ${path} failed:`, e.message);
            return null;
        }
    }

    async function apiPut(path, body) {
        try {
            const resp = await fetch(`${API_BASE}${path}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            return await resp.json();
        } catch (e) {
            console.error(`[LocalDB] PUT ${path} failed:`, e.message);
            return null;
        }
    }

    async function apiDelete(path) {
        try {
            const resp = await fetch(`${API_BASE}${path}`, { method: 'DELETE' });
            return await resp.json();
        } catch (e) {
            console.error(`[LocalDB] DELETE ${path} failed:`, e.message);
            return null;
        }
    }

    async function apiPost(path, body) {
        try {
            const resp = await fetch(`${API_BASE}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            return await resp.json();
        } catch (e) {
            console.error(`[LocalDB] POST ${path} failed:`, e.message);
            return null;
        }
    }

    // ─── 通用 KV 操作 ───

    async function getValue(key, fallbackValue) {
        const result = await apiGet(`/kv/${encodeURIComponent(key)}`);
        if (result && result.value !== null && result.value !== undefined) {
            return result.value;
        }
        return fallbackValue;
    }

    async function setValue(key, value) {
        await apiPut(`/kv/${encodeURIComponent(key)}`, { value });
    }

    async function deleteValue(key) {
        await apiDelete(`/kv/${encodeURIComponent(key)}`);
    }

    async function clearAll() {
        await apiPost('/kv/clear', {});
    }

    // ─── 业务接口（与原 IndexedDB 版完全一致）───

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
        // 迁移逻辑：从 chrome.storage.local 读取旧数据写入本地 SQLite
        if (!globalScope.chrome?.storage?.local) return;

        const { clearLegacy = false } = options;

        // 检查是否已迁移
        const migrationFlag = await getValue('_chrome_storage_migrated', false);
        if (migrationFlag) return;

        const legacy = await globalScope.chrome.storage.local.get([
            'resources', 'domainFrontier', 'domainProfiles',
            'publishTasks', 'publishSessions', 'publishState',
            'logs', 'settings', 'collectState', 'collectStats',
            'domainPublishPolicies', 'aiUsageStats', 'siteTemplates', 'publishAttempts'
        ]);

        const legacyResources = Array.isArray(legacy.resources) ? legacy.resources : [];
        const legacyFrontier = Array.isArray(legacy.domainFrontier) ? legacy.domainFrontier : [];
        const legacyProfiles = legacy.domainProfiles && typeof legacy.domainProfiles === 'object' ? legacy.domainProfiles : {};
        const legacyTasks = Array.isArray(legacy.publishTasks) ? legacy.publishTasks : [];
        const legacySessions = legacy.publishSessions && typeof legacy.publishSessions === 'object' ? legacy.publishSessions : {};
        const legacyLogs = Array.isArray(legacy.logs) ? legacy.logs : [];
        const legacySettings = legacy.settings && typeof legacy.settings === 'object' ? legacy.settings : {};
        const legacyCollectState = legacy.collectState && typeof legacy.collectState === 'object' ? legacy.collectState : null;
        const legacyCollectStats = legacy.collectStats && typeof legacy.collectStats === 'object' ? legacy.collectStats : null;
        const legacyPolicies = legacy.domainPublishPolicies && typeof legacy.domainPublishPolicies === 'object' ? legacy.domainPublishPolicies : {};
        const legacyAIStats = legacy.aiUsageStats && typeof legacy.aiUsageStats === 'object' ? legacy.aiUsageStats : null;
        const legacyTemplates = legacy.siteTemplates && typeof legacy.siteTemplates === 'object' ? legacy.siteTemplates : {};
        const legacyAttempts = Array.isArray(legacy.publishAttempts) ? legacy.publishAttempts : [];

        // 批量写入
        const entries = {};
        if (legacyResources.length > 0) entries[KEY_RESOURCES] = legacyResources;
        if (legacyFrontier.length > 0 || Object.keys(legacyProfiles).length > 0) {
            entries[KEY_DOMAIN_INTEL] = { frontier: legacyFrontier, profiles: legacyProfiles };
        }
        if (legacyTasks.length > 0) entries[KEY_PUBLISH_TASKS] = legacyTasks;
        if (Object.keys(legacySessions).length > 0) entries[KEY_PUBLISH_SESSIONS] = legacySessions;
        if (legacyLogs.length > 0) entries[KEY_LOGS] = legacyLogs;
        if (Object.keys(legacySettings).length > 0) entries[KEY_SETTINGS] = legacySettings;
        if (legacyCollectState || legacyCollectStats) {
            entries[KEY_COLLECT_SNAPSHOT] = { collectState: legacyCollectState, collectStats: legacyCollectStats };
        }
        if (Object.keys(legacyPolicies).length > 0) entries[KEY_DOMAIN_PUBLISH_POLICIES] = legacyPolicies;
        if (legacyAIStats) entries[KEY_AI_USAGE_STATS] = legacyAIStats;
        if (Object.keys(legacyTemplates).length > 0) entries[KEY_SITE_TEMPLATES] = legacyTemplates;
        if (legacyAttempts.length > 0) entries[KEY_PUBLISH_ATTEMPTS] = legacyAttempts;

        if (Object.keys(entries).length > 0) {
            await apiPost('/kv/batch-set', { entries });
            console.log(`[LocalDB] 迁移完成: ${Object.keys(entries).length} 项数据已写入本地数据库`);
        }

        // 标记已迁移
        await setValue('_chrome_storage_migrated', true);

        if (clearLegacy) {
            await globalScope.chrome.storage.local.remove([
                'resources', 'domainFrontier', 'domainProfiles',
                'publishTasks', 'publishSessions', 'publishState',
                'logs', 'settings', 'collectState', 'collectStats',
                'domainPublishPolicies', 'aiUsageStats', 'siteTemplates', 'publishAttempts'
            ]);
        }
    }

    const LocalDB = {
        open: () => Promise.resolve(), // 兼容原有调用
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
