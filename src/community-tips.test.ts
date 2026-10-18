import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FeatureStore } from './feature-store.js';
import { CommunityTips, TIP_ACTIVITY_RULES } from './community-tips.js';
import type { TipAvailability } from './community-tips.js';
import type { ChatMessage } from './types.js';

function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'community-tips-'));
  const file = path.join(directory, 'features.sqlite');
  const store = new FeatureStore(file);
  const tips = new CommunityTips(store);
  return { store, tips, file, close: () => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
function message(text: string, eventId: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { eventId, messageId: `msg-${eventId}`, broadcasterUserId: 'streamer', senderUserId: `viewer-${eventId}`,
    senderLogin: `viewer${eventId}`, senderDisplayName: 'Viewer', message: text, sentAt: 0, ...extra };
}
const available = { events: true, activeEventCommand: 'trickortreat', eightBall: true, rps: true, duels: true,
  guess: true, pet: true, petCare: true, detective: true, quests: true, xp: true, drops: true, imposter: true, wheel: true, vault: true };
const halloweenActive = {...available,activeEventId:'halloween'};
const halloweenOnly = {events:true,activeEventId:'halloween',activeEventCommand:'trickortreat'};

test('tips are off by default, unknown/offline streams never send, and lively requires its activity threshold', () => {
  const { tips, close } = setup();
  try {
    assert.equal(tips.settings().enabled, false);
    for(let i=0;i<TIP_ACTIVITY_RULES.normal.messages;i++)tips.observe(message(`Real viewer conversation ${i}`,`disabled-${i}`),100+i);
    assert.equal(tips.eligibleActivityMessages,TIP_ACTIVITY_RULES.normal.messages,'Aktivitätsmessung unterstützt eigene Nachrichten auch bei ausgeschalteten Community-Tipps');
    tips.alignStream('new-stream');assert.equal(tips.eligibleActivityMessages,0,'Streamwechsel verwirft Aktivität aus dem vorherigen Stream');
    tips.configure(true);
    assert.equal(tips.maybeSend({ isLive: undefined, streamId: 's', profile: 'lively', availability: available, busy: false, now: 1 }), undefined);
    assert.equal(tips.maybeSend({ isLive: false, streamId: 's', profile: 'lively', availability: available, busy: false, now: 1 }), undefined);
    assert.equal(tips.maybeSend({ isLive: true, streamId: 's', profile: 'lively', availability: available, busy: false, now: 2 }), undefined);
    for (let i = 0; i < 4; i++) tips.observe(message(`Different chat thought ${i}`, `${i}`), 1_000 + i);
    assert.equal(tips.maybeSend({ isLive: true, streamId: 's', profile: 'lively', availability: available, busy: false, now: 2_000 }), undefined);
  } finally { close(); }
});

test('activity filters commands, moderators, broadcaster and repeated text; eligible tip persists and rotates once per stream', () => {
  const { tips, store, file, close } = setup();
  try {
    tips.configure(true);
    tips.maybeSend({ isLive: true, streamId: 'live-1', profile: 'normal', availability: available, busy: false, now: 5 });
    tips.observe(message('!help', 'cmd'), 10);
    tips.observe(message('real chat message', 'mod', { isModerator: true }), 10);
    tips.observe(message('real chat message', 'broadcaster', { senderUserId: 'streamer' }), 10);
    tips.observe(message('same genuine message', 'a'), 10);
    tips.observe(message('same genuine message', 'b'), 20);
    for (let i = 0; i < TIP_ACTIVITY_RULES.normal.messages - 2; i++) tips.observe(message(`unique genuine words ${i}`, `u${i}`), 30 + i);
    assert.equal(tips.maybeSend({ isLive: true, streamId: 'live-1', profile: 'normal', availability: available, busy: false, now: 100_000 }), undefined);
    tips.observe(message('the final genuine chat message', 'last'), 40);
    const result = tips.maybeSend({ isLive: true, streamId: 'live-1', profile: 'normal', availability: available, busy: false, now: 100_000, random: () => 0 });
    assert.ok(result);
    assert.equal(result.category, 'oracle');
    assert.equal((store.config<any>('community_tip_state', {}).sentHistory as number[]).length, 1);
    const reopenedStore = new FeatureStore(file);
    const reopened = new CommunityTips(reopenedStore);
    assert.equal(reopened.maybeSend({ isLive: true, streamId: 'live-1', profile: 'normal', availability: available, busy: false, now: 100_001 }), undefined,
      'reopen must retain cooldown and per-stream used-topic state');
    assert.equal(reopened.maybeSend({ isLive: true, streamId: 'live-2', profile: 'normal', availability: available, busy: false, now: 100_002 }), undefined,
      'hourly and minimum-spacing limits persist across restart');
    reopenedStore.close();
  } finally { close(); }
});

test('busy games, unavailable/used features, spacing, per-hour caps and global-send suppression prevent a tip', () => {
  const { tips, close } = setup();
  try {
    tips.configure(true);
    tips.maybeSend({ isLive: true, streamId: 's', profile: 'calm', availability: { xp: true }, busy: false, now: 1 });
    for (let i = 0; i < 8; i++) tips.observe(message(`active conversation ${i}`, `a${i}`), i + 1);
    const common = { isLive: true, streamId: 's', profile: 'calm' as const, availability: { xp: true }, now: 4_000 };
    assert.equal(tips.maybeSend({ ...common, busy: true }), undefined);
    assert.equal(tips.maybeSend({ ...common, busy: false, allowSend: () => false }), undefined);
    assert.equal(tips.state().lastSentAt, 0, 'global message policy denial must not consume/persist a tip');
  } finally { close(); }
});

test('Community Discovery previews only enabled functions and uses the implemented viewer commands',()=>{
  const {tips,close}=setup();
  try{
    tips.configure(true);
    const all=tips.preview(available),byId=new Map(all.map(t=>[t.id,t.text]));
    for(const id of ['eightball','rps','duel','guess','pet','pet-care','detective-guess','quote','quest','quest-vote','xp','drop','imposter','wheel','vault'])assert.ok(byId.has(id),`${id} is available`);
    assert.match(byId.get('quest')||'',/!quest IDEE/u);assert.match(byId.get('quest')||'',/Moderationsfreigabe/u);
    assert.match(byId.get('quest-vote')||'',/Jannik oder ein Mod startet/u);
    assert.match(byId.get('drop')||'',/!claim/u);assert.match(byId.get('imposter')||'',/!joinimposter/u);
    assert.match(byId.get('wheel')||'',/!wheel/u);assert.match(byId.get('vault')||'',/!code XXX.*Platzhalter/u);
    const disabled=tips.preview({});assert.equal(disabled.length,0,'disabled/unknown modules are never advertised');
    tips.configurePortal(true);
    assert.equal(tips.preview({...available,communityPortal:false}).some(t=>t.id==='community-portal'),false);
    assert.equal(tips.preview({...available,communityPortal:true}).some(t=>t.id==='community-portal'),true);
    assert.equal(tips.preview({...available,petCare:false}).some(t=>t.id==='pet-care'),false,'paused care never advertises feeding or play');
  }finally{close()}
});

test('feature use suppresses matching tips and topic rotation survives restart without storing viewers or chat text',()=>{
  const {tips,store,file,close}=setup();
  try{
    tips.configure(true);tips.alignStream('discovery-stream');const now=4_000_000_000;
    tips.observe(message('!quest Meine Idee','quest-used'),now);
    for(let i=0;i<6;i++)tips.observe(message(`Quest cooldown activity ${i}`,`quest-activity-${i}`),now+i+1);
    assert.equal(tips.shouldEvaluate('normal',{quests:true},false,now+100),false,'both quest hints share the same command cooldown');
    tips.configurePortal(true);
    for(let i=0;i<6;i++)tips.observe(message(`Discovery activity ${i}`,`discovery-${i}`),now+i);
    const discoveryAvailability={...available,events:false,communityPortal:true};
    const first=tips.maybeSend({isLive:true,streamId:'discovery-stream',profile:'normal',availability:discoveryAvailability,busy:false,now:now+100,random:max=>max-1});
    assert.ok(first);assert.equal(first.id,'community-portal','portal is a distinct category at the end of the fixture');
    const restoredStore=new FeatureStore(file),restored=new CommunityTips(restoredStore);restored.alignStream('discovery-stream');
    assert.equal(restored.state().lastCategory,first.category,'topic preference persists after restart');
    const persisted=JSON.stringify(store.config('community_tip_state',{}));
    assert.doesNotMatch(persisted,/viewer|Discovery activity|streamer/iu,'state contains no chat text or viewer identity');
    for(let i=0;i<6;i++)restored.observe(message(`Later discussion ${i}`,`later-${i}`),now+31*60_000+i);
    const next=restored.maybeSend({isLive:true,streamId:'discovery-stream',profile:'normal',availability:discoveryAvailability,busy:false,now:now+31*60_000+100,random:()=>0});
    assert.ok(next);assert.notEqual(next.category,first.category,'the next tip rotates to another topic after restart');
    restoredStore.close();
  }finally{close()}
});

test('recent use of promoted game commands temporarily suppresses their own matching tip',()=>{
  const cases:Array<[string,TipAvailability]>= [['!guess 42',{guess:true}],['!feed',{pet:true,petCare:true}],['!wer @Name',{detective:true}],
    ['!claim',{drops:true}],['!joinimposter',{imposter:true}],['!wheel',{wheel:true}],['!code 427',{vault:true}]];
  for(const [command,availability] of cases){
    const {tips,close}=setup();
    try{
      tips.configure(true);tips.alignStream('command-cooldown');tips.observe(message(command,`used-${command}`),10);
      for(let i=0;i<6;i++)tips.observe(message(`Fresh chat ${command} ${i}`,`fresh-${command}-${i}`),20+i);
      assert.equal(tips.shouldEvaluate('normal',availability,false,100),false,`${command} suppresses its matching hint for 15 minutes`);
    }finally{close()}
  }
});

test('Community-Portal-Tipp nutzt nur den vorhandenen Aktivitäts- und Profilplan und respektiert !help/!community',()=>{
  const {tips,close}=setup();
  try{
    tips.configure(true);tips.configurePortal(true);
    const onlyPortal={communityPortal:true};
    assert.equal(tips.preview({...onlyPortal,communityPortal:false}).some(x=>x.id==='community-portal'),false,'nicht erreichbares Portal wird nicht beworben');
    tips.alignStream('portal-stream');
    tips.maybeSend({isLive:true,streamId:'portal-stream',profile:'normal',availability:onlyPortal,busy:false,now:1});
    for(let i=0;i<5;i++)tips.observe(message(`Chatbeitrag ${i}`,`portal-chat-${i}`),100+i);
    assert.equal(tips.maybeSend({isLive:true,streamId:'portal-stream',profile:'normal',availability:onlyPortal,busy:false,now:1_000}),undefined,'Normal benötigt sechs echte Chatbeiträge');
    tips.observe(message('Chatbeitrag sechs','portal-chat-6'),200);
    tips.observe(message('!help','portal-help'),201);
    assert.equal(tips.maybeSend({isLive:true,streamId:'portal-stream',profile:'normal',availability:onlyPortal,busy:false,now:1_000,random:()=>0})?.id,undefined,'unmittelbar nach !help wird derselbe Portal-Link nicht gesendet');
    tips.observe(message('!help','portal-mod-help',{isModerator:true}),1_000_000);
    for(let i=0;i<6;i++)tips.observe(message(`mod-help aftermath ${i}`,`mod-after-${i}`),1_000_001+i);
    assert.equal(tips.maybeSend({isLive:true,streamId:'portal-stream',profile:'normal',availability:onlyPortal,busy:false,now:1_000_010,random:()=>0}),undefined,'auch eine öffentliche Mod-Hilfeantwort unterdrückt denselben Link');
    for(let i=0;i<6;i++)tips.observe(message(`fresh discussion ${i}`,`fresh-${i}`),1_900_000+i);
    assert.equal(tips.maybeSend({isLive:true,streamId:'portal-stream',profile:'normal',availability:onlyPortal,busy:false,now:1_900_010,random:()=>0})?.id,'community-portal');
    assert.equal(tips.maybeSend({isLive:true,streamId:'portal-stream',profile:'normal',availability:onlyPortal,busy:false,now:1_900_011,random:()=>0}),undefined,'derselbe Tipp wird innerhalb des Cooldowns nicht wiederholt');
    tips.configure(false);
    assert.equal(tips.settings().portalEnabled,true,'Schalter bleibt gesetzt, wird aber durch deaktivierte Community-Tipps nicht aktiv');
    assert.equal(tips.preview({...onlyPortal,communityPortal:true}).some(x=>x.id==='community-portal'),false);
  }finally{close()}
});

test('Halloween erinnert abwechslungsreich mit Live-Event, echter Aktivität, 30-Minuten-Abstand und höchstens zwei Tipps pro Stunde',()=>{
  const {tips,store,file,close}=setup();
  try{
    tips.configure(true);tips.alignStream('halloween-stream');
    const start=1_000_000_000;
    const addActivity=(collector:CommunityTips,base:number,prefix:string)=>{for(let i=0;i<6;i++)collector.observe(message(`Genuine Halloween chat ${prefix} ${i}`,`${prefix}-${i}`),base+i)};
    addActivity(tips,start,'first');
    assert.equal(tips.shouldEvaluate('normal',available,false,start+10),true,'ohne aktive Halloween-ID bleiben andere Community-Tipps möglich');
    const first=tips.maybeSend({isLive:true,streamId:'halloween-stream',profile:'normal',availability:halloweenActive,busy:false,now:start+100,random:()=>0});
    assert.equal(first?.id,'halloween-reminder');assert.match(first?.text||'',/!trickortreat|!pumpkins/u);
    assert.equal(tips.status('normal',start+100,halloweenActive).halloweenSentThisHour,1);

    const restoredStore=new FeatureStore(file),restored=new CommunityTips(restoredStore);restored.alignStream('halloween-stream');
    addActivity(restored,start+30*60_000,'second');
    const second=restored.maybeSend({isLive:true,streamId:'halloween-stream',profile:'normal',availability:halloweenActive,busy:false,now:start+30*60_000+100,random:()=>0});
    assert.equal(second?.id,'halloween-reminder');assert.notEqual(second?.text,first?.text,'Textrotation bleibt nach Neustart erhalten');
    assert.equal(restored.status('normal',start+30*60_000+100,halloweenActive).halloweenSentThisHour,2);
    addActivity(restored,start+59*60_000,'third');
    assert.equal(restored.shouldEvaluate('normal',halloweenActive,false,start+59*60_000+100),false,'Mindestabstand hält eine dritte Erinnerung im selben Stundenfenster zurück');
    assert.equal(restored.maybeSend({isLive:true,streamId:'halloween-stream',profile:'normal',availability:halloweenActive,busy:false,now:start+59*60_000+100}),undefined);
    restoredStore.close();
  }finally{close()}
});

test('Halloween-Erinnerung pausiert bei Offline-Stream, beendetem Event, deaktivierten Tipps oder ausgeschaltetem Schalter',()=>{
  const {tips,close}=setup();
  try{
    tips.configure(true);tips.alignStream('halloween-stream');const now=2_000_000_000;
    for(let i=0;i<6;i++)tips.observe(message(`Active event activity ${i}`,`active-${i}`),now+i);
    assert.notEqual(tips.maybeSend({isLive:true,streamId:'halloween-stream',profile:'normal',availability:{...halloweenOnly,events:false},busy:false,now:now+10,random:()=>0})?.id,'halloween-reminder','inaktives Event darf keine Halloween-Erinnerung erzeugen');
    assert.equal(tips.maybeSend({isLive:false,streamId:'halloween-stream',profile:'normal',availability:halloweenOnly,busy:false,now:now+11}),undefined);
    tips.alignStream('halloween-stream');for(let i=0;i<6;i++)tips.observe(message(`More active event activity ${i}`,`more-${i}`),now+20+i);
    tips.configureHalloween(false);
    assert.equal(tips.shouldEvaluate('normal',halloweenOnly,false,now+100),false);
    tips.configureHalloween(true,'normal');tips.configure(false);
    assert.equal(tips.shouldEvaluate('normal',halloweenOnly,false,now+200),false);
  }finally{close()}
});

test('Halloween-Hinweis konkurriert fair mit anderen Tipps und bewahrt Sendegrenzen',()=>{
  const {tips,close}=setup();
  try{
    tips.configure(true);tips.alignStream('mixed-stream');const now=2_500_000_000;
    for(let i=0;i<6;i++)tips.observe(message(`Mixed community chat ${i}`,`mix-${i}`),now+i);
    const result=tips.maybeSend({isLive:true,streamId:'mixed-stream',profile:'normal',availability:{...halloweenActive,pet:true},busy:false,now:now+100,random:()=>2});
    assert.ok(result);assert.notEqual(result.id,'halloween-reminder','mögliche Community-Tipps werden nicht vollständig verdrängt');
    const next= tips.status('normal',now+100,halloweenActive);
    assert.equal(next.halloweenHourlyLimit,2);assert.ok(next.halloweenNextEarliestAt!>=now+30*60_000);
  }finally{close()}
});

test('Halloween-Häufigkeit Normal wartet 45 Minuten und ein kürzlich genutzter Eventbefehl verschiebt den Hinweis',()=>{
  const {tips,close}=setup();
  try{
    tips.configure(true);tips.configureHalloween(true,'normal');tips.alignStream('frequency-stream');const now=3_000_000_000;
    for(let i=0;i<6;i++)tips.observe(message(`First event conversation ${i}`,`normal-first-${i}`),now+i);
    tips.observe(message('!trickortreat','recent-event-command'),now+10);
    assert.equal(tips.shouldEvaluate('normal',halloweenOnly,false,now+11),false,'direkt nach dem Spielbefehl wird nicht erneut dafür geworben');
    assert.equal(tips.shouldEvaluate('normal',halloweenOnly,false,now+15*60_000+11),true,'nach dem Befehlsabstand darf die Erinnerung wieder eingeplant werden');
    const first=tips.maybeSend({isLive:true,streamId:'frequency-stream',profile:'normal',availability:halloweenOnly,busy:false,now:now+15*60_000+11,random:()=>0});
    assert.equal(first?.id,'halloween-reminder');
    for(let i=0;i<6;i++)tips.observe(message(`Second event conversation ${i}`,`normal-second-${i}`),now+45*60_000+i);
    assert.equal(tips.shouldEvaluate('normal',halloweenOnly,false,now+45*60_000+20),false,'Normal wartet mindestens 45 Minuten');
    assert.equal(tips.shouldEvaluate('normal',halloweenOnly,false,now+60*60_000+11),true,'nach 45 Minuten plus globalem Tippabstand ist die Erinnerung wieder möglich');
  }finally{close()}
});
