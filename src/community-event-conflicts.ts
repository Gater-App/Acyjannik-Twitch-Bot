import type BetterSqlite3 from 'better-sqlite3';

/** A feature toggle is configuration, not a running game. Only persisted, live sessions belong here. */
export interface ActiveCommunityEventConflict {
  type:string;
  id:string;
  label:string;
}

/**
 * The shared compatibility gate for chat-based community games. Keep this query
 * aligned with the event lifecycle tables; seasonal_events is deliberately not
 * included because it stores an enabled season, not an active round.
 */
export function findActiveCommunityEventConflict(db:BetterSqlite3.Database):ActiveCommunityEventConflict|undefined {
  return db.prepare(`WITH running(priority,type,id,label) AS (
    SELECT 1,'community-chaos',id,'Community-Chaos' FROM community_chaos_events WHERE status='active'
    UNION ALL SELECT 2,kind,id,CASE kind WHEN 'battle' THEN 'Twitch-vs.-Discord-Battle' WHEN 'mystery_case' THEN 'Mystery-Koffer' WHEN 'elio_rescue' THEN 'Elio-Event' WHEN 'secret_portal' THEN 'Geheimes Portal' ELSE 'Community-Event' END FROM community_interactive_events WHERE status='open' AND kind!='game_night'
    UNION ALL SELECT 3,'mystery-drop',id,'Mystery Drop' FROM mystery_drops WHERE status IN ('announced','claiming','resolving')
    UNION ALL SELECT 4,'chaos-wheel',id,'Chaos Wheel' FROM chaos_wheel_spins WHERE status IN ('spinning','active')
    UNION ALL SELECT 5,'boss',id,'Community-Boss' FROM boss_fights WHERE status='active'
    UNION ALL SELECT 6,'poll',id,'Live-Abstimmung' FROM polls WHERE status='active'
    UNION ALL SELECT 7,'imposter',id,'Chat-Imposter' FROM imposter_rounds WHERE phase IN ('registration','role_distribution','playing','voting')
    UNION ALL SELECT 8,'detective',id,'Chat-Detektiv' FROM detective_rounds WHERE phase IN ('playing','results')
    UNION ALL SELECT 9,'community-vault',id,'Community-Tresor' FROM community_vault_rounds WHERE status='active'
    UNION ALL SELECT 10,'community-quest',id,'Community-Quest' FROM quests WHERE status='active'
  ) SELECT type,id,label FROM running ORDER BY priority LIMIT 1`).get() as ActiveCommunityEventConflict|undefined;
}

export function communityConflictMessage(conflict:ActiveCommunityEventConflict):string {
  return `Ein inkompatibles Community-Spiel läuft bereits: ${conflict.label}.`;
}
