import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { ELIO_2_CARD, ELIO_2_SCRIPT } from '../src/elio-2-ui.js';

test('Elio 2.0 controls show unlocks on mobile and save only the selected outfit or bounded bonus settings',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:390,height:844}}),requests:Array<{path:string;method:string;body:unknown}> = [];
    await page.setContent(`${ELIO_2_CARD}<script>window.show=()=>{};window.api=async(path,method='GET',body)=>{window.__requests=window.__requests||[];window.__requests.push({path,method,body});if(method==='GET')return {settings:{petMilestoneBonusEnabled:false,petMilestoneBonusXp:5},interactiveFeatures:{elio2Enabled:true},pet:{name:'Elio',level:2,moodLabel:'😻 Glücklich',hunger:70,happiness:80,energy:60,outfit:{id:'classic',label:'Klassischer Elio',emoji:'🐱'},unlockedOutfits:[{id:'classic',label:'Klassischer Elio',emoji:'🐱',unlockLevel:1,unlocked:true},{id:'gaming',label:'Gaming-Elio',emoji:'🎮🐱',unlockLevel:2,unlocked:true},{id:'king',label:'König Elio',emoji:'👑🐱',unlockLevel:10,unlocked:false}]},petStats:{total:12,activeUsers:4}};return {ok:true}};</script><script>${ELIO_2_SCRIPT}</script>`);
    await page.getByText(/Community-Level 2/u).waitFor();
    assert.equal(await page.locator('#elio-2-outfit option').count(),3);
    assert.equal(await page.locator('#elio-2-bonus-enabled').isChecked(),false);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Elio module does not overflow a phone-sized viewport');
    await page.locator('#elio-2-outfit').selectOption('gaming');await page.locator('#elio-2-outfit-save').click();
    await page.locator('[data-elio-2] details summary').click();
    await page.locator('#elio-2-bonus-enabled').check();await page.locator('#elio-2-bonus-xp').fill('7');await page.locator('#elio-2-bonus-save').click();
    requests.push(...await page.evaluate(()=>window.__requests));
    assert.ok(requests.some(request=>request.path==='arcade'&&request.method==='POST'&&(request.body as {action?:string})?.action==='pet-outfit'));
    const bonus=requests.find(request=>request.path==='arcade'&&request.method==='POST'&&(request.body as {settings?:unknown})?.settings) as {body:{settings:{petMilestoneBonusEnabled:boolean;petMilestoneBonusXp:number}}}|undefined;
    assert.equal(bonus?.body.settings.petMilestoneBonusEnabled,true);assert.equal(bonus?.body.settings.petMilestoneBonusXp,7);
  }finally{await browser.close();}
});
