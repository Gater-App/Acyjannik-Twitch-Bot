import type { TwitchOAuth } from './twitch-oauth.js';

const VIP_SCOPE='channel:read:vips';
type VipStatusCode='needs_authorization'|'missing_scope'|'wrong_account'|'ready'|'unavailable';
interface VipStatus {state:VipStatusCode;authorized:boolean;scopeGranted:boolean;checkedAt:number|null;}

/** Fail-closed Twitch VIP lookup using a dedicated broadcaster user token. */
export class TwitchVipService {
  private validation:{status:VipStatus;expiresAt:number}|undefined;
  private readonly membership=new Map<string,{isVip:boolean;expiresAt:number}>();
  constructor(private readonly clientId:string,private broadcasterId:string,private readonly oauth:TwitchOAuth,
    private readonly fetchImpl:typeof fetch=fetch,private readonly now:()=>number=Date.now){}

  setBroadcasterId(userId:string):void{if(this.broadcasterId===userId)return;this.broadcasterId=userId;this.invalidate();}

  async status():Promise<VipStatus>{return (await this.validateToken()).status;}

  async isVip(userId:string):Promise<boolean>{
    if(!/^\d{1,30}$/u.test(userId))return false;
    const now=this.now(),cached=this.membership.get(userId);if(cached&&cached.expiresAt>now)return cached.isVip;
    const validation=await this.validateToken();if(validation.status.state!=='ready')return false;
    try{
      let response=await this.helix(userId);
      if(response.status===401){await this.oauth.refreshAccessToken();this.validation=undefined;const refreshed=await this.validateToken();if(refreshed.status.state!=='ready')return false;response=await this.helix(userId);}
      if(!response.ok){this.membership.set(userId,{isVip:false,expiresAt:this.now()+10_000});return false;}
      const body=await response.json() as {data?:Array<{user_id?:string}>};
      if(!Array.isArray(body.data)){this.membership.set(userId,{isVip:false,expiresAt:this.now()+10_000});return false;}
      const result=body.data.some(row=>row.user_id===userId);this.membership.set(userId,{isVip:result,expiresAt:this.now()+60_000});return result;
    }catch{this.membership.set(userId,{isVip:false,expiresAt:this.now()+10_000});return false;}
  }

  invalidate(userId?:string):void{this.validation=undefined;if(userId)this.membership.delete(userId);else this.membership.clear();}

  private async validateToken():Promise<{status:VipStatus;scopes:Set<string>}>{
    const now=this.now();if(this.validation&&this.validation.expiresAt>now)return {status:this.validation.status,scopes:new Set(this.validationScopes)};
    const unavailable=(state:VipStatusCode):{status:VipStatus;scopes:Set<string>}=>{
      const status:VipStatus={state,authorized:false,scopeGranted:false,checkedAt:now};
      this.validation={status,expiresAt:now+10_000};this.validationScopes=new Set();
      return {status,scopes:new Set()};
    };
    let token:string;try{token=await this.oauth.getAccessToken();}catch{return unavailable('needs_authorization');}
    try{
      let response=await this.fetchImpl('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:`OAuth ${token}`},signal:AbortSignal.timeout(10_000)});
      if(response.status===401){token=await this.oauth.refreshAccessToken();response=await this.fetchImpl('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:`OAuth ${token}`},signal:AbortSignal.timeout(10_000)});}
      if(!response.ok)return unavailable('unavailable');
      const identity=await response.json() as {client_id?:string;user_id?:string;scopes?:string[]};
      if(identity.client_id!==this.clientId||identity.user_id!==this.broadcasterId)return unavailable('wrong_account');
      const scopes=new Set(Array.isArray(identity.scopes)?identity.scopes:[]),scopeGranted=scopes.has(VIP_SCOPE);
      const status:VipStatus={state:scopeGranted?'ready':'missing_scope',authorized:true,scopeGranted,checkedAt:now};
      this.validation={status,expiresAt:now+120_000};this.validationScopes=scopes;return {status,scopes};
    }catch{return unavailable('unavailable');}
  }
  private validationScopes=new Set<string>();
  private async helix(userId:string):Promise<Response>{
    const token=await this.oauth.getAccessToken(),query=new URLSearchParams({broadcaster_id:this.broadcasterId,user_id:userId});
    return this.fetchImpl(`https://api.twitch.tv/helix/channels/vips?${query}`,{headers:{'Client-Id':this.clientId,Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10_000)});
  }
}
