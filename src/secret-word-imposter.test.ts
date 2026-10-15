import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FeatureStore } from './feature-store.js';
import { SecretWordImposter } from './secret-word-imposter.js';
import { testConfig } from './test-config.js';

function fixture(){
  const store=new FeatureStore(':memory:'),game=new SecretWordImposter(store,testConfig(),()=>0);
  game.updateSettings({...game.settings(),enabled:true,minPlayers:3,maxPlayers:6,registrationMs:10_000,hintMs:5_000,discussionMs:10_000,votingMs:10_000,guessMs:5_000,cooldownMs:0});
  return {store,game};
}
function addPlayers(game:SecretWordImposter,count=3,now=1000){
  void game;void now;
  return Array.from({length:count},(_,index)=>({userId:`viewer-${index}`,login:`viewer_${index}`,displayName:`Viewer ${index}`}));
}
function beginHints(game:SecretWordImposter,players:ReturnType<typeof addPlayers>,now=2000){
  assert.equal(game.start('broadcaster',now).ok,true);for(const p of players)assert.equal(game.join(p,now+1).ok,true);
  const result=game.startRoles('broadcaster',now+2);assert.equal(result.ok,true);
}
function advanceToVoting(game:SecretWordImposter,players:ReturnType<typeof addPlayers>,now=3000){
  for(const p of players){assert.equal(game.submitHint(p.userId,'Nebel',now).ok,true);assert.equal(game.publishHint('moderator',now).ok,true);now++;}
  assert.equal((game.snapshot(now) as {phase:string}).phase,'discussion');assert.equal(game.beginVote('moderator',now).ok,true);
}

test('Geheimwort-Rollen bleiben privat und das Portal-Binding gibt nur die eigene Rolle aus',()=>{
  const {store,game}=fixture(),players=addPlayers(game);beginHints(game,players);
  const imposter=players[0]!,normal=players[1]!;
  assert.deepEqual(game.privateRole(imposter.userId),{role:'imposter'});
  assert.deepEqual(game.privateRole(normal.userId),{role:'player',word:'Abenteuer'});
  assert.equal(game.privateRole('unbeteiligter-user'),null);
  const snapshot=JSON.stringify(game.snapshot());assert.doesNotMatch(snapshot,/Abenteuer|imposter_id|user_id|viewer-0|role/u);
  assert.equal((game.snapshot() as {players:Array<unknown>}).players.length,3);
  assert.equal(game.viewerState(normal.userId).isParticipant,true);assert.equal(game.viewerState('unbeteiligter-user').isParticipant,false);
  store.close();
});

test('Hinweise werden einzeln eingereicht, direktes Wort wird abgewiesen und erst nach Freigabe öffentlich',()=>{
  const {store,game}=fixture(),players=addPlayers(game);beginHints(game,players,1000);
  assert.equal(game.submitHint(players[0]!.userId,'Abenteuer',1010).ok,false);
  assert.equal(game.submitHint(players[0]!.userId,'Nebel',1010).ok,true);
  assert.equal(game.submitHint(players[0]!.userId,'Regen',1011).ok,false);
  assert.deepEqual((game.snapshot() as {hints:unknown[]}).hints,[]);
  assert.equal((game.moderationSnapshot().pendingHint as {hint:string}).hint,'Nebel');
  assert.equal(game.publishHint('moderator',1012).ok,true);
  assert.deepEqual((game.snapshot() as {hints:Array<{text:string}>}).hints.map(x=>x.text),['Nebel']);
  assert.equal(game.viewerState(players[1]!.userId).isTurn,true);
  store.close();
});

test('Timeout überspringt den Hinweiszug, wechselt nach der Diskussion automatisch in die Abstimmung',()=>{
  const {store,game}=fixture(),players=addPlayers(game);beginHints(game,players,1000);
  assert.equal(game.tickMessages(6002).length,1);
  assert.equal((game.snapshot(6002) as {hintTurn:{turn:number}}).hintTurn.turn,2);
  for(const p of players.slice(1)){game.submitHint(p.userId,'Nebel',6003);game.publishHint('moderator',6004);}
  assert.equal((game.snapshot(6005) as {phase:string}).phase,'discussion');
  assert.equal(game.tickMessages(16_005).length,1);
  assert.equal((game.snapshot(16_005) as {phase:string}).phase,'voting');
  store.close();
});

test('Anmeldungs-Timeout verteilt Rollen automatisch und bricht bei zu wenigen Teilnehmenden ab',()=>{
  const first=fixture(),players=addPlayers(first.game);
  first.game.start('broadcaster',1000);for(const p of players)first.game.join(p,1001);
  assert.equal(first.game.tickMessages(11_000).length,1);
  assert.equal((first.game.snapshot(11_000) as {phase:string}).phase,'hints');
  assert.deepEqual(first.game.privateRole(players[1]!.userId),{role:'player',word:'Abenteuer'});
  first.store.close();

  const second=fixture();second.game.start('broadcaster',1000);second.game.join(players[0]!,1001);
  assert.equal(second.game.tickMessages(11_000).length,1);
  assert.equal((second.game.snapshot(11_000) as {phase:string}|null),null);
  assert.equal((second.store.miniGameQuery(db=>db.prepare("SELECT phase FROM word_imposter_rounds ORDER BY started_at DESC LIMIT 1").get()) as {phase:string}).phase,'canceled');
  second.store.close();
});

test('Geheime Abstimmung verhindert Fremde, Selbststimme und Mehrfachstimme; richtiger letzter Tipp entscheidet XP idempotent',()=>{
  const {store,game}=fixture(),players=addPlayers(game);beginHints(game,players,1000);advanceToVoting(game,players,2000);
  assert.equal(game.vote('outsider','viewer_0',2100).status,403);
  assert.equal(game.vote(players[1]!.userId,players[1]!.login,2100).ok,false);
  assert.equal(game.vote(players[1]!.userId,players[0]!.login,2101).ok,true);
  assert.equal(game.vote(players[1]!.userId,players[0]!.login,2102).ok,false);
  assert.equal(game.vote(players[2]!.userId,players[0]!.login,2103).ok,true);
  assert.equal(game.resolveVote('moderator',2104,true).ok,true);
  assert.equal((game.snapshot(2104) as {phase:string}).phase,'guess');
  assert.doesNotMatch(JSON.stringify(game.snapshot(2104)),/Abenteuer/u);
  assert.equal(game.guess(players[1]!.userId,'Abenteuer',2105).status,403);
  assert.equal(game.guess(players[0]!.userId,'Abenteuer',2106).ok,true);
  const result=(game.snapshot(2106) as {result:{guessCorrect:boolean;winningSide:string;word:string}}).result;
  assert.deepEqual(result,{word:'Abenteuer',imposterName:'Viewer 0',caught:true,tie:false,guessCorrect:true,votes:2,winningSide:'imposter',xpAwarded:30});
  const first=(store.xp('viewer-0').xp);game.resolveVote('moderator',3000,true);assert.equal(store.xp('viewer-0').xp,first);
  assert.equal((store.miniGameQuery(db=>db.prepare("SELECT COUNT(*) n FROM mini_game_awards WHERE game='word-imposter'").get()) as {n:number}).n,3);
  store.close();
});

test('Gleichstand geht an den Imposter, Vergabe wird pro Runde einmalig verbucht',()=>{
  const {store,game}=fixture(),players=addPlayers(game,4);beginHints(game,players,1000);advanceToVoting(game,players,2000);
  assert.equal(game.vote(players[1]!.userId,players[0]!.login,2200).ok,true);
  assert.equal(game.vote(players[2]!.userId,players[1]!.login,2201).ok,true);
  assert.equal(game.vote(players[3]!.userId,players[2]!.login,2202).ok,true);
  assert.equal(game.resolveVote('moderator',2300,true).ok,true);
  const result=(game.snapshot(2300) as {result:{tie:boolean;winningSide:string}}).result;assert.equal(result.tie,true);assert.equal(result.winningSide,'imposter');
  assert.equal((store.miniGameQuery(db=>db.prepare("SELECT COUNT(*) n FROM mini_game_awards WHERE game='word-imposter'").get()) as {n:number}).n,4);
  store.close();
});

test('Abstimmung endet automatisch; ein falscher oder verspäteter letzter Tipp schließt die Runde zugunsten der Community',()=>{
  for(const late of [false,true]){
    const {store,game}=fixture(),players=addPlayers(game);beginHints(game,players,1000);advanceToVoting(game,players,2000);
    game.vote(players[1]!.userId,players[0]!.login,2100);game.vote(players[2]!.userId,players[0]!.login,2101);
    assert.equal(game.tickMessages(12_004).length,1);
    assert.equal((game.snapshot(12_004) as {phase:string}).phase,'guess');
    if(late){assert.equal(game.tickMessages(17_005).length,1);}
    else assert.equal(game.guess(players[0]!.userId,'Zahnbürste',12_005).ok,true);
    const result=(game.snapshot(late?17_005:12_005) as {phase:string;result:{winningSide:string;guessCorrect:boolean}});
    assert.equal(result.phase,'results');assert.equal(result.result.winningSide,'community');assert.equal(result.result.guessCorrect,false);
    assert.equal(store.xp(players[0]!.userId).xp,5);
    store.close();
  }
});

test('Nur der aktuelle Mitspieler darf einen Hinweiszug nutzen; Stimmen nach Frist werden abgewiesen',()=>{
  const {store,game}=fixture(),players=addPlayers(game);beginHints(game,players,1000);
  assert.equal(game.submitHint('outsider','Nebel',1010).status,403);
  assert.equal(game.submitHint(players[1]!.userId,'Nebel',1010).status,403);
  advanceToVoting(game,players,2000);
  assert.equal(game.vote(players[1]!.userId,players[0]!.login,12_003).ok,false);
  assert.equal((game.snapshot(12_003) as {phase:string}).phase,'voting');
  store.close();
});

test('Aktive Geheimwort-Runde und private Rolle bleiben nach SQLite-Neustart erhalten',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'word-imposter-restart-')),file=path.join(directory,'state.sqlite'),players=[
    {userId:'viewer-0',login:'viewer_0',displayName:'Viewer 0'},{userId:'viewer-1',login:'viewer_1',displayName:'Viewer 1'},{userId:'viewer-2',login:'viewer_2',displayName:'Viewer 2'},
  ];let store=new FeatureStore(file),game=new SecretWordImposter(store,testConfig(),()=>0);
  try{
    game.updateSettings({...game.settings(),enabled:true,minPlayers:3,cooldownMs:0});game.start('broadcaster',1000);for(const player of players)game.join(player,1001);game.startRoles('broadcaster',1002);
    const role=game.privateRole('viewer-1');store.close();store=new FeatureStore(file);game=new SecretWordImposter(store,testConfig(),()=>0);
    assert.deepEqual(game.privateRole('viewer-1'),role);assert.equal((game.snapshot(1100) as {phase:string}).phase,'hints');
  }finally{try{store.close()}catch{}fs.rmSync(directory,{recursive:true,force:true});}
});
