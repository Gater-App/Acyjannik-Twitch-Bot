import type { Logger } from './logger.js';
import type { TwitchOAuth } from './twitch-oauth.js';

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
}

export interface SendChatResult {
  messageId: string;
  isSent: boolean;
  dropReason?: string;
}

interface HelixResponse<T> { data: T[]; }
export interface TwitchCustomReward {
  id:string; broadcaster_id:string; title:string; prompt:string; cost:number; is_user_input_required:boolean;
  should_redemptions_skip_request_queue:boolean; is_enabled:boolean;
}
export interface TwitchRedemption { id:string; broadcaster_id:string; user_id:string; user_name:string; user_input:string; redeemed_at:string;
  status:'UNFULFILLED'|'FULFILLED'|'CANCELED'; reward:{id:string;title:string;cost:number;prompt:string}; }
interface HelixPagedResponse<T>{data:T[];pagination?:{cursor?:string};}

export class TwitchApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryAfterMs?: number) {
    super(message);
    this.name = 'TwitchApiError';
  }
}

export class TwitchApi {
  constructor(
    private readonly clientId: string,
    private readonly oauth: TwitchOAuth,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly logger: Logger = consoleLogger,
  ) {}

  async getUsers(logins: string[]): Promise<TwitchUser[]> {
    const query = logins.map((login) => `login=${encodeURIComponent(login)}`).join('&');
    const response = await this.request<HelixResponse<TwitchUser>>(`/users?${query}`);
    return response.data;
  }

  async sendChatMessage(broadcasterId: string, senderId: string, message: string, replyParentMessageId?: string): Promise<SendChatResult> {
    const body: Record<string, string> = { broadcaster_id: broadcasterId, sender_id: senderId, message };
    if (replyParentMessageId) body.reply_parent_message_id = replyParentMessageId;
    const response = await this.request<HelixResponse<{ message_id: string; is_sent: boolean; drop_reason?: { code: string; message: string } | null }>>(
      '/chat/messages', { method: 'POST', body: JSON.stringify(body) },
    );
    const result = response.data[0];
    if (!result) throw new TwitchApiError(502, 'Twitch lieferte kein Sendeergebnis.');
    if (!result.is_sent) this.logger.warn('Twitch hat eine Chatnachricht nicht gesendet.', { reason: result.drop_reason?.code || 'unbekannt' });
    return { messageId: result.message_id, isSent: result.is_sent, ...(result.drop_reason?.message ? { dropReason: result.drop_reason.message } : {}) };
  }

  async ensureChatSubscription(sessionId: string, broadcasterId: string, botId: string): Promise<void> {
    const current = await this.request<HelixResponse<{ type: string; status: string; condition: { broadcaster_user_id: string; user_id: string }; transport: { session_id?: string } }>>('/eventsub/subscriptions');
    const exists = current.data.some((subscription) => subscription.type === 'channel.chat.message'
      && subscription.status === 'enabled'
      && subscription.condition.broadcaster_user_id === broadcasterId
      && subscription.condition.user_id === botId
      && subscription.transport.session_id === sessionId);
    if (exists) {
      this.logger.info('EventSub-Chat-Abonnement bereits aktiv.');
      return;
    }
    await this.request('/eventsub/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        type: 'channel.chat.message',
        version: '1',
        condition: { broadcaster_user_id: broadcasterId, user_id: botId },
        transport: { method: 'websocket', session_id: sessionId },
      }),
    });
    this.logger.info('EventSub-Chat-Abonnement eingerichtet.');
  }

  async ensureChannelPointsSubscription(sessionId:string,broadcasterId:string,rewardId:string):Promise<void> {
    const condition={broadcaster_user_id:broadcasterId,reward_id:rewardId};
    const current=await this.request<HelixResponse<{type:string;status:string;condition:Record<string,string>;transport:{session_id?:string}}>>('/eventsub/subscriptions');
    const exists=current.data.some((subscription)=>subscription.type==='channel.channel_points_custom_reward_redemption.add'
      && subscription.status==='enabled'&&subscription.condition.broadcaster_user_id===broadcasterId
      && subscription.condition.reward_id===rewardId&&subscription.transport.session_id===sessionId);
    if(exists)return;
    await this.request('/eventsub/subscriptions',{method:'POST',body:JSON.stringify({type:'channel.channel_points_custom_reward_redemption.add',version:'1',
      condition,transport:{method:'websocket',session_id:sessionId}})});
    this.logger.info('EventSub-Kanalpunkte-Redemptions-Abonnement eingerichtet.');
  }

  async getCustomRewards(broadcasterId:string,manageableOnly=true):Promise<TwitchCustomReward[]> {
    const query=new URLSearchParams({broadcaster_id:broadcasterId,only_manageable_rewards:String(manageableOnly)});
    return (await this.request<HelixResponse<TwitchCustomReward>>(`/channel_points/custom_rewards?${query}`)).data;
  }

  async createCustomReward(broadcasterId:string,input:{title:string;prompt:string;cost:number}):Promise<TwitchCustomReward> {
    const query=new URLSearchParams({broadcaster_id:broadcasterId});
    const response=await this.request<HelixResponse<TwitchCustomReward>>(`/channel_points/custom_rewards?${query}`,{method:'POST',body:JSON.stringify({
      title:input.title,prompt:input.prompt,cost:input.cost,is_user_input_required:true,should_redemptions_skip_request_queue:false})});
    const reward=response.data[0];if(!reward)throw new TwitchApiError(502,'Twitch lieferte die erstellte Reward-ID nicht zurück.');return reward;
  }

  async getRedemption(broadcasterId:string,rewardId:string,redemptionId:string):Promise<TwitchRedemption|undefined> {
    const query=new URLSearchParams({broadcaster_id:broadcasterId,reward_id:rewardId,id:redemptionId});
    try{return (await this.request<HelixResponse<TwitchRedemption>>(`/channel_points/custom_rewards/redemptions?${query}`)).data[0];}
    catch(error){if(error instanceof TwitchApiError&&error.status===404)return undefined;throw error;}
  }

  async getUnfulfilledRedemptions(broadcasterId:string,rewardId:string):Promise<TwitchRedemption[]> {
    const result:TwitchRedemption[]=[];let cursor:string|undefined;
    for(let page=0;page<20;page++){
      const query=new URLSearchParams({broadcaster_id:broadcasterId,reward_id:rewardId,status:'UNFULFILLED',first:'50'});
      if(cursor)query.set('after',cursor);
      const response=await this.request<HelixPagedResponse<TwitchRedemption>>(`/channel_points/custom_rewards/redemptions?${query}`);
      result.push(...response.data);cursor=response.pagination?.cursor;if(!cursor)break;
    }
    return result;
  }

  async setRedemptionStatus(broadcasterId:string,rewardId:string,redemptionId:string,status:'FULFILLED'|'CANCELED'):Promise<TwitchRedemption> {
    const query=new URLSearchParams({broadcaster_id:broadcasterId,reward_id:rewardId,id:redemptionId});
    const response=await this.request<HelixResponse<TwitchRedemption>>(`/channel_points/custom_rewards/redemptions?${query}`,{
      method:'PATCH',body:JSON.stringify({status})});
    const redemption=response.data[0];if(!redemption||redemption.status!==status)throw new TwitchApiError(502,'Twitch hat den Einlösungsstatus nicht bestätigt.');return redemption;
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}, allowRefresh = true): Promise<T> {
    let token = await this.oauth.getAccessToken();
    let response = await this.fetchImpl(`https://api.twitch.tv/helix${path}`, {
      ...init,
      headers: {
        'Client-Id': this.clientId,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (response.status === 401 && allowRefresh) {
      token = await this.oauth.refreshAccessToken();
      response = await this.fetchImpl(`https://api.twitch.tv/helix${path}`, {
        ...init,
        headers: {
          'Client-Id': this.clientId,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
      });
    }
    if (!response.ok) {
      const body = await response.text();
      const reset = Number(response.headers.get('Ratelimit-Reset'));
      const retryAfterMs = response.status === 429 && Number.isFinite(reset) ? Math.max(1000, reset * 1000 - Date.now()) : undefined;
      throw new TwitchApiError(response.status, `Twitch Helix HTTP ${response.status}: ${body.slice(0, 200)}`, retryAfterMs);
    }
    if (response.status === 204) return {} as T;
    return JSON.parse(await response.text()) as T;
  }
}

const consoleLogger: Logger = {
  info: (message, details) => console.info(message, details || ''),
  warn: (message, details) => console.warn(message, details || ''),
  error: (message, details) => console.error(message, details || ''),
};
