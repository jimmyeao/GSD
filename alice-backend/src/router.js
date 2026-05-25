/**
 * RouterAgent — selects the best specialist agent for a given prompt.
 *
 * Strategy:
 *   1. Keyword/pattern matching (fast, no LLM call, ~0ms)
 *   2. Falls back to AssistantAgent if no pattern matches
 *
 * The optional LLM-based routing can be enabled by calling routeWithLLM()
 * when the general model backend is available and higher accuracy is needed.
 */

import { AGENT_IDS } from './agents/registry.js';

/**
 * Ordered routing rules — more specific rules must come first.
 * Each rule has an agent ID and an array of regex patterns.
 * The first matching rule wins.
 */
const ROUTING_RULES = [
  // Mail + calendar — routed before everything else because keywords like
  // "send", "schedule", "reply" are otherwise ambiguous.
  {
    agent: 'MailAgent',
    patterns: [
      /\bemail\b/i,
      /\bmail(?:\s*box|\s*server)?\b/i,
      /\binbox\b/i,
      /\bgmail\b/i,
      /\boutlook\b/i,
      /\bcalendar\b/i,
      /\bmeeting\b/i,
      /\bevent\b.{0,20}\b(create|schedule|invite|cancel|delete|update|move)\b/i,
      /\b(create|schedule|set\s+up|book)\b.{0,20}\bmeeting\b/i,
      /\breply\s+to\b/i,
      /\bsend\b.{0,20}\b(email|mail|message|reply)\b/i,
      /\bschedule\s+(a|an)\b.{0,20}\b(meeting|call|event)\b/i,
      /\bunread\s+(emails?|messages?)\b/i,
    ],
  },
  // Diagrams — checked before image so "draw a mermaid/flowchart" routes correctly
  {
    agent: 'DiagramAgent',
    patterns: [
      /\bdiagram\b/i,
      /\bmermaid\b/i,
      /\bflowchart\b/i,
      /sequence\s+diagram/i,
      /\barchitecture\s+diagram\b/i,
      /\bdraw\s+.*(flow|arch|mermaid)/i,
      /\bvisualise\b/i,
      /\bvisualize\b/i,
    ],
  },
  // Image generation — match stems so "creating", "generates" etc. all route here
  {
    agent: 'ImageAgent',
    patterns: [
      // verb + visual noun (broad set of creation verbs)
      /(?:generat|creat|mak|render|design|produc|build|draw|sketch|paint|show|give)\w*\b.{0,40}\b(image|photo|picture|logo|icon|banner|artwork|graphic|illustration|poster|visual|thumbnail|wallpaper|portrait|headshot|avatar)\b/i,
      // "I want / need / would like ... <visual noun>"
      /\b(?:want|need|would\s+like|i'?d\s+like|i\s+would\s+like)\b.{0,40}\b(image|photo|picture|logo|icon|banner|artwork|graphic|illustration|poster|visual|thumbnail|wallpaper|portrait|headshot|avatar)\b/i,
      // bare noun phrase: "a/an <visual noun> of/with/showing ..." (subject of creation)
      /\b(?:a|an|the)\s+(image|photo|picture|logo|icon|banner|artwork|graphic|illustration|poster|wallpaper|portrait|headshot|avatar)\s+(of|with|showing|featuring|for|in)\b/i,
      // draw me a X / sketch a X / paint a X
      /\b(?:draw|sketch|paint)\s+(me\s+)?(a|an)\b/i,
      // standalone visual nouns as subject of creation
      /\b(logo|icon|banner|thumbnail|poster)\s+(for|of)\b/i,
      /\billustrat\w+/i,
      /\bcomfyui\b/i,
      /\b(stable\s*diffusion|sdxl|flux)\b/i,
    ],
  },
  // Code review (before generic coder)
  {
    agent: 'ReviewAgent',
    patterns: [
      /review\s+(this\s+)?(code|script|function)/i,
      /\baudit\s+(this\s+)?(code|script)/i,
      /\bcode\s+review\b/i,
      /check\s+(this\s+)?(code|script)\s+for/i,
      /security\s+(review|audit|check)/i,
      /\bunsafe\b.*\bparam/i,
    ],
  },
  // Tests
  {
    agent: 'TestAgent',
    patterns: [
      /write\s+(unit|integration|e2e)\s+tests?/i,
      /\btest\s+cases?\b/i,
      /\bpytest\b/i,
      /\bjest\b/i,
      /\bvitest\b/i,
      /write\s+tests?\s+for/i,
    ],
  },
  // Coder
  {
    agent: 'CoderAgent',
    patterns: [
      /write\s+(a\s+)?(script|function|class|module|program)/i,
      /\bdebug\b/i,
      /\brefactor\b/i,
      /\bimplement\b/i,
      /\bcode\s+(that|to|for|which)\b/i,
      /\bone[\s-]liner\b/i,
      /\bsnippet\b/i,
      /\bpython\b/i,
      /\bpowershell\b/i,
      /\bbash\b/i,
      /\bshell\s+(script|command)\b/i,
      /\bjavascript\b/i,
      /\btypescript\b/i,
      /\bsql\b/i,
      /\bregex\b/i,
    ],
  },
  // Architect
  {
    agent: 'ArchitectAgent',
    patterns: [
      /\barchitect(ure)?\b/i,
      /system\s+design/i,
      /high(ly)?[\s-]availab/i,
      /design\s+(a|an|the)\s+(system|solution|platform)/i,
      /\btrade[\s-]offs?\b/i,
      /\bscalable\s+(system|solution|architecture)\b/i,
    ],
  },
  // Deploy
  {
    agent: 'DeployAgent',
    patterns: [
      /deployment\s+plan/i,
      /\brunbook\b/i,
      /rollout\s+(plan|checklist|strategy)/i,
      /\bdeploy\b.*\bplan\b/i,
      /\bchecklist\b.*\bdeploy/i,
    ],
  },
  // Infra
  {
    agent: 'InfraAgent',
    patterns: [
      /\bprovision(ing)?\b/i,
      /hyper[\s-]?v\b/i,
      /\bterraform\b/i,
      /\bansible\b/i,
      /\bpuppet\b/i,
      /script.*\b(vm|virtual\s+machine)/i,
      /new\s+(vm|server|node)/i,
    ],
  },
  // Proposal
  {
    agent: 'ProposalAgent',
    patterns: [
      /\bproposal\b/i,
      /draft\s+(a\s+)?proposal/i,
      /\bscope\s+of\s+work\b/i,
      /\brfp\b/i,
    ],
  },
  // Client brief
  {
    agent: 'ClientBriefAgent',
    patterns: [
      /\bclient[\s-]brief\b/i,
      /\bone[\s-]page\s+brief\b/i,
      /client[\s-]facing\s+brief/i,
      /turn.*notes.*brief/i,
    ],
  },
  // Research
  {
    agent: 'ResearchAgent',
    patterns: [
      /\bresearch\b/i,
      /best\s+practices?\s+for/i,
      /compare\s+(the\s+)?options?\b/i,
      /deep[\s-]dive\b/i,
      /\binvestigate\b/i,
    ],
  },
  // Documentation
  {
    agent: 'DocAgent',
    patterns: [
      /write\s+(the\s+)?docs?\b/i,
      /\bdocument(ation)?\b/i,
      /\bhow[\s-]to\s+(guide|document)/i,
      /technical\s+guide/i,
      /write.*guide\b/i,
    ],
  },
  // Slides
  {
    agent: 'SlideAgent',
    patterns: [
      /\bslide\s+(deck|presentation)/i,
      /\b(slide|presentation)\s+deck\b/i,
      /\bpowerpoint\b/i,
      /build.*\bslides?\b/i,
      /\bdecks?\b.*\bpresent/i,
    ],
  },
  // Video script — checked BEFORE VideoAgent so "create a video script" routes
  // to scripting and only bare "create a video" falls through to generation.
  {
    agent: 'VideoScriptAgent',
    patterns: [
      /video\s+script/i,
      /script.*video/i,
      /\bshot\s+list\b/i,
      /explainer\s+video/i,
      /\b\d+[\s-]second\s+video\b/i,
    ],
  },
  // Video generation
  {
    agent: 'VideoAgent',
    patterns: [
      /generat\w*\b.{0,40}\bvideo\b/i,
      /\bvideo\b.{0,40}\bgenerat/i,
      /\bcreate\b.{0,20}\bvideo\b/i,
      /\bmake\b.{0,20}\bvideo\b/i,
      /\bvideo\s+of\b/i,
      /\bvideo\s+showing\b/i,
      /\bai\s+video\b/i,
      /\banimate\b/i,
    ],
  },
  // Demo
  {
    agent: 'DemoAgent',
    patterns: [
      /\bdemo\b.*\bscenario\b/i,
      /walk[\s-]through\b/i,
      /\bwalkthrough\b/i,
      /runnable\s+demo/i,
      /create\s+(a\s+)?demo/i,
    ],
  },
  // Alerts
  {
    agent: 'AlertAgent',
    patterns: [
      /\b(zabbix|nagios|pagerduty|grafana)\b/i,
      /\balerts?\b.*\b(summaris|flag|critical)/i,
      /first[\s-]response\s+actions?/i,
      /\bincident\s+(response|triage)\b/i,
    ],
  },
  // Analytics
  {
    agent: 'AnalystAgent',
    patterns: [
      /\banalys[ei]s?\b.*\b(csv|data|log|metric)/i,
      /\banomaly\s+detect/i,
      /\bcsv\b.*\b(analys|highlight|extract)/i,
      /\bdata\s+insight/i,
      /\blogin\s+attempts?\b/i,
    ],
  },
  // Git
  {
    agent: 'GitAgent',
    patterns: [
      /\bgit\s+(commit|merge|rebase|branch|push|pull|log)/i,
      /write\s+a\s+commit\s+message/i,
      /\bpull\s+request\b/i,
      /\bgit\s+workflow\b/i,
    ],
  },
  // Health
  {
    agent: 'HealthAgent',
    patterns: [
      /\bsystemctl\s+(status|output)/i,
      /service\s+health/i,
      /interpret.*\b(status|health)\b/i,
      /\bdiagnostics?\b/i,
    ],
  },
  // Log watch
  {
    agent: 'LogWatchAgent',
    patterns: [
      /\bscan\b.*\blogs?\b/i,
      /\blogs?\b.*\b(errors?|warnings?|scan)/i,
      /\bnginx.*log\b/i,
      /\bwatch\b.*\blogs?\b/i,
      /last\s+hour.*logs?/i,
    ],
  },
];

/**
 * Route a prompt to the most appropriate agent ID using keyword matching.
 * @param {string} prompt
 * @returns {string} agentId
 */
export function routeByKeyword(prompt) {
  for (const rule of ROUTING_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(prompt)) return rule.agent;
    }
  }
  return 'AssistantAgent';
}

/**
 * Route using the LLM (more accurate but requires a working backend).
 * Falls back to keyword routing on error.
 */
export async function routeWithLLM(prompt, llmEndpoint, model) {
  // Keyword match first — deterministic and fast. Only call the LLM if no
  // keyword rule matches (routeByKeyword returns 'AssistantAgent' as the
  // default). This prevents the LLM from second-guessing clear matches like
  // "inbox" → MailAgent and picking LogWatchAgent instead.
  const keywordHit = routeByKeyword(prompt);
  if (keywordHit !== 'AssistantAgent') return keywordHit;

  const { complete, LLMUnavailableError } = await import('./agents/llmClient.js');
  const { AGENT_REGISTRY } = await import('./agents/registry.js');

  // Build a short catalog so the LLM knows what each agent is for.
  const catalog = AGENT_IDS.map(id => {
    const def = AGENT_REGISTRY[id];
    const firstLine = (def?.systemPrompt || '').split('\n')[0].replace(/^You are \w+Agent,?\s*/i, '').trim();
    return `- ${id}: ${firstLine || 'generalist'}`;
  }).join('\n');

  const systemMsg = `You are a routing classifier. Pick the single best specialist for the user's request.
Reply with ONLY the agent name — no explanation, no quotes, no other text.

Agents:
${catalog}`;
  try {
    const result = await complete(llmEndpoint, model, [
      { role: 'system', content: systemMsg },
      { role: 'user', content: prompt },
    ], { signal: AbortSignal.timeout(5000) });

    const raw = result.trim();
    // Exact-match path (model obeyed "reply with ONLY the agent name").
    const clean = raw.replace(/[^A-Za-z]/g, '');
    if (AGENT_IDS.includes(clean)) return clean;
    // Lenient path: model wrapped the answer in reasoning/preamble. Search the
    // response for any agent ID, longest first so "VideoScriptAgent" wins over
    // "VideoAgent" when both appear.
    const sorted = [...AGENT_IDS].sort((a, b) => b.length - a.length);
    for (const id of sorted) {
      if (new RegExp(`\\b${id}\\b`).test(raw)) return id;
    }
  } catch (err) {
    if (!(err instanceof LLMUnavailableError)) console.warn('[router] LLM routing failed:', err.message);
  }
  return 'AssistantAgent';
}
