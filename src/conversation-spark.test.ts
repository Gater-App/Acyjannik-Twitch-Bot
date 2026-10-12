import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeatureStore } from './feature-store.js';
import { ConversationSpark, DEFAULT_SPARK_CONFIG, RuleBasedTopicDetector } from './conversation-spark.js';
import type { ChatMessage } from './types.js';

function message(id:string,user:string,text:string,channel='broadcaster-1'):ChatMessage {
  return {eventId:id,messageId:`message-${id}`,broadcasterUserId:channel,senderUserId:user,senderLogin:user,senderDisplayName:user,
    message:text,sentAt:0,isModerator:false};
}
function enabled(store:FeatureStore,extra:Record<string,unknown>={}) {
  store.setConfig('spark_settings',{...DEFAULT_SPARK_CONFIG,enabled:true,globalCooldownMs:20*60_000,topicCooldownMs:60*60_000,...extra});
}

test('regelbasierte Topic-Erkennung normalisiert Schreibweise und verlangt Kontext bei mehrdeutigem Boss-Begriff',()=>{
  const detector=new RuleBasedTopicDetector();
  assert.deepEqual(detector.detect('  ZERO   BUILD!!! ').map((item)=>item.topic.id),['fortnite']);
  assert.deepEqual(detector.detect('Minecraft und REDSTONE').map((item)=>item.topic.id),['minecraft']);
  assert.deepEqual(detector.detect('Der Boss ist stark'),[]);
  assert.deepEqual(detector.detect('Zero Build im Ranked').map((item)=>item.topic.id),['fortnite']);
  assert.deepEqual(detector.detect('Elden Ring, ich würde ein anderes Build probieren').map((item)=>item.topic.id),['elden-ring']);
});

test('Spark bleibt standardmäßig aus, respektiert Kanalbindung, Schwellen und dedupliziert Events',()=>{
  const store=new FeatureStore(':memory:'); const spark=new ConversationSpark(store,'broadcaster-1');
  try {
    assert.equal(spark.observe(message('off','alice','Fortnite zero build strategy'),1_000).length,0);
    enabled(store);
    assert.equal(spark.observe(message('wrong','alice','Fortnite zero build strategy','other-channel'),2_000).length,0);
    const texts=['Fortnite Zero Build ist heute spannend','Zero Build im Ranked läuft besser','Battle Royale oder Zero Build?','Fortnite Ranked macht Spaß','Ich spiele Fortnite Zero Build'];
    const users=['alice','bob','alice','carol','bob'];
    let proposals=[] as ReturnType<typeof spark.observe>;
    for(let i=0;i<texts.length;i++) proposals=spark.observe(message(`e${i}`,users[i]!,texts[i]!),10_000+i*30_000);
    assert.equal(proposals.length,1);
    assert.equal(proposals[0]?.status,'pending_approval');
    assert.equal(proposals[0]?.participants,3);
    assert.equal(proposals[0]?.messages,5);
    assert.equal(spark.observe(message('e4','bob',texts[4]!),200_000).length,0,'duplicate EventSub event is ignored');
    assert.equal(store.sparkProposals('pending_approval').length,1);
  } finally {store.close();}
});

test('ein Nutzer kann weder allein noch durch kopierte Wiederholungen den Trigger auslösen',()=>{
  const store=new FeatureStore(':memory:'); const spark=new ConversationSpark(store,'broadcaster-1'); enabled(store);
  try {
    for(let i=0;i<12;i++) spark.observe(message(`same-${i}`,'alice','Fortnite Zero Build ranked strategy'),100_000+i*10_000);
    assert.equal(store.sparkProposals('all').length,0);
  } finally {store.close();}
});

test('Sliding Window entfernt abgelaufene Aktivität und Cooldowns verhindern erneute Vorschläge',()=>{
  const store=new FeatureStore(':memory:'); const spark=new ConversationSpark(store,'broadcaster-1'); enabled(store,{windowMs:600_000});
  try {
    const texts=['Fortnite Zero Build today','Zero Build ranked strategy','Fortnite Battle Royale','Fortnite Reload','Ranked Zero Build'];
    for(let i=0;i<texts.length;i++) spark.observe(message(`old-${i}`,['a','b','c','a','b'][i]!,texts[i]!),i*10_000);
    assert.equal(store.sparkProposals('all').length,1);
    spark.tick(700_000);
    assert.deepEqual(spark.snapshot(700_000),[]);
    for(let i=0;i<texts.length;i++) spark.observe(message(`new-${i}`,['a','b','c','a','b'][i]!,texts[i]!),710_000+i*10_000);
    assert.equal(store.sparkProposals('all').length,1,'topic/global cooldown still applies after window expiry');
  } finally {store.close();}
});

test('Proposal state changes require valid current state and expired suggestions cannot execute',()=>{
  const store=new FeatureStore(':memory:'); enabled(store);
  try {
    const proposal=store.createSparkProposal({id:'proposal-test',channelId:'broadcaster-1',topicId:'minecraft',topicLabel:'Minecraft',
      score:14,participants:3,messages:5,actionType:'poll',createdAt:1000,expiresAt:5000},5,60_000,120_000);
    assert.ok(proposal);
    assert.equal(store.decideSparkProposal(proposal.id,'approved','mod-1',2000),true);
    assert.equal(store.decideSparkProposal(proposal.id,'approved','mod-1',2001),false);
    assert.equal(store.decideSparkProposal(proposal.id,'executed','admin-1',5000),false);
    assert.equal(store.sparkProposal(proposal.id)?.status,'expired');
  } finally {store.close();}
});

test('Spark-Proposals überleben Neustart und Migration verändert keine Bestandsdaten',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'spark-store-')),file=path.join(directory,'data','bot.sqlite');
  let store=new FeatureStore(file);
  try {
    store.setConfig('spark_settings',{...DEFAULT_SPARK_CONFIG,enabled:true});
    store.createSparkProposal({id:'persisted',channelId:'broadcaster-1',topicId:'elden-ring',topicLabel:'Elden Ring',
      score:18,participants:4,messages:6,actionType:'poll',createdAt:1000,expiresAt:20000},5,60_000,120_000);
    store.close(); store=new FeatureStore(file);
    assert.equal(store.sparkProposals('pending_approval')[0]?.id,'persisted');
    assert.equal(store.config<Record<string,unknown>>('spark_settings',{}).enabled,true);
  } finally {store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test('Chatbefehle schützen Pause und Moderation nach Broadcaster-/Moderator-Rolle',async()=>{
  const store=new FeatureStore(':memory:');const spark=new ConversationSpark(store,'broadcaster-1');enabled(store);
  try {
    assert.match((await spark.handleCommand(message('pause-viewer','alice','!sparkpause'),'sparkpause',[],1000))||'',/Nur Jannik/u);
    assert.equal((await spark.handleCommand(message('pause-host','broadcaster-1','!sparkpause'),'sparkpause',[],1000)), '✨ Erkennung pausiert.');
    assert.equal(spark.config().paused,true);
    assert.match((await spark.handleCommand({...message('approve-viewer','alice','!sparkapprove a'),isModerator:false},'sparkapprove',['a'],1000))||'',/Nur Jannik oder Moderatoren/u);
  } finally {store.close();}
});
