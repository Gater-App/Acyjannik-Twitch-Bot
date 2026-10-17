import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { FeatureStore } from './feature-store.js';
import { CommunityArcade, type PetState } from './community-arcade.js';
import { CommunityVault } from './community-vault.js';
import { communityWidgetHtml } from './dashboard-community-ui.js';
import type { ChatMessage } from './types.js';
import { DEFAULT_8BALL_ANSWERS, LEGACY_DEFAULT_8BALL_ANSWERS } from './eight-ball-answers.js';

function setup(chooseIndex?:(exclusiveMax:number)=>number){const store=new FeatureStore(':memory:');const arcade=new CommunityArcade(store,'broadcaster',chooseIndex);return {store,arcade};}
function message(user:string,event:string,text:string):ChatMessage{return {eventId:event,messageId:event,broadcasterUserId:'broadcaster',senderUserId:user,senderLogin:user,senderDisplayName:user,message:text,sentAt:1,isModerator:false};}

test('Community-Pet bleibt gemeinschaftlich, begrenzt Werte und dedupliziert Events',()=>{
  const {store,arcade}=setup();arcade.updateSettings({...arcade.settings(),petEnabled:true});
  const before=arcade.pet();assert.equal(before.stage,'egg');assert.equal(before.name,'Elio');
  assert.match(arcade.handle(message('viewer','status','!pet'),'pet',[],999)||'',/Elio 🐱 · Kätzchen/u);
  assert.match(arcade.handle(message('u1','e1','!feed'),'feed',[],1000)||'',/Katzenfutter/u);
  assert.match(arcade.handle(message('u1','e1','!feed'),'feed',[],1001)||'',/bereits verarbeitet/u);
  assert.equal(arcade.pet().hunger,78);
  assert.match(arcade.handle(message('u1','e2','!play'),'play',[],2000)||'',/noch/u);
  assert.equal(arcade.pet().level,1);
  store.close();
});

test('Elios Stimmungen folgen nachvollziehbar seinen Werten und einem zeitnahen seltenen Ereignis',()=>{
  const {store,arcade}=setup();
  try{
    const set=(hunger:number,happiness:number,energy:number)=>store.miniGameTransaction(db=>db.prepare('UPDATE community_pet SET hunger=?,happiness=?,energy=? WHERE id=1').run(hunger,happiness,energy));
    set(20,90,90);assert.equal(arcade.pet(1000).mood,'hungry');
    set(50,50,20);assert.equal(arcade.pet(1000).mood,'tired');
    set(50,85,50);assert.equal(arcade.pet(1000).mood,'playful');
    set(50,65,50);assert.equal(arcade.pet(1000).mood,'happy');
    set(50,40,50);assert.equal(arcade.pet(1000).mood,'calm');
    store.miniGameTransaction(db=>db.prepare("INSERT INTO community_pet_events(id,kind,message,rare,created_at) VALUES('rare-mood','rare','Ein seltenes Glitzern!',1,?)").run(1000));
    assert.equal(arcade.pet(1001).mood,'cheeky');assert.equal(arcade.pet(16*60_000).mood,'calm');
  }finally{store.close();}
});

test('Persönlichkeitsmigration erhält Elis Zustand und bestehende Katzenaktionen',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'elio-migration-')),file=path.join(directory,'db','state.sqlite');let store=new FeatureStore(file);
  store.miniGameTransaction(db=>{db.prepare("UPDATE community_pet SET name='Elio',level=17,xp=1650,hunger=42,happiness=88,energy=61 WHERE id=1").run();db.prepare("INSERT INTO community_pet_interactions(event_id,user_id,kind,created_at,source) VALUES('old-pet-action','viewer','feed',1234,'portal')").run();db.exec('DROP TABLE community_pet_events;DELETE FROM schema_migrations WHERE version>=28')});store.close();
  try{
    store=new FeatureStore(file);const pet=new CommunityArcade(store,'broadcaster').pet(2000);assert.deepEqual([pet.name,pet.level,pet.xp,pet.hunger,pet.happiness,pet.energy],['Elio',17,1650,42,88,61]);
    assert.equal(store.miniGameQuery(db=>(db.prepare("SELECT COUNT(*) n FROM community_pet_interactions WHERE event_id='old-pet-action'").get() as {n:number}).n),1);
    assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM community_pet_events').get() as {n:number}).n),0);
    assert.ok(fs.readdirSync(path.join(directory,'backups')).some(name=>name.includes('migration-v28-')),'v28-Migration erstellt ein Vorab-Backup');
  }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('Elio-Outfits werden aus dem bestehenden Community-Level freigeschaltet und Auswahl bleibt zentral gespeichert',()=>{
  const {store,arcade}=setup();
  try{
    const before=arcade.pet();assert.equal(before.level,1);assert.equal(before.outfit.id,'classic');
    assert.equal(before.unlockedOutfits.find(x=>x.id==='gaming')?.unlocked,false);
    assert.throws(()=>arcade.setPetOutfit('gaming'),/ab Elio-Level 2/u);
    store.miniGameTransaction(db=>db.prepare("UPDATE community_pet SET level=2,xp=100 WHERE id=1").run());
    assert.deepEqual(arcade.setPetOutfit('gaming'),{id:'gaming',label:'Gaming-Elio',emoji:'🎮🐱'});
    assert.equal(arcade.pet().outfit.id,'gaming');
    assert.throws(()=>arcade.setPetOutfit('made-up'),/gibt es nicht/u);
  }finally{store.close();}
});

test('Elio-Meilensteinbonus bleibt standardmäßig aus und vergibt bei Aktivierung begrenzte idempotente XP',()=>{
  const {store,arcade}=setup();
  try{
    arcade.updateSettings({...arcade.settings(),petEnabled:true});
    store.miniGameTransaction(db=>db.prepare('UPDATE community_pet SET level=4,xp=399 WHERE id=1').run());
    const first=arcade.interactFromPortal(message('viewer','milestone-off','!play'), 'play', 1000);
    assert.equal(first.bonusXp,undefined);assert.equal(store.xp('viewer').xp,0);
    store.miniGameTransaction(db=>db.prepare('UPDATE community_pet SET level=4,xp=399 WHERE id=1').run());
    arcade.updateSettings({...arcade.settings(),petMilestoneBonusEnabled:true,petMilestoneBonusXp:7});
    const second=arcade.interactFromPortal(message('viewer-2','milestone-on','!play'),'play',200_000);
    assert.equal(second.bonusXp,7);assert.equal(store.xp('viewer-2').xp,7);assert.match(second.message,/\+7 Community-XP/u);
    const duplicate=arcade.interactFromPortal(message('viewer-2','milestone-on','!play'),'play',400_000);
    assert.equal(duplicate.ok,false);assert.equal(store.xp('viewer-2').xp,7);
    assert.throws(()=>arcade.updateSettings({...arcade.settings(),petMilestoneBonusXp:11}),/zwischen 1 und 10/u);
  }finally{store.close();}
});

test('Elio-Ereignisse laufen über den vorhandenen Tick, sind selten, privat und über Neustarts sichtbar',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'elio-personality-')),file=path.join(directory,'state.sqlite');let store=new FeatureStore(file),arcade=new CommunityArcade(store,'broadcaster',()=>0);
  try{
    arcade.updateSettings({...arcade.settings(),petEnabled:true,petPersonalityEnabled:true},10_000);
    arcade.tickMessages(10_000);const due=store.config<number>('pet_personality_next_event_at',0);assert.ok(due>10_000);
    assert.equal(arcade.petActivity(10_000).length,0);assert.equal(arcade.tickMessages(due-1).length,0);
    assert.equal(arcade.tickMessages(due).some(item=>item.category==='pet'),false,'Ein Portalereignis erzeugt keine Chatmeldung.');
    let snapshot=arcade.snapshot('pet',due) as {events:Array<{rare:boolean;message:string}>;obsHint:{message:string}|null;pet:PetState};
    assert.equal(snapshot.events.length,1);assert.equal(snapshot.events[0]?.rare,true);assert.match(snapshot.events[0]?.message||'',/Elio/u);assert.equal(snapshot.obsHint?.message,snapshot.events[0]?.message);assert.equal(snapshot.pet.mood,'cheeky');
    const before=store.xp('viewer').xp;store.close();
    store=new FeatureStore(file);arcade=new CommunityArcade(store,'broadcaster',()=>0);snapshot=arcade.snapshot('pet',due+5) as typeof snapshot;
    assert.equal(snapshot.events.length,1);assert.equal(snapshot.obsHint?.message,snapshot.events[0]?.message);assert.equal(store.xp('viewer').xp,before);
    assert.equal(arcade.tickMessages(due+25_000).some(item=>item.category==='pet'),false);
    arcade.updateSettings({...arcade.settings(),petPersonalityEnabled:false},due+30_000);assert.equal(arcade.snapshot('pet',due+30_001).obsHint,null);
  }finally{try{store.close()}catch{}fs.rmSync(directory,{recursive:true,force:true});}
});

test('Portalaktionen speichern eine kurze Reaktion ohne Nutzername in der Aktivitätshistorie',()=>{
  const {store,arcade}=setup(()=>0);arcade.updateSettings({...arcade.settings(),petEnabled:true,petPersonalityEnabled:true},1000);
  try{
    const action=arcade.interactFromPortal(message('private-viewer','private-event','!feed'),'feed',2000);assert.equal(action.ok,true);assert.match(action.reaction||'',/Elio/u);
    const events=arcade.petActivity(2001);assert.equal(events.length,1);assert.equal(events[0]?.message,action.reaction);assert.equal('userId' in (events[0]||{}),false);
    assert.equal(arcade.tickMessages(2002).some(item=>item.category==='pet'),false,'Portalaktionen bleiben still im Chat.');
  }finally{store.close();}
});

test('Elio-Befehle, Katzen-Lebensphasen, Bonus und OBS zeigen keine Drachen-UI',()=>{
  const {store,arcade}=setup(()=>0);arcade.updateSettings({...arcade.settings(),petEnabled:true,wheelEnabled:true});
  assert.match(arcade.handle(message('u1','play','!play'),'play',[],1000)||'',/Spielangel oder mit dem Wollknäuel/u);
  assert.match(arcade.handle(message('u2','care','!petcare'),'petcare',[],1000)||'',/kümmert sich um Elio/u);
  assert.match(arcade.handle(message('u3','stats','!petstats'),'petstats',[],1000)||'',/Kätzchen.*Level 1/u);
  const snap=arcade.snapshot('pet') as {pet:{stageLabel:string}};assert.equal(snap.pet.stageLabel,'Kätzchen');
  const widget=communityWidgetHtml('pet','nonce',34,'graphite');assert.match(widget,/🐱/u);assert.match(widget,/stageLabel\|\|d\.stage/u);assert.doesNotMatch(widget,/🐉|Drachenei|Baby-Drache|Jungdrache|Erwachsener Drache/u);
  const challenge=arcade.manageChallenges().find(x=>x.id==='builtin:pet-energy');assert.equal(challenge?.title,'Elio bekommt einen Energieschub!');
  store.close();
});

test('Versionierte Elio-Migration ersetzt nur den alten Standardnamen und erhält Namen, Level und XP',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'elio-pet-migration-'));const sub=path.join(directory,'data');fs.mkdirSync(sub);
  const legacyPath=path.join(sub,'legacy.sqlite');let store=new FeatureStore(legacyPath);new CommunityArcade(store,'broadcaster');
  store.setConfig('8ball_answers', LEGACY_DEFAULT_8BALL_ANSWERS);
  store.miniGameTransaction(db=>{db.prepare("UPDATE community_pet SET name='Fünkchen',level=2,xp=125 WHERE id=1").run();db.prepare("UPDATE chaos_wheel_challenges SET id='legacy-generated-id',title='Der Drache bekommt einen Energieschub!',action_type='boost_pet' WHERE id='builtin:pet-energy'").run();db.prepare("INSERT INTO community_pet_interactions(event_id,user_id,kind,created_at,source) VALUES('viewer:legacy','viewer','feed',100,'chat')").run();db.prepare('DELETE FROM schema_migrations WHERE version>=13').run()});store.close();
  store=new FeatureStore(legacyPath);assert.equal(new CommunityArcade(store,'broadcaster').pet().name,'Elio');assert.equal(new CommunityArcade(store,'broadcaster').pet().level,2);assert.equal(new CommunityArcade(store,'broadcaster').pet().xp,125);
  assert.deepEqual(store.config('8ball_answers', []), DEFAULT_8BALL_ANSWERS, 'alter Standardpool wird beim Upgrade ersetzt');
  assert.equal(store.miniGameQuery(db=>(db.prepare("SELECT source FROM community_pet_interactions WHERE event_id='viewer:legacy'").get() as {source:string}).source),'portal','alte Portalaktionen werden auch beim Upgrade privat gehalten');
  assert.equal(new CommunityArcade(store,'broadcaster').manageChallenges().find(x=>x.id==='legacy-generated-id')?.title,'Elio bekommt einen Energieschub!');store.close();
  const customPath=path.join(sub,'custom.sqlite');store=new FeatureStore(customPath);store.miniGameTransaction(db=>{db.prepare("UPDATE community_pet SET name='Miez',level=17,xp=1650 WHERE id=1").run();db.prepare('DELETE FROM schema_migrations WHERE version>=14').run()});store.close();
  store=new FeatureStore(customPath);const preserved=new CommunityArcade(store,'broadcaster').pet();assert.equal(preserved.name,'Miez');assert.equal(preserved.level,17);assert.equal(preserved.xp,1650);store.close();fs.rmSync(directory,{recursive:true,force:true});
});

test('Community-Aktionen werden nur aus gespeicherten, deduplizierten Interaktionen gebündelt und nach Neustart nicht wiederholt',()=>{
  const {store,arcade}=setup();arcade.updateSettings({...arcade.settings(),petEnabled:true});
  for(const user of ['u1','u2','u3'])assert.match(arcade.handle(message(user,`pet-${user}`,'!feed'),'feed',[],10_000)||'',/Katzenfutter/u);
  const notice=arcade.tick(10_001).find(text=>text.includes('Elio schnurrt'));
  assert.match(notice||'',/3 aus dem Chat.*3 Aktionen/u);
  assert.equal(arcade.tick(10_002).some(text=>text.includes('Elio schnurrt')),false);
  const afterRestart=new CommunityArcade(store,'broadcaster');
  assert.equal(afterRestart.tick(10_003).some(text=>text.includes('Elio schnurrt')),false);
  const rows=store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM community_pet_interactions WHERE announced_at IS NOT NULL').get() as {n:number}).n);
  assert.equal(rows,3);
  store.close();
});

test('Elio portal interactions stay private and never enter the public chat batch',()=>{
  const {store,arcade}=setup();arcade.updateSettings({...arcade.settings(),petEnabled:true});
  for(const user of ['portal-1','portal-2','portal-3']){
    const result=arcade.interactFromPortal(message(user,`portal-${user}`,'!feed'),'feed',10_000);
    assert.equal(result.ok,true);
  }
  assert.equal(arcade.tickMessages(10_001).some(item=>item.category==='pet'),false);
  const portalRows=store.miniGameQuery(db=>(db.prepare("SELECT COUNT(*) n FROM community_pet_interactions WHERE source='portal'").get() as {n:number}).n);
  assert.equal(portalRows,3);
  for(const user of ['chat-1','chat-2','chat-3'])arcade.handle(message(user,`chat-${user}`,'!feed'),'feed',[],11_000);
  assert.match(arcade.tick(11_001).find(text=>text.includes('Elio schnurrt'))||'',/3 aus dem Chat.*3 Aktionen/u);
  store.close();
});

test('Mystery-Drop nimmt pro Twitch-ID einen Claim an und vergibt XP genau einmal',()=>{
  const {store,arcade}=setup();arcade.updateSettings({...arcade.settings(),dropsEnabled:true,dropDurationMs:10_000});
  assert.match(arcade.startDropAdmin('broadcaster','rare',1000),/Ein Mystery Drop startet/u);
  assert.match(arcade.startDropAdmin('broadcaster','rare',1000),/läuft bereits/u);
  assert.match(arcade.handle(message('viewer','c1','!claim'),'claim',[],2000)||'',/dabei/u);
  const status=arcade.handle(message('viewer','status','!drop'),'drop',[],2500)||'';
  assert.match(status,/Mystery Drop läuft noch/u);
  assert.doesNotMatch(status,/common|rare|epic|legendary|community/iu);
  assert.match(arcade.handle(message('viewer','c2','!claim'),'claim',[],3000)||'',/bereits/u);
  assert.match(arcade.tick(11_001)[0]||'',/1 Person erhält je 10 XP/u);
  assert.equal(store.xp('viewer').xp,10);
  arcade.tick(11_002);assert.equal(store.xp('viewer').xp,10);
  store.close();
});

test('Mystery-Drop setzt eine unterbrochene XP-Auswertung nach Neustart idempotent fort',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'drop-recovery-')),database=path.join(directory,'state.sqlite');
  let store=new FeatureStore(database),arcade=new CommunityArcade(store,'broadcaster');
  arcade.updateSettings({...arcade.settings(),dropsEnabled:true,dropDurationMs:10_000});
  arcade.startDropAdmin('broadcaster','rare',1_000);
  arcade.handle(message('viewer','claim','!claim'),'claim',[],2_000);
  store.miniGameTransaction(db=>db.prepare("UPDATE mystery_drops SET status='resolving',result_json=? WHERE status='claiming'").run(JSON.stringify({participants:1,rewardXp:10})));
  assert.equal(store.xp('viewer').xp,0);
  store.close();
  store=new FeatureStore(database);arcade=new CommunityArcade(store,'broadcaster');
  assert.match(arcade.tick(11_001)[0]||'',/1 Person erhält je 10 XP/u);
  assert.equal(store.xp('viewer').xp,10);
  assert.equal(store.miniGameQuery(db=>(db.prepare("SELECT status FROM mystery_drops").get() as {status:string}).status),'completed');
  assert.equal(arcade.tick(11_002).length,0);
  assert.equal(store.xp('viewer').xp,10,'Wiederholung darf weder XP noch Abschlussnachricht doppeln');
  store.close();fs.rmSync(directory,{recursive:true,force:true});
});

test('Mystery-Drop-Texte sind einheitlich deutsch, Null-Teilnahme verspricht keine XP und Widget-Stufen sind übersetzt',()=>{
  const stages=['common','rare','epic','legendary','community'];
  const labels=['Gewöhnlicher Drop','Seltener Drop','Epischer Drop','Legendärer Drop','Community-Drop'];
  for(let i=0;i<stages.length;i++){
    const {store,arcade}=setup();arcade.updateSettings({...arcade.settings(),dropsEnabled:true,dropDurationMs:10_000});
    const announcement=arcade.startDropAdmin('broadcaster',stages[i],1_000);
    assert.equal(announcement,'🎁 Ein Mystery Drop startet! Schreibt innerhalb von 10 Sekunden !claim, um mitzumachen!');
    assert.doesNotMatch(announcement,/common|rare|epic|legendary|community/iu);
    const widget=arcade.snapshot('drop',2_000) as {drop:{rarityLabel:string}};
    assert.equal(widget.drop.rarityLabel,labels[i]);
    const overlay=communityWidgetHtml('drop','nonce',34,'graphite');
    assert.match(overlay,/d\.rarityLabel/u);
    assert.match(overlay,/Diesmal war niemand dabei/u);
    assert.doesNotMatch(overlay,/d\.rarity\.toUpperCase/u);
    const result=arcade.tick(11_001)[0]||'';
    assert.match(result,/niemand mitgemacht/u);
    assert.doesNotMatch(result,/XP/u);
    store.close();
  }
});

test('Abgelaufene Teilnehmerdetails werden gemäß Aufbewahrungsfrist bereinigt',()=>{
  const {store,arcade}=setup();arcade.updateSettings({...arcade.settings(),dropsEnabled:true,dropDurationMs:5000,activityRetentionDays:90});
  const old=Date.now()-100*86_400_000;arcade.startDropAdmin('broadcaster','common',old);
  arcade.handle(message('viewer','old-claim','!claim'),'claim',[],old+1);
  arcade.tick(Date.now());
  const remaining=store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM mystery_claims').get() as {n:number}).n);
  assert.equal(remaining,0);store.close();
});

test('Chaos Wheel enthält nur automatisch ausführbare Segmente und führt das Ergebnis sofort aus',()=>{
  const {store,arcade}=setup(()=>0);arcade.updateSettings({...arcade.settings(),wheelEnabled:true,petEnabled:true,dropsEnabled:true,wheelCooldownMs:1_000});
  const status=arcade.wheelStatus(5_000) as {entries:Array<{actionType:string}>;canSpin:boolean};
  assert.equal(status.canSpin,true);assert.equal(status.entries.length,2);assert.ok(status.entries.every(x=>x.actionType!=='manual_challenge'));
  assert.throws(()=>arcade.configureChallenge('Manuell',1,true,'manual-test','manual_challenge'),/nicht mehr zulässig/u);
  const before=arcade.pet();assert.match(arcade.spinAdmin('broadcaster',5_000),/automatisch \+10 Energie/u);
  assert.equal(arcade.pet().energy,Math.min(100,before.energy+10));
  const snap=arcade.snapshot('wheel',5_001) as {visible:boolean;wheel:{status:string;endsAt:number|null;actionType:string}};
  assert.equal(snap.visible,true);assert.equal(snap.wheel.status,'completed');assert.equal(snap.wheel.endsAt,null);assert.equal(snap.wheel.actionType,'boost_pet');
  assert.equal(arcade.tick(400_000).length,0,'keine manuelle Challenge wartet auf eine Folgeaktion');
  store.close();
});

test('Wheel-Aktionszuordnung startet genau einen konfigurierten Mystery Drop, claims und XP laufen über den bestehenden Pfad',()=>{
  const {store,arcade}=setup(()=>0);arcade.updateSettings({...arcade.settings(),dropsEnabled:true,wheelEnabled:true,dropDurationMs:10_000,wheelCooldownMs:5_000});
  for(const challenge of arcade.manageChallenges())arcade.configureChallenge(challenge.title,challenge.weight,false,challenge.id,challenge.actionType);
  arcade.configureChallenge('Automatischer Drop A',1,true,'test-drop-a','start_mystery_drop');
  arcade.configureChallenge('Automatischer Drop B',1,true,'test-drop-b','start_mystery_drop');
  assert.equal(arcade.manageChallenges().find(x=>x.id==='test-drop-a')?.actionType,'start_mystery_drop');
  const result=arcade.spinAdmin('broadcaster',1_000);
  assert.match(result,/Ein Mystery Drop startet/u);assert.match(result,/10 Sekunden/u);assert.match(result,/!claim/u);
  assert.doesNotMatch(result,/common|rare|epic|legendary/iu);
  const drops=store.miniGameQuery(db=>db.prepare("SELECT id,starts_at,ends_at,source_spin_id FROM mystery_drops WHERE status='claiming'").all() as Array<{id:string;starts_at:number;ends_at:number;source_spin_id:string}>);
  assert.equal(drops.length,1);assert.equal(drops[0]?.starts_at,1_000);assert.equal(drops[0]?.ends_at,11_000);
  const spin=store.miniGameQuery(db=>db.prepare('SELECT id,action_type FROM chaos_wheel_spins').get() as {id:string;action_type:string});
  assert.equal(spin.action_type,'start_mystery_drop');assert.equal(drops[0]?.source_spin_id,spin.id);
  const widget=arcade.snapshot('drop',2_000) as {visible:boolean;drop:{participants:number;endsAt:number;rarityLabel:string}};
  assert.equal(widget.visible,true);assert.equal(widget.drop.participants,0);assert.equal(widget.drop.endsAt,11_000);assert.equal(widget.drop.rarityLabel,'Gewöhnlicher Drop');
  assert.match(arcade.handle(message('viewer-1','drop-claim-1','!claim'),'claim',[],2_000)||'',/dabei/u);
  assert.match(arcade.handle(message('viewer-2','drop-claim-2','!claim'),'claim',[],2_001)||'',/dabei/u);
  assert.match(arcade.spinAdmin('broadcaster',2_002),/Mystery Drop läuft bereits/u,'a repeated wheel action is blocked while its drop is active');
  assert.equal(store.miniGameQuery(db=>db.prepare("SELECT COUNT(*) n FROM mystery_drops WHERE status IN ('claiming','announced')").get() as {n:number}).n,1);
  assert.match(arcade.tick(11_001)[0]||'',/2 Personen erhalten je 5 XP/u);
  assert.equal(store.xp('viewer-1').xp,5);assert.equal(store.xp('viewer-2').xp,5);
  arcade.tick(11_002);assert.equal(store.xp('viewer-1').xp,5);assert.equal(store.xp('viewer-2').xp,5);
  store.close();
});

test('Auto-Pilot startet keine zweite Aktion während ein Drop aktiv ist',()=>{
  const {store,arcade}=setup(()=>1);arcade.updateSettings({...arcade.settings(),dropsEnabled:true,wheelEnabled:true,wheelCooldownMs:1_000});
  for(const challenge of arcade.manageChallenges())arcade.configureChallenge(challenge.title,challenge.weight,false,challenge.id,challenge.actionType);
  arcade.configureChallenge('Automatischer Drop',1,true,'drop-1','start_mystery_drop');
  arcade.startDropAdmin('broadcaster','rare',1_000);
  assert.match(arcade.spinAdmin('broadcaster',2_000),/läuft bereits/u);
  assert.equal(store.miniGameQuery(db=>db.prepare("SELECT COUNT(*) n FROM mystery_drops WHERE status IN ('announced','claiming')").get() as {n:number}).n,1);
  store.close();
});

test('Alte manuelle Rad-Felder bleiben gespeichert, sind aber nicht auswählbar',()=>{
  const {store,arcade}=setup(()=>0);arcade.updateSettings({...arcade.settings(),dropsEnabled:true,petEnabled:true,wheelEnabled:true});
  assert.equal(arcade.manageChallenges().find(x=>x.id==='builtin:mystery-drop')?.actionType,'start_mystery_drop');
  store.miniGameQuery(db=>db.prepare("INSERT INTO chaos_wheel_challenges(id,title,weight,active,action_type) VALUES('legacy-manual','Eine Runde ohne Springen',1,1,'manual_challenge')").run());
  assert.equal(arcade.activeChallenges().some(x=>x.id==='legacy-manual'),false);
  assert.equal(arcade.manageChallenges().some(x=>x.id==='legacy-manual'),true,'Altbestand bleibt erhalten');
  assert.match(arcade.spinAdmin('broadcaster',1_000),/Energie/u);
  assert.equal(store.miniGameQuery(db=>db.prepare('SELECT COUNT(*) n FROM mystery_drops').get() as {n:number}).n,0);
  assert.equal((store.miniGameQuery(db=>db.prepare("SELECT status FROM chaos_wheel_spins ORDER BY created_at DESC LIMIT 1").get() as {status:string})).status,'completed');
  store.close();
});

test('Migration deaktiviert alte manuelle Felder und schließt laufende manuelle Spins ohne Daten zu löschen',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wheel-manual-migration-')),database=path.join(directory,'state','bot.sqlite');fs.mkdirSync(path.dirname(database));
  let store=new FeatureStore(database);
  store.miniGameQuery(db=>{
    db.prepare("INSERT INTO chaos_wheel_challenges(id,title,weight,active,action_type) VALUES('old-manual','Fünf Minuten nur Pistolen',2,1,'manual_challenge')").run();
    db.prepare("INSERT INTO chaos_wheel_spins(id,challenge_id,title,status,created_by,created_at,action_type) VALUES('old-spin','old-manual','Fünf Minuten nur Pistolen','active','mod',10,'manual_challenge')").run();
    db.prepare('DELETE FROM schema_migrations WHERE version>=17').run();
  });store.close();
  store=new FeatureStore(database);
  assert.equal(store.miniGameQuery(db=>db.prepare("SELECT active FROM chaos_wheel_challenges WHERE id='old-manual'").get() as {active:number}).active,0);
  assert.equal(store.miniGameQuery(db=>db.prepare("SELECT status FROM chaos_wheel_spins WHERE id='old-spin'").get() as {status:string}).status,'canceled');
  assert.equal(store.miniGameQuery(db=>db.prepare("SELECT COUNT(*) n FROM chaos_wheel_spins WHERE id='old-spin'").get() as {n:number}).n,1);
  store.close();fs.rmSync(directory,{recursive:true,force:true});
});

test('nicht verfügbare Aktionen werden ausgeschlossen, Pet-Bonus löst genau einmal aus und Not-Stopp beendet die Challenge',()=>{
  let selection=1;const {store,arcade}=setup(()=>selection);arcade.updateSettings({...arcade.settings(),wheelEnabled:true,petEnabled:false,dropsEnabled:false});
  for(const x of arcade.manageChallenges())arcade.configureChallenge(x.title,x.weight,false,x.id,x.actionType);
  arcade.configureChallenge('Nur Challenge',1,false,'manual-only','manual_challenge');
  arcade.configureChallenge('Pet Bonus A',1,true,'pet-action-a','boost_pet');
  arcade.configureChallenge('Pet Bonus B',1,true,'pet-action-b','boost_pet');
  const unavailable=arcade.wheelStatus(10_000) as {entries:Array<{id:string}>;unavailable:Array<{reason:string}>;canSpin:boolean};
  assert.equal(unavailable.canSpin,false);assert.deepEqual(unavailable.entries,[]);assert.ok(unavailable.unavailable.length>=2);
  arcade.updateSettings({...arcade.settings(),petEnabled:true});
  const before=arcade.pet();assert.match(arcade.spinAdmin('broadcaster',10_000),/automatisch \+10 Energie/u);
  assert.equal(arcade.pet().energy,Math.min(100,before.energy+10));
  assert.equal(arcade.spinAdmin('broadcaster',10_001).includes('Bonus'),false,'cooldown prevents reapplying the same action');
  assert.match(arcade.emergencyStop(11_002),/Auto-Pilot gestoppt/u);
  assert.equal((arcade.wheelStatus(11_003) as {autoPilotEnabled:boolean;activeAction:unknown}).autoPilotEnabled,false);
  assert.equal(store.miniGameQuery(db=>db.prepare("SELECT COUNT(*) n FROM chaos_wheel_spins WHERE action_type='manual_challenge'").get() as {n:number}).n,0);
  store.close();
});

test('laufende Community-Spielrunde blockiert den Wheel-Autopiloten ohne Zustand zu verändern',()=>{
  const {store,arcade}=setup(()=>0);arcade.updateSettings({...arcade.settings(),wheelEnabled:true});
  store.miniGameTransaction(db=>db.prepare("INSERT INTO imposter_rounds(id,phase,started_at,phase_ends_at,updated_at) VALUES('live-round','playing',100,5000,100)").run());
  assert.match(arcade.spinAdmin('broadcaster',1_000),/Community-Spiel läuft bereits/u);
  assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM chaos_wheel_spins').get() as {n:number}).n),0);
  const status=arcade.wheelStatus(1_000) as {canSpin:boolean;reason:string};assert.equal(status.canSpin,false);assert.match(status.reason,/Community-Spiel/u);
  store.close();
});

test('Auto-Dreh läuft frühestens alle 30 Minuten und Neustart erzeugt keine doppelte Aktion',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wheel-autopilot-')),database=path.join(directory,'bot.sqlite');
  let store=new FeatureStore(database),arcade=new CommunityArcade(store,'broadcaster',()=>0);
  arcade.updateSettings({...arcade.settings(),wheelEnabled:true,petEnabled:true,dropsEnabled:true,wheelCooldownMs:1_000});
  assert.match(arcade.autoSpinIfDue(10_000)||'',/Ergebnis:/u);
  assert.equal(store.miniGameQuery(db=>db.prepare('SELECT COUNT(*) n FROM chaos_wheel_spins').get() as {n:number}).n,1);
  store.close();
  store=new FeatureStore(database);arcade=new CommunityArcade(store,'broadcaster',()=>0);
  const status=arcade.wheelStatus(11_000) as {nextAutoSpinAt:number;autoSpinDue:boolean};
  assert.equal(status.nextAutoSpinAt,10_000+30*60_000);assert.equal(status.autoSpinDue,false);
  assert.equal(arcade.autoSpinIfDue(status.nextAutoSpinAt-1),undefined);
  assert.match(arcade.autoSpinIfDue(status.nextAutoSpinAt)||'',/Ergebnis:/u);
  assert.equal(store.miniGameQuery(db=>db.prepare('SELECT COUNT(*) n FROM chaos_wheel_spins').get() as {n:number}).n,2);
  store.close();fs.rmSync(directory,{recursive:true,force:true});
});

test('Features sind standardmäßig aus und Pet/Admin-Befehle sind autorisiert',()=>{
  const {store,arcade}=setup();
  assert.equal(arcade.settings().petEnabled,false);
  assert.match(arcade.startDropAdmin('broadcaster','common',999),/deaktiviert/u);
  assert.match(arcade.spinAdmin('broadcaster',999),/deaktiviert/u);
  assert.match(arcade.handle(message('viewer','n1','!pet'),'pet',[],1000)||'',/deaktiviert|pausiert/u);
  arcade.updateSettings({...arcade.settings(),petEnabled:true});
  assert.match(arcade.handle(message('viewer','n2','!setpetname Evil'),'setpetname',['Evil'],1000)||'',/Nur Jannik/u);
  assert.match(arcade.handle(message('broadcaster','n3','!setpetname Glut'),'setpetname',['Glut'],1001)||'',/heißt jetzt Glut/u);
  store.close();
});

test('Rad-Migration hält Quiz-Historie, deaktiviert Quiz und trennt Aufgaben vom Auto-Pilot',()=>{
  const {store,arcade}=setup();const fields=arcade.manageChallenges();
  const quiz=fields.find(x=>x.wheelKey==='gaming_quiz');assert.ok(quiz);assert.equal(quiz.active,false);
  assert.ok(fields.some(x=>x.wheelKey==='no_jumping'&&x.active&&x.kind==='streamer-task'));
  assert.ok(fields.some(x=>x.wheelKey==='pistols_timer'&&x.active));assert.ok(fields.some(x=>x.wheelKey==='quest_vote'&&x.active));
  arcade.updateSettings({...arcade.settings(),wheelEnabled:true});
  const status=arcade.wheelStatus(1000) as {entries:Array<{actionType:string}>;taskEntries:Array<{wheelKey:string}>};
  assert.ok(status.entries.every(x=>x.actionType!=='manual_challenge'));assert.ok(status.taskEntries.every(x=>x.wheelKey!=='gaming_quiz'));
  assert.equal(store.miniGameQuery(db=>(db.prepare("SELECT COUNT(*) n FROM chaos_wheel_challenges WHERE wheel_key='gaming_quiz'").get() as {n:number}).n),1);
  store.close();
});

test('Quest-Raddreh startet Chatabstimmung und beginnt eindeutige Gewinnerquest nur einmal',()=>{
  const {store,arcade}=setup(()=>0);arcade.updateSettings({...arcade.settings(),wheelEnabled:true});
  const policy={maxLength:180,queueLimit:20,maxOpenPerUser:2,cooldownMs:60_000,activeDurationMs:0,completionXp:25},ids:string[]=[];
  for(const title of ['Quest Alpha','Quest Beta']){const saved=store.submitQuest({submitterUserId:title,displayName:title,title,source:'dashboard'},policy,1000);assert.equal(saved.ok,true);if(saved.ok){ids.push(saved.quest.id);assert.equal(store.transitionQuest(saved.quest.id,'approved','broadcaster',1001,policy).ok,true)}}
  const started=arcade.spinAdmin('broadcaster',2000);assert.match(started,/!vote 1 bis !vote 2/u);assert.match(started,/automatisch/u);
  const spin=store.miniGameQuery(db=>db.prepare("SELECT id,task_ref,status FROM chaos_wheel_spins WHERE wheel_key='quest_vote'").get() as {id:string;task_ref:string;status:string});
  assert.equal(spin.status,'active');const poll=store.poll(spin.task_ref);assert.equal(poll?.type,'quest');assert.equal(poll?.options.length,2);
  assert.equal(store.vote(poll!.id,'v1','V1',1,'evt-1',3000).ok,true);assert.equal(store.vote(poll!.id,'v2','V2',1,'evt-2',3001).ok,true);
  assert.match(communityWidgetHtml('poll','nonce',34,'graphite'),/!vote 1/);
  assert.match(arcade.tick(poll!.endsAt+1).join(' '),/Quest Alpha.*läuft jetzt/u);assert.equal(store.activeQuest()?.id,ids[0]);
  assert.equal(store.miniGameQuery(db=>db.prepare("SELECT status FROM chaos_wheel_spins WHERE id=?").get(spin.id) as {status:string}).status,'completed');
  assert.equal(arcade.tick(poll!.endsAt+2).length,0);store.close();
});

test('Pistolen-Countdown wird nach Neustart fortgesetzt und endet ohne Erfolgsbehauptung',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wheel-pistol-timer-')),database=path.join(directory,'state.sqlite');
  let store=new FeatureStore(database),arcade=new CommunityArcade(store,'broadcaster',max=>max-1);arcade.updateSettings({...arcade.settings(),wheelEnabled:true});
  assert.match(arcade.spinAdmin('broadcaster',10_000),/fünf Minuten nur Pistolen/iu);store.close();
  store=new FeatureStore(database);arcade=new CommunityArcade(store,'broadcaster');
  const active=arcade.wheelStatus(11_000) as {activeAction:{title:string;endsAt:number}};assert.equal(active.activeAction.title,'Fünf Minuten nur Pistolen');assert.equal(active.activeAction.endsAt,310_000);
  assert.equal(arcade.tick(309_999).length,0);const ended=arcade.tick(310_000).join(' ');assert.match(ended,/abgelaufen/u);assert.match(ended,/bestätigt nicht/u);assert.equal(arcade.tick(310_001).length,0);
  store.close();fs.rmSync(directory,{recursive:true,force:true});
});

test('Ohne-Springen-Aufgabe erscheint in Chat und OBS ohne Erfolgsversprechen',()=>{
  const {store,arcade}=setup(()=>0);arcade.updateSettings({...arcade.settings(),wheelEnabled:true});
  const result=arcade.spinAdmin('broadcaster',5000);assert.match(result,/Eine Runde ohne Springen/u);assert.match(result,/nicht prüfen/u);
  const view=arcade.snapshot('wheel',5001) as {visible:boolean;wheel:{title:string;status:string}};assert.equal(view.visible,true);assert.equal(view.wheel.title,'Eine Runde ohne Springen');assert.equal(view.wheel.status,'active');assert.match(arcade.finishCurrentTask(5002),/nicht bewertet/u);assert.equal((arcade.snapshot('wheel',5003) as {wheel:{status:string}}).wheel.status,'canceled');
  assert.doesNotMatch(result,/geschafft|erfolgreich/u);store.close();
});

test('recent chat activity deduplicates a viewer, excludes broadcaster and known bot, and expires at the configured window',()=>{
  const {store,arcade}=setup(()=>0);arcade.updateSettings({...arcade.settings(),wheelEnabled:true,viewerRewardsEnabled:true,viewerActivityWindowMinutes:15});
  const vault=new CommunityVault(store,'bot-id');
  const activity=(user:string,login:string,body:string,at:number)=>({...message(user,`activity-${user}-${at}`,body),senderLogin:login,senderDisplayName:login});
  vault.observeActivity(activity('v1','viewerone','Hello chat',1_000),1_000);
  vault.observeActivity(activity('v1','viewerone','Another message',2_000),2_000);
  vault.observeActivity(activity('broadcaster','jannik','Hello everyone',2_500),2_500);
  vault.observeActivity(activity('nightbot-id','nightbot','A timer message',2_600),2_600);
  vault.observeActivity(activity('bot-id','acycommunitybot','Hello',2_700),2_700);
  vault.observeActivity(activity('v2','viewertwo','Good evening',3_000),3_000);
  const status=arcade.wheelStatus(3_000) as {activeViewerCount:number;eligibleWinnerCount:number};
  assert.deepEqual([status.activeViewerCount,status.eligibleWinnerCount],[2,2]);
  assert.equal(store.recentChatActivity(3_000,15,['broadcaster']).length,2,'a chatter gets one ticket regardless of message count');
  assert.equal(store.recentChatActivity(903_001,15,['broadcaster']).length,0,'activity older than 15 minutes is ineligible');
  store.close();
});

test('wheel viewer XP is selected from one ticket per active user and written idempotently with the winning result',()=>{
  const {store,arcade}=setup(()=>0);arcade.updateSettings({...arcade.settings(),wheelEnabled:true,viewerRewardsEnabled:true,wheelWinnerXp:25,wheelMaxRewardsPerStream:1});
  arcade.setCurrentStreamId('test-live-stream');
  store.recordRecentChatActivity('real-viewer','PurrfectViewer','purrfectviewer',1_000);
  arcade.configureWheelField('wheel:viewer-xp',true,1);
  arcade.configureWheelField('wheel:honor',true,1000);
  const status=arcade.wheelStatus(2_000) as {activeViewerCount:number;eligibleWinnerCount:number;entries:Array<{wheelKey:string}>};
  assert.equal(status.activeViewerCount,1);assert.equal(status.eligibleWinnerCount,1);assert.ok(status.entries.some(x=>x.wheelKey==='viewer_xp'));
  const result=arcade.spinAdmin('broadcaster',2_000);
  assert.match(result,/@PurrfectViewer gewinnt 25 XP/u);
  assert.equal(store.xp('real-viewer').xp,25);
  assert.equal(store.miniGameQuery(db=>(db.prepare("SELECT COUNT(*) n FROM xp_ledger WHERE event_id LIKE 'wheel:%:winner-xp'").get() as {n:number}).n),1);
  const winner=arcade.wheelStatus(2_001) as {lastWinner:{winnerName:string;resultLabel:string}};
  assert.equal(winner.lastWinner.winnerName,'PurrfectViewer');assert.match(winner.lastWinner.resultLabel,/25 XP/u);
  const capped=arcade.wheelStatus(2_001) as {prizeSlotsRemaining:number;entries:Array<{wheelKey:string}>};assert.equal(capped.prizeSlotsRemaining,0);assert.ok(!capped.entries.some(x=>x.wheelKey==='viewer_xp'));
  assert.match(arcade.spinAdmin('broadcaster',2_001),/kurze Pause/u);
  assert.equal(store.xp('real-viewer').xp,25);
  store.close();
});

test('Viewer reward segments stay out when no verified stream or eligible participant exists',()=>{
  const {store,arcade}=setup(()=>0);arcade.updateSettings({...arcade.settings(),wheelEnabled:true,viewerRewardsEnabled:true});arcade.configureWheelField('wheel:viewer-xp',true,10);arcade.configureWheelField('wheel:honor',true,10);
  const offline=arcade.wheelStatus(10_000) as {activeViewerCount:number;entries:Array<{wheelKey:string}>;unavailable:Array<{wheelKey?:string;title:string;reason:string}>};
  assert.equal(offline.activeViewerCount,0);assert.ok(!offline.entries.some(x=>x.wheelKey==='viewer_xp'));assert.ok(offline.unavailable.some(x=>x.title.includes('Glückspilz')&&x.reason.includes('Live-Stream')));
  arcade.setCurrentStreamId('stream-with-no-chat');const liveEmpty=arcade.wheelStatus(10_000) as {entries:Array<{wheelKey:string}>};assert.ok(!liveEmpty.entries.some(x=>x.wheelKey==='viewer_xp'));
  store.close();
});

test('personal mystery wheel prize uses the existing drop and XP records and does not create a public claim round',()=>{
  const {store,arcade}=setup(()=>0);arcade.updateSettings({...arcade.settings(),wheelEnabled:true,viewerRewardsEnabled:true,dropsEnabled:true,wheelPersonalMysteryDrop:true});
  arcade.setCurrentStreamId('test-live-stream');
  store.recordRecentChatActivity('winner-id','LuckyCat','luckycat',1_000);
  arcade.configureWheelField('builtin:mystery-drop',false,1);
  arcade.configureWheelField('wheel:viewer-drop',true,1);arcade.configureWheelField('wheel:honor',true,1000);
  assert.match(arcade.spinAdmin('broadcaster',2_000),/persönlichen Mystery Drop mit 5 XP/u);
  assert.equal(store.xp('winner-id').xp,5);
  const drop=store.miniGameQuery(db=>db.prepare('SELECT status,source_spin_id FROM mystery_drops').get() as {status:string;source_spin_id:string});
  assert.equal(drop.status,'completed');assert.ok(drop.source_spin_id);
  assert.equal(store.miniGameQuery(db=>(db.prepare("SELECT COUNT(*) n FROM mystery_drops WHERE status IN ('announced','claiming','resolving')").get() as {n:number}).n),0);
  assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT reward_xp FROM mystery_claims').get() as {reward_xp:number}).reward_xp),5);
  store.close();
});

test('Community bonus, approved quest luck, cosmetic chaos title and extra spin stay bounded and truthful',()=>{
  {
    const {store,arcade}=setup(()=>1);arcade.updateSettings({...arcade.settings(),wheelEnabled:true,viewerRewardsEnabled:true,wheelCommunityBonusXp:10});
    arcade.setCurrentStreamId('test-live-stream');
    store.recordRecentChatActivity('viewer-a','ViewerA','viewera',1_000);store.recordRecentChatActivity('viewer-b','ViewerB','viewerb',1_000);
    arcade.configureWheelField('wheel:community-bonus',true,1000);arcade.configureWheelField('wheel:honor',true,1);
    assert.match(arcade.spinAdmin('broadcaster',2_000),/2 berechtigte aktive Personen erhalten je 10 XP/u);
    assert.equal(store.xp('viewer-a').xp,10);assert.equal(store.xp('viewer-b').xp,10);
    assert.equal(store.miniGameQuery(db=>(db.prepare("SELECT COUNT(*) n FROM xp_ledger WHERE reason='bonus:chaos-wheel'").get() as {n:number}).n),2);
    store.close();
  }
  {
    const {store,arcade}=setup(()=>1);arcade.updateSettings({...arcade.settings(),wheelEnabled:true,viewerRewardsEnabled:true});
    arcade.setCurrentStreamId('test-live-stream');
    const policy={maxLength:180,queueLimit:20,maxOpenPerUser:2,cooldownMs:60_000,activeDurationMs:0,completionXp:25};
    const submitted=store.submitQuest({submitterUserId:'viewer',displayName:'Viewer',title:'Spiele eine Runde ohne Springen',source:'chat'},policy,1000);
    assert.equal(submitted.ok,true);if(submitted.ok)assert.equal(store.transitionQuest(submitted.quest.id,'approved','mod',1001,policy).ok,true);
    arcade.configureWheelField('wheel:quest-luck',true,1000);arcade.configureWheelField('wheel:honor',true,1);
    assert.match(arcade.spinAdmin('broadcaster',2_000),/freigegebene Challenge.*wird für Jannik hervorgehoben/u);
    const spin=store.miniGameQuery(db=>db.prepare('SELECT winner_name,winner_user_id,reward_status,result_label FROM chaos_wheel_spins').get() as {winner_name:string|null;winner_user_id:string|null;reward_status:string;result_label:string});
    assert.equal(spin.winner_name,null);assert.equal(spin.winner_user_id,null);assert.equal(spin.reward_status,'none');assert.match(spin.result_label,/Spiele eine Runde/u);
    store.close();
  }
  {
    let calls=0;const {store,arcade}=setup(max=>calls++===0?1:0);arcade.updateSettings({...arcade.settings(),wheelEnabled:true,viewerRewardsEnabled:true});
    arcade.setCurrentStreamId('test-live-stream');
    store.recordRecentChatActivity('viewer','Viewer','viewer',1000);arcade.configureWheelField('wheel:chaos-title',true,1000);arcade.configureWheelField('wheel:honor',true,1);
    assert.match(arcade.spinAdmin('broadcaster',2_000),/@Viewer ist für 60 Sekunden der offizielle Chaos-Magnet des Streams/u);
    const spin=store.miniGameQuery(db=>db.prepare('SELECT winner_name,reward_status,result_label FROM chaos_wheel_spins').get() as {winner_name:string;reward_status:string;result_label:string});
    assert.equal(spin.winner_name,'Viewer');assert.equal(spin.reward_status,'cosmetic');assert.match(spin.result_label,/Chaos-Magnet/u);
    store.close();
  }
  {
    let calls=0;const {store,arcade}=setup(max=>calls++===0?1:0);arcade.updateSettings({...arcade.settings(),wheelEnabled:true,viewerRewardsEnabled:true});
    arcade.setCurrentStreamId('test-live-stream');
    store.recordRecentChatActivity('viewer','Viewer','viewer',1000);arcade.configureWheelField('wheel:extra-spin',true,1000);arcade.configureWheelField('wheel:honor',true,1);
    assert.match(arcade.spinAdmin('broadcaster',2_000),/Noch ein Dreh!.*Lieblingsmensch/u);
    assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM chaos_wheel_spins').get() as {n:number}).n),1,'a bonus draw is capped at one extra result and creates no spin loop');
    store.close();
  }
});
