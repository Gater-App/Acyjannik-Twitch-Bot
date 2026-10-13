import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** Small in-memory fixed-window limiter keyed by a trusted identity and a route class. */
export class RateLimitBuckets {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  consume(bucket: string, identity: string, limit: number, windowMs: number, now = Date.now()): RateLimitDecision {
    if (this.buckets.size > 10_000) {
      for (const [key, value] of this.buckets) if (value.resetAt <= now) this.buckets.delete(key);
      while (this.buckets.size > 10_000) {
        const oldest = this.buckets.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.buckets.delete(oldest);
      }
    }
    const key = `${bucket}:${identity}`;
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (current.count >= limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
    }
    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/**
 * Only honor forwarding headers from a loopback reverse proxy. Caddy appends its
 * connected client as the rightmost address; a direct non-loopback peer cannot
 * choose the identity by supplying X-Forwarded-For.
 */
export function trustedClientAddress(req: IncomingMessage): string {
  const remote = normalizeAddress(req.socket.remoteAddress || 'unknown');
  if (remote !== '127.0.0.1' && remote !== '::1') return remote;
  const forwarded = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded || '')
    .split(',').map((part) => normalizeAddress(part.trim())).filter((part) => part !== 'unknown');
  return chain.at(-1) || remote;
}

export function setRateLimitHeaders(res: ServerResponse, retryAfterSeconds: number): void {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterSeconds))));
  res.setHeader('Cache-Control', 'no-store');
}

function normalizeAddress(value: string): string {
  const unwrapped = value.replace(/^\[|\]$/gu, '').replace(/^::ffff:/u, '');
  return isIP(unwrapped) ? unwrapped : 'unknown';
}
