const ContinuousDiscoveryEngine = {
    async runSeedInitialization(ctx) {
        if (ctx.getContinuousState().seedInitialized) {
            return { skipped: true };
        }

        await ctx.updateContinuousDiscoveryState({
            currentDomain: ctx.getContinuousSeedDomain(),
            lastMessage: `正在初始化种子网站 ${ctx.getContinuousSeedDomain()}`
        });
        await ctx.startCollect(
            ctx.getContinuousSeedDomain(),
            ctx.getContinuousMyDomain(),
            ctx.getContinuousSources()
        );
        await ctx.updateContinuousDiscoveryState({
            seedInitialized: true,
            currentDomain: '',
            lastSeedRunAt: new Date().toISOString(),
            lastMessage: '种子网站初始化完成，开始持续处理发现池'
        });
        return { completed: true };
    },

    async processDomain(ctx, domain) {
        ctx.prepareCollectContext();
        const now = new Date().toISOString();
        const currentEntry = ctx.getDomainEntry(domain);

        await ctx.markDomainCrawlState(domain, {
            crawlStatus: 'processing',
            status: ctx.mergeDomainStatus(currentEntry?.status || 'discovered', 'queued'),
            lastSeenAt: now,
            crawlAttempts: (currentEntry?.crawlAttempts || 0) + 1
        });

        await ctx.updateContinuousDiscoveryState({
            currentDomain: domain,
            lastFrontierRunAt: now,
            lastMessage: `正在递归分析 ${domain}`
        });

        const merged = await ctx.collectRecursiveDomainBacklinks(domain);
        if (!ctx.isContinuousRunning()) {
            await ctx.markDomainCrawlState(domain, { crawlStatus: 'pending' });
            return false;
        }

        if (merged.length === 0) {
            await ctx.markDomainCrawlState(domain, {
                crawlStatus: 'completed',
                lastCollectedAt: new Date().toISOString(),
                status: ctx.mergeDomainStatus(ctx.getDomainEntry(domain)?.status || 'discovered', 'profiled')
            });
            await ctx.logger.collect(`持续发现: ${domain} 未发现可继续分析的外链`);
            return true;
        }

        const analysisTargets = await ctx.buildAnalysisTargets(merged);
        ctx.incrementQueuedTargets(analysisTargets.length);
        ctx.broadcastStats();
        await ctx.logger.collect(`持续发现: ${domain} 准备分析 ${analysisTargets.length} 个目标`);

        await ctx.fetchAnalyzeAll(analysisTargets);

        await ctx.markDomainCrawlState(domain, {
            crawlStatus: 'completed',
            lastCollectedAt: new Date().toISOString(),
            status: ctx.mergeDomainStatus(ctx.getDomainEntry(domain)?.status || 'discovered', 'expanded')
        });
        return true;
    },

    async runFrontierCollection(ctx) {
        ctx.prepareCollectContext();
        await ctx.persistCollectRunning(true);
        await ctx.ensureDomainIntelLoaded();
        await ctx.ensureCollectTab();

        while (ctx.isContinuousRunning()) {
            const nextEntry = ctx.getNextPendingFrontierDomain();
            if (!nextEntry) break;

            const processed = await this.processDomain(ctx, nextEntry.domain);
            await ctx.ensureContinuousDiscoveryLoaded();
            if (!processed) break;
        }

        const finalState = await ctx.getContinuousDiscoveryStateView();
        if (!finalState.pendingDomains) {
            await ctx.updateContinuousDiscoveryState(
                ctx.taskManager.buildContinuousTaskCompletedPatch(
                    ctx.getContinuousState(),
                    '持续发现已完成，发现池暂时没有新的待递归网站'
                )
            );
            await ctx.persistCollectRunning(false);
            await ctx.closeCollectTab();
            ctx.broadcastCollectDone();
            return { completed: true, stop: true };
        }

        if (ctx.getContinuousState().isPaused) {
            await ctx.updateContinuousDiscoveryState({
                currentDomain: '',
                lastMessage: '持续发现已暂停'
            });
            await ctx.persistCollectRunning(false);
            return { paused: true, stop: true };
        }

        await ctx.updateContinuousDiscoveryState(
            ctx.taskManager.buildContinuousTaskCompletedPatch(ctx.getContinuousState(), '持续发现已结束')
        );
        await ctx.persistCollectRunning(false);
        return { completed: true, stop: true };
    }
};

self.ContinuousDiscoveryEngine = ContinuousDiscoveryEngine;
