import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import {chromium} from 'playwright';
import {CommunityFeatures} from '../src/community-features.js';
import {CommunityHauntedHouse} from '../src/community-haunted-house.js';
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
  const halloween=store.event('halloween');assert.ok(halloween);store.saveEvent({...halloween,active:false,startAt:null,endAt:null});assert.equal(store.setEventActive('halloween',true,launchTime),true);
  const hauntedHouse=new CommunityHauntedHouse(store);for(let i=0;i<25;i++)hauntedHouse.recordAcceptedPlay(`browser-haunted-${i}`,i<5?'viewer-world':`viewer-${i%4}`,launchTime+i);
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
    const livePoll=store.createPoll({type:'chat',question:'Welche Route?',options:[{label:'Waldweg'},{label:'Bergpfad'}],durationMs:60_000,allowVoteChange:false,createdBy:'admin-only',now:Date.now()});assert.ok(livePoll);
    browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1365,height:900}});
    await page.context().addCookies([{name:'community_viewer',value:viewerCookie.split('=')[1],domain:'127.0.0.1',path:'/community',httpOnly:true,secure:false,sameSite:'Lax'}]);
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/community');const openCommunityNav=async()=>{const toggle=page.locator('#community-menu-toggle');if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click()};
    await page.getByRole('heading',{name:'Live-Entscheidung'}).waitFor();await page.getByRole('button',{name:'Für Bergpfad stimmen'}).click();await page.getByText('Deine Stimme ist gezählt. Sie kann nicht geändert werden.',{exact:true}).waitFor();store.endPoll(livePoll!.id,Date.now());
    await page.getByText('Viewer World',{exact:true}).waitFor();await page.getByRole('heading',{name:'Schön, dass du da bist, Viewer World! 👋'}).waitFor();await page.getByRole('heading',{name:'Elios Zimmer 🐱'}).waitFor();
    await page.getByText(/Heute · Gib Elio Aufmerksamkeit/u).waitFor();
    await page.getByRole('button',{name:'Füttern'}).click();await page.getByText(/Elio wurde gefüttert/u).waitFor();await page.getByText('Elios letzte Erlebnisse',{exact:true}).waitFor();await page.locator('.pet-event-list').getByText(/Elio|Mjam/u).first().waitFor();
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
    await page.getByRole('button',{name:'Menü öffnen'}).click();await page.getByRole('link',{name:'Start'}).click();if(screenshots)await page.screenshot({path:path.join(screenshots,'community-world-home-mobile.png'),fullPage:true});
    await page.setViewportSize({width:1365,height:900});await page.getByRole('link',{name:'Spukhaus 🎃'}).click();await page.getByRole('heading',{name:'Das ACY Spukhaus 🎃'}).waitFor();
    await page.getByText('25 / 100 Runden',{exact:true}).waitFor();await page.getByText('Die Kürbiskammer',{exact:true}).waitFor();assert.equal(await page.getByText('Freigeschaltet',{exact:true}).count(),2);await page.getByText('Der verzauberte Dachboden',{exact:true}).waitFor();
    assert.ok(await page.locator('.house-room.locked').count()===1,'Dachboden bleibt bis zum gemeinsamen Ziel verschlossen');
    await page.getByText('Deine gültigen Halloween-Runden: 5',{exact:true}).waitFor();await page.locator('.house-achievements').getByText(/Erster Spukhaus-Besuch/u).waitFor();await page.locator('.house-achievements').getByText(/Mitternachts-Entdecker/u).waitFor();
    if(screenshots){await page.screenshot({path:path.join(screenshots,'haunted-house-desktop.png'),fullPage:true});}
    await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),'Spukhaus läuft mobil nicht horizontal über');
    if(screenshots)await page.screenshot({path:path.join(screenshots,'haunted-house-mobile.png'),fullPage:true});
    const publicPage=await browser.newPage();await publicPage.goto(base+'/community/haunted-house');await publicPage.getByText('25 / 100 Runden',{exact:true}).waitFor();
    await publicPage.getByText('Melde dich mit Twitch an, um deine Besuche und Abzeichen zu sehen.').waitFor();await publicPage.close();
    await openCommunityNav();await page.getByRole('link',{name:'Erinnerungen'}).click();await page.getByRole('heading',{name:'Community-Erinnerungen ✨'}).waitFor();
    await page.locator('#memory-form [name=text]').fill('Die Community hat den Endboss gemeinsam besiegt!');await page.locator('#memory-form [name=category]').selectOption('gaming');
    await page.locator('#memory-form [name=event]').fill('Browser-Test');await page.locator('#memory-form [name=clipUrl]').fill('https://clips.twitch.tv/FriendlyClipSlug123');
    const memoryResponses:string[]=[];page.on('response',response=>{if(response.url().includes('/community/api/memories'))memoryResponses.push(`${response.status()} ${response.url()}`)});
    await page.getByRole('button',{name:'Zur Prüfung einreichen'}).click();await page.waitForTimeout(500);assert.equal(await page.locator('#memory-status').textContent(),'Danke! Dein Moment wartet jetzt auf die Moderation.',`Erinnerungseinreichung fehlgeschlagen: ${memoryResponses.join(' | ')}`);
    const pendingMemory=store.communityMemories({status:'pending'});assert.equal(pendingMemory.length,1);assert.equal(store.moderateCommunityMemory(String(pendingMemory[0]?.id),'publish','admin-only',Date.now()),true);
    await page.reload();await page.locator('#memory-list').getByText('Die Community hat den Endboss gemeinsam besiegt!',{exact:true}).waitFor();await page.locator('#memory-list').getByRole('link',{name:'Twitch-Clip ansehen'}).waitFor();
    await page.getByRole('button',{name:'Mit 💜 reagieren'}).click();await page.getByRole('button',{name:'Du hast reagiert'}).waitFor();
    await page.locator('#memory-filters [name=category]').selectOption('gaming');await page.locator('#memory-filters [name=event]').selectOption('Browser-Test');
    await page.locator('#memory-list').getByText('Die Community hat den Endboss gemeinsam besiegt!',{exact:true}).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),'Erinnerungswand läuft mobil nicht horizontal über');
    await openCommunityNav();await page.getByRole('link',{name:'💡 Ideen'}).click();await page.getByRole('heading',{name:'Community-Ideen 💡'}).waitFor();
    const ideaText='Ein gemeinsamer gemütlicher Community-Spieleabend mit wechselnden Spielen';await page.locator('#idea-form textarea').fill(ideaText);
    const ideaResponses:string[]=[];page.on('response',response=>{if(response.url().includes('/community/api/ideas'))ideaResponses.push(`${response.status()} ${response.url()}`)});
    await page.locator('#idea-form button[type=submit]').click();await page.getByText('Danke! Deine Idee ist gespeichert und wartet auf die Moderation.',{exact:true}).waitFor();
    const pendingIdeas=store.communityIdeas({status:'pending'});assert.equal(pendingIdeas.length,1,`Ideeneinreichung fehlgeschlagen: ${ideaResponses.join(' | ')}`);assert.equal(store.moderateCommunityIdea(pendingIdeas[0]!.id,'approve','admin-only',Date.now()),true);
    await page.reload();await page.locator('#idea-list').getByText(ideaText,{exact:true}).waitFor();await page.locator('#idea-list').getByRole('button',{name:'💜 Diese Idee gefällt mir'}).click();await page.locator('#idea-status').getByText('Deine Stimme für diese Idee wurde gezählt.',{exact:true}).waitFor();
    const otherIdea=store.submitCommunityIdea({id:'browser-idea-second',userId:'viewer-idea-second',displayName:'IdeenFan2',text:'Ein gemeinsamer Retrospiele-Abend wäre toll',now:Date.now()});assert.equal(otherIdea.ok,true);assert.equal(store.moderateCommunityIdea('browser-idea-second','approve','admin-only',Date.now()),true);
    const approvedIdea=store.communityIdeas({status:'approved'}).find(x=>x.id===pendingIdeas[0]!.id)!;const secondApproved=store.communityIdea('browser-idea-second')!;
    const ideaPoll=store.createPoll({type:'chat',question:'Welche Community-Idee soll als Nächstes kommen?',options:[{label:approvedIdea.text,ideaId:approvedIdea.id},{label:secondApproved.text,ideaId:secondApproved.id}],durationMs:60_000,allowVoteChange:false,createdBy:'admin-only',now:Date.now()});assert.ok(ideaPoll);assert.equal(store.markIdeasVoting([approvedIdea.id,secondApproved.id],Date.now()),true);
    await page.reload();await page.locator('#idea-poll').getByRole('button',{name:'Für diese Idee stimmen'}).first().click();await page.locator('#idea-status').getByText('Deine Stimme wurde gezählt.',{exact:true}).waitFor();const result=store.activePoll();assert.equal(result?.totalVotes,1);if(result)store.endPoll(result.id,Date.now(),true);
    await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+1),'Ideenkasten läuft mobil nicht horizontal über');
    assert.deepEqual(errors,[]);
    const repeat=await fetch(base+'/community/api/mission/claim',{method:'POST',headers:{cookie:viewerCookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({missionId:'visit_elio'})});assert.equal(repeat.status,409);
  }finally{await browser?.close();await dashboard.stop();store.close();process.env=env;fs.rmSync(dir,{recursive:true,force:true});}
});
