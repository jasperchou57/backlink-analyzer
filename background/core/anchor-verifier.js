/**
 * Anchor Verifier
 *
 * Verifies whether a published comment anchor is visible on a page.
 * Runs chrome.scripting.executeScript with retry logic to detect
 * anchor presence, moderation status, and submission blocks.
 */

/* global self, chrome */

const AnchorVerifier = {
    async verify(tabId, options = {}, deps = {}) {
        const { delay } = deps;
        let lastResult = null;

        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                await delay(attempt === 0 ? 1500 : 2500);
                const results = await chrome.scripting.executeScript({
                    target: { tabId },
                    func: (payload) => {
                        const normalizeText = (value) => String(value || '')
                            .normalize('NFD')
                            .replace(/[\u0300-\u036f]/g, '')
                            .replace(/\s+/g, ' ')
                            .trim()
                            .toLowerCase();
                        // 严格 URL 解析：返回 { host, path, ok }。
                        // 以前用 normalizeUrl + 双向 includes 做匹配，会把 example.com 误配到
                        // not-example.com、example.com.attacker.net 等。现在用 hostname 完全相等
                        // + pathname 前缀匹配（目标 path 必须是 href path 的完整前缀）。
                        const parseAnchorUrl = (value) => {
                            const raw = String(value || '').trim();
                            if (!raw) return { host: '', path: '', ok: false };
                            try {
                                const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
                                const u = new URL(withScheme);
                                const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
                                return {
                                    host: u.hostname.replace(/^www\./i, '').toLowerCase(),
                                    path: path.toLowerCase(),
                                    ok: true
                                };
                            } catch {
                                return { host: '', path: '', ok: false };
                            }
                        };
                        const hrefMatchesTarget = (rawHref, target) => {
                            if (!target.ok || !target.host) return false;
                            const parsed = parseAnchorUrl(rawHref);
                            if (!parsed.ok || !parsed.host) return false;
                            if (parsed.host !== target.host) return false;
                            // target 指向根路径时，同 host 任意页面都算命中
                            if (target.path === '/' || !target.path) return true;
                            if (parsed.path === target.path) return true;
                            return parsed.path.startsWith(target.path + '/');
                        };
                        // 解析 rel，识别 nofollow / ugc / sponsored。以前完全不读 rel，
                        // 导致 nofollow 被当成 dofollow 计入成功率，SEO KPI 失真。
                        const readAnchorRel = (anchor) => {
                            if (!anchor) return { rel: '', tokens: [], isNofollow: false };
                            const rel = String(anchor.getAttribute('rel') || anchor.rel || '').trim();
                            if (!rel) return { rel: '', tokens: [], isNofollow: false };
                            const tokens = rel.toLowerCase().split(/\s+/).filter(Boolean);
                            return {
                                rel,
                                tokens,
                                isNofollow: tokens.includes('nofollow') || tokens.includes('ugc') || tokens.includes('sponsored')
                            };
                        };
                        const getCommentBlockSelector = () => 'li, article, .comment, .comment-body, .commentlist li, .comment-content, .comment_container, .comments-area article, .comments-area li';
                        // 提取评论块里的作者文本（评论人名），而不是整条块的全部文本。
                        // 以前用整块 textContent.includes(commenterName) 做匹配，
                        // 任何评论里提到作者名字（比如回复里 @John）都会误命中。
                        const getAuthorTextOfBlock = (block) => {
                            if (!block) return '';
                            const el = block.querySelector('.comment-author, .fn, cite, [itemprop="author"]');
                            return normalizeText(el?.textContent || '');
                        };
                        const isVisible = (el) => {
                            if (!el) return false;
                            const rect = el.getBoundingClientRect?.();
                            return !!rect && rect.width > 0 && rect.height > 0;
                        };
                        const buildCommentPreviewTokens = (value) => {
                            const normalized = normalizeText(value || '');
                            if (!normalized) return [];
                            const tokens = normalized
                                .split(/[.!?。！？]/)
                                .map((item) => item.trim())
                                .filter((item) => item.length >= 18)
                                .map((item) => item.slice(0, 120));
                            if (tokens.length > 0) {
                                return Array.from(new Set(tokens)).slice(0, 3);
                            }
                            return [normalized.slice(0, 120)].filter(Boolean);
                        };
                        const clearReviewMarkers = () => {
                            document.querySelectorAll('[data-bla-review-target="1"]').forEach((node) => {
                                node.removeAttribute('data-bla-review-target');
                                node.style.outline = '';
                                node.style.outlineOffset = '';
                                node.style.backgroundColor = '';
                                node.style.scrollMarginTop = '';
                            });
                        };

                        const target = parseAnchorUrl(payload.anchorUrl || '');
                        const anchorText = normalizeText(payload.anchorText || '');
                        const commenterName = normalizeText(payload.commenterName || '');
                        // 名字太短（<3 字符）不参与块定位，否则 a/b/li 这种缩写会到处撞
                        const commenterNameSafe = commenterName.length >= 3 ? commenterName : '';
                        const commentPreviewTokens = buildCommentPreviewTokens(payload.commentPreview || '');
                        const pageTextRaw = String(document.body?.innerText || '').trim();
                        const pageText = normalizeText(pageTextRaw);
                        const pageUrl = String(window.location.href || '');
                        const pageUrlLower = pageUrl.toLowerCase();
                        const pagePath = String(window.location.pathname || '').toLowerCase();

                        const anchors = Array.from(document.querySelectorAll('a[href]'));
                        const matchingAnchors = anchors.filter((anchor) => {
                            const text = normalizeText(anchor.textContent || '');
                            const hrefMatches = hrefMatchesTarget(
                                anchor.getAttribute('href') || anchor.href || '',
                                target
                            );
                            const textMatches = !anchorText || text.includes(anchorText);
                            return hrefMatches && textMatches;
                        });

                        const relatedAnchor = commenterNameSafe
                            ? (matchingAnchors.find((anchor) => {
                                const block = anchor.closest(getCommentBlockSelector());
                                const author = getAuthorTextOfBlock(block);
                                if (!author) return false;
                                return author.includes(commenterNameSafe) || commenterNameSafe.includes(author);
                            }) || matchingAnchors[0] || null)
                            : (matchingAnchors[0] || null);
                        const commentBlocks = Array.from(document.querySelectorAll(getCommentBlockSelector()))
                            .filter((block) => isVisible(block))
                            .filter((block, index, list) => list.indexOf(block) === index);
                        const anchorBlock = relatedAnchor?.closest(getCommentBlockSelector()) || null;
                        const scoredBlocks = commentBlocks
                            .map((block) => {
                                const text = normalizeText(block.textContent || '');
                                let score = 0;
                                if (!text) return { block, score: 0, excerpt: '' };
                                if (anchorBlock && block === anchorBlock) score += 10;
                                // 作者名只在评论作者字段（.comment-author/.fn/cite）里查，
                                // 不再对整块 textContent 做子串匹配
                                if (commenterNameSafe) {
                                    const author = getAuthorTextOfBlock(block);
                                    if (author && (author.includes(commenterNameSafe) || commenterNameSafe.includes(author))) {
                                        score += 5;
                                    }
                                }
                                if (commentPreviewTokens.some((token) => token && text.includes(token))) score += 6;
                                if (target.ok) {
                                    const localAnchors = Array.from(block.querySelectorAll('a[href]'));
                                    if (localAnchors.some((anchor) =>
                                        hrefMatchesTarget(anchor.getAttribute('href') || anchor.href || '', target)
                                    )) {
                                        score += 4;
                                    }
                                }
                                return {
                                    block,
                                    score,
                                    excerpt: String(block.textContent || '').trim().slice(0, 220)
                                };
                            })
                            .sort((left, right) => right.score - left.score);
                        const locatedBlock = anchorBlock || scoredBlocks.find((entry) => entry.score >= 6)?.block || null;
                        const locationMethod = anchorBlock
                            ? 'anchor-block'
                            : (locatedBlock ? 'comment-block' : '');
                        if (locatedBlock) {
                            clearReviewMarkers();
                            locatedBlock.setAttribute('data-bla-review-target', '1');
                            locatedBlock.style.outline = '3px solid #14d39a';
                            locatedBlock.style.outlineOffset = '6px';
                            locatedBlock.style.backgroundColor = 'rgba(20, 211, 154, 0.08)';
                            locatedBlock.style.scrollMarginTop = '120px';
                            try {
                                locatedBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            } catch {}
                        }
                        const websiteFieldBlockedFirstComment =
                            pageText.includes('not permitted to submit a website address')
                            && pageText.includes('delete the website in the website field');
                        const reviewPendingPatterns = [
                            {
                                reason: 'moderated',
                                test: () => pageUrlLower.includes('unapproved=')
                                    && pageUrlLower.includes('moderation-hash=')
                            },
                            {
                                reason: 'moderated',
                                test: () => pageText.includes('your comment is awaiting moderation')
                                    || pageText.includes('comment is awaiting moderation')
                                    || pageText.includes('held for moderation')
                            },
                            {
                                reason: 'moderated',
                                test: () => pageText.includes('awaiting approval')
                                    || pageText.includes('pending approval')
                                    || pageText.includes('pending moderation')
                            },
                            {
                                reason: 'moderated',
                                test: () => pageText.includes('评论正在等待审核')
                                    || pageText.includes('评论正在审核')
                                    || pageText.includes('审核后显示')
                                    || pageText.includes('留言正在审核')
                            },
                            {
                                reason: 'moderated',
                                test: () => pageText.includes('votre commentaire est en attente de moderation')
                                    || pageText.includes('votre commentaire est en attente de modération')
                                    || pageText.includes('en attente de moderation')
                                    || pageText.includes('en attente de modération')
                                    || pageText.includes('sera visible apres validation')
                                    || pageText.includes('sera visible après validation')
                                    || pageText.includes('apercu, votre commentaire sera visible apres validation')
                                    || pageText.includes('aperçu, votre commentaire sera visible après validation')
                            }
                        ];
                        const submissionBlockedPatterns = [
                            {
                                reason: 'comment_rate_limited',
                                test: () =>
                                    pagePath.includes('wp-comments-post.php') &&
                                    (pageText.includes('comentarios rapido demais') ||
                                        pageText.includes('comentarios rapido de mais') ||
                                        pageText.includes('calma ai') ||
                                        pageText.includes('calma ai.'))
                            },
                            {
                                reason: 'comment_rate_limited',
                                test: () => pageText.includes('posting comments too quickly') || pageText.includes('comments too quickly')
                            },
                            {
                                reason: 'comment_rate_limited',
                                test: () => pageText.includes('you are posting comments too fast') || pageText.includes('slow down')
                            },
                            {
                                reason: 'duplicate_comment',
                                test: () => pageText.includes('duplicate comment detected') || pageText.includes('looks as though you have already said that')
                            },
                            {
                                reason: 'comment_submission_blocked',
                                test: () => pagePath.includes('wp-comments-post.php')
                                    && !websiteFieldBlockedFirstComment
                                    && !relatedAnchor
                                    && !locatedBlock
                            }
                        ];
                        const submissionBlockedMatch = submissionBlockedPatterns.find((pattern) => {
                            try {
                                return pattern.test();
                            } catch {
                                return false;
                            }
                        });
                        const reviewPendingMatch = reviewPendingPatterns.find((pattern) => {
                            try {
                                return pattern.test();
                            } catch {
                                return false;
                            }
                        });

                        const relInfo = readAnchorRel(relatedAnchor);
                        return {
                            anchorVisible: !!relatedAnchor,
                            anchorCount: matchingAnchors.length,
                            anchorText: relatedAnchor ? String(relatedAnchor.textContent || '').trim() : '',
                            anchorHref: relatedAnchor ? String(relatedAnchor.getAttribute('href') || relatedAnchor.href || '') : '',
                            anchorRel: relInfo.rel,
                            anchorRelTokens: relInfo.tokens,
                            anchorIsNofollow: relInfo.isNofollow,
                            anchorIsDofollow: !!relatedAnchor && !relInfo.isNofollow,
                            commenterMatched: !!relatedAnchor && !!commenterNameSafe,
                            commentLocated: !!locatedBlock,
                            commentLocationMethod: locationMethod,
                            commentExcerpt: locatedBlock ? String(locatedBlock.textContent || '').trim().slice(0, 220) : '',
                            websiteFieldBlockedFirstComment,
                            reviewPending: !!reviewPendingMatch,
                            reviewPolicy: reviewPendingMatch?.reason || '',
                            submissionBlocked: !!submissionBlockedMatch,
                            submissionBlockReason: submissionBlockedMatch?.reason || '',
                            noticeExcerpt: (websiteFieldBlockedFirstComment || submissionBlockedMatch || reviewPendingMatch)
                                ? pageTextRaw.slice(0, 280)
                                : '',
                            pageUrl
                        };
                    },
                    args: [options]
                });

                lastResult = results?.[0]?.result || null;
                if (
                    lastResult?.anchorVisible
                    || lastResult?.commentLocated
                    || lastResult?.websiteFieldBlockedFirstComment
                    || lastResult?.submissionBlocked
                    || lastResult?.reviewPending
                ) {
                    return lastResult;
                }
            } catch {}
        }

        return lastResult;
    }
};

self.AnchorVerifier = AnchorVerifier;
