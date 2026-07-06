'use strict';

const mongoose = require('mongoose');

// One entry per successful staff mutation (admin panel, mod actions,
// board-mod panel). Powers the admin Changelog page so staff can see who
// changed what without asking each other.
const auditLogSchema = new mongoose.Schema({
  accountId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Account', default: null },
  actorLabel: { type: String, default: 'unknown' },  // ##tripcode or admin:<id>
  actorRole:  { type: String, default: '' },         // admin / mod / janitor / board-mod
  method:     { type: String },                      // POST / PUT / DELETE
  path:       { type: String },                      // request path (router-relative)
  area:       { type: String },                      // admin / mod / manage
  summary:    { type: String, default: '' }          // human-readable details
}, { timestamps: true });

auditLogSchema.index({ createdAt: -1 });
// Keep six months of history
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
