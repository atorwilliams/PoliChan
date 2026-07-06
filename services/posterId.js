'use strict';

const crypto = require('crypto');

/**
 * Per-thread poster IDs, 4chan-style. The ID is a short hash of the poster's
 * (already HMAC-hashed) IP plus the thread it appears in, so it is stable
 * within one thread but different in every other thread: posts by the same
 * person are linkable inside a thread, but posters cannot be tracked across
 * threads or boards.
 */
function posterId(ipHashValue, boardUri, threadId) {
  if (!ipHashValue) return null;
  return crypto.createHash('sha256')
    .update(`${ipHashValue}:${boardUri}:${threadId}`)
    .digest('base64url')
    .slice(0, 8);
}

/**
 * Public projection of a post/thread doc: drops the ip hash (which would let
 * anyone correlate a poster site-wide) and attaches the per-thread posterId.
 */
function withPosterId(doc, boardUri, threadId) {
  const { ip, ...pub } = doc;
  // Capcode (## Mod) posts carry no ID: it would link a staff member's
  // official posts to their anonymous ones in the same thread
  pub.posterId = doc.isModPost ? null : posterId(ip, boardUri, threadId);
  // Poll voter lists are hashed IPs too; the client only needs the tallies
  if (pub.poll?.voters) {
    pub.poll = { ...pub.poll, voters: undefined };
  }
  return pub;
}

module.exports = { posterId, withPosterId };
