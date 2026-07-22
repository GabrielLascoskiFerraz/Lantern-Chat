import { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import {
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Spinner,
  Text
} from '@fluentui/react-components';
import { ArrowReply20Regular } from '@fluentui/react-icons';
import { ArrowForward20Regular } from '@fluentui/react-icons';
import { Checkmark20Regular } from '@fluentui/react-icons';
import { Clock20Regular } from '@fluentui/react-icons';
import { Copy20Regular } from '@fluentui/react-icons';
import { Delete20Regular } from '@fluentui/react-icons';
import { Dismiss20Regular } from '@fluentui/react-icons';
import { DocumentEdit20Regular } from '@fluentui/react-icons';
import { Emoji20Regular } from '@fluentui/react-icons';
import { Megaphone20Regular } from '@fluentui/react-icons';
import { PeopleEye20Regular } from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import {
  AnnouncementReadDetail,
  AnnouncementReadSummary,
  AnnouncementReactionSummary,
  ipcClient,
  MessageReactionDetail,
  MessageReplyReference,
  MessageRow,
  Peer,
  Profile
} from '../api/ipcClient';
import { Avatar } from './Avatar';
import { ConfirmDialog } from './ConfirmDialog';
import { ForwardMessageDialog } from './ForwardMessageDialog';
import { MessageComposer } from './MessageComposer';
import { PlatformEmoji, PlatformEmojiText } from './PlatformEmoji';
import {
  isImageAttachmentName,
  isStickerAttachmentName,
  MessageAttachment
} from './MessageAttachment';

interface AnnouncementsViewProps {
  messages: MessageRow[];
  loading: boolean;
  profile: Profile;
  peers: Peer[];
  forwardTargets: Peer[];
  onlinePeerIds: string[];
  reactionsByMessageId: Record<string, AnnouncementReactionSummary>;
  readsByMessageId: Record<string, AnnouncementReadSummary>;
  recentMessageIds: Record<string, number>;
  relayConnected: boolean;
  onSend: (text: string, replyTo?: MessageReplyReference | null) => Promise<void>;
  onSendFile: (filePath: string, replyTo?: MessageReplyReference | null) => Promise<void>;
  transferByFileId: Record<string, {
    transferred: number;
    total: number;
    stage?: string;
    attempt?: number;
    detail?: string | null;
  }>;
  onOpenFile: (filePath: string) => Promise<void>;
  onSaveFileAs: (filePath: string, fileName?: string | null) => Promise<void>;
  onForwardMessage: (targetPeerIds: string[], sourceMessageId: string) => Promise<void>;
  onEditMessage: (messageId: string, text: string) => Promise<void>;
  onReactToMessage: (messageId: string, reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
}

interface ReplyDraftUi extends MessageReplyReference {
  senderLabel: string;
}

const REACTIONS: Array<'👍' | '👎' | '❤️' | '😢' | '😊' | '😂'> = ['👍', '👎', '❤️', '😂', '😊', '😢'];
const SHOW_ANNOUNCEMENT_READ_BUTTON = false;

const formatTime = (value: number): string =>
  new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

const formatAnnouncementExpiry = (expiresAt: number | null | undefined, now: number): string => {
  if (!expiresAt) return 'expiração automática';
  const remainingMs = expiresAt - now;
  if (remainingMs <= 0) return 'expirando…';
  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `expira em ${days}d${hours > 0 ? ` ${hours}h` : ''}`;
  if (hours > 0) return `expira em ${hours}h${minutes > 0 ? ` ${minutes}min` : ''}`;
  return `expira em ${minutes}min`;
};

const renderMessageText = (text: string): ReactNode[] => {
  const regex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  match = regex.exec(text);
  while (match) {
    const raw = match[0];
    const index = match.index;
    if (index > lastIndex) {
      const fragment = text.slice(lastIndex, index);
      parts.push(<PlatformEmojiText key={`text-${lastIndex}`}>{fragment}</PlatformEmojiText>);
    }
    const href = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`;
    parts.push(
      <a
        key={`${href}-${index}`}
        href={href}
        className="message-link"
        onClick={(event) => {
          event.preventDefault();
          void ipcClient.openExternalUrl(href);
        }}
      >
        <PlatformEmojiText>{raw}</PlatformEmojiText>
      </a>
    );
    lastIndex = index + raw.length;
    match = regex.exec(text);
  }

  if (lastIndex < text.length) {
    parts.push(<PlatformEmojiText key={`text-${lastIndex}`}>{text.slice(lastIndex)}</PlatformEmojiText>);
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

export const AnnouncementsView = ({
  messages,
  loading,
  profile,
  peers,
  forwardTargets,
  onlinePeerIds,
  reactionsByMessageId,
  readsByMessageId,
  recentMessageIds,
  relayConnected,
  onSend,
  onSendFile,
  transferByFileId,
  onOpenFile,
  onSaveFileAs,
  onForwardMessage,
  onEditMessage,
  onReactToMessage,
  onDeleteMessage
}: AnnouncementsViewProps) => {
  const [expiryClockNow, setExpiryClockNow] = useState(Date.now());
  const [pendingDeleteMessageId, setPendingDeleteMessageId] = useState<string | null>(null);
  const [pendingForwardMessageId, setPendingForwardMessageId] = useState<string | null>(null);
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState<ReplyDraftUi | null>(null);
  const [editingMessage, setEditingMessage] = useState<MessageRow | null>(null);
  const [detailsDialog, setDetailsDialog] = useState<{
    title: string;
    loading: boolean;
    reactionDetails: MessageReactionDetail[];
    readDetails: AnnouncementReadDetail[];
  } | null>(null);
  const [messageContextMenu, setMessageContextMenu] = useState<{
    x: number;
    y: number;
    messageId: string;
    selectedText: string;
    canDelete: boolean;
    canForward: boolean;
    canEdit: boolean;
  } | null>(null);
  const [jumpHighlightMessageId, setJumpHighlightMessageId] = useState<string | null>(null);
  const [filePreviewByMessageId, setFilePreviewByMessageId] = useState<Record<string, string>>({});
  const [retryingMessageIds, setRetryingMessageIds] = useState<Record<string, boolean>>({});
  const [retryErrorsByMessageId, setRetryErrorsByMessageId] = useState<Record<string, string>>({});
  const paneRootRef = useRef<HTMLDivElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const messageRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const jumpHighlightTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    setExpiryClockNow(Date.now());
    if (!messages.some((message) => Boolean(message.announcementExpiresAt))) return undefined;
    const timer = window.setInterval(() => setExpiryClockNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [messages]);

  const copySelectedText = async (text: string): Promise<void> => {
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
  };

  const senderLabelForMessage = (senderDeviceId: string): string => {
    if (senderDeviceId === profile.deviceId) {
      return 'Você';
    }
    const peer = peers.find((candidate) => candidate.deviceId === senderDeviceId);
    return peer?.displayName || `Contato ${senderDeviceId.slice(0, 6)}`;
  };

  const focusComposerInput = (): void => {
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
  };

  const startReplyToMessage = (message: MessageRow): void => {
    if (message.deletedAt || message.localOnly) return;
    const replyRef = toReplyReferenceFromMessage(message);
    setReplyDraft({
      ...replyRef,
      senderLabel: senderLabelForMessage(replyRef.senderDeviceId)
    });
    setReactionPickerMessageId(null);
    setMessageContextMenu(null);
    focusComposerInput();
  };

  const canEditMessage = (message: MessageRow): boolean =>
    relayConnected &&
    message.type === 'announcement' &&
    message.direction === 'out' &&
    message.senderDeviceId === profile.deviceId &&
    !message.deletedAt &&
    Date.now() - message.createdAt <= 10 * 60 * 1000;

  const startEditMessage = (message: MessageRow): void => {
    if (!canEditMessage(message)) return;
    setEditingMessage(message);
    setReplyDraft(null);
    setReactionPickerMessageId(null);
    setMessageContextMenu(null);
    focusComposerInput();
  };

  const jumpToReferencedMessage = async (targetMessageId: string): Promise<void> => {
    if (!targetMessageId) return;
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
      window.setTimeout(tryJump, 90);
    };
    window.requestAnimationFrame(tryJump);
  };

  const handleBubbleContextMenu = (
    event: ReactMouseEvent<HTMLDivElement>,
    message: MessageRow
  ): void => {
    event.preventDefault();
    const selection = window.getSelection();
    let selectedText = '';
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      if (event.currentTarget.contains(range.commonAncestorContainer)) {
        selectedText = selection.toString().trim();
      }
    }

    const canReply = !message.deletedAt && !message.localOnly;
    const canForward =
      relayConnected &&
      !message.deletedAt &&
      !message.localOnly &&
      (message.type === 'text' || message.type === 'announcement' || message.type === 'file') &&
      forwardTargets.length > 0;
    const canDelete =
      relayConnected &&
      !message.deletedAt &&
      !message.localOnly &&
      message.direction === 'out' &&
      message.senderDeviceId === profile.deviceId;
    const canEdit = canEditMessage(message);
    const itemCount =
      (canReply ? 1 : 0) +
      (canForward ? 1 : 0) +
      (selectedText ? 1 : 0) +
      (canEdit ? 1 : 0) +
      (canDelete ? 1 : 0);
    if (itemCount <= 0) {
      setMessageContextMenu(null);
      return;
    }
    const menuWidth = 220;
    const menuHeight = itemCount * 42 + 12;
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
      selectedText,
      canDelete,
      canForward,
      canEdit
    });
  };

  const isNearBottom = (): boolean => {
    const node = messagesScrollRef.current;
    if (!node) return true;
    return node.scrollHeight - node.scrollTop - node.clientHeight <= 64;
  };

  const scrollToBottom = (behavior: ScrollBehavior = 'auto'): void => {
    const node = messagesScrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
    stickToBottomRef.current = true;
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
  }, []);

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
      if (jumpHighlightTimeoutRef.current) {
        window.clearTimeout(jumpHighlightTimeoutRef.current);
        jumpHighlightTimeoutRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    const node = messagesScrollRef.current;
    if (!node) return;
    if (!stickToBottomRef.current && !isNearBottom()) return;
    const frameA = window.requestAnimationFrame(() => {
      scrollToBottom('auto');
      const frameB = window.requestAnimationFrame(() => {
        scrollToBottom('auto');
      });
      return () => window.cancelAnimationFrame(frameB);
    });
    return () => window.cancelAnimationFrame(frameA);
  }, [messages]);

  useEffect(() => {
    const availablePreviewIds = new Set(
      messages
        .filter((message) => message.type === 'file' && Boolean(message.filePath))
        .map((message) => message.messageId)
    );
    setFilePreviewByMessageId((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([messageId]) => availablePreviewIds.has(messageId))
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    const pending = messages.filter(
      (message) =>
        message.type === 'file' &&
        Boolean(message.filePath) &&
        isImageAttachmentName(message.fileName) &&
        !filePreviewByMessageId[message.messageId]
    );
    for (const message of pending) {
      void ipcClient.getFilePreview(message.filePath!).then((preview) => {
        if (cancelled || !preview) return;
        setFilePreviewByMessageId((current) => ({ ...current, [message.messageId]: preview }));
      }).catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [filePreviewByMessageId, messages]);

  useEffect(() => {
    const frameA = window.requestAnimationFrame(() => {
      scrollToBottom('auto');
      const frameB = window.requestAnimationFrame(() => {
        scrollToBottom('auto');
      });
      return () => window.cancelAnimationFrame(frameB);
    });
    return () => window.cancelAnimationFrame(frameA);
  }, []);

  const openReactionDetails = async (messageId: string): Promise<void> => {
    setDetailsDialog({
      title: 'Reações do anúncio',
      loading: true,
      reactionDetails: [],
      readDetails: []
    });
    try {
      const details = await ipcClient.getAnnouncementReactionDetails(messageId);
      setDetailsDialog({
        title: 'Reações do anúncio',
        loading: false,
        reactionDetails: details,
        readDetails: []
      });
    } catch {
      setDetailsDialog({
        title: 'Reações do anúncio',
        loading: false,
        reactionDetails: [],
        readDetails: []
      });
    }
  };

  const openReadDetails = async (messageId: string): Promise<void> => {
    setDetailsDialog({
      title: 'Leituras do anúncio',
      loading: true,
      reactionDetails: [],
      readDetails: []
    });
    try {
      const details = await ipcClient.getAnnouncementReadDetails(messageId);
      setDetailsDialog({
        title: 'Leituras do anúncio',
        loading: false,
        reactionDetails: [],
        readDetails: details
      });
    } catch {
      setDetailsDialog({
        title: 'Leituras do anúncio',
        loading: false,
        reactionDetails: [],
        readDetails: []
      });
    }
  };

  return (
    <div className="main-pane" ref={paneRootRef}>
      <header className="pane-header">
        <div className="pane-header-left">
          <div className="pane-header-identity">
            <Text weight="semibold" size={500}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <Megaphone20Regular />
                Anúncios
              </span>
            </Text>
            <Caption1>Comunicados para todos os usuários, com expiração definida pelo Relay.</Caption1>
          </div>
        </div>
      </header>

      <div className="messages-scroll" ref={messagesScrollRef}>
        {loading && messages.filter((message) => !message.deletedAt).length === 0 && (
          <div className="messages-skeleton-list" aria-hidden>
            <div className="message-skeleton-row in" />
            <div className="message-skeleton-row in" />
            <div className="message-skeleton-row out" />
          </div>
        )}
        {messages
          .filter((message) => !message.deletedAt)
          .map((message) => {
            const outgoing = message.direction === 'out';
            const fromCalendar = message.senderDeviceId === 'relay-calendar';
            const sender = peers.find((peer) => peer.deviceId === message.senderDeviceId);
            const emoji = outgoing ? profile.avatarEmoji : fromCalendar ? '📅' : sender?.avatarEmoji || '📢';
            const bg = outgoing ? profile.avatarBg : fromCalendar ? '#107c10' : sender?.avatarBg || '#5b5fc7';
            const senderName = outgoing ? 'Você' : fromCalendar ? 'Agenda do Relay' : sender?.displayName || message.senderDeviceId;
            const summary = reactionsByMessageId[message.messageId] || { counts: {}, myReaction: null };
            const readSummary = readsByMessageId[message.messageId] || { count: 0, readByMe: false };
            const hasCounters = REACTIONS.some((reaction) => (summary.counts[reaction] || 0) > 0);
            const reactionPickerOpen = reactionPickerMessageId === message.messageId;
            const canEditCurrentMessage = canEditMessage(message);
            const isFile = message.type === 'file';
            const filePreview = filePreviewByMessageId[message.messageId];
            const isImageFile = isFile && isImageAttachmentName(message.fileName);
            const isStickerFile = isFile && isStickerAttachmentName(message.fileName);
            const transfer = message.fileId ? transferByFileId[message.fileId] : undefined;
            const hasReplyReference = Boolean(message.replyToMessageId);
            const replySenderLabel = message.replyToSenderDeviceId
              ? senderLabelForMessage(message.replyToSenderDeviceId)
              : 'Mensagem';
            const replyPreview =
              message.replyToType === 'file'
                ? `📎 ${message.replyToFileName || message.replyToPreviewText || 'Arquivo'}`
                : message.replyToPreviewText || 'Mensagem indisponível';

            return (
              <div
                key={message.messageId}
                className={`bubble-row ${outgoing ? 'out' : 'in'} has-actions ${hasCounters ? 'has-static-reaction' : ''} ${recentMessageIds[message.messageId] ? 'is-new' : ''} ${jumpHighlightMessageId === message.messageId ? 'reply-jump-highlight' : ''}`}
                ref={(node) => {
                  messageRowRefs.current[message.messageId] = node;
                }}
              >
                {!outgoing && <Avatar emoji={emoji} bg={bg} size={30} />}
                <div className={`bubble-block ${outgoing ? 'out' : 'in'}`}>
                  <div className={`bubble ${outgoing ? 'out' : 'in'} ${isImageFile && !filePreview ? 'media-loading' : ''} ${isImageFile && filePreview ? 'media-loaded' : ''} ${isStickerFile ? 'sticker-bubble' : ''}`}>
                    <div onContextMenu={(event) => handleBubbleContextMenu(event, message)}>
                      {Boolean(message.forwardedFromMessageId) && (
                        <div className="message-forwarded-label">
                          <ArrowForward20Regular />
                          <span>Encaminhada</span>
                        </div>
                      )}
                      {hasReplyReference && (
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
                          <span className="reply-reference-preview"><PlatformEmojiText>{replyPreview}</PlatformEmojiText></span>
                        </button>
                      )}
                      <div className="announcement-meta">
                        <span className="announcement-sender">{senderName}</span>
                        <span className="announcement-expiry-clock">
                          <Clock20Regular />
                          {formatAnnouncementExpiry(message.announcementExpiresAt, expiryClockNow)}
                        </span>
                      </div>
                      {isFile ? (
                        <MessageAttachment
                          message={message}
                          outgoing={outgoing}
                          previewDataUrl={filePreview}
                          previewVisible={Boolean(filePreview)}
                          transfer={transfer}
                          onOpenFile={onOpenFile}
                          onSaveFileAs={onSaveFileAs}
                        />
                      ) : (
                        <div className="message-text">{renderMessageText(message.bodyText || '')}</div>
                      )}
                      <div className="bubble-meta">
                        <span className="bubble-time">
                          {outgoing && (message.status === 'sent' || message.status === null)
                            ? <Clock20Regular />
                            : outgoing && message.status === 'failed'
                              ? <Dismiss20Regular />
                              : <Checkmark20Regular />}
                          <span>{formatTime(message.createdAt)}</span>
                        </span>
                        {outgoing && <span>{message.status === 'failed' ? 'Não enviada' : message.status === 'sent' || message.status === null ? 'Pendente' : 'Entregue'}</span>}
                        {message.editedAt && <span className="message-edited-label">editada</span>}
                        {SHOW_ANNOUNCEMENT_READ_BUTTON && (
                          <button
                            type="button"
                            className="announcement-read-pill"
                            onClick={() => void openReadDetails(message.messageId)}
                          >
                            Lido por {readSummary.count}
                          </button>
                        )}
                      </div>
                      {outgoing && !isFile && message.status === 'failed' && (
                        <div className="message-send-retry">
                          <Button
                            size="small"
                            appearance="secondary"
                            disabled={Boolean(retryingMessageIds[message.messageId])}
                            onClick={() => {
                              if (retryingMessageIds[message.messageId]) return;
                              setRetryingMessageIds((current) => ({ ...current, [message.messageId]: true }));
                              setRetryErrorsByMessageId((current) => ({ ...current, [message.messageId]: '' }));
                              void ipcClient.retryMessage(message.messageId).catch((error) => {
                                const raw = error instanceof Error ? error.message : 'Não foi possível tentar novamente.';
                                setRetryErrorsByMessageId((current) => ({
                                  ...current,
                                  [message.messageId]: raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, '')
                                }));
                              }).finally(() => {
                                setRetryingMessageIds((current) => ({ ...current, [message.messageId]: false }));
                              });
                            }}
                          >
                            {retryingMessageIds[message.messageId]
                              ? <><Spinner size="tiny" /> Tentando novamente...</>
                              : 'Tentar novamente'}
                          </Button>
                          {retryErrorsByMessageId[message.messageId] && (
                            <Caption1>{retryErrorsByMessageId[message.messageId]}</Caption1>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div
                    className={`bubble-actions-row ${outgoing ? 'out' : 'in'} ${
                      reactionPickerOpen ? 'visible' : ''
                    }`}
                  >
                    <button
                      type="button"
                      className="reaction-trigger"
                      disabled={!relayConnected}
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
                    {canEditCurrentMessage && (
                      <button
                        type="button"
                        className="reaction-trigger edit-trigger"
                        onClick={() => startEditMessage(message)}
                        title="Editar anúncio"
                        aria-label="Editar anúncio"
                      >
                        <DocumentEdit20Regular />
                      </button>
                    )}
                    {hasCounters && (
                      <button
                        type="button"
                        className="reaction-trigger reaction-details-trigger"
                        onClick={() => void openReactionDetails(message.messageId)}
                        title="Ver quem reagiu"
                        aria-label="Ver quem reagiu"
                      >
                        <PeopleEye20Regular />
                      </button>
                    )}
                    <div
                      className={`reaction-picker ${reactionPickerOpen ? 'is-open' : 'is-closed'}`}
                      aria-hidden={!reactionPickerOpen}
                    >
                      {REACTIONS.map((reaction) => (
                        <button
                          key={reaction}
                          type="button"
                          disabled={!relayConnected}
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
                          <PlatformEmoji emoji={reaction} decorative />
                        </button>
                      ))}
                    </div>
                    {outgoing && (
                      <Button
                        appearance="subtle"
                        size="small"
                        icon={<Delete20Regular />}
                        disabled={!relayConnected}
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
                          onClick={() => void openReactionDetails(message.messageId)}
                          title="Ver quem reagiu"
                          aria-label={`Ver quem reagiu com ${reaction}`}
                        >
                          <PlatformEmoji emoji={reaction} decorative />
                          <span>{summary.counts[reaction]}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {outgoing && <Avatar emoji={emoji} bg={bg} size={30} />}
              </div>
            );
          })}
      </div>

      {!relayConnected && (
        <div className="chat-offline-hint">
          Sem conexão com o Relay. Não é possível enviar anúncios no momento.
        </div>
      )}
      <MessageComposer
        placeholder="Enviar anúncio para todos"
        disabled={!relayConnected}
        autoFocusKey="announcements"
        onSend={async (text, replyTo) => {
          await onSend(text, replyTo);
          setReplyDraft(null);
        }}
        onSendFile={onSendFile}
        onSubmitEdit={async (text) => {
          if (!editingMessage) return;
          await onEditMessage(editingMessage.messageId, text);
        }}
        replyDraft={replyDraft}
        onCancelReply={() => setReplyDraft(null)}
        editDraft={
          editingMessage
            ? { messageId: editingMessage.messageId, text: editingMessage.bodyText || '' }
            : null
        }
        onCancelEdit={() => setEditingMessage(null)}
      />
      <ConfirmDialog
        open={Boolean(pendingDeleteMessageId)}
        title="Excluir anúncio"
        description="Este anúncio será removido para todos os usuários."
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
        sourceMessage={
          pendingForwardMessageId
            ? messages.find((row) => row.messageId === pendingForwardMessageId) || null
            : null
        }
        contacts={forwardTargets}
        onlinePeerIds={onlinePeerIds}
        onCancel={() => setPendingForwardMessageId(null)}
        onConfirm={async (targetPeerIds) => {
          if (!pendingForwardMessageId) return;
          await onForwardMessage(targetPeerIds, pendingForwardMessageId);
          setPendingForwardMessageId(null);
        }}
      />

      {messageContextMenu && (
        <div
          className="chat-context-menu"
          style={{ left: messageContextMenu.x, top: messageContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {(() => {
            const message = messages.find((row) => row.messageId === messageContextMenu.messageId) || null;
            if (!message || message.deletedAt || message.localOnly) {
              return null;
            }
            return (
              <button
                type="button"
                className="chat-context-item"
                onClick={() => {
                  startReplyToMessage(message);
                  setMessageContextMenu(null);
                }}
              >
                <span className="menu-item-icon">
                  <ArrowReply20Regular />
                </span>
                <span>Responder</span>
              </button>
            );
          })()}
          {messageContextMenu.canEdit && (
            <button
              type="button"
              className="chat-context-item"
              onClick={() => {
                const message = messages.find((row) => row.messageId === messageContextMenu.messageId) || null;
                if (message) {
                  startEditMessage(message);
                }
              }}
            >
              <span className="menu-item-icon">
                <DocumentEdit20Regular />
              </span>
              <span>Editar</span>
            </button>
          )}
          {(() => {
            const message = messages.find((row) => row.messageId === messageContextMenu.messageId) || null;
            if (!message || !messageContextMenu.canForward || message.deletedAt || message.localOnly) {
              return null;
            }
            return (
              <button
                type="button"
                className="chat-context-item"
                onClick={() => {
                  setPendingForwardMessageId(message.messageId);
                  setMessageContextMenu(null);
                }}
              >
                <span className="menu-item-icon">
                  <ArrowForward20Regular />
                </span>
                <span>Encaminhar</span>
              </button>
            );
          })()}
          {Boolean(messageContextMenu.selectedText.trim()) && (
            <button
              type="button"
              className="chat-context-item"
              onClick={() => {
                void copySelectedText(messageContextMenu.selectedText);
                setMessageContextMenu(null);
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
                setMessageContextMenu(null);
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

      <Dialog
        open={Boolean(detailsDialog)}
        onOpenChange={(_, data) => {
          if (!data.open) setDetailsDialog(null);
        }}
      >
        <DialogSurface className="confirm-modal announcement-details-modal">
          <DialogBody>
            <DialogTitle>{detailsDialog?.title || 'Detalhes'}</DialogTitle>
            <DialogContent>
              {detailsDialog?.loading ? (
                <div className="announcement-details-empty">Carregando...</div>
              ) : (
                <div className="announcement-details-list">
                  {detailsDialog?.reactionDetails.map((item) => (
                    <div key={`${item.deviceId}-${item.reaction}`} className="announcement-details-row">
                      <Avatar emoji={item.avatarEmoji} bg={item.avatarBg} size={28} />
                      <span>{item.displayName}</span>
                      <strong><PlatformEmoji emoji={item.reaction} /></strong>
                    </div>
                  ))}
                  {detailsDialog?.readDetails.map((item) => (
                    <div key={`${item.deviceId}-${item.readAt}`} className="announcement-details-row">
                      <Avatar emoji={item.avatarEmoji} bg={item.avatarBg} size={28} />
                      <span>{item.displayName}</span>
                      <small>
                        {new Date(item.readAt).toLocaleTimeString('pt-BR', {
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </small>
                    </div>
                  ))}
                  {detailsDialog &&
                    !detailsDialog.loading &&
                    detailsDialog.reactionDetails.length === 0 &&
                    detailsDialog.readDetails.length === 0 && (
                      <div className="announcement-details-empty">Nenhum registro ainda.</div>
                    )}
                </div>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setDetailsDialog(null)}>
                Fechar
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </div>
  );
};
