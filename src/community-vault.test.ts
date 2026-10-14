import assert from 'node:assert/strict';
import test from 'node:test';
import { CommunityVault, scoreGuess } from './community-vault.js';
import { FeatureStore } from './feature-store.js';
import { testConfig } from './test-config.js';
import type { ChatMessage } from './types.js';

function chat(id:string,code:string,now:number):ChatMessage{return {eventId:id,broadcasterUserId:'broadcaster-1',senderUserId:'viewer-'+id,senderLogin:'viewer',senderDisplayName:'Viewer '+id,message:'!code '+code,sentAt:now};}
function setup(){const store=new FeatureStore(':memory:'),vault=new CommunityVault(store,'bot-1');vault.updateSettings({enabled:true});return {store,vault};}

test('Community-Tresor bewertet führende Nullen und doppelte Ziffern mathematisch korrekt',()=>{
  assert.deepEqual(scoreGuess('042','427'),{exact:0,misplaced:2});
  assert.deepEqual(scoreGuess('042','440'),{exact:1,misplaced:1});
  assert.deepEqual(scoreGuess('042','404'),{exact:0,misplaced:2});
});

test('Tresor speichert keine Ratestrings, schützt den Geheimcode und begrenzt Versuche pro Zuschauer',()=>{
  const {store,vault}=setup(),now=100_000;assert.equal(vault.startManual(now).ok,true);
  store.miniGameQuery(db=>db.prepare("UPDATE community_vault_rounds SET secret_code='042' WHERE status='active'").run());
  const secret=store.miniGameQuery(db=>(db.prepare("SELECT secret_code FROM community_vault_rounds WHERE status='active'").get() as {secret_code:string}).secret_code);
  const publicState=JSON.stringify(vault.publicSnapshot(now));assert.equal(publicState.includes(secret),false);
  vault.guess(chat('first','404',now),['404'],now);
  vault.guess(chat('second','427',now),['427'],now);
  const rows=store.miniGameQuery(db=>db.prepare('SELECT exact_count,misplaced_count FROM community_vault_attempts ORDER BY submitted_at').all()) as Array<{exact_count:number;misplaced_count:number}>;
  assert.deepEqual(rows,[{exact_count:0,misplaced_count:2},{exact_count:0,misplaced_count:2}]);
  assert.equal(JSON.stringify(store.miniGameQuery(db=>db.prepare('SELECT * FROM community_vault_attempts').all())).includes('404'),false);
  const repeatedMessage=chat('repeat','000',now+1_000);repeatedMessage.senderUserId='viewer-first';const repeated=vault.guess(repeatedMessage,['000'],now+1_000);assert.match(repeated.privateHint||'',/Warte kurz/u);
  store.close();
});

test('gleiche richtige Versuche öffnen den Tresor genau einmal und belohnen innerhalb des Tageslimits idempotent',()=>{
  const {store,vault}=setup(),now=200_000;store.setConfig('xp_settings',{dailyGameCap:5});assert.equal(vault.startManual(now).ok,true);
  store.miniGameQuery(db=>db.prepare("UPDATE community_vault_rounds SET secret_code='042' WHERE status='active'").run());
  vault.updateSettings({participantXp:5,solverBonusXp:5});
  vault.guess(chat('winner-a','000',now+1),['000'],now+1);
  const correct=chat('winner-correct','042',now+3_002);correct.senderUserId='viewer-winner-a';
  const a=vault.guess(correct,['042'],now+3_002),b=vault.guess(chat('winner-b','042',now+3_003),['042'],now+3_003);
  assert.equal(a.privateHint,'Tresor geöffnet!');assert.equal(b.privateHint,'Gerade ist kein Tresor offen.');
  assert.equal(store.xp('viewer-winner-a').xp,5);assert.equal(store.xp('viewer-winner-b').xp,0);
  const notices=vault.tickMessages(now+3_004);assert.equal(notices.length,1);assert.equal(notices[0]?.category,'vault');
  assert.equal(vault.tickMessages(now+3_005).length,0);assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM community_vault_awards').get() as {n:number}).n),2,JSON.stringify(store.miniGameQuery(db=>db.prepare('SELECT * FROM community_vault_awards').all())));
  store.close();
});

test('Automatik braucht drei unterschiedliche echte aktive Zuschauer, Live-Freigabe im Aufrufer und respektiert Stunde und Cooldown',()=>{
  const {store,vault}=setup(),now=5_000_000;vault.updateSettings({enabled:true,autoStart:true,minActiveViewers:3,cooldownMinutes:30});
  assert.equal(vault.autoStartReady(now,0,false,now-600_000),false);
  const message=(userId:string,eventId:string,text:string):ChatMessage=>({eventId,broadcasterUserId:'broadcaster-1',senderUserId:userId,senderLogin:userId,senderDisplayName:userId,message:text,sentAt:now});
  vault.observeActivity(message('viewer-a','a','Hallo Community'),now);vault.observeActivity(message('viewer-a','a2','Noch ein Satz'),now+1);
  vault.observeActivity(message('viewer-b','b','Guten Abend zusammen'),now+2);assert.equal(vault.activeViewerCount(now+2),2);
  vault.observeActivity(message('viewer-c','c','Freut mich hier zu sein'),now+3);assert.equal(vault.activeViewerCount(now+3),3);
  assert.equal(vault.autoStartReady(now+3,3,true,now-600_000),false);
  assert.equal(vault.autoStartReady(now+3,3,false,now-60_000),false);
  assert.equal(vault.autoStartReady(now+3,3,false,now-600_000),true);
  assert.equal(vault.startAutomatic(now+3).ok,true);assert.equal(vault.autoStartReady(now+3+60*60_000-1,3,false,now-600_000),false);
  const restarted=new CommunityVault(store);assert.equal((restarted.publicSnapshot(now+4).vault as {status:string}).status,'active');
  store.close();
});

test('Tresor läuft nach Zeitablauf aus, löst den Code auf und versteckt ihn danach nicht vor OBS',()=>{
  const {store,vault}=setup(),now=300_000;vault.startManual(now);store.miniGameQuery(db=>db.prepare("UPDATE community_vault_rounds SET secret_code='042',ends_at=? WHERE status='active'").run(now+1));
  assert.equal(JSON.stringify(vault.publicSnapshot(now+2)).includes('042'),false);
  const messages=vault.tickMessages(now+2);assert.match(messages[0]?.message||'',/042/u);
  const snapshot=vault.publicSnapshot(now+3);assert.equal((snapshot.vault as {resultCode:string}).resultCode,'042');store.close();
});
