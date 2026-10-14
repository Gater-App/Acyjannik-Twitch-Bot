import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { formatPublicChatMessage } from './chat-message-format.js';
import { FeatureStore } from './feature-store.js';

export const AUTO_CHAT_MIN_INTERVAL_MINUTES = 15;
export const AUTO_CHAT_MIN_GLOBAL_GAP_MS = 5 * 60_000;
export const AUTO_CHAT_ACTIVITY_THRESHOLD = 6;

export interface AutomaticChatMessage {
  id: string; title: string; message: string; intervalMinutes: number;
  enabled: boolean; activeChatOnly: boolean; createdAt: number; updatedAt: number;
  lastSentAt: number | null; lastAttemptAt: number | null; lastErrorAt: number | null;
  nextEarliestAt: number;
}
interface MessageRow {
  id:string;title:string;message:string;interval_minutes:number;enabled:number;active_chat_only:number;
  created_at:number;updated_at:number;last_sent_at:number|null;last_attempt_at:number|null;last_error_at:number|null;
}

/** Persistent, at-most-once scheduled chat announcements sharing the existing SQLite store and send queue. */
export class AutomaticChatMessages {
  constructor(private readonly store:FeatureStore) { this.inheritCommunityTipHistory(); }

  list(now=Date.now()):AutomaticChatMessage[] {
    return this.store.miniGameQuery(db=>(db.prepare('SELECT * FROM automatic_chat_messages ORDER BY created_at,id').all() as MessageRow[]).map(row=>this.toPublic(row,now)));
  }

  globalStatus(now=Date.now()):{lastAttemptAt:number|null;sentThisHour:number;hourlyLimit:number;nextEarliestAt:number|null;canSend:boolean} {
    const state=this.globalState(),sentThisHour=state.history.filter(at=>now-at<60*60_000).length;
    const nextEarliestAt=state.lastAttemptAt?state.lastAttemptAt+AUTO_CHAT_MIN_GLOBAL_GAP_MS:null;
    return {lastAttemptAt:state.lastAttemptAt||null,sentThisHour,hourlyLimit:4,nextEarliestAt,
      canSend:(!state.lastAttemptAt||now-state.lastAttemptAt>=AUTO_CHAT_MIN_GLOBAL_GAP_MS)&&sentThisHour<4};
  }

  save(input:{id?:string;title:unknown;message:unknown;intervalMinutes:unknown;enabled?:unknown;activeChatOnly?:unknown},now=Date.now()):AutomaticChatMessage {
    const title=clean(input.title), message=clean(input.message);
    const intervalMinutes=Number(input.intervalMinutes);
    if(!title)throw new Error('Bitte einen internen Titel angeben.');
    if(!message)throw new Error('Bitte einen Nachrichtentext angeben.');
    if(!Number.isInteger(intervalMinutes)||intervalMinutes<AUTO_CHAT_MIN_INTERVAL_MINUTES||intervalMinutes>1440)throw new Error('Das Intervall muss zwischen 15 Minuten und 24 Stunden liegen.');
    if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw new Error('Der Aktiv-Status ist ungültig.');
    if(input.activeChatOnly!==undefined&&typeof input.activeChatOnly!=='boolean')throw new Error('Die Chat-Aktivitätsoption ist ungültig.');
    if(Array.from(title).length>60)throw new Error('Der interne Titel darf höchstens 60 Zeichen haben.');
    if(Array.from(formatPublicChatMessage(message,'info',1000)).length>500)throw new Error('Der Nachrichtentext ist zu lang (maximal 500 Zeichen inklusive Präfix).');
    const id=typeof input.id==='string'&&input.id.trim()?input.id.trim():randomUUID();
    if(id.length>100)throw new Error('Die Nachrichtenkennung ist ungültig.');
    const current=this.store.miniGameQuery(db=>db.prepare('SELECT * FROM automatic_chat_messages WHERE id=?').get(id) as MessageRow|undefined);
    if(!current&&this.store.miniGameQuery(db=>(db.prepare('SELECT COUNT(*) AS count FROM automatic_chat_messages').get() as {count:number}).count)>=50)
      throw new Error('Es können höchstens 50 automatische Nachrichten verwaltet werden.');
    this.store.miniGameTransaction(db=>{
      if(current)db.prepare(`UPDATE automatic_chat_messages SET title=?,message=?,interval_minutes=?,enabled=?,active_chat_only=?,updated_at=? WHERE id=?`)
        .run(title,message,intervalMinutes,input.enabled===undefined?current.enabled:Number(input.enabled),input.activeChatOnly===undefined?current.active_chat_only:Number(input.activeChatOnly),now,id);
      else db.prepare(`INSERT INTO automatic_chat_messages(id,title,message,interval_minutes,enabled,active_chat_only,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(id,title,message,intervalMinutes,input.enabled===false?0:1,input.activeChatOnly===true?1:0,now,now);
    });
    const saved=this.store.miniGameQuery(db=>db.prepare('SELECT * FROM automatic_chat_messages WHERE id=?').get(id) as MessageRow);
    return this.toPublic(saved,now);
  }

  setEnabled(id:string,enabled:boolean,now=Date.now()):boolean {
    if(typeof enabled!=='boolean')throw new Error('Der Aktiv-Status ist ungültig.');
    return this.store.miniGameTransaction(db=>db.prepare('UPDATE automatic_chat_messages SET enabled=?,updated_at=? WHERE id=?').run(Number(enabled),now,id).changes===1);
  }

  delete(id:string):boolean { return this.store.miniGameTransaction(db=>db.prepare('DELETE FROM automatic_chat_messages WHERE id=?').run(id).changes===1); }

  hasDue(now:number,activityMessages:number,busy:boolean):AutomaticChatMessage|undefined {
    if(busy)return undefined;
    return this.findDue(now,activityMessages);
  }

  nextDue(now:number,activityMessages:number,busy:boolean,isLive:boolean|undefined):AutomaticChatMessage|undefined {
    if(isLive!==true||busy)return undefined;
    return this.findDue(now,activityMessages);
  }

  private findDue(now:number,activityMessages:number):AutomaticChatMessage|undefined {
    return this.list(now).find(message=>message.enabled
      &&(!message.activeChatOnly||activityMessages>=AUTO_CHAT_ACTIVITY_THRESHOLD)
      &&now>=message.nextEarliestAt);
  }

  /** Reserve the shared auto-message slot before queueing; a restart or uncertain API result cannot immediately duplicate it. */
  canReserveGlobalSlot(now=Date.now()):boolean {
    const state=this.globalState();
    return (!state.lastAttemptAt||now-state.lastAttemptAt>=AUTO_CHAT_MIN_GLOBAL_GAP_MS)
      &&state.history.filter(at=>now-at<60*60_000).length<4;
  }

  reserveGlobalSlot(now=Date.now()):boolean {
    return this.store.miniGameTransaction(db=>{
      const state=this.globalState(db);
      if((state.lastAttemptAt&&now-state.lastAttemptAt<AUTO_CHAT_MIN_GLOBAL_GAP_MS)||state.history.filter(at=>now-at<60*60_000).length>=4)return false;
      db.prepare("INSERT INTO feature_config(key,value) VALUES('automatic_chat_state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify({lastAttemptAt:now,history:[...state.history.filter(at=>now-at<60*60_000),now]}));
      return true;
    });
  }

  reserveMessageAttempt(id:string,now=Date.now()):boolean {
    return this.store.miniGameTransaction(db=>{
      const state=this.globalState(db);
      if((state.lastAttemptAt&&now-state.lastAttemptAt<AUTO_CHAT_MIN_GLOBAL_GAP_MS)||state.history.filter(at=>now-at<60*60_000).length>=4)return false;
      const row=db.prepare('SELECT enabled,interval_minutes,created_at,last_sent_at,last_attempt_at FROM automatic_chat_messages WHERE id=?').get(id) as {enabled:number;interval_minutes:number;created_at:number;last_sent_at:number|null;last_attempt_at:number|null}|undefined;
      if(!row||!row.enabled)return false;
      const previous=Math.max(row.last_sent_at||0,row.last_attempt_at||0,row.created_at);
      if(previous&&now-previous<row.interval_minutes*60_000)return false;
      db.prepare('UPDATE automatic_chat_messages SET last_attempt_at=?,last_error_at=NULL WHERE id=?').run(now,id);
      db.prepare("INSERT INTO feature_config(key,value) VALUES('automatic_chat_state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify({lastAttemptAt:now,history:[...state.history.filter(at=>now-at<60*60_000),now]}));
      return true;
    });
  }

  markSent(id:string,now=Date.now()):void { this.store.miniGameTransaction(db=>db.prepare('UPDATE automatic_chat_messages SET last_sent_at=?,last_error_at=NULL WHERE id=?').run(now,id)); }
  markFailed(id:string,now=Date.now()):void { this.store.miniGameTransaction(db=>db.prepare('UPDATE automatic_chat_messages SET last_error_at=? WHERE id=?').run(now,id)); }

  private globalState(db?:BetterSqlite3.Database):{lastAttemptAt:number;history:number[]} {
    const read=(connection:BetterSqlite3.Database)=>{
      const row=connection.prepare("SELECT value FROM feature_config WHERE key='automatic_chat_state'").get() as {value:string}|undefined;
      try{const value=JSON.parse(row?.value||'{}') as {lastAttemptAt?:unknown;history?:unknown};return {
        lastAttemptAt:typeof value.lastAttemptAt==='number'&&Number.isFinite(value.lastAttemptAt)?value.lastAttemptAt:0,
        history:Array.isArray(value.history)?value.history.filter((at):at is number=>typeof at==='number'&&Number.isFinite(at)&&at>0).slice(-24):[],
      };}catch{return {lastAttemptAt:0,history:[]};}
    };
    return db?read(db):this.store.miniGameQuery(read);
  }

  private inheritCommunityTipHistory():void {
    const existing=this.globalState();if(existing.lastAttemptAt||existing.history.length)return;
    const prior=this.store.config<unknown>('community_tip_state',{});
    if(!prior||typeof prior!=='object')return;
    const data=prior as Record<string,unknown>,last=typeof data.lastSentAt==='number'&&Number.isFinite(data.lastSentAt)?data.lastSentAt:0;
    const history=Array.isArray(data.sentHistory)?data.sentHistory.filter((at):at is number=>typeof at==='number'&&Number.isFinite(at)&&at>0).slice(-24):[];
    if(!last&&!history.length)return;
    this.store.setConfig('automatic_chat_state',{lastAttemptAt:last,history});
  }

  private toPublic(row:MessageRow,now:number):AutomaticChatMessage {
    const next=Math.max(row.last_sent_at||0,row.last_attempt_at||0,row.created_at)+(row.interval_minutes*60_000);
    return {id:row.id,title:row.title,message:row.message,intervalMinutes:row.interval_minutes,enabled:row.enabled===1,activeChatOnly:row.active_chat_only===1,
      createdAt:row.created_at,updatedAt:row.updated_at,lastSentAt:row.last_sent_at,lastAttemptAt:row.last_attempt_at,lastErrorAt:row.last_error_at,
      nextEarliestAt:next};
  }
}

function clean(value:unknown):string {
  if(typeof value!=='string')return '';
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim();
}
