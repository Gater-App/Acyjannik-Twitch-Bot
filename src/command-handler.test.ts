import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CommandHandler } from './command-handler.js';
import { Database } from './database.js';
import { GameService } from './game.js';
import { CommunityFeatures } from './community-features.js';
import { FeatureStore } from './feature-store.js';
import { testConfig } from './test-config.js';
import { parseEventSubChatMessage } from './chat.js';
import type { AppConfig, ChatMessage } from './types.js';

function message(config: AppConfig, text: string, senderUserId = config.broadcasterUserId, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    eventId: `event-${Math.random()}`,
    messageId: `message-${Math.random()}`,
    broadcasterUserId: config.broadcasterUserId,
    senderUserId,
    senderLogin: senderUserId,
    senderDisplayName: senderUserId === config.broadcasterUserId ? 'Jannik' : 'Viewer',
    message: text,
    sentAt: Date.now(),
    ...(senderUserId === config.broadcasterUserId ? { isModerator: true } : {}),
    ...overrides,
  };
}

function setup(configOverrides: Partial<AppConfig> = {}) {
  const config = testConfig(configOverrides);
  const database = new Database(':memory:', config.activeOnStart);
  const game = new GameService(database, config, () => 0);
  const handler = new CommandHandler(database, game, config, async () => undefined);
  return { config, database, game, handler };
}

test('Befehle sind case-insensitive und doppelte EventSub-Events zählen nicht doppelt', async () => {
  const { config, database, handler } = setup();
  const first = message(config, '!TrIcKoRtReAt', 'viewer-1', { senderDisplayName: 'Ada' });
  const reply = await handler.handle(first, 1_000);
  assert.equal(reply.length, 1);
  assert.match(reply[0]?.message || '', /Ada/);
  const duplicate = await handler.handle(first, 1_001);
  assert.deepEqual(duplicate, []);
  database.close();
});

test('Rangliste und eigener Punktestand werden kompakt ausgegeben', async () => {
  const { config, database, handler } = setup();
  await handler.handle(message(config, '!trickortreat', 'viewer-1', { senderDisplayName: 'Ada' }), 1_000);
  const own = await handler.handle(message(config, '!pumpkins', 'viewer-1'), 2_000);
  assert.match(own[0]?.message || '', /Viewer hat 5 Kürbisse/);
  const top = await handler.handle(message(config, '!TOP', 'viewer-1'), 3_000);
  assert.match(top[0]?.message || '', /Top 10/);
  database.close();
});

test('Spukhaus zählt nur angenommene !trickortreat-Runden und bewahrt bestehende Kürbiswerte', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'acy-haunted-command-')),file=path.join(dir,'bot.sqlite'),config=testConfig({activeOnStart:true});
  const database=new Database(file,true),store=new FeatureStore(file),community=new CommunityFeatures(store,config),game=new GameService(database,config,()=>0),handler=new CommandHandler(database,game,config,async()=>undefined,community);
  try{
    const accepted=message(config,'!trickortreat','haunted-viewer',{eventId:'haunted-accepted'});
    const response=await handler.handle(accepted,10_000);assert.equal(response.length,1);
    assert.equal(community.hauntedHouse.snapshot('haunted-viewer',10_000).progress,1);
    const pumpkins=game.pumpkins('haunted-viewer');assert.equal(pumpkins,5);
    assert.deepEqual(await handler.handle(accepted,10_001),[],'Doppelte EventSub-Nachricht bleibt wirkungslos');
    const cooldown=message(config,'!trickortreat','haunted-viewer',{eventId:'haunted-cooldown'});
    await handler.handle(cooldown,10_002);
    assert.equal(community.hauntedHouse.snapshot('haunted-viewer',10_002).progress,1,'Cooldown-Runden tragen nicht bei');
    assert.equal(game.pumpkins('haunted-viewer'),pumpkins,'Bestehende Kürbispunkte bleiben konsistent');
  }finally{store.close();database.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('Start/Ende und Moderationsrechte werden geprüft', async () => {
  const { config, database, handler, game } = setup({ activeOnStart: false });
  const denied = await handler.handle(message(config, '!startHalloween', 'viewer-1'), 1_000);
  assert.match(denied[0]?.message || '', /autorisierte Mods/);
  const mod = await handler.handle(message(config, '!startHalloween', 'mod-1', { isModerator: true }), 2_000);
  assert.equal(game.active, true);
  assert.match(mod[0]?.message || '', /gestartet/);
  const ended = await handler.handle(message(config, '!endHalloween', 'mod-1', { isModerator: true }), 3_000);
  assert.match(ended[0]?.message || '', /beendet/);
  database.close();
});

test('Reset verlangt Bestätigung, erstellt Backup und löscht keine Datenbankdatei', async () => {
  const { config, database, handler } = setup();
  await handler.handle(message(config, '!trickortreat', 'viewer-1'), 1_000);
  let backupCalled = false;
  const handlerWithBackup = new CommandHandler(database, new GameService(database, config, () => 0), config, async () => { backupCalled = true; });
  const request = await handlerWithBackup.handle(message(config, '!resetHalloween'), 2_000);
  assert.match(request[0]?.message || '', /CONFIRM/);
  const done = await handlerWithBackup.handle(message(config, '!resetHalloween CONFIRM'), 2_001);
  assert.equal(backupCalled, true);
  assert.match(done[0]?.message || '', /zurückgesetzt/);
  assert.equal(database.getPlayer('viewer-1').pumpkins, 0);
  database.close();
});

test('Bot-Nachrichten und fremde Channels werden ignoriert', async () => {
  const { config, database, handler } = setup();
  assert.deepEqual(await handler.handle(message(config, '!top', config.botUserId)), []);
  assert.deepEqual(await handler.handle(message(config, '!top', 'viewer-1', { broadcasterUserId: 'other-channel' })), []);
  database.close();
});

test('!help bietet kurze Themenhilfe und schützt die Admin-Übersicht', async () => {
  const { config, database, handler } = setup({ appChatMessageLength: 450 });
  const menu = await handler.handle(message(config, '!help', 'viewer-1'), 1_000);
  assert.match(menu[0]?.message || '', /!help spiele/u);
  assert.match(menu[0]?.message || '', /https:\/\/twitch\.gater-app\.de\/hilfe/u);
  assert.match(menu[0]?.message || '', /https:\/\/twitch\.gater-app\.de\/community/u);
  const pet = await handler.handle(message(config, '!help pet', 'viewer-2'), 1_001);
  assert.equal(pet[0]?.category,'pet');
  assert.equal(menu[0]?.category,'help');
  assert.ok((menu[0]?.message.length || 0) <= config.appChatMessageLength);
  assert.deepEqual(await handler.handle(message(config, '!help games', 'viewer-1'),1_100),[],'kurzer Cooldown bremst wiederholte Hilfe');
  const topic = await handler.handle(message(config, '!help detective', 'viewer-1'), 7_000);
  assert.match(topic[0]?.message || '', /derzeit deaktiviert/u);
  const denied = await handler.handle(message(config, '!help mods', 'viewer-1'), 13_000);
  assert.match(denied[0]?.message || '', /nur für Jannik/u);
  const mod = await handler.handle(message(config, '!help mods spiele', 'mod-1', { isModerator: true }), 14_000);
  assert.match(mod[0]?.message || '', /!startimposter/u);
  const owner = await handler.handle(message(config, '!help admin'), 19_000);
  assert.match(owner[0]?.message || '', /Dashboard/u);
  assert.ok((owner[0]?.message.length||0)<200);
  const portal=await handler.handle(message(config,'!community','viewer-3'),20_000);
  assert.equal(portal[0]?.category,'communityPortal');
  assert.match(portal[0]?.message||'',/XP und Level.*Elio.*Quest-Ideen.*Imposter/u);
  assert.match(portal[0]?.message||'',/https:\/\/twitch\.gater-app\.de\/community/u);
  assert.deepEqual(await handler.handle(message(config,'!help community','viewer-3'),20_001),[],'Community-Befehl und Hilfe teilen Cooldown und verhindern doppelte Links');
  assert.match((await handler.handle(message(config,'!help community','viewer-3'),26_000))[0]?.message||'',/\/community/u);
  database.close();
});

test('echter verschachtelter Twitch-EventSub-Frame erreicht !help und wird dedupliziert', async () => {
  const { config, database, handler } = setup();
  const event = {
    metadata: { message_type: 'notification', message_id: 'meta-help-1' },
    payload: {
      subscription: { type: 'channel.chat.message' },
      event: {
        message_id: 'event-help-1',
        broadcaster_user_id: config.broadcasterUserId,
        chatter_user_id: 'viewer-live',
        chatter_user_login: 'viewer',
        chatter_user_name: 'Viewer',
        message: { text: '!help' },
        badges: [],
        sent_at: '2026-10-13T19:00:00.000Z',
      },
    },
  };
  const parsed = parseEventSubChatMessage(event);
  assert.equal(parsed.broadcasterUserId, config.broadcasterUserId);
  assert.equal(parsed.senderUserId, 'viewer-live');
  const replies = await handler.handle(parsed, 1_000);
  assert.equal(replies.length, 1);
  assert.match(replies[0]?.message || '', /!help spiele/u);
  assert.deepEqual(await handler.handle(parsed, 1_001), [], 'redelivery of the same Twitch event is ignored');
  database.close();
});
