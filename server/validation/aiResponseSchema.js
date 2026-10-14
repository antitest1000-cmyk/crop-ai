/**
 * CropAI – AI Response JSON Schema Validator
 * ─────────────────────────────────────────────────────────────────────────────
 * Validates that the AI response conforms to the expected schema before
 * it is used in any downstream processing.
 *
 * SECURITY: Never execute or eval anything from the AI response.
 * Only structured data fields are extracted.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

/**
 * Validates a bounding box object.
 */
function isValidBoundingBox(bb) {
  if (!bb || typeof bb !== 'object') return false;
  const fields = ['x', 'y', 'width', 'height'];
  return fields.every(f => typeof bb[f] === 'number' && isFinite(bb[f]) && bb[f] >= 0);
}

/**
 * Validates an option object (used in ambiguous responses).
 */
function isValidOption(opt) {
  if (!opt || typeof opt !== 'object') return false;
  return (
    typeof opt.label === 'string' &&
    typeof opt.description === 'string' &&
    isValidBoundingBox(opt.bounding_box)
  );
}

/**
 * validateAIResponse
 * ─────────────────────────────────────────────────────────────────────────────
 * @param {*} response - The parsed object from the vision AI
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateAIResponse(response) {
  const errors = [];

  // Must be an object
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { valid: false, errors: ['Response must be a JSON object.'] };
  }

  // Required: "found" boolean
  if (typeof response.found !== 'boolean') {
    errors.push('"found" must be a boolean.');
  }

  // Required: "ambiguous" boolean
  if (typeof response.ambiguous !== 'boolean') {
    errors.push('"ambiguous" must be a boolean.');
  }

  // Required: "target" string
  if (typeof response.target !== 'string' || response.target.trim().length === 0) {
    errors.push('"target" must be a non-empty string.');
  }

  // Required: "confidence" number 0-1
  if (typeof response.confidence !== 'number' || response.confidence < 0 || response.confidence > 1) {
    errors.push('"confidence" must be a number between 0 and 1.');
  }

  // If found and not ambiguous: bounding_box required
  if (response.found && !response.ambiguous) {
    if (!isValidBoundingBox(response.bounding_box)) {
      errors.push('"bounding_box" must have numeric x, y, width, height fields (all >= 0).');
    }

    // requires_segmentation must be boolean
    if (typeof response.requires_segmentation !== 'boolean') {
      // Tolerate undefined – default to false
      response.requires_segmentation = false;
    }
  }

  // If ambiguous: must have options array
  if (response.ambiguous) {
    if (!Array.isArray(response.options) || response.options.length < 2) {
      errors.push('"options" must be an array with at least 2 entries when ambiguous.');
    } else {
      response.options.forEach((opt, i) => {
        if (!isValidOption(opt)) {
          errors.push(`options[${i}] is missing required fields (label, description, bounding_box).`);
        }
      });
    }
    if (typeof response.clarification_message !== 'string') {
      errors.push('"clarification_message" must be a string when ambiguous.');
    }
  }

  // Sanitize string fields – remove any suspicious content
  const stringFields = ['target', 'instruction', 'clarification_message', 'segmentation_hint'];
  stringFields.forEach(field => {
    if (typeof response[field] === 'string') {
      // Strip HTML tags and control characters
      response[field] = response[field]
        .replace(/<[^>]*>/g, '')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .substring(0, 1000); // Cap length
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = { validateAIResponse };
