export const EIGHT_BALL_SETTINGS_SCRIPT = `(()=>{
const root=document.querySelector('[data-setting-page="functions"] .view-grid');if(!root||root.querySelector('[data-eight-ball-settings]'))return;
for(const label of document.querySelectorAll('#modules label'))if(/eightball/iu.test(label.textContent||'')){label.hidden=true;label.style.display='none';label.setAttribute('aria-hidden','true')}
const card=document.createElement('article');card.className='card';card.dataset.eightBallSettings='true';
const title=document.createElement('h2');title.textContent='🎱 Magic 8-Ball';
const intro=document.createElement('p');intro.className='muted';intro.textContent='Kurze Ja/Nein/ Vielleicht-Antworten mit fairer Verteilung und sichtbarer Wartezeit.';
const form=document.createElement('form');form.id='eight-ball-form';
const enabledLabel=document.createElement('label'),enabled=document.createElement('input');enabled.type='checkbox';enabled.name='enabled';enabledLabel.append(enabled,document.createTextNode(' 8-Ball aktivieren'));
const personalLabel=document.createElement('label'),personalCaption=document.createElement('span'),personal=document.createElement('input');personalCaption.textContent='Persönliche Wartezeit (Sekunden)';personal.type='number';personal.name='personalCooldownSeconds';personal.min='0';personal.max='3600';personal.required=true;personalLabel.append(personalCaption,personal);
const globalLabel=document.createElement('label'),globalCaption=document.createElement('span'),global=document.createElement('input');globalCaption.textContent='Wartezeit für den ganzen Chat (Sekunden)';global.type='number';global.name='globalCooldownSeconds';global.min='0';global.max='60';global.required=true;globalLabel.append(globalCaption,global);
const noticeLabel=document.createElement('label'),notices=document.createElement('input');notices.type='checkbox';notices.name='cooldownNotices';noticeLabel.append(notices,document.createTextNode(' Cooldown-Hinweis für dich anzeigen'));
const distribution=document.createElement('p');distribution.className='muted';distribution.textContent='Antwortverteilung: 40 % JA · 40 % NEIN · 20 % VIELLEICHT';
const last=document.createElement('p');last.className='muted';last.setAttribute('aria-live','polite');
const feedback=document.createElement('p');feedback.className='muted';feedback.setAttribute('aria-live','polite');
const actions=document.createElement('div');actions.className='row';const save=document.createElement('button');save.type='submit';save.textContent='Einstellungen speichern';const preview=document.createElement('button');preview.type='button';preview.className='secondary';preview.textContent='Sichere Antwort-Vorschau';actions.append(save,preview);
form.append(enabledLabel,personalLabel,globalLabel,noticeLabel,distribution,last,feedback,actions);card.append(title,intro,form);root.append(card);
async function refresh(){const d=await api('eight-ball');enabled.checked=d.enabled;personal.value=String(Math.round(d.settings.personalCooldownMs/1000));global.value=String(Math.round(d.settings.globalCooldownMs/1000));notices.checked=d.settings.cooldownNotices;last.textContent=d.lastUsedAt?'Zuletzt erfolgreich genutzt: '+new Date(d.lastUsedAt).toLocaleString():'Noch keine erfolgreiche Nutzung erfasst.'}
form.onsubmit=async e=>{e.preventDefault();save.disabled=true;feedback.textContent='Speichere …';try{const d=await api('eight-ball','POST',{enabled:enabled.checked,personalCooldownSeconds:Number(personal.value),globalCooldownSeconds:Number(global.value),cooldownNotices:notices.checked});feedback.textContent=d.message||'Gespeichert.';await refresh()}catch(error){feedback.textContent=error.message||'Speichern fehlgeschlagen.'}finally{save.disabled=false}};
preview.onclick=async()=>{preview.disabled=true;try{const d=await api('eight-ball/preview');feedback.textContent='Vorschau (wird nicht in Twitch gesendet): '+d.answer}catch(error){feedback.textContent=error.message||'Vorschau nicht verfügbar.'}finally{preview.disabled=false}};
refresh().catch(error=>{feedback.textContent=error.message||'Einstellungen konnten nicht geladen werden.'});
})();`;
