import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  stripWholeHome,
  isHaUserAllowed,
  haConfig, askAssist, handleHomeCommand, runHomeAssistantAgent, findPendingCommand,
  needsConfirmation, isConfirmation, isCancellation, NOT_CONFIGURED_REPLY, HomeAssistantError,
} from '../src/agents/homeAssistantAgent.js';
import { routeByKeyword } from '../src/router.js';
import { pickVoiceAgent, runVoiceTurn } from '../src/agents/voiceAssistant.js';

const cfg = { url: 'http://ha.test:8123', token: 'sekret-token', agentId: 'conversation.home_assistant', language: 'en' };
const haReply = (speech, type = 'action_done', status = 200) => async (url, init) => {
  haReply.last = { url, init };
  return { ok: status < 400, status, json: async () => ({ response: { response_type: type, speech: { plain: { speech } } } }) };
};

describe('haConfig', () => {
  it('is null without a token and trims the URL with one', () => {
    assert.equal(haConfig({}), null);
    assert.equal(haConfig({ HA_TOKEN: '  ' }), null);
    const c = haConfig({ HA_TOKEN: 't', HA_URL: 'http://x:8123///' });
    assert.equal(c.url, 'http://x:8123');
    assert.equal(c.agentId, 'conversation.home_assistant');
    assert.equal(c.language, 'en');
  });
});

describe('askAssist', () => {
  it('POSTs the text to /api/conversation/process with the bearer token and agent id', async () => {
    const r = await askAssist('turn off the kitchen light', cfg, { fetch: haReply('Turned off the light') });
    assert.deepEqual(r, { text: 'Turned off the light', type: 'action_done' });
    const { url, init } = haReply.last;
    assert.equal(url, 'http://ha.test:8123/api/conversation/process');
    assert.equal(init.headers.Authorization, 'Bearer sekret-token');
    const body = JSON.parse(init.body);
    assert.deepEqual(body, { text: 'turn off the kitchen light', language: 'en', agent_id: 'conversation.home_assistant' });
  });
  it('says Done when an action has no speech', async () => {
    assert.equal((await askAssist('x', cfg, { fetch: haReply('') })).text, 'Done.');
  });
  it('classifies HTTP failures', async () => {
    await assert.rejects(askAssist('x', cfg, { fetch: haReply('', 'error', 401) }), (e) => e.kind === 'auth');
    await assert.rejects(askAssist('x', cfg, { fetch: haReply('', 'error', 404) }), (e) => e.kind === 'agent');
    await assert.rejects(askAssist('x', cfg, { fetch: haReply('', 'error', 500) }), (e) => e.kind === 'http');
    await assert.rejects(askAssist('x', cfg, { fetch: async () => { throw new TypeError('fetch failed'); } }), (e) => e instanceof HomeAssistantError && e.kind === 'unreachable');
  });
});

describe('handleHomeCommand', () => {
  it('explains how to connect when no token is configured', async () => {
    const r = await handleHomeCommand({ content: 'turn off the lights' }, { config: null });
    assert.equal(r.text, NOT_CONFIGURED_REPLY);
  });
  it('returns HA speech for a normal command', async () => {
    const r = await handleHomeCommand({ content: 'turn off the kitchen light' }, { config: cfg, fetch: haReply('Turned off the kitchen light') });
    assert.deepEqual(r, { text: 'Turned off the kitchen light', ok: true });
  });
  it('flags an HA "could not understand" as not ok but still passes the speech', async () => {
    const r = await handleHomeCommand({ content: 'turn on the moon' }, { config: cfg, fetch: haReply("Sorry, I couldn't understand that", 'error') });
    assert.equal(r.ok, false);
    assert.match(r.text, /couldn't understand/);
  });
  it('turns network and auth failures into friendly sentences without leaking the token', async () => {
    const down = await handleHomeCommand({ content: 'lights off' }, { config: cfg, fetch: async () => { throw new TypeError('fetch failed'); } });
    assert.match(down.text, /couldn't reach Home Assistant/);
    const auth = await handleHomeCommand({ content: 'lights off' }, { config: cfg, fetch: haReply('', 'error', 401) });
    assert.match(auth.text, /access token/);
    assert.doesNotMatch(down.text + auth.text, /sekret/);
  });

  describe('confirmation for sensitive commands', () => {
    it('detects sensitive wording', () => {
      for (const t of ['unlock the front door', 'open the garage door', 'disarm the alarm', 'lock the back door']) assert.ok(needsConfirmation(t), t);
      for (const t of ['turn off the kitchen light', 'set the heating to 21', 'blocks and clocks']) assert.ok(!needsConfirmation(t), t);
    });
    it('asks first and does not call Home Assistant', async () => {
      let called = false;
      const r = await handleHomeCommand({ content: 'unlock the front door' }, { config: cfg, fetch: async () => { called = true; } });
      assert.equal(called, false);
      assert.equal(r.text, 'Please confirm: "unlock the front door". Say yes to go ahead, or no to cancel.');
      assert.equal(findPendingCommand([{ role: 'user', content: 'unlock the front door' }, { role: 'assistant', content: r.text }]), 'unlock the front door');
    });
    it('runs exactly the confirmed command on "yes"', async () => {
      const history = [{ role: 'user', content: 'unlock the front door' }, { role: 'assistant', content: 'Please confirm: "unlock the front door". Say yes to go ahead, or no to cancel.' }];
      const r = await handleHomeCommand({ content: 'Yes please', history }, { config: cfg, fetch: haReply('Unlocked the front door') });
      assert.equal(r.text, 'Unlocked the front door');
      assert.equal(JSON.parse(haReply.last.init.body).text, 'unlock the front door');
    });
    it('cancels on "no" and never calls Home Assistant', async () => {
      let called = false;
      const history = [{ role: 'assistant', content: 'Please confirm: "unlock the front door". Say yes to go ahead, or no to cancel.' }];
      const r = await handleHomeCommand({ content: 'no', history }, { config: cfg, fetch: async () => { called = true; } });
      assert.equal(called, false);
      assert.match(r.text, /cancelled/);
    });
    it('a different command after a prompt is treated as new, not as a confirmation', async () => {
      const history = [{ role: 'assistant', content: 'Please confirm: "unlock the front door". Say yes to go ahead, or no to cancel.' }];
      const r = await handleHomeCommand({ content: 'turn off the lamp', history }, { config: cfg, fetch: haReply('Turned off the lamp') });
      assert.equal(JSON.parse(haReply.last.init.body).text, 'turn off the lamp');
      assert.equal(r.text, 'Turned off the lamp');
    });
    it('classifies yes/no wording', () => {
      assert.ok(isConfirmation('yes')); assert.ok(isConfirmation('Go ahead')); assert.ok(!isConfirmation('yesterday I'));
      assert.ok(isCancellation('No')); assert.ok(isCancellation('never mind')); assert.ok(!isCancellation('nothing'));
    });
  });
});

describe('runHomeAssistantAgent', () => {
  it('emits thinking → tokens → done and joins to the HA reply', async () => {
    const socket = new EventEmitter();
    const seen = [];
    for (const ev of ['thinking', 'token', 'done', 'error']) socket.on(ev, (p) => seen.push([ev, p]));
    await runHomeAssistantAgent({ socket, content: 'turn off the kitchen light', convId: null }, { config: cfg, fetch: haReply('Turned off the kitchen light') });
    assert.equal(seen[0][0], 'thinking');
    assert.equal(seen.filter(e => e[0] === 'token').map(e => e[1].token).join(''), 'Turned off the kitchen light');
    assert.deepEqual(seen.at(-1), ['done', { agent: 'HomeAssistantAgent' }]);
    assert.equal(socket.listenerCount('stop:stream'), 0);
  });
});

describe('routing', () => {
  it('routes home-device commands to HomeAssistantAgent', () => {
    for (const t of ['Turn off the kitchen light', 'switch on the living room lamp', 'Turn the lights off', 'dim the lights to 30 percent',
      'Set the heating to 21 degrees', 'close the blinds', 'lock the front door', 'which lights are on']) {
      assert.equal(routeByKeyword(t), 'HomeAssistantAgent', t);
    }
  });
  it('leaves IT and coding phrasing alone', () => {
    for (const t of ['Turn off the firewall on the server', 'switch on debug logging', 'Write a script to turn off the lights', 'How do I set a heating schedule in the app']) {
      assert.notEqual(routeByKeyword(t), 'HomeAssistantAgent', t);
    }
  });
  it('voice: routes device commands and pending confirmations to HomeAssistantAgent', () => {
    assert.equal(pickVoiceAgent('turn off the kitchen light'), 'HomeAssistantAgent');
    const history = [{ role: 'assistant', content: 'Please confirm: "lock the front door". Say yes to go ahead, or no to cancel.' }];
    assert.equal(pickVoiceAgent('yes', history), 'HomeAssistantAgent');
    assert.notEqual(pickVoiceAgent('yes'), 'HomeAssistantAgent');
  });
  it('voice turn returns flattened HA speech', async () => {
    const r = await runVoiceTurn({ content: 'turn off the kitchen light' }, { handleHomeCommand: async () => ({ text: 'Turned off the **kitchen** light', ok: true }) });
    assert.deepEqual(r, { text: 'Turned off the kitchen light', agent: 'HomeAssistantAgent' });
  });
});

describe('stripWholeHome', () => {
  it('drops trailing whole-home phrases', () => {
    assert.equal(stripWholeHome('what lights are on in the house'), 'what lights are on');
    assert.equal(stripWholeHome('Which lights are on in the whole house?'), 'Which lights are on?');
    assert.equal(stripWholeHome('are any lights on at home'), 'are any lights on');
    assert.equal(stripWholeHome('turn off the lights throughout my home.'), 'turn off the lights.');
  });
  it('leaves room-specific and plain commands alone', () => {
    assert.equal(stripWholeHome('what lights are on in the kitchen'), 'what lights are on in the kitchen');
    assert.equal(stripWholeHome('turn off the kitchen light'), 'turn off the kitchen light');
    assert.equal(stripWholeHome('in the house'), 'in the house');
  });
});

describe('isHaUserAllowed', () => {
  it('allows everyone when HA_ALLOWED_USERS is unset', () => {
    assert.equal(isHaUserAllowed({ email: 'a@b.c' }, {}), true);
  });
  it('restricts to listed emails or usernames, case-insensitively', () => {
    const env = { HA_ALLOWED_USERS: 'Jimmy@Example.com, bob' };
    assert.equal(isHaUserAllowed({ email: 'jimmy@example.com' }, env), true);
    assert.equal(isHaUserAllowed({ username: 'BOB' }, env), true);
    assert.equal(isHaUserAllowed({ email: 'eve@example.com', username: 'eve' }, env), false);
    assert.equal(isHaUserAllowed(undefined, env), false);
  });
});
