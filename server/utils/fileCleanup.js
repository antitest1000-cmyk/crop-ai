/**
 * CropAI – File Cleanup Utility
 * ─────────────────────────────────────────────────────────────────────────────
 * Schedules automatic deletion of temporary upload and output files.
 * Uses Node.js timers – no external dependencies required.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// Track scheduled cleanups so we can cancel if needed
const scheduledCleanups = new Map();

/**
 * scheduleCleanup
 * Schedule a file for deletion after the specified TTL.
 *
 * @param {string} filePath - Absolute path to the file
 * @param {number} ttlMs    - Time to live in milliseconds
 */
function scheduleCleanup(filePath, ttlMs) {
  // Cancel any existing timer for this path
  if (scheduledCleanups.has(filePath)) {
    clearTimeout(scheduledCleanups.get(filePath));
  }

  const timer = setTimeout(() => {
    cleanupFile(filePath);
    scheduledCleanups.delete(filePath);
  }, ttlMs);

  // Don't prevent Node from exiting just because of cleanup timers
  if (timer.unref) timer.unref();

  scheduledCleanups.set(filePath, timer);
  console.log(`[cleanup] Scheduled: ${path.basename(filePath)} (TTL: ${ttlMs / 1000}s)`);
}

/**
 * cleanupFile
 * Immediately delete a file if it exists.
 *
 * @param {string} filePath - Absolute path to the file
 */
function cleanupFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[cleanup] Deleted: ${path.basename(filePath)}`);
    }
  } catch (err) {
    // Non-fatal – log and continue
    console.warn(`[cleanup] Failed to delete ${path.basename(filePath)}: ${err.message}`);
  }
}

/**
 * cleanupOldFiles
 * On startup, remove any leftover temp files older than the TTL.
 * Call this when the server starts.
 *
 * @param {string[]} directories - Array of directory paths to scan
 * @param {number}   ttlMs       - Files older than this are deleted
 */
function cleanupOldFiles(directories, ttlMs) {
  const now = Date.now();
  directories.forEach(dir => {
    if (!fs.existsSync(dir)) return;
    try {
      const files = fs.readdirSync(dir);
      files.forEach(file => {
        const filePath = path.join(dir, file);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > ttlMs) {
            fs.unlinkSync(filePath);
            console.log(`[startup-cleanup] Removed stale file: ${file}`);
          }
        } catch (e) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
  });
}

module.exports = { scheduleCleanup, cleanupFile, cleanupOldFiles };
