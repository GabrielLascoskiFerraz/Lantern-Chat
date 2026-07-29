(() => {
  if (window.relayUi) return;

  document.body.classList.add('web-dashboard');
  let csrfToken = sessionStorage.getItem('lantern-admin-csrf') || '';
  let resolveAuthentication;
  const authenticated = new Promise((resolve) => { resolveAuthentication = resolve; });

  const request = async (url, options = {}) => {
    await authenticated;
    const headers = new Headers(options.headers || {});
    if (options.body && !(options.body instanceof Blob) && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    if ((options.method || 'GET') !== 'GET' && csrfToken) headers.set('x-lantern-csrf', csrfToken);
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.message || result.error || `Falha HTTP ${response.status}`);
    return result;
  };

  const chooseFiles = (accept, multiple = false) => new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener('change', () => resolve(Array.from(input.files || [])), { once: true });
    input.click();
  });

  const upload = async (url, file, headers = {}) => request(url, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/octet-stream', 'x-lantern-file-name': encodeURIComponent(file.name) },
    body: file
  });

  const json = (method, body) => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

  window.relayUi = {
    status: async () => (await request('/api/admin/relay-ui/status')).state,
    management: async () => (await request('/api/admin/relay-ui/management')).management,
    start: async () => (await request('/api/admin/relay-ui/status')).state,
    stop: async () => (await request('/api/admin/relay-ui/status')).state,
    restart: async () => (await request('/api/admin/relay-ui/status')).state,
    backup: async () => (await request('/api/admin/backup', json('POST'))).backup,
    importConvertedBackup: async () => ({ canceled: true }),
    createUser: async (input) => (await request('/api/admin/users', json('POST', input))).user,
    updateUser: async (userId, input) => (await request(`/api/admin/users/${encodeURIComponent(userId)}`, json('PATCH', input))).user,
    resetPassword: async (userId, password) => request(`/api/admin/users/${encodeURIComponent(userId)}/password`, json('POST', { password })),
    deleteUser: async (userId) => request(`/api/admin/users/${encodeURIComponent(userId)}`, json('DELETE')),
    reviewPasswordReset: async (requestId, approve) =>
      (await request(`/api/admin/password-reset-requests/${encodeURIComponent(requestId)}`, json('POST', { action: approve ? 'approve' : 'reject' }))).request,
    setAnnouncementTtl: async (ttlMs) =>
      (await request('/api/admin/relay-ui/announcement-ttl', json('PUT', { ttlMs }))).ttlMs,
    setAnnouncementExpiry: async (messageId, expiresAt) =>
      request(`/api/admin/relay-ui/announcements/${encodeURIComponent(messageId)}/expiry`, json('PUT', { expiresAt })),
    configureCalendar: async (input) =>
      (await request('/api/admin/relay-ui/calendar', json('PUT', input))).calendarAutomation,
    refreshCalendar: async () =>
      (await request('/api/admin/relay-ui/calendar/refresh', json('POST'))).result,
    importStickers: async (input) => {
      const files = await chooseFiles('image/gif,.gif', true);
      if (!files.length) return { canceled: true, added: [], replaced: [] };
      let added = [];
      let replaced = [];
      for (const file of files) {
        const result = await upload('/api/admin/relay-ui/stickers', file, {
          'x-lantern-category': encodeURIComponent(input?.category || ''),
          'x-lantern-replace': input?.replaceExisting ? '1' : '0'
        });
        added = added.concat(result.added || []);
        replaced = replaced.concat(result.replaced || []);
      }
      return { canceled: false, added, replaced };
    },
    updateSticker: async (relativePath, input) =>
      (await request(`/api/admin/relay-ui/stickers/${encodeURIComponent(relativePath)}`, json('PATCH', input))).sticker,
    removeSticker: async (relativePath) =>
      request(`/api/admin/relay-ui/stickers/${encodeURIComponent(relativePath)}`, json('DELETE')),
    stickerPreview: async (relativePath) => `/stickers/${relativePath.split('/').map(encodeURIComponent).join('/')}`,
    selectUpdateInstaller: async (platform) => {
      const accept = platform === 'win32' ? '.exe' : platform === 'darwin' ? '.dmg' : '.AppImage,.appimage';
      const [file] = await chooseFiles(accept);
      if (!file) return { canceled: true };
      const result = await upload(`/api/admin/updates/${platform}`, file);
      return { canceled: false, updates: result.updates };
    },
    removeUpdateInstaller: async (platform) =>
      (await request(`/api/admin/updates/${platform}`, json('DELETE'))).updates,
    openDashboard: async () => undefined,
    updateSettings: async () => (await request('/api/admin/relay-ui/status')).state,
    pickCertificate: async () => null,
    pickPrivateKey: async () => null
  };

  const gate = document.createElement('div');
  gate.className = 'web-auth-gate';
  gate.innerHTML = `
    <form class="web-auth-card" autocomplete="on">
      <img src="/lantern-icon.png" alt="">
      <span class="section-kicker">Administração</span>
      <h1>Entrar no Lantern Relay</h1>
      <p>Use uma conta com permissão administrativa.</p>
      <label class="field"><span>Usuário</span><input name="username" required autocomplete="username"></label>
      <label class="field"><span>Senha</span><input name="password" type="password" required autocomplete="current-password"></label>
      <div class="web-auth-error" role="alert"></div>
      <button class="button primary wide" type="submit">Entrar</button>
    </form>`;
  document.body.appendChild(gate);

  const finishAuthentication = (token) => {
    csrfToken = token;
    sessionStorage.setItem('lantern-admin-csrf', token);
    gate.remove();
    resolveAuthentication();
  };
  fetch('/api/admin/session', { credentials: 'same-origin' })
    .then(async (response) => {
      if (!response.ok) return;
      const result = await response.json();
      if (result.csrfToken) finishAuthentication(result.csrfToken);
    })
    .catch(() => undefined);
  gate.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = gate.querySelector('button');
    const error = gate.querySelector('.web-auth-error');
    const values = new FormData(event.currentTarget);
    button.disabled = true;
    error.textContent = '';
    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username: values.get('username'), password: values.get('password') })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Usuário ou senha inválidos.');
      finishAuthentication(result.csrfToken);
    } catch (reason) {
      error.textContent = reason instanceof Error ? reason.message : String(reason);
      button.disabled = false;
    }
  });
})();
