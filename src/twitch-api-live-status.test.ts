import assert from 'node:assert/strict';
import test from 'node:test';
import { TwitchApi } from './twitch-api.js';
import { TwitchApiError } from './twitch-api.js';
import type { TwitchOAuth } from './twitch-oauth.js';

test('stream status uses existing Twitch access token and distinguishes online from offline', async () => {
  let requested = '';
  const oauth = { getAccessToken: async () => 'existing-token' } as unknown as TwitchOAuth;
  const api = new TwitchApi('client', oauth, async (input, init) => {
    requested = String(input);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer existing-token');
    return Response.json({ data: [{ id: 'stream-1', user_id: 'broadcaster', type: 'live', title:'Test stream',game_name:'Fortnite',viewer_count:42,started_at:'2026-10-14T18:00:00Z' }] });
  });
  const live=await api.getStreamStatus('broadcaster');assert.equal(live?.id,'stream-1');assert.equal(live?.title,'Test stream');assert.equal(live?.game_name,'Fortnite');assert.equal(live?.viewer_count,42);assert.equal(live?.started_at,'2026-10-14T18:00:00Z');
  assert.match(requested, /\/streams\?user_id=broadcaster/u);

  const offline = new TwitchApi('client', oauth, async () => Response.json({ data: [] }));
  assert.equal(await offline.getStreamStatus('broadcaster'), undefined);
});

test('Live EventSub subscriptions are idempotently scoped to the broadcaster and WebSocket session', async () => {
  const requests: Array<{ url:string; method:string; body?:Record<string,unknown> }> = [];
  const oauth = { getAccessToken: async () => 'existing-token' } as unknown as TwitchOAuth;
  const api = new TwitchApi('client', oauth, async (input, init) => {
    const url=String(input),method=init?.method||'GET';
    requests.push({url,method,...(init?.body?{body:JSON.parse(String(init.body)) as Record<string,unknown>}:{})});
    if(url.includes('/eventsub/subscriptions')&&method==='GET')return Response.json({data:[{type:'stream.online',version:'1',status:'enabled',condition:{broadcaster_user_id:'broadcaster'},transport:{session_id:'session-1'}}]});
    return Response.json({data:[]},{status:202});
  });
  await api.ensureLiveSubscriptions('session-1','broadcaster');
  const creates=requests.filter(item=>item.method==='POST');
  assert.deepEqual(creates.map(item=>item.body?.type),['stream.offline','channel.update']);
  assert.deepEqual(creates[1]?.body,{type:'channel.update',version:'2',condition:{broadcaster_user_id:'broadcaster'},transport:{method:'websocket',session_id:'session-1'}});
});

test('Twitch GET liest begrenzt mit exponentiellem Backoff nach 5xx erneut', async () => {
  let calls = 0; const delays: number[] = [];
  const oauth = { getAccessToken: async () => 'synthetic-token' } as unknown as TwitchOAuth;
  const api = new TwitchApi('client', oauth, async () => ++calls === 1
    ? new Response('temporarily unavailable', { status: 503 })
    : Response.json({ data: [] }), undefined, async ms => { delays.push(ms); });
  assert.equal(await api.getStreamStatus('broadcaster'), undefined);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [250]);
});

test('Twitch 429 respektiert kurze Retry-After, aber unsichere Schreibvorgänge werden nicht wiederholt', async () => {
  const oauth = { getAccessToken: async () => 'synthetic-token' } as unknown as TwitchOAuth;
  const delays: number[] = []; let reads = 0;
  const readApi = new TwitchApi('client', oauth, async () => ++reads === 1
    ? new Response('', { status: 429, headers: { 'Retry-After': '2' } })
    : Response.json({ data: [] }), undefined, async ms => { delays.push(ms); });
  await readApi.getStreamStatus('broadcaster');
  assert.equal(reads, 2); assert.deepEqual(delays, [2000]);

  let writes = 0;
  const writeApi = new TwitchApi('client', oauth, async () => { writes++; return new Response('failure', { status: 503 }); }, undefined, async () => undefined);
  await assert.rejects(() => writeApi.sendChatMessage('broadcaster', 'bot', 'test'), (error: unknown) => error instanceof TwitchApiError && error.status === 503);
  assert.equal(writes, 1, 'POST mit unklarem Ausgang darf nicht erneut gesendet werden');
});

test('Twitch Netzwerkfehler werden begrenzt wiederholt und fehlerhafte API-Antworten verständlich abgewiesen', async () => {
  const oauth = { getAccessToken: async () => 'synthetic-token' } as unknown as TwitchOAuth;
  const delays: number[] = []; let calls = 0;
  const api = new TwitchApi('client', oauth, async () => { calls++; throw new Error('socket reset'); }, undefined, async ms => { delays.push(ms); });
  await assert.rejects(() => api.getStreamStatus('broadcaster'), (error: unknown) => error instanceof TwitchApiError && error.status === 503);
  assert.equal(calls, 3); assert.deepEqual(delays, [250, 500]);

  const malformed = new TwitchApi('client', oauth, async () => new Response('{', { status: 200 }));
  await assert.rejects(() => malformed.getStreamStatus('broadcaster'), /ungültige JSON-Antwort/u);
  const incomplete = new TwitchApi('client', oauth, async () => Response.json({}));
  await assert.rejects(() => incomplete.getStreamStatus('broadcaster'), /unvollständige API-Antwort/u);
});
