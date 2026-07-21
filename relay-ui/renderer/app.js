const $ = (id) => document.getElementById(id);
const api = window.relayUi;

const locale = (() => {
  const value = (navigator.language || 'en').toLowerCase();
  if (value.startsWith('pt')) return 'pt-BR';
  if (value.startsWith('es')) return 'es';
  if (value.startsWith('fr')) return 'fr';
  return 'en';
})();

const dictionaries = {
  en: {
    server: 'Server', overview: 'Overview', activity: 'Activity', connection: 'Connection', relayReady: 'Relay ready', relayOverview: 'Relay overview', loadingStatus: 'Loading Relay status...',
    online: 'Online', offline: 'Offline', operation: 'Operation', updating: 'Updating...', relayStoppedTitle: 'Relay stopped', relayStoppedDetail: 'Start the server to accept connections.',
    startRelay: 'Start Relay', restart: 'Restart', stop: 'Stop', onlineUsers: 'Online users', activeAnnouncements: 'Active announcements', retainedAttachments: 'Attachments retained', transfers: 'Transfers', stickers: 'Stickers', relayCatalog: 'Relay catalog', uptime: 'Uptime',
    realTime: 'Real time', connectedUsers: 'Connected users', connectedUsersHelp: 'One entry for every active Relay connection.', activeAnnouncementsHelp: 'Messages remain available until their configured expiration.', network: 'Network', connectionAndSettings: 'Connection and settings', localWs: 'Local WS',
    availableAddresses: 'Available addresses', availableAddressesHelp: 'Select an address to copy it.', localNetwork: 'Local network', localNetworkHelp: 'Use this address in Lantern clients when automatic discovery is unavailable.', relaySettings: 'Relay settings', relaySettingsHelp: 'Port changes restart the Relay when it is active.', port: 'Port', announcementExpiration: 'Announcement expiration (hours)',
    startWithSystem: 'Start Relay with the system', startWithSystemHelp: 'Starts the Relay automatically after this user signs in.', startWithSystemUnavailable: 'Available only in the packaged Relay on this system.', settingsSaved: 'Settings saved', applySettings: 'Apply settings',
    relayOnline: 'Relay online', relayOffline: 'Relay offline', connectionRunning: 'Local WS · port {port} · {count} active session(s)', connectionStopped: 'The server is stopped and does not accept connections.', operationRunning: 'Relay running', operationRunningDetail: 'Serving Lantern clients · started at {time}',
    activeSessions: '{count} active session(s)', expiresInHours: 'Expires after {hours}h', stored: '{size} stored', noFailures: 'No failures', failures: '{count} failure(s)', startedAt: 'Started at {time}', updatedAt: 'Updated at {time}',
    copy: 'Copy', copied: 'Copied', addressCopied: 'Address copied to the clipboard.', noLocalAddress: 'No local network address found.', noUsers: 'Nobody online', noUsersDetail: 'Connections will appear here.', noAnnouncements: 'No announcements', noAnnouncementsDetail: 'New announcements will appear here.',
    available: 'Available', onlineFor: 'Online for {duration}', settingsPending: 'Changes have not been applied yet', invalidPort: 'Enter a port between 1 and 65535.', settingsApplied: 'Settings applied.', relayStarted: 'Relay started.', relayRestarted: 'Relay restarted.', relayStopped: 'Relay stopped.', actionFailed: 'Relay action failed.'
  },
  'pt-BR': {
    server: 'Servidor', overview: 'Visão geral', activity: 'Atividade', connection: 'Conexão', relayReady: 'Relay pronto', relayOverview: 'Visão geral do Relay', loadingStatus: 'Carregando estado do Relay...',
    online: 'Online', offline: 'Offline', operation: 'Operação', updating: 'Atualizando...', relayStoppedTitle: 'Relay parado', relayStoppedDetail: 'Inicie o servidor para aceitar conexões.',
    startRelay: 'Iniciar Relay', restart: 'Reiniciar', stop: 'Parar', onlineUsers: 'Usuários online', activeAnnouncements: 'Anúncios ativos', retainedAttachments: 'Anexos mantidos', transfers: 'Transferências', stickers: 'Figurinhas', relayCatalog: 'Catálogo do Relay', uptime: 'Tempo ativo',
    realTime: 'Tempo real', connectedUsers: 'Usuários conectados', connectedUsersHelp: 'Uma entrada para cada conexão ativa no Relay.', activeAnnouncementsHelp: 'Mensagens ficam disponíveis até a expiração configurada.', network: 'Rede', connectionAndSettings: 'Conexão e ajustes', localWs: 'WS local',
    availableAddresses: 'Endereços disponíveis', availableAddressesHelp: 'Selecione um endereço para copiá-lo.', localNetwork: 'Rede local', localNetworkHelp: 'Use este endereço nos clientes Lantern quando a descoberta automática não estiver disponível.', relaySettings: 'Ajustes do Relay', relaySettingsHelp: 'Alterar a porta reinicia o Relay quando ele está ativo.', port: 'Porta', announcementExpiration: 'Expiração dos anúncios (horas)',
    startWithSystem: 'Iniciar Relay com o sistema', startWithSystemHelp: 'Inicia o Relay automaticamente após o login deste usuário.', startWithSystemUnavailable: 'Disponível apenas no Relay empacotado neste sistema.', settingsSaved: 'Ajustes salvos', applySettings: 'Aplicar ajustes',
    relayOnline: 'Relay online', relayOffline: 'Relay offline', connectionRunning: 'WS local · porta {port} · {count} sessão(ões) ativa(s)', connectionStopped: 'O servidor está parado e não aceita conexões.', operationRunning: 'Relay em operação', operationRunningDetail: 'Atendendo clientes Lantern · iniciado às {time}',
    activeSessions: '{count} sessão(ões) ativa(s)', expiresInHours: 'Expiram após {hours}h', stored: '{size} armazenados', noFailures: 'Nenhuma falha', failures: '{count} falha(s)', startedAt: 'Iniciado às {time}', updatedAt: 'Atualizado às {time}',
    copy: 'Copiar', copied: 'Copiado', addressCopied: 'Endereço copiado para a área de transferência.', noLocalAddress: 'Nenhum endereço de rede local encontrado.', noUsers: 'Ninguém online', noUsersDetail: 'As conexões aparecerão aqui.', noAnnouncements: 'Nenhum anúncio', noAnnouncementsDetail: 'Novos anúncios aparecerão aqui.',
    available: 'Disponível', onlineFor: 'Online há {duration}', settingsPending: 'Alterações ainda não aplicadas', invalidPort: 'Informe uma porta entre 1 e 65535.', settingsApplied: 'Ajustes aplicados.', relayStarted: 'Relay iniciado.', relayRestarted: 'Relay reiniciado.', relayStopped: 'Relay parado.', actionFailed: 'A ação do Relay falhou.'
  },
  es: {
    server: 'Servidor', overview: 'Resumen', activity: 'Actividad', connection: 'Conexión', relayReady: 'Relay listo', relayOverview: 'Resumen del Relay', loadingStatus: 'Cargando el estado del Relay...',
    online: 'En línea', offline: 'Sin conexión', operation: 'Operación', updating: 'Actualizando...', relayStoppedTitle: 'Relay detenido', relayStoppedDetail: 'Inicia el servidor para aceptar conexiones.',
    startRelay: 'Iniciar Relay', restart: 'Reiniciar', stop: 'Detener', onlineUsers: 'Usuarios en línea', activeAnnouncements: 'Anuncios activos', retainedAttachments: 'Archivos adjuntos conservados', transfers: 'Transferencias', stickers: 'Stickers', relayCatalog: 'Catálogo del Relay', uptime: 'Tiempo activo',
    realTime: 'Tiempo real', connectedUsers: 'Usuarios conectados', connectedUsersHelp: 'Una entrada para cada conexión activa del Relay.', activeAnnouncementsHelp: 'Los mensajes permanecen disponibles hasta la expiración configurada.', network: 'Red', connectionAndSettings: 'Conexión y ajustes', localWs: 'WS local',
    availableAddresses: 'Direcciones disponibles', availableAddressesHelp: 'Selecciona una dirección para copiarla.', localNetwork: 'Red local', localNetworkHelp: 'Usa esta dirección en los clientes Lantern cuando la detección automática no esté disponible.', relaySettings: 'Ajustes del Relay', relaySettingsHelp: 'Cambiar el puerto reinicia el Relay cuando está activo.', port: 'Puerto', announcementExpiration: 'Expiración de anuncios (horas)',
    startWithSystem: 'Iniciar Relay con el sistema', startWithSystemHelp: 'Inicia el Relay automáticamente después de que este usuario inicie sesión.', startWithSystemUnavailable: 'Disponible solo en el Relay empaquetado en este sistema.', settingsSaved: 'Ajustes guardados', applySettings: 'Aplicar ajustes',
    relayOnline: 'Relay en línea', relayOffline: 'Relay sin conexión', connectionRunning: 'WS local · puerto {port} · {count} sesión(es) activa(s)', connectionStopped: 'El servidor está detenido y no acepta conexiones.', operationRunning: 'Relay en funcionamiento', operationRunningDetail: 'Atendiendo clientes Lantern · iniciado a las {time}',
    activeSessions: '{count} sesión(es) activa(s)', expiresInHours: 'Expiran después de {hours}h', stored: '{size} almacenados', noFailures: 'Sin fallos', failures: '{count} fallo(s)', startedAt: 'Iniciado a las {time}', updatedAt: 'Actualizado a las {time}',
    copy: 'Copiar', copied: 'Copiado', addressCopied: 'Dirección copiada al portapapeles.', noLocalAddress: 'No se encontró una dirección de red local.', noUsers: 'Nadie en línea', noUsersDetail: 'Las conexiones aparecerán aquí.', noAnnouncements: 'No hay anuncios', noAnnouncementsDetail: 'Los nuevos anuncios aparecerán aquí.',
    available: 'Disponible', onlineFor: 'En línea desde hace {duration}', settingsPending: 'Los cambios aún no se aplicaron', invalidPort: 'Introduce un puerto entre 1 y 65535.', settingsApplied: 'Ajustes aplicados.', relayStarted: 'Relay iniciado.', relayRestarted: 'Relay reiniciado.', relayStopped: 'Relay detenido.', actionFailed: 'La acción del Relay falló.'
  },
  fr: {
    server: 'Serveur', overview: 'Vue d’ensemble', activity: 'Activité', connection: 'Connexion', relayReady: 'Relay prêt', relayOverview: 'Vue d’ensemble du Relay', loadingStatus: 'Chargement de l’état du Relay...',
    online: 'En ligne', offline: 'Hors ligne', operation: 'Fonctionnement', updating: 'Mise à jour...', relayStoppedTitle: 'Relay arrêté', relayStoppedDetail: 'Démarrez le serveur pour accepter les connexions.',
    startRelay: 'Démarrer le Relay', restart: 'Redémarrer', stop: 'Arrêter', onlineUsers: 'Utilisateurs en ligne', activeAnnouncements: 'Annonces actives', retainedAttachments: 'Pièces jointes conservées', transfers: 'Transferts', stickers: 'Stickers', relayCatalog: 'Catalogue du Relay', uptime: 'Durée de fonctionnement',
    realTime: 'Temps réel', connectedUsers: 'Utilisateurs connectés', connectedUsersHelp: 'Une entrée pour chaque connexion active au Relay.', activeAnnouncementsHelp: 'Les messages restent disponibles jusqu’à leur expiration configurée.', network: 'Réseau', connectionAndSettings: 'Connexion et paramètres', localWs: 'WS local',
    availableAddresses: 'Adresses disponibles', availableAddressesHelp: 'Sélectionnez une adresse pour la copier.', localNetwork: 'Réseau local', localNetworkHelp: 'Utilisez cette adresse dans les clients Lantern lorsque la découverte automatique est indisponible.', relaySettings: 'Paramètres du Relay', relaySettingsHelp: 'Modifier le port redémarre le Relay lorsqu’il est actif.', port: 'Port', announcementExpiration: 'Expiration des annonces (heures)',
    startWithSystem: 'Démarrer le Relay avec le système', startWithSystemHelp: 'Démarre automatiquement le Relay après la connexion de cet utilisateur.', startWithSystemUnavailable: 'Disponible uniquement dans le Relay empaqueté sur ce système.', settingsSaved: 'Paramètres enregistrés', applySettings: 'Appliquer les paramètres',
    relayOnline: 'Relay en ligne', relayOffline: 'Relay hors ligne', connectionRunning: 'WS local · port {port} · {count} session(s) active(s)', connectionStopped: 'Le serveur est arrêté et n’accepte pas les connexions.', operationRunning: 'Relay en fonctionnement', operationRunningDetail: 'Clients Lantern desservis · démarré à {time}',
    activeSessions: '{count} session(s) active(s)', expiresInHours: 'Expiration après {hours}h', stored: '{size} stockés', noFailures: 'Aucun échec', failures: '{count} échec(s)', startedAt: 'Démarré à {time}', updatedAt: 'Mis à jour à {time}',
    copy: 'Copier', copied: 'Copié', addressCopied: 'Adresse copiée dans le presse-papiers.', noLocalAddress: 'Aucune adresse réseau locale trouvée.', noUsers: 'Personne en ligne', noUsersDetail: 'Les connexions apparaîtront ici.', noAnnouncements: 'Aucune annonce', noAnnouncementsDetail: 'Les nouvelles annonces apparaîtront ici.',
    available: 'Disponible', onlineFor: 'En ligne depuis {duration}', settingsPending: 'Les modifications ne sont pas encore appliquées', invalidPort: 'Saisissez un port entre 1 et 65535.', settingsApplied: 'Paramètres appliqués.', relayStarted: 'Relay démarré.', relayRestarted: 'Relay redémarré.', relayStopped: 'Relay arrêté.', actionFailed: 'L’action du Relay a échoué.'
  }
};

const t = (key, params = {}) => (dictionaries[locale][key] || dictionaries.en[key] || key)
  .replace(/\{(\w+)\}/g, (_match, name) => String(params[name] ?? `{${name}}`));

const text = (id, value) => { $(id).textContent = value; };
const number = (value) => new Intl.NumberFormat(locale).format(Number(value) || 0);
const time = (value) => value ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
const duration = (ms) => {
  const total = Math.floor(Math.max(0, Number(ms) || 0) / 60_000);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};
const bytes = (value) => {
  const size = Math.max(0, Number(value) || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
};
const cleanError = (error) => String(error?.message || error || t('actionFailed'))
  .replace(/^Error invoking remote method '[^']+': Error: /, '');

for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
document.documentElement.lang = locale;

let latestState = null;
let settingsDirty = false;
let actionInFlight = false;
let feedbackTimer = null;

const showFeedback = (message, level = 'success') => {
  const node = $('feedback');
  node.textContent = message;
  node.className = `feedback visible ${level}`;
  if (feedbackTimer) window.clearTimeout(feedbackTimer);
  feedbackTimer = window.setTimeout(() => { node.className = 'feedback'; }, 4_800);
};

const emptyState = (icon, title, detail) => {
  const node = document.createElement('div');
  node.className = 'empty-state';
  const symbol = document.createElement('span');
  const strong = document.createElement('strong');
  const small = document.createElement('small');
  symbol.textContent = icon;
  strong.textContent = title;
  small.textContent = detail;
  node.append(symbol, strong, small);
  return node;
};

const renderUsers = (peers) => {
  const list = $('users');
  list.replaceChildren();
  text('users-count', number(peers.length));
  if (!peers.length) {
    list.append(emptyState('○', t('noUsers'), t('noUsersDetail')));
    return;
  }
  for (const peer of peers) {
    const row = document.createElement('article');
    row.className = 'entity-row';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.style.background = peer.avatarBg || '#5b5fc7';
    avatar.textContent = peer.avatarEmoji || '🙂';
    const main = document.createElement('div');
    main.className = 'entity-main';
    const name = document.createElement('strong');
    const detail = document.createElement('span');
    name.textContent = peer.displayName || t('available');
    detail.textContent = `${peer.statusMessage || t('available')} · Lantern ${peer.appVersion || '—'}`;
    main.append(name, detail);
    const meta = document.createElement('div');
    meta.className = 'entity-meta';
    const online = document.createElement('span');
    const since = document.createElement('span');
    online.className = 'online-label';
    online.textContent = t('online');
    since.textContent = t('onlineFor', { duration: duration(peer.onlineForMs) });
    meta.append(online, since);
    row.append(avatar, main, meta);
    list.append(row);
  }
};

const renderAnnouncements = (announcements) => {
  const list = $('announcements');
  list.replaceChildren();
  text('announcements-count', number(announcements.length));
  if (!announcements.length) {
    list.append(emptyState('◇', t('noAnnouncements'), t('noAnnouncementsDetail')));
    return;
  }
  for (const announcement of announcements) {
    const row = document.createElement('article');
    row.className = 'entity-row announcement-row';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.style.background = announcement.authorAvatarBg || '#5b5fc7';
    avatar.textContent = announcement.authorAvatarEmoji || '📣';
    const main = document.createElement('div');
    main.className = 'entity-main';
    const author = document.createElement('strong');
    const content = document.createElement('span');
    author.textContent = announcement.authorName || t('available');
    content.textContent = announcement.text || '—';
    main.append(author, content);
    const meta = document.createElement('div');
    meta.className = 'entity-meta';
    const created = document.createElement('span');
    const counters = document.createElement('div');
    const reactions = document.createElement('b');
    const reads = document.createElement('b');
    created.textContent = time(announcement.createdAt);
    counters.className = 'announcement-counters';
    reactions.textContent = `♡ ${number(announcement.reactionsCount)}`;
    reads.textContent = `◉ ${number(announcement.readsCount)}`;
    counters.append(reactions, reads);
    meta.append(created, counters);
    row.append(avatar, main, meta);
    list.append(row);
  }
};

const renderAddresses = (state) => {
  const list = $('addresses');
  list.replaceChildren();
  const addresses = Array.isArray(state.localAddresses) ? state.localAddresses : [];
  const port = state.port || state.settings?.port || 43190;
  if (!addresses.length) {
    list.append(emptyState('⌁', t('noLocalAddress'), t('localNetworkHelp')));
    return;
  }
  for (const ip of addresses) {
    const endpoint = `ws://${ip}:${port}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'address';
    const code = document.createElement('code');
    const hint = document.createElement('span');
    code.textContent = endpoint;
    hint.textContent = t('copy');
    button.append(code, hint);
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(endpoint);
        hint.textContent = t('copied');
        showFeedback(t('addressCopied'));
        window.setTimeout(() => { hint.textContent = t('copy'); }, 1_600);
      } catch (error) {
        showFeedback(cleanError(error), 'error');
      }
    });
    list.append(button);
  }
};

const setButtons = (state) => {
  $('start').disabled = actionInFlight || state.running;
  $('restart').disabled = actionInFlight || !state.running;
  $('stop').disabled = actionInFlight || !state.running;
  $('save-settings').disabled = actionInFlight || !settingsDirty;
};

const render = (state) => {
  latestState = state;
  const running = Boolean(state.running);
  const peers = Array.isArray(state.peers) ? state.peers : [];
  const announcements = Array.isArray(state.announcements) ? state.announcements : [];
  const transfers = state.transferMetrics || {};
  const port = state.port || state.settings?.port || 43190;
  const sessions = Number(state.sessionsOpen || peers.length);
  const transferTotal = Number(transfers.uploadsCompleted || 0) + Number(transfers.downloadsCompleted || 0);
  const transferFailures = Number(transfers.uploadsFailed || 0) + Number(transfers.downloadsFailed || 0) + Number(transfers.sendFailures || 0);
  const ttlHours = Number(state.settings?.announcementTtlHours || 24);

  $('status-pill').className = `live-pill ${running ? '' : 'offline'}`.trim();
  text('status-label', running ? t('relayOnline') : t('relayOffline'));
  text('connection-summary', running
    ? t('connectionRunning', { port, count: number(sessions) })
    : t('connectionStopped'));
  $('operation-icon').className = `operation-icon ${running ? '' : 'offline'}`.trim();
  text('operation-title', running ? t('operationRunning') : t('relayStoppedTitle'));
  text('operation-detail', running ? t('operationRunningDetail', { time: time(state.startedAt) }) : t('relayStoppedDetail'));

  text('metric-peers', number(state.peersOnline || peers.length));
  text('metric-sessions', t('activeSessions', { count: number(sessions) }));
  text('metric-announcements', number(state.announcementsActive || announcements.length));
  text('metric-announcement-help', t('expiresInHours', { hours: ttlHours }));
  text('metric-attachments', number(transfers.retainedFiles));
  text('metric-storage', t('stored', { size: bytes(transfers.retainedBytes) }));
  text('metric-transfers', number(transferTotal));
  text('metric-transfer-health', transferFailures ? t('failures', { count: number(transferFailures) }) : t('noFailures'));
  text('metric-stickers', number(state.stickersAvailable));
  text('metric-uptime', running ? duration(state.uptimeMs) : '—');
  text('metric-started', running ? t('startedAt', { time: time(state.startedAt) }) : t('relayStoppedTitle'));
  text('last-update', t('updatedAt', { time: time(state.now || Date.now()) }));
  text('port-label', `${t('port')} ${port}`);
  text('transport-badge', t('localWs'));
  text('nav-version', `Relay ${state.version || '—'}`);
  text('nav-store', running ? t('relayReady') : t('relayStoppedTitle'));

  if (!settingsDirty) {
    $('port-input').value = String(port);
    $('ttl-input').value = String(ttlHours);
  }
  const autoStart = state.autoStart || { supported: false, enabled: false };
  $('auto-start-input').checked = Boolean(autoStart.enabled);
  $('auto-start-input').disabled = !autoStart.supported;
  text('auto-start-help', autoStart.supported ? t('startWithSystemHelp') : t('startWithSystemUnavailable'));

  renderUsers(peers);
  renderAnnouncements(announcements);
  renderAddresses(state);
  setButtons(state);
};

const refresh = async ({ silent = true } = {}) => {
  try {
    render(await api.status());
  } catch (error) {
    if (!silent) showFeedback(cleanError(error), 'error');
  }
};

const runAction = async (action, successMessage) => {
  if (actionInFlight) return;
  actionInFlight = true;
  if (latestState) setButtons(latestState);
  try {
    render(await action());
    if (successMessage) showFeedback(successMessage);
  } catch (error) {
    showFeedback(cleanError(error), 'error');
  } finally {
    actionInFlight = false;
    if (latestState) setButtons(latestState);
  }
};

const markSettingsDirty = () => {
  settingsDirty = true;
  text('settings-state', t('settingsPending'));
  $('settings-state').className = 'dirty';
  if (latestState) setButtons(latestState);
};

$('start').addEventListener('click', () => runAction(api.start, t('relayStarted')));
$('restart').addEventListener('click', () => runAction(api.restart, t('relayRestarted')));
$('stop').addEventListener('click', () => runAction(api.stop, t('relayStopped')));
$('port-input').addEventListener('input', markSettingsDirty);
$('ttl-input').addEventListener('input', markSettingsDirty);
$('save-settings').addEventListener('click', async () => {
  const port = Number($('port-input').value);
  const announcementTtlHours = Number($('ttl-input').value);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(announcementTtlHours) || announcementTtlHours < 1 || announcementTtlHours > 168) {
    showFeedback(t('invalidPort'), 'error');
    return;
  }
  await runAction(async () => {
    const state = await api.updateSettings({ port, announcementTtlHours });
    settingsDirty = false;
    text('settings-state', t('settingsSaved'));
    $('settings-state').className = '';
    return state;
  }, t('settingsApplied'));
});
$('auto-start-input').addEventListener('change', () => runAction(
  () => api.setAutoStart($('auto-start-input').checked),
  $('auto-start-input').checked ? t('settingsApplied') : t('settingsApplied')
));

for (const link of document.querySelectorAll('.nav-link')) {
  link.addEventListener('click', () => {
    for (const item of document.querySelectorAll('.nav-link')) item.classList.toggle('active', item === link);
  });
}

void refresh({ silent: false });
window.setInterval(() => void refresh(), 3_000);
