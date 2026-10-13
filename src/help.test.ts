import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_HELP_AVAILABILITY, helpReply, type HelpAvailability } from './help.js';
import type { ChatMessage } from './types.js';

const viewer:ChatMessage={eventId:'e',broadcasterUserId:'owner',senderUserId:'viewer',senderLogin:'viewer',senderDisplayName:'Viewer',message:'!help',sentAt:1};
const active:HelpAvailability={...DEFAULT_HELP_AVAILABILITY,xp:true,events:true,activeEventName:'Weihnachten',activeEventCommand:'gift',pet:true,drops:true,wheel:true,imposter:true,detective:true,quests:true,spark:true,eightBall:true,rps:true,guess:true,duels:true};

test('Chat-Hilfe ist knapp, Aliase funktionieren und nennen nur aktivierte Funktionen',()=>{
  assert.match(helpReply([],viewer,active),/!help spiele.*!help events.*!help xp.*twitch\.gater-app\.de\/hilfe/u);
  assert.equal(helpReply(['games'],viewer,active),helpReply(['spiele'],viewer,active));
  assert.match(helpReply(['drops'],viewer,active),/!claim/u);
  assert.match(helpReply(['wheel'],viewer,active),/!wheel/u);
  assert.match(helpReply(['imposter'],viewer,active),/!joinimposter/u);
  assert.match(helpReply(['events'],viewer,active),/Weihnachten.*!gift/u);
  assert.match(helpReply(['ostern'],viewer,{...active,seasonalEvents:[{id:'easter',name:'Ostern',command:'egghunt',active:true}]}),/Ostern läuft.*!egghunt/u);
  assert.ok(helpReply(['spiele'],viewer,active).length<250);
  assert.match(helpReply(['drop'],viewer,{...active,drops:false}),/deaktiviert/u);
});

test('Moderatorhilfe nutzt kurze Unterkategorien und bewahrt Rollenprüfung',()=>{
  assert.match(helpReply(['mods'],{...viewer,isModerator:true},active),/!help mods spiele.*community.*events/u);
  assert.match(helpReply(['mods','events'],{...viewer,isModerator:true},active),/!startevent.*!endevent/u);
  assert.match(helpReply(['mods','events'],viewer,active),/nur für Jannick/u);
  assert.ok(helpReply(['mods','spiele'],{...viewer,isModerator:true},active).length<300);
});
