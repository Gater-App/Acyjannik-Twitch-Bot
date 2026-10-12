import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandHandler } from './command-handler.js';
import { Database } from './database.js';
import { GameService } from './game.js';
import { testConfig } from './test-config.js';
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
  assert.match(menu[0]?.message || '', /!help games/u);
  assert.ok((menu[0]?.message.length || 0) <= config.appChatMessageLength);
  const topic = await handler.handle(message(config, '!help detective', 'viewer-1'), 2_000);
  assert.match(topic[0]?.message || '', /!savequote TEXT/u);
  const denied = await handler.handle(message(config, '!help mods', 'viewer-1'), 3_000);
  assert.match(denied[0]?.message || '', /nur für Jannik/u);
  const mod = await handler.handle(message(config, '!help mods', 'mod-1', { isModerator: true }), 4_000);
  assert.match(mod[0]?.message || '', /!startimposter/u);
  const owner = await handler.handle(message(config, '!help admin'), 5_000);
  assert.match(owner[0]?.message || '', /!resethalloween CONFIRM/u);
  database.close();
});
