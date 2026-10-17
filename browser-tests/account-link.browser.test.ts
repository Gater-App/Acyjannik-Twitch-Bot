import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import {chromium,devices} from 'playwright';
import {CommunityFeatures} from '../src/community-features.js';
import {ViewerCommunityPortal} from '../src/community-portal.js';
import {DashboardServer} from '../src/dashboard.js';
import {FeatureStore} from '../src/feature-store.js';
import {logger} from '../src/logger.js';
import {testConfig} from '../src/test-config.js';

async function freePort():Promise<number>{const server=net.createServer();await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}

test('iPhone-sized browser follows the one-time Discord link through Twitch OAuth and back',async()=>{
  const env={...process.env},store=new FeatureStore(':memory:'),port=await freePort(),base=`http://127.0.0.1:${port}`,discordUserId='18446744073709551615';
  process.env.TWITCH_CLIENT_ID='link-browser-client';process.env.TWITCH_CLIENT_SECRET='link-browser-secret';process.env.DASHBOARD_REDIRECT_URI=`${base}/dashboard/oauth/callback`;process.env.DASHBOARD_ADMIN_IDS='admin-only';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);process.env.DISCORD_INTEGRATION_SECRET='synthetic-link-integration-secret-123456';
  store.setConfig('discord_integration',{enabled:true,accountLinkEnabled:true});
  const cfg=testConfig({clientId:'link-browser-client',clientSecret:'link-browser-secret',redirectUri:`${base}/dashboard/oauth/callback`}),features=new CommunityFeatures(store,cfg);
  const external:typeof fetch=async input=>{const url=String(input);if(url.endsWith('/oauth2/token'))return Response.json({access_token:'synthetic-viewer-access'});if(url.endsWith('/oauth2/validate'))return Response.json({client_id:'link-browser-client',user_id:'synthetic-twitch-viewer'});if(url.endsWith('/helix/users'))return Response.json({data:[{id:'synthetic-twitch-viewer',login:'synthetic_viewer',display_name:'Synthetic Viewer'}]});return Response.error();};
  const portal=new ViewerCommunityPortal(store,features,cfg,external),dashboard=new DashboardServer(store,()=>({twitchConnected:false,channel:'acyjannik',startedAt:1}),logger,external,undefined,undefined,undefined,features.miniGames,features.arcade,undefined,undefined,undefined,undefined,undefined,portal);
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    assert.equal(await dashboard.start(),true);
    const intent=await fetch(`${base}/api/discord/v1/account-links/intents`,{method:'POST',headers:{Authorization:'Bearer synthetic-link-integration-secret-123456','Content-Type':'application/json'},body:JSON.stringify({discordUserId})});assert.equal(intent.status,201);
    const {authorizationUrl}=await intent.json() as {authorizationUrl:string};
    let oauthRequestSeen=false;browser=await chromium.launch({headless:true});const context=await browser.newContext({...devices['iPhone 13']});
    const page=await context.newPage(),consoleErrors:string[]=[];page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
    await page.goto(authorizationUrl);
    await page.route('**/community/link/twitch',async route=>{
      if(route.request().method()!=='POST')return route.continue();
      const response=await route.fetch({maxRedirects:0}),location=response.headers()['location'];assert.equal(response.status(),302);assert.ok(location);
      const auth=new URL(location);assert.equal(auth.origin,'https://id.twitch.tv');assert.equal(auth.pathname,'/oauth2/authorize');assert.equal(auth.searchParams.get('scope'),'');oauthRequestSeen=true;
      const callback=new URL(auth.searchParams.get('redirect_uri')||'');assert.equal(callback.origin,base);callback.searchParams.set('code','synthetic-oauth-code');callback.searchParams.set('state',auth.searchParams.get('state')||'');
      await route.fulfill({status:302,headers:{Location:callback.toString(),'Set-Cookie':response.headers()['set-cookie']||''}});
    });
    const button=page.getByRole('button',{name:'Weiter zu Twitch und verbinden'});await button.waitFor({state:'visible'});await button.click();
    await page.waitForURL('**/community/link/complete',{timeout:10_000});
    await page.getByRole('heading',{name:'💜 Twitch und Discord sind verbunden'}).waitFor();
    assert.equal(oauthRequestSeen,true,'the first form submission must reach Twitch authorization');assert.equal(new URL(page.url()).pathname,'/community/link/complete');assert.equal(store.communityAccountLinkStatus(discordUserId).linked,true);assert.deepEqual(consoleErrors,[],'CSP must not block the OAuth navigation');
    const noJsContext=await browser.newContext({...devices['iPhone 13'],javaScriptEnabled:false});const noJsPage=await noJsContext.newPage();await noJsPage.goto(authorizationUrl);await noJsPage.getByRole('alert').getByText(/JavaScript aktiviert sein/u).waitFor();assert.equal(await noJsPage.getByRole('button',{name:'Weiter zu Twitch und verbinden'}).isDisabled(),true);await noJsContext.close();
  }finally{await browser?.close();await dashboard.stop();store.close();process.env=env;}
});
