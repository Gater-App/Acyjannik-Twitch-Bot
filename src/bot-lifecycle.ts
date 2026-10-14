import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { FeatureStore } from './feature-store.js';

export const BOT_LIFESIGNS_ENABLED_BY_DEFAULT = false;
export const BOT_RESTART_COOLDOWN_MS = 30 * 60_000;
export const BOT_RESTART_MARKER_TTL_MS = 15 * 60_000;

export type RestartNoticeStatus = 'pending' | 'sent' | 'failed' | 'skipped';
export type RestartPhase = 'armed' | 'shutting-down' | 'awaiting-return' | 'returning' | 'complete' | 'cancelled';
export interface PlannedRestartMarker {
  id: string;
  plannedAt: number;
  reason: 'Geplantes Update';
  phase: RestartPhase;
  farewellStatus: RestartNoticeStatus;
  welcomeStatus: RestartNoticeStatus;
  returnAllowed: boolean;
}

export const RESTART_GOODBYE_MESSAGES = [
  '🔧💜 Ich muss mal kurz meine Bits sortieren. Bin gleich wieder da!',
  '💤 Kurzes Bot-Nickerchen. Nicht ohne mich eskalieren!',
  '🤖 Einmal Schrauben nachziehen. Bin gleich zurück!',
  '🐱 Elio übernimmt kurz die Aufsicht. Was soll schon schiefgehen?',
] as const;

export const RESTART_WELCOME_MESSAGES = [
  '💜 Bin wieder da! Frisch poliert und bereit für neuen Unsinn. 🤖✨',
  '✨ Wieder wach! Hab ich was verpasst?',
  '🤖 Alle Schrauben wieder drin. Hoffentlich.',
  '🐾 Elio hat nichts kaputt gemacht. Glaube ich.',
  '💅 Zurück und schöner als vorher. Angeblich.',
] as const;

interface LifecycleSettings { enabled: boolean; lastPlannedAt: number; }

export class BotLifecycle {
  private startupChecked=false;
  constructor(private readonly store: FeatureStore) {}

  settings(): LifecycleSettings {
    const value=this.store.config<unknown>('bot_lifecycle_settings',{});
    const data=value&&typeof value==='object'?value as Record<string,unknown>:{};
    return {enabled:data.enabled===true,lastPlannedAt:typeof data.lastPlannedAt==='number'&&Number.isFinite(data.lastPlannedAt)?data.lastPlannedAt:0};
  }

  setEnabled(enabled:boolean):LifecycleSettings {
    if(typeof enabled!=='boolean')throw new Error('Bitte Ein oder Aus wählen.');
    return this.store.miniGameTransaction(db=>{
      const current=this.readSettings(db);this.write(db,'bot_lifecycle_settings',{...current,enabled});
      if(!enabled){const marker=this.readMarker(db);if(marker&&['armed','awaiting-return','returning'].includes(marker.phase))this.write(db,'bot_lifecycle_marker',{...marker,phase:'cancelled',welcomeStatus:'skipped'});}
      return this.readSettings(db);
    });
  }

  marker():PlannedRestartMarker|undefined {
    return this.readMarker();
  }

  private readMarker(db?:BetterSqlite3.Database):PlannedRestartMarker|undefined {
    const value=db?readConfig<unknown>(db,'bot_lifecycle_marker',null):this.store.config<unknown>('bot_lifecycle_marker',null);
    if(!value||typeof value!=='object')return undefined;
    const m=value as Record<string,unknown>;
    if(typeof m.id!=='string'||typeof m.plannedAt!=='number'||m.reason!=='Geplantes Update'
      ||!['armed','shutting-down','awaiting-return','returning','complete','cancelled'].includes(String(m.phase)))return undefined;
    return {id:m.id,plannedAt:m.plannedAt,reason:'Geplantes Update',phase:m.phase as RestartPhase,
      farewellStatus:isStatus(m.farewellStatus)?m.farewellStatus:'pending',welcomeStatus:isStatus(m.welcomeStatus)?m.welcomeStatus:'pending',returnAllowed:m.returnAllowed===true};
  }

  prepare(now=Date.now()):{ok:true;marker:PlannedRestartMarker}|{ok:false;error:string} {
    return this.store.miniGameTransaction(db=>{
      const settings=this.readSettings(db);
      if(!settings.enabled)return {ok:false as const,error:'Bot-Lebenszeichen sind ausgeschaltet.'};
      const current=this.readMarker(db);
      if(current&&['armed','shutting-down','awaiting-return','returning'].includes(current.phase)&&now-current.plannedAt<BOT_RESTART_MARKER_TTL_MS)
        return {ok:false as const,error:'Es ist bereits ein geplanter Neustart vorbereitet.'};
      if(settings.lastPlannedAt&&now-settings.lastPlannedAt<BOT_RESTART_COOLDOWN_MS)
        return {ok:false as const,error:`Neustart-Cooldown aktiv. Erneut möglich ab ${new Date(settings.lastPlannedAt+BOT_RESTART_COOLDOWN_MS).toLocaleString()}.`};
      const marker:PlannedRestartMarker={id:randomUUID(),plannedAt:now,reason:'Geplantes Update',phase:'armed',farewellStatus:'pending',welcomeStatus:'pending',returnAllowed:false};
      this.write(db,'bot_lifecycle_settings',{...settings,lastPlannedAt:now});this.write(db,'bot_lifecycle_marker',marker);
      return {ok:true as const,marker};
    });
  }

  beginShutdown(now=Date.now(),canSendFarewell=false):PlannedRestartMarker|undefined {
    return this.store.miniGameTransaction(db=>{
      const marker=this.readMarker(db);
      if(!this.readSettings(db).enabled||!marker||marker.phase!=='armed'||now-marker.plannedAt>BOT_RESTART_MARKER_TTL_MS){
        if(marker?.phase==='armed')this.write(db,'bot_lifecycle_marker',{...marker,phase:'cancelled',farewellStatus:'skipped',welcomeStatus:'skipped'});
        return undefined;
      }
      const next={...marker,phase:'shutting-down' as const,returnAllowed:canSendFarewell,...(!canSendFarewell?{farewellStatus:'skipped' as const}:{})};
      this.write(db,'bot_lifecycle_marker',next);return next;
    });
  }

  finishFarewell(id:string,status:'sent'|'failed'|'skipped'):void {
    this.store.miniGameTransaction(db=>{const marker=this.readMarker(db);if(!marker||marker.id!==id||marker.phase!=='shutting-down')return;
      this.write(db,'bot_lifecycle_marker',{...marker,farewellStatus:status,returnAllowed:marker.returnAllowed&&status!=='skipped'});});
  }

  completeShutdown(id:string):void {
    this.store.miniGameTransaction(db=>{const marker=this.readMarker(db);if(!marker||marker.id!==id||marker.phase!=='shutting-down')return;
      const allowed=this.readSettings(db).enabled&&marker.returnAllowed;
      this.write(db,'bot_lifecycle_marker',{...marker,phase:allowed?'awaiting-return':'cancelled',welcomeStatus:allowed?'pending':'skipped'});});
  }

  takeReturnCandidate(now=Date.now()):PlannedRestartMarker|undefined {
    if(this.startupChecked)return undefined;
    this.startupChecked=true;
    return this.store.miniGameTransaction(db=>{
      const marker=this.readMarker(db);
      if(marker?.phase==='armed'||marker?.phase==='shutting-down'){
        this.write(db,'bot_lifecycle_marker',{...marker,phase:'cancelled',farewellStatus:marker.phase==='armed'?'skipped':marker.farewellStatus,welcomeStatus:'skipped'});return undefined;
      }
      if(marker?.phase==='returning'){this.write(db,'bot_lifecycle_marker',{...marker,phase:'complete',welcomeStatus:'failed'});return undefined;}
      if(!marker||marker.phase!=='awaiting-return')return undefined;
      if(!this.readSettings(db).enabled){this.write(db,'bot_lifecycle_marker',{...marker,phase:'cancelled',welcomeStatus:'skipped'});return undefined;}
      if(now-marker.plannedAt>BOT_RESTART_MARKER_TTL_MS){this.write(db,'bot_lifecycle_marker',{...marker,phase:'cancelled',welcomeStatus:'skipped'});return undefined;}
      const claimed={...marker,phase:'returning' as const,welcomeStatus:'pending' as const};this.write(db,'bot_lifecycle_marker',claimed);return claimed;
    });
  }

  finishWelcome(id:string,status:'sent'|'failed'|'skipped'):void {
    this.store.miniGameTransaction(db=>{const marker=this.readMarker(db);if(!marker||marker.id!==id||marker.phase!=='returning')return;
      this.write(db,'bot_lifecycle_marker',{...marker,phase:'complete',welcomeStatus:status});});
  }

  private readSettings(db?:BetterSqlite3.Database):LifecycleSettings {
    const value=db?readConfig<unknown>(db,'bot_lifecycle_settings',{}):this.store.config<unknown>('bot_lifecycle_settings',{});
    const data=value&&typeof value==='object'?value as Record<string,unknown>:{};
    return {enabled:data.enabled===true,lastPlannedAt:typeof data.lastPlannedAt==='number'&&Number.isFinite(data.lastPlannedAt)?data.lastPlannedAt:0};
  }
  private write(db:BetterSqlite3.Database,key:string,value:unknown):void {
    db.prepare('INSERT INTO feature_config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
  }
}

function isStatus(value:unknown):value is RestartNoticeStatus { return value==='pending'||value==='sent'||value==='failed'||value==='skipped'; }
function readConfig<T>(db:BetterSqlite3.Database,key:string,fallback:T):T {
  const row=db.prepare('SELECT value FROM feature_config WHERE key=?').get(key) as {value:string}|undefined;
  if(!row)return fallback;try{return JSON.parse(row.value) as T;}catch{return fallback;}
}
