/**
 * MarketingPlanner — plan building, normalization, and task generation
 * for marketing channels.
 *
 * Dependencies (available via importScripts global scope):
 *   compactText, getDomainBg, normalizeHttpUrlBg, WorkflowRegistry,
 *   MarketingResearch (loaded before this file)
 */

const MarketingPlanner = {

    normalizeMarketingChannel(channel = {}, task = {}, researchContext = {}) {
        const url = normalizeHttpUrlBg(channel.url || '');
        if (!url) return null;
        const host = getDomainBg(url);
        const workflowId = ['community-post-promote', 'directory-submit-promote', 'account-nurture'].includes(channel.workflowId)
            ? channel.workflowId
            : MarketingResearch.inferMarketingWorkflowId({ ...channel, url, host });
        const score = Number(channel.score || MarketingResearch.scoreMarketingCandidate({ ...channel, url, host }));

        return {
            name: compactText(channel.name || MarketingResearch.buildMarketingChannelName({ ...channel, host }, workflowId)),
            url,
            host,
            workflowId,
            angle: compactText(channel.angle || MarketingResearch.buildMarketingChannelAngle(task, workflowId, { ...channel, url, host }, researchContext)),
            reason: compactText(channel.reason || MarketingResearch.buildMarketingChannelReason({ ...channel, url, host }, workflowId)),
            source: compactText(channel.source || 'ai-plan'),
            query: compactText(channel.query || ''),
            title: compactText(channel.title || ''),
            score
        };
    },

    buildMarketingFallbackChannels(task = {}, researchContext = {}) {
        const pageReads = Array.isArray(researchContext?.pageReads) ? researchContext.pageReads : [];
        const queryResults = Array.isArray(researchContext?.queries) ? researchContext.queries : [];
        const candidates = [];

        for (const page of pageReads) {
            candidates.push({
                ...page,
                source: 'page-read',
                rank: Number(page.rank || 0)
            });
        }

        for (const entry of queryResults) {
            const query = String(entry?.query || '').trim();
            const results = Array.isArray(entry?.results) ? entry.results : [];
            for (let index = 0; index < results.length; index++) {
                const item = results[index] || {};
                candidates.push({
                    ...item,
                    query,
                    source: 'search-result',
                    rank: index + 1,
                    host: getDomainBg(item.url || '')
                });
            }
        }

        const deduped = new Map();
        for (const candidate of candidates) {
            const normalizedUrl = normalizeHttpUrlBg(candidate.url || '');
            if (!normalizedUrl) continue;
            const host = getDomainBg(normalizedUrl);
            if (!host || host === getDomainBg(task.website || '')) continue;

            const workflowId = MarketingResearch.inferMarketingWorkflowId({ ...candidate, url: normalizedUrl, host });
            if (!MarketingResearch.isLikelyMarketingPlatformCandidate({ ...candidate, url: normalizedUrl, host }, workflowId)) continue;
            const normalized = MarketingPlanner.normalizeMarketingChannel({
                ...candidate,
                url: normalizedUrl,
                host,
                workflowId,
                score: MarketingResearch.scoreMarketingCandidate({ ...candidate, url: normalizedUrl, host })
            }, task, researchContext);
            if (!normalized) continue;

            const key = `${normalized.workflowId}::${normalized.url}`;
            const existing = deduped.get(key);
            if (!existing || normalized.score > existing.score) {
                deduped.set(key, normalized);
            }
        }

        const priority = {
            'community-post-promote': 0,
            'directory-submit-promote': 1,
            'account-nurture': 2
        };

        return Array.from(deduped.values())
            .sort((a, b) => {
                const priorityDelta = (priority[a.workflowId] || 9) - (priority[b.workflowId] || 9);
                if (priorityDelta !== 0) return priorityDelta;
                return (b.score || 0) - (a.score || 0);
            })
            .slice(0, 8);
    },

    summarizeMarketingChannelMix(channels = []) {
        return channels.reduce((summary, channel) => {
            const workflowId = channel?.workflowId || '';
            summary[workflowId] = Number(summary[workflowId] || 0) + 1;
            return summary;
        }, {});
    },

    finalizeMarketingPlan(rawPlan = {}, task = {}, researchContext = {}) {
        const fallbackChannels = MarketingPlanner.buildMarketingFallbackChannels(task, researchContext);
        const merged = new Map();
        const priority = {
            'community-post-promote': 0,
            'directory-submit-promote': 1,
            'account-nurture': 2
        };

        for (const channel of Array.isArray(rawPlan?.channels) ? rawPlan.channels : []) {
            const normalized = MarketingPlanner.normalizeMarketingChannel(channel, task, researchContext);
            if (!normalized) continue;
            merged.set(`${normalized.workflowId}::${normalized.url}`, normalized);
        }

        for (const channel of fallbackChannels) {
            const key = `${channel.workflowId}::${channel.url}`;
            const existing = merged.get(key);
            if (existing) {
                merged.set(key, {
                    ...channel,
                    ...existing,
                    angle: existing.angle || channel.angle,
                    reason: existing.reason || channel.reason,
                    score: Math.max(Number(existing.score || 0), Number(channel.score || 0)),
                    source: existing.source || channel.source
                });
            } else {
                merged.set(key, channel);
            }
        }

        const channels = Array.from(merged.values()).sort((a, b) => {
            const priorityDelta = (priority[a.workflowId] || 9) - (priority[b.workflowId] || 9);
            if (priorityDelta !== 0) return priorityDelta;
            return Number(b.score || 0) - Number(a.score || 0);
        });
        const channelMix = MarketingPlanner.summarizeMarketingChannelMix(channels);
        const nextSteps = Array.isArray(rawPlan?.nextSteps) && rawPlan.nextSteps.length > 0
            ? rawPlan.nextSteps
            : [
                channelMix['community-post-promote'] ? '优先推进高分社区渠道，准备对应发帖角度与落地页。' : '',
                channelMix['directory-submit-promote'] ? '整理目录提交所需的标题、描述、分类和截图素材。' : '',
                channelMix['account-nurture'] ? '把需要长期积累的平台加入养号节奏，降低直接发帖风险。' : ''
            ].filter(Boolean);
        const cautions = Array.isArray(rawPlan?.cautions) && rawPlan.cautions.length > 0
            ? rawPlan.cautions
            : [
                '优先在允许推广的社区或目录提交，不要在规则不明的平台直接硬广。',
                '对需要登录、养号或人工上传素材的平台，保留人工接管点。'
            ];
        const summary = compactText(rawPlan?.summary || '')
            || `已基于浏览器调研整理 ${channels.length} 个可执行渠道，其中社区发帖 ${channelMix['community-post-promote'] || 0} 个、目录提交 ${channelMix['directory-submit-promote'] || 0} 个、账号养护 ${channelMix['account-nurture'] || 0} 个。`;

        return {
            ...rawPlan,
            summary,
            channels,
            nextSteps,
            cautions,
            browserSuggestedCount: fallbackChannels.length,
            channelMix
        };
    },

    filterPromotionPlanForUnopenedChannels(plan = {}, reviewItems = []) {
        const openedUrls = new Set((Array.isArray(reviewItems) ? reviewItems : [])
            .map((item) => normalizeHttpUrlBg(item?.url || ''))
            .filter(Boolean));

        const channels = (Array.isArray(plan.channels) ? plan.channels : [])
            .filter((channel) => {
                const url = normalizeHttpUrlBg(channel?.url || '');
                return url && !openedUrls.has(url);
            });

        const channelMix = MarketingPlanner.summarizeMarketingChannelMix(channels);
        const totalOpenableChannels = channels.filter((channel) =>
            channel?.workflowId !== 'account-nurture' && normalizeHttpUrlBg(channel?.url || '')
        ).length;

        return {
            ...plan,
            channels,
            channelMix,
            totalOpenableChannels,
            nextChannelIndex: 0,
            progressedChannelCount: 0,
            lastOpenedChannelIndex: -1,
            openedChannelName: '',
            openedChannelUrl: '',
            lastOpenedAt: '',
            status: totalOpenableChannels > 0 ? 'planned' : 'awaiting_refresh'
        };
    },

    normalizePromotionReviewItem(item = {}) {
        const url = normalizeHttpUrlBg(item.url || '');
        if (!url) return null;
        const openedAt = item.openedAt || new Date().toISOString();
        return {
            name: compactText(item.name || MarketingResearch.getKnownMarketingPlatformLabel(getDomainBg(url))),
            url,
            host: getDomainBg(url),
            workflowId: compactText(item.workflowId || ''),
            openedAt,
            checkedAt: item.checkedAt || '',
            openCount: Math.max(1, Number(item.openCount || 1))
        };
    },

    mergePromotionReviewItems(existingItems = [], item = {}) {
        const normalized = MarketingPlanner.normalizePromotionReviewItem(item);
        if (!normalized) return Array.isArray(existingItems) ? existingItems : [];

        const items = Array.isArray(existingItems) ? existingItems : [];
        const existingIndex = items.findIndex((entry) => normalizeHttpUrlBg(entry?.url || '') === normalized.url);
        if (existingIndex >= 0) {
            const existing = items[existingIndex] || {};
            const merged = {
                ...existing,
                ...normalized,
                name: normalized.name || existing.name || '',
                openCount: Math.max(1, Number(existing.openCount || 1)) + 1,
                checkedAt: existing.checkedAt || normalized.checkedAt || ''
            };
            const next = items.slice();
            next[existingIndex] = merged;
            return next
                .sort((a, b) => new Date(b.openedAt || 0).getTime() - new Date(a.openedAt || 0).getTime())
                .slice(0, 20);
        }

        return [normalized, ...items]
            .sort((a, b) => new Date(b.openedAt || 0).getTime() - new Date(a.openedAt || 0).getTime())
            .slice(0, 20);
    },

    buildGeneratedMarketingTask(baseTask = {}, channel = {}, index = 0) {
        const workflowId = ['community-post-promote', 'directory-submit-promote', 'account-nurture'].includes(channel.workflowId)
            ? channel.workflowId
            : 'community-post-promote';
        const taskType = WorkflowRegistry.get(workflowId || WorkflowRegistry.DEFAULT_WORKFLOW_ID)?.taskType || 'publish';
        const platformUrl = normalizeHttpUrlBg(channel.url || '');
        const workflowLabel = WorkflowRegistry.getLabel(workflowId);
        const angle = String(channel.angle || '').trim();
        const reason = String(channel.reason || '').trim();
        const campaignBrief = [
            String(baseTask.campaignBrief || '').trim(),
            reason ? `研究建议：${reason}` : '',
            angle ? `建议角度：${angle}` : ''
        ].filter(Boolean).join('\n');

        return {
            id: `research-${baseTask.id || 'seed'}-${index}-${Math.random().toString(36).slice(2, 7)}`,
            name: `${baseTask.name || baseTask.website || '营销任务'} · ${channel.name || workflowLabel}`,
            website: baseTask.website || '',
            workflowId,
            taskType,
            platformUrl,
            campaignBrief,
            postAngle: taskType === 'promote' ? angle : '',
            submitCategory: workflowId === 'directory-submit-promote' ? angle : '',
            frequency: workflowId === 'account-nurture' ? 'daily' : '',
            sessionGoal: workflowId === 'account-nurture' ? (angle || reason || '浏览并进行低频互动') : '',
            nextRunAt: workflowId === 'account-nurture' ? computeNextNurtureRunAt('daily') : '',
            generatedFromTaskId: baseTask.id || '',
            generatedByResearch: true,
            generatedAt: new Date().toISOString(),
            stats: { total: 0, success: 0, skipped: 0, pending: 0, failed: 0 },
            runCount: 0,
            lastRunAt: ''
        };
    }

};
