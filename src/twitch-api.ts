import type { Logger } from './logger.js';
import type { TwitchOAuth } from './twitch-oauth.js';

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url?: string;
}
export interface TwitchStream { id: string; user_id: string; user_login?:string; user_name?:string; type: 'live' | ''; title?:string; game_id?:string; game_name?:string; viewer_count?:number; started_at?:string; language?:string; thumbnail_url?:string; }

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
    private readonly wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  ) {}

  async getUsers(logins: string[]): Promise<TwitchUser[]> {
    const query = logins.map((login) => `login=${encodeURIComponent(login)}`).join('&');
    const response = await this.request<HelixResponse<TwitchUser>>(`/users?${query}`);
    return response.data;
  }

  /** Public stream state lookup. Get Streams accepts an existing user token and requests no additional scope. */
  async getStreamStatus(broadcasterId: string): Promise<TwitchStream | undefined> {
    const query = new URLSearchParams({ user_id: broadcasterId });
    const response = await this.request<HelixResponse<TwitchStream>>(`/streams?${query}`);
    return response.data.find(stream => stream.user_id === broadcasterId && stream.type === 'live');
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

  async ensureLiveSubscriptions(sessionId: string, broadcasterId: string): Promise<void> {
    const subscriptions = [
      { type: 'stream.online', version: '1' },
      { type: 'stream.offline', version: '1' },
      { type: 'channel.update', version: '2' },
    ] as const;
    const current = await this.request<HelixResponse<{ type: string; version: string; status: string; condition: Record<string, string>; transport: { session_id?: string } }>>('/eventsub/subscriptions');
    for (const subscription of subscriptions) {
      const exists = current.data.some(item => item.type === subscription.type && item.version === subscription.version
        && item.status === 'enabled' && item.condition.broadcaster_user_id === broadcasterId
        && item.transport.session_id === sessionId);
      if (exists) continue;
      await this.request('/eventsub/subscriptions', {
        method: 'POST',
        body: JSON.stringify({ type: subscription.type, version: subscription.version,
          condition: { broadcaster_user_id: broadcasterId }, transport: { method: 'websocket', session_id: sessionId } }),
      });
      this.logger.info('Twitch-Live-EventSub eingerichtet.', { type: subscription.type });
    }
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
    const method = (init.method || 'GET').toUpperCase();
    const retrySafeRead = method === 'GET';
    let refreshed = false;
    const send = () => this.fetchImpl(`https://api.twitch.tv/helix${path}`, {
      ...init, signal: init.signal || AbortSignal.timeout(15_000),
      headers: {
        'Client-Id': this.clientId,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { response = await send(); }
      catch (error) {
        if (retrySafeRead && attempt < 2) { await this.wait(250 * (2 ** attempt)); continue; }
        throw new TwitchApiError(503, retrySafeRead ? 'Twitch-Verbindung vorübergehend nicht verfügbar.' : 'Twitch-Verbindung unklar; der Vorgang wurde nicht automatisch wiederholt.');
      }
      if (response.status === 401 && allowRefresh && !refreshed) {
        const latestToken = await this.oauth.getAccessToken();
        token = latestToken === token ? await this.oauth.refreshAccessToken() : latestToken;
        refreshed = true;
        try { response = await send(); }
        catch { throw new TwitchApiError(503, retrySafeRead ? 'Twitch-Verbindung nach Token-Erneuerung fehlgeschlagen.' : 'Twitch-Ergebnis nach Token-Erneuerung unklar; bitte Status prüfen.'); }
      }
      if (response.ok || !(retrySafeRead && (response.status === 429 || response.status >= 500) && attempt < 2)) break;
      const retryAfterMs = retryAfter(response);
      const delay = response.status === 429 ? retryAfterMs : 250 * (2 ** attempt);
      if (delay !== undefined && delay > 5_000) break;
      await this.wait(delay ?? 250 * (2 ** attempt));
    }
    if (!response) throw new TwitchApiError(503, 'Twitch lieferte keine Antwort.');
    if (!response.ok) {
      const detail = response.status === 401 ? 'OAuth-Zugriff fehlt oder wurde widerrufen.' : `Twitch Helix HTTP ${response.status}.`;
      throw new TwitchApiError(response.status, detail, retryAfter(response));
    }
    if (response.status === 204) return {} as T;
    let payload: unknown;
    try { payload = JSON.parse(await response.text()); }
    catch { throw new TwitchApiError(502, 'Twitch lieferte eine ungültige JSON-Antwort.'); }
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as {data?:unknown}).data))
      throw new TwitchApiError(502, 'Twitch lieferte eine unvollständige API-Antwort.');
    return payload as T;
  }
}

function retryAfter(response: Response): number | undefined {
  const seconds = Number(response.headers.get('Retry-After'));
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  const reset = Number(response.headers.get('Ratelimit-Reset'));
  return Number.isFinite(reset) && reset > 0 ? Math.max(1000, Math.ceil(reset * 1000 - Date.now())) : undefined;
}

const consoleLogger: Logger = {
  info: (message, details) => console.info(message, details || ''),
  warn: (message, details) => console.warn(message, details || ''),
  error: (message, details) => console.error(message, details || ''),
};
