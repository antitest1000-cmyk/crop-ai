/**
 * CropAI – Smart Extract (Mode 2: Transparent Background / Segmentation)
 * ─────────────────────────────────────────────────────────────────────────────
 * ADAPTER PATTERN:
 *   The segmentationProvider object defines the interface.
 *   Swap the provider by changing the implementation below, not the calling code.
 *
 * Currently supported providers (set SEGMENTATION_PROVIDER in .env):
 *   • "none"        – Falls back to a refined bounding-box crop with transparency note
 *   • "replicate"   – Uses Replicate.com (e.g. SAM, REMBG models)
 *   • "huggingface" – Uses Hugging Face Inference API (e.g. BRIA RMBG)
 *
 * When a full segmentation provider IS configured, the pipeline:
 *   1. Crops the bounding-box region
 *   2. Sends it to the segmentation API
 *   3. Receives a mask (binary / alpha)
 *   4. Composites the mask onto the cropped region → transparent PNG
 *
 * When NO provider is configured (SEGMENTATION_PROVIDER=none):
 *   Falls back to bounding-box crop (Mode 1) with an informational note.
 *   This is NOT fake functionality – it is an intentional graceful degradation.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const sharp = require('sharp');
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const { spawn } = require('child_process');

// ─── Segmentation Provider Adapter Interface ──────────────────────────────────

/**
 * segmentationProvider
 * ─────────────────────────────────────────────────────────────────────────────
 * Public interface. Replace `impl` below to swap the backend provider.
 * Each provider must implement: segment(imageBuffer, hint) → Buffer (alpha mask PNG)
 */
const segmentationProvider = {
  /**
   * @param {Buffer} imageBuffer  - The cropped region (PNG buffer)
   * @param {string} hint         - Short text describing the target object
   * @returns {Promise<Buffer>}   - Alpha mask PNG (white = keep, black = remove)
   */
  async segment(imageBuffer, hint) {
    const provider = (process.env.SEGMENTATION_PROVIDER || 'none').toLowerCase();

    if (provider === 'replicate') {
      return segmentWithReplicate(imageBuffer, hint);
    }
    if (provider === 'huggingface') {
      return segmentWithHuggingFace(imageBuffer, hint);
    }
    if (provider === 'local_python') {
      return segmentWithLocalPython(imageBuffer, hint);
    }

    // "none" or unrecognized – return null to trigger fallback
    return null;
  },
};

// ─── Provider Implementations ─────────────────────────────────────────────────

/**
 * Replicate provider – uses BRIA RMBG-1.4 (background removal model)
 * https://replicate.com/briaai/rmbg-1.4
 */
async function segmentWithReplicate(imageBuffer, hint) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error('REPLICATE_API_TOKEN is not set.');

  // Convert buffer to base64 data URL for Replicate
  const base64Image = imageBuffer.toString('base64');
  const dataUrl     = `data:image/png;base64,${base64Image}`;

  // Start prediction
  const startRes = await axios.post(
    'https://api.replicate.com/v1/predictions',
    {
      version: 'e809cddc666ccfd38a044f795cf65baab62eedc4273d096bf05935b6b0e6e218', // RMBG-1.4
      input:   { image: dataUrl },
    },
    {
      headers: {
        'Authorization': `Token ${token}`,
        'Content-Type':  'application/json',
      },
      timeout: 30_000,
    }
  );

  const predictionId = startRes.data.id;
  if (!predictionId) throw new Error('Replicate: failed to start prediction.');

  // Poll for completion
  let attempts = 0;
  while (attempts < 30) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await axios.get(
      `https://api.replicate.com/v1/predictions/${predictionId}`,
      { headers: { 'Authorization': `Token ${token}` }, timeout: 15_000 }
    );

    const { status, output, error } = pollRes.data;
    if (status === 'succeeded' && output) {
      // Download the mask image
      const maskRes = await axios.get(output, { responseType: 'arraybuffer', timeout: 15_000 });
      return Buffer.from(maskRes.data);
    }
    if (status === 'failed') throw new Error(`Replicate segmentation failed: ${error}`);
    attempts++;
  }

  throw new Error('Replicate segmentation timed out.');
}

/**
 * HuggingFace provider – uses BRIA RMBG or similar inference endpoint
 * https://huggingface.co/briaai/RMBG-1.4
 */
async function segmentWithHuggingFace(imageBuffer, hint) {
  const token = process.env.HUGGINGFACE_API_TOKEN;
  if (!token) throw new Error('HUGGINGFACE_API_TOKEN is not set.');

  const response = await axios.post(
    'https://api-inference.huggingface.co/models/briaai/RMBG-1.4',
    imageBuffer,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'image/png',
      },
      responseType: 'arraybuffer',
      timeout: 60_000,
    }
  );

  return Buffer.from(response.data);
}

/**
 * Local Python provider – uses rembg library locally via child_process
 */
async function segmentWithLocalPython(imageBuffer, hint) {
  return new Promise((resolve, reject) => {
    const pythonCmd = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
    const pythonProcess = spawn(pythonCmd, [path.join(__dirname, 'remove_bg.py')]);
    
    let maskData = [];
    let errData = [];
    
    pythonProcess.stdout.on('data', (data) => maskData.push(data));
    pythonProcess.stderr.on('data', (data) => errData.push(data));
    
    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python rembg failed: ${Buffer.concat(errData).toString()}`));
      } else {
        resolve(Buffer.concat(maskData));
      }
    });

    pythonProcess.stdin.on('error', (err) => {
      console.error('[smartExtract] python stdin error:', err.message);
    });
    
    // Write image buffer to python stdin
    pythonProcess.stdin.write(imageBuffer);
    pythonProcess.stdin.end();
  });
}

// ─── Main Extract Function ────────────────────────────────────────────────────

/**
 * smartExtract
 * ─────────────────────────────────────────────────────────────────────────────
 * Attempts pixel-level object extraction using the configured segmentation provider.
 * Falls back to bounding-box crop if no provider is configured or if segmentation fails.
 *
 * @param {object} params
 * @param {string} params.imagePath  - Absolute path to the source image
 * @param {object} params.aiResult   - Validated AI response with bounding_box
 * @param {string} params.outputPath - Absolute path for the output PNG (transparent)
 */
async function smartExtract({ imagePath, aiResult, outputPath }) {
  const { bounding_box, segmentation_hint, target } = aiResult;

  if (!bounding_box) {
    throw new Error('AI result is missing bounding_box for smart extract.');
  }

  // Get image metadata
  const meta = await sharp(imagePath).metadata();
  const { width: imgW, height: imgH } = meta;

  // Clamp bounding box
  const left   = Math.max(0, Math.round(bounding_box.x));
  const top    = Math.max(0, Math.round(bounding_box.y));
  const right  = Math.min(imgW, Math.round(bounding_box.x + bounding_box.width));
  const bottom = Math.min(imgH, Math.round(bounding_box.y + bounding_box.height));
  const cropW  = right - left;
  const cropH  = bottom - top;

  if (cropW <= 0 || cropH <= 0) {
    throw new Error('Bounding box resulted in an invalid region.');
  }

  // Extract the bounding-box region as PNG buffer
  const croppedBuffer = await sharp(imagePath)
    .extract({ left, top, width: cropW, height: cropH })
    .png()
    .toBuffer();

  const hint = segmentation_hint || target || 'the main object';

  // ── Attempt segmentation ──────────────────────────────────────────────────
  let maskBuffer = null;
  try {
    maskBuffer = await segmentationProvider.segment(croppedBuffer, hint);
  } catch (segErr) {
    console.warn(`[smartExtract] Segmentation failed, falling back to bbox crop: ${segErr.message}`);
    maskBuffer = null;
  }

  if (maskBuffer) {
    if ((process.env.SEGMENTATION_PROVIDER || '').toLowerCase() === 'local_python') {
      // local_python returns the fully transparent image, not just a mask
      console.log('[smartExtract] Saving python transparent output...');
      await sharp(maskBuffer)
        .png({ compressionLevel: 8 })
        .toFile(outputPath);
      console.log(`[smartExtract] Transparent PNG saved: ${outputPath}`);
    } else {
      // ── Apply alpha mask to remove background ──────────────────────────────
      // The mask is white (255) where we keep the object, black (0) where transparent
      console.log('[smartExtract] Applying segmentation mask...');

      // Resize mask to match crop dimensions if needed
      const resizedMask = await sharp(maskBuffer)
        .resize(cropW, cropH)
        .grayscale()
        .toBuffer();

      // Extract alpha channel from mask and apply to the cropped image
      await sharp(croppedBuffer)
        .ensureAlpha()
        .composite([{
          input: resizedMask,
          blend: 'dest-in', // mask controls what's visible
        }])
        .png({ compressionLevel: 8 })
        .toFile(outputPath);

      console.log(`[smartExtract] Transparent PNG saved: ${outputPath}`);
    }
  } else {
    // ── Fallback: Save bounding-box crop with note ─────────────────────────
    // This is honest fallback, not fake segmentation.
    // We save the bounding-box crop as-is (no transparency).
    console.log('[smartExtract] No segmentation provider configured. Using bounding-box fallback.');

    await sharp(croppedBuffer)
      .png({ compressionLevel: 8 })
      .toFile(outputPath);

    console.log(`[smartExtract] Fallback bbox crop saved: ${outputPath}`);

    // Attach a flag so the server can inform the frontend
    aiResult._segmentationFallback = true;
  }
}

module.exports = { smartExtract, segmentationProvider };
