/* global window, document, navigator */
const $ = (id) => document.getElementById(id);
const api = window.relayUi;

let latestState = null;
let settingsDirty = false;
let actionInFlight = false;
let feedbackTimer = null;

const cleanError = (error) => String(error?.message || error || 'Não foi possível concluir a operação.')
  .replace(/^Error invoking remote method '[^']+': Error: /, '');

const duration = (ms) => {
  const totalMinutes = Math.floor(Math.max(0, Number(ms) || 0) / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
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

const number = (value) => new Intl.NumberFormat('pt-BR').format(Number(value) || 0);
const time = (value) => value ? new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';

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
  $('users-count').textContent = number(peers.length);
  if (!peers.length) {
    list.append(emptyState('○', 'Ninguém online', 'As conexões aparecerão aqui.'));
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
    name.textContent = peer.displayName || 'Usuário';
    const detail = document.createElement('span');
    detail.textContent = `${peer.statusMessage || 'Disponível'} · Lantern ${peer.appVersion || '—'}`;
    main.append(name, detail);
    const meta = document.createElement('div');
    meta.className = 'entity-meta';
    const online = document.createElement('span');
    online.className = 'online-label';
    online.textContent = 'Online';
    const since = document.createElement('span');
    since.textContent = duration(peer.onlineForMs || 0);
    meta.append(online, since);
    row.append(avatar, main, meta);
    list.append(row);
  }
};

const renderAnnouncements = (announcements) => {
  const list = $('announcements');
  list.replaceChildren();
  $('announcements-count').textContent = number(announcements.length);
  if (!announcements.length) {
    list.append(emptyState('◇', 'Nenhum anúncio', 'Novos anúncios aparecerão aqui.'));
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
    author.textContent = announcement.authorName || 'Usuário';
    const content = document.createElement('span');
    content.textContent = announcement.text || '(sem conteúdo)';
    main.append(author, content);
    const meta = document.createElement('div');
    meta.className = 'entity-meta';
    const created = document.createElement('span');
    created.textContent = time(announcement.createdAt);
    const counters = document.createElement('div');
    counters.className = 'announcement-counters';
    const reactions = document.createElement('b');
    const reads = document.createElement('b');
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
  const protocol = state.tls ? 'wss' : 'ws';
  const port = state.port || state.settings?.port || 43190;
  if (!addresses.length) {
    list.append(emptyState('⌁', 'Nenhuma interface de rede', 'Conecte este computador a uma rede local.'));
    return;
  }
  for (const ip of addresses) {
    const endpoint = `${protocol}://${ip}:${port}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'address';
    const code = document.createElement('code');
    const hint = document.createElement('span');
    code.textContent = endpoint;
    hint.textContent = 'Copiar';
    button.append(code, hint);
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(endpoint);
        hint.textContent = 'Copiado';
        showFeedback('Endereço copiado para a área de transferência.');
        window.setTimeout(() => { hint.textContent = 'Copiar'; }, 1_600);
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
  $('backup').disabled = actionInFlight || !state.running;
  $('dashboard').disabled = actionInFlight || !state.running;
  $('save-settings').disabled = actionInFlight || !settingsDirty;
};

const render = (state) => {
  latestState = state;
  const running = Boolean(state.running);
  const store = state.centralStore || {};
  const transfers = state.transferMetrics || {};
  const port = state.port || state.settings?.port || 43190;
  const peers = Array.isArray(state.peers) ? state.peers : [];
  const announcements = Array.isArray(state.announcements) ? state.announcements : [];
  const transferTotal = Number(transfers.uploadsCompleted || 0) + Number(transfers.downloadsCompleted || 0);
  const transferFailures = Number(transfers.uploadsFailed || 0) + Number(transfers.downloadsFailed || 0) + Number(transfers.sendFailures || 0);

  $('status-pill').className = `live-pill ${running ? '' : 'offline'}`.trim();
  $('status-label').textContent = running ? 'Relay online' : 'Relay offline';
  $('connection-summary').textContent = running
    ? `${state.tls ? 'WSS seguro' : 'WS local'} · porta ${port} · ${number(state.sessionsOpen)} sessão(ões)`
    : 'O servidor está parado e não aceita conexões.';
  $('operation-icon').className = `operation-icon ${running ? '' : 'offline'}`.trim();
  $('operation-title').textContent = running ? 'Relay em operação' : 'Relay parado';
  $('operation-detail').textContent = running
    ? `${state.tls ? 'Conexões seguras habilitadas' : 'Acesso simples restrito à rede local'} · iniciado às ${time(state.startedAt)}`
    : 'Inicie o servidor para aceitar conexões.';

  $('metric-peers').textContent = number(state.peersOnline);
  $('metric-sessions').textContent = `${number(state.sessionsOpen)} sessões ativas`;
  $('metric-accounts').textContent = number(store.users);
  $('metric-retention').textContent = `Retenção ${store.retentionPolicy || '—'}`;
  $('metric-frames').textContent = number(store.frames);
  $('metric-attachments').textContent = number(store.attachments);
  $('metric-storage').textContent = `${bytes(store.attachmentBytes)} armazenados`;
  $('metric-transfers').textContent = number(transferTotal);
  $('metric-transfer-health').textContent = transferFailures ? `${number(transferFailures)} falha(s)` : 'Nenhuma falha';
  $('metric-uptime').textContent = running ? duration(state.uptimeMs) : '—';
  $('metric-started').textContent = running ? `Iniciado às ${time(state.startedAt)}` : 'Servidor parado';
  $('last-update').textContent = `Atualizado às ${time(state.now || Date.now())}`;

  $('port-label').textContent = `Porta ${port}`;
  $('transport-badge').textContent = state.tls ? 'WSS seguro' : 'WS local';
  $('security-title').textContent = state.tls ? 'Transporte seguro habilitado' : 'Acesso local';
  $('security-detail').textContent = state.tls
    ? 'Certificado e chave privada configurados para WSS.'
    : 'WS é aceito somente na rede local quando não há certificado.';
  $('nav-version').textContent = `Relay ${state.version || '—'}`;
  $('nav-store').textContent = running ? 'Dados canônicos persistentes' : 'Servidor parado';

  if (!settingsDirty) {
    $('port-input').value = String(state.settings?.port || 43190);
    $('cert-input').value = state.settings?.tlsCertFile || '';
    $('key-input').value = state.settings?.tlsKeyFile || '';
  }
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
    const state = await action();
    if (state?.settings) render(state);
    else await refresh();
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
  $('settings-state').textContent = 'Alterações ainda não aplicadas';
  $('settings-state').className = 'dirty';
  if (latestState) setButtons(latestState);
};

$('start').addEventListener('click', () => runAction(api.start, 'Relay iniciado.'));
$('restart').addEventListener('click', () => runAction(api.restart, 'Relay reiniciado.'));
$('stop').addEventListener('click', () => runAction(api.stop, 'Relay parado.'));
$('backup').addEventListener('click', async () => {
  if (actionInFlight) return;
  actionInFlight = true;
  if (latestState) setButtons(latestState);
  try {
    const result = await api.backup();
    showFeedback(`Backup criado com sucesso · ${bytes(result.size)}`);
  } catch (error) {
    showFeedback(cleanError(error), 'error');
  } finally {
    actionInFlight = false;
    if (latestState) setButtons(latestState);
  }
});
$('dashboard').addEventListener('click', async () => {
  try {
    await api.openDashboard();
    showFeedback('Dashboard aberta no navegador local.');
  } catch (error) {
    showFeedback(cleanError(error), 'error');
  }
});
$('pick-cert').addEventListener('click', async () => {
  const selected = await api.pickCertificate();
  if (selected) { $('cert-input').value = selected; markSettingsDirty(); }
});
$('pick-key').addEventListener('click', async () => {
  const selected = await api.pickPrivateKey();
  if (selected) { $('key-input').value = selected; markSettingsDirty(); }
});
$('port-input').addEventListener('input', markSettingsDirty);
$('save-settings').addEventListener('click', async () => {
  const port = Number($('port-input').value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    showFeedback('Informe uma porta entre 1 e 65535.', 'error');
    return;
  }
  await runAction(async () => {
    const state = await api.updateSettings({
      port,
      tlsCertFile: $('cert-input').value,
      tlsKeyFile: $('key-input').value
    });
    settingsDirty = false;
    $('settings-state').textContent = 'Configuração salva';
    $('settings-state').className = '';
    return state;
  }, 'Configuração aplicada.');
});

const navLinks = Array.from(document.querySelectorAll('.nav-link'));
for (const link of navLinks) {
  link.addEventListener('click', () => {
    for (const item of navLinks) item.classList.toggle('active', item === link);
  });
}

void refresh({ silent: false });
window.setInterval(() => void refresh(), 3_000);
