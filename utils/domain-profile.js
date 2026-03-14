(function (globalScope) {
    if (globalScope.DomainProfileUtils) return;

    function create(config = {}) {
        const compactText = typeof config.compactText === 'function'
            ? config.compactText
            : (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const getDomain = typeof config.getDomain === 'function'
            ? config.getDomain
            : (() => '');
        const sourceTiers = config.sourceTiers || {};
        const sourceTierScores = config.sourceTierScores || {};

        function pushUniqueValue(target, value, limit = 6) {
            const normalized = String(value || '').trim();
            if (!normalized) return;
            if (!Array.isArray(target)) return;
            if (target.includes(normalized)) return;
            target.push(normalized);
            if (target.length > limit) {
                target.splice(0, target.length - limit);
            }
        }

        function mergeStringArrays(values = [], nextValues = [], limit = 6) {
            const merged = Array.isArray(values) ? [...values] : [];
            for (const value of nextValues || []) {
                pushUniqueValue(merged, value, limit);
            }
            return merged;
        }

        function inferLanguageFromHtml(html = '') {
            const langMatch = html.match(/<html[^>]+lang=["']([^"']+)["']/i);
            if (langMatch?.[1]) return langMatch[1].trim().toLowerCase();

            const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .slice(0, 2500);

            if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
            if (/[\u3040-\u30ff]/.test(text)) return 'ja';
            if (/[\u0400-\u04ff]/.test(text)) return 'ru';
            if (/[àèìòù]/i.test(text) || /\b(ciao|grazie|commenti|articolo)\b/i.test(text)) return 'it';
            if (/[áéíóúñ]/i.test(text) || /\b(hola|articulo|comentarios)\b/i.test(text)) return 'es';
            if (/[ãõç]/i.test(text) || /\b(voce|comentarios|comentario)\b/i.test(text)) return 'pt';
            return 'en';
        }

        function inferCountryFromDomain(domain = '', language = '') {
            const tld = domain.split('.').pop() || '';
            const ccMap = {
                br: 'BR', it: 'IT', fr: 'FR', de: 'DE', es: 'ES', pt: 'PT', ru: 'RU',
                cn: 'CN', jp: 'JP', uk: 'GB', us: 'US', ca: 'CA', au: 'AU', in: 'IN',
                nl: 'NL', pl: 'PL', ro: 'RO', tr: 'TR', mx: 'MX'
            };
            if (ccMap[tld]) return ccMap[tld];

            if (language.startsWith('pt-br')) return 'BR';
            if (language.startsWith('pt')) return 'PT';
            if (language.startsWith('zh')) return 'CN';
            if (language.startsWith('ja')) return 'JP';
            if (language.startsWith('ru')) return 'RU';
            if (language.startsWith('it')) return 'IT';
            if (language.startsWith('es')) return 'ES';
            return '';
        }

        function detectCmsFromHtml(html = '', url = '') {
            const lower = html.toLowerCase();
            const urlLower = String(url || '').toLowerCase();
            if (lower.includes('powered by ownd') || lower.includes('ameba ownd') || /(?:^|\/\/|\.)(shopinfo\.jp|themedia\.jp)\b/.test(urlLower)) {
                return 'ameba-ownd';
            }
            if (lower.includes('wp-content') || lower.includes('wp-includes') || lower.includes('wordpress')) return 'wordpress';
            if (lower.includes('woocommerce')) return 'woocommerce';
            if (lower.includes('shopify') || lower.includes('cdn.shopify.com')) return 'shopify';
            if (lower.includes('ghost/')) return 'ghost';
            if (lower.includes('webflow')) return 'webflow';
            if (lower.includes('wix.com') || lower.includes('wixstatic.com')) return 'wix';
            if (lower.includes('squarespace')) return 'squarespace';
            if (lower.includes('drupal-settings-json') || lower.includes('drupal')) return 'drupal';
            if (lower.includes('joomla')) return 'joomla';
            if (lower.includes('mediawiki')) return 'mediawiki';
            return '';
        }

        function detectSiteTypeFromHtml(html = '', url = '', sampleUrls = []) {
            const lower = html.toLowerCase();
            const joinedUrls = sampleUrls.join(' ').toLowerCase();
            const pathHints = `${url} ${joinedUrls}`.toLowerCase();

            if (lower.includes('commentform') || lower.includes('wp-comments-post') || lower.includes('leave a reply') || lower.includes('leave a comment')) {
                return 'blog';
            }
            if (lower.includes('phpbb') || lower.includes('vbulletin') || lower.includes('xenforo') || lower.includes('discourse')) {
                return 'forum';
            }
            if (lower.includes('mediawiki') || lower.includes('wiki')) {
                return 'wiki';
            }
            if (lower.includes('directory') || lower.includes('submit your site') || lower.includes('listing')) {
                return 'directory';
            }
            if (lower.includes('cart') || lower.includes('checkout') || lower.includes('product') || lower.includes('woocommerce') || lower.includes('shopify')) {
                return 'store';
            }
            if (pathHints.includes('/blog') || pathHints.includes('/news') || pathHints.includes('/article') || pathHints.includes('/post')) {
                return 'blog';
            }
            if (pathHints.includes('/tool') || pathHints.includes('/generator') || pathHints.includes('/calculator')) {
                return 'tool';
            }
            return 'website';
        }

        function detectTopicFromText(text = '') {
            const lower = text.toLowerCase();
            const topicRules = [
                ['gaming', /\b(game|gaming|roblox|minecraft|steam|xbox|playstation|wiki)\b/gi],
                ['tech', /\b(ai|tech|software|saas|cloud|developer|chrome extension|app)\b/gi],
                ['business', /\b(marketing|seo|business|startup|agency|analytics)\b/gi],
                ['finance', /\b(finance|loan|credit|bank|insurance|investment)\b/gi],
                ['health', /\b(health|clinic|doctor|fitness|medical|wellness)\b/gi],
                ['education', /\b(course|school|student|essay|education|learn)\b/gi],
                ['travel', /\b(travel|hotel|flight|destination|tour)\b/gi],
                ['entertainment', /\b(movie|music|streaming|iptv|tv|anime|celebrity)\b/gi],
                ['sports', /\b(football|soccer|nba|nfl|sport|tennis)\b/gi],
                ['gambling', /\b(casino|slot|bet|betting|poker|jackpot)\b/gi],
                ['adult', /\b(adult|porn|sex|escort)\b/gi]
            ];

            let bestTopic = 'general';
            let bestScore = 0;
            for (const [topic, pattern] of topicRules) {
                const matches = lower.match(pattern);
                const score = matches?.length || 0;
                if (score > bestScore) {
                    bestScore = score;
                    bestTopic = topic;
                }
            }

            return bestTopic;
        }

        function normalizeSourceTier(value = '') {
            const normalized = compactText(value).toLowerCase();
            return Object.values(sourceTiers).includes(normalized) ? normalized : '';
        }

        function getSourceTierScore(value = '') {
            return sourceTierScores[normalizeSourceTier(value)] || 0;
        }

        function preferHigherSourceTier(current = '', next = '') {
            return getSourceTierScore(next) > getSourceTierScore(current) ? normalizeSourceTier(next) : normalizeSourceTier(current);
        }

        function mergeSourceTierArrays(values = [], nextValues = [], limit = 5) {
            const merged = [];
            for (const value of [...(values || []), ...(nextValues || [])]) {
                const normalized = normalizeSourceTier(value);
                if (!normalized || merged.includes(normalized)) continue;
                merged.push(normalized);
            }
            return merged
                .sort((left, right) => getSourceTierScore(right) - getSourceTierScore(left))
                .slice(0, limit);
        }

        function buildDiscoveryEdge(tier = '', method = '', detail = '') {
            return compactText([
                normalizeSourceTier(tier),
                compactText(method),
                compactText(detail)
            ].filter(Boolean).join('|')).slice(0, 180);
        }

        function mergeDiscoveryEdges(values = [], nextValues = [], limit = 8) {
            const merged = [];
            for (const value of [...(values || []), ...(nextValues || [])]) {
                const normalized = compactText(value).slice(0, 180);
                if (!normalized || merged.includes(normalized)) continue;
                merged.push(normalized);
            }
            return merged.slice(0, limit);
        }

        function getResourcePublishedSuccessCount(resource = {}) {
            return Object.values(resource.publishHistory || {}).reduce((total, entry) => {
                return total + Number(entry?.attempts?.published || 0);
            }, 0) + (resource.status === 'published' ? 1 : 0);
        }

        function getResourceAnchorVerifiedCount(resource = {}) {
            let count = 0;
            if (resource.publishMeta?.anchorVisible) count += 1;
            for (const entry of Object.values(resource.publishHistory || {})) {
                if (entry?.publishMeta?.anchorVisible) count += 1;
            }
            return count;
        }

        function getEffectiveResourceSourceTier(resource = {}) {
            if (
                getResourcePublishedSuccessCount(resource) > 0
                || getResourceAnchorVerifiedCount(resource) > 0
                || resource.publishMeta?.commentFieldVerified
            ) {
                return sourceTiers.HISTORICAL_SUCCESS;
            }

            const candidates = [
                resource.sourceTier,
                resource.discoverySourceTier,
                ...(resource.sourceTiers || [])
            ];
            return mergeSourceTierArrays([], candidates, 1)[0] || '';
        }

        function summarizeSourceEvidenceFromEdges(edges = []) {
            const evidence = {
                historicalSuccess: 0,
                commentObserved: 0,
                competitorBacklink: 0,
                ruleGuess: 0,
                aiGuess: 0
            };

            for (const edge of edges || []) {
                const tier = normalizeSourceTier(String(edge || '').split('|')[0] || '');
                if (tier === sourceTiers.HISTORICAL_SUCCESS) evidence.historicalSuccess++;
                if (tier === sourceTiers.COMMENT_OBSERVED) evidence.commentObserved++;
                if (tier === sourceTiers.COMPETITOR_BACKLINK) evidence.competitorBacklink++;
                if (tier === sourceTiers.RULE_GUESS) evidence.ruleGuess++;
                if (tier === sourceTiers.AI_GUESS) evidence.aiGuess++;
            }

            return evidence;
        }

        function calculateDomainQualityScore(entry = {}, profile = {}) {
            let score = 10;
            const sources = new Set(entry.sources || []);

            score += Math.min((sources.size || 0) * 8, 24);
            score += Math.round(getSourceTierScore(entry.sourceTier || '') * 0.35);
            score += Math.min((entry.commentMentions || 0) * 4, 16);
            score += Math.min((entry.drilldownPages || 0) * 3, 15);
            score += Math.min((entry.commentOpportunityCount || 0) * 6, 18);
            score += Math.min((entry.publishSuccessCount || 0) * 10, 24);
            score += Math.min((entry.verifiedAnchorCount || 0) * 12, 24);
            score -= Math.min((entry.blockedPublishCount || 0) * 6, 18);

            if (profile.siteType === 'blog') score += 22;
            if (profile.siteType === 'forum') score += 16;
            if (profile.siteType === 'wiki') score += 10;
            if (profile.siteType === 'directory') score += 8;
            if (profile.siteType === 'store') score -= 8;
            if (profile.cms === 'wordpress') score += 6;
            if (profile.cms === 'ameba-ownd') score -= 16;
            if (profile.commentCapable) score += 12;
            if (profile.topic === 'gambling' || profile.topic === 'adult') score -= 18;
            if (sources.has('A')) score += 6;
            if (sources.has('M')) score += 4;
            if (sources.has('W')) score += 3;

            return Math.max(0, Math.min(100, Math.round(score)));
        }

        function buildDomainProfileFromHtml(url, html, hints = {}) {
            const title = html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1]?.trim()?.slice(0, 140) || '';
            const description = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1]?.trim()?.slice(0, 220) || '';
            const language = inferLanguageFromHtml(html);
            const cms = detectCmsFromHtml(html, url);
            const siteType = detectSiteTypeFromHtml(html, url, hints.sampleUrls || []);
            const pageText = html
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .slice(0, 5000);
            const topic = detectTopicFromText(`${title} ${description} ${pageText}`);
            const country = inferCountryFromDomain(getDomain(url), language);

            return {
                homepageUrl: url,
                title,
                description,
                language,
                country,
                cms,
                siteType,
                topic,
                commentCapable: /commentform|wp-comments-post|leave a reply|leave a comment/i.test(html),
                trafficLabel: hints.trafficLabel || '',
                profiledAt: new Date().toISOString()
            };
        }

        return {
            pushUniqueValue,
            mergeStringArrays,
            inferLanguageFromHtml,
            inferCountryFromDomain,
            detectCmsFromHtml,
            detectSiteTypeFromHtml,
            detectTopicFromText,
            normalizeSourceTier,
            getSourceTierScore,
            preferHigherSourceTier,
            mergeSourceTierArrays,
            buildDiscoveryEdge,
            mergeDiscoveryEdges,
            getResourcePublishedSuccessCount,
            getResourceAnchorVerifiedCount,
            getEffectiveResourceSourceTier,
            summarizeSourceEvidenceFromEdges,
            calculateDomainQualityScore,
            buildDomainProfileFromHtml
        };
    }

    globalScope.DomainProfileUtils = { create };
})(typeof self !== 'undefined' ? self : window);
