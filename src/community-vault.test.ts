import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CommunityVault, formatGuessFeedback, scoreGuess } from './community-vault.js';
import { FeatureStore } from './feature-store.js';
import { testConfig } from './test-config.js';
import type { ChatMessage } from './types.js';

function chat(id:string,code:string,now:number):ChatMessage{return {eventId:id,broadcasterUserId:'broadcaster-1',senderUserId:'viewer-'+id,senderLogin:'viewer',senderDisplayName:'Viewer '+id,message:'!code '+code,sentAt:now};}
function setup(){const store=new FeatureStore(':memory:'),vault=new CommunityVault(store,'bot-1');vault.updateSettings({enabled:true});return {store,vault};}

test('Community-Tresor bewertet führende Nullen und doppelte Ziffern mathematisch korrekt',()=>{
  assert.deepEqual(scoreGuess('042','427'),{exact:0,misplaced:2});
  assert.deepEqual(scoreGuess('042','440'),{exact:1,misplaced:1});
  assert.deepEqual(scoreGuess('042','404'),{exact:0,misplaced:2});
  assert.deepEqual(scoreGuess('112','121'),{exact:1,misplaced:2});
  assert.deepEqual(scoreGuess('112','111'),{exact:2,misplaced:0});
  assert.match(formatGuessFeedback('viewer',1,2,4,'Noch ein Tipp.'),/1 Ziffer steht an der richtigen Stelle.*2 weitere Ziffern sind im Code.*0 Ziffern kommen nicht im Code vor/u);
});

test('Tresorstart erklärt XXX als Platzhalter und verrät keine dreistellige Zahl',()=>{
  const {store,vault}=setup(),result=vault.startManual(50_000);
  assert.equal(result.ok,true);assert.match(result.message,/🔐 COMMUNITY-TRESOR GEÖFFNET!/u);assert.match(result.message,/!code XXX/u);
  assert.match(result.message,/XXX ist ein Platzhalter.*durch drei selbst gewählte Ziffern/u);assert.match(result.message,/3 Minuten/u);assert.match(result.message,/bis zu 5 XP/u);
  assert.doesNotMatch(result.message,/(?<!\d)\d{3}(?!\d)/u);assert.doesNotMatch(result.message,/zum Beispiel/u);
  store.close();
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
  const attemptColumns=store.miniGameQuery(db=>db.prepare('PRAGMA table_info(community_vault_attempts)').all()) as Array<{name:string}>;
  assert.equal(attemptColumns.some(({name})=>/guess|code/iu.test(name)),false,'persisted attempts contain feedback only, never the submitted guess');
  const repeatedMessage=chat('repeat','000',now+1_000);repeatedMessage.senderUserId='viewer-first';const repeated=vault.guess(repeatedMessage,['000'],now+1_000);assert.match(repeated.privateHint||'',/Warte noch/u);
  store.close();
});

test('gleiche richtige Versuche öffnen den Tresor genau einmal und belohnen innerhalb des Tageslimits idempotent',()=>{
  const {store,vault}=setup(),now=200_000;store.setConfig('xp_settings',{dailyGameCap:5});assert.equal(vault.startManual(now).ok,true);
  store.miniGameQuery(db=>db.prepare("UPDATE community_vault_rounds SET secret_code='042' WHERE status='active'").run());
  vault.updateSettings({participantXp:5,solverBonusXp:5});
  vault.guess(chat('winner-a','000',now+1),['000'],now+1);
  const correct=chat('winner-correct','042',now+3_002);correct.senderUserId='viewer-winner-a';
  const a=vault.guess(correct,['042'],now+3_002),b=vault.guess(chat('winner-b','042',now+3_003),['042'],now+3_003);
  assert.match(a.privateHint||'',/tatsächliche Auszahlung: \+5 XP/u);assert.equal(b.privateHint,'Gerade ist kein Tresor offen.');
  assert.equal(store.xp('viewer-winner-a').xp,5);assert.equal(store.xp('viewer-winner-b').xp,0);
  const awards=store.miniGameQuery(db=>db.prepare('SELECT award_type,xp FROM community_vault_awards ORDER BY award_type').all()) as Array<{award_type:string;xp:number}>;assert.deepEqual(awards,[{award_type:'participant',xp:5},{award_type:'solver',xp:0}],'der Verlauf speichert tatsächlich gebuchte XP statt den konfigurierten Sollwert');
  const notices=vault.tickMessages(now+3_004);assert.equal(notices.length,1);assert.equal(notices[0]?.category,'vault');
  assert.match(notices[0]?.message||'',/1 qualifizierte Person · 5 XP tatsächlich ausgezahlt/u);
  assert.equal(vault.tickMessages(now+3_005).length,0);assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM community_vault_awards').get() as {n:number}).n),2,JSON.stringify(store.miniGameQuery(db=>db.prepare('SELECT * FROM community_vault_awards').all())));
  assert.equal(vault.history()[0]?.xpAwarded,5);
  store.close();
});

test('Tresor lehnt Tipps nach der Deadline ab, vergibt keine XP und veröffentlicht die Auflösung einmal',()=>{
  const {store,vault}=setup(),now=400_000;assert.equal(vault.startManual(now).ok,true);
  store.miniGameQuery(db=>db.prepare("UPDATE community_vault_rounds SET secret_code='042',ends_at=? WHERE status='active'").run(now+1_000));
  const late=vault.guess(chat('late','042',now+1_001),['042'],now+1_001);assert.match(late.privateHint||'',/Zeit ist abgelaufen/u);
  assert.equal(store.xp('viewer-late').xp,0);assert.equal(vault.isActive(now+1_001),false);
  const notice=vault.tickMessages(now+1_002);assert.equal(notice.length,1);assert.match(notice[0]?.message||'',/042/);assert.match(notice[0]?.message||'',/keine XP vergeben/u);
  assert.equal(vault.tickMessages(now+1_003).length,0);store.close();
});

test('Abbruch verwirft offene Tipps ohne Belohnung und parallele Starts erzeugen nur eine Runde',async()=>{
  const {store,vault}=setup(),now=500_000;const attempts=await Promise.all(Array.from({length:8},(_,i)=>Promise.resolve().then(()=>vault.startManual(now+i))));
  assert.equal(attempts.filter(x=>x.ok).length,1);vault.guess(chat('pending','111',now+10),['111'],now+10);
  assert.equal(vault.cancel(now+20),true);assert.equal(vault.cancel(now+21),false);
  assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM community_vault_attempts').get() as {n:number}).n),0);
  assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT status FROM community_vault_rounds ORDER BY started_at DESC LIMIT 1').get() as {status:string}).status),'canceled');store.close();
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
  assert.equal(vault.isActive(now+4),true,'laufender Tresor gilt für automatische Chat-Tipps als belegt');
  const restarted=new CommunityVault(store);assert.equal((restarted.publicSnapshot(now+4).vault as {status:string}).status,'active');
  store.close();
});

test('Tresor läuft nach Zeitablauf aus, löst den Code auf und versteckt ihn danach nicht vor OBS',()=>{
  const {store,vault}=setup(),now=300_000;vault.startManual(now);store.miniGameQuery(db=>db.prepare("UPDATE community_vault_rounds SET secret_code='042',ends_at=? WHERE status='active'").run(now+1));
  assert.equal(JSON.stringify(vault.publicSnapshot(now+2)).includes('042'),false);
  const messages=vault.tickMessages(now+2);assert.match(messages[0]?.message||'',/042/u);
  const snapshot=vault.publicSnapshot(now+3);assert.equal((snapshot.vault as {resultCode:string}).resultCode,'042');store.close();
});

test('isolierte vollständige Runde erklärt Tipps, gewinnt einmal und übersteht Neustart ohne doppelte XP oder Meldung',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'vault-simulation-')),file=path.join(directory,'vault.sqlite'),now=900_000;
  let store=new FeatureStore(file),vault=new CommunityVault(store,'bot-1');vault.updateSettings({enabled:true,participantXp:5,solverBonusXp:5});
  const started=vault.startManual(now);assert.equal(started.ok,true);
  store.miniGameQuery(db=>db.prepare("UPDATE community_vault_rounds SET secret_code='427' WHERE status='active'").run());
  const opening=started.message;
  const hiddenCode=store.miniGameQuery(db=>(db.prepare("SELECT secret_code FROM community_vault_rounds WHERE status='active'").get() as {secret_code:string}).secret_code);
  assert.equal(hiddenCode,'427');assert.doesNotMatch(opening,/(?<!\d)\d{3}(?!\d)/u);assert.match(opening,/XXX ist ein Platzhalter/u);
  const viewer=(id:string,name:string,guess:string,at:number)=>{const message=chat(id+'-'+at,guess,at);message.senderUserId=id;message.senderDisplayName=name;return message;};
  const first=vault.guess(viewer('alice','Alice','111',now+1),['111'],now+1).privateHint||'';
  const second=vault.guess(viewer('alice','Alice','400',now+3_002),['400'],now+3_002).privateHint||'';
  const third=vault.guess(viewer('bob','Bob','729',now+3_003),['729'],now+3_003).privateHint||'';
  const invalid=vault.guess(viewer('cara','Cara','12',now+3_004),['12'],now+3_004).privateHint||'';
  assert.match(first,/0 Ziffern stehen an der richtigen Stelle.*0 weitere Ziffern sind im Code.*3 Ziffern kommen nicht im Code vor/u);
  assert.match(second,/1 Ziffer steht an der richtigen Stelle.*0 weitere Ziffern sind im Code.*2 Ziffern kommen nicht im Code vor/u);
  assert.match(third,/1 Ziffer steht an der richtigen Stelle.*1 weitere Ziffer ist im Code.*1 Ziffer kommt nicht im Code vor/u);
  assert.match(invalid,/!code XXX.*Ersetze XXX durch deine drei Ziffern/u);assert.doesNotMatch(invalid,/(?<!\d)\d{3}(?!\d)/u);
  const win=vault.guess(viewer('alice','Alice','427',now+6_003),['427'],now+6_003).privateHint||'';
  assert.match(win,/tatsächliche Auszahlung: \+10 XP/u);assert.equal(store.xp('alice').xp,10);
  assert.equal(vault.guess(viewer('alice','Alice','427',now+6_004),['427'],now+6_004).privateHint,'Gerade ist kein Tresor offen.');
  store.close();store=new FeatureStore(file);vault=new CommunityVault(store,'bot-1');
  const result=vault.tickMessages(now+6_005);assert.equal(result.length,1);
  assert.match(result[0]!.message,/Alice hat den Code geknackt.*1 qualifizierte Person · 10 XP tatsächlich ausgezahlt/u);
  assert.deepEqual(vault.tickMessages(now+6_006),[],'nach Neustart wird die Abschlussmeldung nicht doppelt gesendet');
  assert.equal(store.xp('alice').xp,10,'Neustart zahlt die Ledger-Buchung nicht erneut aus');
  assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM community_vault_awards').get() as {n:number}).n),2);
  store.close();fs.rmSync(directory,{recursive:true,force:true});
});

test('isolierter Zeitablauf löst den Code nach Neustart genau einmal auf und zahlt keine XP',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'vault-timeout-')),file=path.join(directory,'vault.sqlite'),now=1_200_000;
  let store=new FeatureStore(file),vault=new CommunityVault(store,'bot-1');vault.updateSettings({enabled:true});
  assert.equal(vault.startManual(now).ok,true);
  store.miniGameQuery(db=>db.prepare("UPDATE community_vault_rounds SET secret_code='427',ends_at=? WHERE status='active'").run(now+100));
  vault.guess(chat('bad','111',now+10),['111'],now+10);store.close();
  store=new FeatureStore(file);vault=new CommunityVault(store,'bot-1');
  const output=vault.tickMessages(now+101);assert.equal(output.length,1);
  assert.equal(output[0]!.message,'⏰ Die Tresor-Zeit ist abgelaufen. Der Code war 427. Es wurden keine XP vergeben.');
  assert.deepEqual(vault.tickMessages(now+102),[]);assert.equal(store.xp('viewer-bad').xp,0);
  store.close();fs.rmSync(directory,{recursive:true,force:true});
});
