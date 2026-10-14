import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCADE_CARD, ARCADE_SCRIPT, wheelSegments } from './dashboard-community-ui.js';
import { ELIO_STATUS_SCRIPT } from './dashboard-ux.js';

test('Dashboard bietet bei Elios Status einen verständlichen Persönlichkeitsschalter mit Vorschau',()=>{
  assert.match(ELIO_STATUS_SCRIPT,/id='pet-personality-toggle'/u);assert.match(ELIO_STATUS_SCRIPT,/Vorschau ansehen/u);
  assert.match(ELIO_STATUS_SCRIPT,/verändern weder Punkte noch Chat-Nachrichten/u);
  assert.match(ELIO_STATUS_SCRIPT,/petPersonalityEnabled/u);assert.match(ELIO_STATUS_SCRIPT,/p\.moodLabel/u);
  assert.doesNotMatch(ARCADE_CARD,/pet-personality-toggle/u);assert.doesNotMatch(ARCADE_SCRIPT,/pet-personality-toggle/u);
});

test('Chaos-Wheel-Segmente bilden Gewichte proportional und vollständig ab',()=>{
  const segments=wheelSegments([{id:'small',title:'Kleines Feld',weight:1},{id:'large',title:'Großes Feld',weight:3}]);
  assert.equal(segments.length,2);
  assert.equal(segments[0]?.startAngle,-90);
  assert.equal(segments[0]?.endAngle,0);
  assert.equal(segments[1]?.endAngle,270);
  assert.equal(segments[0]?.centerAngle,-45);
  assert.equal(segments[1]?.centerAngle,135);
  assert.equal(segments.at(-1)!.endAngle-segments[0]!.startAngle,360);
});

test('Chaos-Wheel ignoriert ungültige Gewichte und bleibt bei leerem Pool leer',()=>{
  assert.deepEqual(wheelSegments([{id:'bad',title:'Ungültig',weight:0},{id:'ok',title:'Gültig',weight:2}]).map(x=>x.id),['ok']);
  assert.deepEqual(wheelSegments([{id:'bad',title:'Ungültig',weight:-2}]),[]);
});
