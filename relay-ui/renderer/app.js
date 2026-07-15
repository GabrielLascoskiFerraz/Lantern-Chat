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

const managementEmpty = (title, detail) => emptyState('○', title, detail);

const renderManagement = (state) => {
  const users = Array.isArray(state.users) ? state.users : [];
  const requests = Array.isArray(state.passwordResetRequests) ? state.passwordResetRequests : [];
  const announcements = Array.isArray(state.announcements) ? state.announcements : [];
  $('accounts-count').textContent = number(users.length);
  $('password-resets-count').textContent = number(requests.length);
  const accounts = $('accounts-list');
  accounts.replaceChildren();
  if (!users.length) accounts.append(managementEmpty('Nenhuma conta', 'Crie a primeira conta para começar.'));
  for (const user of users) {
    const row = document.createElement('article'); row.className = 'management-row';
    const head = document.createElement('div'); head.className = 'management-row-head';
    const identity = document.createElement('div'); identity.className = 'account-identity';
    const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.style.background = user.avatarBg || '#147ad6'; avatar.textContent = user.avatarEmoji || '🙂';
    const labels = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = user.displayName;
    const username = document.createElement('span'); username.textContent = `@${user.username}${user.department ? ` · ${user.department}` : ''}`;
    labels.append(name, username); identity.append(avatar, labels);
    const status = document.createElement('span'); status.className = `state-badge${user.disabled ? ' disabled' : ''}`; status.textContent = user.disabled ? 'Desativada' : 'Ativa';
    head.append(identity, status);
    const controls = document.createElement('div'); controls.className = 'management-controls';
    const department = document.createElement('input'); department.value = user.department || ''; department.placeholder = 'Setor'; department.setAttribute('aria-label', `Setor de ${user.displayName}`);
    const adminLabel = document.createElement('label'); adminLabel.className = 'check-field compact';
    const admin = document.createElement('input'); admin.type = 'checkbox'; admin.checked = user.role === 'admin';
    const adminText = document.createElement('span'); adminText.textContent = 'Acesso à dashboard'; adminLabel.append(admin, adminText);
    const save = document.createElement('button'); save.className = 'button'; save.type = 'button'; save.textContent = 'Salvar';
    save.addEventListener('click', () => runManagementAction(() => api.updateUser(user.userId, { department: department.value, role: admin.checked ? 'admin' : 'user' }), 'Conta atualizada.'));
    const password = document.createElement('input'); password.type = 'password'; password.placeholder = 'Nova senha'; password.autocomplete = 'new-password';
    const reset = document.createElement('button'); reset.className = 'button'; reset.type = 'button'; reset.textContent = 'Redefinir senha';
    reset.addEventListener('click', () => {
      if (password.value.length < 10) return showFeedback('A senha deve ter pelo menos 10 caracteres.', 'error');
      void runManagementAction(() => api.resetPassword(user.userId, password.value), 'Senha redefinida e sessões encerradas.');
    });
    const toggle = document.createElement('button'); toggle.className = user.disabled ? 'button' : 'button danger'; toggle.type = 'button'; toggle.textContent = user.disabled ? 'Reativar' : 'Desativar';
    toggle.addEventListener('click', () => runManagementAction(() => api.updateUser(user.userId, { disabled: !user.disabled }), user.disabled ? 'Conta reativada.' : 'Conta desativada.'));
    const remove = document.createElement('button'); remove.className = 'button danger'; remove.type = 'button'; remove.textContent = 'Excluir';
    remove.addEventListener('click', () => { if (window.confirm(`Excluir a conta de ${user.displayName}? O histórico será preservado.`)) void runManagementAction(() => api.deleteUser(user.userId), 'Conta excluída.'); });
    controls.append(department, adminLabel, save, password, reset, toggle, remove);
    row.append(head, controls); accounts.append(row);
  }

  const resets = $('password-resets-list'); resets.replaceChildren();
  if (!requests.length) resets.append(managementEmpty('Nenhuma solicitação pendente', 'Novos pedidos aparecerão aqui.'));
  for (const request of requests) {
    const row = document.createElement('article'); row.className = 'management-row horizontal';
    const detail = document.createElement('div'); const title = document.createElement('strong'); title.textContent = request.displayName;
    const subtitle = document.createElement('span'); subtitle.textContent = `@${request.username} · solicitada em ${new Date(request.requestedAt).toLocaleString('pt-BR')}`; detail.append(title, subtitle);
    const actions = document.createElement('div'); actions.className = 'row-actions';
    if (request.status === 'pending') {
      const approve = document.createElement('button'); approve.className = 'button primary'; approve.textContent = 'Aprovar'; approve.type = 'button'; approve.addEventListener('click', () => runManagementAction(() => api.reviewPasswordReset(request.requestId, true), 'Redefinição aprovada.'));
      const reject = document.createElement('button'); reject.className = 'button danger'; reject.textContent = 'Rejeitar'; reject.type = 'button'; reject.addEventListener('click', () => runManagementAction(() => api.reviewPasswordReset(request.requestId, false), 'Solicitação rejeitada.'));
      actions.append(approve, reject);
    } else { const stateLabel = document.createElement('span'); stateLabel.className = 'state-badge'; stateLabel.textContent = 'Aprovada'; actions.append(stateLabel); }
    row.append(detail, actions); resets.append(row);
  }

  const ttlMs = Number(state.announcementTtlMs) || 86400000;
  const ttlDays = ttlMs / 86400000;
  if (Number.isInteger(ttlDays)) { $('announcement-ttl-value').value = String(ttlDays); $('announcement-ttl-unit').value = '86400000'; }
  else { $('announcement-ttl-value').value = String(Math.max(1, Math.round(ttlMs / 3600000))); $('announcement-ttl-unit').value = '3600000'; }
  const announcementList = $('managed-announcements-list'); announcementList.replaceChildren();
  if (!announcements.length) announcementList.append(managementEmpty('Nenhum anúncio ativo', 'Os anúncios publicados aparecerão aqui.'));
  for (const announcement of announcements) {
    const row = document.createElement('article'); row.className = 'management-row horizontal';
    const detail = document.createElement('div'); const title = document.createElement('strong'); title.textContent = announcement.authorName || 'Usuário';
    const subtitle = document.createElement('span'); subtitle.textContent = announcement.text || '(sem conteúdo)'; detail.append(title, subtitle);
    const controls = document.createElement('div'); controls.className = 'expiry-controls';
    const input = document.createElement('input'); input.type = 'datetime-local'; input.value = new Date(announcement.expiresAt - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const save = document.createElement('button'); save.className = 'button'; save.type = 'button'; save.textContent = 'Alterar';
    save.addEventListener('click', () => runManagementAction(() => api.setAnnouncementExpiry(announcement.messageId, new Date(input.value).getTime()), 'Expiração atualizada.'));
    controls.append(input, save); row.append(detail, controls); announcementList.append(row);
  }
  const calendar = state.calendarAutomation || {};
  const calendarForm = $('calendar-automation-form');
  if (!calendarForm.contains(document.activeElement)) {
    $('calendar-url').value = calendar.url || '';
    $('calendar-update-time').value = calendar.updateTime || '08:00';
    $('calendar-enabled').checked = Boolean(calendar.enabled);
  }
  $('calendar-status').textContent = calendar.enabled ? 'Ativado' : 'Desativado';
  $('calendar-status').className = `state-badge${calendar.enabled ? '' : ' disabled'}`;
  $('calendar-last-result').textContent = calendar.lastError
    ? `Última tentativa: ${calendar.lastError}`
    : calendar.lastRunAt
      ? `Última atualização em ${new Date(calendar.lastRunAt).toLocaleString('pt-BR')} · ${number(calendar.publishedEvents)} evento(s) já publicado(s).`
      : 'Nenhuma atualização executada.';
};

const refreshManagement = async () => {
  if (!latestState?.running) return;
  renderManagement(await api.management());
};

const runManagementAction = async (action, successMessage) => {
  try { await action(); await refreshManagement(); await refresh(); showFeedback(successMessage); }
  catch (error) { showFeedback(cleanError(error), 'error'); }
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
    $('start-at-login').checked = Boolean(state.settings?.startAtLogin);
    $('start-relay-on-launch').checked = Boolean(state.settings?.startRelayOnLaunch);
  }
  $('start-at-login').disabled = !state.loginItemSupported;
  $('startup-support').textContent = state.loginItemSupported
    ? 'Compatível com a inicialização nativa deste sistema.'
    : 'A inicialização com o sistema não é gerenciada automaticamente nesta plataforma.';
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
    if (latestState?.running) await refreshManagement();
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
$('start-at-login').addEventListener('change', markSettingsDirty);
$('start-relay-on-launch').addEventListener('change', markSettingsDirty);
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
      tlsKeyFile: $('key-input').value,
      startAtLogin: $('start-at-login').checked,
      startRelayOnLaunch: $('start-relay-on-launch').checked
    });
    settingsDirty = false;
    $('settings-state').textContent = 'Configuração salva';
    $('settings-state').className = '';
    return state;
  }, 'Configuração aplicada.');
});

$('create-account-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const password = $('create-password').value;
  if (password.length < 10) return showFeedback('A senha inicial deve ter pelo menos 10 caracteres.', 'error');
  void runManagementAction(async () => {
    await api.createUser({
      username: $('create-username').value,
      displayName: $('create-display-name').value,
      department: $('create-department').value,
      password,
      role: $('create-admin').checked ? 'admin' : 'user'
    });
    $('create-account-form').reset();
  }, 'Conta criada.');
});

$('announcement-ttl-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const ttlMs = Number($('announcement-ttl-value').value) * Number($('announcement-ttl-unit').value);
  void runManagementAction(() => api.setAnnouncementTtl(ttlMs), 'Tempo padrão dos anúncios atualizado.');
});

$('calendar-automation-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void runManagementAction(() => api.configureCalendar({
    url: $('calendar-url').value,
    updateTime: $('calendar-update-time').value,
    enabled: $('calendar-enabled').checked
  }), 'Automação do calendário salva.');
});

$('calendar-refresh-now').addEventListener('click', async () => {
  try {
    await api.configureCalendar({ url: $('calendar-url').value, updateTime: $('calendar-update-time').value, enabled: $('calendar-enabled').checked });
    const result = await api.refreshCalendar();
    await refreshManagement(); await refresh();
    showFeedback(`${number(result.eventsFound)} evento(s) encontrado(s) · ${number(result.announcementsCreated)} anúncio(s) criado(s).`);
  } catch (error) { showFeedback(cleanError(error), 'error'); }
});

const navLinks = Array.from(document.querySelectorAll('.nav-link'));
for (const link of navLinks) {
  link.addEventListener('click', () => {
    for (const item of navLinks) item.classList.toggle('active', item === link);
  });
}

void refresh({ silent: false }).then(() => refreshManagement()).catch(() => undefined);
window.setInterval(() => void refresh(), 3_000);
window.setInterval(() => void refreshManagement().catch(() => undefined), 15_000);
