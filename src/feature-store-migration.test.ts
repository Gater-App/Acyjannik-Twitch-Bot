import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { FeatureStore } from './feature-store.js';

test('Migration 31 ergänzt Wheel-Gewinnerdaten aus v30, erhält laufende Runden und erstellt ein Backup', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-store-v31-'));
  const database = path.join(directory, 'data', 'state.sqlite');
  let store = new FeatureStore(database);

  try {
    store.miniGameTransaction(db => {
      db.prepare(`INSERT INTO chaos_wheel_challenges(id,title,weight,active,action_type,wheel_key)
        VALUES('v30-custom','Bestehendes Segment',3,1,'manual_challenge',NULL)`).run();
      db.prepare(`INSERT INTO chaos_wheel_spins(id,challenge_id,title,status,created_by,created_at,action_type)
        VALUES('v30-active','v30-custom','Bestehendes Segment','active','mod',123,'manual_challenge')`).run();
      db.exec('DROP TABLE recent_chat_activity');
      for (const column of ['winner_user_id', 'winner_name', 'result_label', 'reward_status', 'stream_id']) {
        db.exec(`ALTER TABLE chaos_wheel_spins DROP COLUMN ${column}`);
      }
      db.prepare("DELETE FROM chaos_wheel_challenges WHERE id IN ('wheel:viewer-xp','wheel:viewer-drop','wheel:honor','wheel:community-bonus','wheel:quest-luck','wheel:chaos-title','wheel:extra-spin')").run();
      db.prepare('DELETE FROM schema_migrations WHERE version>=31').run();
    });
  } finally {
    store.close();
  }

  store = new FeatureStore(database);
  try {
    const result = store.miniGameQuery(db => {
      const columns = new Set((db.prepare('PRAGMA table_info(chaos_wheel_spins)').all() as Array<{ name: string }>).map(column => column.name));
      const recentActivity = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='recent_chat_activity'").get() as { count: number };
      const spin = db.prepare("SELECT status,challenge_id FROM chaos_wheel_spins WHERE id='v30-active'").get() as { status: string; challenge_id: string };
      const segment = db.prepare("SELECT active,weight,action_type,wheel_key FROM chaos_wheel_challenges WHERE id='wheel:viewer-xp'").get() as { active: number; weight: number; action_type: string; wheel_key: string };
      const version = db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=31').get() as { count: number };
      return { columns, recentActivity, spin, segment, version };
    });

    for (const column of ['winner_user_id', 'winner_name', 'result_label', 'reward_status', 'stream_id']) assert.ok(result.columns.has(column), `${column} wurde ergänzt`);
    assert.equal(result.recentActivity.count, 1);
    assert.deepEqual(result.spin, { status: 'active', challenge_id: 'v30-custom' }, 'bestehende laufende Runde bleibt erhalten');
    assert.deepEqual(result.segment, { active: 0, weight: 1, action_type: 'manual_challenge', wheel_key: 'viewer_xp' }, 'neue Segmente bleiben standardmäßig deaktiviert');
    assert.equal(result.version.count, 1);
    assert.ok(fs.readdirSync(path.join(directory, 'backups')).some(name => name.includes('migration-v31-')), 'v31-Migration erstellt ein Vorab-Backup');
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
