const $ = (id) => document.getElementById(id);
const api = window.relayUi;

const supportedLocale = (() => {
  const language = (navigator.language || 'en').toLowerCase();
  if (language.startsWith('pt')) return 'pt-BR';
  if (language.startsWith('es')) return 'es';
  if (language.startsWith('fr')) return 'fr';
  return 'en';
})();

const dictionaries = {
  'pt-BR': {
    networkBridge: 'Ponte de rede', startRelay: 'Iniciar Relay', restart: 'Reiniciar', stop: 'Parar',
    manualConnection: 'Conexão manual', manualConnectionHelp: 'Use um destes IPs locais nos clientes Lantern quando a descoberta automática não estiver disponível.',
    connectedUsers: 'Usuários conectados', activeAnnouncements: 'Anúncios ativos', retainedAttachments: 'Anexos mantidos', uptime: 'Tempo ativo',
    relaySettings: 'Ajustes do Relay', savedAutomatically: 'Salvo automaticamente', port: 'Porta', announcementExpiration: 'Expiração dos anúncios (horas)',
    applySettings: 'Aplicar ajustes', settingsHelp: 'Alterar a porta reinicia o Relay. Alterar a expiração também atualiza os anúncios ativos.',
    startWithSystem: 'Iniciar Relay com o sistema', startWithSystemHelp: 'Inicia o Relay automaticamente após o login deste usuário.', startWithSystemUnavailable: 'Disponível apenas no Relay empacotado neste sistema.',
    noUsers: 'Nenhum usuário conectado.', online: 'Online', offline: 'Offline', listening: 'Escutando na porta {port} · {count} conectado(s)',
    relayStopped: 'O Relay está parado. Inicie-o para aceitar clientes Lantern.', noLocalAddress: 'Nenhum endereço IPv4 local encontrado.',
    copyAddress: 'Copiar endereço', unknownUser: 'Usuário desconhecido', available: 'Disponível', onlineFor: 'Online há {duration}',
    actionFailed: 'A ação do Relay falhou.', onlineCount: '{count} online'
  },
  en: {
    networkBridge: 'Network bridge', startRelay: 'Start Relay', restart: 'Restart', stop: 'Stop',
    manualConnection: 'Manual connection', manualConnectionHelp: 'Use one of these local IP addresses in Lantern clients when automatic discovery is unavailable.',
    connectedUsers: 'Connected users', activeAnnouncements: 'Active announcements', retainedAttachments: 'Attachments retained', uptime: 'Uptime',
    relaySettings: 'Relay settings', savedAutomatically: 'Saved automatically', port: 'Port', announcementExpiration: 'Announcement expiration (hours)',
    applySettings: 'Apply settings', settingsHelp: 'Changing the port restarts the Relay. Changing expiration updates active announcements too.',
    startWithSystem: 'Start Relay with the system', startWithSystemHelp: 'Starts the Relay automatically after this user signs in.', startWithSystemUnavailable: 'Available only in the packaged Relay on this system.',
    noUsers: 'No users connected.', online: 'Online', offline: 'Offline', listening: 'Listening on port {port} · {count} connected',
    relayStopped: 'Relay is stopped. Start it to accept Lantern clients.', noLocalAddress: 'No local IPv4 address found.',
    copyAddress: 'Copy address', unknownUser: 'Unknown user', available: 'Available', onlineFor: 'Online for {duration}',
    actionFailed: 'Relay action failed.', onlineCount: '{count} online'
  },
  es: {
    networkBridge: 'Puente de red', startRelay: 'Iniciar Relay', restart: 'Reiniciar', stop: 'Detener',
    manualConnection: 'Conexión manual', manualConnectionHelp: 'Usa una de estas direcciones IP locales en los clientes Lantern cuando la detección automática no esté disponible.',
    connectedUsers: 'Usuarios conectados', activeAnnouncements: 'Anuncios activos', retainedAttachments: 'Archivos adjuntos conservados', uptime: 'Tiempo activo',
    relaySettings: 'Ajustes del Relay', savedAutomatically: 'Guardado automáticamente', port: 'Puerto', announcementExpiration: 'Expiración de anuncios (horas)',
    applySettings: 'Aplicar ajustes', settingsHelp: 'Cambiar el puerto reinicia el Relay. Cambiar la expiración también actualiza los anuncios activos.',
    startWithSystem: 'Iniciar Relay con el sistema', startWithSystemHelp: 'Inicia el Relay automáticamente después de que este usuario inicie sesión.', startWithSystemUnavailable: 'Disponible solo en el Relay empaquetado en este sistema.',
    noUsers: 'No hay usuarios conectados.', online: 'En línea', offline: 'Sin conexión', listening: 'Escuchando en el puerto {port} · {count} conectado(s)',
    relayStopped: 'El Relay está detenido. Inícialo para aceptar clientes Lantern.', noLocalAddress: 'No se encontró una dirección IPv4 local.',
    copyAddress: 'Copiar dirección', unknownUser: 'Usuario desconocido', available: 'Disponible', onlineFor: 'En línea desde hace {duration}',
    actionFailed: 'La acción del Relay falló.', onlineCount: '{count} en línea'
  },
  fr: {
    networkBridge: 'Passerelle réseau', startRelay: 'Démarrer le Relay', restart: 'Redémarrer', stop: 'Arrêter',
    manualConnection: 'Connexion manuelle', manualConnectionHelp: 'Utilisez l’une de ces adresses IP locales dans les clients Lantern lorsque la découverte automatique est indisponible.',
    connectedUsers: 'Utilisateurs connectés', activeAnnouncements: 'Annonces actives', retainedAttachments: 'Pièces jointes conservées', uptime: 'Temps de fonctionnement',
    relaySettings: 'Paramètres du Relay', savedAutomatically: 'Enregistré automatiquement', port: 'Port', announcementExpiration: 'Expiration des annonces (heures)',
    applySettings: 'Appliquer les paramètres', settingsHelp: 'Modifier le port redémarre le Relay. Modifier l’expiration met aussi à jour les annonces actives.',
    startWithSystem: 'Démarrer le Relay avec le système', startWithSystemHelp: 'Démarre automatiquement le Relay après la connexion de cet utilisateur.', startWithSystemUnavailable: 'Disponible uniquement dans le Relay empaqueté sur ce système.',
    noUsers: 'Aucun utilisateur connecté.', online: 'En ligne', offline: 'Hors ligne', listening: 'Écoute sur le port {port} · {count} connecté(s)',
    relayStopped: 'Le Relay est arrêté. Démarrez-le pour accepter les clients Lantern.', noLocalAddress: 'Aucune adresse IPv4 locale trouvée.',
    copyAddress: 'Copier l’adresse', unknownUser: 'Utilisateur inconnu', available: 'Disponible', onlineFor: 'En ligne depuis {duration}',
    actionFailed: 'L’action du Relay a échoué.', onlineCount: '{count} en ligne'
  }
};

const t = (key, params = {}) => (dictionaries[supportedLocale][key] || dictionaries.en[key] || key)
  .replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));

document.documentElement.lang = supportedLocale;
document.querySelectorAll('[data-i18n]').forEach((element) => {
  element.textContent = t(element.dataset.i18n);
});

const text = (id, value) => { $(id).textContent = value; };
const duration = (ms) => {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days) return `${days}d ${hours % 24}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
};

const render = (snapshot) => {
  const running = Boolean(snapshot.running);
  const pill = $('status-pill');
  pill.className = `status-pill ${running ? 'online' : 'offline'}`;
  pill.textContent = running ? t('online') : t('offline');
  text('connection-summary', running ? t('listening', { port: snapshot.port, count: snapshot.peersOnline }) : t('relayStopped'));
  text('port-label', `${t('port')} ${snapshot.port}`);
  text('metric-peers', String(snapshot.peersOnline || 0));
  text('metric-announcements', String(snapshot.announcementsActive || 0));
  text('metric-files', String(snapshot.transferMetrics?.retainedFiles || 0));
  text('metric-uptime', running ? duration(snapshot.uptimeMs || 0) : '--');
  $('port-input').value = String(snapshot.settings.port || 43190);
  $('ttl-input').value = String(snapshot.settings.announcementTtlHours || 24);
  const autoStart = snapshot.autoStart || { supported: false, enabled: false };
  $('auto-start-input').checked = Boolean(autoStart.enabled);
  $('auto-start-input').disabled = !autoStart.supported;
  text('auto-start-help', autoStart.supported ? t('startWithSystemHelp') : t('startWithSystemUnavailable'));
  $('start').disabled = running;
  $('restart').disabled = !running;
  $('stop').disabled = !running;
  const addresses = $('addresses');
  addresses.replaceChildren();
  const ips = snapshot.localAddresses || [];
  if (!ips.length) {
    const empty = document.createElement('span');
    empty.className = 'empty';
    empty.textContent = t('noLocalAddress');
    addresses.appendChild(empty);
  }
  for (const ip of ips) {
    const button = document.createElement('button');
    button.className = 'address';
    button.textContent = `${ip}:${snapshot.port}`;
    button.title = t('copyAddress');
    button.onclick = () => navigator.clipboard?.writeText(`${ip}:${snapshot.port}`);
    addresses.appendChild(button);
  }
  const users = $('users');
  users.replaceChildren();
  const peers = snapshot.peers || [];
  if (!peers.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = t('noUsers');
    users.appendChild(empty);
  }
  for (const peer of peers) {
    const row = document.createElement('article');
    row.className = 'user';
    const avatar = document.createElement('span');
    avatar.className = 'avatar'; avatar.style.background = peer.avatarBg || '#146eb4'; avatar.textContent = peer.avatarEmoji || '•';
    const details = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = peer.displayName || t('unknownUser');
    const status = document.createElement('span');
    status.textContent = `${peer.statusMessage || t('available')} · ${peer.deviceShort}`;
    details.append(name, status);
    const seen = document.createElement('span'); seen.className = 'seen'; seen.textContent = t('onlineFor', { duration: duration(peer.onlineForMs || 0) });
    row.append(avatar, details, seen); users.appendChild(row);
  }
  text('users-count', t('onlineCount', { count: peers.length }));
};

const request = async (action) => {
  try { render(await action()); } catch (error) { text('connection-summary', error?.message || t('actionFailed')); }
};
$('start').onclick = () => request(api.start);
$('restart').onclick = () => request(api.restart);
$('stop').onclick = () => request(api.stop);
$('save-settings').onclick = () => request(() => api.updateSettings({
  port: Number($('port-input').value),
  announcementTtlHours: Number($('ttl-input').value)
}));
$('auto-start-input').onchange = () => request(() => api.setAutoStart($('auto-start-input').checked));
const refresh = () => request(api.status);
refresh(); setInterval(refresh, 2500);
