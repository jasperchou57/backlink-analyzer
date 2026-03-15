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
                        const normalizeUrl = (value) => String(value || '')
                            .trim()
                            .toLowerCase()
                            .replace(/^https?:\/\//, '')
                            .replace(/^www\./, '')
                            .replace(/\/+$/, '');
                        const getCommentBlockSelector = () => 'li, article, .comment, .comment-body, .commentlist li, .comment-content, .comment_container, .comments-area article, .comments-area li';
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

                        const targetUrl = normalizeUrl(payload.anchorUrl || '');
                        const anchorText = normalizeText(payload.anchorText || '');
                        const commenterName = normalizeText(payload.commenterName || '');
                        const commentPreviewTokens = buildCommentPreviewTokens(payload.commentPreview || '');
                        const pageTextRaw = String(document.body?.innerText || '').trim();
                        const pageText = normalizeText(pageTextRaw);
                        const pageUrl = String(window.location.href || '');
                        const pageUrlLower = pageUrl.toLowerCase();
                        const pagePath = String(window.location.pathname || '').toLowerCase();

                        const anchors = Array.from(document.querySelectorAll('a[href]'));
                        const matchingAnchors = anchors.filter((anchor) => {
                            const href = normalizeUrl(anchor.getAttribute('href') || anchor.href || '');
                            const text = normalizeText(anchor.textContent || '');
                            const hrefMatches = targetUrl && (href === targetUrl || href.includes(targetUrl) || targetUrl.includes(href));
                            const textMatches = !anchorText || text.includes(anchorText);
                            return hrefMatches && textMatches;
                        });

                        const relatedAnchor = commenterName
                            ? (matchingAnchors.find((anchor) => {
                                const block = anchor.closest(getCommentBlockSelector());
                                return normalizeText(block?.textContent || '').includes(commenterName);
                            }) || null)
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
                                if (commenterName && text.includes(commenterName)) score += 5;
                                if (commentPreviewTokens.some((token) => token && text.includes(token))) score += 6;
                                if (targetUrl) {
                                    const localAnchors = Array.from(block.querySelectorAll('a[href]'));
                                    if (localAnchors.some((anchor) => {
                                        const href = normalizeUrl(anchor.getAttribute('href') || anchor.href || '');
                                        return href && (href === targetUrl || href.includes(targetUrl) || targetUrl.includes(href));
                                    })) {
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

                        return {
                            anchorVisible: !!relatedAnchor,
                            anchorCount: matchingAnchors.length,
                            anchorText: relatedAnchor ? String(relatedAnchor.textContent || '').trim() : '',
                            anchorHref: relatedAnchor ? String(relatedAnchor.getAttribute('href') || relatedAnchor.href || '') : '',
                            commenterMatched: !!relatedAnchor && !!commenterName,
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
