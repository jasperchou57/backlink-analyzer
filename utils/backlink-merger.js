/**
 * Backlink Merger - 三源数据合并、去重、Link Gap 计算
 */

const BacklinkMerger = {
    /**
     * 合并多个来源的外链数据
     * @param {Object} sourceData - { ahrefs: [...urls], semrush: [...urls], similarweb: [...urls] }
     * @returns {Array} 合并后的外链列表，每条包含 sources 数组
     */
    merge(sourceData) {
        const urlMap = new Map(); // normalizedUrl -> { url, sources }

        for (const [source, urls] of Object.entries(sourceData)) {
            if (!urls) continue;
            const sourceKey = source.charAt(0).toUpperCase(); // A, S, W

            for (const url of urls) {
                const normalized = normalizeUrl(url);
                if (!normalized || normalized === '/') continue;

                if (urlMap.has(normalized)) {
                    const entry = urlMap.get(normalized);
                    if (!entry.sources.includes(sourceKey)) {
                        entry.sources.push(sourceKey);
                    }
                } else {
                    urlMap.set(normalized, {
                        url: url,
                        normalizedUrl: normalized,
                        sources: [sourceKey],
                        domain: getDomainFromUrl(url)
                    });
                }
            }
        }

        return Array.from(urlMap.values());
    },

    /**
     * 计算 Link Gap: 竞争对手有但我没有的外链
     * @param {Array} competitorLinks - 竞争对手合并后的外链
     * @param {Array} myLinks - 我的外链列表 (URL 字符串数组)
     * @returns {Array} gap 外链列表
     */
    calculateGap(competitorLinks, myLinks) {
        const myNormalized = new Set(
            (myLinks || []).map(url => {
                const domain = getDomainFromUrl(url);
                return domain;
            }).filter(Boolean)
        );

        return competitorLinks.filter(link => {
            // 如果我在同一个域名上已经有外链了，就不算 gap
            return !myNormalized.has(link.domain);
        });
    },

    /**
     * 按来源覆盖度排序：三源都有的排前面
     */
    sortByCoverage(links) {
        return [...links].sort((a, b) => b.sources.length - a.sources.length);
    },

    /**
     * 统计信息
     */
    getStats(links) {
        const total = links.length;
        const bySourceCount = { 3: 0, 2: 0, 1: 0 };
        const bySources = { A: 0, S: 0, W: 0 };

        for (const link of links) {
            const count = Math.min(link.sources.length, 3);
            bySourceCount[count]++;
            for (const s of link.sources) {
                if (bySources[s] !== undefined) bySources[s]++;
            }
        }

        return { total, bySourceCount, bySources };
    }
};

// 需要 utils.js 中的 normalizeUrl 和 getDomainFromUrl
if (typeof window !== 'undefined') {
    window.BacklinkMerger = BacklinkMerger;
}
