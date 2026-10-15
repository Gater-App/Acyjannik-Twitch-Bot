import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileTokenStore, TwitchOAuth } from './twitch-oauth.js';
import { TwitchApi, TwitchApiError } from './twitch-api.js';

const silentLogger = { info() {}, warn() {}, error() {} };

test('Chat-EventSub verwendet den unterstützten User-Token-WebSocket-Pfad und die Bot-Identität', async () => {
  const requests: Array<{ url: string; method: string; authorization: string; body?: Record<string, unknown> }> = [];
  const fetchMock: typeof fetch = async (input, init) => {
    const method = String(init?.method || 'GET');
    const headers = new Headers(init?.headers);
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({ url, method, authorization: headers.get('Authorization') || '', ...(body ? { body } : {}) });
    if (method === 'GET') return Response.json({ data: [] });
    return Response.json({ data: [{ id: 'subscription-id' }] }, { status: 202 });
  };
  const oauth = { getAccessToken: async () => 'synthetic-user-token', refreshAccessToken: async () => 'unexpected-refresh' } as unknown as TwitchOAuth;
  const api = new TwitchApi('synthetic-client-id', oauth, fetchMock, silentLogger, async () => undefined);
  await api.ensureChatSubscription('session-1', 'broadcaster-1', 'bot-1');
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.authorization === 'Bearer synthetic-user-token'));
  assert.equal(requests[1]?.method, 'POST');
  assert.deepEqual(requests[1]?.body, {
    type: 'channel.chat.message', version: '1',
    condition: { broadcaster_user_id: 'broadcaster-1', user_id: 'bot-1' },
    transport: { method: 'websocket', session_id: 'session-1' },
  });
});

test('Helix-401 nach Ablauf löst genau einen Token-Refresh aus und wiederholt den Lesezugriff', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acy-twitch-api-refresh-'));
  const store = new FileTokenStore(path.join(directory, 'bot-tokens.json'));
  await store.save({ accessToken: 'synthetic-expired-token', refreshToken: 'synthetic-refresh-token', expiresAt: 0, scopes: ['user:read:chat', 'user:write:chat'] });
  const oauth = new TwitchOAuth('synthetic-client-id', 'synthetic-client-secret', 'https://example.test/callback', [], store, async (input, init) => {
    assert.equal(String(input), 'https://id.twitch.tv/oauth2/token');
    assert.equal(new URLSearchParams(String(init?.body || '')).get('grant_type'), 'refresh_token');
    return Response.json({ access_token: 'synthetic-fresh-token', refresh_token: 'synthetic-rotated-refresh-token', expires_in: 3600, token_type: 'bearer', scope: ['user:read:chat', 'user:write:chat'] });
  }, silentLogger);
  const helixTokens: string[] = [];
  let calls = 0;
  const fetchMock: typeof fetch = async (_input, init) => {
    helixTokens.push(new Headers(init?.headers).get('Authorization') || '');
    calls += 1;
    if (calls === 1) return new Response('expired', { status: 401 });
    return Response.json({ data: [{ id: 'user-1', login: 'acycommunitybot', display_name: 'ACY Community Bot' }] });
  };
  try {
    await oauth.initialize();
    const api = new TwitchApi('synthetic-client-id', oauth, fetchMock, silentLogger, async () => undefined);
    const users = await api.getUsers(['acycommunitybot']);
    assert.equal(users[0]?.id, 'user-1');
    assert.deepEqual(helixTokens, ['Bearer synthetic-expired-token', 'Bearer synthetic-fresh-token']);
    assert.deepEqual((await store.load())?.scopes, ['user:read:chat', 'user:write:chat']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Helix-403 wegen fehlender Berechtigung löst keinen Token-Refresh oder Retry aus', async () => {
  let refreshes = 0, calls = 0;
  const oauth = { getAccessToken: async () => 'synthetic-user-token', refreshAccessToken: async () => { refreshes += 1; return 'synthetic-refreshed-token'; } } as unknown as TwitchOAuth;
  const api = new TwitchApi('synthetic-client-id', oauth, async () => { calls += 1; return new Response('forbidden', { status: 403 }); }, silentLogger, async () => undefined);
  await assert.rejects(api.getUsers(['acycommunitybot']), (error: unknown) => error instanceof TwitchApiError && error.status === 403);
  assert.equal(calls, 1);
  assert.equal(refreshes, 0);
});
