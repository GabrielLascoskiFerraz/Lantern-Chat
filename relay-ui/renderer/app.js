/* global window, document, navigator */
const $ = (id) => document.getElementById(id);
const api = window.relayUi;
const duration = (ms) => { const min=Math.floor(Math.max(0,ms)/60000), h=Math.floor(min/60), d=Math.floor(h/24); return d?`${d}d ${h%24}h`:h?`${h}h ${min%60}m`:`${min}m`; };
const render = (s) => {
  $('status-pill').className=`status-pill ${s.running?'online':'offline'}`; $('status-pill').textContent=s.running?'Online':'Offline';
  $('connection-summary').textContent=s.running?`${s.tls?'WSS':'WS local'} ativo na porta ${s.port} · ${s.peersOnline||0} conectado(s)`:'O Relay está parado.';
  $('metric-peers').textContent=String(s.peersOnline||0); $('metric-announcements').textContent=String(s.announcementsActive||0);
  $('metric-frames').textContent=String(s.centralStore?.frames||0); $('metric-uptime').textContent=s.running?duration(s.uptimeMs||0):'--';
  $('port-label').textContent=`Porta ${s.port||s.settings.port}`; $('port-input').value=String(s.settings.port||43190);
  $('cert-input').value=s.settings.tlsCertFile||''; $('key-input').value=s.settings.tlsKeyFile||'';
  $('start').disabled=s.running; $('restart').disabled=!s.running; $('stop').disabled=!s.running;
  $('addresses').replaceChildren(...(s.localAddresses||[]).map(ip=>{const b=document.createElement('button');b.className='address';b.textContent=`${s.tls?'wss':'ws'}://${ip}:${s.port||s.settings.port}`;b.onclick=()=>navigator.clipboard.writeText(b.textContent);return b;}));
  const users=$('users'); users.replaceChildren(); const peers=s.peers||[];
  if(!peers.length){const p=document.createElement('p');p.className='empty';p.textContent='Nenhum usuário conectado.';users.append(p);}
  peers.forEach(peer=>{const row=document.createElement('article');row.className='user';row.innerHTML=`<span class="avatar"></span><div><strong></strong><span></span></div>`;row.querySelector('.avatar').textContent=peer.avatarEmoji||'🙂';row.querySelector('strong').textContent=peer.displayName||peer.username||'Usuário';row.querySelector('div span').textContent=`@${peer.username||'usuário'} · ${peer.department||'Sem setor'}`;users.append(row);});
  $('users-count').textContent=`${peers.length} online`;
};
const request=async(fn)=>{try{$('feedback').textContent='';render(await fn());}catch(e){$('feedback').textContent=String(e?.message||e).replace(/^Error invoking remote method '[^']+': Error: /,'');}};
$('start').onclick=()=>request(api.start); $('restart').onclick=()=>request(api.restart); $('stop').onclick=()=>request(api.stop);
$('pick-cert').onclick=async()=>{const p=await api.pickCertificate();if(p)$('cert-input').value=p;}; $('pick-key').onclick=async()=>{const p=await api.pickPrivateKey();if(p)$('key-input').value=p;};
$('save-settings').onclick=()=>request(()=>api.updateSettings({port:Number($('port-input').value),tlsCertFile:$('cert-input').value,tlsKeyFile:$('key-input').value}));
request(api.status); setInterval(()=>request(api.status),3000);
