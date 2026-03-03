import {
  MouseEvent as ReactMouseEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { Button, Caption1, Input, ProgressBar, Spinner, Text } from '@fluentui/react-components';
import {
  ArrowReply20Regular,
  ArrowForward20Regular,
  ArrowSync20Regular,
  ChevronDown20Regular,
  ChevronUp20Regular,
  Checkmark20Regular,
  Clock20Regular,
  Emoji20Regular,
  Copy20Regular,
  Delete20Regular,
  Dismiss20Regular,
  MoreHorizontal20Regular,
  Search20Regular,
  Star20Filled,
  Star20Regular
} from '@fluentui/react-icons';
import {
  AnnouncementReactionSummary,
  ipcClient,
  MessageReplyReference,
  MessageRow,
  Peer,
  Profile
} from '../api/ipcClient';
import { Avatar } from './Avatar';
import { ConfirmDialog } from './ConfirmDialog';
import { ForwardMessageDialog } from './ForwardMessageDialog';
import { MessageComposer } from './MessageComposer';

interface ChatViewProps {
  conversationId: string;
  peer: Peer | null;
  forwardTargets: Peer[];
  onlinePeerIds: string[];
  peerOnline: boolean;
  peerTyping: boolean;
  loading: boolean;
  localProfile: Profile;
  messages: MessageRow[];
  reactionsByMessageId: Record<string, AnnouncementReactionSummary>;
  favoriteByMessageId: Record<string, boolean>;
  transferByFileId: Record<string, { transferred: number; total: number }>;
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  recentMessageIds: Record<string, number>;
  unreadAtOpen: number;
  unreadAnchorMessageId: string | null;
  onSend: (text: string, replyTo?: MessageReplyReference | null) => Promise<void>;
  onTyping: (isTyping: boolean) => Promise<void>;
  onSendFile?: (filePath: string, replyTo?: MessageReplyReference | null) => Promise<void>;
  onForwardMessage: (targetPeerIds: string[], sourceMessageId: string) => Promise<void>;
  onReactToMessage: (messageId: string, reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null) => Promise<void>;
  onToggleFavoriteMessage: (messageId: string, favorite: boolean) => Promise<void>;
  onGetFavoriteMessages: (conversationId: string) => Promise<MessageRow[]>;
  onDeleteMessage: (messageId: string) => Promise<void>;
  onResyncConversation: () => Promise<void>;
  onClearConversation: () => Promise<void>;
  onForgetContactConversation: () => Promise<void>;
  onOpenFile: (filePath: string) => Promise<void>;
  onSaveFileAs: (filePath: string, fileName?: string | null) => Promise<void>;
  onSearchMessageIds: (query: string) => Promise<string[]>;
  onLoadOlderMessages: () => Promise<number>;
  onEnsureMessagesLoaded: (messageIds: string[]) => Promise<void>;
}

interface ReplyDraftUi extends MessageReplyReference {
  senderLabel: string;
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
  if (status === 'read') return 'Entregue';
  if (status === 'delivered') return 'Entregue';
  if (status === 'failed') return 'Não enviada';
  return 'Pendente';
};

const renderOutgoingStatusIcon = (status: MessageRow['status']): ReactNode => {
  if (status === 'sent' || status === null) {
    return <Clock20Regular className="bubble-time-icon pending" />;
  }
  if (status === 'failed') {
    return <Dismiss20Regular className="bubble-time-icon failed" />;
  }
  if (status === 'read') return <Checkmark20Regular className="bubble-time-icon delivered" />;
  return <Checkmark20Regular className="bubble-time-icon delivered" />;
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
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?)$/i.test(name);
};

interface ImagePreviewState {
  dataUrl: string;
}

const imagePreviewStateCache = new Map<string, ImagePreviewState>();

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
  if (message.status === 'delivered' || message.status === 'read') {
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

const toReplyReferenceFromMessage = (message: MessageRow): MessageReplyReference => {
  if (message.type === 'file') {
    return {
      messageId: message.messageId,
      senderDeviceId: message.senderDeviceId,
      type: 'file',
      previewText: null,
      fileName: message.fileName || 'Arquivo'
    };
  }

  const body = (message.bodyText || '').replace(/\s+/g, ' ').trim();
  return {
    messageId: message.messageId,
    senderDeviceId: message.senderDeviceId,
    type: message.type === 'announcement' ? 'announcement' : 'text',
    previewText: body.length > 180 ? `${body.slice(0, 177)}...` : body || null,
    fileName: null
  };
};

export const ChatView = ({
  conversationId,
  peer,
  forwardTargets,
  onlinePeerIds,
  peerOnline,
  peerTyping,
  loading,
  localProfile,
  messages,
  reactionsByMessageId,
  favoriteByMessageId,
  transferByFileId,
  hasMoreOlder,
  loadingOlder,
  recentMessageIds,
  unreadAtOpen,
  unreadAnchorMessageId,
  onSend,
  onTyping,
  onSendFile,
  onForwardMessage,
  onReactToMessage,
  onToggleFavoriteMessage,
  onGetFavoriteMessages,
  onDeleteMessage,
  onResyncConversation,
  onClearConversation,
  onForgetContactConversation,
  onOpenFile,
  onSaveFileAs,
  onSearchMessageIds,
  onLoadOlderMessages,
  onEnsureMessagesLoaded
}: ChatViewProps) => {
  const [previewStateByMessageId, setPreviewStateByMessageId] = useState<Record<string, ImagePreviewState>>(() => {
    const seed: Record<string, ImagePreviewState> = {};
    for (const message of messages) {
      const cached = imagePreviewStateCache.get(message.messageId);
      if (cached) {
        seed[message.messageId] = cached;
      }
    }
    return seed;
  });
  const [visiblePreviewByMessageId, setVisiblePreviewByMessageId] = useState<Record<string, boolean>>(() => {
    const seed: Record<string, boolean> = {};
    for (const message of messages) {
      if (imagePreviewStateCache.has(message.messageId)) {
        seed[message.messageId] = true;
      }
    }
    return seed;
  });
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState<string | null>(null);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchClosing, setSearchClosing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favoriteMessages, setFavoriteMessages] = useState<MessageRow[]>([]);
  const [favoriteMessagesLoading, setFavoriteMessagesLoading] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const [matchedMessageIds, setMatchedMessageIds] = useState<string[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [confirmForgetOpen, setConfirmForgetOpen] = useState(false);
  const [pendingDeleteMessageId, setPendingDeleteMessageId] = useState<string | null>(null);
  const [pendingForwardMessageId, setPendingForwardMessageId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState<ReplyDraftUi | null>(null);
  const [messageContextMenu, setMessageContextMenu] = useState<{
    x: number;
    y: number;
    messageId: string;
    canDelete: boolean;
    canForward: boolean;
    canFavorite: boolean;
    isFavorite: boolean;
    selectedText: string;
  } | null>(null);
  const [jumpHighlightMessageId, setJumpHighlightMessageId] = useState<string | null>(null);
  const [unreadSeparatorState, setUnreadSeparatorState] = useState<'hidden' | 'visible' | 'leaving'>('hidden');
  const headerMenuRef = useRef<HTMLDivElement | null>(null);
  const paneRootRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchCloseTimerRef = useRef<number | null>(null);
  const matchRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const messageRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const jumpHighlightTimeoutRef = useRef<number | null>(null);
  const unreadSeparatorHideTimeoutRef = useRef<number | null>(null);
  const unreadSeparatorUnmountTimeoutRef = useRef<number | null>(null);
  const scrollMetricsRef = useRef<{ top: number; height: number; client: number }>({
    top: 0,
    height: 0,
    client: 0
  });

  const closeMessageContextMenu = useCallback(() => {
    setMessageContextMenu(null);
  }, []);

  const copySelectedText = useCallback(async (text: string) => {
    const value = text.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // fallback legado para ambientes sem permissão de clipboard API
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand('copy');
    } finally {
      document.body.removeChild(textarea);
    }
  }, []);

  const handleBubbleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, message: MessageRow) => {
      event.preventDefault();
      const selection = window.getSelection();
      let selectedText = '';
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        if (event.currentTarget.contains(range.commonAncestorContainer)) {
          selectedText = selection.toString().trim();
        }
      }

      const menuWidth = 220;
      const rowHeight = 42;
      const isDeleted = Boolean(message.deletedAt);
      const isLocalOnly = Boolean(message.localOnly);
      const canReply = !isDeleted && !isLocalOnly;
      const canForward =
        !isDeleted &&
        !isLocalOnly &&
        (message.type === 'text' || message.type === 'announcement' || message.type === 'file') &&
        forwardTargets.length > 0;
      const canFavorite = !isDeleted && !isLocalOnly;
      const isFavorite = canFavorite ? Boolean(favoriteByMessageId[message.messageId]) : false;
      const canDelete =
        !isDeleted &&
        !isLocalOnly &&
        message.direction === 'out' &&
        message.senderDeviceId === localProfile.deviceId;
      const itemCount =
        (canReply ? 1 : 0) +
        (canForward ? 1 : 0) +
        (canFavorite ? 1 : 0) +
        (selectedText ? 1 : 0) +
        (canDelete ? 1 : 0);
      if (itemCount <= 0) {
        setMessageContextMenu(null);
        return;
      }
      const menuHeight = itemCount * rowHeight + 12;
      const rootRect = paneRootRef.current?.getBoundingClientRect();
      const rootLeft = rootRect?.left ?? 0;
      const rootTop = rootRect?.top ?? 0;
      const minX = 8 - rootLeft;
      const maxX = window.innerWidth - 8 - rootLeft - menuWidth;
      const minY = 8 - rootTop;
      const maxY = window.innerHeight - 8 - rootTop - menuHeight;
      const x = Math.min(Math.max(event.clientX - rootLeft, minX), maxX);
      const y = Math.min(Math.max(event.clientY - rootTop, minY), maxY);

      setMessageContextMenu({
        x,
        y,
        messageId: message.messageId,
        canDelete,
        canForward,
        canFavorite,
        isFavorite,
        selectedText
      });
    },
    [forwardTargets.length, localProfile.deviceId, favoriteByMessageId]
  );
  const lastMessageIdRef = useRef<string | null>(null);
  const stickToBottomRef = useRef(true);
  const forceScrollOnOpenRef = useRef(false);
  const forceScrollTimeoutRef = useRef<number | null>(null);
  const forceFollowAfterPasteRef = useRef(false);
  const forceFollowAfterPasteTimeoutRef = useRef<number | null>(null);
  const hasMoreOlderRef = useRef(hasMoreOlder);
  const loadingOlderRef = useRef(loadingOlder);
  const searchJumpInFlightRef = useRef(false);

  const displayedMessages = useMemo(
    () =>
      favoritesOnly
        ? [...favoriteMessages].sort((a, b) => {
            const at = Number(a.createdAt) || 0;
            const bt = Number(b.createdAt) || 0;
            if (at !== bt) return at - bt;
            return a.messageId.localeCompare(b.messageId);
          })
        : messages,
    [favoriteMessages, favoritesOnly, messages]
  );
  const searchUiVisible = searchOpen || searchClosing;
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const matchedMessageIdSet = useMemo(() => new Set(matchedMessageIds), [matchedMessageIds]);
  const loadedMessageIdSet = useMemo(
    () => new Set(displayedMessages.map((row) => row.messageId)),
    [displayedMessages]
  );
  const messageById = useMemo(
    () => new Map(messages.map((row) => [row.messageId, row])),
    [messages]
  );
  const contextMenuMessage = useMemo(() => {
    if (!messageContextMenu) return null;
    return messageById.get(messageContextMenu.messageId) || null;
  }, [messageById, messageContextMenu]);
  const pendingForwardMessage = useMemo(() => {
    if (!pendingForwardMessageId) return null;
    return messageById.get(pendingForwardMessageId) || null;
  }, [messageById, pendingForwardMessageId]);

  const senderLabelForMessage = useCallback(
    (senderDeviceId: string): string => {
      if (senderDeviceId === localProfile.deviceId) {
        return 'Você';
      }
      return peer?.displayName || `Contato ${senderDeviceId.slice(0, 6)}`;
    },
    [localProfile.deviceId, peer?.displayName]
  );

  const focusComposerInput = useCallback(() => {
    const tryFocus = () => {
      const textarea = paneRootRef.current?.querySelector('.composer textarea');
      if (!(textarea instanceof HTMLTextAreaElement)) return false;
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
      return true;
    };

    window.requestAnimationFrame(() => {
      if (tryFocus()) return;
      window.setTimeout(() => {
        void tryFocus();
      }, 60);
    });
  }, []);

  const startReplyToMessage = useCallback(
    (message: MessageRow) => {
      const replyRef = toReplyReferenceFromMessage(message);
      setReplyDraft({
        ...replyRef,
        senderLabel: senderLabelForMessage(replyRef.senderDeviceId)
      });
      setReactionPickerMessageId(null);
      closeMessageContextMenu();
      focusComposerInput();
    },
    [senderLabelForMessage, closeMessageContextMenu, focusComposerInput]
  );

  const closeSearchAnimated = useCallback(() => {
    if (!searchOpen && !searchClosing) {
      return;
    }
    if (searchCloseTimerRef.current) {
      window.clearTimeout(searchCloseTimerRef.current);
      searchCloseTimerRef.current = null;
    }
    setSearchOpen(false);
    setSearchClosing(true);
    searchCloseTimerRef.current = window.setTimeout(() => {
      setSearchClosing(false);
      searchCloseTimerRef.current = null;
    }, 180);
  }, [searchClosing, searchOpen]);

  const toggleSearchPanel = useCallback(() => {
    if (searchOpen) {
      closeSearchAnimated();
      return;
    }
    if (searchCloseTimerRef.current) {
      window.clearTimeout(searchCloseTimerRef.current);
      searchCloseTimerRef.current = null;
    }
    setSearchClosing(false);
    setSearchOpen(true);
  }, [closeSearchAnimated, searchOpen]);

  const jumpToReferencedMessage = useCallback(
    async (targetMessageId: string) => {
      if (!targetMessageId) return;
      await onEnsureMessagesLoaded([targetMessageId]);

      let attempts = 0;
      const maxAttempts = 8;
      const tryJump = () => {
        const rowNode = messageRowRefs.current[targetMessageId];
        if (rowNode) {
          rowNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setJumpHighlightMessageId(targetMessageId);
          if (jumpHighlightTimeoutRef.current) {
            window.clearTimeout(jumpHighlightTimeoutRef.current);
            jumpHighlightTimeoutRef.current = null;
          }
          jumpHighlightTimeoutRef.current = window.setTimeout(() => {
            setJumpHighlightMessageId((current) =>
              current === targetMessageId ? null : current
            );
            jumpHighlightTimeoutRef.current = null;
          }, 1400);
          return;
        }
        if (attempts >= maxAttempts) return;
        attempts += 1;
        window.setTimeout(tryJump, 80);
      };

      window.requestAnimationFrame(tryJump);
    },
    [onEnsureMessagesLoaded]
  );

  useEffect(() => {
    setReplyDraft(null);
    setFavoritesOnly(false);
    setFavoriteMessages([]);
    setFavoriteMessagesLoading(false);
  }, [conversationId]);

  useEffect(() => {
    if (!favoritesOnly) {
      return;
    }
    if (searchOpen) {
      closeSearchAnimated();
    }
    let cancelled = false;
    setFavoriteMessagesLoading(true);
    void onGetFavoriteMessages(conversationId)
      .then((rows) => {
        if (cancelled) return;
        setFavoriteMessages(rows);
      })
      .catch(() => {
        if (!cancelled) {
          setFavoriteMessages([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setFavoriteMessagesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [favoritesOnly, conversationId, onGetFavoriteMessages, searchOpen, closeSearchAnimated]);

  useEffect(() => {
    if (!favoritesOnly) {
      return;
    }
    setFavoriteMessages((current) => {
      const map = new Map<string, MessageRow>();
      for (const row of current) {
        if (favoriteByMessageId[row.messageId]) {
          map.set(row.messageId, row);
        }
      }
      for (const row of messages) {
        if (favoriteByMessageId[row.messageId]) {
          map.set(row.messageId, row);
        }
      }
      return Array.from(map.values()).sort((a, b) => {
        const at = Number(a.createdAt) || 0;
        const bt = Number(b.createdAt) || 0;
        if (at !== bt) return at - bt;
        return a.messageId.localeCompare(b.messageId);
      });
    });
  }, [favoritesOnly, favoriteByMessageId, messages]);

  useEffect(() => {
    if (unreadSeparatorHideTimeoutRef.current) {
      window.clearTimeout(unreadSeparatorHideTimeoutRef.current);
      unreadSeparatorHideTimeoutRef.current = null;
    }
    if (unreadSeparatorUnmountTimeoutRef.current) {
      window.clearTimeout(unreadSeparatorUnmountTimeoutRef.current);
      unreadSeparatorUnmountTimeoutRef.current = null;
    }
    if (!unreadAnchorMessageId || unreadAtOpen <= 0) {
      setUnreadSeparatorState('hidden');
      return;
    }

    setUnreadSeparatorState('visible');
    unreadSeparatorHideTimeoutRef.current = window.setTimeout(() => {
      setUnreadSeparatorState('leaving');
      unreadSeparatorHideTimeoutRef.current = null;
      unreadSeparatorUnmountTimeoutRef.current = window.setTimeout(() => {
        setUnreadSeparatorState('hidden');
        unreadSeparatorUnmountTimeoutRef.current = null;
      }, 260);
    }, 6200);

    return () => {
      if (unreadSeparatorHideTimeoutRef.current) {
        window.clearTimeout(unreadSeparatorHideTimeoutRef.current);
        unreadSeparatorHideTimeoutRef.current = null;
      }
      if (unreadSeparatorUnmountTimeoutRef.current) {
        window.clearTimeout(unreadSeparatorUnmountTimeoutRef.current);
        unreadSeparatorUnmountTimeoutRef.current = null;
      }
    };
  }, [conversationId, unreadAtOpen, unreadAnchorMessageId]);

  useEffect(() => {
    hasMoreOlderRef.current = hasMoreOlder;
  }, [hasMoreOlder]);

  useEffect(() => {
    loadingOlderRef.current = loadingOlder;
  }, [loadingOlder]);

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
      .then((messageIds) => {
        if (cancelled) return;
        const uniqueIds = Array.from(new Set(messageIds));
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
  }, [normalizedQuery, conversationId, onSearchMessageIds]);

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

  const isComposerFocused = (): boolean => {
    const root = paneRootRef.current;
    if (!root) return false;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    const textarea = root.querySelector('.composer textarea');
    return textarea instanceof HTMLTextAreaElement && active === textarea;
  };

  const handleComposerPaste = useCallback(() => {
    const node = messagesScrollRef.current;
    if (!node) return;
    const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (gap <= 160) {
      stickToBottomRef.current = true;
    }
    forceFollowAfterPasteRef.current = true;
    if (forceFollowAfterPasteTimeoutRef.current) {
      window.clearTimeout(forceFollowAfterPasteTimeoutRef.current);
      forceFollowAfterPasteTimeoutRef.current = null;
    }
    forceFollowAfterPasteTimeoutRef.current = window.setTimeout(() => {
      forceFollowAfterPasteRef.current = false;
      forceFollowAfterPasteTimeoutRef.current = null;
    }, 2800);
    window.requestAnimationFrame(() => {
      maybeFollowBottom(true, 'auto');
      window.requestAnimationFrame(() => {
        maybeFollowBottom(true, 'auto');
      });
    });
  }, []);

  const loadOlderWithViewportLock = useCallback(async (): Promise<number> => {
    if (favoritesOnly) return 0;
    const node = messagesScrollRef.current;
    if (!node) return 0;
    if (loadingOlderRef.current) return 0;
    if (!hasMoreOlderRef.current) return 0;

    const previousHeight = node.scrollHeight;
    const previousTop = node.scrollTop;
    const loadedCount = await onLoadOlderMessages();
    if (loadedCount <= 0) return 0;

    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    const nextNode = messagesScrollRef.current;
    if (!nextNode) return loadedCount;
    const delta = nextNode.scrollHeight - previousHeight;
    if (delta > 0) {
      nextNode.scrollTop = previousTop + delta;
    }
    return loadedCount;
  }, [favoritesOnly, onLoadOlderMessages]);

  useEffect(() => {
    const node = messagesScrollRef.current;
    if (!node) return;

    const snapshotMetrics = () => {
      scrollMetricsRef.current = {
        top: node.scrollTop,
        height: node.scrollHeight,
        client: node.clientHeight
      };
    };

    const onScroll = () => {
      const previous = scrollMetricsRef.current;
      const current = {
        top: node.scrollTop,
        height: node.scrollHeight,
        client: node.clientHeight
      };
      const layoutShiftOnly =
        stickToBottomRef.current &&
        Math.abs(current.top - previous.top) <= 1 &&
        (Math.abs(current.client - previous.client) > 1 || Math.abs(current.height - previous.height) > 1);

      stickToBottomRef.current = layoutShiftOnly ? true : isNearBottom();
      if (node.scrollTop <= 56 && hasMoreOlderRef.current && !loadingOlderRef.current) {
        void loadOlderWithViewportLock();
      }
      scrollMetricsRef.current = current;
    };

    stickToBottomRef.current = isNearBottom();
    snapshotMetrics();
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [peer?.deviceId, loadOlderWithViewportLock]);

  useEffect(() => {
    if (normalizedQuery) return;
    const node = messagesScrollRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (!(stickToBottomRef.current || isNearBottom())) return;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(() => {
        maybeFollowBottom(true, 'auto');
        frame = null;
      });
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [normalizedQuery]);

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
    }, 1800);
    return () => window.cancelAnimationFrame(frameA);
  }, [peer?.deviceId, normalizedQuery]);

  useEffect(() => {
    if (normalizedQuery) return;
    const lastMessage = displayedMessages[displayedMessages.length - 1];
    const forceForComposer = isComposerFocused() || forceFollowAfterPasteRef.current;
    const isOutgoingFileTransfer =
      Boolean(lastMessage) &&
      lastMessage.type === 'file' &&
      Boolean(lastMessage.fileId) &&
      (lastMessage.direction === 'out' || lastMessage.senderDeviceId === localProfile.deviceId) &&
      Boolean(lastMessage.fileId && transferByFileId[lastMessage.fileId]);
    const frame = window.requestAnimationFrame(() => {
      maybeFollowBottom(isOutgoingFileTransfer || forceForComposer, 'auto');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [transferByFileId, normalizedQuery, displayedMessages, localProfile.deviceId]);

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
      const pending = messages.filter(
        (message) =>
          message.type === 'file' &&
          Boolean(message.filePath) &&
          isImageName(message.fileName) &&
          !previewStateByMessageId[message.messageId]
      ).slice(-24);
      if (pending.length === 0) return;

      const resolved = await Promise.allSettled(
        pending.map(async (message) => {
          const cached = imagePreviewStateCache.get(message.messageId);
          if (cached) {
            return {
              messageId: message.messageId,
              previewState: cached
            };
          }

          const preview = message.filePath ? await ipcClient.getFilePreview(message.filePath) : null;
          if (!preview) {
            return {
              messageId: message.messageId,
              previewState: null
            };
          }
          const previewState: ImagePreviewState = {
            dataUrl: preview
          };
          imagePreviewStateCache.set(message.messageId, previewState);
          return {
            messageId: message.messageId,
            previewState
          };
        })
      );

      if (cancelled) return;
      setPreviewStateByMessageId((current) => {
        const next = { ...current };
        let changed = false;
        for (const result of resolved) {
          if (result.status !== 'fulfilled') {
            continue;
          }
          const item = result.value;
          if (item.previewState && !next[item.messageId]) {
            next[item.messageId] = item.previewState;
            changed = true;
          }
        }
        return changed ? next : current;
      });
    };

    void loadPreviews();

    return () => {
      cancelled = true;
    };
  }, [messages, previewStateByMessageId]);

  useEffect(() => {
    const immediateVisible: string[] = [];
    for (const messageId of Object.keys(previewStateByMessageId)) {
      if (visiblePreviewByMessageId[messageId]) continue;
      immediateVisible.push(messageId);
    }

    if (immediateVisible.length > 0) {
      setVisiblePreviewByMessageId((current) => {
        let changed = false;
        const next = { ...current };
        for (const messageId of immediateVisible) {
          if (!next[messageId]) {
            next[messageId] = true;
            changed = true;
          }
        }
        return changed ? next : current;
      });
    }
  }, [previewStateByMessageId, visiblePreviewByMessageId]);

  useEffect(() => {
    if (normalizedQuery) return;
    const node = messagesScrollRef.current;
    if (!node) return;

    const lastMessage = displayedMessages[displayedMessages.length - 1];
    if (!lastMessage || lastMessage.type !== 'file' || !isImageName(lastMessage.fileName)) {
      return;
    }
    if (!previewStateByMessageId[lastMessage.messageId]) {
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
      const shouldForce =
        lastMessage.direction === 'out' || lastMessage.senderDeviceId === localProfile.deviceId;
      maybeFollowBottom(shouldForce, 'auto');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [previewStateByMessageId, displayedMessages, normalizedQuery, recentMessageIds, localProfile.deviceId]);

  useEffect(() => {
    if (normalizedQuery) return;
    const frame = window.requestAnimationFrame(() => {
      // Enquanto a conversa acabou de abrir, força manter no fim mesmo com imagens revelando.
      if (forceScrollOnOpenRef.current || forceFollowAfterPasteRef.current) {
        maybeFollowBottom(true, 'auto');
        return;
      }
      maybeFollowBottom(false, 'auto');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visiblePreviewByMessageId, normalizedQuery]);

  useEffect(() => {
    if (normalizedQuery) return;
    const currentLastMessage =
      displayedMessages.length > 0 ? displayedMessages[displayedMessages.length - 1] : null;
    const currentLastId =
      displayedMessages.length > 0
        ? displayedMessages[displayedMessages.length - 1].messageId
        : null;
    const previousLastId = lastMessageIdRef.current;
    const hasNewTailMessage = currentLastId !== null && currentLastId !== previousLastId;
    const forceForComposer = isComposerFocused() || forceFollowAfterPasteRef.current;

    if (forceScrollOnOpenRef.current || hasNewTailMessage || forceForComposer) {
      const shouldForceFollow =
        forceScrollOnOpenRef.current ||
        forceForComposer ||
        Boolean(
          hasNewTailMessage &&
            currentLastMessage &&
            (currentLastMessage.direction === 'out' ||
              currentLastMessage.senderDeviceId === localProfile.deviceId)
        );
      const frame = window.requestAnimationFrame(() => {
        maybeFollowBottom(shouldForceFollow, 'auto');
      });
      lastMessageIdRef.current = currentLastId;
      return () => window.cancelAnimationFrame(frame);
    }

    lastMessageIdRef.current = currentLastId;
    return undefined;
  }, [displayedMessages, normalizedQuery, localProfile.deviceId]);

  useEffect(
    () => () => {
      if (forceScrollTimeoutRef.current) {
        window.clearTimeout(forceScrollTimeoutRef.current);
        forceScrollTimeoutRef.current = null;
      }
      if (forceFollowAfterPasteTimeoutRef.current) {
        window.clearTimeout(forceFollowAfterPasteTimeoutRef.current);
        forceFollowAfterPasteTimeoutRef.current = null;
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
    if (!messageContextMenu) return;
    const close = () => setMessageContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [messageContextMenu]);

  useEffect(
    () => () => {
      if (searchCloseTimerRef.current) {
        window.clearTimeout(searchCloseTimerRef.current);
        searchCloseTimerRef.current = null;
      }
      if (jumpHighlightTimeoutRef.current) {
        window.clearTimeout(jumpHighlightTimeoutRef.current);
        jumpHighlightTimeoutRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    if (!searchUiVisible) {
      setSearchQuery((current) => (current === '' ? current : ''));
      setActiveMatchIndex((current) => (current === -1 ? current : -1));
      setMatchedMessageIds((current) => (current.length === 0 ? current : []));
      return;
    }
    if (!normalizedQuery || matchedMessageIds.length === 0) {
      setActiveMatchIndex(-1);
      return;
    }
    let newestLoadedIndex = -1;
    for (let index = matchedMessageIds.length - 1; index >= 0; index -= 1) {
      if (loadedMessageIdSet.has(matchedMessageIds[index])) {
        newestLoadedIndex = index;
        break;
      }
    }
    const fallbackIndex = newestLoadedIndex >= 0 ? newestLoadedIndex : matchedMessageIds.length - 1;
    setActiveMatchIndex((current) =>
      current >= 0 && current < matchedMessageIds.length ? current : fallbackIndex
    );
  }, [searchUiVisible, normalizedQuery, matchedMessageIds, loadedMessageIdSet]);

  useEffect(() => {
    if (activeMatchIndex < 0) return;
    const messageId = matchedMessageIds[activeMatchIndex];
    if (!messageId) return;
    let cancelled = false;

    const jumpToMatch = async () => {
      if (searchJumpInFlightRef.current) {
        return;
      }
      searchJumpInFlightRef.current = true;
      try {
        let guard = 0;
        while (!cancelled) {
          const node = matchRowRefs.current[messageId];
          if (node) {
            node.scrollIntoView({ behavior: 'smooth', block: 'center' });
            break;
          }
          if (!hasMoreOlderRef.current || guard >= 120) {
            await onEnsureMessagesLoaded([messageId]);
            await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
            const fallbackNode = matchRowRefs.current[messageId];
            if (fallbackNode) {
              fallbackNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            break;
          }
          guard += 1;
          const loaded = await loadOlderWithViewportLock();
          if (loaded <= 0) {
            break;
          }
        }
      } finally {
        searchJumpInFlightRef.current = false;
      }
    };

    void jumpToMatch();
    return () => {
      cancelled = true;
    };
  }, [activeMatchIndex, matchedMessageIds, loadOlderWithViewportLock, onEnsureMessagesLoaded]);

  if (!peer) {
    return <div className="empty-state">Selecione um contato para abrir o histórico da conversa.</div>;
  }

  return (
    <div className="main-pane" ref={paneRootRef}>
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
          <div className={`chat-search-wrap ${searchOpen ? 'open' : ''} ${searchClosing ? 'closing' : ''}`}>
            {searchUiVisible && (
              <div className="chat-search-content">
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
              </div>
            )}
            <Button
              appearance="subtle"
              icon={searchOpen ? <Dismiss20Regular /> : <Search20Regular />}
              disabled={favoritesOnly}
              onClick={toggleSearchPanel}
            />
          </div>
          <Button
            appearance="subtle"
            className={`chat-favorites-toggle ${favoritesOnly ? 'active' : ''}`}
            icon={favoritesOnly ? <Star20Filled /> : <Star20Regular />}
            title={favoritesOnly ? 'Mostrar todas as mensagens' : 'Mostrar favoritas'}
            aria-label={favoritesOnly ? 'Mostrar todas as mensagens' : 'Mostrar favoritas'}
            onClick={() => setFavoritesOnly((current) => !current)}
          />
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
                    void onResyncConversation();
                  }}
                >
                  <span className="menu-item-icon">
                    <ArrowSync20Regular />
                  </span>
                  <span>Ressincronizar conversa</span>
                </button>
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
        {loading && displayedMessages.length === 0 && !favoritesOnly && (
          <div className="messages-skeleton-list" aria-hidden>
            <div className="message-skeleton-row in" />
            <div className="message-skeleton-row in" />
            <div className="message-skeleton-row out" />
            <div className="message-skeleton-row out" />
          </div>
        )}
        {favoriteMessagesLoading && (
          <div className="messages-skeleton-list" aria-hidden>
            <div className="message-skeleton-row in" />
            <div className="message-skeleton-row out" />
          </div>
        )}
        {!favoriteMessagesLoading && favoritesOnly && displayedMessages.length === 0 && (
          <div className="chat-favorites-empty">Nenhuma mensagem favorita nesta conversa.</div>
        )}
        {displayedMessages.map((message, index) => {
          const previousMessage = index > 0 ? displayedMessages[index - 1] : null;
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
          const isFavorite = Boolean(favoriteByMessageId[message.messageId]);
          const summary = reactionsByMessageId[message.messageId] || { counts: {}, myReaction: null };
          const hasCounters = REACTIONS.some((reaction) => (summary.counts[reaction] || 0) > 0);
          const reactionPickerOpen = reactionPickerMessageId === message.messageId;
          const isImageFile = isFile && isImageName(message.fileName);
          const previewState = previewStateByMessageId[message.messageId];
          const previewDataUrl = previewState?.dataUrl;
          const previewVisible = Boolean(previewDataUrl && visiblePreviewByMessageId[message.messageId]);
          const progress = message.fileId ? transferByFileId[message.fileId] : undefined;
          const progressPercent =
            progress && progress.total > 0
              ? Math.min(100, Math.floor((progress.transferred / progress.total) * 100))
              : null;
          const transferStage = isFile ? transferStageLabel(message, progressPercent) : null;
          const hasReplyReference = Boolean(message.replyToMessageId);
          const replySenderLabel = message.replyToSenderDeviceId
            ? senderLabelForMessage(message.replyToSenderDeviceId)
            : 'Mensagem';
          const replyPreview =
            message.replyToType === 'file'
              ? `📎 ${message.replyToFileName || message.replyToPreviewText || 'Arquivo'}`
              : message.replyToPreviewText || 'Mensagem indisponível';

          return (
            <div key={message.messageId}>
              {startsNewDay && (
                <div className="messages-date-separator">
                  <span>{formatDateSeparator(message.createdAt)}</span>
                </div>
              )}
              {unreadSeparatorState !== 'hidden' &&
                !normalizedQuery &&
                !favoritesOnly &&
                unreadAnchorMessageId === message.messageId && (
                  <div
                    className={`messages-new-separator ${
                      unreadSeparatorState === 'leaving' ? 'is-leaving' : 'is-visible'
                    }`}
                  >
                    <span>Novas mensagens</span>
                  </div>
                )}
              <div
                className={`bubble-row ${outgoing ? 'out' : 'in'} ${groupedWithPrevious ? 'grouped' : ''} ${hasCounters ? 'has-static-reaction' : ''} ${canShowActions ? 'has-actions' : ''} ${reactionPickerOpen ? 'actions-open' : ''} ${recentMessageIds[message.messageId] ? 'is-new' : ''} ${matchedMessageIdSet.has(message.messageId) ? 'search-match' : ''} ${matchedMessageIds[activeMatchIndex] === message.messageId ? 'search-match-active' : ''} ${jumpHighlightMessageId === message.messageId ? 'reply-jump-highlight' : ''} ${isFavorite ? 'is-favorite' : ''}`}
                ref={(node) => {
                  messageRowRefs.current[message.messageId] = node;
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
                  } ${message.status === 'sent' ? 'pending' : ''} ${
                    message.status === null ? 'pending' : ''
                  } ${isImageFile && !previewDataUrl ? 'media-loading' : ''} ${
                    isImageFile && previewDataUrl ? 'media-loaded' : ''
                  }`}
                  onContextMenu={(event) => handleBubbleContextMenu(event, message)}
                >
                  {!isDeleted && Boolean(message.forwardedFromMessageId) && (
                    <div className="message-forwarded-label">
                      <ArrowForward20Regular />
                      <span>Encaminhada</span>
                    </div>
                  )}
                  {!isDeleted && hasReplyReference && (
                    <button
                      type="button"
                      className="reply-reference"
                      onClick={() => {
                        if (message.replyToMessageId) {
                          void jumpToReferencedMessage(message.replyToMessageId);
                        }
                      }}
                    >
                      <span className="reply-reference-author">{replySenderLabel}</span>
                      <span className="reply-reference-preview">{replyPreview}</span>
                    </button>
                  )}
                  {isDeleted ? (
                    <div className="message-deleted">Esta mensagem foi apagada.</div>
                  ) : isFile ? (
                    <>
                      <div className="message-file-title">📎 {message.fileName}</div>
                      {isImageFile && (
                        <button
                          type="button"
                          className={`message-image-preview-btn ${previewDataUrl ? 'is-ready' : ''} ${
                            previewVisible ? 'is-media-visible' : ''
                          }`}
                          onClick={() => void onOpenFile(message.filePath!)}
                          disabled={!previewVisible}
                        >
                          {previewDataUrl && (
                            <img
                              src={previewDataUrl}
                              alt={message.fileName || 'Imagem'}
                              className="message-image-preview"
                            />
                          )}
                          <div
                            className={`message-image-preview-placeholder ${previewVisible ? 'hidden' : ''}`}
                            aria-hidden
                          >
                            Carregando imagem...
                          </div>
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
                      {message.filePath && message.status !== 'failed' ? (
                        <div className="message-file-actions">
                          <Button size="small" onClick={() => void onOpenFile(message.filePath!)}>
                            Abrir
                          </Button>
                          <Button
                            size="small"
                            appearance="secondary"
                            onClick={() => void onSaveFileAs(message.filePath!, message.fileName)}
                          >
                            Salvar como
                          </Button>
                        </div>
                      ) : message.status === 'failed' ? (
                        <div className="inline-status error">
                          <Caption1>Não foi possível enviar este anexo.</Caption1>
                        </div>
                      ) : outgoing && (message.status === 'sent' || message.status === null) ? (
                        <div className="inline-status pending">
                          <Clock20Regular className="bubble-time-icon pending" />
                          <Caption1>Anexo pendente. Envia quando o contato voltar.</Caption1>
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
                    {isFavorite && (
                      <span className="bubble-favorite-indicator" title="Mensagem favoritada">
                        <Star20Filled />
                      </span>
                    )}
                    <span className="bubble-time">
                      {outgoing ? renderOutgoingStatusIcon(message.status) : null}
                      <span>{formatTime(message.createdAt)}</span>
                    </span>
                    {outgoing && <span>{statusLabel(message.status)}</span>}
                  </div>
                </div>

                {canShowActions && (
                  <>
                    <div
                      className={`bubble-actions-row ${outgoing ? 'out' : 'in'} ${
                        reactionPickerOpen ? 'visible' : ''
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
                      {reactionPickerMessageId === message.messageId ? (
                        <Dismiss20Regular />
                      ) : (
                        <Emoji20Regular />
                      )}
                    </button>

                    <button
                      type="button"
                      className="reaction-trigger reply-trigger"
                      onClick={() => startReplyToMessage(message)}
                      title="Responder"
                      aria-label="Responder"
                    >
                      <ArrowReply20Regular />
                    </button>

                    <button
                      type="button"
                      className={`reaction-trigger favorite-trigger ${isFavorite ? 'active' : ''}`}
                      onClick={() => {
                        void onToggleFavoriteMessage(message.messageId, !isFavorite);
                        closeMessageContextMenu();
                      }}
                      title={isFavorite ? 'Remover dos favoritos' : 'Favoritar mensagem'}
                      aria-label={isFavorite ? 'Remover dos favoritos' : 'Favoritar mensagem'}
                    >
                      {isFavorite ? <Star20Filled /> : <Star20Regular />}
                    </button>

                      <div
                        className={`reaction-picker ${reactionPickerOpen ? 'is-open' : 'is-closed'}`}
                        aria-hidden={!reactionPickerOpen}
                      >
                        {REACTIONS.map((reaction) => (
                          <button
                            key={reaction}
                            type="button"
                            tabIndex={reactionPickerOpen ? 0 : -1}
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
          Este contato está offline. Suas mensagens e anexos ficarão pendentes e serão enviados quando ele voltar.
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
        disabled={false}
        autoFocusKey={peer.deviceId}
        onSend={async (text, replyTo) => {
          await onSend(text, replyTo);
          setReplyDraft(null);
        }}
        onTypingChange={onTyping}
        onSendFile={onSendFile}
        onPaste={handleComposerPaste}
        replyDraft={replyDraft}
        onCancelReply={() => setReplyDraft(null)}
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

      <ForwardMessageDialog
        open={Boolean(pendingForwardMessageId)}
        sourceMessage={pendingForwardMessage}
        contacts={forwardTargets}
        onlinePeerIds={onlinePeerIds}
        onCancel={() => setPendingForwardMessageId(null)}
        onConfirm={async (targetPeerIds) => {
          if (!pendingForwardMessageId) return;
          await onForwardMessage(targetPeerIds, pendingForwardMessageId);
          setPendingForwardMessageId(null);
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

      {messageContextMenu && (
        <div
          className="chat-context-menu"
          style={{ left: messageContextMenu.x, top: messageContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenuMessage && !contextMenuMessage.deletedAt && !contextMenuMessage.localOnly && (
            <button
              type="button"
              className="chat-context-item"
              onClick={() => {
                startReplyToMessage(contextMenuMessage);
                closeMessageContextMenu();
              }}
            >
              <span className="menu-item-icon">
                <ArrowReply20Regular />
              </span>
              <span>Responder</span>
            </button>
          )}
          {messageContextMenu.canForward && contextMenuMessage && !contextMenuMessage.deletedAt && !contextMenuMessage.localOnly && (
            <button
              type="button"
              className="chat-context-item"
              onClick={() => {
                setPendingForwardMessageId(contextMenuMessage.messageId);
                closeMessageContextMenu();
              }}
            >
              <span className="menu-item-icon">
                <ArrowForward20Regular />
              </span>
              <span>Encaminhar</span>
            </button>
          )}
          {messageContextMenu.canFavorite && (
            <button
              type="button"
              className="chat-context-item"
              onClick={() => {
                void onToggleFavoriteMessage(
                  messageContextMenu.messageId,
                  !messageContextMenu.isFavorite
                );
                closeMessageContextMenu();
              }}
            >
              <span className="menu-item-icon">
                {messageContextMenu.isFavorite ? <Star20Filled /> : <Star20Regular />}
              </span>
              <span>{messageContextMenu.isFavorite ? 'Desfavoritar' : 'Favoritar'}</span>
            </button>
          )}
          {Boolean(messageContextMenu.selectedText.trim()) && (
            <button
              type="button"
              className="chat-context-item"
              onClick={() => {
                void copySelectedText(messageContextMenu.selectedText);
                closeMessageContextMenu();
              }}
            >
              <span className="menu-item-icon">
                <Copy20Regular />
              </span>
              <span>Copiar texto</span>
            </button>
          )}
          {messageContextMenu.canDelete && (
            <button
              type="button"
              className="chat-context-item danger"
              onClick={() => {
                setPendingDeleteMessageId(messageContextMenu.messageId);
                closeMessageContextMenu();
              }}
            >
              <span className="menu-item-icon">
                <Delete20Regular />
              </span>
              <span>Excluir</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
