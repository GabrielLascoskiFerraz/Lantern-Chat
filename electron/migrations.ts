import Database from 'better-sqlite3';

export const runMigrations = (db: Database.Database): void => {
  db.exec(`
    PRAGMA journal_mode = WAL;

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
  `);

  const profileColumns = db.prepare('PRAGMA table_info(profile)').all() as Array<{ name: string }>;
  if (!profileColumns.some((column) => column.name === 'statusMessage')) {
    db.exec("ALTER TABLE profile ADD COLUMN statusMessage TEXT NOT NULL DEFAULT 'Disponível';");
  }

	  const peerColumns = db.prepare('PRAGMA table_info(peers_cache)').all() as Array<{ name: string }>;
	  if (!peerColumns.some((column) => column.name === 'statusMessage')) {
	    db.exec('ALTER TABLE peers_cache ADD COLUMN statusMessage TEXT;');
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
  `);
};
