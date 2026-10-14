const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const imgDir = path.join(__dirname, '..', 'public', 'img');
if (!fs.existsSync(imgDir)) {
  fs.mkdirSync(imgDir, { recursive: true });
}

// User provided images
const userImages = [
  'images/Gemini_Generated_Image_d77haad77haad77h.png',
  'images/Gemini_Generated_Image_eu0645eu0645eu06.png',
  'images/Gemini_Generated_Image_p4hspmp4hspmp4hs.png',
  'images/Gemini_Generated_Image_ufy5viufy5viufy5.png',
  'images/hero-before-after.webp.png',
  'images/og-image for phoien.png',
  'images/og-image.png.png'
];

async function generatePlaceholder(name, width, height) {
  const outputPath = path.join(imgDir, `${name}.webp`);
  
  // Try to use a source image if we have one, otherwise just make a colored rectangle
  const sourceImage = userImages[Math.floor(Math.random() * userImages.length)];
  const fullSourcePath = path.join(__dirname, '..', sourceImage);
  
  try {
    if (fs.existsSync(fullSourcePath)) {
      await sharp(fullSourcePath)
        .resize(width, height, { fit: 'cover' })
        .webp({ quality: 80 })
        .toFile(outputPath);
      console.log(`Generated ${name}.webp from ${sourceImage}`);
    } else {
      throw new Error("File not found");
    }
  } catch (error) {
    // Fallback placeholder
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#1a1a2e" />
      <text x="50%" y="50%" font-family="sans-serif" font-size="24" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${name}</text>
    </svg>`;
    await sharp(Buffer.from(svg))
      .webp({ quality: 80 })
      .toFile(outputPath);
    console.log(`Generated fallback for ${name}.webp`);
  }
}

async function main() {
  await generatePlaceholder('hero-before-after', 1200, 675);
  await generatePlaceholder('step-upload', 600, 400);
  await generatePlaceholder('step-describe', 600, 400);
  await generatePlaceholder('step-download', 600, 400);
  await generatePlaceholder('demo-poster', 1280, 720);
  await generatePlaceholder('feature-smart-crop', 800, 600);
  await generatePlaceholder('feature-bg-remover', 800, 600);
  await generatePlaceholder('feature-batch', 800, 600);
  await generatePlaceholder('feature-refine', 800, 600);
  await generatePlaceholder('usecase-ecommerce', 600, 400);
  await generatePlaceholder('usecase-thumbnails', 600, 400);
  await generatePlaceholder('usecase-profiles', 600, 400);
  await generatePlaceholder('usecase-design', 600, 400);
  await generatePlaceholder('usecase-social', 600, 400);
  await generatePlaceholder('privacy-shield', 600, 400);
  await generatePlaceholder('cta-bg', 1200, 400);
}

main().catch(console.error);
