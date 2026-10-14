import assert from 'node:assert/strict';
import test from 'node:test';
import { CommunityPortalHealth } from './portal-health.js';

test('Portal-Hinweis setzt eine erreichbare HTML-Startseite voraus und puffert Fehler',async()=>{
  let calls=0;
  const health=new CommunityPortalHealth('https://twitch.gater-app.de/community',async()=>{calls++;return new Response('<title>ACY COMMUNITY</title>',{status:200,headers:{'Content-Type':'text/html; charset=utf-8'}})},60_000);
  assert.equal(await health.isAvailable(1_000),true);
  assert.equal(await health.isAvailable(2_000),true);
  assert.equal(calls,1,'keine zweite Probe innerhalb des vorhandenen Tipp-Zeitfensters');
  const unavailable=new CommunityPortalHealth('https://twitch.gater-app.de/community',async()=>{calls++;return new Response('maintenance',{status:503,headers:{'Content-Type':'text/html'}})},60_000);
  assert.equal(await unavailable.isAvailable(1_000),false);
  assert.equal(await unavailable.isAvailable(2_000),false);
  assert.equal(calls,2,'Fehlerhafte Portalroute wird bis zur nächsten Prüfung nicht erneut abgefragt');
  const wrongContent=new CommunityPortalHealth('https://twitch.gater-app.de/community',async()=>Response.json({ok:true}));
  assert.equal(await wrongContent.isAvailable(1_000),false,'JSON-Fehlerseite gilt nicht als Portal');
});
