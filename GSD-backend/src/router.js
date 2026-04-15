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
      // verb + visual noun
      /generat\w*\b.{0,40}\b(image|photo|picture|logo|icon|banner|artwork|graphic|illustration|poster|visual|thumbnail)\b/i,
      /creat\w*\b.{0,40}\b(image|photo|picture|logo|icon|banner|artwork|graphic|illustration|poster|visual|thumbnail)\b/i,
      /mak\w*\b.{0,40}\b(image|photo|picture|logo|icon|banner|artwork|graphic|illustration)\b/i,
      /render\w*\b.{0,40}\b(image|photo|picture|logo|graphic)\b/i,
      /design\w*\b.{0,40}\b(logo|icon|banner|graphic|visual|thumbnail)\b/i,
      // draw me a X
      /\bdraw\s+(me\s+)?(a|an)\b/i,
      // standalone visual nouns as subject of creation
      /\b(logo|icon|banner|thumbnail|poster)\s+(for|of)\b/i,
      /\billustrat\w+/i,
      /\bcomfyui\b/i,
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
  // Video generation (must be before VideoScript to catch "generate a video")
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
  // Video script
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
  const { complete, LLMUnavailableError } = await import('./agents/llmClient.js');
  const systemMsg = `You are a routing agent. Reply with ONLY the agent name — no other text.
Choose from: ${AGENT_IDS.join(', ')}.`;
  try {
    const result = await complete(llmEndpoint, model, [
      { role: 'system', content: systemMsg },
      { role: 'user', content: prompt },
    ], { signal: AbortSignal.timeout(5000) });

    const clean = result.trim().replace(/[^A-Za-z]/g, '');
    if (AGENT_IDS.includes(clean)) return clean;
  } catch (err) {
    if (!(err instanceof LLMUnavailableError)) console.warn('[router] LLM routing failed:', err.message);
  }
  return routeByKeyword(prompt);
}
