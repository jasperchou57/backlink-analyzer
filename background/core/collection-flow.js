/** Collection and discovery flow - extracted from background.js */

async function startCollect(domain, myDomain, sources) {
    await CollectorRuntime.runSeedCollection({
        logger: Logger,
        delay,
        waitForTabLoad,
        mergeBacklinks,
        buildAnalysisTargets,
        fetchAnalyzeAll,
        recursiveDiscovery,
        recordDomainIntel,
        broadcastStats,
        broadcastContinuousDiscoveryState,
        broadcastCollectDone: () => broadcastToPopup({ action: 'collectDone' }),
        getDomain: (value) => getDomainBg(value || ''),
        getCollectState: () => collectState,
        setCollectState: (nextState) => { collectState = nextState; },
        resetCollectWaveStats: (mergedCount) => {
            collectState.stats.backlinksFound = mergedCount;
            collectState.stats.targetsFound = mergedCount;
            collectState.stats.analyzed = 0;
            collectState.stats.inQueue = 0;
        },
        setCollectWaveTargets: (count) => {
            collectState.stats.targetsFound = count;
            collectState.stats.inQueue = count;
        },
        seedFrontier: async (seededDomains) => {
            await ensureDomainIntelLoaded();
            const seedEntry = seededDomains[0] ? ensureDomainFrontierEntry(seededDomains[0]) : null;
            if (seedEntry) {
                seedEntry.crawlStatus = 'completed';
                seedEntry.status = mergeDomainStatus(seedEntry.status, 'expanded');
            }
            if (seededDomains[1]) {
                const myEntry = ensureDomainFrontierEntry(seededDomains[1]);
                myEntry.crawlStatus = 'completed';
                myEntry.status = mergeDomainStatus(myEntry.status, 'profiled');
            }
            await flushDomainIntel();
        },
        persistCollectSnapshot: async (snapshot) => {
            await StateStore.saveCollectSnapshot(snapshot);
        },
        openCollectTab: async () => {
            const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
            collectTabId = tab.id;
            return collectTabId;
        },
        closeCollectTab: async () => {
            if (!collectTabId) return;
            try { await chrome.tabs.remove(collectTabId); } catch {}
            collectTabId = null;
        },
        finishCollecting: () => {
            collectState.isCollecting = false;
        },
        updateTab: async (tabId, url) => {
            await chrome.tabs.update(tabId, { url });
        },
        executeCollector: async (tabId, collectorFile) => {
            await chrome.scripting.executeScript({
                target: { tabId },
                files: [`content/${collectorFile}`]
            });
        },
        triggerMyDomainCollect: async (tabId) => {
            try {
                await chrome.tabs.sendMessage(tabId, { action: 'collectAsMyDomain' });
            } catch {}
        },
        setSourceDone: (source, value) => {
            collectState[`${source}_done`] = value;
        },
        isSourceDone: (source) => !!collectState[`${source}_done`],
        setSourceRequest: (value) => {
            collectState.sourceRequest = value;
        },
        getSourceRequest: () => collectState.sourceRequest
    }, domain, myDomain, sources);
}

function stopCollect() {
    collectState.isCollecting = false;
    if (continuousDiscoveryLoaded && continuousDiscoveryState.isRunning) {
        continuousDiscoveryState.isRunning = false;
        continuousDiscoveryState.isPaused = true;
        continuousDiscoveryState.currentDomain = '';
        continuousDiscoveryState.lastMessage = '已暂停持续发现';
        flushContinuousDiscoveryState().catch(() => {});
        broadcastContinuousDiscoveryState().catch(() => {});
    }
    persistCollectSnapshot().catch(() => {});
    broadcastToPopup({ action: 'collectDone' });
    Logger.collect('手动停止收集');
}

async function runContinuousDiscoveryLoop() {
    const runtimeContext = {
        ensureContinuousDiscoveryLoaded,
        ensureDomainIntelLoaded,
        ensureCollectTab,
        startCollect,
        buildAnalysisTargets,
        fetchAnalyzeAll,
        collectRecursiveDomainBacklinks,
        markDomainCrawlState,
        mergeDomainStatus,
        getNextPendingFrontierDomain,
        getContinuousDiscoveryStateView,
        updateContinuousDiscoveryState,
        getContinuousState: () => continuousDiscoveryState,
        getContinuousSeedDomain,
        getContinuousMyDomain,
        getContinuousSources: () => continuousDiscoveryState.sources || [],
        getDomainEntry: (domain) => domainIntel.getCache().frontier.find((item) => item.domain === domain) || null,
        isContinuousRunning: () => continuousDiscoveryState.isRunning && !continuousDiscoveryState.isPaused,
        prepareCollectContext: prepareContinuousCollectContext,
        incrementQueuedTargets: (count) => {
            collectState.stats.targetsFound += count;
            collectState.stats.inQueue += count;
        },
        broadcastStats,
        persistCollectRunning: async (isCollecting) => {
            collectState.isCollecting = isCollecting;
            await StateStore.saveCollectSnapshot({
                collectState: {
                    isCollecting,
                    domain: getContinuousSeedDomain(),
                    myDomain: getContinuousMyDomain(),
                    sources: collectState.sources || []
                },
                collectStats: collectState.stats
            });
        },
        closeCollectTab: async () => {
            if (!collectTabId) return;
            try { await chrome.tabs.remove(collectTabId); } catch {}
            collectTabId = null;
        },
        broadcastCollectDone: () => broadcastToPopup({ action: 'collectDone' }),
        logger: Logger,
        taskManager: TaskManager
    };

    await ensureContinuousDiscoveryLoaded();
    if (continuousDiscoveryState.isPaused || !continuousDiscoveryState.isRunning) return;

    const task = DiscoverWorkflow.buildTask(continuousDiscoveryState);
    await TaskRunner.run(task, {
        shouldStop: () => continuousDiscoveryState.isPaused || !continuousDiscoveryState.isRunning,
        handlers: {
            seed_collect: async () => await ContinuousDiscoveryEngine.runSeedInitialization(runtimeContext),
            frontier_collect: async () => await ContinuousDiscoveryEngine.runFrontierCollection(runtimeContext)
        },
        onStepStart: async (step, index, total, currentTask) => {
            await updateContinuousDiscoveryState(
                TaskManager.buildContinuousStepPatch(continuousDiscoveryState, currentTask, step, index, total)
            );
        }
    });
}

async function fetchAnalyzePage(link) {
    let url = link.url;
    if (!url.startsWith('http')) url = 'https://' + url;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
        });
        clearTimeout(timeout);

        if (!response.ok) return null;
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/html')) return null;

        const html = await response.text();

        // 尝试 AI 分类
        let aiResult = null;
        try {
            aiResult = await AIEngine.classifyLink(url, html);
            await Logger.ai(`AI 分类: ${url}`, aiResult);
        } catch {
            // AI 不可用时回退到规则分析
        }

        // 规则分析
        const ruleResult = analyzeHtml(html, url, link);
        if (ruleResult) {
            ruleResult.candidateType = link.candidateType || resolveCandidateType(link.sourceTypes || []);
            ruleResult.sourceTypes = [...(link.sourceTypes || [])];
            ruleResult.discoverySourceTier = normalizeSourceTier(link.sourceTier || '');
            ruleResult.sourceTier = normalizeSourceTier(link.sourceTier || '');
            ruleResult.sourceTiers = mergeSourceTierArrays(link.sourceTiers || [], [ruleResult.sourceTier]);
            ruleResult.discoveryEdges = mergeDiscoveryEdges(link.discoveryEdges || [], [
                buildDiscoveryEdge(ruleResult.sourceTier || SOURCE_TIERS.RULE_GUESS, 'rule-match', link.analysisStage || link.candidateType || 'page')
            ]);
        }
        await enrichDomainProfileFromPage(url, html, ruleResult);

        // AI 结果增强
        if (aiResult && aiResult.canLeaveLink && !ruleResult) {
            const aiOpportunities = [];
            if (aiResult.hasComments || aiResult.isBlog) {
                aiOpportunities.push('comment');
            }
            if (aiResult.siteType && !aiOpportunities.includes(aiResult.siteType)) {
                aiOpportunities.push(aiResult.siteType);
            }
            if (aiOpportunities.length === 0) {
                aiOpportunities.push('comment');
            }
            return {
                url,
                pageTitle: html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.trim()?.substring(0, 100) || '',
                opportunities: aiOpportunities,
                details: ['ai-candidate', aiResult.reason || ''],
                sources: link.sources || [],
                sourceTypes: [...(link.sourceTypes || [])],
                discoverySourceTier: normalizeSourceTier(link.sourceTier || SOURCE_TIERS.AI_GUESS) || SOURCE_TIERS.AI_GUESS,
                sourceTier: preferHigherSourceTier(link.sourceTier || '', SOURCE_TIERS.AI_GUESS) || SOURCE_TIERS.AI_GUESS,
                sourceTiers: mergeSourceTierArrays(link.sourceTiers || [], [SOURCE_TIERS.AI_GUESS, link.sourceTier || '']),
                discoveryEdges: mergeDiscoveryEdges(link.discoveryEdges || [], [
                    buildDiscoveryEdge(SOURCE_TIERS.AI_GUESS, 'ai-classify', link.analysisStage || link.candidateType || 'page')
                ]),
                candidateType: link.candidateType || resolveCandidateType(link.sourceTypes || []),
                linkMethod: 'text',
                aiClassified: true
            };
        }

        // 提取评论中的其他网站（为递归发现做准备）
        if (ruleResult && ruleResult.opportunities.includes('comment')) {
            await extractCommenterDomains(html, {
                discoveredFromUrl: url,
                seedTarget: collectState.domain
            });
        }

        return ruleResult;
    } catch {
        clearTimeout(timeout);
        return null;
    }
}

async function extractCommenterDomains(html, context = {}) {
    const commentSectionPatterns = [
        /<ol class="comment-list">([\s\S]*?)<\/ol>/i,
        /<div id="comments">([\s\S]*?)<\/div>\s*<\/div>/i,
        /<section class="comments">([\s\S]*?)<\/section>/i,
    ];

    let commentsHtml = '';
    for (const pattern of commentSectionPatterns) {
        const match = html.match(pattern);
        if (match) {
            commentsHtml = match[1];
            break;
        }
    }

    if (!commentsHtml) return;

    const linkRegex = /href=["'](https?:\/\/[^"']+)["']/gi;
    let match;
    const newlyDiscovered = [];
    while ((match = linkRegex.exec(commentsHtml)) !== null) {
        const href = match[1];
        const domain = getDomainBg(href);
        if (domain &&
            !domain.includes('wordpress.com') &&
            !domain.includes('blogger.com') &&
            !domain.includes('gravatar.com') &&
            !domain.includes('google.com') &&
            !domain.includes('facebook.com') &&
            !domain.includes('twitter.com') &&
            !domain.includes('instagram.com') &&
            !domain.includes('linkedin.com') &&
            !domain.includes('youtube.com') &&
            !domain.includes('tiktok.com') &&
            !domain.includes('pinterest.com') &&
            !domain.includes('reddit.com') &&
            !domain.includes('medium.com') &&
            !domain.includes('tumblr.com') &&
            !/\.edu$/i.test(domain) &&
            !/\.gov$/i.test(domain) &&
            !/\.mil$/i.test(domain) &&
            !collectState.discoveredDomains.has(domain)) {
            collectState.discoveredDomains.add(domain);
            newlyDiscovered.push({
                url: `https://${domain}/`,
                domain,
                sourceType: 'ref-domain',
                sourceTier: SOURCE_TIERS.COMMENT_OBSERVED,
                sourceTiers: [SOURCE_TIERS.COMMENT_OBSERVED],
                discoveryEdges: [
                    buildDiscoveryEdge(
                        SOURCE_TIERS.COMMENT_OBSERVED,
                        'commenter-domain',
                        context.discoveredFromUrl || domain
                    )
                ],
                sources: ['D']
            });
            if (collectState.discoveryQueue.length < collectState.maxDiscoveryQueue) {
                collectState.discoveryQueue.push(domain);
            }
        }
    }

    if (newlyDiscovered.length > 0) {
        await recordDomainIntel(newlyDiscovered, {
            discoveryMethod: 'commenter-domain',
            seedTarget: context.seedTarget || collectState.domain,
            discoveredFromUrl: context.discoveredFromUrl || '',
            status: 'queued',
            commentMention: true
        });
    }
}

async function recursiveDiscovery() {
    if (collectState.discoveryQueue.length === 0) return;
    if (collectState.discoveryDepth >= collectState.maxDiscoveryDepth) return;
    if (collectState.recursiveDomainsProcessed >= collectState.maxRecursiveDomains) return;

    const recursiveSources = getRecursiveCollectSources();
    if (recursiveSources.length === 0) {
        await Logger.collect('递归网站外链发现已跳过：当前仅支持用 SEMrush / SimilarWeb 继续自动扩展');
        return;
    }

    await Logger.collect(`递归发现: 发现 ${collectState.discoveryQueue.length} 个新域名，深度 ${collectState.discoveryDepth + 1}`);

    collectState.discoveryDepth++;
    const remainingBudget = Math.max(collectState.maxRecursiveDomains - collectState.recursiveDomainsProcessed, 0);
    const queuedUnique = [...new Set(collectState.discoveryQueue)]
        .filter((domain) => domain && !collectState.processedDiscoveryDomains.has(domain));
    const domainsToProcess = queuedUnique.slice(0, remainingBudget);
    const deferredDomains = queuedUnique.slice(domainsToProcess.length);
    collectState.discoveryQueue = deferredDomains;

    if (domainsToProcess.length === 0) return;

    const links = domainsToProcess.map((domain) => ({
        url: `https://${domain}`,
        normalizedUrl: domain,
        sources: ['D'],
        sourceTypes: ['ref-domain'],
        sourceTier: SOURCE_TIERS.COMMENT_OBSERVED,
        sourceTiers: [SOURCE_TIERS.COMMENT_OBSERVED],
        discoveryEdges: [buildDiscoveryEdge(SOURCE_TIERS.COMMENT_OBSERVED, 'recursive-discovery', domain)],
        candidateType: 'ref-domain',
        domain
    }));
    await recordDomainIntel(links, {
        discoveryMethod: 'recursive-discovery',
        seedTarget: collectState.domain,
        status: 'queued'
    });

    for (const domain of domainsToProcess) {
        if (!collectState.isCollecting) break;

        collectState.processedDiscoveryDomains.add(domain);
        collectState.recursiveDomainsProcessed++;

        const merged = await collectRecursiveDomainBacklinks(domain);
        if (merged.length === 0) {
            await Logger.collect(`递归网站外链为空: ${domain}`);
            continue;
        }

        const analysisTargets = await buildAnalysisTargets(merged);
        collectState.stats.targetsFound += analysisTargets.length;
        collectState.stats.inQueue += analysisTargets.length;
        broadcastStats();

        await Logger.collect(`递归网站分析目标准备完成: ${domain}`, {
            targets: analysisTargets.length,
            sources: recursiveSources
        });

        await fetchAnalyzeAll(analysisTargets);
    }

    if (collectState.isCollecting && collectState.discoveryQueue.length > 0) {
        await recursiveDiscovery();
    }
}

async function persistCollectSnapshot() {
    await StateStore.saveCollectSnapshot({
        collectState: {
            isCollecting: collectState.isCollecting,
            domain: collectState.domain,
            myDomain: collectState.myDomain,
            sources: collectState.sources || []
        },
        collectStats: collectState.stats
    });
}

async function getPersistedCollectView() {
    return await StateStore.loadCollectView(collectState.stats, collectState.isCollecting);
}
