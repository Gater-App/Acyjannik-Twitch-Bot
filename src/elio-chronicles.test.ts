import test from 'node:test';
import assert from 'node:assert/strict';
import { FeatureStore } from './feature-store.js';
import { CommunityChaos, type ChaosGame } from './community-chaos.js';
import { ElioChronicles } from './elio-chronicles.js';
import { ELIO_CHRONICLES_SEASON_1, finalEnding, type StoryMission } from './elio-chronicles-season-1.js';
import type { ChatMessage } from './types.js';

const message=(id:string,body:string):ChatMessage=>({eventId:id,broadcasterUserId:'broadcaster',senderUserId:id,senderLogin:id,senderDisplayName:id,message:body,sentAt:1});
const command=(game:ChaosGame)=>({elio_rescue:'retten',potion:'rot',treasure:'schatz',wake_elio:'aufwachen',portal:'portal',bodyguard:'bodyguard'}[game]);

test('season one is complete, versioned, data-driven, and has three stable endings',()=>{
  assert.equal(ELIO_CHRONICLES_SEASON_1.version,1);assert.deepEqual(ELIO_CHRONICLES_SEASON_1.chapters.map(c=>c.missions.length),[8,8,8,8]);
  for(const chapter of ELIO_CHRONICLES_SEASON_1.chapters)for(const mission of chapter.missions){assert.ok(mission.intro.length>20);assert.ok(mission.success.length>15);assert.ok(mission.failure.length>15);assert.ok(mission.clue);}
  assert.equal(finalEnding(10,1,{}).id,'heroic');assert.equal(finalEnding(6,5,{}).id,'chaotic');assert.equal(finalEnding(1,8,{}).id,'mysterious');
});

test('protected preview explains the actual first three missions and every one of 32 missions is playable',()=>{
  const store=new FeatureStore(':memory:'),chaos=new CommunityChaos(store),story=new ElioChronicles(store,chaos),preview=story.preview();
  const missions=preview.season.chapters.flatMap(chapter=>chapter.missions);
  assert.equal(missions.length,32);
  for(const mission of missions){assert.ok(mission.mechanic);assert.ok(mission.task);assert.ok(mission.commands.length);assert.ok(mission.successCondition);assert.ok(mission.xpRule);assert.ok(mission.completionRule);assert.ok(mission.storyProgress);}
  const rescue=missions[0]!,potion=missions[1]!;
  assert.deepEqual(rescue.commands,['!retten']);assert.match(rescue.successCondition,/Mindestens eine/u);assert.match(rescue.xpRule,/20\/15\/10/u);
  assert.deepEqual(potion.commands,['!schatz']);assert.match(potion.xpRule,/Erste Person: 20 XP/u);
  const third=missions[2]!;assert.deepEqual(third.commands,['!aufwachen']);assert.match(third.successCondition,/mindestens fünf/iu);assert.match(third.xpRule,/8 XP/u);
  store.close();
});

test('started mission announcement includes story, task, valid command, and the complete bounded chat text',()=>{
  const store=new FeatureStore(':memory:'),chaos=new CommunityChaos(store),story=new ElioChronicles(store,chaos);story.updateSettings({enabled:true});story.startSeason(1);
  const mission=ELIO_CHRONICLES_SEASON_1.chapters[0]!.missions[0]!,active=story.startNext('admin',mission.id,100);
  assert.ok(active.prompt.includes('📖 Rettet Elio!'));assert.ok(active.prompt.includes('Aufgabe:'));assert.ok(active.prompt.includes('!retten'));assert.ok(active.prompt.includes('Erfolg:'));assert.ok(active.prompt.length<=460);
  store.close();
});

test('story decision announcements list the question, every labeled command, and fit Twitch chat limits',()=>{
  const store=new FeatureStore(':memory:'),chaos=new CommunityChaos(store),story=new ElioChronicles(store,chaos);story.updateSettings({enabled:true});story.startSeason(1);let now=1;
  for(const chapter of ELIO_CHRONICLES_SEASON_1.chapters)for(const item of chapter.missions){const mission=item as StoryMission,event=story.startNext('admin',mission.id,now);if(mission.decision){assert.ok(event.prompt.includes(mission.decision.prompt));for(const option of mission.decision.options)assert.ok(event.prompt.includes(`!${option.command}`));assert.ok(event.prompt.length<=460,`${mission.id}: ${event.prompt.length}`);}const headcount=mission.game==='wake_elio'?5:1;for(let i=0;i<headcount;i++)chaos.participate(message(`announce-${mission.id}-${i}`,`!${command(mission.game)}`),command(mission.game),now+1+i);chaos.finishDue(event.deadline);story.reconcile(event.deadline);now=event.deadline+1;}
  store.close();
});

test('flags default off and story start reuses existing chaos event and XP ledger',()=>{
  const store=new FeatureStore(':memory:'),chaos=new CommunityChaos(store,()=>0),story=new ElioChronicles(store,chaos);
  assert.equal(story.status().settings.enabled,false);assert.equal(story.status().season.status,'draft');
  assert.throws(()=>story.startSeason(1),/Aktiviere Elio Chronicles/u);
  chaos.updateSettings({enabled:true});story.updateSettings({enabled:true});story.startSeason(1);
  const event=story.startNext('admin',undefined,10);assert.equal(event.game,'elio_rescue');assert.match(event.prompt,/!retten/u);
  chaos.participate(message('viewer','!retten'),'retten',11);chaos.finishDue(event.deadline);story.reconcile(event.deadline);
  assert.equal(story.status().progress.completed,1);assert.equal(story.status().progress.clueCount,1);assert.equal(store.xpTop(1)[0]?.xp,20);
  store.close();
});

test('Elio Chronicles can use the shared minigame engine while general Community-Chaos stays disabled',()=>{
  const store=new FeatureStore(':memory:'),chaos=new CommunityChaos(store,()=>0),story=new ElioChronicles(store,chaos);
  story.updateSettings({enabled:true});story.startSeason(1);
  assert.equal(chaos.settings().enabled,false);
  assert.throws(()=>chaos.start('treasure','admin',2),/Community-Chaos ist im Dashboard ausgeschaltet/u);
  const event=story.startNext('admin',undefined,10);
  assert.equal(event.game,'elio_rescue');assert.match(event.prompt,/!retten/u);
  chaos.participate(message('story-viewer','!retten'),'retten',11);
  chaos.finishDue(event.deadline);story.reconcile(event.deadline);
  assert.equal(story.status().progress.completed,1);
  assert.equal(store.users().find(user=>user.userId==='story-viewer')?.xp,20);
  assert.equal(store.discordOutboxBatch(event.deadline+1).length,0,'Story-Diary und allgemeine Chaos-Ankündigungen bleiben ohne ihre eigenen Freigaben aus');
  store.close();
});

test('full four chapter story simulation resumes at exact mission and stores choices and clues once',()=>{
  const store=new FeatureStore(':memory:'),chaos=new CommunityChaos(store,()=>0),story=new ElioChronicles(store,chaos);
  chaos.updateSettings({enabled:true});story.updateSettings({enabled:true});story.startSeason(100);
  let now=1000;
  for(let chapterIndex=0;chapterIndex<4;chapterIndex++)for(let missionIndex=0;missionIndex<8;missionIndex++){
    const chapter=ELIO_CHRONICLES_SEASON_1.chapters[chapterIndex]!,mission=chapter.missions[missionIndex]! as StoryMission;
    assert.equal(story.status().chapter?.id,chapter.id);assert.equal(story.status().currentMission?.id,mission.id);
    const active=story.startNext('admin',mission.id,now);assert.equal(active.game,mission.game);assert.ok(active.prompt.includes(`!${command(mission.game)}`));assert.ok(active.prompt.length<=460);for(const option of mission.decision?.options||[])assert.ok(active.prompt.includes(`!${option.command}`));
    if(mission.decision){for(const [optionIndex,option] of mission.decision.options.entries()){const count=optionIndex===0?2:1;for(let vote=0;vote<count;vote++){const voter=message(`voter-${chapterIndex}-${missionIndex}-${optionIndex}-${vote}`,`!${option.command}`);assert.equal(story.castVote(voter,option.command,now+1+vote),true);}}}
    if(mission.id==='shadowpaw-strikes')assert.match(active.prompt,/Nova führt die Community zu einem sicheren Zugang/u);
    const total=mission.game==='wake_elio'?5:1;
    for(let i=0;i<total;i++)chaos.participate(message(`viewer-${chapterIndex}-${missionIndex}-${i}`,`!${command(mission.game)}`),command(mission.game),now+3+i);
    chaos.finishDue(active.deadline);story.reconcile(active.deadline);story.reconcile(active.deadline+1);
    now=active.deadline+100;
  }
  const final=story.status();assert.equal(final.season.status,'completed');assert.equal(final.progress.completed,32);assert.equal(final.progress.clueCount,32);assert.ok(['heroic','chaotic','mysterious'].includes(final.ending||''));
  assert.equal(final.decisions['nova-trust'],'trust');assert.equal(final.decisions['portal-choice'],'home');
  assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM elio_chronicles_events WHERE status=\'completed\'').get() as {n:number}).n),32);
  store.close();
});

test('pausing blocks mission starts, voting is first-choice and duplicate completions cannot advance twice',()=>{
  const store=new FeatureStore(':memory:'),chaos=new CommunityChaos(store,()=>0),story=new ElioChronicles(store,chaos);
  chaos.updateSettings({enabled:true});story.updateSettings({enabled:true});story.startSeason(1);story.pause(2);
  assert.throws(()=>story.startNext('admin',undefined,3),/Staffel muss aktiv sein/u);story.resume(4);
  const mission=ELIO_CHRONICLES_SEASON_1.chapters[0]!.missions[0]!,active=story.startNext('admin',mission.id,10);
  chaos.participate(message('viewer','!retten'),'retten',11);chaos.finishDue(active.deadline);story.reconcile(active.deadline);story.reconcile(active.deadline+1);
  assert.equal(story.status().progress.completed,1);store.close();
});

test('pausing during a mission lets its stored result settle once but prevents the next start',()=>{
  const store=new FeatureStore(':memory:'),chaos=new CommunityChaos(store,()=>0),story=new ElioChronicles(store,chaos);chaos.updateSettings({enabled:true});story.updateSettings({enabled:true});story.startSeason(1);
  const event=story.startNext('admin',undefined,10);chaos.participate(message('pause-viewer','!retten'),'retten',11);story.pause(12);chaos.finishDue(event.deadline);story.reconcile(event.deadline);
  assert.equal(story.status().season.status,'paused');assert.equal(story.status().progress.completed,1);assert.throws(()=>story.startNext('admin',undefined,event.deadline+1),/Staffel muss aktiv sein/u);
  story.resume(event.deadline+2);assert.equal(story.status().currentMission?.id,'missing-toy');store.close();
});

test('a failed mission follows its alternate route without unlocking its clue or blocking the chapter',()=>{
  const store=new FeatureStore(':memory:'),chaos=new CommunityChaos(store,()=>0),story=new ElioChronicles(store,chaos);
  chaos.updateSettings({enabled:true});story.updateSettings({enabled:true});story.startSeason(1);const event=story.startNext('admin',undefined,10);
  chaos.finishDue(event.deadline);story.reconcile(event.deadline);assert.equal(story.status().progress.completed,1);assert.equal(story.status().progress.clueCount,0);assert.equal(story.status().currentMission?.id,'missing-toy');
  store.close();
});

test('a correct potion answer advances the story even when the global XP cap pays zero',()=>{
  const store=new FeatureStore(':memory:'),chaos=new CommunityChaos(store,()=>0),story=new ElioChronicles(store,chaos);
  chaos.updateSettings({enabled:true});story.updateSettings({enabled:true});story.startSeason(1);store.setConfig('xp_settings',{dailyGameCap:0});let now=10;
  for(const mission of ELIO_CHRONICLES_SEASON_1.chapters[0]!.missions.slice(0,3)){
    const event=story.startNext('admin',mission.id,now),participants=mission.game==='wake_elio'?5:1;
    for(let i=0;i<participants;i++)chaos.participate(message(`cap-${mission.id}-${i}`,`!${command(mission.game)}`),command(mission.game),now+1+i);
    chaos.finishDue(event.deadline);story.reconcile(event.deadline);now=event.deadline+1;
  }
  const potion=ELIO_CHRONICLES_SEASON_1.chapters[0]!.missions[3]!,event=story.startNext('admin',potion.id,now),snapshot=store.miniGameQuery(db=>db.prepare('SELECT settings_json FROM community_chaos_events WHERE id=?').get(event.id) as {settings_json:string}),secret=(JSON.parse(snapshot.settings_json) as {secret:string}).secret;
  chaos.participate(message('cap-correct',`!${secret}`),secret,now+1);chaos.finishDue(event.deadline);story.reconcile(event.deadline);
  assert.equal(story.status().lastEvents[0]?.result && (story.status().lastEvents[0]!.result as {success:boolean}).success,true);assert.equal(story.status().progress.failedMissions,0);assert.equal(store.xpTop(1).length,0);store.close();
});

test('an active chronicle mission is recovered after service recreation and completes once',()=>{
  const store=new FeatureStore(':memory:'),chaos=new CommunityChaos(store,()=>0),story=new ElioChronicles(store,chaos);
  chaos.updateSettings({enabled:true});story.updateSettings({enabled:true});story.startSeason(1);const event=story.startNext('admin',undefined,10);chaos.participate(message('restart-viewer','!retten'),'retten',11);
  const recoveredChaos=new CommunityChaos(store,()=>0),recovered=new ElioChronicles(store,recoveredChaos);
  assert.equal(recovered.status().active?.missionId,'window-shadow');recoveredChaos.finishDue(event.deadline);recovered.reconcile(event.deadline);recovered.reconcile(event.deadline+1);
  assert.equal(recovered.status().progress.completed,1);assert.equal(store.xpTop(1)[0]?.xp,20);store.close();
});

test('controlled whole-season runs can reach the chaotic and mysterious endings',()=>{
  const simulate=(openPortal:boolean)=>{const store=new FeatureStore(':memory:'),chaos=new CommunityChaos(store,()=>0),story=new ElioChronicles(store,chaos);chaos.updateSettings({enabled:true});story.updateSettings({enabled:true});story.startSeason(1);let now=100;
    for(const chapter of ELIO_CHRONICLES_SEASON_1.chapters)for(const item of chapter.missions){const mission=item as StoryMission,event=story.startNext('simulation',mission.id,now);if(mission.decision){for(const [index,option] of mission.decision.options.entries()){const count=mission.id==='portal-choice'&&openPortal?(option.id==='open'?2:optionIndexCount(option.id)):0;if(count)for(let i=0;i<count;i++)story.castVote(message(`vote-${mission.id}-${option.id}-${i}`,`!${option.command}`),option.command,now+1);}}
      chaos.finishDue(event.deadline);story.reconcile(event.deadline);now=event.deadline+1;}
    const ending=story.status().ending;assert.equal(story.status().progress.completed,32);store.close();return ending;};
  assert.equal(simulate(true),'chaotic');assert.equal(simulate(false),'mysterious');
});

function optionIndexCount(optionId:string){return optionId==='home'?0:1;}
