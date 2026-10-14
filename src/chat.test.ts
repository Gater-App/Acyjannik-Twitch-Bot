import assert from 'node:assert/strict';
import test from 'node:test';
import { assertChatMessageLength, chatCharacterLength, clampChatMessage, parseEventSubChatMessage } from './chat.js';

test('Chatlimit zählt Unicode-Codepoints und verhindert überlange Nachrichten', () => {
  assert.equal(chatCharacterLength('🎃'), 1);
  assert.doesNotThrow(() => assertChatMessageLength('🎃'.repeat(500), 500));
  assert.throws(() => assertChatMessageLength('x'.repeat(501), 500), /überschreitet/);
  assert.equal(chatCharacterLength(clampChatMessage('x'.repeat(20), 10)), 10);
});

test('EventSub-Chatpayload wird auf User-ID und Event-ID abgebildet', () => {
  const message = parseEventSubChatMessage({
    metadata: { message_type: 'notification', message_id: 'meta-id' },
    payload: {
      subscription: { type: 'channel.chat.message' },
      event: {
        message_id: 'event-id',
        broadcaster_user_id: 'broadcaster-1',
        chatter_user_id: 'viewer-1',
        chatter_user_login: 'viewer',
        chatter_user_name: 'Viewer',
        message: { text: '!top' },
        badges: [{ set_id: 'moderator', id: '1', info: '' }],
        sent_at: '2026-10-12T12:00:00.000Z',
      },
    },
  });
  assert.equal(message.eventId, 'event-id');
  assert.equal(message.senderUserId, 'viewer-1');
  assert.equal(message.isModerator, true);
  assert.equal(message.isVip, false);
});

test('VIP-Berechtigung wird ausschließlich aus dem Twitch-EventSub-VIP-Badge übernommen', () => {
  const message = parseEventSubChatMessage({metadata:{message_type:'notification',message_id:'vip-event'},payload:{event:{message_id:'vip-event',broadcaster_user_id:'broadcaster-1',chatter_user_id:'vip-1',chatter_user_login:'vip',chatter_user_name:'VIP',message:{text:'!startguess'},badges:[{set_id:'vip',id:'1',info:''}]}}});
  assert.equal(message.isVip,true);
  assert.equal(message.isModerator,false);
});
