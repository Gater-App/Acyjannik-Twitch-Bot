import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredDiscordInvite } from './discord-invite.js';

test('finds and normalizes an invite from the configured recurring message', () => {
  assert.equal(configuredDiscordInvite(['Kommt zu uns: https://discord.gg/F7gpQ43YxB 💜']), 'https://discord.gg/F7gpQ43YxB');
  assert.equal(configuredDiscordInvite(['Server: discord.com/invite/Community-123']), 'https://discord.com/invite/Community-123');
});

test('does not guess when no invite or multiple different invites are configured', () => {
  assert.equal(configuredDiscordInvite(['Schaut im Portal vorbei.']), undefined);
  assert.equal(configuredDiscordInvite(['https://discord.gg/first', 'https://discord.gg/second']), undefined);
});

test('rejects lookalike hosts and malformed invite paths', () => {
  assert.equal(configuredDiscordInvite(['https://discord.gg.example.com/not-an-invite']), undefined);
  assert.equal(configuredDiscordInvite(['https://discord.com/other/path']), undefined);
});
