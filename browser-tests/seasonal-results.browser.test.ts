import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { chromium } from 'playwright';
import { DashboardServer } from '../src/dashboard.js';
import { FeatureStore, HALLOWEEN_2026_END_AT } from '../src/feature-store.js';
import { logger } from '../src/logger.js';

async function freePort():Promise<number>{const server=net.createServer();await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}

test('finales Halloween-Ergebnis wird im geschützten Saison-Dashboard mobil lesbar angezeigt',async()=>{
  const env={...process.env},directory=fs.mkdtempSync(path.join(os.tmpdir(),'acy-seasonal-results-browser-')),store=new FeatureStore(path.join(directory,'state.sqlite')),port=await freePort(),base=`http://127.0.0.1:${port}`;
  process.env.TWITCH_CLIENT_ID='seasonal-test-client';process.env.TWITCH_CLIENT_SECRET='seasonal-test-secret';process.env.DASHBOARD_REDIRECT_URI=`${base}/dashboard/oauth/callback`;process.env.DASHBOARD_ADMIN_IDS='seasonal-admin';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);
  store.miniGameTransaction(db=>{
    db.prepare("INSERT INTO seasonal_scores(event_id,user_id,display_name,points,updated_at) VALUES('halloween','viewer-2','Zoe',42,20)").run();
    db.prepare("INSERT INTO seasonal_scores(event_id,user_id,display_name,points,updated_at) VALUES('halloween','viewer-1','Anna',42,20)").run();
  });
  store.finalizeHalloween2026(HALLOWEEN_2026_END_AT,['broadcaster','bot']);
  const external:typeof fetch=async input=>{const url=String(input);if(url.endsWith('/oauth2/token'))return Response.json({access_token:'local-seasonal-test-token'});if(url.endsWith('/oauth2/validate'))return Response.json({client_id:'seasonal-test-client',user_id:'seasonal-admin',login:'admin'});if(url.endsWith('/helix/users'))return Response.json({data:[{id:'seasonal-admin',login:'admin',display_name:'Admin'}]});throw new Error(`Unexpected external request ${url}`);};
  const dashboard=new DashboardServer(store,()=>({twitchConnected:true,channel:'acyjannik',startedAt:1}),logger,external);let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    assert.equal(await dashboard.start(),true);const login=await fetch(`${base}/dashboard/login`,{redirect:'manual'}),state=new URL(login.headers.get('location')||'').searchParams.get('state')||'',stateCookie=login.headers.get('set-cookie')?.split(';')[0]||'';
    const callback=await fetch(`${base}/dashboard/oauth/callback?code=test&state=${state}`,{headers:{Cookie:stateCookie},redirect:'manual'});assert.equal(callback.status,303);const cookie=callback.headers.getSetCookie().find(value=>value.startsWith('community_admin='))?.split(';')[0]||'';assert.ok(cookie);
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});await page.context().addCookies([{name:'community_admin',value:cookie.split('=')[1]!,domain:'127.0.0.1',path:'/',httpOnly:true,secure:true,sameSite:'Lax'}]);
    await page.goto(`${base}/dashboard`,{waitUntil:'domcontentloaded'});await page.locator('[data-view-target="community"]').click();await page.locator('[data-community-target="events"]').click();
    await page.getByText('Gewinner: Anna · 42 Kürbisse',{exact:true}).waitFor();assert.equal(JSON.stringify(await page.locator('#seasonal-results-content li').allTextContents()),JSON.stringify(['Anna · 42 Kürbisse','Zoe · 42 Kürbisse']));
    assert.match(await page.locator('#seasonal-results-content').innerText(),/alphabetisch aufsteigend/u);
    for(const width of [375,430]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),`kein horizontaler Überlauf bei ${width}px`);}
  }finally{await browser?.close();await dashboard.stop();store.close();fs.rmSync(directory,{recursive:true,force:true});for(const [key,value] of Object.entries(env))process.env[key]=value;for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];}
});
