# Alice — Artificial Local Intelligent Compute Engine

A multi-agent, 100% local LLM assistant: routing, code, images, video, mail, and more — running entirely on your hardware.

## How it works
When you send a prompt, a RouterAgent inspects the request and routes it to the specialist best suited to the task. The specialist streams its response back through Socket.IO so you see tokens as they are generated. All model traffic, embeddings, and conversation history stay on the machine — there is no external API call in the default loop. You can always pick a specific agent from the sidebar if you want to bypass routing.
The 22 Agents
 
Agent	What it does	Example prompt	Model
AlertAgent	Summarises alerts and suggests first-response actions.	"Summarise these Zabbix alerts and flag anything critical."	General LLM (8001)
AnalystAgent	Analyses structured data, logs, and metrics to extract insight.	"Analyse this CSV of login attempts and highlight anomalies."	General LLM (8001)
ArchitectAgent	Designs system architectures and evaluates trade-offs.	"Design a highly-available file share for 200 Windows clients."	Qwen3-Coder 80B (8000)
AssistantAgent	General-purpose conversational assistant for everyday questions.	"Explain the difference between SCCM and Intune in plain English."	General LLM (8001)
ClientBriefAgent	Turns raw notes into polished client-facing briefs.	"Write a one-page brief for a 50-seat Intune migration."	General LLM (8001)
CoderAgent	Writes, debugs, and refactors production code in any language.	"Write a Python script to parse Intune CSV exports."	Qwen3-Coder 80B (8000)
DemoAgent	Builds runnable demo scenarios and walk-through scripts.	"Create a demo showing Autopilot enrolment end to end."	Qwen3-Coder 80B (8000)
DeployAgent	Produces deployment plans, runbooks, and rollout checklists.	"Draft a deployment plan for Defender for Endpoint."	Qwen3-Coder 80B (8000)
DiagramAgent	Generates Mermaid diagrams for architecture and flows.	"Diagram the Alice request flow from browser to model."	General LLM (8001)
DocAgent	Writes clear technical documentation and how-to guides.	"Document how to rotate the Alice admin password."	General LLM (8001)
GitAgent	Helps with Git workflows, commits, merges, and history.	"Write a commit message for these staged changes."	General LLM (8001)
HealthAgent	Reports on service health and interprets diagnostics.	"Interpret this systemctl status output for alice-web."	General LLM (8001)
ImageAgent	Generates images via a local ComfyUI pipeline.	"Generate a dark, minimal hero image for a proposal deck."	ComfyUI (8188)
InfraAgent	Plans and scripts infrastructure changes for Windows and Linux.	"Script the provisioning of a new Hyper-V VM from a template."	Qwen3-Coder 80B (8000)
LogWatchAgent	Watches log streams for errors and surfaces likely causes.	"Scan these nginx error logs for the last hour and summarise."	General LLM (8001)
ProposalAgent	Drafts client-ready proposals with scope, cost, and risk.	"Draft a proposal for a 100-seat Windows 11 refresh."	Qwen3-Coder 80B (8000)
ResearchAgent	Deep-dives into technical topics and cites sources.	"Research best practices for Entra ID Conditional Access."	Qwen3-Coder 80B (8000)
ReviewAgent	Reviews code for bugs, style, and security issues.	"Review this PowerShell script for unsafe parameter handling."	Qwen3-Coder 80B (8000
 
 
 
SlideAgent	Produces slide decks in markdown-slides format.	"Build a five-slide intro deck for a Alice client demo."	General LLM (8001)
TestAgent	Writes unit and integration tests for existing code.	"Write pytest tests for this Alice auth helper."	Qwen3-Coder 80B (8000)
VideoScriptAgent	Writes scripts and shot lists for short technical videos.	"Write a 90-second video script explaining Alice."	General LLM (8001)
 

Choosing an Agent
    • Need code? → CoderAgent.
    • Need code reviewed? → ReviewAgent.
    • Need tests? → TestAgent.
    • Need a diagram? → DiagramAgent.
    • Need an image? → ImageAgent.
    • Need a design or architecture? → ArchitectAgent.
    • Need a proposal or client brief? → ProposalAgent or ClientBriefAgent.
    • Need to research a topic? → ResearchAgent.
    • Need to document something? → DocAgent.
    • Just chatting? → AssistantAgent.
If you are not sure, leave routing to the RouterAgent — it will pick for you based on the prompt.
