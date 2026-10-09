import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRemoteWorkers, resolveNeeds } from '../src/comfyWorkers.js';
import { TALKING_HEAD_NEEDS } from '../src/agents/talkingHeadClient.js';

describe('parseRemoteWorkers', () => {
  it('parses name=url lists and drops junk', () => {
    assert.deepEqual(parseRemoteWorkers('laptop=http://192.168.0.144:8188/, bad=ftp://x, =, other=https://gpu.lan:8443'), [
      { name: 'laptop', endpoint: 'http://192.168.0.144:8188', local: false },
      { name: 'other', endpoint: 'https://gpu.lan:8443', local: false },
    ]);
    assert.deepEqual(parseRemoteWorkers(''), []);
  });
});

describe('resolveNeeds', () => {
  const laptop = new Set(['ltx-2.3-22b-dev-fp8.safetensors', 'gemma_3_12B_it_fp4_mixed.safetensors', 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors',
    'ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors', 'ltx-2.3-id-lora-talkvid-3k.safetensors']);
  it('picks the first available alternative (fp8 on the laptop)', () => {
    assert.equal(resolveNeeds(TALKING_HEAD_NEEDS, laptop)[0], 'ltx-2.3-22b-dev-fp8.safetensors');
    assert.equal(resolveNeeds(TALKING_HEAD_NEEDS, new Set([...laptop, 'ltx-2.3-22b-dev.safetensors']))[0], 'ltx-2.3-22b-dev.safetensors');
  });
  it('rejects a worker missing any required file', () => {
    const missing = new Set([...laptop]); missing.delete('ltx-2.3-id-lora-talkvid-3k.safetensors');
    assert.equal(resolveNeeds(TALKING_HEAD_NEEDS, missing), null);
  });
});

describe('comboOptions', async () => {
  const { comboOptions } = await import('../src/comfyWorkers.js');
  it('reads both /object_info COMBO formats', () => {
    assert.deepEqual(comboOptions([['a.safetensors', 'b.safetensors']]), ['a.safetensors', 'b.safetensors']);
    assert.deepEqual(comboOptions(['COMBO', { options: ['ltx-2.3-spatial-upscaler-x2-1.1.safetensors'] }]), ['ltx-2.3-spatial-upscaler-x2-1.1.safetensors']);
    assert.deepEqual(comboOptions(undefined), []);
  });
});
