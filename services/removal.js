'use strict';

/**
 * Public-facing stub for a soft-removed post: keeps its place in the thread
 * (id, timestamps, backlink quotes) but drops body, media, and identity.
 */
function stubPost(p) {
  return {
    _id:       p._id,
    boardUri:  p.boardUri,
    threadId:  p.threadId,
    postId:    p.postId,
    createdAt: p.createdAt,
    quotes:    p.quotes || [],
    isRemoved: true,
    stubbed:   true,  // explicit marker — body can be legitimately empty (image-only posts)
    removedReason: p.removedReason,
    body: '', bodyHtml: null, media: null,
    name: '', tripcode: null, flair: null, flairColor: null, flairBgColor: null
  };
}

function isStaffSession(session) {
  return !!(session?.isAdmin || ['mod', 'janitor'].includes(session?.staffRole));
}

module.exports = { stubPost, isStaffSession };
