import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from './database.js';
import { FeatureStore } from './feature-store.js';
import { CommunityFeatures, levelForXp, xpAtLevel } from './community-features.js';
import { loadConfig } from './config.js';
import { CommandHandler } from './command-handler.js';
import { GameService } from './game.js';
import type { ChatMessage } from './types.js';

function fixture(): { file: string; directory: string; close: () => void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jannik-community-'));
  const file = path.join(directory, 'bot.sqlite');
  return { file, directory, close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test('Versionierte Migration übernimmt Halloween-Punkte, Cooldown und aktiven Zustand ohne Reset', () => {
  const f = fixture();
  const legacy = new Database(f.file);
  legacy.setActive(true, 1000);
  legacy.applyPlay('twitch-1', 'Alice', 27, 2000, 900_000);
  const features = new FeatureStore(f.file);
  features.syncLegacyHalloween(3000);
  assert.equal(features.event('halloween')?.active, true);
  assert.equal(features.score('halloween', 'twitch-1'), 27);
  assert.equal(features.activeEvent()?.id, 'halloween');
  assert.equal(features.events().filter((event) => event.active).length, 1);
  features.close(); legacy.close(); f.close();
});

test('XP ist dedupliziert, Aktivitäts-XP respektiert Cooldown/Spam und Levelkurve steigt quadratisch', () => {
  const f = fixture(); const store = new FeatureStore(f.file);
  assert.equal(store.awardXp('event-1', 'u1', 'Alice', 10, 'bonus:test', 1_000_000, 100), 10);
  assert.equal(store.awardXp('event-1', 'u1', 'Alice', 10, 'bonus:test', 1_000_001, 100), 0);
  assert.equal(store.awardActivity('u2', 'Bob', 'same', 'chat-1', 1_000_000, 5, 60_000), 5);
  assert.equal(store.awardActivity('u2', 'Bob', 'same', 'chat-2', 1_000_001, 5, 60_000), 0);
  assert.equal(store.awardActivity('u2', 'Bob', 'different', 'chat-3', 1_060_001, 5, 60_000), 5);
  assert.equal(store.xpRank('not-yet-a-player'), 0);
  assert.equal(levelForXp(399), 2);
  assert.equal(levelForXp(400), 3);
  assert.equal(xpAtLevel(3), 400);
  store.close(); f.close();
});

test('First-chat welcome is opt-in, personalized, deduplicated and stores no chat text',()=>{
  const f=fixture(),store=new FeatureStore(f.file),config={...loadConfig({testMode:true}),databasePath:f.file};
  const community=new CommunityFeatures(store,config);
  const message:ChatMessage={eventId:'welcome-1',broadcasterUserId:config.broadcasterUserId,senderUserId:'new-viewer',senderLogin:'newviewer',senderDisplayName:'NewViewer',message:'private text must not be persisted',sentAt:1};
  assert.equal(community.firstChatWelcome(message,100),undefined);
  store.setConfig('first_chat_welcome',{enabled:true,message:'Willkommen, {user}!'});
  assert.equal(community.firstChatWelcome(message,200),'Willkommen, NewViewer!');
  assert.equal(community.firstChatWelcome({...message,eventId:'welcome-2'},300),undefined);
  assert.equal((store.miniGameQuery(db=>db.prepare('SELECT COUNT(*) n FROM first_chat_seen').get()) as {n:number}).n,1);
  store.close();f.close();
});

test('Events wechseln exklusiv, werden bei Ende archiviert und können wiederholt beendet werden', () => {
  const f = fixture(); const store = new FeatureStore(f.file);
  assert.equal(store.setEventActive('christmas', true, 10_000), true);
  assert.equal(store.setEventActive('easter', true, 10_001), false);
  assert.equal(store.setEventActive('christmas', false, 10_002), true);
  const archived = store.event('christmas');
  assert.equal(archived?.active, false);
  assert.equal(archived?.archivedAt, 10_002);
  assert.equal(store.setEventActive('christmas', false, 10_999), true);
  assert.equal(store.event('christmas')?.archivedAt, 10_002);
  const scheduled = store.event('christmas')!;
  store.saveEvent({ ...scheduled, active: false, startAt: 20_000, endAt: 30_000 });
  const community = new CommunityFeatures(store, { ...loadConfig({ testMode: true }), databasePath: f.file });
  community.tick(20_000);
  assert.equal(store.activeEvent()?.id, 'christmas');
  community.tick(30_000);
  assert.equal(store.activeEvent(), undefined);
  assert.equal(store.event('christmas')?.archivedAt, 30_000);
  store.close(); f.close();
});

test('Duelle verhindern Selbstduelle, lösen genau einmal zufällig auf und laufen ab', () => {
  const f = fixture(); const store = new FeatureStore(f.file);
  assert.deepEqual(store.createDuel('a', 'Alice', 'a', 'Alice', 100_000, 60_000), { ok: false, reason: 'self' });
  const created = store.createDuel('a', 'Alice', 'b', 'Bob', 100_000, 60_000);
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error('Duell wurde nicht angelegt.');
  assert.equal(store.createDuel('b', 'Bob', 'c', 'Cara', 100_001, 60_000).ok, false);
  const result = store.acceptDuel('b', 100_002, 100, 15);
  assert.equal(result.status, 'accepted');
  if (result.status === 'accepted') assert.ok(['Alice', 'Bob'].includes(result.winnerName));
  assert.notEqual(store.acceptDuel('b', 100_003, 100, 15).status, 'accepted');
  store.createDuel('c', 'Cara', 'd', 'Dan', 200_000, 1000);
  assert.equal(store.acceptDuel('d', 202_000, 100, 15).status, 'expired');
  store.close(); f.close();
});

test('Bosskampf überlebt Neustart und atomare Angriffe vergeben den Sieg nur einmal', async () => {
  const f = fixture(); let store = new FeatureStore(f.file);
  assert.equal(store.startBoss('boss-1', 'Schattenkönig', 100, 900_000, 100_000), true);
  const beforeRestart = store.attackBoss('a', 'Alice', 50, 101_000, 'hit-1', 1, 10, 5);
  assert.equal(beforeRestart.status, 'hit');
  store.close();
  store = new FeatureStore(f.file);
  assert.equal(store.activeBoss(102_000)?.hp, 50);
  const outcomes = await Promise.all([
    Promise.resolve().then(() => store.attackBoss('a', 'Alice', 30, 103_000, 'hit-2', 1, 10, 5)),
    Promise.resolve().then(() => store.attackBoss('b', 'Bob', 40, 103_001, 'hit-3', 1, 10, 5)),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'defeated').length, 1);
  assert.equal(store.activeBoss(104_000), undefined);
  assert.ok(store.xp('a').xp + store.xp('b').xp <= 28);
  store.close(); f.close();
});

test('Custom Chatbefehle sind persistent, aliasesicher und blockieren Code-/unbekannte Platzhalter', () => {
  const f = fixture(); let store = new FeatureStore(f.file);
  store.addCustomCommand({ name: 'communityhome', alias: 'homealias', response: 'Hi {user} auf {channel}', enabled: true,
    permission: 'everyone', cooldownMs: 5000, expiresAt: null, modsMayManage: false });
  assert.equal(store.customCommand('homealias', 1000)?.name, 'communityhome');
  assert.throws(() => store.addCustomCommand({ name: 'run', alias: null, response: '{process.exit()}', enabled: true,
    permission: 'everyone', cooldownMs: 0, expiresAt: null, modsMayManage: false }));
  assert.throws(() => store.addCustomCommand({ name: 'other', alias: 'homealias', response: 'Hi', enabled: true,
    permission: 'everyone', cooldownMs: 0, expiresAt: null, modsMayManage: false }));
  store.close(); store = new FeatureStore(f.file);
  assert.equal(store.customCommand('communityhome', 1000)?.response, 'Hi {user} auf {channel}');
  assert.equal(store.deleteCustomCommand('homealias'), true);
  store.close(); f.close();
});

test('Chatintegration routet Event, XP, Minispiele, Duell, Boss und Custom Commands mit Berechtigungen', async () => {
  const f = fixture(); const config = { ...loadConfig({ testMode: true }), databasePath: f.file };
  const database = new Database(f.file); const store = new FeatureStore(f.file); const game = new GameService(database, config);
  const community = new CommunityFeatures(store, config, async (login) => login === 'bob' ? { id: 'bob-id', login, displayName: 'Bob' } : undefined, (min) => min);
  const handler = new CommandHandler(database, game, config, undefined, community);
  let eventNo = 0;
  const send = async (userId: string, displayName: string, text: string, moderator = false) => {
    const msg: ChatMessage = { eventId: `integration-${++eventNo}`, broadcasterUserId: config.broadcasterUserId,
      senderUserId: userId, senderLogin: userId, senderDisplayName: displayName, message: text, sentAt: Date.now(), isModerator: moderator };
    return handler.handle(msg, 1_800_000_000_000 + eventNo);
  };
  try {
    assert.match((await send('alice', 'Alice', '!startguess'))[0]?.message || '', /Nur Jannik|Mods/u);
    assert.match((await send(config.broadcasterUserId, 'Jannik', '!startguess'))[0]?.message || '', /Zahlenrunde gestartet/u);
    assert.match((await send('alice', 'Alice', '!guess 1'))[0]?.message || '', /hat die Zahl 1 erraten/u);
    assert.match((await send('alice', 'Alice', '!8ball Wird das klappen?'))[0]?.message || '', /Auf jeden Fall/u);
    assert.match((await send('alice', 'Alice', '!rps stein'))[0]?.message || '', /Du gewinnst/u);
    assert.match((await send('alice', 'Alice', '!level @bob'))[0]?.message || '', /Bob: Level 1/u);
    assert.match((await send('alice', 'Alice', '!level @nobody'))[0]?.message || '', /wurde nicht gefunden/u);

    assert.equal(store.setEventActive('christmas', true, 1_800_000_000_000), true);
    assert.match((await send('alice', 'Alice', '!gift'))[0]?.message || '', /Geschenke|sammelt/u);
    assert.equal(store.score('christmas', 'alice'), 3);
    assert.equal(store.setEventActive('christmas', false, 1_800_000_000_100), true);

    assert.match((await send('alice', 'Alice', '!duel @bob'))[0]?.message || '', /herausgefordert/u);
    assert.match((await send('bob-id', 'Bob', '!accept'))[0]?.message || '', /gewinnt das faire Duell/u);
    assert.match((await send(config.broadcasterUserId, 'Jannik', '!startboss'))[0]?.message || '', /erscheint/u);
    assert.match((await send('alice', 'Alice', '!attack'))[0]?.message || '', /verursacht/u);
    assert.match((await send(config.broadcasterUserId, 'Jannik', '!endboss'))[0]?.message || '', /beendet/u);

    assert.match((await send('alice', 'Alice', '!addcommand socials | Hallo {user}'))[0]?.message || '', /Nur Jannik/u);
    assert.match((await send(config.broadcasterUserId, 'Jannik', '!addcommand socials | Hallo {user}'))[0]?.message || '', /ist angelegt/u);
    assert.match((await send('alice', 'Alice', '!socials'))[0]?.message || '', /Hallo Alice/u);
    store.setConfig('modules', { ...store.config<Record<string, boolean>>('modules', {}), xp: false });
    assert.equal((await send('alice', 'Alice', '!rank')).length, 0);
  } finally { store.close(); database.close(); f.close(); }
});
