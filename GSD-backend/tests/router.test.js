import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { routeByKeyword } from '../src/router.js';

describe('routeByKeyword', () => {
  // Image
  it('routes image generation prompts to ImageAgent', () => {
    assert.equal(routeByKeyword('Generate a dark hero image for the proposal'), 'ImageAgent');
    assert.equal(routeByKeyword('Create an image of a server room'), 'ImageAgent');
    assert.equal(routeByKeyword('Draw me a network topology'), 'ImageAgent');
  });

  // Diagrams
  it('routes diagram prompts to DiagramAgent', () => {
    assert.equal(routeByKeyword('Diagram the request flow from browser to model'), 'DiagramAgent');
    assert.equal(routeByKeyword('Draw a mermaid flowchart for the auth process'), 'DiagramAgent');
    assert.equal(routeByKeyword('Create a sequence diagram for the login flow'), 'DiagramAgent');
  });

  // Code review (before generic coder)
  it('routes review prompts to ReviewAgent', () => {
    assert.equal(routeByKeyword('Review this PowerShell script for unsafe parameter handling'), 'ReviewAgent');
    assert.equal(routeByKeyword('Code review this function for security issues'), 'ReviewAgent');
    assert.equal(routeByKeyword('Audit this code for vulnerabilities'), 'ReviewAgent');
  });

  // Tests
  it('routes test-writing prompts to TestAgent', () => {
    assert.equal(routeByKeyword('Write pytest tests for this GSD auth helper'), 'TestAgent');
    assert.equal(routeByKeyword('Write unit tests for this function'), 'TestAgent');
    assert.equal(routeByKeyword('Create integration test cases for the API'), 'TestAgent');
  });

  // Coder
  it('routes coding prompts to CoderAgent', () => {
    assert.equal(routeByKeyword('Write a Python script to parse Intune CSV exports'), 'CoderAgent');
    assert.equal(routeByKeyword('Implement a retry mechanism in TypeScript'), 'CoderAgent');
    assert.equal(routeByKeyword('Debug this JavaScript function'), 'CoderAgent');
    assert.equal(routeByKeyword('Refactor this bash script'), 'CoderAgent');
  });

  // Architect
  it('routes architecture prompts to ArchitectAgent', () => {
    assert.equal(routeByKeyword('Design a highly-available file share for 200 Windows clients'), 'ArchitectAgent');
    assert.equal(routeByKeyword('What are the trade-offs of a microservices architecture?'), 'ArchitectAgent');
  });

  // Deploy
  it('routes deployment prompts to DeployAgent', () => {
    assert.equal(routeByKeyword('Draft a deployment plan for Defender for Endpoint'), 'DeployAgent');
    assert.equal(routeByKeyword('Write a rollout plan with checklist'), 'DeployAgent');
  });

  // Infra
  it('routes infra prompts to InfraAgent', () => {
    assert.equal(routeByKeyword('Script the provisioning of a new Hyper-V VM from a template'), 'InfraAgent');
    assert.equal(routeByKeyword('Write a Terraform module to provision a new server'), 'InfraAgent');
  });

  // Proposal
  it('routes proposal prompts to ProposalAgent', () => {
    assert.equal(routeByKeyword('Draft a proposal for a 100-seat Windows 11 refresh'), 'ProposalAgent');
    assert.equal(routeByKeyword('Write an IT proposal with scope of work'), 'ProposalAgent');
  });

  // Client brief
  it('routes brief prompts to ClientBriefAgent', () => {
    assert.equal(routeByKeyword('Write a one-page brief for a 50-seat Intune migration'), 'ClientBriefAgent');
    assert.equal(routeByKeyword('Create a client-brief for the project'), 'ClientBriefAgent');
  });

  // Research
  it('routes research prompts to ResearchAgent', () => {
    assert.equal(routeByKeyword('Research best practices for Entra ID Conditional Access'), 'ResearchAgent');
    assert.equal(routeByKeyword('Deep-dive into Zero Trust networking'), 'ResearchAgent');
  });

  // Docs
  it('routes documentation prompts to DocAgent', () => {
    assert.equal(routeByKeyword('Document how to rotate the GSD admin password'), 'DocAgent');
    assert.equal(routeByKeyword('Write a technical guide for onboarding new users'), 'DocAgent');
  });

  // Slides
  it('routes slide prompts to SlideAgent', () => {
    assert.equal(routeByKeyword('Build a five-slide presentation deck for a GSD client demo'), 'SlideAgent');
    assert.equal(routeByKeyword('Create a slide deck about zero trust'), 'SlideAgent');
  });

  // Video script
  it('routes video script prompts to VideoScriptAgent', () => {
    assert.equal(routeByKeyword('Write a 90-second video script explaining GSD'), 'VideoScriptAgent');
    assert.equal(routeByKeyword('Create a video script with shot list'), 'VideoScriptAgent');
  });

  // Demo
  it('routes demo prompts to DemoAgent', () => {
    assert.equal(routeByKeyword('Create a demo showing Autopilot enrolment end to end'), 'DemoAgent');
    assert.equal(routeByKeyword('Build a walk-through for the onboarding process'), 'DemoAgent');
  });

  // Alert
  it('routes alert prompts to AlertAgent', () => {
    assert.equal(routeByKeyword('Summarise these Zabbix alerts and flag anything critical'), 'AlertAgent');
    assert.equal(routeByKeyword('Triage this PagerDuty incident'), 'AlertAgent');
  });

  // Analyst
  it('routes data analysis prompts to AnalystAgent', () => {
    assert.equal(routeByKeyword('Analyse this CSV of login attempts and highlight anomalies'), 'AnalystAgent');
  });

  // Git
  it('routes git prompts to GitAgent', () => {
    assert.equal(routeByKeyword('Write a git commit message for these staged changes'), 'GitAgent');
    assert.equal(routeByKeyword('How do I git merge with rebase?'), 'GitAgent');
  });

  // Health
  it('routes health prompts to HealthAgent', () => {
    assert.equal(routeByKeyword('Interpret this systemctl status output for gsd-web'), 'HealthAgent');
  });

  // Log watch
  it('routes log prompts to LogWatchAgent', () => {
    assert.equal(routeByKeyword('Scan these nginx error logs for the last hour and summarise'), 'LogWatchAgent');
  });

  // Default fallback
  it('falls back to AssistantAgent for unrecognised prompts', () => {
    assert.equal(routeByKeyword('What time is it in Tokyo?'), 'AssistantAgent');
    assert.equal(routeByKeyword('Hello'), 'AssistantAgent');
    assert.equal(routeByKeyword('Explain the difference between SCCM and Intune'), 'AssistantAgent');
  });
});
