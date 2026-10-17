import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import {chromium} from 'playwright';
import {DashboardServer} from '../src/dashboard.js';
import {FeatureStore} from '../src/feature-store.js';
import {logger} from '../src/logger.js';

async function freePort():Promise<number>{const server=net.createServer();await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const port=(server.address() as net.AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}

test('Event Director settings card loads and remains usable at an iPhone viewport',async()=>{
  const env={...process.env},store=new FeatureStore(':memory:'),port=await freePort(),base=`http://127.0.0.1:${port}`;
  process.env.TWITCH_CLIENT_ID='event-director-browser-client';process.env.TWITCH_CLIENT_SECRET='event-director-browser-secret';process.env.DASHBOARD_REDIRECT_URI=`${base}/dashboard/oauth/callback`;process.env.DASHBOARD_ADMIN_IDS='director-admin';process.env.DASHBOARD_HOST='127.0.0.1';process.env.DASHBOARD_PORT=String(port);
  const fetchImpl:typeof fetch=async input=>{const url=String(input);if(url.endsWith('/oauth2/token'))return Response.json({access_token:'synthetic-director-token'});if(url.endsWith('/oauth2/validate'))return Response.json({client_id:'event-director-browser-client',user_id:'director-admin',login:'director_admin'});if(url.endsWith('/helix/users'))return Response.json({data:[{id:'director-admin',login:'director_admin',display_name:'Director Admin'}]});throw new Error('Unexpected browser-test request');};
  const dashboard=new DashboardServer(store,()=>({twitchConnected:false,channel:'acyjannik',startedAt:1}),logger,fetchImpl);let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    assert.equal(await dashboard.start(),true);
    const login=await fetch(`${base}/dashboard/login`,{redirect:'manual'}),state=new URL(login.headers.get('location')||'').searchParams.get('state')||'',stateCookie=login.headers.get('set-cookie')?.split(';')[0]||'';
    const callback=await fetch(`${base}/dashboard/oauth/callback?code=synthetic&state=${state}`,{headers:{Cookie:stateCookie},redirect:'manual'});assert.equal(callback.status,303);
    const session=callback.headers.getSetCookie().find(value=>value.startsWith('community_admin='))?.split(';')[0]||'';assert.ok(session);
    browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});await context.addCookies([{name:'community_admin',value:session.split('=')[1]!,domain:'127.0.0.1',path:'/',httpOnly:true,secure:true,sameSite:'Lax'}]);
    const page=await context.newPage(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`${base}/dashboard#spiele/director`,{waitUntil:'domcontentloaded'});
    const card=page.locator('[data-event-director]');await card.waitFor({state:'visible'});await page.getByLabel('Event Director aktiv').waitFor();await page.getByLabel('Boss-Intervall mindestens (Min.)').waitFor();
    const dimensions=await card.evaluate(element=>({width:element.getBoundingClientRect().width,right:element.getBoundingClientRect().right,viewport:innerWidth}));assert.ok(dimensions.width>0&&dimensions.right<=dimensions.viewport+1,`Director-Karte passt in den mobilen Viewport: ${JSON.stringify(dimensions)}`);assert.deepEqual(errors,[]);
    await context.close();
  }finally{await browser?.close();await dashboard.stop();store.close();process.env=env;}
});
