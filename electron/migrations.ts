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
      unreadCount INTEGER DEFAULT 0
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

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const profileColumns = db.prepare('PRAGMA table_info(profile)').all() as Array<{ name: string }>;
  if (!profileColumns.some((column) => column.name === 'statusMessage')) {
    db.exec("ALTER TABLE profile ADD COLUMN statusMessage TEXT NOT NULL DEFAULT 'Disponível';");
  }

  const peerColumns = db.prepare('PRAGMA table_info(peers_cache)').all() as Array<{ name: string }>;
  if (!peerColumns.some((column) => column.name === 'statusMessage')) {
    db.exec('ALTER TABLE peers_cache ADD COLUMN statusMessage TEXT;');
  }

  const messageColumns = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
  if (!messageColumns.some((column) => column.name === 'reaction')) {
    db.exec('ALTER TABLE messages ADD COLUMN reaction TEXT;');
  }
  if (!messageColumns.some((column) => column.name === 'deletedAt')) {
    db.exec('ALTER TABLE messages ADD COLUMN deletedAt INTEGER;');
  }
};
