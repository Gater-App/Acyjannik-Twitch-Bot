import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { EventSubClient } from './eventsub.js';

test('EventSub hands off to Twitch reconnect URL before closing old session and keeps transferred subscriptions', { timeout: 5_000 }, async () => {
  const oldServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const nextServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await Promise.all([oldServer, nextServer].map((server) => new Promise<void>((resolve) => server.once('listening', resolve))));
  const oldAddress = oldServer.address(), nextAddress = nextServer.address();
  assert.ok(oldAddress && typeof oldAddress !== 'string' && nextAddress && typeof nextAddress !== 'string');
  const initialUrl = `ws://127.0.0.1:${oldAddress.port}`;
  const reconnectUrl = `ws://127.0.0.1:${nextAddress.port}/handoff`;
  let resolveNotification!: () => void;
  const gotNotification = new Promise<void>((resolve) => { resolveNotification = resolve; });
  let oldClosed = false;
  const subscriptions: string[] = [];
  oldServer.on('connection', (socket) => {
    socket.on('close', () => { oldClosed = true; });
    socket.send(JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'old-session', keepalive_timeout_seconds: 60 } } }));
    setTimeout(() => socket.send(JSON.stringify({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: reconnectUrl } } })), 20);
  });
  nextServer.on('connection', (socket) => {
    socket.send(JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 'new-session', keepalive_timeout_seconds: 60 } } }));
    setTimeout(() => socket.send(JSON.stringify({ metadata: { message_type: 'notification' }, payload: {} })), 20);
  });
  const client = new EventSubClient(async (sessionId) => { subscriptions.push(sessionId); }, async () => { resolveNotification(); },
    { info() {}, warn() {}, error() {} }, initialUrl);
  try {
    client.start();
    await gotNotification;
    assert.deepEqual(subscriptions, ['old-session'], 'Twitch transfers the existing subscriptions during handoff');
    assert.equal(oldClosed, true, 'the old socket closes only after the new welcome and event');
    assert.equal(client.isConnected, true);
  } finally {
    await client.stop();
    await Promise.all([oldServer, nextServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});

test('EventSub uses a reconnect URL once, then falls back to a fresh session after HTTP 429', { timeout: 8_000 }, async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const initialUrl = `ws://127.0.0.1:${address.port}`;
  let reconnectAttempts = 0;
  const rateLimited = createServer((_request, response) => { reconnectAttempts += 1; response.writeHead(429); response.end('rate limited'); });
  await new Promise<void>((resolve) => rateLimited.listen(0, '127.0.0.1', resolve));
  const limitedAddress = rateLimited.address();
  assert.ok(limitedAddress && typeof limitedAddress !== 'string');
  const reconnectUrl = `ws://127.0.0.1:${limitedAddress.port}/reconnect`;
  let welcomeCount = 0;
  let resolveRecovered!: () => void;
  const recovered = new Promise<void>((resolve) => { resolveRecovered = resolve; });
  server.on('connection', (socket) => {
    welcomeCount += 1;
    const current = welcomeCount;
    socket.send(JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: `session-${current}`, keepalive_timeout_seconds: 60 } } }));
    if (current === 1) setTimeout(() => socket.send(JSON.stringify({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: reconnectUrl } } })), 20);
  });
  const client = new EventSubClient(async (sessionId) => { if (sessionId === 'session-2') resolveRecovered(); }, async () => undefined,
    { info() {}, warn() {}, error() {} }, initialUrl);
  try {
    client.start();
    await recovered;
    assert.equal(reconnectAttempts, 1, 'the rejected Twitch handoff URL is not retried');
    assert.equal(client.isConnected, true, 'the normal endpoint establishes a fresh session');
  } finally {
    await client.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => rateLimited.close(() => resolve()));
  }
});
