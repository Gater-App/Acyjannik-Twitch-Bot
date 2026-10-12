import { FeatureStore } from './feature-store.js';
import { MiniGames } from './mini-games.js';
import { testConfig } from './test-config.js';
import type { ChatMessage } from './types.js';

const store=new FeatureStore(':memory:');
const games=new MiniGames(store,testConfig(),()=>0);
games.updateSettings({...games.settings(),enabled:true,imposter:{...games.settings().imposter,minPlayers:4,maxPlayers:8,registrationMs:30_000,playMs:30_000,votingMs:10_000,cooldownMs:0},detective:{...games.settings().detective,roundMs:10_000}});
const synthetic=(id:string,name:string,text=''):ChatMessage=>({eventId:`demo-${id}-${Math.random()}`,broadcasterUserId:'broadcaster-1',senderUserId:id,senderLogin:id,senderDisplayName:name,message:text,sentAt:Date.now()});
try{
  console.log('Lokale Demo – ausschließlich synthetische Daten; keine Twitch-Verbindung.');
  console.log(games.startImposter('broadcaster-1',100));
  for(let i=1;i<=4;i++)console.log(games.join(synthetic(`viewer-${i}`,`Viewer${i}`),101+i));
  console.log(games.startRoles('broadcaster-1',110));
  const role=games.roleFor('viewer-1');console.log('Private Demo-Rollenansicht Viewer1:',role?.role==='imposter'?'IMPOSTER':`Regel: ${role?.rule}`);
  console.log('Öffentliches OBS-Snapshot während der Runde:',JSON.stringify(store.widgetSnapshot('imposter',111)));
  console.log(games.beginVote(120));
  for(let i=2;i<=4;i++)console.log(games.vote(synthetic(`viewer-${i}`,`Viewer${i}`),'@Viewer1',121+i));
  console.log(games.finishImposter(20_000));

  console.log(games.quoteOptIn('quote-author',30_000));
  console.log(games.saveQuote(synthetic('quote-author','ZitatGast','Mein Internet hat mich schon wieder verraten!'),'Mein Internet hat mich schon wieder verraten!',30_001));
  const quote=(games.pendingQuotes() as Array<{id:string}>)[0];if(!quote)throw Error('Demo-Zitat fehlt.');
  games.moderateQuote(quote.id,'approved',30_002);games.tick(32_001);console.log(games.startDetective(32_003));
  console.log(games.guess(synthetic('guesser','Rater'),'@ZitatGast',32_004));console.log(games.finishDetective(43_000));
  console.log('XP (synthetisch): Viewer2 =',store.xp('viewer-2').xp,'· Rater =',store.xp('guesser').xp);
}finally{store.close();}
