/**
 * Inter-agent orchestrator — resolves visual assets for slide decks
 * by calling sub-agents (ImageAgent via ComfyUI, DiagramAgent via Mermaid).
 */

import { generateImage } from './agents/comfyClient.js';
import { complete } from './agents/llmClient.js';
import { getAgent } from './agents/registry.js';
import { ensureComfyRunning, freeComfyMemory } from './comfyManager.js';

const DEFAULT_NEGATIVE = [
  'extra fingers', 'missing fingers', 'deformed hands', 'bad anatomy',
  'blurry', 'low quality', 'watermark', 'signature',
  'same ethnicity only', 'homogeneous group',
].join(', ');

// Appended to photo prompts that may contain people, to encourage diversity
const DIVERSITY_SUFFIX = ', diverse group of professionals of mixed ethnicities genders and ages, inclusive representation, global workforce';

/**
 * Resolve all visual assets for a slide deck.
 * Mutates each slide, adding `imageData` (base64 data URI) where possible.
 *
 * @param {object}   deckData
 * @param {object}   options
 * @param {Function} options.onProgress - Called with status message strings
 * @param {object}   options.config     - App config object
 * @returns {Promise<object>} The mutated deckData
 */
export async function resolveVisuals(deckData, { onProgress, config }) {
  const slides = deckData.slides || [];
  let generated = 0;

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    if (!slide.image) continue;

    const { prompt, type } = slide.image;
    if (!prompt) continue;

    const label = slide.title || `Slide ${i + 1}`;

    try {
      if (type === 'photo') {
        onProgress(`Generating image for slide ${i + 1}: "${label}"...`);
        const data = await generatePhotoBase64(
          prompt,
          config.models.comfyui.endpoint,
          config.models.comfyui.timeout,
        );
        if (data) {
          slide.imageData = data;
          generated++;
        } else {
          onProgress(`Skipped image for slide ${i + 1} (ComfyUI unavailable)`);
        }
      } else if (type === 'diagram') {
        onProgress(`Generating diagram for slide ${i + 1}: "${label}"...`);
        const data = await generateDiagramBase64(
          prompt,
          config.models.general.endpoint,
          config.models.general.model,
          config.mermaid.renderUrl,
        );
        if (data) {
          slide.imageData = data;
          generated++;
        } else {
          onProgress(`Skipped diagram for slide ${i + 1} (render unavailable)`);
        }
      }
    } catch (err) {
      console.error(`[orchestrator] slide ${i + 1} visual failed:`, err.message);
      onProgress(`Skipped visual for slide ${i + 1} (error)`);
    }
  }

  if (generated > 0) {
    onProgress(`Generated ${generated} visual${generated > 1 ? 's' : ''}`);
    freeComfyMemory();
  }

  return deckData;
}

/**
 * Generate a photo via ComfyUI and return base64 PNG data URI.
 * Returns null if ComfyUI is unreachable.
 */
export async function generatePhotoBase64(prompt, comfyEndpoint, timeout) {
  try {
    await ensureComfyRunning();

    // Add diversity guidance to prompts that likely contain people
    const peopleKeywords = /\b(person|people|team|group|staff|employee|worker|professional|client|user|meeting|office|workplace|colleagues)\b/i;
    const enhancedPrompt = peopleKeywords.test(prompt)
      ? prompt + DIVERSITY_SUFFIX
      : prompt;

    const imgData = await generateImage(comfyEndpoint, enhancedPrompt, DEFAULT_NEGATIVE, timeout);

    // Fetch the raw image bytes from ComfyUI
    const viewUrl = `${comfyEndpoint}/view?filename=${encodeURIComponent(imgData.filename)}&subfolder=${encodeURIComponent(imgData.subfolder)}&type=${encodeURIComponent(imgData.type)}`;
    const res = await fetch(viewUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    return `image/png;base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.warn('[orchestrator] photo generation failed:', err.message);
    return null;
  }
}

/**
 * Generate a Mermaid diagram and return base64 PNG data URI.
 * Uses LLM to produce Mermaid code, then renders via mermaid.ink.
 * Returns null on any failure.
 */
export async function generateDiagramBase64(prompt, llmEndpoint, llmModel, renderUrl) {
  try {
    // Get Mermaid code from DiagramAgent
    const diagramAgent = getAgent('DiagramAgent');
    const messages = [
      { role: 'system', content: diagramAgent.systemPrompt },
      { role: 'user', content: `Create a Mermaid diagram for: ${prompt}. Return ONLY the Mermaid code, no explanation, no code fences.` },
    ];

    const raw = await complete(llmEndpoint, llmModel, messages, {
      signal: AbortSignal.timeout(30_000),
      numPredict: 1024,
    });

    // Extract Mermaid code — handle both fenced and raw output
    let mermaidCode = raw.trim();
    const fencedMatch = mermaidCode.match(/```(?:mermaid)?\s*([\s\S]*?)```/);
    if (fencedMatch) {
      mermaidCode = fencedMatch[1].trim();
    }

    if (!mermaidCode || mermaidCode.length < 10) return null;

    // Render via mermaid.ink
    const encoded = Buffer.from(mermaidCode).toString('base64url');
    const imgUrl = `${renderUrl}${encoded}`;
    console.log(`[orchestrator] rendering diagram via ${imgUrl.slice(0, 80)}...`);
    const res = await fetch(imgUrl, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      console.warn(`[orchestrator] mermaid.ink returned ${res.status}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    return `image/png;base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.warn('[orchestrator] diagram generation failed:', err.message);
    return null;
  }
}
