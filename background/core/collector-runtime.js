const CollectorRuntime = {
    createInitialCollectState(domain, myDomain, sources, seededDomains = []) {
        return {
            isCollecting: true,
            domain,
            myDomain,
            sources,
            backlinks: { ahrefs: [], semrush: [], similarweb: [] },
            myBacklinks: [],
            stats: { backlinksFound: 0, targetsFound: 0, analyzed: 0, blogResources: 0, inQueue: 0 },
            discoveredDomains: new Set(seededDomains),
            discoveryQueue: [],
            processedDiscoveryDomains: new Set(seededDomains),
            discoveryDepth: 0,
            maxDiscoveryDepth: 3,
            maxDiscoveryQueue: 500,
            maxRecursiveDomains: 50,
            recursiveDomainsProcessed: 0,
            sourceRequest: null
        };
    },

    getSourceUrl(source, domain) {
        switch (source) {
            case 'ahrefs':
                return `https://ahrefs.com/backlink-checker/?input=${domain}&mode=subdomains`;
            case 'semrush':
                return `https://sem.3ue.co/analytics/backlinks/backlinks/?q=${domain}&searchType=domain`;
            case 'similarweb':
                return `https://sim.3ue.co/#/digitalsuite/acquisition/backlinks/table/999/?duration=28d&key=${domain}&sort=DomainScore`;
            default:
                return null;
        }
    },

    async waitForData(ctx, source, timeout) {
        const start = Date.now();
        while (!ctx.isSourceDone(source) && Date.now() - start < timeout) {
            await ctx.delay(1000);
        }
    },

    async navigateAndCollect(ctx, tabId, url, source) {
        try {
            ctx.setSourceDone(source, false);
            ctx.setSourceRequest({
                source,
                result: []
            });

            await ctx.updateTab(tabId, url);
            await ctx.waitForTabLoad(tabId);
            await ctx.delay(4000);

            const collectorFile = source.replace('my-', '') + '-collector.js';
            await ctx.executeCollector(tabId, collectorFile);

            if (source.startsWith('my-')) {
                await ctx.triggerMyDomainCollect(tabId);
            }

            const baseSource = source.replace('my-', '');
            const waitTimeout = baseSource === 'similarweb'
                ? 150000
                : baseSource === 'semrush'
                    ? 210000
                    : baseSource === 'ahrefs'
                        ? 90000
                        : 45000;

            await this.waitForData(ctx, source, waitTimeout);
            const request = ctx.getSourceRequest();
            const requestResult = request?.source === source
                ? [...(request.result || [])]
                : [];
            ctx.setSourceRequest(null);
            return requestResult;
        } catch (error) {
            ctx.setSourceRequest(null);
            await ctx.logger.error(`收集失败 (${source}): ${error.message}`);
            return [];
        }
    },

    async runSeedCollection(ctx, domain, myDomain, sources) {
        const seededDomains = [domain, myDomain]
            .map((value) => ctx.getDomain(value || ''))
            .filter(Boolean);

        ctx.setCollectState(this.createInitialCollectState(domain, myDomain, sources, seededDomains));

        await ctx.seedFrontier(seededDomains);
        await ctx.persistCollectSnapshot({
            collectState: {
                isCollecting: true,
                domain,
                myDomain,
                sources
            },
            collectStats: ctx.getCollectState().stats
        });
        ctx.broadcastStats();
        await ctx.logger.collect(`开始收集: ${domain}`, { sources });

        const tabId = await ctx.openCollectTab();

        for (const source of sources) {
            if (!ctx.getCollectState().isCollecting) break;
            const url = this.getSourceUrl(source, domain);
            if (url) {
                await this.navigateAndCollect(ctx, tabId, url, source);
            }
        }

        if (myDomain && ctx.getCollectState().isCollecting) {
            for (const source of sources) {
                if (!ctx.getCollectState().isCollecting) break;
                const url = this.getSourceUrl(source, myDomain);
                if (url) {
                    await this.navigateAndCollect(ctx, tabId, url, `my-${source}`);
                }
            }
        }

        if (ctx.getCollectState().isCollecting) {
            const merged = ctx.mergeBacklinks();
            await ctx.recordDomainIntel(merged, {
                discoveryMethod: 'collector-merge',
                seedTarget: ctx.getCollectState().domain,
                status: 'discovered'
            });
            ctx.resetCollectWaveStats(merged.length);
            ctx.broadcastStats();
            await ctx.logger.collect(`合并完成: ${merged.length} 条外链`);

            const analysisTargets = await ctx.buildAnalysisTargets(merged);
            ctx.setCollectWaveTargets(analysisTargets.length);
            ctx.broadcastStats();
            await ctx.logger.collect(`分析目标准备完成: ${analysisTargets.length} 个`, {
                directPages: analysisTargets.filter((item) => item.analysisStage === 'direct-page').length,
                domainDrilldowns: analysisTargets.filter((item) => item.analysisStage === 'domain-drilldown').length
            });

            await ctx.fetchAnalyzeAll(analysisTargets);
            await ctx.recursiveDiscovery();
        }

        await ctx.closeCollectTab();
        ctx.finishCollecting();
        await ctx.persistCollectSnapshot({
            collectState: {
                isCollecting: false,
                domain,
                myDomain,
                sources
            },
            collectStats: ctx.getCollectState().stats
        });
        await ctx.broadcastContinuousDiscoveryState();
        ctx.broadcastCollectDone();
        await ctx.logger.collect('收集完成');
    }
};

self.CollectorRuntime = CollectorRuntime;
