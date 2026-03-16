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

        const CATEGORY_MAP = {
            'startup':      'directory',
            'ai tool':      'directory',
            'saas':         'directory',
            'directory':    'directory',
            'product hunt': 'directory',
            'app':          'directory',
            'blog':         'blog',
            'news':         'blog',
            'media':        'blog',
            'forum':        'community',
            'community':    'community',
            'reddit':       'community',
            'social':       'community'
        };

        function normalizeCategory(raw) {
            if (!raw) return 'other';
            const key = String(raw).trim().toLowerCase();
            return CATEGORY_MAP[key] || 'other';
        }

        // ── opportunity mapping ───────────────────────────────────

        function opportunitiesForCategory(category) {
            switch (category) {
                case 'directory':  return ['submit-site', 'listing'];
                case 'blog':      return ['comment'];
                case 'community': return ['form'];
                default:          return ['submit-site'];
            }
        }

        function resourceClassForCategory(category) {
            switch (category) {
                case 'blog':  return 'blog-comment';
                default:      return 'profile';
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
            return entries.map(entry => ({
                id:               `submify-${entry.submifyId}`,
                url:              entry.url,
                pageTitle:        entry.name,
                opportunities:    opportunitiesForCategory(entry.category),
                linkModes:        ['website-field'],
                details:          [
                    'submify-verified',
                    `category:${entry.category}`,
                    `dr:${entry.dr != null ? entry.dr : '?'}`,
                    entry.tips
                ].filter(Boolean),
                sources:          ['submify'],
                sourceTier:       'competitor-backlink',
                sourceTiers:      ['competitor-backlink'],
                discoveryEdges:   [buildDiscoveryEdge('competitor-backlink', 'submify-import', entry.url)],
                resourceClass:    resourceClassForCategory(entry.category),
                frictionLevel:    entry.isPaid ? 'high' : 'medium',
                status:           'pending',
                submifySeed:      true,
                submifyCategory:  entry.category,
                submifyDr:        entry.dr,
                submifyLanguage:  entry.language
            }));
        }

        /**
         * Return entries useful for Stage 1 (blog comment backlinks):
         * - category is 'blog'
         * - NOT paid
         * - domain looks like it could have comments (has a path or known blog platform)
         */
        function filterForBlogCommentSeeds(entries) {
            return entries.filter(entry => {
                if (entry.category !== 'blog') return false;
                if (entry.isPaid) return false;

                // Heuristic: domains with paths beyond root, or known blogging
                // platforms, are more likely to have comment sections.
                try {
                    const parsed = new URL(entry.url);
                    const hasPath = parsed.pathname && parsed.pathname !== '/';
                    const bloggyDomain = /blog|medium|wordpress|ghost|substack|hashnode|dev\.to|write/i
                        .test(entry.domain);
                    return hasPath || bloggyDomain;
                } catch (_) {
                    return false;
                }
            });
        }

        /**
         * Return entries useful for Stage 2 (directory submission):
         * - category is 'directory' or 'community'
         * - NOT paid by default; pass includePaid=true to include paid entries
         */
        function filterForDirectorySeeds(entries, { includePaid = false } = {}) {
            return entries.filter(entry => {
                if (entry.category !== 'directory' && entry.category !== 'community') return false;
                if (!includePaid && entry.isPaid) return false;
                return true;
            });
        }

        /**
         * Return summary statistics for a set of parsed entries.
         */
        function getSeedStats(entries) {
            let directories = 0;
            let blogs = 0;
            let communities = 0;
            let paid = 0;
            let free = 0;
            let withDr = 0;
            let drSum = 0;

            for (const entry of entries) {
                if (entry.category === 'directory')  directories++;
                if (entry.category === 'blog')       blogs++;
                if (entry.category === 'community')  communities++;
                if (entry.isPaid) paid++; else free++;
                if (entry.dr != null) {
                    withDr++;
                    drSum += entry.dr;
                }
            }

            return {
                total:       entries.length,
                directories,
                blogs,
                communities,
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
            filterForBlogCommentSeeds,
            filterForDirectorySeeds,
            getSeedStats
        };
    }
};

self.SubmifySeedImporter = SubmifySeedImporter;
