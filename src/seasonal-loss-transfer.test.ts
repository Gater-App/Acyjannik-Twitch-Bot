import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHRISTMAS_2026_START_AT, FeatureStore } from './feature-store.js';
import { formatSeasonalLoss } from './seasonal-loss.js';
import { Database } from './database.js';
import { GameService } from './game.js';
import { CommunityFeatures } from './community-features.js';
import { CommandHandler } from './command-handler.js';
import { testConfig } from './test-config.js';
import type { ChatMessage } from './types.js';

const delivery=(eventId:string,excludedUserIds:string[]=[])=>({eventId,excludedUserIds,chooseRecipient:(count:number)=>count-1,format:(points:number,transfer?:Parameters<typeof formatSeasonalLoss>[1])=>transfer?formatSeasonalLoss(transfer.eventType,transfer):`Punkte: ${points}`});
function setup(eventId='halloween') {
  const store=new FeatureStore(':memory:');
  store.miniGameTransaction(db=>db.prepare('UPDATE seasonal_events SET active=0').run());
  store.setEventActive(eventId,true,eventId==='christmas'?CHRISTMAS_2026_START_AT:1_000);
  return store;
}
function putScore(store:FeatureStore,eventId:string,userId:string,name:string,points:number,now=1_000) {
  store.miniGameTransaction(db=>db.prepare(`INSERT INTO seasonal_scores(event_id,user_id,display_name,points,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(event_id,user_id) DO UPDATE SET points=excluded.points,display_name=excluded.display_name,updated_at=excluded.updated_at`).run(eventId,userId,name,points,now));
  if(eventId==='halloween')store.miniGameTransaction(db=>db.prepare(`INSERT INTO players(user_id,display_name,pumpkins,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET pumpkins=excluded.pumpkins,display_name=excluded.display_name,updated_at=excluded.updated_at`).run(userId,name,points,now));
}
function activity(store:FeatureStore,userId:string,name:string,login:string,now=10_000) { store.recordRecentChatActivity(userId,name,login,now); }

test('Halloween transfers only the available loss, preserves the loser floor and mirrors both pumpkin accounts atomically',()=>{
  const store=setup();try{
    putScore(store,'halloween','loser','Max',5);activity(store,'receiver','Lisa','lisa');
    const result=store.playEvent('halloween','loser','Max',-10,10_000,delivery('loss-normal'));
    assert.equal(result.ok,true);if(!result.ok)return;
    assert.equal(result.points,0);assert.equal(result.transfer?.amount,5);assert.equal(result.transfer?.recipientUserId,'receiver');
    assert.equal(store.score('halloween','loser'),0);assert.equal(store.score('halloween','receiver'),5);
    assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT pumpkins FROM players WHERE user_id=?').get('loser') as {pumpkins:number}).pumpkins),0);
    assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT pumpkins FROM players WHERE user_id=?').get('receiver') as {pumpkins:number}).pumpkins),5);
    const audit=store.miniGameQuery(db=>db.prepare('SELECT event_type,loser_user_id,recipient_user_id,amount,status FROM seasonal_loss_transfers WHERE event_id=?').get('loss-normal'));
    assert.deepEqual(audit,{event_type:'halloween',loser_user_id:'loser',recipient_user_id:'receiver',amount:5,status:'transferred'});
    const message=store.claimChatDeliveryMessages(10_001)[0]?.message||'';assert.match(message,/5 Kürbisse.*@Lisa/u);assert.doesNotMatch(message,/10 Kürbisse/u);
    assert.deepEqual(store.playEvent('halloween','loser','Max',-1,10_002,delivery('loss-cooldown')),{ok:false,reason:'cooldown',remainingMs:899_998});
  }finally{store.close();}
});

test('zero balance and missing eligible recipient leave the seasonal balance untouched and never claim a loss',()=>{
  const store=setup();try{
    putScore(store,'halloween','zero','Zero',0);putScore(store,'halloween','max','Max',7);
    const empty=store.playEvent('halloween','zero','Zero',-9,10_000,delivery('loss-zero'));
    const alone=store.playEvent('halloween','max','Max',-9,10_001,delivery('loss-alone'));
    assert.equal(empty.ok,true);assert.equal(alone.ok,true);if(!empty.ok||!alone.ok)return;
    assert.equal(empty.transfer?.status,'no_balance');assert.equal(empty.transfer?.amount,0);
    assert.equal(alone.transfer?.status,'no_recipient');assert.equal(alone.points,7);
    assert.equal(store.score('halloween','max'),7);
    const messages=store.claimChatDeliveryMessages(10_002).map(item=>item.message).join('\n');
    assert.match(messages,/keine Kürbisse/u);assert.match(messages,/bleiben unangetastet/u);assert.doesNotMatch(messages,/verliert 9/u);
  }finally{store.close();}
});

test('Empfänger muss aktuell, verschieden, gültig und kein Bot sein; ein Empfänger mit null Bestand ist zulässig',()=>{
  const store=setup();try{
    putScore(store,'halloween','loser','Max',12);
    activity(store,'loser','Max','max');activity(store,'fresh-zero','Lisa','lisa');
    activity(store,'stale','Old','oldviewer',-400_000);activity(store,'bot','Nightbot','nightbot');activity(store,'suffix-bot','OtherBot','helperbot');
    activity(store,'broadcaster','Jannik','acyjannik');activity(store,'invalid','Bad Login','not valid');
    const result=store.playEvent('halloween','loser','Max',-4,10_000,{...delivery('loss-eligible',['broadcaster']),chooseRecipient:count=>{assert.equal(count,1);return 0;}});
    assert.equal(result.ok,true);if(!result.ok)return;
    assert.equal(result.transfer?.recipientUserId,'fresh-zero');assert.equal(store.score('halloween','fresh-zero'),4);assert.equal(store.score('halloween','loser'),8);
  }finally{store.close();}
});

test('zwei aufeinanderfolgende Verluste können kein Guthaben überziehen und begrenzen den zweiten Transfer',()=>{
  const store=setup();try{
    store.miniGameTransaction(db=>db.prepare("UPDATE seasonal_events SET cooldown_ms=0 WHERE id='halloween'").run());
    putScore(store,'halloween','loser','Max',20);activity(store,'receiver','Lisa','lisa');
    const first=store.playEvent('halloween','loser','Max',-15,10_000,delivery('loss-concurrent-a'));
    const second=store.playEvent('halloween','loser','Max',-15,10_001,delivery('loss-concurrent-b'));
    assert.equal(first.ok,true);assert.equal(second.ok,true);if(!first.ok||!second.ok)return;
    assert.equal(first.transfer?.amount,15);assert.equal(second.transfer?.amount,5);assert.equal(second.points,0);
    assert.equal(store.score('halloween','loser'),0);assert.equal(store.score('halloween','receiver'),20);
    assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM seasonal_loss_transfers WHERE status=\'transferred\'').get() as {n:number}).n),2);
  }finally{store.close();}
});

test('wiederholte Verarbeitung derselben Event-ID bucht weder Gegenstände noch Chatantwort doppelt',()=>{
  const store=setup();try{
    putScore(store,'halloween','loser','Max',10);activity(store,'receiver','Lisa','lisa');
    const first=store.playEvent('halloween','loser','Max',-6,10_000,delivery('loss-idempotent'));
    const second=store.playEvent('halloween','loser','Max',-6,10_001,delivery('loss-idempotent'));
    assert.equal(first.ok,true);assert.deepEqual(second,{ok:false,reason:'duplicate'});
    assert.equal(store.score('halloween','loser'),4);assert.equal(store.score('halloween','receiver'),6);
    assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM seasonal_loss_transfers').get() as {n:number}).n),1);
    assert.equal(store.claimChatDeliveryMessages(10_002).length,1);
  }finally{store.close();}
});

test('Fehler bei der Empfängerbuchung rollt Abzug, Audit und Chat-Outbox vollständig zurück',()=>{
  const store=setup();try{
    putScore(store,'halloween','loser','Max',10);activity(store,'receiver','Lisa','lisa');
    store.miniGameTransaction(db=>db.exec(`CREATE TRIGGER fail_recipient BEFORE INSERT ON seasonal_scores WHEN NEW.user_id='receiver' BEGIN SELECT RAISE(ABORT,'simulated credit failure'); END;`));
    assert.throws(()=>store.playEvent('halloween','loser','Max',-6,10_000,delivery('loss-rollback')),/simulated credit failure/u);
    assert.equal(store.score('halloween','loser'),10);assert.equal(store.score('halloween','receiver'),0);
    assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM seasonal_loss_transfers').get() as {n:number}).n),0);
    assert.equal(store.chatDeliverySnapshot().pending,0);
  }finally{store.close();}
});

test('gemeinsame Übertragung verwendet pro Saison nur deren eigene Eventwährung',()=>{
  const store=setup('christmas');try{
    const now=CHRISTMAS_2026_START_AT+10_000;putScore(store,'christmas','loser','Max',8);activity(store,'receiver','Lisa','lisa',now);
    const christmas=store.playEvent('christmas','loser','Max',-3,now,delivery('loss-christmas'));
    store.setEventActive('christmas',false,now+1);store.setEventActive('easter',true,now+2);putScore(store,'easter','loser','Max',6);
    const easter=store.playEvent('easter','loser','Max',-2,now+3,delivery('loss-easter'));
    assert.equal(christmas.ok,true);assert.equal(easter.ok,true);if(!christmas.ok||!easter.ok)return;
    assert.equal(christmas.transfer?.currency,'Geschenke');assert.equal(easter.transfer?.currency,'Ostereier');
    assert.equal(store.score('christmas','receiver'),3);assert.equal(store.score('easter','receiver'),2);
    assert.equal(store.score('halloween','receiver'),0);
    assert.match(formatSeasonalLoss('christmas',christmas.transfer!),/Geschenke/u);
    assert.match(formatSeasonalLoss('easter',easter.transfer!),/Ostereier/u);
  }finally{store.close();}
});

test('Gewinnpfad und saisonale Gewichtungen bleiben unverändert',()=>{
  const store=setup();try{
    const weightsBefore=store.event('halloween')!.weights;
    const result=store.playEvent('halloween','winner','Winner',5,10_000,{eventId:'positive-seasonal',format:points=>`+5 · ${points}`});
    assert.equal(result.ok,true);if(result.ok)assert.equal(result.transfer,undefined);
    assert.deepEqual(store.event('halloween')!.weights,weightsBefore);
    assert.equal(store.claimChatDeliveryMessages(10_001)[0]?.message,'+5 · 5');
  }finally{store.close();}
});

test('!trickortreat verwendet denselben atomaren Übertragungsweg und stellt die echte Transfermeldung dauerhaft zu',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'acy-halloween-transfer-')),file=path.join(directory,'bot.sqlite');
  const config=testConfig({databasePath:file,cooldownMs:0,eventWeights:{TREAT:0,TRICK:1,JACKPOT:0,GHOST:0,WITCH:0,EMPTY_HOUSE:0,GOLDEN_PUMPKIN:0},gameValues:{...testConfig().gameValues,trick:{min:4,max:4}}});
  const database=new Database(file,true),features=new FeatureStore(file),community=new CommunityFeatures(features,config),game=new GameService(database,config,()=>0);
  try{
    database.applyPlay('loser','Max',7,1,0);features.miniGameTransaction(db=>db.prepare("UPDATE seasonal_events SET cooldown_ms=0 WHERE id='halloween'").run());
    community.syncLegacyHalloween(2);features.recordRecentChatActivity('receiver','Lisa','lisa',9_000);
    const handler=new CommandHandler(database,game,config,undefined,community);
    const message:ChatMessage={eventId:'treat-transfer-chat-id',messageId:'treat-transfer-message-id',broadcasterUserId:config.broadcasterUserId,senderUserId:'loser',senderLogin:'max',senderDisplayName:'Max',message:'!trickortreat',sentAt:10_000};
    const replies=await handler.handle(message,10_000);
    assert.equal(replies.length,1);assert.match(replies[0]?.message||'',/4 Kürbisse.*@Lisa/u);
    assert.equal(game.pumpkins('loser'),3);assert.equal(game.pumpkins('receiver'),4);
    assert.equal(replies[0]?.durableDeliveryId,'treat-transfer-chat-id');
    assert.match(features.claimChatDeliveryMessages(10_001)[0]?.message||'',/4 Kürbisse.*@Lisa/u);
  }finally{features.close();database.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('!gift and !egghunt can transfer bounded losses through the shared atomic seasonal path',async()=>{
  for(const [eventId,command,expectedCurrency] of [['christmas','gift','Geschenke'],['easter','egghunt','Ostereier']] as const){
    const store=setup(eventId),config=testConfig();
    try{
      const event=store.event(eventId)!;
      store.saveEvent({...event,weights:{LOSS:1},cooldownMs:0});
      putScore(store,eventId,'loser','Max',4);
      activity(store,'receiver','Lisa','lisa');
      const community=new CommunityFeatures(store,config,async()=>undefined,(_min,max)=>max);
      const now=eventId==='christmas'?CHRISTMAS_2026_START_AT+10_000:10_000;if(eventId==='christmas')activity(store,'receiver','Lisa','lisa',now);
      const message:ChatMessage={eventId:`${eventId}-loss-chat`,broadcasterUserId:config.broadcasterUserId,senderUserId:'loser',senderLogin:'max',senderDisplayName:'Max',message:`!${command}`,sentAt:now};
      const replies=await community.handle(message,command,[],now);
      assert.equal(replies.length,1);
      assert.match(replies[0]?.message||'',new RegExp(`4 ${expectedCurrency}`,'u'));
      assert.match(replies[0]?.message||'',/@Max/u);assert.match(replies[0]?.message||'',/@Lisa/u);
      assert.equal(store.score(eventId,'loser'),0);
      assert.equal(store.score(eventId,'receiver'),4);
      const audit=store.miniGameQuery(db=>db.prepare('SELECT event_type,amount,status FROM seasonal_loss_transfers WHERE event_id=?').get(`${eventId}-loss-chat`));
      assert.deepEqual(audit,{event_type:eventId,amount:4,status:'transferred'});
      assert.equal(community.claimChatDeliveryMessages(now+1)[0]?.message,replies[0]?.message);
      assert.deepEqual(await community.handle(message,command,[],now+2),[],'Wiederholte Chat-Event-ID zahlt und antwortet nicht erneut.');
      assert.equal(store.score(eventId,'receiver'),4);
    }finally{store.close();}
  }
});

test('seasonal loss weights keep neutral outcomes and existing item ranges while limiting losses to about one quarter of active outcomes',()=>{
  const store=new FeatureStore(':memory:');try{
    const christmas=store.event('christmas')!.weights,easter=store.event('easter')!.weights,halloween=store.event('halloween')!.weights;
    assert.deepEqual(christmas,{GIFT:41,JACKPOT:4,LOSS:15,EMPTY_HOUSE:40});
    assert.deepEqual(easter,{EGG:45,GOLDEN_EGG:2,LOSS:16,EMPTY_HOUSE:37});
    assert.deepEqual(halloween,{TREAT:55,TRICK:15,JACKPOT:5,GHOST:8,WITCH:8,EMPTY_HOUSE:8,GOLDEN_PUMPKIN:1});
    assert.equal(christmas.LOSS!/(christmas.LOSS!+christmas.GIFT!+christmas.JACKPOT!),0.25);
    assert.ok(Math.abs(easter.LOSS!/(easter.LOSS!+easter.EGG!+easter.GOLDEN_EGG!)-0.25)<0.01);
  }finally{store.close();}
});

test('migration v48 adds a loss to custom weights while preserving neutral share and an explicitly configured loss',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'acy-seasonal-weights-v48-')),file=path.join(directory,'data','state.sqlite');
  let store=new FeatureStore(file);
  try{
    store.miniGameTransaction(db=>{
      db.prepare("UPDATE seasonal_events SET weights_json=? WHERE id='christmas'").run('{"GIFT":32,"JACKPOT":8,"EMPTY_HOUSE":60}');
      db.prepare("UPDATE seasonal_events SET weights_json=? WHERE id='easter'").run('{"EGG":30,"GOLDEN_EGG":2,"LOSS":8,"EMPTY_HOUSE":60}');
      db.prepare('DELETE FROM schema_migrations WHERE version>=48').run();
      db.exec('DROP TABLE IF EXISTS seasonal_event_results');
    });
  }finally{store.close();}
  store=new FeatureStore(file);
  try{
    assert.deepEqual(store.event('christmas')!.weights,{GIFT:24,JACKPOT:6,EMPTY_HOUSE:60,LOSS:10});
    assert.deepEqual(store.event('easter')!.weights,{EGG:30,GOLDEN_EGG:2,LOSS:8,EMPTY_HOUSE:60});
    assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT MAX(version) version FROM schema_migrations').get() as {version:number}).version),49);
    assert.equal(store.miniGameQuery(db=>(db.prepare('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check),'ok');
    assert.ok(fs.readdirSync(path.join(directory,'backups')).some(name=>name.includes('before-feature-migration-v48-')));
  }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('saisonale Anwesenheit wird auch erfasst, wenn Tresor und Wheel ausgeschaltet sind',()=>{
  const store=new FeatureStore(':memory:'),config=testConfig(),community=new CommunityFeatures(store,config);
  try{
    store.setEventActive('halloween',true,1_000);
    const message:ChatMessage={eventId:'seasonal-presence',broadcasterUserId:config.broadcasterUserId,senderUserId:'viewer',senderLogin:'viewer',senderDisplayName:'Viewer',message:'Hallo zusammen!',sentAt:10_000};
    community.vault.observeActivity(message,10_000);
    assert.deepEqual(store.recentChatActivity(10_001,5).map(viewer=>viewer.userId),['viewer']);
    community.vault.observeActivity({...message,eventId:'seasonal-bot',senderUserId:'helper',senderLogin:'helperbot',senderDisplayName:'Helper Bot'},10_002);
    assert.deepEqual(store.recentChatActivity(10_003,5).map(viewer=>viewer.userId),['viewer']);
  }finally{store.close();}
});

test('Migration v47 erstellt ein eindeutiges Transfer-Audit und ist nach Neustart wiederholbar',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'acy-seasonal-transfer-v47-')),file=path.join(directory,'data','state.sqlite');
  let store=new FeatureStore(file);
  try{
    const first=store.miniGameQuery(db=>({version:(db.prepare('SELECT MAX(version) version FROM schema_migrations').get() as {version:number}).version,
      tables:db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='seasonal_loss_transfers'").get() as {n:number},
      backup:fs.readdirSync(path.join(directory,'backups')).some(name=>name.includes('before-feature-migration-v47-'))}));
    assert.equal(first.version,49);assert.equal(first.tables.n,1);assert.equal(first.backup,true);
    store.miniGameTransaction(db=>db.prepare(`INSERT INTO seasonal_loss_transfers(event_id,event_type,loser_user_id,loser_name,currency,amount,status,created_at)
      VALUES('migration-audit','halloween','viewer','Viewer','Kürbisse',0,'no_balance',1)`).run());
  }finally{store.close();}
  store=new FeatureStore(file);try{
    assert.equal(store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) n FROM seasonal_loss_transfers').get() as {n:number}).n),1);
    assert.equal(store.miniGameQuery(db=>(db.prepare('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check),'ok');
    assert.throws(()=>store.miniGameTransaction(db=>db.prepare(`INSERT INTO seasonal_loss_transfers(event_id,event_type,loser_user_id,loser_name,currency,amount,status,created_at)
      VALUES('migration-audit','halloween','viewer','Viewer','Kürbisse',0,'no_balance',2)`).run()));
  }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});
