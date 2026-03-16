/**
 * Submify Seed Importer
 *
 * Imports data from the Submify backlinks JSON file and converts it into
 * seed resources and domain frontier entries for the backlink-analyzer pipeline.
 *
 * Factory: SubmifySeedImporter.create(deps) → instance with import/filter methods.
 */

/* global self */

const SubmifySeedImporter = {
    create(deps) {
        const {
            getDomain,
            normalizeUrl,
            SOURCE_TIERS,
            buildDiscoveryEdge
        } = deps;

        // ── category normalization ────────────────────────────────

        // Maps Submify link_category to UI workflow categories:
        //   'startup'   → Startup 发布列表
        //   'directory'  → 目录提交 (also General + vertical niches)
        //   'blog'       → 博客提交
        //   'community'  → 账号养护 (Social/Forum)
        //   'backlink'   → 直发外链 (General free-post sites)
        const CATEGORY_MAP = {
            // Startup 发布列表
            'startup':              'startup',
            'ai tools directory':   'startup',
            'saas':                 'startup',
            'mobile app':           'startup',
            'app directory':        'startup',
            'software directory':   'startup',
            'software':             'startup',
            'tools directory':      'startup',
            'product hunt':         'startup',
            'product forum':        'startup',
            // 博客提交
            'blog':                 'blog',
            'marketing':            'blog',
            'seo':                  'blog',
            'technology':           'blog',
            'wordpress plugin':     'blog',
            'podcast':              'blog',
            // 账号养护 (Social/Forum/Community)
            'social':               'community',
            'social media':         'community',
            'forum':                'community',
            'community':            'community',
            'reddit':               'community',
            'phone forum':          'community',
            'music forum':          'community',
            'sports forum':         'community',
            // 目录提交 (vertical niche directories)
            'directory':            'directory',
            'app':                  'directory',
            'reviews':              'directory',
            // General = 免费发帖/分类信息站 → 直发外链
            'general':              'backlink',
            'generalit':            'backlink'
        };

        // Vertical niche categories → 目录提交 (directory)
        const NICHE_CATEGORIES = new Set([
            'music', 'gaming', 'photography', 'sports', 'developers', 'developer',
            'books', 'design', 'desgin', 'education', 'educational', 'consumer', 'general consumer',
            'art', 'business', 'bussiness', 'doctor', 'medicine', 'health', 'fitness',
            'automobile', 'architecture', 'information', 'informational', 'entertainment',
            'science', 'food', 'search engine', 'travel', 'finance', 'trading',
            'scale model', 'anime', 'real estate', 'hosting', 'legal', 'gardening',
            'pet', 'fishing', 'construction', 'fashion', 'fasion', 'aviation',
            'agencies', 'cell phone', 'domains name', 'domains names', 'blockchain',
            'it security', 'religion', '3d printing', 'firearms', 'restaurant',
            'cannabis', 'website detection', 'public services', 'hunting', 'self improvement',
            'military', 'spirituality', 'advertising', 'shop', 'gambling',
            'home services', 'astronomy', 'company info', 'elderly care', 'lifestyle',
            'sofware'
        ]);

        function normalizeCategory(raw) {
            if (!raw) return 'backlink';
            const key = String(raw).trim().toLowerCase();
            if (CATEGORY_MAP[key]) return CATEGORY_MAP[key];
            if (NICHE_CATEGORIES.has(key)) return 'directory';
            return 'backlink';
        }

        // ── opportunity mapping ───────────────────────────────────

        function opportunitiesForCategory(category) {
            switch (category) {
                case 'startup':    return ['submit-site', 'listing'];
                case 'directory':  return ['submit-site', 'listing'];
                case 'blog':      return ['comment'];
                case 'community': return ['form', 'register'];
                case 'backlink':  return ['comment', 'form'];
                default:          return ['comment'];
            }
        }

        function resourceClassForCategory(category) {
            switch (category) {
                case 'blog':      return 'blog-comment';
                case 'backlink':  return 'blog-comment';
                case 'community': return 'profile';
                default:          return 'profile';
            }
        }

        // Map to workflow IDs used in your task system
        function workflowForCategory(category) {
            switch (category) {
                case 'startup':    return 'directory-submit-promote';
                case 'directory':  return 'directory-submit-promote';
                case 'blog':      return 'community-post-promote';
                case 'community': return 'account-nurture';
                case 'backlink':  return 'blog-comment-backlink';
                default:          return 'blog-comment-backlink';
            }
        }

        // ── public methods ────────────────────────────────────────

        /**
         * Convert raw Submify JSON array into normalized entries.
         */
        function parseSubmifyData(jsonArray) {
            if (!Array.isArray(jsonArray)) return [];

            const entries = [];
            for (const item of jsonArray) {
                if (!item || !item.link) continue;

                const url = normalizeUrl(item.link);
                const domain = getDomain(url);
                if (!domain) continue;

                entries.push({
                    url,
                    domain,
                    name:       item.name || domain,
                    tags:       Array.isArray(item.tags) ? item.tags : [],
                    isPaid:     Boolean(item.is_paid),
                    category:   normalizeCategory(item.link_category),
                    dr:         typeof item.dr === 'number' ? item.dr : null,
                    language:   item.language || 'English',
                    tips:       item.tips || '',
                    submifyId:  item.id || '',
                    sourceType: 'submify-seed'
                });
            }

            return entries;
        }

        /**
         * Convert parsed entries into domain intel items suitable for
         * domainIntel.recordIntel().
         */
        function buildDomainIntelItems(entries) {
            return entries.map(entry => ({
                url:            entry.url,
                domain:         entry.domain,
                sourceType:     'submify-seed',
                sourceTier:     'competitor-backlink',
                sourceTiers:    ['competitor-backlink'],
                discoveryEdges: [buildDiscoveryEdge('competitor-backlink', 'submify-import', entry.url)],
                sources:        ['submify']
            }));
        }

        /**
         * Convert parsed entries into resource entries suitable for direct
         * storage in the resource store.
         */
        function buildResourceEntries(entries) {
            return entries.map(entry => {
                // Only blog category goes into blog-comment workflow as main pool.
                // 'backlink' (General/classified sites) and directories need agent-based
                // submission, so they go to legacy pool until the agent workflow is ready.
                const isBlogComment = entry.category === 'blog';
                const isDirectoryLike = entry.category === 'backlink' || entry.category === 'startup' || entry.category === 'directory';
                const isCommunity = entry.category === 'community';

                let resourceClass, frictionLevel, directPublishReady, resourcePool, resourcePoolReason;

                if (isBlogComment) {
                    resourceClass = 'blog-comment';
                    frictionLevel = entry.isPaid ? 'high' : 'low';
                    directPublishReady = !entry.isPaid;
                    resourcePool = entry.isPaid ? 'legacy' : 'main';
                    resourcePoolReason = entry.isPaid ? 'submify_blog_paid' : 'submify_verified_blog';
                } else if (isDirectoryLike) {
                    resourceClass = 'profile';
                    frictionLevel = 'medium';
                    directPublishReady = false;
                    resourcePool = 'legacy';
                    resourcePoolReason = 'submify_directory_needs_agent';
                } else if (isCommunity) {
                    resourceClass = 'profile';
                    frictionLevel = 'medium';
                    directPublishReady = false;
                    resourcePool = 'legacy';
                    resourcePoolReason = 'submify_community_needs_nurture';
                } else {
                    resourceClass = 'profile';
                    frictionLevel = 'medium';
                    directPublishReady = false;
                    resourcePool = 'legacy';
                    resourcePoolReason = 'submify_other';
                }

                return {
                    id:               `submify-${entry.submifyId}`,
                    url:              entry.url,
                    pageTitle:        entry.name,
                    opportunities:    opportunitiesForCategory(entry.category),
                    linkModes:        isBlogComment ? ['website-field'] : ['website-field'],
                    details:          [
                        'submify-verified',
                        `category:${entry.category}`,
                        `dr:${entry.dr != null ? entry.dr : '?'}`,
                        entry.tips
                    ].filter(Boolean).concat(isBlogComment ? ['inline-submit-form'] : []),
                    sources:          ['submify'],
                    sourceTier:       'competitor-backlink',
                    sourceTiers:      ['competitor-backlink'],
                    discoveryEdges:   [buildDiscoveryEdge('competitor-backlink', 'submify-import', entry.url)],
                    resourceClass,
                    frictionLevel,
                    directPublishReady,
                    hasUrlField:      isBlogComment,
                    resourcePool,
                    resourcePoolReason,
                    status:           'pending',
                    submifySeed:      true,
                    submifyCategory:  entry.category,
                    submifyWorkflow:  workflowForCategory(entry.category),
                    submifyDr:        entry.dr,
                    submifyLanguage:  entry.language
                };
            });
        }

        /**
         * Return entries for 直发外链 workflow (General free-post sites + blogs):
         * - category is 'backlink' or 'blog'
         * - NOT paid
         */
        function filterForBacklinkSeeds(entries) {
            return entries.filter(entry => {
                if (entry.category !== 'backlink' && entry.category !== 'blog') return false;
                return !entry.isPaid;
            });
        }

        /**
         * Return entries for Startup 发布列表:
         * - category is 'startup'
         */
        function filterForStartupSeeds(entries, { includePaid = false } = {}) {
            return entries.filter(entry => {
                if (entry.category !== 'startup') return false;
                return includePaid || !entry.isPaid;
            });
        }

        /**
         * Return entries for 目录提交:
         * - category is 'directory'
         */
        function filterForDirectorySeeds(entries, { includePaid = false } = {}) {
            return entries.filter(entry => {
                if (entry.category !== 'directory') return false;
                return includePaid || !entry.isPaid;
            });
        }

        /**
         * Return entries for 博客提交:
         * - category is 'blog'
         */
        function filterForBlogSeeds(entries) {
            return entries.filter(entry => entry.category === 'blog' && !entry.isPaid);
        }

        /**
         * Return entries for 账号养护:
         * - category is 'community'
         */
        function filterForNurtureSeeds(entries) {
            return entries.filter(entry => entry.category === 'community');
        }

        /**
         * Return summary statistics grouped by UI workflow categories.
         */
        function getSeedStats(entries) {
            let startups = 0;
            let directories = 0;
            let blogs = 0;
            let communities = 0;
            let backlinks = 0;
            let paid = 0;
            let free = 0;
            let withDr = 0;
            let drSum = 0;

            for (const entry of entries) {
                if (entry.category === 'startup')    startups++;
                if (entry.category === 'directory')  directories++;
                if (entry.category === 'blog')       blogs++;
                if (entry.category === 'community')  communities++;
                if (entry.category === 'backlink')   backlinks++;
                if (entry.isPaid) paid++; else free++;
                if (entry.dr != null) {
                    withDr++;
                    drSum += entry.dr;
                }
            }

            return {
                total:       entries.length,
                startups,
                directories,
                blogs,
                communities,
                backlinks,
                paid,
                free,
                withDr,
                avgDr:       withDr > 0 ? Math.round(drSum / withDr) : null
            };
        }

        // ── public interface ──────────────────────────────────────

        return {
            parseSubmifyData,
            buildDomainIntelItems,
            buildResourceEntries,
            filterForBacklinkSeeds,
            filterForStartupSeeds,
            filterForDirectorySeeds,
            filterForBlogSeeds,
            filterForNurtureSeeds,
            getSeedStats,
            workflowForCategory
        };
    }
};

self.SubmifySeedImporter = SubmifySeedImporter;
