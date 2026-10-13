import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { RateLimitBuckets, setRateLimitHeaders, trustedClientAddress } from './request-limits.js';

test('rate limits are isolated by route class and authenticated identity, expire, and provide retry time', () => {
  const limiter = new RateLimitBuckets();
  assert.equal(limiter.consume('admin-read', 'admin-a', 2, 10_000, 100).allowed, true);
  assert.equal(limiter.consume('admin-read', 'admin-a', 2, 10_000, 101).allowed, true);
  const blocked = limiter.consume('admin-read', 'admin-a', 2, 10_000, 102);
  assert.deepEqual(blocked, { allowed: false, retryAfterSeconds: 10 });
  assert.equal(limiter.consume('admin-read', 'admin-b', 2, 10_000, 102).allowed, true);
  assert.equal(limiter.consume('widget-read', 'admin-a', 2, 10_000, 102).allowed, true);
  assert.equal(limiter.consume('admin-read', 'admin-a', 2, 10_000, 10_100).allowed, true);
});

test('forwarded client identity is accepted only behind loopback proxy and uses the proxy-appended rightmost address', async () => {
  const handler = (req: IncomingMessage, res: ServerResponse) => { res.end(trustedClientAddress(req)); };
  const server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}`, { headers: { 'X-Forwarded-For': '198.51.100.10, 203.0.113.22' } });
    assert.equal(await response.text(), '203.0.113.22');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const spoofed = { socket: { remoteAddress: '198.51.100.44' }, headers: { 'x-forwarded-for': '127.0.0.1' } } as unknown as IncomingMessage;
  assert.equal(trustedClientAddress(spoofed), '198.51.100.44');
});

test('429 response advertises Retry-After', () => {
  const headers = new Headers();
  const response = { setHeader: (name: string, value: string) => headers.set(name, value) } as unknown as ServerResponse;
  setRateLimitHeaders(response, 3.2);
  assert.equal(headers.get('retry-after'), '4');
  assert.equal(headers.get('cache-control'), 'no-store');
});
