/**
 * MarketingResearch — pure functions for browser search, page scoring,
 * platform detection, and candidate building.
 *
 * Dependencies (available via importScripts global scope):
 *   compactText, getDomainBg, normalizeHttpUrlBg, getSourceTierScore
 */

const MarketingResearch = {

    buildMarketingResearchQueries(task = {}, snapshot = {}) {
        const website = normalizeHttpUrlBg(task.website || '');
        const domain = getDomainBg(website);
        const title = compactText(snapshot.title || '').replace(/\s*[|\-–—]\s*.*/, '');
        const productSeed = title || domain || compactText(task.name || '');
        const targetAudience = compactText(task.targetAudience || '');
        const preferredChannels = compactText(task.preferredChannels || '');
        const brief = compactText(task.campaignBrief || '');

        const rawQueries = [
            `${productSeed} ${preferredChannels || targetAudience || brief}`.trim(),
            `${productSeed} site:reddit.com OR site:news.ycombinator.com OR site:dev.to OR site:producthunt.com OR site:indiehackers.com`.trim(),
            `${productSeed} submit site OR app directory OR startup directory OR product showcase`.trim(),
            `${productSeed} forum OR community OR launch OR review`.trim()
        ];

        return Array.from(new Set(rawQueries.map((value) => compactText(value)).filter(Boolean))).slice(0, 4);
    },

    getMarketingPageReadScore(item = {}, ownDomain = '') {
        const url = normalizeHttpUrlBg(item.url || '');
        const host = getDomainBg(url);
        const text = compactText([item.title, item.snippet].filter(Boolean).join(' ')).toLowerCase();
        let score = 0;

        if (!url || !host || (ownDomain && host === ownDomain)) return -999;
        if (/(google|bing|yahoo)\./.test(host)) return -999;

        if (/(reddit|news\.ycombinator|dev\.to|producthunt|indiehackers|itch\.io|youtube|x\.com|twitter|instagram|facebook|linkedin)\./.test(host)) {
            score += 120;
        }
        if (/(directory|directories|submit|showcase|launch|community|forum|startup|indie|product hunt|appsumo|betalist)/.test(text)) {
            score += 40;
        }
        if (/(post|thread|discussion|launch|listing|directory|submit)/.test(text)) {
            score += 25;
        }

        score += Math.max(0, 20 - (item.rank || 0));
        return score;
    },

    buildMarketingPageReadCandidates(queryResults = [], ownDomain = '') {
        const scored = [];
        for (const entry of queryResults) {
            const results = Array.isArray(entry?.results) ? entry.results : [];
            for (let index = 0; index < results.length; index++) {
                const item = results[index] || {};
                scored.push({
                    ...item,
                    query: entry.query || '',
                    rank: index + 1,
                    score: MarketingResearch.getMarketingPageReadScore({ ...item, rank: index + 1 }, ownDomain)
                });
            }
        }

        const seenHosts = new Set();
        return scored
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .filter((item) => {
                const host = getDomainBg(item.url || '');
                if (!host || seenHosts.has(host)) return false;
                seenHosts.add(host);
                return true;
            })
            .slice(0, 6);
    },

    getKnownMarketingPlatformLabel(host = '') {
        const normalized = String(host || '').toLowerCase();
        const platformMap = [
            ['reddit.com', 'Reddit'],
            ['news.ycombinator.com', 'Hacker News'],
            ['dev.to', 'Dev.to'],
            ['producthunt.com', 'Product Hunt'],
            ['indiehackers.com', 'Indie Hackers'],
            ['itch.io', 'itch.io'],
            ['youtube.com', 'YouTube'],
            ['instagram.com', 'Instagram'],
            ['x.com', 'X'],
            ['twitter.com', 'Twitter'],
            ['facebook.com', 'Facebook'],
            ['linkedin.com', 'LinkedIn'],
            ['threads.net', 'Threads'],
            ['tiktok.com', 'TikTok'],
            ['alternativeto.net', 'AlternativeTo'],
            ['betalist.com', 'BetaList'],
            ['startupstash.com', 'Startup Stash'],
            ['saashub.com', 'SaaSHub'],
            ['toolify.ai', 'Toolify'],
            ['futurepedia.io', 'Futurepedia'],
            ['thereisanaiforthat.com', 'ThereIsAnAIForThat'],
            ['launchingnext.com', 'Launching Next'],
            ['insanelycooltools.com', 'Insanely Cool Tools'],
            ['chromewebstore.google.com', 'Chrome Web Store'],
            ['addons.mozilla.org', 'Mozilla Add-ons']
        ];

        const matched = platformMap.find(([pattern]) => normalized === pattern || normalized.endsWith(`.${pattern}`));
        if (matched) return matched[1];
        return normalized.replace(/^www\./, '') || '平台';
    },

    isLikelyMarketingPlatformCandidate(candidate = {}, workflowId = '') {
        const host = String(candidate.host || getDomainBg(candidate.url || '') || '').toLowerCase();
        const text = compactText([
            candidate.title,
            candidate.description,
            candidate.summary,
            candidate.snippet,
            candidate.query,
            candidate.reason
        ].join(' ')).toLowerCase();

        if (!host) return false;
        if (/google\.com|bing\.com|yahoo\.com|duckduckgo\.com|baidu\.com|wikipedia\.org|fandom\.com/i.test(host)) {
            return false;
        }
        if (/(login|sign in|pricing|docs|documentation|terms|privacy|download|apk|wiki|codes)/i.test(text)
            && !/(forum|community|discussion|subreddit|directory|listing|submit|launch|show hn|product hunt)/i.test(text)) {
            return false;
        }

        const knownPlatform = /(reddit\.com|news\.ycombinator\.com|dev\.to|producthunt\.com|indiehackers\.com|itch\.io|youtube\.com|instagram\.com|x\.com|twitter\.com|facebook\.com|linkedin\.com|threads\.net|tiktok\.com|alternativeto\.net|betalist\.com|startupstash\.com|saashub\.com|toolify\.ai|futurepedia\.io|thereisanaiforthat\.com|launchingnext\.com|insanelycooltools\.com|chromewebstore\.google\.com|addons\.mozilla\.org|g2\.com|capterra\.com|appsumo\.com|discord\.com|devforum\.roblox\.com)/i;
        if (knownPlatform.test(host)) return true;

        if (workflowId === 'community-post-promote') {
            return /(forum|community|discussion|thread|subreddit|discourse|phpbb|xenforo|vbulletin|show hn|share your project)/i.test(`${host} ${text}`);
        }
        if (workflowId === 'directory-submit-promote') {
            return /(submit|directory|listing|launch|showcase|catalog|startup directory|tool directory|product hunt|app directory)/i.test(text);
        }
        if (workflowId === 'account-nurture') {
            return /(youtube|instagram|twitter|x\.com|facebook|linkedin|threads|tiktok|discord)/i.test(host);
        }
        return false;
    },

    inferMarketingWorkflowId(candidate = {}) {
        const host = String(candidate.host || getDomainBg(candidate.url || '') || '').toLowerCase();
        const text = compactText([
            candidate.title,
            candidate.description,
            candidate.summary,
            candidate.snippet,
            candidate.query
        ].join(' ')).toLowerCase();

        const socialHosts = /(youtube\.com|instagram\.com|x\.com|twitter\.com|facebook\.com|linkedin\.com|threads\.net|tiktok\.com|discord\.com)/i;
        const communityHosts = /(reddit\.com|news\.ycombinator\.com|dev\.to|indiehackers\.com|hashnode\.com|medium\.com|substack\.com|forum|community|discourse|phpbb|xenforo|vbulletin)/i;
        const directoryHosts = /(producthunt\.com|alternativeto\.net|betalist\.com|startupstash\.com|saashub\.com|toolify\.ai|futurepedia\.io|thereisanaiforthat\.com|launchingnext\.com|insanelycooltools\.com|chromewebstore\.google\.com|addons\.mozilla\.org|g2\.com|capterra\.com|appsumo\.com)/i;

        if (socialHosts.test(host)) return 'account-nurture';
        if (directoryHosts.test(host)) return 'directory-submit-promote';
        if (communityHosts.test(host)) return 'community-post-promote';

        if (/\b(submit|directory|listing|launch|showcase|startup directory|product hunt|chrome extension store|add-ons)\b/i.test(text)) {
            return 'directory-submit-promote';
        }
        if (/\b(subreddit|community|forum|discussion|thread|show hn|post idea|devlog|share your project|launch thread)\b/i.test(text)) {
            return 'community-post-promote';
        }
        if (/\b(profile|followers|subscribe|channel|feed|timeline|creator)\b/i.test(text)) {
            return 'account-nurture';
        }
        return 'community-post-promote';
    },

    scoreMarketingCandidate(candidate = {}) {
        const host = String(candidate.host || getDomainBg(candidate.url || '') || '').toLowerCase();
        const text = compactText([
            candidate.title,
            candidate.description,
            candidate.summary,
            candidate.snippet,
            candidate.query
        ].join(' ')).toLowerCase();

        let score = Number(candidate.rank || 0) > 0 ? Math.max(0, 40 - (Number(candidate.rank) * 4)) : 8;
        if (candidate.source === 'page-read') score += 24;
        if (/reddit\.com|news\.ycombinator\.com|dev\.to|producthunt\.com|indiehackers\.com|itch\.io|alternativeto\.net|betalist\.com|startupstash\.com|saashub\.com/i.test(host)) score += 20;
        if (/\b(submit|directory|listing|community|forum|discussion|launch|show hn|share your project|product hunt)\b/i.test(text)) score += 12;
        if (/\b(login|sign in|pricing|docs|documentation|terms|privacy)\b/i.test(text)) score -= 8;
        if (/google\.com|bing\.com|yahoo\.com|duckduckgo\.com/i.test(host)) score -= 20;
        return Math.max(0, Math.min(100, score));
    },

    buildMarketingChannelAngle(task = {}, workflowId = '', candidate = {}, researchContext = {}) {
        const audience = compactText(task.targetAudience || '');
        const brief = compactText(task.campaignBrief || '').slice(0, 120);
        const productTitle = compactText(researchContext?.snapshot?.title || task.name || getDomainBg(task.website || '') || '产品');
        const platform = MarketingResearch.getKnownMarketingPlatformLabel(candidate.host || getDomainBg(candidate.url || ''));

        if (workflowId === 'directory-submit-promote') {
            return compactText(`提交 ${productTitle} 到 ${platform}，突出 ${brief || '核心卖点、差异化与落地页价值'}。`);
        }
        if (workflowId === 'account-nurture') {
            return compactText(`围绕 ${platform} 的目标用户 ${audience || '相关受众'} 做低频浏览、点赞和自然互动，逐步建立账号历史。`);
        }
        return compactText(`在 ${platform} 以 ${audience || '目标用户'} 为对象，分享 ${brief || `${productTitle} 的使用价值、案例和故事`}。`);
    },

    buildMarketingChannelReason(candidate = {}, workflowId = '') {
        const query = compactText(candidate.query || '');
        const evidence = compactText(candidate.summary || candidate.description || candidate.snippet || '').slice(0, 180);
        const host = candidate.host || getDomainBg(candidate.url || '');
        const workflowLabelMap = {
            'community-post-promote': '社区发帖',
            'directory-submit-promote': '目录提交',
            'account-nurture': '账号养护'
        };
        const label = workflowLabelMap[workflowId] || '宣传渠道';
        const parts = [
            `${label}候选`,
            host ? `来源站点：${host}` : '',
            query ? `命中搜索：${query}` : '',
            evidence ? `页面摘要：${evidence}` : ''
        ].filter(Boolean);
        return parts.join('；');
    },

    buildMarketingChannelName(candidate = {}, workflowId = '') {
        const host = candidate.host || getDomainBg(candidate.url || '');
        const platformLabel = MarketingResearch.getKnownMarketingPlatformLabel(host);
        if (workflowId === 'account-nurture') return `${platformLabel} 账号养护`;
        if (workflowId === 'directory-submit-promote') return `${platformLabel} 目录提交`;
        return `${platformLabel} 社区发帖`;
    }

};
