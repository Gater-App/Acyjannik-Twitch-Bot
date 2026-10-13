import assert from 'node:assert/strict';
import test from 'node:test';
import { TwitchApi } from './twitch-api.js';
import type { TwitchOAuth } from './twitch-oauth.js';

test('stream status uses existing Twitch access token and distinguishes online from offline', async () => {
  let requested = '';
  const oauth = { getAccessToken: async () => 'existing-token' } as unknown as TwitchOAuth;
  const api = new TwitchApi('client', oauth, async (input, init) => {
    requested = String(input);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer existing-token');
    return Response.json({ data: [{ id: 'stream-1', user_id: 'broadcaster', type: 'live' }] });
  });
  assert.equal((await api.getStreamStatus('broadcaster'))?.id, 'stream-1');
  assert.match(requested, /\/streams\?user_id=broadcaster/u);

  const offline = new TwitchApi('client', oauth, async () => Response.json({ data: [] }));
  assert.equal(await offline.getStreamStatus('broadcaster'), undefined);
});
