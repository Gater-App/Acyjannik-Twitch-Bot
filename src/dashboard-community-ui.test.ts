import assert from 'node:assert/strict';
import test from 'node:test';
import { wheelSegments } from './dashboard-community-ui.js';

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
