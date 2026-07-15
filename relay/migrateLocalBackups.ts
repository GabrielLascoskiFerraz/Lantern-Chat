import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CentralStore } from './centralStore';
import { CanonicalFrame } from './centralTypes';
import { EncryptedChunkStore } from './encryptedChunkStore';
import { RelayGroup, RelayGroupAttachmentMetadata, RelayGroupEvent, RelayGroupMember } from './groupTypes';

const CHUNK_BYTES = 64 * 1024;

type Json = Record<string, unknown>;

interface LegacyProfile { deviceId: string; displayName: string; avatarEmoji: string; avatarBg: string; statusMessage: string; createdAt: number; updatedAt: number }
interface LegacyMessage {
  messageId: string; conversationId: string; senderDeviceId: string; receiverDeviceId: string | null;
  type: 'text' | 'file' | 'announcement'; bodyText: string | null; fileId: string | null;
  fileName: string | null; fileSize: number | null; fileSha256: string | null; filePath: string | null;
  replyToMessageId: string | null; replyToSenderDeviceId: string | null; replyToType: string | null;
  replyToPreviewText: string | null; replyToFileName: string | null; forwardedFromMessageId: string | null;
  editedAt: number | null; deletedAt: number | null; createdAt: number; sourceRoot: string;
}
interface LegacyBackup {
  root: string; manifest: Json; profile: LegacyProfile; peers: Json[]; conversations: Json[];
  messages: LegacyMessage[]; reactions: Json[]; announcementReads: Json[]; favorites: Json[]; hidden: Json[];
  groups: Json[]; groupMembers: Json[]; pinned: Json[]; attachmentFiles: string[];
}
interface MappingUser { username?: string; password?: string; department?: string; role?: 'admin' | 'user' }
interface MigrationMapping { users?: Record<string, MappingUser> }
interface ResolvedAttachment { file: string; size: number; sha256: string }
interface PlannedUser { deviceId: string; profile: LegacyProfile; username: string; password: string; department: string; role: 'admin' | 'user' }
interface MigrationPlan {
  backups: LegacyBackup[]; users: PlannedUser[]; messages: LegacyMessage[];
  attachments: Map<string, ResolvedAttachment>; warnings: string[]; errors: string[];
}
interface CliOptions {
  backupsDir: string; relayDataDir: string; mappingFile: string | null; reportFile: string;
  apply: boolean; allowMissingUsers: boolean; allowMissingAttachments: boolean;
}

const value = (row: Json, key: string): string => typeof row[key] === 'string' ? String(row[key]).trim() : '';
const numberValue = (row: Json, key: string): number => typeof row[key] === 'number' && Number.isFinite(row[key]) ? Math.trunc(Number(row[key])) : 0;
const nullable = (row: Json, key: string): string | null => value(row, key) || null;
const sha256File = (file: string): string => {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read = 0;
    do { read = fs.readSync(descriptor, buffer, 0, buffer.length, null); if (read) hash.update(buffer.subarray(0, read)); } while (read);
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
};
const walkFiles = (root: string): string[] => {
  if (!fs.existsSync(root)) return [];
  const output: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(file)); else if (entry.isFile()) output.push(file);
  }
  return output;
};
const tableExists = (db: Database.Database, name: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const all = (db: Database.Database, table: string): Json[] => tableExists(db, table) ? db.prepare(`SELECT * FROM ${table}`).all() as Json[] : [];

const discoverBackups = (root: string): string[] => {
  const found: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 4 || !fs.existsSync(directory)) return;
    if (fs.existsSync(path.join(directory, 'manifest.json')) && fs.existsSync(path.join(directory, 'db', 'lantern.db'))) {
      found.push(directory); return;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) visit(path.join(directory, entry.name), depth + 1);
  };
  visit(path.resolve(root), 0);
  return found.sort((a, b) => a.localeCompare(b));
};

const readBackup = (root: string): LegacyBackup => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as Json;
  if (manifest.app !== 'Lantern') throw new Error(`Manifesto inválido em ${root}.`);
  const db = new Database(path.join(root, 'db', 'lantern.db'), { readonly: true, fileMustExist: true });
  try {
    const profileRow = all(db, 'profile')[0];
    if (!profileRow || !value(profileRow, 'deviceId')) throw new Error(`Perfil ausente no backup ${root}.`);
    const profile: LegacyProfile = {
      deviceId: value(profileRow, 'deviceId'), displayName: value(profileRow, 'displayName') || String(manifest.profileName || 'Usuário'),
      avatarEmoji: value(profileRow, 'avatarEmoji') || '🙂', avatarBg: value(profileRow, 'avatarBg') || '#147ad6',
      statusMessage: value(profileRow, 'statusMessage') || 'Disponível', createdAt: numberValue(profileRow, 'createdAt') || numberValue(manifest, 'createdAt') || Date.now(),
      updatedAt: numberValue(profileRow, 'updatedAt') || numberValue(manifest, 'createdAt') || Date.now()
    };
    const messages = all(db, 'messages').map((row): LegacyMessage => ({
      messageId: value(row, 'messageId'), conversationId: value(row, 'conversationId'), senderDeviceId: value(row, 'senderDeviceId'),
      receiverDeviceId: nullable(row, 'receiverDeviceId'), type: value(row, 'type') as LegacyMessage['type'], bodyText: nullable(row, 'bodyText'),
      fileId: nullable(row, 'fileId'), fileName: nullable(row, 'fileName'), fileSize: numberValue(row, 'fileSize') || null,
      fileSha256: nullable(row, 'fileSha256'), filePath: nullable(row, 'filePath'), replyToMessageId: nullable(row, 'replyToMessageId'),
      replyToSenderDeviceId: nullable(row, 'replyToSenderDeviceId'), replyToType: nullable(row, 'replyToType'),
      replyToPreviewText: nullable(row, 'replyToPreviewText'), replyToFileName: nullable(row, 'replyToFileName'),
      forwardedFromMessageId: nullable(row, 'forwardedFromMessageId'), editedAt: numberValue(row, 'editedAt') || null,
      deletedAt: numberValue(row, 'deletedAt') || null, createdAt: numberValue(row, 'createdAt'), sourceRoot: root
    })).filter((row) => row.messageId && row.senderDeviceId && ['text', 'file', 'announcement'].includes(row.type) && row.createdAt > 0);
    return {
      root, manifest, profile, peers: all(db, 'peers_cache'), conversations: all(db, 'conversations'), messages,
      reactions: all(db, 'message_reactions'), announcementReads: all(db, 'announcement_reads'),
      favorites: all(db, 'message_favorites'), hidden: all(db, 'hidden_messages'),
      groups: all(db, 'groups'), groupMembers: all(db, 'group_members'), pinned: all(db, 'group_pinned_messages'),
      attachmentFiles: walkFiles(path.join(root, 'attachments'))
    };
  } finally { db.close(); }
};

const slug = (text: string): string => {
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '.').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  return (normalized || 'usuario').slice(0, 40).padEnd(3, '0');
};
const messageSignature = (row: LegacyMessage): string => JSON.stringify({
  sender: row.senderDeviceId, receiver: row.receiverDeviceId, type: row.type, text: row.bodyText, fileId: row.fileId,
  fileName: row.fileName, fileSize: row.fileSize, sha: row.fileSha256, reply: row.replyToMessageId, forwarded: row.forwardedFromMessageId,
  editedAt: row.editedAt, deletedAt: row.deletedAt, createdAt: row.createdAt
});

const resolveAttachment = (message: LegacyMessage, backups: LegacyBackup[]): ResolvedAttachment | null => {
  const source = backups.find((backup) => backup.root === message.sourceRoot);
  const pools = [source, ...backups.filter((backup) => backup !== source)].filter((item): item is LegacyBackup => Boolean(item));
  const expectedNames = new Set([message.filePath ? path.basename(message.filePath) : '', message.fileName ? `${message.messageId}_${message.fileName}` : '', message.fileName || ''].filter(Boolean));
  let candidates = pools.flatMap((backup) => backup.attachmentFiles.filter((file) => expectedNames.has(path.basename(file))));
  if (!candidates.length && message.fileSize !== null) candidates = pools.flatMap((backup) => backup.attachmentFiles.filter((file) => fs.statSync(file).size === message.fileSize));
  for (const file of candidates) {
    const size = fs.statSync(file).size;
    if (message.fileSize !== null && size !== message.fileSize) continue;
    const sha256 = sha256File(file);
    if (message.fileSha256 && sha256 !== message.fileSha256.toLowerCase()) continue;
    return { file, size, sha256 };
  }
  return null;
};

const buildPlan = (options: CliOptions): MigrationPlan => {
  const roots = discoverBackups(options.backupsDir);
  if (!roots.length) throw new Error('Nenhum backup Lantern foi encontrado.');
  const backups = roots.map(readBackup);
  const mapping: MigrationMapping = options.mappingFile ? JSON.parse(fs.readFileSync(options.mappingFile, 'utf8')) as MigrationMapping : {};
  const warnings: string[] = [];
  const errors: string[] = [];
  const profileByDevice = new Map<string, LegacyProfile>();
  for (const backup of backups) {
    const current = profileByDevice.get(backup.profile.deviceId);
    if (!current || backup.profile.updatedAt >= current.updatedAt) profileByDevice.set(backup.profile.deviceId, backup.profile);
  }
  const usedNames = new Set<string>();
  const users = Array.from(profileByDevice.values()).sort((a, b) => a.deviceId.localeCompare(b.deviceId)).map((profile) => {
    const configured = mapping.users?.[profile.deviceId] || {};
    let username = slug(configured.username || profile.displayName);
    let suffix = 2;
    while (usedNames.has(username)) username = `${slug(configured.username || profile.displayName).slice(0, 43)}.${suffix++}`;
    usedNames.add(username);
    return { deviceId: profile.deviceId, profile, username, password: configured.password || '', department: configured.department || '', role: configured.role || 'user' } satisfies PlannedUser;
  });
  const knownDevices = new Set(users.map((user) => user.deviceId));
  const messageById = new Map<string, LegacyMessage>();
  for (const backup of backups) for (const message of backup.messages) {
    const existing = messageById.get(message.messageId);
    if (!existing) messageById.set(message.messageId, message);
    else if (messageSignature(existing) !== messageSignature(message)) errors.push(`Conflito no messageId ${message.messageId} entre ${existing.sourceRoot} e ${message.sourceRoot}.`);
    else if (!existing.filePath && message.filePath) messageById.set(message.messageId, message);
  }
  let messages = Array.from(messageById.values()).filter((message) => !message.deletedAt).sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId));
  const requiredDevices = new Set<string>();
  for (const message of messages) {
    requiredDevices.add(message.senderDeviceId);
    if (message.receiverDeviceId) requiredDevices.add(message.receiverDeviceId);
  }
  for (const backup of backups) for (const member of backup.groupMembers) if (value(member, 'deviceId')) requiredDevices.add(value(member, 'deviceId'));
  const missingDevices = Array.from(requiredDevices).filter((id) => !knownDevices.has(id));
  if (missingDevices.length && !options.allowMissingUsers) errors.push(`Faltam backups para ${missingDevices.length} participante(s): ${missingDevices.join(', ')}.`);
  if (missingDevices.length && options.allowMissingUsers) {
    warnings.push(`Mensagens relacionadas a participantes sem backup foram ignoradas: ${missingDevices.join(', ')}.`);
    messages = messages.filter((message) => knownDevices.has(message.senderDeviceId) && (!message.receiverDeviceId || knownDevices.has(message.receiverDeviceId)));
  }
  const attachments = new Map<string, ResolvedAttachment>();
  for (const message of messages.filter((item) => item.type === 'file')) {
    if (!message.fileId) {
      errors.push(`Mensagem de arquivo ${message.messageId} não possui fileId.`);
      continue;
    }
    const resolved = resolveAttachment(message, backups);
    if (resolved) attachments.set(message.messageId, resolved);
    else if (options.allowMissingAttachments) warnings.push(`Anexo ausente; mensagem ${message.messageId} será ignorada.`);
    else errors.push(`Bytes do anexo ${message.fileName || message.fileId || message.messageId} não foram encontrados ou falharam na verificação.`);
  }
  if (options.allowMissingAttachments) messages = messages.filter((message) => message.type !== 'file' || attachments.has(message.messageId));
  return { backups, users, messages, attachments, warnings, errors };
};

const replyPayload = (message: LegacyMessage, deviceToUser: Map<string, string>): Json | null => message.replyToMessageId ? {
  messageId: message.replyToMessageId, senderDeviceId: message.replyToSenderDeviceId ? deviceToUser.get(message.replyToSenderDeviceId) || message.replyToSenderDeviceId : '',
  type: message.replyToType || 'text', previewText: message.replyToPreviewText, fileName: message.replyToFileName
} : null;

const ALLOWED_REACTIONS = new Set(['👍', '👎', '❤️', '😢', '😊', '😂']);

const latestRows = (backups: LegacyBackup[], rows: (backup: LegacyBackup) => Json[], key: (row: Json) => string, timestamp: string): Json[] => {
  const latest = new Map<string, Json>();
  for (const backup of backups) for (const row of rows(backup)) {
    const id = key(row); const current = latest.get(id);
    if (id && (!current || numberValue(row, timestamp) >= numberValue(current, timestamp))) latest.set(id, row);
  }
  return Array.from(latest.values());
};

const writeFileChunks = (file: string, write: (index: number, chunk: Buffer) => void): void => {
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES); let index = 0; let read = 0;
    do { read = fs.readSync(descriptor, buffer, 0, buffer.length, null); if (read) write(index++, Buffer.from(buffer.subarray(0, read))); } while (read);
    if (index === 0) write(0, Buffer.alloc(0));
  } finally { fs.closeSync(descriptor); }
};

const buildGroups = (plan: MigrationPlan, deviceToUser: Map<string, string>, groupChunks: EncryptedChunkStore): { groups: RelayGroup[]; eventsByGroupId: Record<string, RelayGroupEvent[]>; attachments: RelayGroupAttachmentMetadata[] } => {
  const groupRows = new Map<string, Json>();
  for (const backup of plan.backups) for (const row of backup.groups) {
    const id = value(row, 'groupId'); const current = groupRows.get(id);
    if (id && (!current || numberValue(row, 'updatedAt') >= numberValue(current, 'updatedAt'))) groupRows.set(id, row);
  }
  const outputGroups: RelayGroup[] = []; const eventsByGroupId: Record<string, RelayGroupEvent[]> = {}; const attachmentMetadata: RelayGroupAttachmentMetadata[] = [];
  for (const [groupId, row] of groupRows) {
    const memberRows = plan.backups.flatMap((backup) => backup.groupMembers.filter((member) => value(member, 'groupId') === groupId));
    const memberByDevice = new Map<string, Json>();
    for (const member of memberRows) { const id = value(member, 'deviceId'); const current = memberByDevice.get(id); if (id && deviceToUser.has(id) && (!current || numberValue(member, 'updatedAt') >= numberValue(current, 'updatedAt'))) memberByDevice.set(id, member); }
    const createdBy = deviceToUser.get(value(row, 'createdByDeviceId')) || deviceToUser.get(memberByDevice.keys().next().value || '');
    if (!createdBy) { plan.warnings.push(`Grupo ${groupId} ignorado porque nenhum membro possui backup.`); continue; }
    const members: Record<string, RelayGroupMember> = {};
    for (const [deviceId, member] of memberByDevice) {
      const userId = deviceToUser.get(deviceId)!;
      members[userId] = { groupId, deviceId: userId, role: (['owner','admin'].includes(value(member, 'role')) ? value(member, 'role') : 'member') as RelayGroupMember['role'], status: (['left','removed'].includes(value(member, 'status')) ? value(member, 'status') : 'active') as RelayGroupMember['status'], displayNameSnapshot: nullable(member, 'displayNameSnapshot'), avatarEmojiSnapshot: nullable(member, 'avatarEmojiSnapshot'), avatarBgSnapshot: nullable(member, 'avatarBgSnapshot'), joinedAt: numberValue(member, 'joinedAt') || numberValue(row, 'createdAt'), updatedAt: numberValue(member, 'updatedAt') || numberValue(row, 'updatedAt') };
    }
    if (!Object.values(members).some((member) => member.role === 'owner')) members[createdBy] = { ...(members[createdBy] || { groupId, deviceId: createdBy, status: 'active', displayNameSnapshot: null, avatarEmojiSnapshot: null, avatarBgSnapshot: null, joinedAt: numberValue(row, 'createdAt'), updatedAt: numberValue(row, 'updatedAt') }), role: 'owner' };
    const pinnedIds = Array.from(new Set(plan.backups.flatMap((backup) => backup.pinned.filter((pin) => value(pin, 'groupId') === groupId).map((pin) => value(pin, 'messageId'))).filter(Boolean)));
    const group: RelayGroup = { groupId, name: value(row, 'name') || 'Grupo', emoji: value(row, 'emoji') || '👥', avatarBg: value(row, 'avatarBg') || '#147ad6', description: value(row, 'description'), createdByDeviceId: createdBy, createdAt: numberValue(row, 'createdAt') || Date.now(), updatedAt: numberValue(row, 'updatedAt') || Date.now(), lastEventSeq: 0, deletedAt: numberValue(row, 'deletedAt') || null, settings: { allowMembersToPin: row.allowMembersToPin === undefined || numberValue(row, 'allowMembersToPin') !== 0, allowMembersToEditInfo: numberValue(row, 'allowMembersToEditInfo') === 1 }, members, pinnedMessageIds: pinnedIds };
    const events: RelayGroupEvent[] = [];
    const append = (type: RelayGroupEvent['type'], actorDeviceId: string, payload: unknown, createdAt: number): void => { events.push({ eventId: randomUUID(), groupId, seq: events.length + 1, type, actorDeviceId, payload, createdAt }); };
    append('group.created', createdBy, { group, members: Object.values(members), pinnedMessageIds: pinnedIds }, group.createdAt);
    for (const message of plan.messages.filter((item) => item.conversationId === `group:${groupId}`)) {
      const sender = deviceToUser.get(message.senderDeviceId); if (!sender || !members[sender]) continue;
      const resolved = plan.attachments.get(message.messageId);
      let metadata: RelayGroupAttachmentMetadata | null = null;
      if (message.type === 'file' && resolved && message.fileId) {
        const fileId = message.fileId;
        metadata = { groupId, messageId: message.messageId, fileId, senderDeviceId: sender, fileName: message.fileName || 'Arquivo', fileSize: resolved.size, sha256: resolved.sha256, createdAt: message.createdAt, expiresAt: Number.MAX_SAFE_INTEGER, recipients: Object.keys(members), receivedByDeviceId: Object.fromEntries(Object.keys(members).map((id) => [id, message.createdAt])), replyTo: replyPayload(message, deviceToUser), forwardedFromMessageId: message.forwardedFromMessageId, uploadedAt: message.createdAt, deletedAt: null };
        groupChunks.reset(fileId); writeFileChunks(resolved.file, (index, chunk) => groupChunks.write(index, chunk, fileId)); attachmentMetadata.push(metadata);
      }
      append('group.message.created', sender, { message: { messageId: message.messageId, groupId, type: message.type === 'file' ? 'file' : 'text', senderDeviceId: sender, bodyText: message.bodyText || '', fileId: message.fileId, fileName: message.fileName, fileSize: resolved?.size || message.fileSize, fileSha256: resolved?.sha256 || message.fileSha256, replyTo: replyPayload(message, deviceToUser), forwardedFromMessageId: message.forwardedFromMessageId, createdAt: message.createdAt, editedAt: message.editedAt }, ...(metadata ? { attachment: metadata } : {}) }, message.createdAt);
      if (metadata) append('group.attachment.available', sender, { metadata }, message.createdAt);
    }
    const groupMessageIds = new Set(plan.messages.filter((item) => item.conversationId === `group:${groupId}`).map((item) => item.messageId));
    for (const reactionRow of latestRows(plan.backups, (backup) => backup.reactions, (item) => `${value(item, 'messageId')}\0${value(item, 'reactorDeviceId')}`, 'updatedAt')) {
      const targetMessageId = value(reactionRow, 'messageId'); const actor = deviceToUser.get(value(reactionRow, 'reactorDeviceId')); const reaction = value(reactionRow, 'reaction');
      if (!groupMessageIds.has(targetMessageId) || !actor || !members[actor] || !ALLOWED_REACTIONS.has(reaction)) continue;
      append('group.message.reactionChanged', actor, { targetMessageId, reaction, updatedAt: numberValue(reactionRow, 'updatedAt') }, numberValue(reactionRow, 'updatedAt'));
    }
    for (const messageId of pinnedIds) append('group.message.pinned', createdBy, { messageId, pinnedMessageIds: pinnedIds }, group.updatedAt);
    group.lastEventSeq = events.length; outputGroups.push(group); eventsByGroupId[groupId] = events;
  }
  return { groups: outputGroups, eventsByGroupId, attachments: attachmentMetadata };
};

const applyPlan = (plan: MigrationPlan, options: CliOptions): Json => {
  if (plan.errors.length) throw new Error(`Dry-run encontrou ${plan.errors.length} erro(s); a importação foi cancelada.`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const original = path.resolve(options.relayDataDir); const staging = `${original}.migration-staging-${stamp}`; const rollback = `${original}.pre-migration-${stamp}`;
  const relativeReport = path.relative(original, options.reportFile);
  if (relativeReport && !relativeReport.startsWith('..') && !path.isAbsolute(relativeReport)) throw new Error('O relatório deve ficar fora da pasta de dados do Relay durante --apply.');
  const liveDatabase = path.join(original, 'central', 'lantern-relay.db');
  if (fs.existsSync(liveDatabase)) {
    const probe = new Database(liveDatabase, { readonly: false, fileMustExist: true, timeout: 500 });
    try { probe.exec('BEGIN EXCLUSIVE; ROLLBACK;'); }
    catch { throw new Error('O Relay parece estar em execução. Encerre-o completamente antes de aplicar a migração.'); }
    finally { probe.close(); }
  }
  fs.rmSync(staging, { recursive: true, force: true });
  if (fs.existsSync(original)) fs.cpSync(original, staging, { recursive: true }); else fs.mkdirSync(staging, { recursive: true });
  const store = new CentralStore(path.join(staging, 'central'), () => undefined);
  const credentials: Json[] = [];
  try {
    const stats = store.getStats();
    const groupsExisting = store.readCanonicalState<Json>('groups', 1);
    if (stats.frames || stats.attachments || (groupsExisting && Array.isArray(groupsExisting.groups) && groupsExisting.groups.length)) throw new Error('O Relay de destino já possui histórico. Use um Relay vazio para evitar mesclagem ambígua.');
    const existingNames = new Set(store.listUsers().map((user) => user.username)); const deviceToUser = new Map<string, string>();
    for (const planned of plan.users) {
      if (existingNames.has(planned.username)) throw new Error(`Nome de usuário já existe no Relay: ${planned.username}.`);
      const password = planned.password || randomBytes(18).toString('base64url');
      const created = store.createUser({ username: planned.username, displayName: planned.profile.displayName, department: planned.department, password, role: planned.role }, 'migration');
      store.updateUser(created.userId, { avatarEmoji: planned.profile.avatarEmoji, avatarBg: planned.profile.avatarBg, statusMessage: planned.profile.statusMessage }, 'migration');
      store.completeProfileSetup(created.userId, { avatarEmoji: planned.profile.avatarEmoji, avatarBg: planned.profile.avatarBg });
      deviceToUser.set(planned.deviceId, created.userId); credentials.push({ legacyDeviceId: planned.deviceId, userId: created.userId, username: planned.username, temporaryPassword: password });
    }
    let directMessages = 0; let reactions = 0; let announcements = 0; let directAttachments = 0; const announcementState: Json[] = [];
    const messageById = new Map(plan.messages.map((message) => [message.messageId, message]));
    const announcementReactions = new Map<string, Record<string, string>>();
    const directFrames: CanonicalFrame[] = [];
    const directReactionFrames: CanonicalFrame[] = [];
    for (const row of latestRows(plan.backups, (backup) => backup.reactions, (item) => `${value(item, 'messageId')}\0${value(item, 'reactorDeviceId')}`, 'updatedAt')) {
      const message = messageById.get(value(row, 'messageId')); const reactor = deviceToUser.get(value(row, 'reactorDeviceId')); const reaction = value(row, 'reaction');
      if (!message || !reactor || !ALLOWED_REACTIONS.has(reaction)) continue;
      if (message.type === 'announcement') announcementReactions.set(message.messageId, { ...(announcementReactions.get(message.messageId) || {}), [reactor]: reaction });
      else if (!message.conversationId.startsWith('group:')) {
        const target = message.senderDeviceId === value(row, 'reactorDeviceId') ? message.receiverDeviceId && deviceToUser.get(message.receiverDeviceId) : deviceToUser.get(message.senderDeviceId);
        if (!target) continue;
        const conversationId = `dm:${[reactor, target].sort((a, b) => a.localeCompare(b)).join(':')}`;
        const reactionMessageId = `migration-reaction-${createHash('sha256').update(`${message.messageId}\0${reactor}`).digest('hex').slice(0, 32)}`;
        directReactionFrames.push({ messageId: reactionMessageId, type: 'chat:react', senderUserId: reactor, targetUserId: target, conversationId, payload: { targetMessageId: message.messageId, reaction }, createdAt: numberValue(row, 'updatedAt') });
      }
    }
    const announcementReads = new Map<string, Record<string, number>>();
    for (const row of latestRows(plan.backups, (backup) => backup.announcementReads, (item) => `${value(item, 'messageId')}\0${value(item, 'readerDeviceId')}`, 'readAt')) {
      const reader = deviceToUser.get(value(row, 'readerDeviceId')); const messageId = value(row, 'messageId');
      if (reader && messageById.get(messageId)?.type === 'announcement') announcementReads.set(messageId, { ...(announcementReads.get(messageId) || {}), [reader]: numberValue(row, 'readAt') });
    }
    for (const message of plan.messages.filter((item) => !item.conversationId.startsWith('group:'))) {
      const sender = deviceToUser.get(message.senderDeviceId); const target = message.receiverDeviceId ? deviceToUser.get(message.receiverDeviceId) || null : null;
      if (!sender || (message.type !== 'announcement' && !target)) continue;
      const conversationId = message.type === 'announcement' ? 'announcements' : `dm:${[sender, target!].sort((a, b) => a.localeCompare(b)).join(':')}`;
      const resolved = plan.attachments.get(message.messageId);
      const payload = message.type === 'file' ? { fileId: message.fileId, messageId: message.messageId, filename: message.fileName || 'Arquivo', size: resolved?.size || message.fileSize || 0, sha256: resolved?.sha256 || message.fileSha256 || '', replyTo: replyPayload(message, deviceToUser), forwardedFromMessageId: message.forwardedFromMessageId } : { text: message.bodyText || '', replyTo: replyPayload(message, deviceToUser), forwardedFromMessageId: message.forwardedFromMessageId, editedAt: message.editedAt };
      const frameType = message.type === 'announcement' ? 'announce' : message.type === 'file' ? 'file:offer' : 'chat:text';
      directFrames.push({ messageId: message.messageId, type: frameType, senderUserId: sender, targetUserId: target, conversationId, payload, createdAt: message.createdAt });
      if (message.type === 'announcement') { announcements += 1; announcementState.push({ messageId: message.messageId, frame: { type: frameType, messageId: message.messageId, from: sender, to: null, createdAt: message.createdAt, payload }, createdAt: message.createdAt, expiresAt: Number.MAX_SAFE_INTEGER, expiredAt: null, deletedAt: null, reactionsByDeviceId: announcementReactions.get(message.messageId) || {}, readByDeviceId: announcementReads.get(message.messageId) || {} }); }
      else directMessages += 1;
      if (message.type === 'file' && resolved && message.fileId) {
        store.initAttachment({ attachmentId: message.fileId, messageId: message.messageId, ownerUserId: sender, conversationId, fileName: message.fileName || 'Arquivo', mimeType: 'application/octet-stream', size: resolved.size, sha256: resolved.sha256 });
        writeFileChunks(resolved.file, (index, chunk) => store.appendAttachmentChunk(message.fileId!, sender, index, chunk)); store.completeAttachment(message.fileId, sender); directAttachments += 1;
      }
    }
    const directReactionIds = new Set(directReactionFrames.map((frame) => frame.messageId));
    for (const frame of [...directFrames, ...directReactionFrames].sort((a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId))) {
      store.saveFrame(frame); if (directReactionIds.has(frame.messageId)) reactions += 1;
    }
    if (announcementState.length) store.writeCanonicalState('announcements', { version: 1, savedAt: Date.now(), announcements: announcementState }, 1);
    for (const backup of plan.backups) {
      const owner = deviceToUser.get(backup.profile.deviceId); if (!owner) continue;
      for (const row of backup.conversations) {
        const id = value(row, 'id'); if (!id.startsWith('dm:')) continue; const peer = deviceToUser.get(value(row, 'peerDeviceId') || id.slice(3)); if (!peer) continue;
        store.setUserConversationPreference(owner, { conversationId: `dm:${[owner, peer].sort((a, b) => a.localeCompare(b)).join(':')}`, archived: numberValue(row, 'archivedAt') > 0, readAt: numberValue(row, 'lastReadAt'), manualUnread: numberValue(row, 'unreadCount') > 0 });
      }
      for (const favorite of backup.favorites) store.setUserMessagePreference(owner, { messageId: value(favorite, 'messageId'), favorite: true });
      for (const hidden of backup.hidden) store.setUserMessagePreference(owner, { messageId: value(hidden, 'messageId'), hidden: true });
    }
    const groupChunks = new EncryptedChunkStore(path.join(staging, 'group-attachments'), store.getEncryption()); const groupState = buildGroups(plan, deviceToUser, groupChunks); if (groupState.groups.length) store.writeCanonicalState('groups', { version: 1, ...groupState }, 1);
    store.close();
    let originalMoved = false;
    try {
      if (fs.existsSync(original)) { fs.renameSync(original, rollback); originalMoved = true; }
      fs.renameSync(staging, original);
    } catch (swapError) {
      if (originalMoved && !fs.existsSync(original) && fs.existsSync(rollback)) fs.renameSync(rollback, original);
      throw swapError;
    }
    return { applied: true, relayDataDir: original, rollbackDir: fs.existsSync(rollback) ? rollback : null, users: credentials, counts: { backups: plan.backups.length, users: credentials.length, directMessages, reactions, announcements, directAttachments, groups: groupState.groups.length, groupAttachments: groupState.attachments.length }, warnings: plan.warnings };
  } catch (error) {
    try { store.close(); } catch { /* noop */ }
    fs.rmSync(staging, { recursive: true, force: true }); throw error;
  }
};

const parseArgs = (): CliOptions => {
  const args = process.argv.slice(2); const get = (name: string): string => { const index = args.indexOf(name); return index >= 0 ? String(args[index + 1] || '') : ''; };
  const backupsDir = get('--backups'); const relayDataDir = get('--relay-data');
  if (!backupsDir || !relayDataDir) throw new Error('Uso: --backups <pasta> --relay-data <pasta> [--mapping arquivo.json] [--apply].');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return { backupsDir: path.resolve(backupsDir), relayDataDir: path.resolve(relayDataDir), mappingFile: get('--mapping') ? path.resolve(get('--mapping')) : null, reportFile: path.resolve(get('--report') || path.join(process.cwd(), `lantern-migration-report-${stamp}.json`)), apply: args.includes('--apply'), allowMissingUsers: args.includes('--allow-missing-users'), allowMissingAttachments: args.includes('--allow-missing-attachments') };
};

const main = (): void => {
  const options = parseArgs(); const plan = buildPlan(options);
  const summary: Json = { applied: false, dryRun: !options.apply, source: options.backupsDir, destination: options.relayDataDir, counts: { backups: plan.backups.length, users: plan.users.length, messages: plan.messages.length, attachments: plan.attachments.size }, proposedUsers: plan.users.map((user) => ({ legacyDeviceId: user.deviceId, displayName: user.profile.displayName, username: user.username, password: user.password ? '<from mapping>' : '<generated on apply>' })), warnings: plan.warnings, errors: plan.errors };
  const report = options.apply ? applyPlan(plan, options) : summary;
  fs.writeFileSync(options.reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...report, reportFile: options.reportFile }, null, 2)}\n`);
  if (plan.errors.length) process.exitCode = 2;
};

try { main(); } catch (error) { process.stderr.write(`Falha na migração: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
