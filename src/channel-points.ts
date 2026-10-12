import type { FeatureStore, QuestPolicy, ChannelRedemptionRecord, ChannelRedemptionStatus } from './feature-store.js';
import type { TwitchApi, TwitchCustomReward } from './twitch-api.js';
import { TwitchApiError } from './twitch-api.js';
import type { Logger } from './logger.js';
import type { TwitchOAuth } from './twitch-oauth.js';

export interface ChannelPointsSettings { enabled:boolean; rewardId:string|null; rewardTitle:string; cost:number; fulfillOnApproval:boolean; }
export const DEFAULT_CHANNEL_POINTS_SETTINGS:ChannelPointsSettings={enabled:false,rewardId:null,rewardTitle:'Quest für Jannik 🎯',cost:2000,fulfillOnApproval:true};

export class ChannelPointsService {
  constructor(private readonly store:FeatureStore,private readonly api:TwitchApi,private readonly oauth:TwitchOAuth,
    private readonly broadcasterId:string,private readonly questPolicy:()=>QuestPolicy,private readonly logger:Logger) {}
  private sessionId?:string;

  settings():ChannelPointsSettings {
    const saved=this.store.config<Partial<ChannelPointsSettings>>('channel_points_settings',{});
    return {...DEFAULT_CHANNEL_POINTS_SETTINGS,...saved};
  }
  connected():boolean { return this.oauth.hasAccessToken&&this.oauth.grantedScopes.includes('channel:manage:redemptions'); }
  get oauthStatusMessage():string {
    if(!this.oauth.hasAccessToken)return 'Noch nicht verbunden. Im Dashboard den Broadcaster-OAuth starten.';
    if(!this.oauth.grantedScopes.includes('channel:manage:redemptions'))return 'Gespeicherter Token hat channel:manage:redemptions nicht; bitte im Dashboard neu autorisieren.';
    return 'Broadcaster-OAuth mit erforderlichem Scope verfügbar.';
  }
  async manageableRewards():Promise<TwitchCustomReward[]> {
    if(!this.connected())throw new Error('Janniks Broadcaster-OAuth für Kanalpunkte ist noch nicht verbunden.');
    return this.api.getCustomRewards(this.broadcasterId,true);
  }
  async saveSettings(settings:ChannelPointsSettings):Promise<void> {
    if(settings.enabled&&(!settings.rewardId||!this.connected()))throw new Error('Zum Aktivieren müssen Broadcaster-OAuth und Reward-ID verknüpft sein.');
    this.store.setConfig('channel_points_settings',settings);
    if(settings.enabled&&settings.rewardId&&this.sessionId)await this.ensureSubscription(this.sessionId);
  }
  async createReward(cost:number):Promise<TwitchCustomReward> {
    if(!Number.isSafeInteger(cost)||cost<1||cost>1_000_000)throw new Error('Reward-Kosten müssen zwischen 1 und 1.000.000 liegen.');
    if(!this.connected())throw new Error('Janniks Broadcaster-OAuth ist noch nicht verbunden.');
    const rewards=await this.api.getCustomRewards(this.broadcasterId,false),title='Quest für Jannik 🎯';
    const existing=rewards.find((reward)=>reward.title.toLocaleLowerCase('de-DE')===title.toLocaleLowerCase('de-DE'));
    if(existing)throw new Error(`Eine verwaltbare Belohnung mit diesem Namen existiert bereits (ID ${existing.id}); bitte auswählen statt erneut erstellen.`);
    const reward=await this.api.createCustomReward(this.broadcasterId,{title,prompt:'Beschreibe deine Quest-Idee (max. 180 Zeichen).',cost});
    await this.saveSettings({...this.settings(),rewardId:reward.id,rewardTitle:reward.title,cost:reward.cost});
    return reward;
  }
  async selectReward(rewardId:string):Promise<TwitchCustomReward> {
    const reward=(await this.manageableRewards()).find((candidate)=>candidate.id===rewardId);
    if(!reward)throw new Error('Belohnung ist nicht vorhanden oder diese Twitch-App darf sie nicht verwalten.');
    if(!reward.is_user_input_required)throw new Error('Die ausgewählte Belohnung verlangt keine Texteingabe.');
    if(!reward.is_enabled||reward.should_redemptions_skip_request_queue)throw new Error('Reward muss aktiviert sein und Einlösungen zur manuellen Bearbeitung in der Twitch-Warteschlange lassen.');
    await this.saveSettings({...this.settings(),rewardId:reward.id,rewardTitle:reward.title,cost:reward.cost});
    return reward;
  }
  async ensureSubscription(sessionId:string):Promise<void> {
    this.sessionId=sessionId;
    const settings=this.settings();if(!settings.enabled||!settings.rewardId)return;
    if(!this.connected()){this.store.setConfig('channel_points_settings',{...settings,enabled:false});this.logger.warn('Kanalpunkte deaktiviert: Broadcaster-OAuth oder erforderlicher Scope fehlt.');return;}
    try{await this.api.ensureChannelPointsSubscription(sessionId,this.broadcasterId,settings.rewardId);}
    catch(error){
      if(error instanceof TwitchApiError&&(error.status===401||error.status===403)){
        this.store.setConfig('channel_points_settings',{...settings,enabled:false});
        this.logger.error('Kanalpunkte deaktiviert: Twitch verweigert Broadcaster-/Reward-Zugriff.',{status:error.status});
      }
      throw error;
    }
    await this.reconcile();
  }
  async reconcile():Promise<void> {
    const settings=this.settings();if(!settings.enabled||!settings.rewardId||!this.connected())return;
    try{
      const redemptions=await this.api.getUnfulfilledRedemptions(this.broadcasterId,settings.rewardId);
      for(const redemption of redemptions){
        await this.acceptEventSub({metadata:{message_type:'notification'},payload:{subscription:{type:'channel.channel_points_custom_reward_redemption.add',
          condition:{broadcaster_user_id:this.broadcasterId,reward_id:settings.rewardId}},event:{...redemption,user_login:redemption.user_name,
          broadcaster_user_id:redemption.broadcaster_id,status:'unfulfilled',reward:redemption.reward}}});
      }
    }catch(error){this.logger.warn('Twitch-Reconciliation der offenen Kanalpunkte-Einlösungen fehlgeschlagen.',{error:error instanceof Error?error.message:'unbekannt'});}
    for(const record of this.store.channelRedemptions(500)){
      const shouldRecover=record.status==='fulfillment_pending'||record.status==='cancel_pending'
        ||(record.status==='pending'&&(record.questStatus==='rejected'||(record.questStatus==='approved'&&settings.fulfillOnApproval)));
      if(shouldRecover)try{await this.retry(record.redemptionId);}
      catch(error){this.logger.warn('Gespeicherte Kanalpunkte-Statusaktion bleibt zur Klärung offen.',{redemptionId:record.redemptionId,error:error instanceof Error?error.message:'unbekannt'});}
    }
  }
  async acceptEventSub(message:Record<string,unknown>):Promise<void> {
    const metadata=message.metadata as Record<string,unknown>|undefined;
    const payload=message.payload as Record<string,unknown>|undefined;
    const subscription=payload?.subscription as Record<string,unknown>|undefined;
    const condition=subscription?.condition as Record<string,unknown>|undefined;
    const event=payload?.event as Record<string,unknown>|undefined;
    const settings=this.settings();
    if(metadata?.message_type!=='notification'||subscription?.type!=='channel.channel_points_custom_reward_redemption.add'||!event)throw new Error('Unbekanntes EventSub-Redemption-Format.');
    const reward=event.reward as Record<string,unknown>|undefined;
    const redemptionId=String(event.id||''),rewardId=String(reward?.id||''),broadcasterId=String(event.broadcaster_user_id||'');
    if(!settings.enabled||!settings.rewardId||!redemptionId||broadcasterId!==this.broadcasterId
      ||String(condition?.broadcaster_user_id||'')!==this.broadcasterId||rewardId!==settings.rewardId
      ||(condition?.reward_id&&String(condition.reward_id)!==settings.rewardId)) { this.logger.warn('Nicht passende Kanalpunkte-Einlösung verworfen.');return; }
    if(event.status!=='unfulfilled')return;
    const userId=String(event.user_id||''),displayName=String(event.user_name||event.user_login||''),userInput=String(event.user_input||'').normalize('NFC').trim();
    const timestamp=Date.parse(String(event.redeemed_at||''));
    if(!userId||!displayName||!Number.isFinite(timestamp)||!safeInput(userInput,this.questPolicy().maxLength)) {
      this.store.recordManualChannelRedemption({redemptionId,rewardId,userId,displayName:clean(displayName||'Unbekannt',48),userInput,
        redeemedAt:Number.isFinite(timestamp)?timestamp:Date.now()},'Eingabe oder Redemption-Felder ungültig; manuelle Prüfung erforderlich.',Date.now());
      this.logger.warn('Kanalpunkte-Einlösung hat ungültige Eingaben; wird nicht automatisch veröffentlicht.',{redemptionId});return;
    }
    const result=this.store.acceptChannelRedemption({redemptionId,rewardId,userId,displayName:clean(displayName,48),userInput,redeemedAt:timestamp},this.questPolicy(),Date.now());
    if(result.duplicate){this.logger.info('Doppelte Kanalpunkte-Einlösung ignoriert.',{redemptionId});return;}
    if(!result.result.ok)this.logger.warn('Kanalpunkte-Einlösung gespeichert, aber Questannahme benötigt Klärung.',{redemptionId,reason:result.result.reason});
  }
  async resolveQuest(questId:string,target:'approved'|'rejected'):Promise<void> {
    const redemption=this.store.channelRedemptionForQuest(questId);if(!redemption)return;
    if((target==='approved'&&redemption.status==='fulfilled')||(target==='rejected'&&redemption.status==='canceled'))return;
    const fulfill=target==='approved'&&this.settings().fulfillOnApproval;
    if(target==='approved'&&!fulfill)return;
    await this.resolveRedemption(redemption,fulfill?'FULFILLED':'CANCELED',fulfill?'fulfilled':'canceled');
  }
  async retry(redemptionId:string):Promise<void> {
    const record=this.store.channelRedemption(redemptionId);if(!record)throw new Error('Einlösung nicht gefunden.');
    if(record.status==='failed'&&!record.questId){
      const retried=this.store.retryChannelRedemption(redemptionId,this.questPolicy(),Date.now());
      if(!retried)throw new Error('Questannahme ist nicht wiederholbar.');
      if(!retried.ok)throw new Error(`Questannahme weiterhin nicht möglich: ${retried.reason}`);
      return;
    }
    if(record.status==='fulfillment_pending')return this.resolveRedemption(record,'FULFILLED','fulfilled');
    if(record.status==='cancel_pending')return this.resolveRedemption(record,'CANCELED','canceled');
    if(record.questId&&['pending','manual'].includes(record.status)){
      const quest=this.store.quest(record.questId);
      if(quest?.status==='approved')return this.resolveRedemption(record,'FULFILLED','fulfilled');
      if(quest?.status==='rejected')return this.resolveRedemption(record,'CANCELED','canceled');
    }
    throw new Error('Dieser Einlösungsfall benötigt keine automatische Wiederholung.');
  }
  private async resolveRedemption(record:ChannelRedemptionRecord,target:'FULFILLED'|'CANCELED',success:ChannelRedemptionStatus):Promise<void> {
    const pending=target==='FULFILLED'?'fulfillment_pending':'cancel_pending';
    this.store.updateChannelRedemption(record.redemptionId,pending,null,Date.now());
    try {
      const current=await this.api.getRedemption(this.broadcasterId,record.rewardId,record.redemptionId);
      if(!current){this.store.updateChannelRedemption(record.redemptionId,'manual','Twitch meldet diese Einlösung nicht (mehr); Status bitte im Twitch-Dashboard prüfen.',Date.now());return;}
      if(current.broadcaster_id!==this.broadcasterId||current.reward.id!==record.rewardId){
        this.store.updateChannelRedemption(record.redemptionId,'manual','Twitch-Einlösung passt nicht zu Kanal/Reward; keine Statusänderung ausgeführt.',Date.now());return;
      }
      if(current.status===target){this.store.updateChannelRedemption(record.redemptionId,success,null,Date.now());return;}
      if(current.status!=='UNFULFILLED'){
        this.store.updateChannelRedemption(record.redemptionId,'manual',`Twitch-Status ist ${current.status}; bitte manuell abgleichen.`,Date.now());return;
      }
      await this.api.setRedemptionStatus(this.broadcasterId,record.rewardId,record.redemptionId,target);
      this.store.updateChannelRedemption(record.redemptionId,success,null,Date.now());
    } catch(error) {
      const detail=error instanceof TwitchApiError?`Twitch HTTP ${error.status}${error.retryAfterMs?`; Retry nach ${Math.ceil(error.retryAfterMs/1000)}s`:''}`:error instanceof Error?error.message:'Unbekannter Twitch-Fehler';
      const status=error instanceof TwitchApiError&&error.status===403?'manual':pending;
      const message=status==='manual'?'Twitch verweigert die Statusänderung (403). Diese App darf den Reward vermutlich nicht verwalten; keine Erstattung versprochen. Bitte Status und Rückerstattung im Twitch-Dashboard prüfen.':detail;
      this.store.updateChannelRedemption(record.redemptionId,status,message,Date.now());
      this.logger.error('Kanalpunkte-Status konnte nicht bestätigt werden.',{redemptionId:record.redemptionId,error:detail});
    }
  }
}

function safeInput(value:string,max:number):boolean {
  const length=Array.from(value).length;
  return length>=3&&length<=max&&!/[\u0000-\u001F\u007F<>\u202A-\u202E\u2066-\u2069]/u.test(value)
    &&value.replace(/[\p{P}\p{S}\s]/gu,'').length>0;
}
function clean(value:string,max:number):string { return Array.from(value.replace(/[\r\n\t]/gu,' ').trim()).slice(0,max).join('')||'Unbekannt'; }
