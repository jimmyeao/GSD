/**
 * Converts ComfyUI UI workflow JSON (including subgraphs) to API prompt format.
 * Used to extract the exact workflow the user built in ComfyUI's editor.
 */

import { readFileSync } from 'node:fs';

/**
 * Convert a ComfyUI UI workflow JSON file to API prompt format.
 * Handles subgraph expansion and link resolution.
 *
 * @param {string} filePath - Path to the .json workflow file
 * @param {object} overrides - Values to override: { prompt, negativePrompt, imageName, seed }
 * @returns {object} API prompt object ready for POST /prompt
 */
export function loadWorkflowAsAPI(filePath, overrides = {}) {
  const wf = JSON.parse(readFileSync(filePath, 'utf-8'));

  // Collect all nodes (expanding subgraphs)
  const allNodes = {};  // id -> { type, widgets_values, inputs, outputs }
  const allLinks = [];  // { from_id, from_slot, to_id, to_slot }

  const subgraphDefs = {};
  for (const sg of (wf.definitions?.subgraphs || [])) {
    subgraphDefs[sg.id] = sg;
  }

  // Process top-level nodes
  for (const node of wf.nodes) {
    if (subgraphDefs[node.type]) {
      // This is a subgraph instance — expand it
      expandSubgraph(node, subgraphDefs[node.type], allNodes, allLinks, wf.links);
    } else if (!isUtilityNode(node.type)) {
      allNodes[node.id] = node;
    }
  }

  // Add top-level links
  for (const link of (wf.links || [])) {
    const [linkId, fromId, fromSlot, toId, toSlot, type] = link;
    // Skip links to/from subgraph nodes (already handled in expansion)
    if (allNodes[fromId] && allNodes[toId]) {
      allLinks.push({ from_id: fromId, from_slot: fromSlot, to_id: toId, to_slot: toSlot });
    }
  }

  // Build API prompt
  return buildAPIPrompt(allNodes, allLinks, overrides);
}

function isUtilityNode(type) {
  return ['MarkdownNote', 'Reroute', 'Note', 'PrimitiveNode'].includes(type);
}

function expandSubgraph(instance, sgDef, allNodes, allLinks, outerLinks) {
  // Map subgraph input ports to the source nodes from the outer workflow
  const sgInputSources = {};  // input_slot -> { from_id, from_slot } in outer workflow
  for (const input of (instance.inputs || [])) {
    if (input.link != null) {
      // Find this link in outer links
      for (const link of (outerLinks || [])) {
        if (link[0] === input.link) {
          sgInputSources[input.name] = { from_id: link[1], from_slot: link[2] };
          break;
        }
      }
    }
  }

  // Add all internal nodes (skip utility nodes)
  for (const node of (sgDef.nodes || [])) {
    if (!isUtilityNode(node.type)) {
      allNodes[node.id] = node;
    }
  }

  // Add internal links
  for (const link of (sgDef.links || [])) {
    const fromId = link.origin_id;
    const toId = link.target_id;

    // Skip links from/to subgraph boundary ports (negative IDs)
    if (fromId < 0 || toId < 0) continue;

    if (allNodes[fromId] && allNodes[toId]) {
      allLinks.push({
        from_id: fromId,
        from_slot: link.origin_slot,
        to_id: toId,
        to_slot: link.target_slot,
      });
    }
  }
}

function buildAPIPrompt(allNodes, allLinks, overrides) {
  // Build link lookup: to_id -> { to_slot -> [from_id, from_slot] }
  const incomingLinks = {};
  for (const link of allLinks) {
    if (!incomingLinks[link.to_id]) incomingLinks[link.to_id] = {};
    incomingLinks[link.to_id][link.to_slot] = [String(link.from_id), link.from_slot];
  }

  const prompt = {};

  for (const [id, node] of Object.entries(allNodes)) {
    const nodeType = node.type;
    if (isUtilityNode(nodeType)) continue;

    const inputs = {};
    const nodeInputDefs = node.inputs || [];
    const widgets = node.widgets_values || [];
    const nodeLinks = incomingLinks[id] || {};

    // Map input slots that have links
    let widgetIdx = 0;
    for (let slot = 0; slot < nodeInputDefs.length; slot++) {
      const inputDef = nodeInputDefs[slot];
      const inputName = inputDef.name || inputDef.label || `input_${slot}`;

      if (nodeLinks[slot]) {
        inputs[inputName] = nodeLinks[slot];
      }
      // Inputs with widgets that don't have links get their value from widgets_values
      else if (inputDef.widget) {
        if (widgetIdx < widgets.length) {
          inputs[inputName] = widgets[widgetIdx];
        }
        widgetIdx++;
      }
    }

    // Remaining widget values (for inputs not in the inputs array)
    // These are the "hidden" widget inputs that appear after the linked inputs
    // We need to map them based on the node type's expected inputs
    // For simplicity, if there are more widget values than consumed, add them
    // by looking at common patterns

    // Apply overrides
    if (overrides.prompt && nodeType === 'CLIPTextEncode' && (widgets[0] === '' || inputName === 'text')) {
      // Empty positive prompt — override with user's prompt
    }

    prompt[String(id)] = {
      class_type: nodeType,
      inputs,
    };
  }

  // Apply overrides by finding the right nodes
  if (overrides.prompt || overrides.imageName) {
    for (const [id, entry] of Object.entries(prompt)) {
      // Override prompt text in CLIPTextEncode nodes with empty text
      if (overrides.prompt && entry.class_type === 'CLIPTextEncode') {
        if (entry.inputs.text === '' || entry.inputs.text === undefined) {
          entry.inputs.text = overrides.prompt;
        }
      }
      // Override image name in LoadImage
      if (overrides.imageName && entry.class_type === 'LoadImage') {
        entry.inputs.image = overrides.imageName;
      }
      // Override seeds
      if (overrides.seed && entry.class_type === 'RandomNoise') {
        entry.inputs.noise_seed = overrides.seed;
      }
    }
  }

  return prompt;
}
