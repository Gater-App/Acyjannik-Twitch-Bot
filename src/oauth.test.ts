import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileTokenStore, TwitchOAuth } from './twitch-oauth.js';

test('OAuth-URL enthält nur die minimalen Chat-Scopes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'twitch-oauth-'));
  const oauth = new TwitchOAuth('client', 'secret', 'http://127.0.0.1/callback', ['user:read:chat', 'user:write:chat'], new FileTokenStore(path.join(directory, 'tokens.json')));
  const url = new URL(oauth.authorizationUrl);
  assert.equal(url.searchParams.get('scope'), 'user:read:chat user:write:chat');
  await fs.rm(directory, { recursive: true, force: true });
});

test('Refresh-Token-Rotation wird gespeichert ohne Tokens zu loggen', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'twitch-oauth-refresh-'));
  const tokenPath = path.join(directory, 'tokens.json');
  const fetchMock: typeof fetch = async () => new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, token_type: 'bearer' }), { status: 200, headers: { 'content-type': 'application/json' } });
  const oauth = new TwitchOAuth('client', 'secret', 'http://127.0.0.1/callback', [], new FileTokenStore(tokenPath), fetchMock);
  await oauth.initialize(undefined, 'old-refresh');
  assert.equal(await oauth.getAccessToken(), 'new-access');
  const saved = JSON.parse(await fs.readFile(tokenPath, 'utf8')) as { accessToken: string; refreshToken: string };
  assert.equal(saved.accessToken, 'new-access');
  assert.equal(saved.refreshToken, 'new-refresh');
  await fs.rm(directory, { recursive: true, force: true });
});
