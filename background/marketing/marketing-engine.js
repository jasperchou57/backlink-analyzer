/**
 * MarketingEngine — runtime orchestration for marketing tasks.
 * Manages tabs, browser search, and task creation.
 *
 * Uses a factory pattern because these functions need runtime dependencies
 * (tab management, TaskStore, etc.) that are only available in the
 * background.js execution context.
 *
 * Dependencies (available via importScripts global scope):
 *   MarketingResearch, MarketingPlanner (loaded before this file)
 */

const MarketingEngine = {

    create(deps) {
        // deps: {
        //   openOrReuseMarketingTab, delay, TaskStore, Logger, AIEngine,
        //   getDomainBg, normalizeHttpUrlBg, compactText, WorkflowRegistry,
        //   getNurtureAlarmName, computeNextNurtureRunAt, syncTaskSchedule
        // }

        const {
            openOrReuseMarketingTab,
            delay,
            TaskStore,
            Logger,
            AIEngine,
            getDomainBg: getDomain,
            normalizeHttpUrlBg: normalizeUrl,
            compactText: compact,
            WorkflowRegistry: registry,
            getNurtureAlarmName,
            computeNextNurtureRunAt,
            syncTaskSchedule
        } = deps;

        async function readMarketingTargetSnapshot(url = '') {
            const finalUrl = normalizeUrl(url);
            if (!finalUrl) return null;

            const tab = await openOrReuseMarketingTab(finalUrl, { active: false, waitForLoad: true });
            try {
                await delay(1200);
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => {
                        const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
                        const description = document.querySelector('meta[name="description"]')?.getAttribute('content')
                            || document.querySelector('meta[property="og:description"]')?.getAttribute('content')
                            || '';
                        const headings = Array.from(document.querySelectorAll('h1, h2'))
                            .map((node) => compact(node.textContent))
                            .filter(Boolean)
                            .slice(0, 6);
                        const paragraphs = Array.from(document.querySelectorAll('main p, article p, p'))
                            .map((node) => compact(node.textContent))
                            .filter((text) => text.length > 40)
                            .slice(0, 4);

                        return {
                            title: compact(document.title),
                            description: compact(description),
                            headings,
                            summary: paragraphs.join(' ').slice(0, 600),
                            url: window.location.href
                        };
                    }
                });
                return results?.[0]?.result || null;
            } catch {
                return null;
            }
        }

        async function readMarketingPageSnapshot(url = '') {
            const finalUrl = normalizeUrl(url);
            if (!finalUrl) return null;

            const tab = await openOrReuseMarketingTab(finalUrl, { active: false, waitForLoad: true });
            try {
                await delay(1400);
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => {
                        const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
                        const description = document.querySelector('meta[name="description"]')?.getAttribute('content')
                            || document.querySelector('meta[property="og:description"]')?.getAttribute('content')
                            || '';
                        const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
                            .map((node) => compact(node.textContent))
                            .filter(Boolean)
                            .slice(0, 8);
                        const paragraphs = Array.from(document.querySelectorAll('main p, article p, p'))
                            .map((node) => compact(node.textContent))
                            .filter((text) => text.length > 40)
                            .slice(0, 3);
                        return {
                            title: compact(document.title),
                            description: compact(description),
                            headings,
                            summary: paragraphs.join(' ').slice(0, 500),
                            url: window.location.href
                        };
                    }
                });
                const snapshot = results?.[0]?.result || null;
                if (!snapshot) return null;
                return {
                    ...snapshot,
                    host: getDomain(snapshot.url || finalUrl)
                };
            } catch {
                return null;
            }
        }

        async function collectBrowserSearchResults(query = '') {
            const finalQuery = compact(query);
            if (!finalQuery) return [];

            const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(finalQuery)}`;
            const tab = await openOrReuseMarketingTab(searchUrl, { active: false, waitForLoad: true });
            try {
                await delay(1400);
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => {
                        const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
                        return Array.from(document.querySelectorAll('li.b_algo, article[data-testid="result"], .result, .web-result'))
                            .map((node) => {
                                const anchor = node.querySelector('a[href]');
                                if (!anchor) return null;
                                const title = compact(anchor.textContent);
                                const url = anchor.href || anchor.getAttribute('href') || '';
                                const snippet = compact(
                                    node.querySelector('.b_caption p, p, .result__snippet, .snippet, .description')?.textContent || ''
                                );
                                return {
                                    title,
                                    url,
                                    snippet
                                };
                            })
                            .filter((item) => item && item.url && /^https?:/i.test(item.url) && item.title)
                            .slice(0, 8);
                    }
                });
                return results?.[0]?.result || [];
            } catch {
                return [];
            }
        }

        async function collectMarketingResearchContext(task = {}) {
            const snapshot = await readMarketingTargetSnapshot(task.website || '');
            const queries = MarketingResearch.buildMarketingResearchQueries(task, snapshot || {});
            const queryResults = [];
            const seenUrls = new Set();
            const ownDomain = getDomain(task.website || '');

            for (const query of queries) {
                const results = await collectBrowserSearchResults(query);
                const filtered = results.filter((item) => {
                    const normalized = normalizeUrl(item.url || '');
                    if (!normalized || seenUrls.has(normalized)) return false;
                    seenUrls.add(normalized);
                    return true;
                });
                queryResults.push({ query, results: filtered });
            }

            const candidates = MarketingResearch.buildMarketingPageReadCandidates(queryResults, ownDomain);
            const pageReads = [];
            for (const candidate of candidates) {
                const page = await readMarketingPageSnapshot(candidate.url || '');
                if (!page) continue;
                pageReads.push({
                    query: candidate.query || '',
                    rank: candidate.rank || 0,
                    title: page.title || candidate.title || '',
                    url: page.url || candidate.url || '',
                    description: page.description || '',
                    summary: page.summary || candidate.snippet || '',
                    headings: page.headings || [],
                    host: page.host || getDomain(candidate.url || '')
                });
            }

            return {
                generatedAt: new Date().toISOString(),
                snapshot: snapshot || null,
                queries: queryResults,
                pageReads
            };
        }

        async function createNurtureTasksFromPromotionPlan(baseTask = {}, promotionPlan = {}) {
            const channels = Array.isArray(promotionPlan.channels) ? promotionPlan.channels : [];
            const nurtureChannels = channels.filter((channel) => channel?.workflowId === 'account-nurture');
            const scheduledTasks = [];
            const summary = await TaskStore.updateTasks((tasks) => {
                let createdCount = 0;
                let updatedCount = 0;

                for (let index = 0; index < nurtureChannels.length; index++) {
                    const channel = nurtureChannels[index] || {};
                    const normalizedUrl = normalizeUrl(channel.url || '');
                    if (!normalizedUrl) continue;

                    const existingIndex = tasks.findIndex((task) =>
                        task.generatedFromTaskId === baseTask.id
                        && task.workflowId === 'account-nurture'
                        && normalizeUrl(task.platformUrl || '') === normalizedUrl
                    );

                    const generatedTask = {
                        ...MarketingPlanner.buildGeneratedMarketingTask(baseTask, channel, index),
                        workflowId: 'account-nurture',
                        taskType: 'nurture',
                        name: `${baseTask.name || baseTask.website || '产品宣传'} · 养号 · ${channel.name || getDomain(channel.url || '') || '平台'}`,
                        generatedByCampaign: true
                    };

                    if (existingIndex >= 0) {
                        tasks[existingIndex] = {
                            ...tasks[existingIndex],
                            ...generatedTask,
                            id: tasks[existingIndex].id,
                            createdAt: tasks[existingIndex].createdAt || new Date().toISOString(),
                            runCount: Number(tasks[existingIndex].runCount || 0),
                            lastRunAt: tasks[existingIndex].lastRunAt || ''
                        };
                        scheduledTasks.push({ ...tasks[existingIndex] });
                        updatedCount++;
                    } else {
                        generatedTask.createdAt = new Date().toISOString();
                        tasks.push(generatedTask);
                        scheduledTasks.push({ ...generatedTask });
                        createdCount++;
                    }
                }

                return {
                    tasks,
                    value: {
                        createdCount,
                        updatedCount,
                        totalChannels: nurtureChannels.length
                    }
                };
            });
            await Promise.all(scheduledTasks.map((task) => syncTaskSchedule(task).catch(() => {})));
            return {
                createdCount: summary.createdCount,
                updatedCount: summary.updatedCount,
                totalChannels: summary.totalChannels
            };
        }

        async function createTasksFromResearchPlan(baseTask = {}, researchResult = {}) {
            const channels = Array.isArray(researchResult.channels) ? researchResult.channels : [];
            const scheduledTasks = [];
            const summary = await TaskStore.updateTasks((tasks) => {
                let createdCount = 0;
                let updatedCount = 0;

                for (let index = 0; index < channels.length; index++) {
                    const channel = channels[index] || {};
                    const normalizedUrl = normalizeUrl(channel.url || '');
                    if (!normalizedUrl) continue;

                    const workflowId = ['community-post-promote', 'directory-submit-promote', 'account-nurture'].includes(channel.workflowId)
                        ? channel.workflowId
                        : 'community-post-promote';

                    const existingIndex = tasks.findIndex((task) =>
                        task.generatedFromTaskId === baseTask.id
                        && task.workflowId === workflowId
                        && normalizeUrl(task.platformUrl || '') === normalizedUrl
                    );

                    const generatedTask = MarketingPlanner.buildGeneratedMarketingTask(baseTask, channel, index);

                    if (existingIndex >= 0) {
                        tasks[existingIndex] = {
                            ...tasks[existingIndex],
                            ...generatedTask,
                            id: tasks[existingIndex].id,
                            createdAt: tasks[existingIndex].createdAt || new Date().toISOString(),
                            runCount: Number(tasks[existingIndex].runCount || 0),
                            lastRunAt: tasks[existingIndex].lastRunAt || ''
                        };
                        scheduledTasks.push({ ...tasks[existingIndex] });
                        updatedCount++;
                    } else {
                        generatedTask.createdAt = new Date().toISOString();
                        tasks.push(generatedTask);
                        scheduledTasks.push({ ...generatedTask });
                        createdCount++;
                    }
                }

                return {
                    tasks,
                    value: {
                        createdCount,
                        updatedCount,
                        totalChannels: channels.length
                    }
                };
            });
            await Promise.all(scheduledTasks.map((task) => syncTaskSchedule(task).catch(() => {})));
            return {
                createdCount: summary.createdCount,
                updatedCount: summary.updatedCount,
                totalChannels: summary.totalChannels
            };
        }

        return {
            readMarketingTargetSnapshot,
            readMarketingPageSnapshot,
            collectBrowserSearchResults,
            collectMarketingResearchContext,
            createNurtureTasksFromPromotionPlan,
            createTasksFromResearchPlan
        };
    }

};
