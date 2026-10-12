import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import test from 'node:test';
import { FeatureStore } from './feature-store.js';
import { MiniGames } from './mini-games.js';
import { testConfig } from './test-config.js';
import type { ChatMessage } from './types.js';

function msg(id:string,name:string,text='hello there'):ChatMessage{return {eventId:`evt-${id}-${Math.random()}`,broadcasterUserId:'broadcaster-1',senderUserId:id,senderLogin:id,senderDisplayName:name,message:text,sentAt:1};}
function fixture(){const store=new FeatureStore(':memory:'),game=new MiniGames(store,testConfig(),()=>0);game.updateSettings({...game.settings(),enabled:true,imposter:{...game.settings().imposter,minPlayers:4,maxPlayers:5,registrationMs:1000,playMs:1000,votingMs:1000,cooldownMs:0,rules:[{id:'uppercase',name:'Caps',description:'Nur GROSSBUCHSTABEN.',enabled:true}]},detective:{...game.settings().detective,roundMs:1000}});return {store,game};}

test('Imposter-Runde braucht Mindestzahl, begrenzt Plätze, weist genau eine Rolle zu und schützt fremde Rollen',()=>{
  const {store,game}=fixture();const t=1000;assert.match(game.startImposter('broadcaster-1',t),/Anmeldung offen/u);
  for(let i=1;i<=6;i++)game.join(msg(`u${i}`,`Viewer${i}`),t+i);
  const db=store.miniGameQuery(d=>d);assert.equal((db.prepare('SELECT COUNT(*) n FROM imposter_players').get() as {n:number}).n,5);
  const response=game.startRoles('broadcaster-1',t+10);assert.match(response,/Mit Twitch anmelden/u);
  const players=db.prepare('SELECT user_id,role FROM imposter_players').all() as Array<{user_id:string;role:string}>;
  assert.equal(players.filter(p=>p.role==='imposter').length,1);
  assert.deepEqual(game.roleFor('intruder'),undefined);
  const assigned=players.find(p=>p.role==='imposter')!;assert.deepEqual(game.roleFor(assigned.user_id),{role:'imposter'});
  const normal=players.find(p=>p.role==='player')!;assert.deepEqual(game.roleFor(normal.user_id),{role:'player',rule:'Nur GROSSBUCHSTABEN.'});
  assert.equal(JSON.stringify(store.widgetSnapshot('imposter',t)).includes('Nur GROSSBUCHSTABEN'),false);
  assert.match(game.beginVote(t+20),/Abstimmung/u);
  const voter=players.find(p=>p.user_id!==assigned.user_id)!;assert.match(game.vote(msg(voter.user_id,'Viewer2'),'@u1',t+30),/Stimme .* gespeichert/u);
  store.close();
});

test('Imposter-Abstimmung und XP-Auszahlung sind idempotent; ein Nichtteilnehmer kann nicht stimmen',()=>{
  const {store,game}=fixture();game.startImposter('admin',1);for(let i=1;i<=4;i++)game.join(msg(`p${i}`,`P${i}`),2+i);game.startRoles('admin',10);
  const players=store.miniGameQuery(db=>db.prepare('SELECT user_id,display_name,role FROM imposter_players').all() as Array<{user_id:string;display_name:string;role:string}>);
  const imp=players.find(p=>p.role==='imposter')!,other=players.find(p=>p.role==='player')!;game.beginVote(20);
  assert.match(game.vote(msg('outsider','Outsider'),'@'+imp.display_name,21),/Nur Teilnehmende/u);
  for(const voter of players.filter(p=>p.user_id!==imp.user_id))game.vote(msg(voter.user_id,voter.display_name),'@'+imp.display_name,22);
  const result=game.finishImposter(2000);assert.match(result,/Gut erkannt/u);
  const before=store.xp(imp.user_id).xp;game.finishImposter(3000);assert.equal(store.xp(imp.user_id).xp,before);
  assert.equal(store.miniGameQuery(db=>db.prepare('SELECT COUNT(*) n FROM mini_game_awards').get() as {n:number}).n,4);
  assert.equal(game.roleFor(other.user_id),undefined,'finished round no longer exposes participant role');store.close();
});

test('Detektiv speichert nur einzeln eingereichte Zitate, benötigt Moderationsfreigabe und erlaubt Opt-out-Löschung',()=>{
  const {store,game}=fixture();const author=msg('author','Joker','Mein Internet hat mich heute schon dreimal verraten!');
  assert.match(game.saveQuote(author,'Meine Nachricht ohne Einwilligung',1),/quoteoptin/u);
  game.quoteOptIn(author.senderUserId,2);assert.match(game.saveQuote(author,author.message,3),/Moderation/u);
  const pending=game.pendingQuotes() as Array<{id:string;text:string}>;assert.equal(pending.length,1);assert.equal(pending[0]!.text,author.message);
  assert.equal(game.startDetective(4).includes('kein freigegebenes Zitat'),true);
  assert.equal(game.moderateQuote(pending[0]!.id,'approved',5),true);assert.equal(game.moderateQuote(pending[0]!.id,'rejected',6),false);
  assert.match(game.startDetective(10),/gestartet/u);assert.equal(JSON.stringify(store.widgetSnapshot('detective',11)).includes('author'),false);
  assert.match(game.guess(msg('guesser','Guess'),'@Joker',12),/Tipp gespeichert/u);
  assert.match(game.finishDetective(2000),/Joker/u);assert.equal(store.xp('guesser').xp,10);
  assert.match(game.quoteOptOut(author.senderUserId),/gelöscht/u);assert.equal((game.pendingQuotes() as unknown[]).length,0);
  assert.equal(store.miniGameQuery(db=>db.prepare('SELECT COUNT(*) n FROM detective_quotes').get() as {n:number}).n,0);store.close();
});

test('Minispiele default OFF, Rundenzustand bleibt nach erneutem Store-Start erhalten und Text wird begrenzt',()=>{
  const {store,game}=fixture();const saved=game.settings();assert.equal(saved.enabled,true);const consent=game.quoteOptIn('viewer');assert.match(consent,/ausdrücklich/u);
  assert.match(game.saveQuote(msg('viewer','Viewer'),'<img src=x onerror=alert(1)>\u0000abcdefgh',1),/Moderation/u);
  const stored=store.miniGameQuery(db=>db.prepare('SELECT text FROM detective_quotes').get() as {text:string});assert.match(stored.text,/<img/u);assert.equal(stored.text.includes('\u0000'),false);
  store.close();
  const reopened=new FeatureStore(':memory:');assert.equal(reopened.config('mini_game_settings',{enabled:true}).enabled,false);reopened.close();
});

test('Abmeldung und Mindestzahl werden geprüft; der automatische Timer bricht leere Runden sicher ab',()=>{
  const {store,game}=fixture();game.startImposter('admin',100);game.join(msg('a','Ada'),110);game.join(msg('b','Bea'),120);
  assert.match(game.leave('b'),/verlassen/u);assert.match(game.startRoles('admin',130),/Mindestens 4/u);
  assert.match(game.handle(msg('viewer','Viewer'),'startimposter',[],140)||'',/Nur Jannik oder Mods/u);
  const timed=game.tick(1200);assert.match(timed.join(' '),/Zu wenige Teilnehmende/u);
  assert.equal((game.snapshot(1201).imposter),null);store.close();
});

test('Konfigurierte Stimmenänderung zählt weiterhin eine Stimme; Gleichstand kann neutral ausgehen',()=>{
  const {store,game}=fixture();game.updateSettings({...game.settings(),enabled:true,imposter:{...game.settings().imposter,allowVoteChange:true,noSelfVote:false,tieOutcome:'neutral'}});
  game.startImposter('admin',1);for(let i=1;i<=4;i++)game.join(msg(`v${i}`,`V${i}`),i+1);game.startRoles('admin',10);game.beginVote(20);
  assert.match(game.vote(msg('v1','V1'),'@V2',21),/gespeichert/u);assert.match(game.vote(msg('v1','V1'),'@V3',22),/geändert/u);
  game.vote(msg('v2','V2'),'@V3',23);game.vote(msg('v3','V3'),'@V2',24);game.vote(msg('v4','V4'),'@V2',25);
  assert.equal((game.snapshot(26).imposter as {votes:number}).votes,4);
  assert.match(game.finishImposter(2000),/neutrale Runde/u);
  const widget=store.widgetSnapshot('imposter',2001);assert.equal((widget.game as {result:{neutral:boolean}}).result.neutral,true);store.close();
});

test('Detektiv-Tippwechsel bleibt eindeutig und abgelaufene Zitate werden bereinigt',()=>{
  const {store,game}=fixture();const author=msg('author','QuoteAutor');game.quoteOptIn('author',1);game.saveQuote(author,'Ich habe diesen Boss schon besiegt!',2);
  const quote=(game.pendingQuotes() as Array<{id:string}>)[0]!;game.moderateQuote(quote.id,'approved',3);game.startDetective(10);
  assert.match(game.guess(msg('guesser','Rater'),'@QuoteAutor',11),/gespeichert/u);assert.match(game.guess(msg('guesser','Rater'),'@QuoteAutor',12),/bereits gespeichert/u);
  game.updateSettings({...game.settings(),detective:{...game.settings().detective,allowGuessChange:true}});
  assert.match(game.guess(msg('guesser','Rater'),'@QuoteAutor',13),/geändert/u);
  game.tick(91*86_400_000);assert.equal((game.pendingQuotes() as unknown[]).length,0);store.close();
});

test('Aktive Imposter-Runde und geheime Rolle lassen sich aus SQLite nach Neustart wiederherstellen',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mini-game-restart-')),file=path.join(dir,'bot.sqlite'),config=testConfig();
  let store=new FeatureStore(file),games=new MiniGames(store,config,()=>0);games.updateSettings({...games.settings(),enabled:true});games.startImposter('admin',100);
  for(let i=1;i<=4;i++)games.join(msg(`restart-${i}`,`Restart${i}`),101+i);games.startRoles('admin',110);const expected=games.roleFor('restart-2');store.close();
  try{store=new FeatureStore(file);games=new MiniGames(store,config,()=>0);assert.deepEqual(games.roleFor('restart-2'),expected);assert.equal((games.snapshot(120).imposter as {phase:string}).phase,'playing');assert.match(games.beginVote(130),/Abstimmung/u);}
  finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
