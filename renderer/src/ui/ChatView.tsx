import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Caption1, Input, ProgressBar, Spinner, Text } from '@fluentui/react-components';
import {
  ChevronDown20Regular,
  ChevronUp20Regular,
  Checkmark20Regular,
  Delete20Regular,
  Dismiss20Regular,
  MoreHorizontal20Regular,
  Search20Regular
} from '@fluentui/react-icons';
import { AnnouncementReactionSummary, ipcClient, MessageRow, Peer, Profile } from '../api/ipcClient';
import { Avatar } from './Avatar';
import { ConfirmDialog } from './ConfirmDialog';
import { MessageComposer } from './MessageComposer';

interface ChatViewProps {
  conversationId: string;
  peer: Peer | null;
  peerOnline: boolean;
  peerTyping: boolean;
  loading: boolean;
  localProfile: Profile;
  messages: MessageRow[];
  reactionsByMessageId: Record<string, AnnouncementReactionSummary>;
  transferByFileId: Record<string, { transferred: number; total: number }>;
  recentMessageIds: Record<string, number>;
  onSend: (text: string) => Promise<void>;
  onTyping: (isTyping: boolean) => Promise<void>;
  onSendFile: (filePath: string) => Promise<void>;
  onReactToMessage: (messageId: string, reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
  onClearConversation: () => Promise<void>;
  onForgetContactConversation: () => Promise<void>;
  onOpenFile: (filePath: string) => Promise<void>;
  onSearchMessageIds: (query: string) => Promise<string[]>;
  onEnsureMessagesLoaded: (messageIds: string[]) => Promise<void>;
}

const formatTime = (value: number): string =>
  new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

const isSameDay = (a: number, b: number): boolean => {
  const ad = new Date(a);
  const bd = new Date(b);
  return (
    ad.getFullYear() === bd.getFullYear() &&
    ad.getMonth() === bd.getMonth() &&
    ad.getDate() === bd.getDate()
  );
};

const formatDateSeparator = (value: number): string => {
  const now = new Date();
  const target = new Date(value);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const diffDays = Math.round((today - targetDay) / 86_400_000);

  if (diffDays === 0) return 'Hoje';
  if (diffDays === 1) return 'Ontem';
  return target.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
};

const statusLabel = (status: MessageRow['status']): string => {
  if (status === 'delivered') return 'Entregue';
  if (status === 'failed') return 'Não enviada';
  return 'Enviando';
};

const formatBytes = (bytes: number | null | undefined): string => {
  const safe = Number(bytes || 0);
  if (!Number.isFinite(safe) || safe <= 0) return '0 B';
  if (safe < 1024) return `${safe} B`;
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1)} KB`;
  if (safe < 1024 * 1024 * 1024) return `${(safe / (1024 * 1024)).toFixed(1)} MB`;
  return `${(safe / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

const isImageName = (name: string | null): boolean => {
  if (!name) return false;
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
};

const transferStageLabel = (
  message: MessageRow,
  progressPercent: number | null
): { label: string; tone: 'neutral' | 'active' | 'done' | 'error' } => {
  if (message.status === 'failed') {
    return { label: 'Falha no envio', tone: 'error' };
  }
  if (typeof progressPercent === 'number' && progressPercent >= 0 && progressPercent < 100) {
    return {
      label: `${message.direction === 'out' ? 'Enviando' : 'Recebendo'} ${progressPercent}%`,
      tone: 'active'
    };
  }
  if (message.status === 'delivered') {
    return { label: 'Concluído', tone: 'done' };
  }
  if (message.status === 'sent') {
    return { label: 'Preparando envio', tone: 'neutral' };
  }
  return { label: 'Processando', tone: 'neutral' };
};

const REACTIONS: Array<'👍' | '👎' | '❤️' | '😢' | '😊' | '😂'> = ['👍', '👎', '❤️', '😂', '😊', '😢'];

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const highlightText = (text: string, query: string, keyPrefix: string): ReactNode[] => {
  if (!query.trim()) {
    return [text];
  }

  const safeQuery = escapeRegExp(query.trim());
  const regex = new RegExp(`(${safeQuery})`, 'gi');
  const pieces = text.split(regex);

  return pieces.map((piece, index) => {
    if (piece.toLowerCase() === query.trim().toLowerCase()) {
      return (
        <mark key={`${keyPrefix}-mark-${index}`} className="message-highlight">
          {piece}
        </mark>
      );
    }
    return <span key={`${keyPrefix}-txt-${index}`}>{piece}</span>;
  });
};

const renderMessageText = (text: string, query: string, onOpen: (url: string) => void): ReactNode[] => {
  const regex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let fragmentIndex = 0;

  match = regex.exec(text);
  while (match) {
    const raw = match[0];
    const index = match.index;
    if (index > lastIndex) {
      parts.push(...highlightText(text.slice(lastIndex, index), query, `p-${fragmentIndex}`));
      fragmentIndex += 1;
    }
    const href = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`;
    parts.push(
      <a
        key={`${href}-${index}`}
        href={href}
        className="message-link"
        onClick={(event) => {
          event.preventDefault();
          onOpen(href);
        }}
      >
        {highlightText(raw, query, `l-${fragmentIndex}`)}
      </a>
    );
    fragmentIndex += 1;
    lastIndex = index + raw.length;
    match = regex.exec(text);
  }

  if (lastIndex < text.length) {
    parts.push(...highlightText(text.slice(lastIndex), query, `p-${fragmentIndex}`));
  }

  return parts;
};

export const ChatView = ({
  conversationId,
  peer,
  peerOnline,
  peerTyping,
  loading,
  localProfile,
  messages,
  reactionsByMessageId,
  transferByFileId,
  recentMessageIds,
  onSend,
  onTyping,
  onSendFile,
  onReactToMessage,
  onDeleteMessage,
  onClearConversation,
  onForgetContactConversation,
  onOpenFile,
  onSearchMessageIds,
  onEnsureMessagesLoaded
}: ChatViewProps) => {
  const [previewByMessageId, setPreviewByMessageId] = useState<Record<string, string>>({});
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState<string | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const [matchedMessageIds, setMatchedMessageIds] = useState<string[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [confirmForgetOpen, setConfirmForgetOpen] = useState(false);
  const [pendingDeleteMessageId, setPendingDeleteMessageId] = useState<string | null>(null);
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const matchRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const lastMessageCountRef = useRef(0);
  const lastMessageIdRef = useRef<string | null>(null);
  const stickToBottomRef = useRef(true);
  const forceScrollOnOpenRef = useRef(false);
  const forceScrollTimeoutRef = useRef<number | null>(null);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const matchedMessageIdSet = useMemo(() => new Set(matchedMessageIds), [matchedMessageIds]);

  useEffect(() => {
    let cancelled = false;
    if (!normalizedQuery) {
      setMatchedMessageIds((current) => (current.length === 0 ? current : []));
      setSearchLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setSearchLoading(true);
    void onSearchMessageIds(normalizedQuery)
      .then(async (messageIds) => {
        if (cancelled) return;
        const uniqueIds = Array.from(new Set(messageIds));
        await onEnsureMessagesLoaded(uniqueIds);
        if (cancelled) return;
        setMatchedMessageIds((current) => {
          if (
            current.length === uniqueIds.length &&
            current.every((value, index) => value === uniqueIds[index])
          ) {
            return current;
          }
          return uniqueIds;
        });
      })
      .catch(() => {
        if (cancelled) return;
        setMatchedMessageIds((current) => (current.length === 0 ? current : []));
      })
      .finally(() => {
        if (!cancelled) {
          setSearchLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [normalizedQuery, conversationId, onEnsureMessagesLoaded, onSearchMessageIds]);

  const isNearBottom = (): boolean => {
    const node = messagesScrollRef.current;
    if (!node) return true;
    const threshold = 64;
    return node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
  };

  const scrollToBottom = (behavior: ScrollBehavior = 'auto'): void => {
    const node = messagesScrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    stickToBottomRef.current = true;
  };

  const maybeFollowBottom = (force = false, behavior: ScrollBehavior = 'auto'): void => {
    if (force || stickToBottomRef.current || isNearBottom()) {
      scrollToBottom(behavior);
    }
  };

  useEffect(() => {
    const node = messagesScrollRef.current;
    if (!node) return;

    const onScroll = () => {
      stickToBottomRef.current = isNearBottom();
    };

    stickToBottomRef.current = isNearBottom();
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [peer?.deviceId]);

  useEffect(() => {
    if (normalizedQuery) return;
    stickToBottomRef.current = true;
    forceScrollOnOpenRef.current = true;
    if (forceScrollTimeoutRef.current) {
      window.clearTimeout(forceScrollTimeoutRef.current);
      forceScrollTimeoutRef.current = null;
    }
    const frameA = window.requestAnimationFrame(() => {
      maybeFollowBottom(true, 'auto');
      const frameB = window.requestAnimationFrame(() => {
        maybeFollowBottom(true, 'auto');
      });
      return () => window.cancelAnimationFrame(frameB);
    });
    forceScrollTimeoutRef.current = window.setTimeout(() => {
      forceScrollOnOpenRef.current = false;
      forceScrollTimeoutRef.current = null;
    }, 700);
    return () => window.cancelAnimationFrame(frameA);
  }, [peer?.deviceId, normalizedQuery]);

  useEffect(() => {
    if (normalizedQuery) return;
    const frame = window.requestAnimationFrame(() => {
      maybeFollowBottom(false, 'auto');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [transferByFileId, normalizedQuery]);

  useEffect(() => {
    if (normalizedQuery) return;
    const onResize = () => {
      maybeFollowBottom(false, 'auto');
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [normalizedQuery]);

  useEffect(() => {
    let cancelled = false;
    const loadPreviews = async () => {
      for (const message of messages) {
        if (message.type !== 'file' || !message.filePath || !isImageName(message.fileName)) continue;
        if (previewByMessageId[message.messageId]) continue;

        const preview = await ipcClient.getFilePreview(message.filePath);
        if (!preview || cancelled) continue;

        setPreviewByMessageId((current) =>
          current[message.messageId] ? current : { ...current, [message.messageId]: preview }
        );
      }
    };

    void loadPreviews();
    return () => {
      cancelled = true;
    };
  }, [messages, previewByMessageId]);

  useEffect(() => {
    if (normalizedQuery) return;
    const node = messagesScrollRef.current;
    if (!node) return;

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.type !== 'file' || !isImageName(lastMessage.fileName)) {
      return;
    }
    if (!previewByMessageId[lastMessage.messageId]) {
      return;
    }
    const isRecent = Boolean(recentMessageIds[lastMessage.messageId]);
    const shouldFollow =
      isRecent ||
      lastMessage.direction === 'out' ||
      lastMessage.senderDeviceId === localProfile.deviceId;
    if (!shouldFollow) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      maybeFollowBottom(false, 'auto');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [previewByMessageId, messages, normalizedQuery, recentMessageIds, localProfile.deviceId]);

  useEffect(() => {
    if (normalizedQuery) return;
    const currentLastId = messages.length > 0 ? messages[messages.length - 1].messageId : null;
    const previousCount = lastMessageCountRef.current;
    const previousLastId = lastMessageIdRef.current;
    const hasNewTailMessage =
      messages.length > previousCount || (currentLastId !== null && currentLastId !== previousLastId);

    if (forceScrollOnOpenRef.current || hasNewTailMessage) {
      const frame = window.requestAnimationFrame(() => {
        maybeFollowBottom(forceScrollOnOpenRef.current, 'auto');
      });
      lastMessageCountRef.current = messages.length;
      lastMessageIdRef.current = currentLastId;
      return () => window.cancelAnimationFrame(frame);
    }

    lastMessageCountRef.current = messages.length;
    lastMessageIdRef.current = currentLastId;
    return undefined;
  }, [messages, normalizedQuery]);

  useEffect(
    () => () => {
      if (forceScrollTimeoutRef.current) {
        window.clearTimeout(forceScrollTimeoutRef.current);
        forceScrollTimeoutRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    const onClickOutside = (event: MouseEvent) => {
      if (!headerMenuRef.current) return;
      if (!headerMenuRef.current.contains(event.target as Node)) {
        setHeaderMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onClickOutside);
    return () => window.removeEventListener('mousedown', onClickOutside);
  }, []);

  useEffect(() => {
    if (searchOpen) {
      const frame = window.requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
    return undefined;
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) {
      setSearchQuery((current) => (current === '' ? current : ''));
      setActiveMatchIndex((current) => (current === -1 ? current : -1));
      setMatchedMessageIds((current) => (current.length === 0 ? current : []));
      return;
    }
    if (!normalizedQuery || matchedMessageIds.length === 0) {
      setActiveMatchIndex(-1);
      return;
    }
    setActiveMatchIndex((current) =>
      current >= 0 && current < matchedMessageIds.length ? current : 0
    );
  }, [searchOpen, normalizedQuery, matchedMessageIds]);

  useEffect(() => {
    if (activeMatchIndex < 0) return;
    const messageId = matchedMessageIds[activeMatchIndex];
    if (!messageId) return;
    const node = matchRowRefs.current[messageId];
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeMatchIndex, matchedMessageIds]);

  if (!peer) {
    return <div className="empty-state">Selecione um contato para abrir o histórico da conversa.</div>;
  }

  return (
    <div className="main-pane">
      <header className="pane-header">
        <div className="pane-header-left">
          <Avatar emoji={peer.avatarEmoji} bg={peer.avatarBg} />
          <div className="pane-header-identity">
            <Text weight="semibold">{peer.displayName}</Text>
            <Caption1>
              {peerTyping
                ? 'digitando...'
                : peerOnline
                ? peer.statusMessage?.trim() || 'Online'
                : 'Offline · sem conexão no momento'}
            </Caption1>
          </div>
        </div>
        <div className="pane-header-actions">
          <div className={`chat-search-wrap ${searchOpen ? 'open' : ''}`}>
            {searchOpen && (
              <>
                <Input
                  className="chat-search-input"
                  placeholder="Buscar nesta conversa"
                  value={searchQuery}
                  onChange={(_, data) => setSearchQuery(data.value)}
                  ref={searchInputRef}
                />
                <button
                  type="button"
                  className="chat-search-nav-btn"
                  disabled={matchedMessageIds.length === 0}
                  onClick={() =>
                    setActiveMatchIndex((current) =>
                      matchedMessageIds.length === 0
                        ? -1
                        : (current - 1 + matchedMessageIds.length) % matchedMessageIds.length
                    )
                  }
                >
                  <ChevronUp20Regular />
                </button>
                <button
                  type="button"
                  className="chat-search-nav-btn"
                  disabled={matchedMessageIds.length === 0}
                  onClick={() =>
                    setActiveMatchIndex((current) =>
                      matchedMessageIds.length === 0 ? -1 : (current + 1) % matchedMessageIds.length
                    )
                  }
                >
                  <ChevronDown20Regular />
                </button>
                <Text size={200} className="chat-search-count">
                  {searchLoading
                    ? '...'
                    : matchedMessageIds.length === 0 || activeMatchIndex < 0
                    ? '0/0'
                    : `${activeMatchIndex + 1}/${matchedMessageIds.length}`}
                </Text>
              </>
            )}
            <Button
              appearance="subtle"
              icon={searchOpen ? <Dismiss20Regular /> : <Search20Regular />}
              onClick={() => setSearchOpen((open) => !open)}
            />
          </div>
          <div className="header-menu-wrap" ref={headerMenuRef}>
            <Button
              appearance="subtle"
              icon={<MoreHorizontal20Regular />}
              onClick={() => setHeaderMenuOpen((open) => !open)}
            />
            {headerMenuOpen && (
              <div className="header-menu">
                <button
                  type="button"
                  className="header-menu-item"
                  onClick={() => {
                    setHeaderMenuOpen(false);
                    setConfirmClearOpen(true);
                  }}
                >
                  <span className="menu-item-icon">
                    <Delete20Regular />
                  </span>
                  <span>Limpar conversa</span>
                </button>
                <button
                  type="button"
                  className="header-menu-item danger"
                  onClick={() => {
                    setHeaderMenuOpen(false);
                    setConfirmForgetOpen(true);
                  }}
                >
                  <span className="menu-item-icon">
                    <Dismiss20Regular />
                  </span>
                  <span>Excluir contato e conversa</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="messages-scroll" ref={messagesScrollRef}>
        {loading && messages.length === 0 && (
          <div className="messages-skeleton-list" aria-hidden>
            <div className="message-skeleton-row in" />
            <div className="message-skeleton-row in" />
            <div className="message-skeleton-row out" />
            <div className="message-skeleton-row out" />
          </div>
        )}
        {messages.map((message, index) => {
          const previousMessage = index > 0 ? messages[index - 1] : null;
          const startsNewDay =
            !previousMessage || !isSameDay(previousMessage.createdAt, message.createdAt);
          const groupedWithPrevious =
            Boolean(previousMessage) &&
            !startsNewDay &&
            previousMessage!.direction === message.direction &&
            previousMessage!.senderDeviceId === message.senderDeviceId;

          const outgoing = message.direction === 'out';
          const isFile = message.type === 'file';
          const isDeleted = Boolean(message.deletedAt);
          const isLocalOnly = Boolean(message.localOnly);
          const canShowActions = !isDeleted && !isLocalOnly;
          const summary = reactionsByMessageId[message.messageId] || { counts: {}, myReaction: null };
          const hasCounters = REACTIONS.some((reaction) => (summary.counts[reaction] || 0) > 0);
          const isImageFile = isFile && isImageName(message.fileName);
          const previewDataUrl = previewByMessageId[message.messageId];
          const progress = message.fileId ? transferByFileId[message.fileId] : undefined;
          const progressPercent =
            progress && progress.total > 0
              ? Math.min(100, Math.floor((progress.transferred / progress.total) * 100))
              : null;
          const transferStage = isFile ? transferStageLabel(message, progressPercent) : null;

          return (
            <div key={message.messageId}>
              {startsNewDay && (
                <div className="messages-date-separator">
                  <span>{formatDateSeparator(message.createdAt)}</span>
                </div>
              )}
              <div
                className={`bubble-row ${outgoing ? 'out' : 'in'} ${groupedWithPrevious ? 'grouped' : ''} ${hasCounters ? 'has-static-reaction' : ''} ${canShowActions ? 'has-actions' : ''} ${recentMessageIds[message.messageId] ? 'is-new' : ''} ${matchedMessageIdSet.has(message.messageId) ? 'search-match' : ''} ${matchedMessageIds[activeMatchIndex] === message.messageId ? 'search-match-active' : ''}`}
                ref={(node) => {
                  if (matchedMessageIdSet.has(message.messageId)) {
                    matchRowRefs.current[message.messageId] = node;
                  }
                }}
              >
                {!outgoing && !groupedWithPrevious && (
                  <Avatar emoji={peer.avatarEmoji} bg={peer.avatarBg} size={30} />
                )}
                {!outgoing && groupedWithPrevious && <div className="avatar-spacer" />}
              <div className={`bubble-block ${outgoing ? 'out' : 'in'}`}>
                <div
                  className={`bubble ${outgoing ? 'out' : 'in'} ${isDeleted ? 'deleted' : ''} ${
                    message.status === 'failed' ? 'failed' : ''
                  }`}
                >
                  {isDeleted ? (
                    <div className="message-deleted">Esta mensagem foi apagada.</div>
                  ) : isFile ? (
                    <>
                      <div className="message-file-title">📎 {message.fileName}</div>
                      {isImageFile && previewDataUrl && (
                        <button
                          type="button"
                          className="message-image-preview-btn"
                          onClick={() => void onOpenFile(message.filePath!)}
                        >
                          <img src={previewDataUrl} alt={message.fileName || 'Imagem'} className="message-image-preview" />
                        </button>
                      )}
                      <div className="message-file-meta">
                        {((message.fileSize || 0) / 1024).toFixed(1)} KB · SHA-256 {message.fileSha256?.slice(0, 10)}...
                      </div>
                      {progressPercent !== null && (
                        <div className="message-file-progress-wrap">
                          <ProgressBar value={progressPercent / 100} thickness="medium" />
                          <div className="message-file-progress">
                            Transferência: {progressPercent}% · {formatBytes(progress?.transferred)} /{' '}
                            {formatBytes(progress?.total)}
                          </div>
                        </div>
                      )}
                      {transferStage && (
                        <div className={`transfer-stage-pill ${transferStage.tone}`}>
                          {transferStage.label}
                        </div>
                      )}
                      {message.filePath && message.status === 'delivered' ? (
                        <Button size="small" onClick={() => void onOpenFile(message.filePath!)}>
                          Abrir
                        </Button>
                      ) : message.status === 'failed' ? (
                        <div className="inline-status error">
                          <Caption1>Não foi possível enviar este anexo.</Caption1>
                        </div>
                      ) : (
                        <div className="inline-status">
                          <Spinner size="tiny" />
                          <Caption1>aguardando arquivo completo...</Caption1>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="message-text">
                      {renderMessageText(message.bodyText || '', searchQuery, (url) => {
                        void ipcClient.openExternalUrl(url);
                      })}
                    </div>
                  )}

                  <div className="bubble-meta">
                    <span className="bubble-time">
                      <Checkmark20Regular />
                      <span>{formatTime(message.createdAt)}</span>
                    </span>
                    {outgoing && <span>{statusLabel(message.status)}</span>}
                  </div>
                </div>

                {canShowActions && (
                  <>
                    <div
                      className={`bubble-actions-row ${outgoing ? 'out' : 'in'} ${
                        reactionPickerMessageId === message.messageId ? 'visible' : ''
                      }`}
                    >
                      <button
                        type="button"
                        className="reaction-trigger"
                        onClick={() =>
                          setReactionPickerMessageId((current) =>
                            current === message.messageId ? null : message.messageId
                          )
                        }
                      >
                        {summary.myReaction || '🙂'}
                      </button>

                      {reactionPickerMessageId === message.messageId && (
                        <div className="reaction-picker">
                          {REACTIONS.map((reaction) => (
                            <button
                              key={reaction}
                              type="button"
                              className={`reaction-btn ${summary.myReaction === reaction ? 'active' : ''}`}
                              onClick={() => {
                                void onReactToMessage(
                                  message.messageId,
                                  summary.myReaction === reaction ? null : reaction
                                );
                                setReactionPickerMessageId(null);
                              }}
                            >
                              {reaction}
                            </button>
                          ))}
                        </div>
                      )}

                      {outgoing && (
                        <Button
                          appearance="subtle"
                          size="small"
                          icon={<Delete20Regular />}
                          onClick={() => setPendingDeleteMessageId(message.messageId)}
                        >
                          Excluir
                        </Button>
                      )}
                    </div>
                    {hasCounters && (
                      <div className={`bubble-reaction-static ${outgoing ? 'out' : 'in'} announcement-reactions`}>
                        {REACTIONS.filter((reaction) => (summary.counts[reaction] || 0) > 0).map((reaction) => (
                          <button
                            key={`${message.messageId}-${reaction}`}
                            type="button"
                            className={`announcement-reaction-pill ${summary.myReaction === reaction ? 'active' : ''}`}
                            onClick={() =>
                              void onReactToMessage(
                                message.messageId,
                                summary.myReaction === reaction ? null : reaction
                              )
                            }
                          >
                            <span>{reaction}</span>
                            <span>{summary.counts[reaction]}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
                {outgoing && !groupedWithPrevious && (
                  <Avatar emoji={localProfile.avatarEmoji} bg={localProfile.avatarBg} size={30} />
                )}
                {outgoing && groupedWithPrevious && <div className="avatar-spacer" />}
              </div>
            </div>
          );
        })}
      </div>

      {!peerOnline && (
        <div className="chat-offline-hint">
          Este contato está offline. Você pode consultar o histórico local, mas o envio só é liberado quando ele voltar.
        </div>
      )}
      {peerOnline && peerTyping && (
        <div className="typing-indicator-row">
          <Avatar emoji={peer.avatarEmoji} bg={peer.avatarBg} size={24} />
          <div className="typing-indicator-bubble">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </div>
        </div>
      )}

      <MessageComposer
        placeholder="Digite sua mensagem"
        disabled={!peerOnline}
        autoFocusKey={peer.deviceId}
        onSend={onSend}
        onTypingChange={onTyping}
        onSendFile={onSendFile}
      />

      <ConfirmDialog
        open={confirmClearOpen}
        title="Limpar conversa"
        description="Esta ação remove toda a conversa e anexos salvos pelo Lantern neste dispositivo."
        confirmLabel="Excluir"
        onCancel={() => setConfirmClearOpen(false)}
        onConfirm={() => {
          setConfirmClearOpen(false);
          void onClearConversation();
        }}
      />

      <ConfirmDialog
        open={Boolean(pendingDeleteMessageId)}
        title="Excluir"
        description="Esta mensagem será removida para você e para o outro usuário."
        confirmLabel="Excluir"
        onCancel={() => setPendingDeleteMessageId(null)}
        onConfirm={() => {
          if (pendingDeleteMessageId) {
            void onDeleteMessage(pendingDeleteMessageId);
          }
          setPendingDeleteMessageId(null);
        }}
      />

      <ConfirmDialog
        open={confirmForgetOpen}
        title="Excluir contato e conversa"
        description="Isso remove o contato da sidebar e apaga a conversa/anexos para os dois usuários. O contato só volta a aparecer quando reconectar."
        confirmLabel="Excluir"
        onCancel={() => setConfirmForgetOpen(false)}
        onConfirm={() => {
          setConfirmForgetOpen(false);
          void onForgetContactConversation();
        }}
      />
    </div>
  );
};
