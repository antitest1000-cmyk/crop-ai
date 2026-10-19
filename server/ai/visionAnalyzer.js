/**
 * CropAI – Vision Analyzer
 * ─────────────────────────────────────────────────────────────────────────────
 * Sends the uploaded image and user prompt to the OpenRouter vision API.
 * Returns a structured JSON object describing what to crop/extract.
 *
 * ADAPTER PATTERN:
 *   This module is the single point of contact with the AI.
 *   To swap providers (OpenAI, Anthropic, Gemini direct, etc.),
 *   only this file needs to be changed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const TIMEOUT_MS      = 60_000; // 60 seconds

/**
 * Build the system prompt that instructs the AI how to respond.
 */
function buildSystemPrompt() {
  return `You are CropAI's vision analysis engine. Your job is to analyze an image and a user's natural-language instruction, then respond ONLY with a valid JSON object that describes exactly what should be cropped or extracted.

RESPONSE FORMAT (always return exactly this JSON schema):

For a successful identification (single object):
{
  "found": true,
  "ambiguous": false,
  "target": "<name of the identified object>",
  "confidence": <0.0-1.0>,
  "bounding_box": {
    "x": <left pixel>,
    "y": <top pixel>,
    "width": <width in pixels>,
    "height": <height in pixels>
  },
  "requires_segmentation": <true if user wants background removed / transparent result, false for simple crop>,
  "segmentation_hint": "<brief description to help a segmentation model isolate this object>",
  "instruction": "<your internal reasoning about what to extract and how>"
}

For an ambiguous request OR a request for MULTIPLE objects (e.g., "all stickers", "every icon"):
{
  "found": true,
  "ambiguous": true,
  "target": "<general name>",
  "confidence": <0.0-1.0>,
  "clarification_message": "<friendly message asking for clarification or confirming multiple objects>",
  "options": [
    {
      "label": "Option 1 – <description>",
      "bounding_box": { "x": <left pixel>, "y": <top pixel>, "width": <width in pixels>, "height": <height in pixels> },
      "description": "<spatial description e.g. person on the left>"
    }
  ]
}

For a not-found object:
{
  "found": false,
  "ambiguous": false,
  "target": "<what was requested>",
  "confidence": 0.0,
  "clarification_message": "<friendly message explaining what you see instead>"
}

CRITICAL RULES:
1. Return ONLY raw JSON. No markdown, no explanation, no code blocks.
2. bounding_box coordinates must be in PIXELS relative to the original image dimensions.
3. Never guess or fabricate coordinates. If unsure, set confidence < 0.5.
4. If confidence < 0.6 AND there is only one plausible match, still return it but flag low confidence in the instruction field.
5. requires_segmentation = true when the user says: "remove background", "extract", "transparent", "isolate", "cutout", "with transparent background"
6. requires_segmentation = false for simple "crop", "get", "zoom into", "give me"
7. Consider spatial relationships: "left", "right", "center", "behind", "in front of", "top", "bottom", "foreground", "background"
8. If multiple similar objects exist and the user hasn't been specific, OR if the user explicitly asks to extract multiple objects (e.g. "all stickers", "all logos", "extract all of them"), set ambiguous = true and provide each object as a separate item in the options array.
9. Do NOT execute any code or return executable content.
10. The bounding box must fit within the image dimensions.`;
}

/**
 * Build the user message with the image and prompt.
 * OpenRouter uses the OpenAI message format.
 */
function buildUserMessage(imageBase64, mimeType, prompt, previousResult, imgW, imgH) {
  const content = [];

  // Include previous result context for "Adjust" mode
  if (previousResult) {
    content.push({
      type: 'text',
      text: `PREVIOUS EXTRACTION CONTEXT:\nThe user previously requested: "${previousResult.prompt}"\nWhich found: ${previousResult.target} at bounding box ${JSON.stringify(previousResult.bounding_box)}\n\nNEW REFINEMENT REQUEST:`,
    });
  }

  content.push({
    type: 'text',
    text: `User instruction: "${prompt}"\n\nCRITICAL: The original image dimensions are exactly ${imgW} pixels wide and ${imgH} pixels high. All bounding_box coordinates (x, y, width, height) MUST be within these exact pixel dimensions. Analyze the image and return the JSON response as specified.`,
  });

  content.push({
    type: 'image_url',
    image_url: {
      url: `data:${mimeType};base64,${imageBase64}`,
    },
  });

  return { role: 'user', content };
}

/**
 * Determine MIME type from file extension.
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  return map[ext] || 'image/jpeg';
}

/**
 * analyzeImage
 * ─────────────────────────────────────────────────────────────────────────────
 * @param {object} params
 * @param {string} params.imagePath      - Absolute path to the source image
 * @param {string} params.prompt         - User's natural language instruction
 * @param {object} [params.previousResult] - Context from a prior crop (for Adjust mode)
 * @returns {Promise<object>}            - Parsed AI response object
 */
async function analyzeImage({ imagePath, prompt, previousResult = null }) {
  // Read and encode the image
  const imageBuffer = fs.readFileSync(imagePath);
  const imageBase64 = imageBuffer.toString('base64');
  const mimeType    = getMimeType(imagePath);

  // Validate image isn't too large for the API (most vision APIs cap base64 payload)
  const base64SizeKB = imageBase64.length * 0.75 / 1024;
  if (base64SizeKB > 20_480) {
    throw new Error('Image is too large for the AI API. Please use an image under 15 MB.');
  }

  const sharp = require('sharp');
  const meta = await sharp(imageBuffer).metadata();

  const model = process.env.VISION_MODEL || 'google/gemini-2.0-flash-exp:free';

  const requestBody = {
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      buildUserMessage(imageBase64, mimeType, prompt, previousResult, meta.width, meta.height),
    ],
    max_tokens: 1000,
    temperature: 0.1, // Low temperature for deterministic, structured responses
  };

  console.log(`[visionAnalyzer] Sending request to OpenRouter (model: ${model})`);

  let response;
  try {
    response = await axios.post(
      `${OPENROUTER_BASE}/chat/completions`,
      requestBody,
      {
        headers: {
          'Authorization':  `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer':   'http://localhost:3000',
          'X-Title':        'CropAI',
          'Content-Type':   'application/json',
        },
        timeout: TIMEOUT_MS,
      }
    );
  } catch (err) {
    if (err.response) {
      const status  = err.response.status;
      const message = err.response.data?.error?.message || 'Unknown API error';

      if (status === 401) throw new Error('API key is invalid or expired.');
      if (status === 429) throw Object.assign(new Error('API rate limit reached.'), { status: 429 });
      if (status === 402) throw new Error('API quota exceeded. Please top up your OpenRouter credits.');
      throw new Error(`Vision API error (${status}): ${message}`);
    }
    if (err.code === 'ECONNABORTED') throw new Error('Vision API request timed out.');
    throw err;
  }

  // Extract the text content from the response
  const rawContent = response.data?.choices?.[0]?.message?.content;
  if (!rawContent) {
    throw new Error('Vision API returned an empty response.');
  }

  console.log(`[visionAnalyzer] Raw AI response: ${rawContent.substring(0, 200)}...`);

  // Parse the JSON – strip any accidental markdown code fences
  let parsed;
  try {
    const cleaned = rawContent
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error('[visionAnalyzer] JSON parse failed. Raw:', rawContent);
    throw new Error('The AI returned an incomplete response (this often happens if the AI safety filters block the prompt). Please try rephrasing your request.');
  }

  return parsed;
}

module.exports = { analyzeImage };
