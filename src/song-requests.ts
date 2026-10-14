import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FeatureStore } from './feature-store.js';
import type { TwitchApi, TwitchCustomReward } from './twitch-api.js';
import type { TwitchOAuth } from './twitch-oauth.js';
import type { Logger } from './logger.js';

const SPOTIFY_SCOPES=['playlist-read-private','playlist-read-collaborative','playlist-modify-private','playlist-modify-public'];
const CALLBACK_PATH='/dashboard/spotify/callback';
const REQUEST_COST=1000;
const DEFAULTS:SongRequestSettings={enabled:false,rewardId:null,rewardTitle:'🎵 Song wünschen',cost:REQUEST_COST,playlistId:null,playlistName:null};
export interface SongRequestSettings {enabled:boolean;rewardId:string|null;rewardTitle:string;cost:number;playlistId:string|null;playlistName:string|null}
export interface SongRequestRecord {redemptionId:string;rewardId:string;userId:string;displayName:string;userInput:string;status:'processing'|'added'|'fulfillment_pending'|'rejected'|'needs_review';trackUri:string|null;trackName:string|null;trackArtist:string|null;lastError:string|null;createdAt:number;updatedAt:number}
interface SpotifyTokens {accessToken:string;refreshToken:string;expiresAt:number;scopes:string[]}
interface SpotifyTrack {uri:string;name:string;artists:Array<{name:string}>}
interface SpotifyPlaylist {id:string;name:string;owner:{id:string};tracks?:{total:number};}

/** Channel-points requests are durably claimed before external writes; ambiguous playlist writes are never replayed automatically. */
export class SpotifySongRequests {
  private tokens?:SpotifyTokens;
  private pendingState:{value:string;expiresAt:number}|undefined;
  private sessionId?:string;
  private readonly tokenPath:string;
  private readonly clientId=(process.env.SPOTIFY_CLIENT_ID||'').trim();
  private readonly clientSecret=(process.env.SPOTIFY_CLIENT_SECRET||'').trim();
  private readonly redirectUri=(process.env.SPOTIFY_REDIRECT_URI||'').trim();
  constructor(private readonly store:FeatureStore,private readonly twitch:TwitchApi,private readonly twitchOAuth:TwitchOAuth,
    private readonly broadcasterId:string,private readonly logger:Logger,private readonly fetchImpl:typeof fetch=fetch,
    tokenPath=(process.env.SPOTIFY_TOKEN_FILE||'data/spotify-tokens.json')) {this.tokenPath=tokenPath;}

  settings():SongRequestSettings {return {...DEFAULTS,...this.store.config<Partial<SongRequestSettings>>('song_request_settings',{})};}
  configured():boolean {return Boolean(this.clientId&&this.clientSecret&&this.redirectUri);}
  connected():boolean {return Boolean(this.tokens&&SPOTIFY_SCOPES.every(scope=>this.tokens!.scopes.includes(scope)));}
  broadcasterConnected():boolean {return Boolean(this.twitchOAuth.hasAccessToken&&this.twitchOAuth.grantedScopes.includes('channel:manage:redemptions'));}
  statusMessage():string {if(!this.configured())return 'Spotify-App-Zugang und Callback-Adresse sind noch nicht eingerichtet.';if(!this.connected())return 'Spotify noch nicht verbunden oder erforderliche Playlist-Freigaben fehlen.';return 'Spotify ist verbunden; es wird ausschließlich die ausgewählte Playlist ergänzt.';}
  async initialize():Promise<void>{this.store.miniGameTransaction(db=>db.prepare("UPDATE song_requests SET status='needs_review',last_error='Bot-Neustart während der Verarbeitung; aus Sicherheitsgründen nicht automatisch erneut zur Playlist gesendet.',updated_at=? WHERE status='processing'").run(Date.now()));try{const mode=fsSync.statSync(this.tokenPath).mode&0o777;if(mode&0o077)await fs.chmod(this.tokenPath,0o600);const saved=JSON.parse(await fs.readFile(this.tokenPath,'utf8')) as Partial<SpotifyTokens>;
    if(saved.accessToken&&saved.refreshToken)this.tokens={accessToken:saved.accessToken,refreshToken:saved.refreshToken,expiresAt:Number(saved.expiresAt||0),scopes:Array.isArray(saved.scopes)?saved.scopes.filter((s):s is string=>typeof s==='string'):[]};}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')this.logger.warn('Spotify-Token konnte nicht geladen werden; erneute Verbindung ist erforderlich.');}}
  authorizationUrl():string {if(!this.configured())throw new Error('Spotify-App-Zugang und SPOTIFY_REDIRECT_URI müssen zuerst auf dem Server eingerichtet werden.');const redirect=new URL(this.redirectUri);
    if(redirect.pathname!==CALLBACK_PATH||redirect.search||redirect.hash||(redirect.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(redirect.hostname)))throw new Error(`Spotify-Redirect muss exakt auf ${CALLBACK_PATH} zeigen und HTTPS verwenden.`);
    const state=randomBytes(32).toString('hex');this.pendingState={value:state,expiresAt:Date.now()+10*60_000};const url=new URL('https://accounts.spotify.com/authorize');
    url.searchParams.set('client_id',this.clientId);url.searchParams.set('response_type','code');url.searchParams.set('redirect_uri',this.redirectUri);url.searchParams.set('scope',SPOTIFY_SCOPES.join(' '));url.searchParams.set('state',state);return url.toString();}
  async handleCallback(url:URL):Promise<void>{const state=url.searchParams.get('state'),code=url.searchParams.get('code');const expected=this.pendingState;this.pendingState=undefined;
    if(!expected||expected.expiresAt<Date.now()||!state||state!==expected.value)throw new Error('Spotify-Anmeldung abgelaufen oder ungültig; bitte erneut verbinden.');
    if(url.searchParams.has('error')||!code)throw new Error('Spotify hat die Verbindung nicht freigegeben.');
    const response=await this.fetchImpl('https://accounts.spotify.com/api/token',{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:this.redirectUri})});
    const data=await spotifyJson(response) as {access_token:string;refresh_token?:string;expires_in:number;scope:string};if(!data.access_token||!data.refresh_token)throw new Error('Spotify hat kein gültiges Zugriffstoken geliefert.');
    this.tokens={accessToken:data.access_token,refreshToken:data.refresh_token,expiresAt:Date.now()+data.expires_in*1000,scopes:data.scope.split(' ').filter(Boolean)};await this.persistTokens();}
  async ensureSubscription(sessionId:string):Promise<void>{this.sessionId=sessionId;const s=this.settings();if(!s.enabled||!s.rewardId)return;if(!this.connected()||!s.playlistId){this.store.setConfig('song_request_settings',{...s,enabled:false});throw new Error('Spotify oder Playlist fehlt; Song Requests wurden sicher pausiert.');}if(!this.twitchOAuth.hasAccessToken||!this.twitchOAuth.grantedScopes.includes('channel:manage:redemptions')){this.store.setConfig('song_request_settings',{...s,enabled:false});throw new Error('Broadcaster-OAuth für Kanalpunkte fehlt; Song Requests wurden sicher pausiert.');}
    await this.twitch.ensureChannelPointsSubscription(sessionId,this.broadcasterId,s.rewardId);await this.reconcile();}
  async saveSettings(input:Partial<SongRequestSettings>):Promise<void>{const old=this.settings(),next={...old,...input};if(next.cost!==REQUEST_COST)throw new Error('Ein Song Request kostet fest 1.000 Kanalpunkte.');
    if(next.enabled&&(!next.rewardId||!next.playlistId||!this.connected()||!this.twitchOAuth.grantedScopes.includes('channel:manage:redemptions')))throw new Error('Zum Einschalten Spotify, Song-Reward, Playlist und Broadcaster-OAuth verbinden.');
    this.store.setConfig('song_request_settings',next);if(next.enabled&&this.sessionId)await this.ensureSubscription(this.sessionId);}
  async playlists():Promise<Array<{id:string;name:string;tracks:number}>>{const data=await this.spotifyRequest<{items:SpotifyPlaylist[];next:string|null}>('/me/playlists?limit=50');const owner=await this.spotifyRequest<{id:string}>('/me');let items=data.items.filter(p=>p.owner?.id===owner.id);let next=data.next;
    while(next&&items.length<300){const page=await this.spotifyRequest<{items:SpotifyPlaylist[];next:string|null}>(next);items=items.concat(page.items.filter(p=>p.owner?.id===owner.id));next=page.next;}
    return items.map(p=>({id:p.id,name:p.name,tracks:p.tracks?.total??0}));}
  async selectReward(rewardId:string):Promise<TwitchCustomReward>{const reward=(await this.twitch.getCustomRewards(this.broadcasterId,true)).find(x=>x.id===rewardId);if(!reward||!reward.is_user_input_required||!reward.is_enabled||reward.should_redemptions_skip_request_queue)throw new Error('Song-Reward muss aktiv sein, Texteingaben verlangen und in der manuellen Twitch-Warteschlange bleiben.');if(reward.cost!==REQUEST_COST)throw new Error('Der ausgewählte Reward muss genau 1.000 Kanalpunkte kosten.');await this.saveSettings({...this.settings(),rewardId:reward.id,rewardTitle:reward.title,cost:REQUEST_COST});return reward;}
  async manageableRewards():Promise<TwitchCustomReward[]>{if(!this.twitchOAuth.hasAccessToken||!this.twitchOAuth.grantedScopes.includes('channel:manage:redemptions'))throw new Error('Janniks Broadcaster-OAuth für Kanalpunkte fehlt.');return this.twitch.getCustomRewards(this.broadcasterId,true);}
  async createReward():Promise<TwitchCustomReward>{const title=DEFAULTS.rewardTitle;
    const existing=(await this.twitch.getCustomRewards(this.broadcasterId,false)).find(x=>x.title.toLowerCase()===title.toLowerCase());if(existing)throw new Error('„🎵 Song wünschen“ existiert bereits; bitte im Dashboard auswählen.');
    const reward=await this.twitch.createCustomReward(this.broadcasterId,{title,prompt:'Titel + Interpret oder Spotify-Songlink (max. 300 Zeichen).',cost:REQUEST_COST});await this.saveSettings({...this.settings(),rewardId:reward.id,rewardTitle:reward.title,cost:REQUEST_COST});return reward;}
  async selectPlaylist(playlistId:string):Promise<void>{const list=await this.playlists(),found=list.find(p=>p.id===playlistId);if(!found)throw new Error('Bitte eine Playlist auswählen, die Jannik selbst besitzt.');await this.saveSettings({...this.settings(),playlistId:found.id,playlistName:found.name});}
  async acceptEventSub(message:Record<string,unknown>):Promise<void>{const payload=message.payload as Record<string,unknown>|undefined,sub=payload?.subscription as Record<string,unknown>|undefined,event=payload?.event as Record<string,unknown>|undefined,condition=sub?.condition as Record<string,unknown>|undefined,s=this.settings(),reward=event?.reward as Record<string,unknown>|undefined;
    if(sub?.type!=='channel.channel_points_custom_reward_redemption.add'||!event||!s.enabled||!s.rewardId||String(reward?.id||'')!==s.rewardId||String(event.broadcaster_user_id||'')!==this.broadcasterId||String(condition?.broadcaster_user_id||'')!==this.broadcasterId||event.status!=='unfulfilled')return;
    const id=String(event.id||''),userId=String(event.user_id||''),name=clean(String(event.user_name||event.user_login||'Unbekannt'),48),input=cleanInput(String(event.user_input||''));if(!id||!userId)return;
    const now=Date.now(),db=this.store.miniGameQuery(x=>x);const insert=db.prepare(`INSERT OR IGNORE INTO song_requests(redemption_id,reward_id,user_id,display_name,user_input,status,created_at,updated_at) VALUES(?,?,?,?,?,'processing',?,?)`).run(id,s.rewardId,userId,name,input,now,now);
    if(insert.changes!==1){this.logger.info('Doppelte Song-Einlösung ignoriert.',{redemptionId:id});return;}
    let playlistAdded=false;
    try{if(!input||input.length>300||/[\u0000-\u001f\u007f]/u.test(input))throw new Error('Bitte Titel und Interpret oder einen gültigen Spotify-Songlink eingeben.');
      if(!s.playlistId||!this.connected())throw new Error('Spotify-Playlist ist derzeit nicht verbunden.');const track=await this.resolveTrack(input);this.update(id,'processing',track);
      await this.spotifyRequest(`/playlists/${encodeURIComponent(s.playlistId)}/items`,{method:'POST',body:JSON.stringify({uris:[track.uri]})});playlistAdded=true;
      this.update(id,'fulfillment_pending',track);
      await this.twitch.setRedemptionStatus(this.broadcasterId,s.rewardId,id,'FULFILLED');this.update(id,'added',track);this.logger.info('Song Request zur Playlist hinzugefügt.',{redemptionId:id,trackUri:track.uri});
    }catch(error){const detail=error instanceof Error?error.message:'Unbekannter Fehler';const status=playlistAdded?'fulfillment_pending':'needs_review';this.update(id,status,null,detail);this.logger.warn('Song Request benötigt Dashboard-Prüfung.',{redemptionId:id,status,error:detail});
      if(!playlistAdded&&/gültigen Spotify-Songlink|Titel und Interpret/u.test(detail)){try{await this.twitch.setRedemptionStatus(this.broadcasterId,s.rewardId,id,'CANCELED');this.update(id,'rejected',null,detail);}catch(cancelError){this.logger.warn('Ungültige Einlösung konnte nicht automatisch storniert werden.',{redemptionId:id,error:cancelError instanceof Error?cancelError.message:'unbekannt'});}}}
  }
  list():SongRequestRecord[]{return this.store.miniGameQuery(db=>(db.prepare('SELECT * FROM song_requests ORDER BY created_at DESC LIMIT 100').all() as Array<Record<string,unknown>>).map(rowToRecord));}
  async reconcile():Promise<void>{const s=this.settings();if(!s.enabled||!s.rewardId)return;
    for(const record of this.list().filter(r=>r.status==='fulfillment_pending'))try{const current=await this.twitch.getRedemption(this.broadcasterId,record.rewardId,record.redemptionId);
      if(current?.status==='FULFILLED')this.update(record.redemptionId,'added',null);
      else if(current?.status==='UNFULFILLED'){await this.twitch.setRedemptionStatus(this.broadcasterId,record.rewardId,record.redemptionId,'FULFILLED');this.update(record.redemptionId,'added',null);}
      else this.update(record.redemptionId,'needs_review',null,'Playlisteneintrag ist vorhanden; Twitch-Einlösungsstatus muss manuell geprüft werden.');}
      catch(error){this.logger.warn('Song wurde hinzugefügt, aber Twitch-Einlösung muss abgeglichen werden.',{redemptionId:record.redemptionId,error:error instanceof Error?error.message:'unbekannt'});}
    try{for(const r of await this.twitch.getUnfulfilledRedemptions(this.broadcasterId,s.rewardId))await this.acceptEventSub({payload:{subscription:{type:'channel.channel_points_custom_reward_redemption.add',condition:{broadcaster_user_id:this.broadcasterId,reward_id:s.rewardId}},event:{...r,broadcaster_user_id:r.broadcaster_id,status:'unfulfilled',reward:r.reward}}});}
    catch(error){this.logger.warn('Offene Song-Einlösungen konnten nicht abgeglichen werden.',{error:error instanceof Error?error.message:'unbekannt'});}}
  private update(id:string,status:SongRequestRecord['status'],track:SpotifyTrack|null,error:string|null=null):void{this.store.miniGameTransaction(db=>db.prepare('UPDATE song_requests SET status=?,track_uri=COALESCE(?,track_uri),track_name=COALESCE(?,track_name),track_artist=COALESCE(?,track_artist),last_error=?,updated_at=? WHERE redemption_id=?')
    .run(status,track?.uri??null,track?.name??null,track?.artists.map(a=>a.name).join(', ')??null,error,Date.now(),id));}
  private async resolveTrack(input:string):Promise<SpotifyTrack>{const uri=input.match(/^spotify:track:([A-Za-z0-9]{22})$/u);if(uri)return this.spotifyRequest<SpotifyTrack>(`/tracks/${uri[1]}`);
    try{const url=new URL(input);const match=url.hostname.toLowerCase()==='open.spotify.com'?url.pathname.match(/^\/track\/([A-Za-z0-9]{22})\/?$/u):null;if(match)return this.spotifyRequest<SpotifyTrack>(`/tracks/${match[1]}`);}catch{/* The request may be a plain title and artist. */}
    const result=await this.spotifyRequest<{tracks:{items:SpotifyTrack[]}}>(`/search?${new URLSearchParams({q:input,type:'track',limit:'1'})}`);const track=result.tracks.items[0];if(!track)throw new Error('Kein passender Song gefunden. Bitte Einlösung im Twitch-Dashboard prüfen.');return track;}
  private async spotifyRequest<T>(pathOrUrl:string,init:RequestInit={}):Promise<T>{const token=await this.accessToken();const url=pathOrUrl.startsWith('https://api.spotify.com/')?pathOrUrl:`https://api.spotify.com/v1${pathOrUrl.startsWith('/')?pathOrUrl:`/${pathOrUrl}`}`;
    let response=await this.fetchImpl(url,{...init,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...init.headers}});if(response.status===401){await this.refreshToken();response=await this.fetchImpl(url,{...init,headers:{Authorization:`Bearer ${this.tokens!.accessToken}`,'Content-Type':'application/json',...init.headers}});}
    return spotifyJson(response) as Promise<T>;}
  private async accessToken():Promise<string>{if(!this.tokens)throw new Error('Spotify wurde noch nicht verbunden.');if(this.tokens.expiresAt<Date.now()+60_000)await this.refreshToken();return this.tokens.accessToken;}
  private async refreshToken():Promise<void>{if(!this.tokens)throw new Error('Spotify wurde noch nicht verbunden.');const response=await this.fetchImpl('https://accounts.spotify.com/api/token',{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:this.tokens.refreshToken})});
    const data=await spotifyJson(response) as {access_token:string;refresh_token?:string;expires_in:number;scope?:string};this.tokens={...this.tokens,accessToken:data.access_token,refreshToken:data.refresh_token||this.tokens.refreshToken,expiresAt:Date.now()+data.expires_in*1000,scopes:data.scope?.split(' ').filter(Boolean)||this.tokens.scopes};await this.persistTokens();}
  private async persistTokens():Promise<void>{if(!this.tokens)return;await fs.mkdir(path.dirname(this.tokenPath),{recursive:true,mode:0o700});const temp=`${this.tokenPath}.tmp-${process.pid}`;await fs.writeFile(temp,JSON.stringify(this.tokens),{mode:0o600});await fs.rename(temp,this.tokenPath);await fs.chmod(this.tokenPath,0o600);}
}
function rowToRecord(r:Record<string,unknown>):SongRequestRecord{return {redemptionId:String(r.redemption_id),rewardId:String(r.reward_id),userId:String(r.user_id),displayName:String(r.display_name),userInput:String(r.user_input),status:r.status as SongRequestRecord['status'],trackUri:r.track_uri?String(r.track_uri):null,trackName:r.track_name?String(r.track_name):null,trackArtist:r.track_artist?String(r.track_artist):null,lastError:r.last_error?String(r.last_error):null,createdAt:Number(r.created_at),updatedAt:Number(r.updated_at)};}
function clean(value:string,max=300):string{return Array.from(value.normalize('NFC').replace(/[\r\n\t]/gu,' ').trim()).slice(0,max).join('');}
function cleanInput(value:string):string{return clean(value,301);}
async function spotifyJson(response:Response):Promise<unknown>{const raw=await response.text();let data:unknown={};try{data=raw?JSON.parse(raw):{};}catch{/* response body is not JSON */}if(!response.ok){const detail=data&&typeof data==='object'&&'error' in data?String((data as {error:unknown}).error):`HTTP ${response.status}`;throw new Error(`Spotify-Anfrage fehlgeschlagen (${response.status}): ${detail.slice(0,160)}`);}return data;}
