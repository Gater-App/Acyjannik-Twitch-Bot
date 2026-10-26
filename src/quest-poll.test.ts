import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { FeatureStore, type QuestPolicy } from './feature-store.js';
import { QuestPollFeatures } from './quest-poll.js';
import { testConfig } from './test-config.js';
import type { ChatMessage } from './types.js';

const policy: QuestPolicy = { maxLength: 180, queueLimit: 20, maxOpenPerUser: 2, cooldownMs: 60_000, activeDurationMs: 0, completionXp: 25 };

function chat(eventId: string, senderUserId: string, senderDisplayName: string, message: string, isModerator = false): ChatMessage {
  return { eventId, broadcasterUserId: 'broadcaster-1', senderUserId, senderLogin: senderUserId,
    senderDisplayName, message, sentAt: 1_000, isModerator };
}

test('Quest-Vorschläge bleiben privat bis zur Freigabe, beachten Cooldown/Rollen und belohnen Abschluss nur einmal', () => {
  const store = new FeatureStore(':memory:');
  const config = testConfig();
  const features = new QuestPollFeatures(store, config);
  const saved = store.config<Record<string, unknown>>('quest_settings', {});
  store.setConfig('quest_settings', { ...saved, cooldownMs: 60_000, modsCanModerate: true, modsCanSkip: true, moderatorUserIds: ['mod-1'] });
  try {
    const submitted = features.handle(chat('quest-event-1', 'alice-id', 'Alice', '!quest Gewinne die nächste Runde mit Pistolen'),
      'quest', ['Gewinne', 'die', 'nächste', 'Runde', 'mit', 'Pistolen'], 10_000);
    assert.match(submitted || '', /wartet auf Freigabe/u);
    const quest = store.lastQuestForUser('alice-id');
    assert.ok(quest);
    assert.equal(quest.status, 'pending');
    assert.match(features.handle(chat('quest-list', 'viewer-id', 'Viewer', '!quests'), 'quests', [], 10_001) || '', /1 Vorschläge warten/u);
    assert.match(features.handle(chat('quest-help', 'viewer-id', 'Viewer', '!questhelp'), 'questhelp', [], 10_001) || '', /Cooldown/u);
    assert.match(features.handle(chat('quest-mine', 'alice-id', 'Alice', '!myquest'), 'myquest', [], 10_001) || '', /wartet auf Freigabe/u);
    assert.equal(store.widgetSnapshot('quest', 10_001).visible, false, 'ungeprüfter Text darf nicht im Overlay auftauchen');

    const unsafe = features.handle(chat('quest-event-unsafe', 'mallory-id', 'Mallory', '!quest <script>alert(1)</script>'),
      'quest', ['<script>alert(1)</script>'], 10_002);
    assert.match(unsafe || '', /ohne Steuerzeichen/u);
    const cooldown = features.handle(chat('quest-event-2', 'alice-id', 'Alice', '!quest Noch eine Runde'),
      'quest', ['Noch', 'eine', 'Runde'], 10_003);
    assert.match(cooldown || '', /warte noch/u);
    const duplicateQuest = store.submitQuest({ submitterUserId: 'alice-id', displayName: 'Alice', title: quest.title,
      source: 'chat', sourceEventId: 'quest-event-1' }, policy, 10_004);
    assert.equal(duplicateQuest.ok, false);
    if (!duplicateQuest.ok) assert.equal(duplicateQuest.reason, 'duplicate');

    assert.match(features.handle(chat('skip-viewer', 'alice-id', 'Alice', '!skipquest'), 'skipquest', [], 10_005) || '', /Nur Jannik/u);
    assert.match(features.handle(chat('approve-viewer', 'alice-id', 'Alice', '!approvequest'), 'approvequest', [quest.id.slice(0, 8)], 10_006) || '', /Nur Jannik/u);
    const modQueue = features.handle(chat('queue-mod', 'mod-1', 'Mod', '!questqueue', true), 'questqueue', [], 10_006) || '';
    assert.match(modQueue, new RegExp(quest.id.slice(0, 8), 'u'));
    assert.doesNotMatch(modQueue, /Gewinne die nächste Runde/u, 'Chat-Warteschlange darf ungeprüften Vorschlagstext nicht ausgeben');
    assert.equal(store.transitionQuest(quest.id, 'active', 'broadcaster-1', 10_006, policy).ok, false,
      'pending darf nicht direkt gestartet werden');
    const redemptionQuest = store.submitQuest({ submitterUserId: 'viewer-cp', displayName: 'KanalpunkteViewer', title: 'Kanalpunkte-Challenge',
      source: 'channel_points', redemptionId: 'redemption-chat-moderation' }, policy, 10_006);
    assert.equal(redemptionQuest.ok, true);
    if (!redemptionQuest.ok) throw new Error('Kanalpunkte-Testquest wurde nicht angelegt.');
    const blockedChatModeration = features.handle(chat('approve-cp', 'broadcaster-1', 'Broadcaster', '!approvequest'), 'approvequest',
      [redemptionQuest.quest.id.slice(0, 8)], 10_006) || '';
    assert.match(blockedChatModeration, /im Dashboard moderieren/u);
    assert.equal(store.quest(redemptionQuest.quest.id)?.status, 'pending', 'Kanalpunkte-Moderation muss über den Statusabgleich im Dashboard laufen');
    assert.match(features.handle(chat('approve-mod', 'mod-1', 'Mod', '!approvequest', true), 'approvequest', [quest.id.slice(0, 8)], 10_007) || '', /freigegeben/u);
    assert.equal(store.transitionQuest(quest.id, 'active', 'broadcaster-1', 10_008, policy).ok, true);
    assert.equal((store.widgetSnapshot('quest', 10_009).quest as { title: string }).title, quest.title);
    assert.match(features.handle(chat('skip-mod', 'mod-1', 'Mod', '!skipquest', true), 'skipquest', [], 10_010) || '', /übersprungen/u);
    assert.equal(store.quest(quest.id)?.status, 'canceled');

    const second = store.submitQuest({ submitterUserId: 'bob-id', displayName: 'Bob', title: 'Spiele eine Runde ohne Schild',
      source: 'chat', sourceEventId: 'quest-event-3' }, policy, 20_000);
    assert.equal(second.ok, true);
    if (!second.ok) throw new Error('Zweite Testquest wurde nicht angelegt.');
    assert.equal(store.transitionQuest(second.quest.id, 'approved', 'broadcaster-1', 20_001, policy).ok, true);
    assert.equal(store.transitionQuest(second.quest.id, 'active', 'broadcaster-1', 20_002, policy).ok, true);
    const completed = store.transitionQuest(second.quest.id, 'completed', 'broadcaster-1', 20_003, policy);
    assert.equal(completed.ok, true);
    assert.equal(completed.ok ? completed.rewardedXp : 0, 25);
    assert.equal(store.transitionQuest(second.quest.id, 'completed', 'broadcaster-1', 20_004, policy).ok, false);
    assert.equal(store.xp('bob-id').xp, 25);
  } finally { store.close(); }
});

test('Chat-Umfragen deduplizieren Events, erlauben konfigurierte Stimmenänderung und bleiben nach Neustart erhalten', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jannik-polls-'));
  const databasePath = path.join(directory, 'data', 'bot.sqlite');
  let store = new FeatureStore(databasePath);
  try {
    const poll = store.createPoll({ type: 'chat', question: 'Was soll als Nächstes passieren?',
      options: [{ label: 'Nur Pistole' }, { label: 'Ohne Schild' }], durationMs: 10_000,
      allowVoteChange: true, createdBy: 'broadcaster-1', now: 10_000 });
    assert.ok(poll);
    store.setConfig('poll_settings', { enabled: true, durationMs: 10_000, allowVoteChange: true, ignoredUserIds: ['bot-id'] });
    const features = new QuestPollFeatures(store, testConfig());
    assert.match(features.handle(chat('poll-status', 'viewer-id', 'Viewer', '!poll'), 'poll', [], 10_050) || '', /!vote 1-2/u);
    assert.match(features.handle(chat('vote-event-1', 'alice-id', 'Alice', '!vote 1'), 'vote', ['1'], 10_100) || '', /Stimme gezählt/u);
    assert.deepEqual(store.vote(poll.id, 'alice-id', 'Alice', 1, 'vote-event-1', 10_101), { ok: false, reason: 'duplicate' });
    assert.match(features.handle(chat('vote-event-2', 'alice-id', 'Alice', '!vote 2'), 'vote', ['2'], 10_200) || '', /Stimme geändert/u);
    assert.equal(store.vote(poll.id, 'bob-id', 'Bob', 2, 'vote-event-3', 10_300).ok, true);
    assert.equal(features.handle(chat('vote-event-bot', 'bot-id', 'Bot', '!vote 1'), 'vote', ['1'], 10_400), '');
    assert.match(features.handle(chat('poll-results', 'viewer-id', 'Viewer', '!pollresults'), 'pollresults', [], 10_500) || '', /2 Stimmen/u);
    store.close();

    store = new FeatureStore(databasePath);
    assert.equal(store.activePoll(10_600)?.status, 'active', 'aktive Umfrage und Laufzeit überleben den Bot-Neustart');
    assert.equal(store.poll(poll.id)?.totalVotes, 2);
    assert.equal(store.finishExpiredPolls(20_000), 1);
    assert.equal(store.poll(poll.id)?.winnerOption, 1);
    assert.equal(store.poll(poll.id)?.options[1]?.votes, 2);
    assert.equal(store.poll(poll.id)?.status, 'ended');
    const claimed = store.claimPollResultMessages(20_000);
    assert.equal(claimed.length, 1, 'ein abgeschlossenes Poll-Ergebnis wird dauerhaft zur Chat-Zustellung eingeplant');
    assert.match(claimed[0]!.message, /ABSTIMMUNG BEENDET/u);
    assert.match(claimed[0]!.message, /Gewinner: Ohne Schild/u);
    assert.match(claimed[0]!.message, /2 Stimmen/u);
    assert.deepEqual(store.claimPollResultMessages(20_001), [], 'parallele Ticks beanspruchen dasselbe Ergebnis nicht doppelt');
    store.finishPollResultDelivery(poll.id, false, 20_002, 'simulierter Versandfehler');
    assert.deepEqual(store.claimPollResultMessages(20_003), [], 'Retry wird nicht vor seiner Backoff-Zeit versendet');
    const retried = store.claimPollResultMessages(50_002);
    assert.equal(retried.length, 1, 'fehlgeschlagene Zustellung ist nach Backoff wieder aufnehmbar');
    store.finishPollResultDelivery(poll.id, true, 50_003);
    assert.deepEqual(store.claimPollResultMessages(50_004), [], 'bestätigte Ergebnisnachricht wird nicht erneut versendet');
    const tie = store.createPoll({ type: 'chat', question: 'Gleichstandstest?', options: [{ label: 'A' }, { label: 'B' }],
      durationMs: 10_000, allowVoteChange: false, createdBy: 'broadcaster-1', now: 30_000 });
    assert.ok(tie);
    assert.equal(store.vote(tie.id, 'alice-id', 'Alice', 1, 'tie-vote-a', 30_100).ok, true);
    assert.equal(store.vote(tie.id, 'bob-id', 'Bob', 2, 'tie-vote-b', 30_200).ok, true);
    const blockedChange = store.vote(tie.id, 'alice-id', 'Alice', 2, 'tie-vote-a2', 30_300);
    assert.equal(blockedChange.ok, false);
    if (!blockedChange.ok) assert.equal(blockedChange.reason, 'already-voted');
    assert.equal(store.finishExpiredPolls(40_000), 1);
    assert.equal(store.poll(tie.id)?.tied, true);
    assert.equal(store.poll(tie.id)?.winnerOption, null);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Quest-Abstimmung markiert nur den Gewinner, löscht eine alte Auswahl und startet nie automatisch', () => {
  const store = new FeatureStore(':memory:');
  try {
    const first = store.submitQuest({ submitterUserId: 'alice', displayName: 'Alice', title: 'Erste freigegebene Aufgabe', source: 'chat' }, policy, 1_000);
    const second = store.submitQuest({ submitterUserId: 'bob', displayName: 'Bob', title: 'Zweite freigegebene Aufgabe', source: 'chat' }, policy, 1_000);
    assert.equal(first.ok, true); assert.equal(second.ok, true);
    if (!first.ok || !second.ok) throw new Error('Testquests konnten nicht angelegt werden.');
    store.transitionQuest(first.quest.id, 'approved', 'broadcaster-1', 1_001, policy);
    store.transitionQuest(second.quest.id, 'approved', 'broadcaster-1', 1_001, policy);
    assert.equal(store.selectNextQuest(first.quest.id, 'broadcaster-1', 1_002), true);
    const poll = store.createPoll({ type: 'quest', question: 'Welche Aufgabe?', options: [
      { label: first.quest.title, questId: first.quest.id }, { label: second.quest.title, questId: second.quest.id },
    ], durationMs: 10_000, allowVoteChange: true, createdBy: 'broadcaster-1', now: 2_000 });
    assert.ok(poll);
    assert.equal(store.vote(poll.id, 'viewer', 'Viewer', 2, 'quest-vote', 2_100).ok, true);
    store.finishExpiredPolls(12_000);
    assert.equal(store.poll(poll.id)?.winnerOption, 1);
    assert.equal(store.quest(first.quest.id)?.queuedNext, false);
    assert.equal(store.quest(second.quest.id)?.queuedNext, true);
    assert.equal(store.activeQuest(), undefined, 'Umfrageende darf keine Quest starten');
    assert.equal(store.transitionQuest(second.quest.id, 'active', 'broadcaster-1', 12_001, policy).ok, true,
      'Streamer kann den Gewinner anschließend ausdrücklich starten');
  } finally { store.close(); }
});

test('SQLite-Migration sichert die vorherige Datenbank und erhält Halloween-Punkte', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jannik-feature-migration-'));
  const databasePath = path.join(directory, 'data', 'bot.sqlite');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  let store = new FeatureStore(databasePath);
  store.setEventActive('halloween', true, 1_000);
  store.playEvent('halloween', 'viewer-1', 'Viewer', 7, 1_001);
  store.close();
  try {
    const raw = new BetterSqlite3(databasePath);
    raw.pragma('foreign_keys = OFF');
    raw.exec(`DROP TABLE poll_vote_events; DROP TABLE poll_votes; DROP TABLE polls; DROP TABLE widget_tokens;
      DROP TABLE detective_guesses; DROP TABLE detective_rounds; DROP TABLE detective_quotes; DROP TABLE mini_game_awards; DROP TABLE mini_game_consent;
      DROP TABLE imposter_votes; DROP TABLE imposter_players; DROP TABLE imposter_rounds;
      DROP TABLE quest_cooldowns; DROP TABLE quests;
      DELETE FROM feature_config WHERE key IN ('quest_settings','poll_settings','widget_settings');
      UPDATE feature_config SET value='{"xp":true}' WHERE key='modules';
      DROP TABLE channel_point_redemptions; DROP TABLE song_requests;
      DELETE FROM feature_config WHERE key IN ('channel_points_settings','song_request_settings');
      DELETE FROM schema_migrations WHERE version>=4;`);
    raw.close();
    const before = fs.readdirSync(path.join(directory, 'backups')).length;
    store = new FeatureStore(databasePath);
    assert.equal(store.score('halloween', 'viewer-1'), 7);
    store.close();
    const backups = fs.readdirSync(path.join(directory, 'backups'));
    assert.equal(backups.length, before + 45, 'v4–v48 werden jeweils vor der Schemaänderung gesichert');
    const migrationV4 = backups.find((name) => name.includes('migration-v4-'))!;
    const newest = path.join(directory, 'backups', migrationV4);
    assert.equal(fs.statSync(newest).mode & 0o777, 0o600);
    const backup = new BetterSqlite3(newest, { readonly: true });
    assert.equal((backup.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='channel_point_redemptions'").get() as { n: number }).n, 0);
    backup.close();
  } finally {
    try { store.close(); } catch { /* A prior assertion may already have closed the connection. */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
