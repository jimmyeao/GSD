import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pollForVideo } from '../src/agents/videoClient.js';

describe('pollForVideo worker liveness', () => {
  it('gives up with workerDown once a remote worker stops answering', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    try {
      await assert.rejects(
        pollForVideo('http://worker:8188', 'c', 'p1', 60_000, undefined, undefined, { unreachableMs: 1 }),
        (err) => err.workerDown === true && /not responding/.test(err.message),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
