/**
 * CropAI – Smart Crop (Mode 1: Bounding Box)
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses Sharp to crop the image to the bounding box returned by the vision AI.
 * Adds a small configurable padding around the detected region.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const sharp = require('sharp');

/**
 * smartCrop
 * Crops the source image to the AI-specified bounding box and saves as PNG.
 *
 * @param {object} params
 * @param {string} params.imagePath  - Absolute path to source image
 * @param {object} params.aiResult   - Validated AI response object
 * @param {string} params.outputPath - Absolute path for the output PNG
 * @param {number} [params.padding]  - Optional pixel padding around the box (default: 10)
 */
async function smartCrop({ imagePath, aiResult, outputPath, padding = 0 }) {
  const { bounding_box } = aiResult;

  if (!bounding_box) {
    throw new Error('AI result is missing bounding_box for smart crop.');
  }

  // Get original image dimensions
  const meta = await sharp(imagePath).metadata();
  const { width: imgW, height: imgH } = meta;

  // Apply padding and clamp to image boundaries
  const left   = Math.max(0, Math.round(bounding_box.x) - padding);
  const top    = Math.max(0, Math.round(bounding_box.y) - padding);
  const right  = Math.min(imgW, Math.round(bounding_box.x + bounding_box.width)  + padding);
  const bottom = Math.min(imgH, Math.round(bounding_box.y + bounding_box.height) + padding);

  const cropWidth  = right - left;
  const cropHeight = bottom - top;

  if (cropWidth <= 0 || cropHeight <= 0) {
    throw new Error('Bounding box resulted in an invalid crop region.');
  }

  console.log(`[smartCrop] Cropping region: x=${left}, y=${top}, w=${cropWidth}, h=${cropHeight}`);

  await sharp(imagePath)
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .png({ compressionLevel: 8 })
    .toFile(outputPath);

  console.log(`[smartCrop] Output saved: ${outputPath}`);
}

module.exports = { smartCrop };
