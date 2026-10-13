import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_HELP_AVAILABILITY } from './help.js';
import { renderPublicHelpPage } from './public-help.js';

test('öffentliche Hilfe zeigt deaktivierte Spiele ohne Mitmachbefehle und bleibt mobilfähig',()=>{
  const html=renderPublicHelpPage(DEFAULT_HELP_AVAILABILITY,'','nonce-test');
  assert.match(html,/name="viewport"/u);
  assert.match(html,/@media\(max-width:520px\)/u);
  assert.match(html,/Mystery Drops/u);
  assert.match(html,/Derzeit deaktiviert/u);
  assert.doesNotMatch(html,/<code>!claim<\/code>/u);
  assert.doesNotMatch(html,/<script\b/iu,'die öffentliche Seite enthält keine Skripte');
});

test('öffentliche Hilfe zeigt aktivierte Befehle, funktioniert als Suchergebnis und escaped Daten',()=>{
  const state={...DEFAULT_HELP_AVAILABILITY,drops:true,seasonalEvents:[{id:'halloween',name:'<img src=x>',command:'trickortreat',active:true}]};
  const html=renderPublicHelpPage(state,'!claim','nonce-test');
  assert.match(html,/<code>!claim<\/code>/u);
  assert.doesNotMatch(html,/XP &amp; Level/u);
  const escaped=renderPublicHelpPage(state,'','nonce-test');
  assert.match(escaped,/&lt;img src=x&gt;/u);
  assert.doesNotMatch(escaped,/<img src=x>/u);
});
