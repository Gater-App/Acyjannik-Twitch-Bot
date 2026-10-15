import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { chromium } from 'playwright';
import { CommunityFeatures } from '../src/community-features.js';
import { ViewerCommunityPortal } from '../src/community-portal.js';
import { DashboardServer } from '../src/dashboard.js';
import { FeatureStore } from '../src/feature-store.js';
import { logger } from '../src/logger.js';
import { testConfig } from '../src/test-config.js';

async function freePort():Promise<number>{const server=net.createServer();await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}

test('Geheimwort-Portal ist mobil nutzbar und zeigt die eigene Rolle getrennt vom öffentlichen Spielstand',async()=>{
  const env={...process.env},dir=fs.mkdtempSync(path.join(os.tmpdir(),'acy-word-imposter-browser-')),store=new FeatureStore(path.join(dir,'state.sqlite')),port=await freePort(),base=`http://127.0.0.1:${port}`;
  process.env.TWITCH_CLIENT_ID='word-client';process.env.TWITCH_CLIENT_SECRET='word-secret';process.env.DASHBOARD_REDIRECT_URI=`${base}/dashboard/oauth/callback`;process.env.DASHBOARD_ADMIN_IDS='admin-only';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);
  const config=testConfig({clientId:'word-client',clientSecret:'word-secret',redirectUri:`${base}/dashboard/oauth/callback`}),features=new CommunityFeatures(store,config);
  features.secretWordImposter.updateSettings({...features.secretWordImposter.settings(),enabled:true,minPlayers:3,maxPlayers:6,cooldownMs:0});
  const fetchImpl:typeof fetch=async input=>String(input).endsWith('/oauth2/token')?Response.json({access_token:'test-viewer-token'}):String(input).endsWith('/oauth2/validate')?Response.json({client_id:'word-client',user_id:'viewer-browser'}):String(input).endsWith('/helix/users')?Response.json({data:[{id:'viewer-browser',login:'viewerbrowser',display_name:'Viewer Browser'}]}):Response.error();
  const portal=new ViewerCommunityPortal(store,features,config,fetchImpl),dashboard=new DashboardServer(store,()=>({twitchConnected:false,channel:'acyjannik',startedAt:1}),logger,fetchImpl,undefined,undefined,undefined,features.miniGames,features.arcade,undefined,undefined,undefined,undefined,undefined,portal);
  const raw=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url'),now=Date.now();store.createViewerSession({sessionHash:createHash('sha256').update(raw).digest('hex'),userId:'viewer-browser',login:'viewerbrowser',displayName:'Viewer Browser',profileImageUrl:null,csrfToken:csrf,createdAt:now,expiresAt:now+60*60_000});
  features.secretWordImposter.start('admin',now);for(const player of [{userId:'viewer-browser',login:'viewerbrowser',displayName:'Viewer Browser'},{userId:'browser-two',login:'browsertwo',displayName:'Browser Two'},{userId:'browser-three',login:'browserthree',displayName:'Browser Three'}])features.secretWordImposter.join(player,now+1);features.secretWordImposter.startRoles('admin',now+2);
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    assert.equal(await dashboard.start(),true);browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});await page.context().addCookies([{name:'community_viewer',value:raw,domain:'127.0.0.1',path:'/community',httpOnly:true,secure:false,sameSite:'Lax'}]);
    const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/community/imposter-word');
    await page.getByRole('heading',{name:'Das Geheimwort 🎭'}).waitFor();await page.getByText(/Dein geheimer Begriff lautet:|Du bist der IMPOSTER/u).waitFor();await page.getByText('Viewer Browser',{exact:true}).waitFor();
    const privateRole=await page.locator('#private-role').innerText();await page.reload();await page.getByText(privateRole,{exact:true}).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),'Das Portal darf auf Mobilgeräten nicht horizontal überlaufen.');
    assert.deepEqual(errors,[]);
    const screenshots=process.env.ACY_COMMUNITY_SCREENSHOT_DIR;if(screenshots){fs.mkdirSync(screenshots,{recursive:true});await page.screenshot({path:path.join(screenshots,'imposter-secret-word-mobile.png'),fullPage:true});}
    await page.setViewportSize({width:1365,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),'Desktopansicht darf nicht horizontal überlaufen.');
    if(screenshots)await page.screenshot({path:path.join(screenshots,'imposter-secret-word-desktop.png'),fullPage:true});
    const response=await fetch(base+'/community/api/word-imposter/state');const publicState=await response.json() as any;assert.equal(publicState.mine,null);assert.doesNotMatch(JSON.stringify(publicState.game),/secret_word|imposter_id|browser-two|viewer-browser|role/u);
  }finally{await browser?.close();await dashboard.stop();store.close();process.env=env;fs.rmSync(dir,{recursive:true,force:true});}
});
