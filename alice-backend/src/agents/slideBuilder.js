/**
 * Builds PowerPoint (.pptx) files from structured slide data using PptxGenJS.
 * Branded with Access Group identity.
 *
 * Expected input format:
 * {
 *   title: "Deck Title",
 *   slides: [
 *     { title: "Slide Title", bullets: ["Point 1", "Point 2"], notes: "Speaker notes" },
 *     ...
 *   ]
 * }
 */

import PptxGenJS from 'pptxgenjs';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SLIDES_DIR = join(__dirname, '..', '..', 'data', 'slides');
const LOGO_PATH = join(__dirname, '..', '..', 'Logo_Access_RGB.png');

// Access Group brand palette
const BRAND = {
  red:    'E5173F',
  teal:   '54B9B3',
  purple: '4B112C',
  white:  'FFFFFF',
  grey:   '666666',
  darkBg: '1A1A2E',   // deep navy-purple for slide backgrounds
  lightBg: 'FFFFFF',  // white for light slides
};

// Two themes: dark (default) and light
const THEMES = {
  dark: {
    bg:       BRAND.darkBg,
    title:    BRAND.white,
    body:     'D0D0D8',
    accent:   BRAND.teal,
    accent2:  BRAND.red,
    muted:    '8888A0',
    bullet:   BRAND.teal,
  },
  light: {
    bg:       BRAND.lightBg,
    title:    BRAND.purple,
    body:     '333344',
    accent:   BRAND.teal,
    accent2:  BRAND.red,
    muted:    BRAND.grey,
    bullet:   BRAND.red,
  },
};

/**
 * Build a .pptx from structured slide data and write to disk.
 * Returns the filename.
 */
export function buildPptx(deckData, variant = 'dark') {
  const T = THEMES[variant] || THEMES.dark;
  const pptx = new PptxGenJS();

  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 inches
  pptx.author = 'Access Group — Alice';
  pptx.company = 'Access Group';
  pptx.title = deckData.title || 'Presentation';

  // Load logo as base64 for embedding
  let logoData;
  try {
    const buf = readFileSync(LOGO_PATH);
    logoData = `image/png;base64,${buf.toString('base64')}`;
  } catch { /* logo missing — skip */ }

  // ── Slide master: branded layout ──────────────────────────────────
  const masterObjects = [
    // Top accent bar (Access Red)
    { rect: { x: 0, y: 0, w: 13.33, h: 0.06, fill: { color: BRAND.red } } },
    // Bottom teal line
    { rect: { x: 0.5, y: 7.0, w: 12.33, h: 0.02, fill: { color: BRAND.teal } } },
    // Footer text
    { text: { text: deckData.title || 'Access Group', options: { x: 0.5, y: 7.05, w: 5, h: 0.35, fontSize: 8, color: T.muted, fontFace: 'Arial' } } },
  ];

  // Logo in bottom-right corner of every slide
  if (logoData) {
    masterObjects.push({
      image: { data: logoData, x: 10.5, y: 7.0, w: 2.3, h: 0.4 },
    });
  }

  pptx.defineSlideMaster({
    title: 'ACCESS_BRANDED',
    background: { color: T.bg },
    objects: masterObjects,
  });

  // ── Title slide ───────────────────────────────────────────────────
  const titleSlide = pptx.addSlide({ masterName: 'ACCESS_BRANDED' });

  // Large logo on title slide
  if (logoData) {
    titleSlide.addImage({ data: logoData, x: 0.8, y: 0.8, w: 3.5, h: 0.6 });
  }

  // Purple accent block behind title
  titleSlide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 2.5, w: 13.33, h: 2.8,
    fill: { color: BRAND.purple, transparency: 85 },
  });

  titleSlide.addText(deckData.title || 'Presentation', {
    x: 0.8, y: 2.6, w: 11.5, h: 1.4,
    fontSize: 38, fontFace: 'Arial', color: T.title,
    bold: true, align: 'left',
  });

  if (deckData.subtitle) {
    titleSlide.addText(deckData.subtitle, {
      x: 0.8, y: 4.0, w: 11.5, h: 0.8,
      fontSize: 18, fontFace: 'Arial', color: T.accent,
      align: 'left',
    });
  }

  // ── Content slides ────────────────────────────────────────────────
  for (const slideData of (deckData.slides || [])) {
    const slide = pptx.addSlide({ masterName: 'ACCESS_BRANDED' });
    const hasImage = !!slideData.imageData;
    const hasText = slideData.bullets?.length || slideData.body;

    // Text width adjusts when an image is present (split layout)
    const textWidth = hasImage && hasText ? 5.5 : 11.5;

    // Slide title with red left accent bar
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.5, y: 0.4, w: 0.08, h: 0.7,
      fill: { color: BRAND.red },
    });

    slide.addText(slideData.title || '', {
      x: 0.8, y: 0.4, w: 11.5, h: 0.8,
      fontSize: 26, fontFace: 'Arial', color: T.title,
      bold: true, align: 'left', valign: 'middle',
    });

    // Bullets
    if (slideData.bullets?.length) {
      const bulletObjs = slideData.bullets.map(b => ({
        text: b,
        options: {
          fontSize: 17, fontFace: 'Arial', color: T.body,
          bullet: { type: 'bullet', color: T.bullet },
          paraSpaceAfter: 10,
          lineSpacing: 28,
        },
      }));

      slide.addText(bulletObjs, {
        x: 0.8, y: 1.5, w: textWidth, h: 4.8,
        valign: 'top',
      });
    }

    // Body text (alternative to bullets)
    if (slideData.body && !slideData.bullets?.length) {
      slide.addText(slideData.body, {
        x: 0.8, y: 1.5, w: textWidth, h: 4.8,
        fontSize: 16, fontFace: 'Arial', color: T.body,
        valign: 'top', lineSpacing: 26,
      });
    }

    // Image (generated by sub-agent orchestration)
    if (hasImage) {
      if (hasText) {
        // Split layout: image on right half
        slide.addImage({
          data: slideData.imageData,
          x: 6.8, y: 1.3, w: 5.5, h: 5.0,
          sizing: { type: 'contain', w: 5.5, h: 5.0 },
        });
      } else {
        // Full-width centered image (no text)
        slide.addImage({
          data: slideData.imageData,
          x: 2.0, y: 1.0, w: 9.33, h: 5.5,
          sizing: { type: 'contain', w: 9.33, h: 5.5 },
        });
      }
    }

    // Speaker notes
    if (slideData.notes) {
      slide.addNotes(slideData.notes);
    }
  }

  // Write to disk
  const filename = `alice_${Date.now()}.pptx`;
  const filepath = join(SLIDES_DIR, filename);

  return pptx.stream().then(ab => {
    writeFileSync(filepath, Buffer.from(ab));
    return filename;
  });
}

/**
 * Parse LLM output into structured slide data.
 * Tries JSON first, then falls back to markdown parsing.
 */
export function parseSlideResponse(text) {
  // Try JSON extraction
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.slides && Array.isArray(parsed.slides)) {
        return parsed;
      }
    } catch { /* fall through to markdown parsing */ }
  }

  // Fallback: parse markdown slides (--- separated)
  const sections = text.split(/^---$/m).map(s => s.trim()).filter(Boolean);
  const slides = [];
  let deckTitle = 'Presentation';

  for (const section of sections) {
    const lines = section.split('\n');
    let title = '';
    const bullets = [];
    let notes = '';
    let inNotes = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('# ') && !title) {
        title = trimmed.replace(/^#+\s*/, '');
        if (slides.length === 0) deckTitle = title;
      } else if (trimmed.startsWith('<!-- Note:')) {
        notes = trimmed.replace(/^<!-- Note:\s*/, '').replace(/\s*-->$/, '');
        inNotes = true;
      } else if (inNotes && trimmed.endsWith('-->')) {
        notes += ' ' + trimmed.replace(/\s*-->$/, '');
        inNotes = false;
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        bullets.push(trimmed.replace(/^[-*]\s*/, ''));
      } else if (trimmed.startsWith('## ') && !title) {
        title = trimmed.replace(/^#+\s*/, '');
      }
    }

    if (title || bullets.length) {
      slides.push({ title, bullets, notes });
    }
  }

  return { title: deckTitle, slides };
}
