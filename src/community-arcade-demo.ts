import { FeatureStore } from './feature-store.js';
import { CommunityArcade } from './community-arcade.js';
import type { ChatMessage } from './types.js';

const store=new FeatureStore(':memory:');
const arcade=new CommunityArcade(store,'broadcaster');
arcade.updateSettings({...arcade.settings(),petEnabled:true,dropsEnabled:true,wheelEnabled:true,dropDurationMs:5000});
function m(user:string,id:string):ChatMessage{return {eventId:id,messageId:id,broadcasterUserId:'broadcaster',senderUserId:user,senderLogin:user,senderDisplayName:user,message:'!feed',sentAt:Date.now(),isModerator:false};}
try {
  console.log('Lokale Arcade-Demo: ausschließlich synthetische Chat-Events, keine Twitch-Verbindung.');
  console.log(arcade.handle(m('viewer-1','feed-1'),'feed',[],1000));
  console.log('Pet-OBS:',JSON.stringify(arcade.snapshot('pet',1001)));
  console.log(arcade.startDropAdmin('broadcaster','rare',2000));
  console.log(arcade.handle(m('viewer-1','claim-1'),'claim',[],2500));
  console.log(arcade.handle(m('viewer-2','claim-2'),'claim',[],2600));
  console.log('Drop-Auflösung:',arcade.tick(7001).join(' '));
  console.log(arcade.spinAdmin('broadcaster',8000));
  console.log('Wheel-OBS:',JSON.stringify(arcade.snapshot('wheel',8001)));
} finally {store.close();}
