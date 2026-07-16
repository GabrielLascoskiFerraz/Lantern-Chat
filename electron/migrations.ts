import Database from 'better-sqlite3';

export const runMigrations = (db: Database.Database): void => {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA wal_autocheckpoint = 1000;

    CREATE TABLE IF NOT EXISTS profile (
      deviceId TEXT PRIMARY KEY,
      displayName TEXT NOT NULL,
      avatarEmoji TEXT NOT NULL,
      avatarBg TEXT NOT NULL,
      statusMessage TEXT NOT NULL DEFAULT 'Disponível',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS peers_cache (
      deviceId TEXT PRIMARY KEY,
      displayName TEXT,
      avatarEmoji TEXT,
      avatarBg TEXT,
      statusMessage TEXT,
      username TEXT,
      department TEXT,
      lastSeenAt INTEGER,
      lastAddress TEXT,
      lastPort INTEGER
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      peerDeviceId TEXT,
      title TEXT,
      createdAt INTEGER,
      updatedAt INTEGER,
      unreadCount INTEGER DEFAULT 0,
      lastReadAt INTEGER DEFAULT 0,
      archivedAt INTEGER DEFAULT 0
	    );

    CREATE TABLE IF NOT EXISTS messages (
      messageId TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL,
      direction TEXT NOT NULL,
      senderDeviceId TEXT NOT NULL,
      receiverDeviceId TEXT,
      type TEXT NOT NULL,
      bodyText TEXT,
      fileId TEXT,
      fileName TEXT,
      fileSize INTEGER,
      fileSha256 TEXT,
      filePath TEXT,
      status TEXT,
      reaction TEXT,
      deletedAt INTEGER,
      replyToMessageId TEXT,
      replyToSenderDeviceId TEXT,
      replyToType TEXT,
      replyToPreviewText TEXT,
      replyToFileName TEXT,
      forwardedFromMessageId TEXT,
      editedAt INTEGER,
      createdAt INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
      ON messages(conversationId, createdAt);

    CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);

    CREATE TABLE IF NOT EXISTS outbound_frames (
      messageId TEXT PRIMARY KEY,
      frameJson TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      lastError TEXT,
      nextAttemptAt INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outbound_frames_due
      ON outbound_frames(nextAttemptAt, createdAt);

    CREATE TABLE IF NOT EXISTS attachment_download_checkpoints (
      fileId TEXT PRIMARY KEY,
      messageId TEXT NOT NULL,
      tempPath TEXT NOT NULL,
      receivedBytes INTEGER NOT NULL DEFAULT 0,
      nextChunkIndex INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS canonical_sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      serverSeq INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_reactions (
      messageId TEXT NOT NULL,
      reactorDeviceId TEXT NOT NULL,
      reaction TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (messageId, reactorDeviceId)
    );

    CREATE INDEX IF NOT EXISTS idx_message_reactions_message
      ON message_reactions(messageId);

    CREATE TABLE IF NOT EXISTS pending_message_reactions (
      messageId TEXT NOT NULL,
      reactorDeviceId TEXT NOT NULL,
      reaction TEXT,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (messageId, reactorDeviceId)
    );

    CREATE INDEX IF NOT EXISTS idx_pending_message_reactions_message
      ON pending_message_reactions(messageId);

    CREATE TABLE IF NOT EXISTS message_favorites (
      messageId TEXT PRIMARY KEY,
      createdAt INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_message_favorites_created_at
      ON message_favorites(createdAt DESC);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hidden_messages (
      messageId TEXT PRIMARY KEY,
      hiddenAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS announcement_reads (
      messageId TEXT NOT NULL,
      readerDeviceId TEXT NOT NULL,
      readAt INTEGER NOT NULL,
      PRIMARY KEY (messageId, readerDeviceId)
    );

    CREATE INDEX IF NOT EXISTS idx_announcement_reads_message
      ON announcement_reads(messageId);

    CREATE TABLE IF NOT EXISTS groups (
      groupId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL,
      avatarBg TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      createdByDeviceId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      lastEventSeq INTEGER NOT NULL DEFAULT 0,
      deletedAt INTEGER,
      missingOnRelay INTEGER NOT NULL DEFAULT 0,
      allowMembersToPin INTEGER NOT NULL DEFAULT 1,
      allowMembersToEditInfo INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS group_members (
      groupId TEXT NOT NULL,
      deviceId TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      displayNameSnapshot TEXT,
      avatarEmojiSnapshot TEXT,
      avatarBgSnapshot TEXT,
      joinedAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (groupId, deviceId)
    );

    CREATE INDEX IF NOT EXISTS idx_group_members_group
      ON group_members(groupId, status, role);

    CREATE INDEX IF NOT EXISTS idx_group_members_device
      ON group_members(deviceId, status);

    CREATE TABLE IF NOT EXISTS group_pinned_messages (
      groupId TEXT NOT NULL,
      messageId TEXT NOT NULL,
      pinnedByDeviceId TEXT NOT NULL,
      pinnedAt INTEGER NOT NULL,
      PRIMARY KEY (groupId, messageId)
    );

    CREATE INDEX IF NOT EXISTS idx_group_pinned_messages_group
      ON group_pinned_messages(groupId, pinnedAt DESC);

    CREATE TABLE IF NOT EXISTS group_events_applied (
      eventId TEXT PRIMARY KEY,
      groupId TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_group_events_applied_group_seq
      ON group_events_applied(groupId, seq);

    CREATE TABLE IF NOT EXISTS group_attachment_downloads (
      fileId TEXT PRIMARY KEY,
      groupId TEXT NOT NULL,
      messageId TEXT NOT NULL,
      status TEXT NOT NULL,
      localPath TEXT,
      tempPath TEXT,
      totalBytes INTEGER NOT NULL DEFAULT 0,
      receivedBytes INTEGER NOT NULL DEFAULT 0,
      nextChunkIndex INTEGER NOT NULL DEFAULT 0,
      totalChunks INTEGER NOT NULL DEFAULT 0,
      retryCount INTEGER NOT NULL DEFAULT 0,
      lastError TEXT,
      lastAttemptAt INTEGER,
      requestId TEXT,
      receivedAt INTEGER,
      updatedAt INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_group_attachment_downloads_group
      ON group_attachment_downloads(groupId, status);

    CREATE TABLE IF NOT EXISTS group_attachment_uploads (
      fileId TEXT PRIMARY KEY,
      groupId TEXT NOT NULL,
      messageId TEXT NOT NULL,
      status TEXT NOT NULL,
      totalBytes INTEGER NOT NULL DEFAULT 0,
      sentBytes INTEGER NOT NULL DEFAULT 0,
      nextChunkIndex INTEGER NOT NULL DEFAULT 0,
      totalChunks INTEGER NOT NULL DEFAULT 0,
      retryCount INTEGER NOT NULL DEFAULT 0,
      lastError TEXT,
      lastAttemptAt INTEGER,
      updatedAt INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_group_attachment_uploads_group
      ON group_attachment_uploads(groupId, status);
  `);

  const profileColumns = db.prepare('PRAGMA table_info(profile)').all() as Array<{ name: string }>;
  if (!profileColumns.some((column) => column.name === 'statusMessage')) {
    db.exec("ALTER TABLE profile ADD COLUMN statusMessage TEXT NOT NULL DEFAULT 'Disponível';");
  }

	  const peerColumns = db.prepare('PRAGMA table_info(peers_cache)').all() as Array<{ name: string }>;
	  if (!peerColumns.some((column) => column.name === 'statusMessage')) {
	    db.exec('ALTER TABLE peers_cache ADD COLUMN statusMessage TEXT;');
	  }
	  if (!peerColumns.some((column) => column.name === 'username')) {
	    db.exec('ALTER TABLE peers_cache ADD COLUMN username TEXT;');
	  }
	  if (!peerColumns.some((column) => column.name === 'department')) {
	    db.exec('ALTER TABLE peers_cache ADD COLUMN department TEXT;');
	  }

	  const conversationColumns = db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>;
	  if (!conversationColumns.some((column) => column.name === 'lastReadAt')) {
	    db.exec('ALTER TABLE conversations ADD COLUMN lastReadAt INTEGER DEFAULT 0;');
	  }
	  if (!conversationColumns.some((column) => column.name === 'archivedAt')) {
	    db.exec('ALTER TABLE conversations ADD COLUMN archivedAt INTEGER DEFAULT 0;');
	  }
	  db.exec(`
	    UPDATE conversations
	    SET lastReadAt = COALESCE((
	      SELECT MAX(messages.createdAt)
	      FROM messages
	      WHERE messages.conversationId = conversations.id
	        AND messages.deletedAt IS NULL
	    ), 0)
	    WHERE COALESCE(unreadCount, 0) = 0
	      AND COALESCE(lastReadAt, 0) = 0;
	  `);

	  const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
  if (!messageColumns.some((column) => column.name === 'reaction')) {
    db.exec('ALTER TABLE messages ADD COLUMN reaction TEXT;');
  }
  if (!messageColumns.some((column) => column.name === 'deletedAt')) {
    db.exec('ALTER TABLE messages ADD COLUMN deletedAt INTEGER;');
  }
  if (!messageColumns.some((column) => column.name === 'replyToMessageId')) {
    db.exec('ALTER TABLE messages ADD COLUMN replyToMessageId TEXT;');
  }
  if (!messageColumns.some((column) => column.name === 'replyToSenderDeviceId')) {
    db.exec('ALTER TABLE messages ADD COLUMN replyToSenderDeviceId TEXT;');
  }
  if (!messageColumns.some((column) => column.name === 'replyToType')) {
    db.exec('ALTER TABLE messages ADD COLUMN replyToType TEXT;');
  }
  if (!messageColumns.some((column) => column.name === 'replyToPreviewText')) {
    db.exec('ALTER TABLE messages ADD COLUMN replyToPreviewText TEXT;');
  }
  if (!messageColumns.some((column) => column.name === 'replyToFileName')) {
    db.exec('ALTER TABLE messages ADD COLUMN replyToFileName TEXT;');
  }
  if (!messageColumns.some((column) => column.name === 'forwardedFromMessageId')) {
    db.exec('ALTER TABLE messages ADD COLUMN forwardedFromMessageId TEXT;');
  }
  if (!messageColumns.some((column) => column.name === 'editedAt')) {
    db.exec('ALTER TABLE messages ADD COLUMN editedAt INTEGER;');
  }
  if (!messageColumns.some((column) => column.name === 'serverSeq')) {
    db.exec('ALTER TABLE messages ADD COLUMN serverSeq INTEGER;');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_server_seq ON messages(serverSeq);');

  db.exec(`
    CREATE TABLE IF NOT EXISTS message_favorites (
      messageId TEXT PRIMARY KEY,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_message_favorites_created_at
      ON message_favorites(createdAt DESC);
    CREATE TABLE IF NOT EXISTS pending_message_reactions (
      messageId TEXT NOT NULL,
      reactorDeviceId TEXT NOT NULL,
      reaction TEXT,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (messageId, reactorDeviceId)
    );
    CREATE INDEX IF NOT EXISTS idx_pending_message_reactions_message
      ON pending_message_reactions(messageId);
    CREATE TABLE IF NOT EXISTS hidden_messages (
      messageId TEXT PRIMARY KEY,
      hiddenAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS announcement_reads (
      messageId TEXT NOT NULL,
      readerDeviceId TEXT NOT NULL,
      readAt INTEGER NOT NULL,
      PRIMARY KEY (messageId, readerDeviceId)
    );
    CREATE INDEX IF NOT EXISTS idx_announcement_reads_message
      ON announcement_reads(messageId);
    CREATE TABLE IF NOT EXISTS groups (
      groupId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL,
      avatarBg TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      createdByDeviceId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      lastEventSeq INTEGER NOT NULL DEFAULT 0,
      deletedAt INTEGER,
      missingOnRelay INTEGER NOT NULL DEFAULT 0,
      allowMembersToPin INTEGER NOT NULL DEFAULT 1,
      allowMembersToEditInfo INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS group_members (
      groupId TEXT NOT NULL,
      deviceId TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      displayNameSnapshot TEXT,
      avatarEmojiSnapshot TEXT,
      avatarBgSnapshot TEXT,
      joinedAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (groupId, deviceId)
    );
    CREATE INDEX IF NOT EXISTS idx_group_members_group
      ON group_members(groupId, status, role);
    CREATE INDEX IF NOT EXISTS idx_group_members_device
      ON group_members(deviceId, status);
    CREATE TABLE IF NOT EXISTS group_pinned_messages (
      groupId TEXT NOT NULL,
      messageId TEXT NOT NULL,
      pinnedByDeviceId TEXT NOT NULL,
      pinnedAt INTEGER NOT NULL,
      PRIMARY KEY (groupId, messageId)
    );
    CREATE INDEX IF NOT EXISTS idx_group_pinned_messages_group
      ON group_pinned_messages(groupId, pinnedAt DESC);
    CREATE TABLE IF NOT EXISTS group_events_applied (
      eventId TEXT PRIMARY KEY,
      groupId TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_events_applied_group_seq
      ON group_events_applied(groupId, seq);
    CREATE TABLE IF NOT EXISTS group_attachment_downloads (
      fileId TEXT PRIMARY KEY,
      groupId TEXT NOT NULL,
      messageId TEXT NOT NULL,
      status TEXT NOT NULL,
      localPath TEXT,
      receivedAt INTEGER,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_group_attachment_downloads_group
      ON group_attachment_downloads(groupId, status);
  `);

  const groupColumns = db.prepare('PRAGMA table_info(groups)').all() as Array<{ name: string }>;
  if (!groupColumns.some((column) => column.name === 'missingOnRelay')) {
    db.exec('ALTER TABLE groups ADD COLUMN missingOnRelay INTEGER NOT NULL DEFAULT 0;');
  }

  const groupAttachmentColumns = db
    .prepare('PRAGMA table_info(group_attachment_downloads)')
    .all() as Array<{ name: string }>;
  const addGroupAttachmentColumn = (name: string, definition: string): void => {
    if (!groupAttachmentColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE group_attachment_downloads ADD COLUMN ${name} ${definition};`);
    }
  };
  addGroupAttachmentColumn('tempPath', 'TEXT');
  addGroupAttachmentColumn('totalBytes', 'INTEGER NOT NULL DEFAULT 0');
  addGroupAttachmentColumn('receivedBytes', 'INTEGER NOT NULL DEFAULT 0');
  addGroupAttachmentColumn('nextChunkIndex', 'INTEGER NOT NULL DEFAULT 0');
  addGroupAttachmentColumn('totalChunks', 'INTEGER NOT NULL DEFAULT 0');
  addGroupAttachmentColumn('retryCount', 'INTEGER NOT NULL DEFAULT 0');
  addGroupAttachmentColumn('lastError', 'TEXT');
  addGroupAttachmentColumn('lastAttemptAt', 'INTEGER');
  addGroupAttachmentColumn('requestId', 'TEXT');
};
