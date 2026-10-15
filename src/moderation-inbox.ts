import type { ModerationInboxArea, ModerationInboxEntry, ModerationInboxSnapshot } from './feature-store.js';

const AREA_LABELS: Record<ModerationInboxArea, string> = {
  memories: 'Erinnerungswand',
  ideas: 'Community-Ideen',
  quests: 'Community-Quests',
  'chat-ideas': 'Chat-Ideen',
  quotes: 'Detektiv-Zitate',
  vip: 'VIP-Chaos',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Wartet auf Prüfung',
  reviewing: 'In Prüfung',
};

export interface ModerationInboxItem extends ModerationInboxEntry {
  label: string;
  statusLabel: string;
  href: string;
}

export function moderationInboxPage(csrf: string, nonce: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf" content="${csrf}"><meta name="theme-color" content="#11131b"><title>Moderationsübersicht · ACY</title><style nonce="${nonce}">:root{color-scheme:dark;font:16px/1.5 system-ui,sans-serif;background:#11131b;color:#f2f0f8}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 84% 0,#30234a 0,transparent 36%),#11131b}main{max-width:980px;margin:auto;padding:clamp(14px,3vw,30px)}header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}h1{font-size:1.5rem;margin:.2em 0}a{color:#d2baff}button,select{font:inherit;color:inherit;background:#252432;border:1px solid #4b465c;border-radius:10px;padding:10px 12px;min-height:44px}button{cursor:pointer;background:#6747a0}.summary{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:16px 0}.total{font-size:1.15rem;font-weight:750}.counts{display:flex;gap:7px;flex-wrap:wrap}.count{border:1px solid #39364a;background:#1b1d29;border-radius:999px;padding:5px 10px;color:#d5d0df;font-size:.9rem}.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}.list{display:grid;gap:9px}.task{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;border:1px solid #343546;background:#1b1d29;border-radius:13px;padding:12px 14px}.task strong,.task small{display:block}.task small{color:#b5b4c4}.task a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:8px 13px;border-radius:9px;background:#302344;border:1px solid #594477;text-decoration:none;font-weight:650}.notice{min-height:1.5em;color:#d7c0ff}.empty{border:1px dashed #454457;border-radius:12px;padding:18px;color:#b9b7c6}.task a:focus-visible,button:focus-visible,select:focus-visible{outline:3px solid #d7bdff;outline-offset:2px}@media(max-width:520px){.task{grid-template-columns:1fr}.task a{width:100%}.toolbar select{width:100%}.toolbar label{flex:1 1 100%}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation-duration:.01ms!important;transition-duration:.01ms!important}}</style></head><body><main><header><div><a href="/dashboard">← Dashboard</a><h1>Moderationsübersicht</h1><p class="notice">Offene Aufgaben, nach Bereich filterbar. Inhalte bleiben in den jeweiligen Moderationsseiten.</p></div><button id="refresh" type="button">Aktualisieren</button></header><section aria-label="Offene Aufgaben"><div class="summary"><div id="total" class="total" aria-live="polite">Wird geladen …</div><div id="counts" class="counts"></div></div><div class="toolbar"><label for="area-filter">Bereich</label><select id="area-filter"><option value="all">Alle Bereiche</option></select><span id="updated" class="notice"></span></div><p class="notice">Zähler umfassen alle offenen Aufgaben; angezeigt werden die neuesten 100 je Bereich.</p><p id="status" class="notice" role="status" aria-live="polite"></p><div id="inbox-list" class="list" aria-live="polite"></div></section></main><script nonce="${nonce}">(()=>{const labels=${JSON.stringify(AREA_LABELS)},statusLabels=${JSON.stringify(STATUS_LABELS)},filter=document.querySelector('#area-filter'),list=document.querySelector('#inbox-list'),status=document.querySelector('#status'),counts=document.querySelector('#counts');for(const [key,label] of Object.entries(labels)){const option=document.createElement('option');option.value=key;option.textContent=label;filter.append(option)}let items=[];function render(){const selected=filter.value,visible=items.filter(x=>selected==='all'||x.area===selected);list.replaceChildren();if(!visible.length){const empty=document.createElement('p');empty.className='empty';empty.textContent=items.length?'In diesem Bereich sind keine offenen Aufgaben.':'Alles erledigt. Es warten gerade keine Moderationsaufgaben.';list.append(empty);return}for(const item of visible){const row=document.createElement('article'),copy=document.createElement('div'),title=document.createElement('strong'),meta=document.createElement('small'),link=document.createElement('a');row.className='task';title.textContent=item.label+' · #'+item.id.slice(0,8);meta.textContent=item.statusLabel+' · '+new Date(item.createdAt).toLocaleString('de-DE');copy.append(title,meta);link.href=item.href;link.textContent='Aufgabe öffnen';link.setAttribute('aria-label',item.label+' öffnen, Status: '+item.statusLabel);row.append(copy,link);list.append(row)}}async function load(){status.textContent='Aufgaben werden aktualisiert …';try{const response=await fetch('/dashboard/api/moderation/inbox',{cache:'no-store'}),data=await response.json().catch(()=>({error:'Serverantwort konnte nicht gelesen werden.'}));if(!response.ok)throw Error(data.error||'Moderationsübersicht nicht verfügbar.');items=data.items||[];document.querySelector('#total').textContent=data.total+' offene '+(data.total===1?'Aufgabe':'Aufgaben');counts.replaceChildren();for(const [key,count] of Object.entries(data.counts)){if(!count)continue;const pill=document.createElement('span');pill.className='count';pill.textContent=labels[key]+' · '+count;counts.append(pill)}document.querySelector('#updated').textContent='Zuletzt aktualisiert '+new Date(data.updatedAt).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit',second:'2-digit'});status.textContent='';render()}catch(error){status.textContent=error instanceof Error?error.message:'Moderationsübersicht nicht verfügbar.'}}filter.addEventListener('change',render);document.querySelector('#refresh').addEventListener('click',load);load();window.dashboardPoll('#inbox-list',load,20000)})();</script></body></html>`;
}

export function moderationInboxData(snapshot: ModerationInboxSnapshot, role: 'admin' | 'moderator'): { total: number; counts: Record<string, number>; items: ModerationInboxItem[]; updatedAt: number } {
  const moderatorAreas = new Set<ModerationInboxArea>(['memories', 'ideas', 'vip']);
  const labels = AREA_LABELS;
  const visible = snapshot.items.filter((item) => role === 'admin' || moderatorAreas.has(item.area));
  const allowedCounts = Object.fromEntries(Object.entries(snapshot.counts).filter(([area]) => role === 'admin' || moderatorAreas.has(area as ModerationInboxArea)));
  const hrefFor = (item: ModerationInboxEntry): string => {
    const focus = encodeURIComponent(item.id);
    if (item.area === 'ideas') return `/dashboard/ideas?focus=${focus}&status=${encodeURIComponent(item.status)}`;
    if (item.area === 'memories') return `/dashboard/memories?focus=${focus}`;
    if (item.area === 'quests') return `/dashboard?focus=${focus}#community/quests`;
    if (item.area === 'chat-ideas') return `/dashboard?focus=${focus}#community/spark`;
    if (item.area === 'quotes') return `/dashboard?focus=${focus}#games/detective`;
    return role === 'moderator' ? '/dashboard?focus=vip-moderation#vip-moderation' : '/dashboard?focus=vip-moderation#community/vip';
  };
  const items = visible.map((item) => ({
    ...item,
    label: labels[item.area],
    statusLabel: STATUS_LABELS[item.status] || item.status,
    href: hrefFor(item),
  }));
  return { total: Object.values(allowedCounts).reduce((sum, count) => sum + count, 0), counts: allowedCounts, items, updatedAt: Date.now() };
}
