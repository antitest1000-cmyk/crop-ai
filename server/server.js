/**
 * CropAI – Main Express Server
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *   • Image upload & validation (multer)
 *   • Forwarding image + prompt to vision AI (OpenRouter)
 *   • Parsing and validating the structured AI response
 *   • Dispatching to the correct extraction mode (smart crop / smart extract)
 *   • Returning processed images to the frontend
 *   • Automatic temp-file cleanup
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const compression  = require('compression');
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');
const { v4: uuidv4 } = require('uuid');
const rateLimit    = require('express-rate-limit');

const { analyzeImage }      = require('./ai/visionAnalyzer');
const { smartCrop }         = require('./image/smartCrop');
const { smartExtract }      = require('./image/smartExtract');
const { validateAIResponse} = require('./validation/aiResponseSchema');
const { scheduleCleanup, cleanupFile, cleanupOldFiles } = require('./utils/fileCleanup');

// ─── App Setup ───────────────────────────────────────────────────────────────

const app  = express();
const PORT = process.env.PORT || 3000;

// Directory paths
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const OUTPUTS_DIR = path.join(__dirname, '..', 'outputs');

// Ensure directories exist
[UPLOADS_DIR, OUTPUTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Clean up stale files from previous server sessions
cleanupOldFiles([UPLOADS_DIR, OUTPUTS_DIR], parseInt(process.env.FILE_TTL_MS, 10) || 3_600_000);

// ─── Security Middleware ──────────────────────────────────────────────────────

app.use(compression());

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
    },
  },
}));

const ALLOWED_ORIGINS = [
  'https://crop-ai.antitest1000.workers.dev',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || 
        ALLOWED_ORIGINS.includes('*') || 
        ALLOWED_ORIGINS.includes(origin) || 
        origin.endsWith('.workers.dev') || 
        origin.endsWith('.pages.dev')) {
      return cb(null, true);
    }
    return cb(null, true); // Allow all web origins for the public API
  }
}));
app.use(express.json({ limit: '1mb' }));

// Rate limiting – 60 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests – please wait a moment.' },
});
app.use('/api/', limiter);

// ─── Health Check (required by Render) ───────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Canonical URL Redirect: Redirect /page.html -> /page and /index.html -> /
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const pathName = req.path;
  if (pathName.endsWith('.html')) {
    if (pathName === '/index.html') {
      return res.redirect(301, '/');
    }
    return res.redirect(301, pathName.slice(0, -5));
  }
  next();
});

// Serve static frontend with long-lived cache for assets
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '1d',
  etag: true,
  setHeaders: (res, filePath) => {
    // No caching for HTML pages
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
    // Prevent indexing of uploads/outputs
    if (filePath.includes('/uploads/') || filePath.includes('/outputs/')) {
      res.setHeader('X-Robots-Tag', 'noindex');
    }
  },
}));

// Serve output images (outside public/, needs its own route)
app.use('/outputs', (req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex');
  next();
}, express.static(OUTPUTS_DIR));

// ─── Page Routes (clean URLs) ────────────────────────────────────────────────

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const pages = [
  { path: '/app',                              file: 'app.html' },
  { path: '/privacy',                          file: 'privacy.html' },
  { path: '/terms',                            file: 'terms.html' },
  { path: '/about',                            file: 'about.html' },
  { path: '/contact',                          file: 'contact.html' },
  { path: '/faq',                              file: 'faq.html' },
  { path: '/crop-image-by-text',               file: 'crop-image-by-text.html' },
  { path: '/background-remover',               file: 'background-remover.html' },
  { path: '/extract-object-from-image',        file: 'extract-object-from-image.html' },
  { path: '/product-photo-background-remover', file: 'product-photo-background-remover.html' },
  { path: '/youtube-thumbnail-cutout',         file: 'youtube-thumbnail-cutout.html' },
  { path: '/profile-picture-cropper',          file: 'profile-picture-cropper.html' },
  { path: '/sticker-maker',                    file: 'sticker-maker.html' },
];

pages.forEach(({ path: route, file }) => {
  app.get(route, (req, res) => {
    const filePath = path.join(PUBLIC_DIR, file);
    if (fs.existsSync(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(filePath);
    } else {
      res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'), () => {
        res.status(404).send('Page not found');
      });
    }
  });
});

// ─── Sitemap ─────────────────────────────────────────────────────────────────

app.get('/sitemap.xml', (req, res) => {
  const baseUrl = process.env.BASE_URL || 'https://cropai.app';
  const now = new Date().toISOString().split('T')[0];
  // /app is intentionally excluded (noindex tool page)
  const urls = [
    { loc: '/',                                priority: '1.0', changefreq: 'weekly' },
    { loc: '/crop-image-by-text',               priority: '0.9', changefreq: 'weekly' },
    { loc: '/background-remover',               priority: '0.9', changefreq: 'weekly' },
    { loc: '/product-photo-background-remover', priority: '0.8', changefreq: 'weekly' },
    { loc: '/extract-object-from-image',        priority: '0.8', changefreq: 'weekly' },
    { loc: '/youtube-thumbnail-cutout',         priority: '0.8', changefreq: 'monthly' },
    { loc: '/profile-picture-cropper',          priority: '0.8', changefreq: 'monthly' },
    { loc: '/sticker-maker',                    priority: '0.8', changefreq: 'monthly' },
    { loc: '/faq',                              priority: '0.8', changefreq: 'monthly' },
    { loc: '/about',                            priority: '0.7', changefreq: 'monthly' },
    { loc: '/contact',                          priority: '0.5', changefreq: 'yearly' },
    { loc: '/privacy',                          priority: '0.4', changefreq: 'yearly' },
    { loc: '/terms',                            priority: '0.4', changefreq: 'yearly' },
  ];
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map(u => [
      '  <url>',
      `    <loc>${baseUrl}${u.loc}</loc>`,
      `    <lastmod>${now}</lastmod>`,
      `    <changefreq>${u.changefreq}</changefreq>`,
      `    <priority>${u.priority}</priority>`,
      '  </url>',
    ].join('\n')),
    '</urlset>',
  ].join('\n');
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(xml);
});

// ─── Multer Configuration ─────────────────────────────────────────────────────

const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE, 10) || 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `upload_${uuidv4()}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Unsupported file type. Please upload PNG, JPG, or WEBP.'), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
});

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /api/upload
 * Uploads an image and returns a temporary fileId.
 * The original image is preserved server-side for the duration of the session.
 */
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided.' });
    }

    const fileId = path.parse(req.file.filename).name.replace('upload_', ''); // uuid portion

    // Auto-delete after TTL
    scheduleCleanup(req.file.path, parseInt(process.env.FILE_TTL_MS, 10) || 3_600_000);

    // Read basic image metadata via Sharp
    const sharp = require('sharp');
    const meta  = await sharp(req.file.path).metadata();

    return res.json({
      success: true,
      fileId,
      filename: req.file.filename,
      width:    meta.width,
      height:   meta.height,
      format:   meta.format,
      size:     req.file.size,
    });
  } catch (err) {
    console.error('[upload]', err.message);
    return res.status(500).json({ error: 'Failed to process uploaded image.' });
  }
});

/**
 * POST /api/crop
 * Main pipeline:
 *   1. Receive fileId + prompt (+ optional previousResult for refinement)
 *   2. Ask vision AI to locate the target
 *   3. Validate the AI response
 *   4. Crop (Mode 1) or Extract with segmentation (Mode 2)
 *   5. Return the output image path + metadata
 */
app.post('/api/crop', async (req, res) => {
  const { fileId, prompt, previousResult } = req.body;

  // ── Input validation ──────────────────────────────────────────────────────
  if (!fileId || typeof fileId !== 'string' || !/^[a-f0-9-]{36}$/.test(fileId)) {
    return res.status(400).json({ error: 'Invalid or missing fileId.' });
  }
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'Please provide a description of what to crop.' });
  }
  if (prompt.trim().length > 500) {
    return res.status(400).json({ error: 'Prompt is too long (max 500 characters).' });
  }

  // ── Locate source image ───────────────────────────────────────────────────
  const extensions = ['.png', '.jpg', '.jpeg', '.webp'];
  let imagePath = null;

  for (const ext of extensions) {
    const candidate = path.join(UPLOADS_DIR, `upload_${fileId}${ext}`);
    if (fs.existsSync(candidate)) { imagePath = candidate; break; }
  }

  if (!imagePath) {
    return res.status(404).json({ error: 'Image not found. Please re-upload your image.' });
  }

  // ── Check API key ─────────────────────────────────────────────────────────
  if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY.startsWith('your_')) {
    return res.status(503).json({
      error: 'Vision AI is not configured. Please set OPENROUTER_API_KEY in your .env file.',
    });
  }

  try {
    // ── Step 1: Ask vision AI ───────────────────────────────────────────────
    console.log(`[crop] Analyzing image for prompt: "${prompt.trim()}"`);

    const aiResult = await analyzeImage({
      imagePath,
      prompt: prompt.trim(),
      previousResult: previousResult || null,
    });

    // ── Step 2: Validate AI response ────────────────────────────────────────
    const validation = validateAIResponse(aiResult);
    if (!validation.valid) {
      console.error('[crop] Invalid AI response:', validation.errors);
      return res.status(422).json({ error: 'AI returned an unexpected response. Please try again.' });
    }

    // ── Step 3: Handle ambiguity ────────────────────────────────────────────
    if (aiResult.ambiguous) {
      return res.json({
        ambiguous: true,
        message:   aiResult.clarification_message,
        options:   aiResult.options || [],
      });
    }

    // ── Step 4: No object found ─────────────────────────────────────────────
    if (!aiResult.found) {
      return res.json({
        found: false,
        message: aiResult.clarification_message || "I couldn't find that object in the image.",
      });
    }

    // ── Step 5: Crop or Extract ─────────────────────────────────────────────
    const outputId   = uuidv4();
    const outputPath = path.join(OUTPUTS_DIR, `result_${outputId}.png`);
    let   mode       = 'crop';

    if (aiResult.requires_segmentation || req.body.removeBg) {
      // Mode 2 – Smart Extract (transparent background)
      mode = 'extract';
      await smartExtract({ imagePath, aiResult, outputPath });
    } else {
      // Mode 1 – Smart Crop (bounding box)
      await smartCrop({ imagePath, aiResult, outputPath });
    }

    // Schedule output cleanup
    scheduleCleanup(outputPath, parseInt(process.env.FILE_TTL_MS, 10) || 3_600_000);

    // Read output metadata
    const sharp    = require('sharp');
    const outMeta  = await sharp(outputPath).metadata();

    return res.json({
      success:      true,
      mode,
      outputId,
      outputUrl:    `/outputs/result_${outputId}.png`,
      target:       aiResult.target,
      confidence:   aiResult.confidence,
      boundingBox:  aiResult.bounding_box,
      instruction:  aiResult.instruction,
      width:        outMeta.width,
      height:       outMeta.height,
    });

  } catch (err) {
    console.error('[crop] Pipeline error:', err.message);

    // User-safe error messages
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Image file not found. Please re-upload.' });
    }
    if (err.message?.includes('credits') || err.message?.includes('quota') || err.status === 402) {
      return res.status(402).json({ error: 'OpenRouter credit limit reached. Please check your credits at openrouter.ai.' });
    }
    if (err.message?.includes('API key')) {
      return res.status(503).json({ error: 'AI service is unavailable. Check your API key.' });
    }
    if (err.message?.includes('rate limit') || err.status === 429) {
      return res.status(429).json({ error: 'AI service rate limit reached. Please wait.' });
    }

    if (err.message?.includes('safety filters')) {
      return res.status(422).json({ error: err.message });
    }

    return res.status(500).json({ error: err.message || 'Processing failed. Please try again.' });
  }
});

/**
 * POST /api/crop-direct
 * Fast path for extracting known bounding boxes without calling AI.
 */
app.post('/api/crop-direct', async (req, res) => {
  const { fileId, boundingBox, removeBg } = req.body;

  if (!fileId || typeof fileId !== 'string' || !/^[a-f0-9-]{36}$/.test(fileId)) {
    return res.status(400).json({ error: 'Invalid or missing fileId.' });
  }
  if (!boundingBox || typeof boundingBox.x !== 'number') {
    return res.status(400).json({ error: 'Missing or invalid bounding box.' });
  }

  // Locate source image
  const extensions = ['.png', '.jpg', '.jpeg', '.webp'];
  let imagePath = null;
  for (const ext of extensions) {
    const candidate = path.join(UPLOADS_DIR, `upload_${fileId}${ext}`);
    if (fs.existsSync(candidate)) { imagePath = candidate; break; }
  }
  if (!imagePath) {
    return res.status(404).json({ error: 'Image not found. Please re-upload.' });
  }

  try {
    const outputId   = uuidv4();
    const outputPath = path.join(OUTPUTS_DIR, `result_${outputId}.png`);
    let   mode       = 'crop';

    const aiResult = { bounding_box: boundingBox, requires_segmentation: removeBg || false };

    if (aiResult.requires_segmentation) {
      mode = 'extract';
      await smartExtract({ imagePath, aiResult, outputPath });
    } else {
      await smartCrop({ imagePath, aiResult, outputPath });
    }

    scheduleCleanup(outputPath, parseInt(process.env.FILE_TTL_MS, 10) || 3_600_000);

    const sharp    = require('sharp');
    const outMeta  = await sharp(outputPath).metadata();

    return res.json({
      success:      true,
      mode,
      outputId,
      outputUrl:    `/outputs/result_${outputId}.png`,
      width:        outMeta.width,
      height:       outMeta.height,
    });
  } catch (err) {
    console.error('[crop-direct]', err.message);
    return res.status(500).json({ error: 'Processing failed.' });
  }
});

/**
 * POST /api/adjust
 * Refine a previous crop/extraction using a follow-up instruction.
 * Simply routes to the same handler as /api/crop – the frontend passes
 * previousResult in the body for context-aware re-analysis.
 */
app.post('/api/adjust', (req, res, next) => {
  // Delegate directly to the /api/crop handler (same logic)
  req.url = '/api/crop';
  app.handle(req, res, next);
});

/**
 * GET /api/download/:outputId/:format
 * Download a result as PNG or JPG.
 */
app.get('/api/download/:outputId/:format', async (req, res) => {
  const { outputId, format } = req.params;

  // Validate params
  if (!/^[a-f0-9-]{36}$/.test(outputId)) {
    return res.status(400).json({ error: 'Invalid output ID.' });
  }
  if (!['png', 'jpg'].includes(format)) {
    return res.status(400).json({ error: 'Format must be png or jpg.' });
  }

  const sourcePath = path.join(OUTPUTS_DIR, `result_${outputId}.png`);
  if (!fs.existsSync(sourcePath)) {
    return res.status(404).json({ error: 'Result not found. It may have expired.' });
  }

  try {
    const sharp = require('sharp');
    let pipeline = sharp(sourcePath);

    if (format === 'jpg') {
      pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: 92 });
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Disposition', `attachment; filename="cropai_result.jpg"`);
    } else {
      pipeline = pipeline.png({ compressionLevel: 8 });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', `attachment; filename="cropai_result.png"`);
    }

    pipeline.pipe(res);
  } catch (err) {
    console.error('[download]', err.message);
    return res.status(500).json({ error: 'Download failed.' });
  }
});

/**
 * GET /api/health
 * Health check endpoint.
 */
app.get('/api/health', (req, res) => {
  const hasApiKey = !!(
    process.env.OPENROUTER_API_KEY &&
    !process.env.OPENROUTER_API_KEY.startsWith('your_')
  );
  res.json({
    status: 'ok',
    apiConfigured: hasApiKey,
    model: process.env.VISION_MODEL || 'not set',
    segmentation: process.env.SEGMENTATION_PROVIDER || 'none',
  });
});

// ─── 404 Handler ─────────────────────────────────────────────────────────────

app.use((req, res) => {
  if (req.accepts('html')) {
    const notFoundPath = path.join(PUBLIC_DIR, '404.html');
    if (fs.existsSync(notFoundPath)) {
      return res.status(404).sendFile(notFoundPath);
    }
    return res.status(404).send('Page not found');
  }
  return res.status(404).json({ error: 'Endpoint not found' });
});

// ─── Error Handling ───────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    const maxMB = (MAX_FILE_SIZE / 1024 / 1024).toFixed(0);
    return res.status(413).json({ error: `File too large. Maximum size is ${maxMB} MB.` });
  }
  if (err.message?.includes('Unsupported file type')) {
    return res.status(415).json({ error: err.message });
  }

  console.error('[server error]', err.message);
  return res.status(500).json({ error: 'An unexpected error occurred.' });
});

// ─── Start Server ─────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 CropAI server running at http://localhost:${PORT}`);
  console.log(`   Vision model : ${process.env.VISION_MODEL || 'not configured'}`);
  console.log(`   Segmentation : ${process.env.SEGMENTATION_PROVIDER || 'none'}`);
  const hasKey = process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_API_KEY.startsWith('your_');
  console.log(`   API key      : ${hasKey ? '✅ configured' : '❌ MISSING – set OPENROUTER_API_KEY in .env'}`);
  console.log('');
});

module.exports = app;
