import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FeatureStore } from './feature-store.js';
import { CommunityTips, TIP_ACTIVITY_RULES } from './community-tips.js';
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
  pet: true, detective: true, quests: true, xp: true };

test('tips are off by default, unknown/offline streams never send, and lively requires its activity threshold', () => {
  const { tips, close } = setup();
  try {
    assert.equal(tips.settings().enabled, false);
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
