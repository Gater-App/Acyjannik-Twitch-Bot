import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import {chromium} from 'playwright';
import {CommunityFeatures} from '../src/community-features.js';
import {ViewerCommunityPortal} from '../src/community-portal.js';
import {DashboardServer} from '../src/dashboard.js';
import {FeatureStore} from '../src/feature-store.js';
import {logger} from '../src/logger.js';
import {testConfig} from '../src/test-config.js';

async function freePort():Promise<number>{const server=net.createServer();await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}

test('Community-Welt: Elio, Missionen und Trophäen funktionieren am Desktop und mobil',async()=>{
  const env={...process.env},dir=fs.mkdtempSync(path.join(os.tmpdir(),'acy-community-world-')),store=new FeatureStore(path.join(dir,'world.sqlite')),port=await freePort(),base=`http://127.0.0.1:${port}`;
  process.env.TWITCH_CLIENT_ID='world-client';process.env.TWITCH_CLIENT_SECRET='world-secret';process.env.DASHBOARD_REDIRECT_URI=`${base}/dashboard/oauth/callback`;process.env.DASHBOARD_ADMIN_IDS='admin-only';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);
  const cfg=testConfig({clientId:'world-client',clientSecret:'world-secret',redirectUri:`${base}/dashboard/oauth/callback`}),features=new CommunityFeatures(store,cfg);
  features.arcade.updateSettings({...features.arcade.settings(),petEnabled:true});
  const launchTime=Date.now()-20*60_000;store.setConfig('community_world_started_at',launchTime);
  store.miniGameTransaction(db=>{for(let i=0;i<4;i++)db.prepare("INSERT INTO community_pet_interactions(event_id,user_id,kind,created_at,source) VALUES(?,?,?,?,'portal')").run(`seed-pet-${i}`,'viewer-world','feed',launchTime+5*60_000+i*60_000);});
  store.setConfig('quest_settings',{enabled:true,chatEnabled:true,maxLength:180,queueLimit:100,maxOpenPerUser:2,cooldownMs:300_000,activeDurationMs:0,completionXp:25,channelPointsEnabled:false,modsCanModerate:false,modsCanSkip:false,moderatorUserIds:[]});
  const external:typeof fetch=async input=>String(input).endsWith('/oauth2/token')?Response.json({access_token:'test-viewer-token'}):String(input).endsWith('/oauth2/validate')?Response.json({client_id:'world-client',user_id:'viewer-world'}):String(input).endsWith('/helix/users')?Response.json({data:[{id:'viewer-world',login:'viewerworld',display_name:'Viewer World'}]}):Response.error();
  const portal=new ViewerCommunityPortal(store,features,cfg,external),dashboard=new DashboardServer(store,()=>({twitchConnected:false,channel:'acyjannik',startedAt:1}),logger,external,undefined,undefined,undefined,features.miniGames,features.arcade,undefined,undefined,undefined,undefined,undefined,portal);
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    assert.equal(await dashboard.start(),true);
    const start=await fetch(base+'/community/login/twitch',{redirect:'manual'}),auth=new URL(start.headers.get('location')||''),stateCookie=start.headers.get('set-cookie')?.split(';')[0]||'';
    const callback=await fetch(`${base}/dashboard/oauth/callback?code=demo&state=${auth.searchParams.get('state')}`,{headers:{cookie:stateCookie},redirect:'manual'});
    const viewerCookie=callback.headers.getSetCookie().find(value=>value.startsWith('community_viewer='))?.split(';')[0]||'';assert.ok(viewerCookie);
    const initial=await fetch(base+'/community/api/state',{headers:{cookie:viewerCookie}}),state=await initial.json() as any,csrf=state.viewer.csrfToken;
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1365,height:900}});
    await page.context().addCookies([{name:'community_viewer',value:viewerCookie.split('=')[1],domain:'127.0.0.1',path:'/community',httpOnly:true,secure:false,sameSite:'Lax'}]);
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/community');
    await page.getByText('Viewer World',{exact:true}).waitFor();await page.getByRole('heading',{name:'Schön, dass du da bist, Viewer World! 👋'}).waitFor();await page.getByRole('heading',{name:'Elios Zimmer 🐱'}).waitFor();
    await page.getByText(/Heute · Gib Elio Aufmerksamkeit/u).waitFor();
    await page.getByRole('button',{name:'Füttern'}).click();await page.getByText(/Elio wurde gefüttert/u).waitFor();
    const mission=page.locator('#world-missions').getByRole('button',{name:'XP abholen'}).first();await mission.waitFor();
    await mission.click();await page.getByText('Belohnung abgeholt',{exact:true}).waitFor();await page.locator('#world-recent-badges').getByText('🐱 Elios bester Freund',{exact:true}).waitFor();
    const screenshots=process.env.ACY_COMMUNITY_SCREENSHOT_DIR;
    if(screenshots){fs.mkdirSync(screenshots,{recursive:true});await page.screenshot({path:path.join(screenshots,'community-world-home-desktop.png'),fullPage:true});}
    await page.getByRole('link',{name:'Mein Fortschritt'}).click();await page.getByRole('heading',{name:'Dein Trophäenschrank 🏆'}).waitFor();await page.getByText('Elios bester Freund',{exact:true}).waitFor();
    assert.ok(await page.locator('#world-badges').isVisible());
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),'Desktop hat kein horizontales Überlaufen');
    if(screenshots){fs.mkdirSync(screenshots,{recursive:true});await page.screenshot({path:path.join(screenshots,'community-world-desktop.png'),fullPage:true});}
    await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),'Mobilansicht hat kein horizontales Überlaufen');
    if(screenshots)await page.screenshot({path:path.join(screenshots,'community-world-mobile.png'),fullPage:true});
    await page.getByRole('link',{name:'Start'}).click();if(screenshots)await page.screenshot({path:path.join(screenshots,'community-world-home-mobile.png'),fullPage:true});
    assert.deepEqual(errors,[]);
    const repeat=await fetch(base+'/community/api/mission/claim',{method:'POST',headers:{cookie:viewerCookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({missionId:'visit_elio'})});assert.equal(repeat.status,409);
  }finally{await browser?.close();await dashboard.stop();store.close();process.env=env;fs.rmSync(dir,{recursive:true,force:true});}
});
