import { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { Button, Caption1, Text } from '@fluentui/react-components';
import { ArrowReply20Regular } from '@fluentui/react-icons';
import { Checkmark20Regular } from '@fluentui/react-icons';
import { Clock20Regular } from '@fluentui/react-icons';
import { Copy20Regular } from '@fluentui/react-icons';
import { Delete20Regular } from '@fluentui/react-icons';
import { Dismiss20Regular } from '@fluentui/react-icons';
import { Emoji20Regular } from '@fluentui/react-icons';
import { Megaphone20Regular } from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
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
import { MessageComposer } from './MessageComposer';

interface AnnouncementsViewProps {
  messages: MessageRow[];
  loading: boolean;
  profile: Profile;
  peers: Peer[];
  reactionsByMessageId: Record<string, AnnouncementReactionSummary>;
  recentMessageIds: Record<string, number>;
  relayConnected: boolean;
  onSend: (text: string, replyTo?: MessageReplyReference | null) => Promise<void>;
  onReactToMessage: (messageId: string, reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
}

interface ReplyDraftUi extends MessageReplyReference {
  senderLabel: string;
}

const REACTIONS: Array<'👍' | '👎' | '❤️' | '😢' | '😊' | '😂'> = ['👍', '👎', '❤️', '😂', '😊', '😢'];

const formatTime = (value: number): string =>
  new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

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
      parts.push(text.slice(lastIndex, index));
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
        {raw}
      </a>
    );
    lastIndex = index + raw.length;
    match = regex.exec(text);
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
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
  reactionsByMessageId,
  recentMessageIds,
  relayConnected,
  onSend,
  onReactToMessage,
  onDeleteMessage
}: AnnouncementsViewProps) => {
  const [pendingDeleteMessageId, setPendingDeleteMessageId] = useState<string | null>(null);
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState<ReplyDraftUi | null>(null);
  const [messageContextMenu, setMessageContextMenu] = useState<{
    x: number;
    y: number;
    messageId: string;
    selectedText: string;
    canDelete: boolean;
  } | null>(null);
  const [jumpHighlightMessageId, setJumpHighlightMessageId] = useState<string | null>(null);
  const paneRootRef = useRef<HTMLDivElement | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const messageRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const jumpHighlightTimeoutRef = useRef<number | null>(null);

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
    const canDelete =
      !message.deletedAt &&
      !message.localOnly &&
      message.direction === 'out' &&
      message.senderDeviceId === profile.deviceId;
    const itemCount = (canReply ? 1 : 0) + (selectedText ? 1 : 0) + (canDelete ? 1 : 0);
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
      canDelete
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
    const timer = window.setInterval(() => {
      setNowTs(Date.now());
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

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
    const frameA = window.requestAnimationFrame(() => {
      scrollToBottom('auto');
      const frameB = window.requestAnimationFrame(() => {
        scrollToBottom('auto');
      });
      return () => window.cancelAnimationFrame(frameB);
    });
    return () => window.cancelAnimationFrame(frameA);
  }, []);

  const formatRemaining = (createdAt: number): string => {
    const remaining = createdAt + 24 * 60 * 60 * 1000 - nowTs;
    if (remaining <= 0) return 'expira em breve';
    const totalMinutes = Math.ceil(remaining / 60_000);
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `expira em ${days}d ${hours}h`;
    if (hours > 0) return `expira em ${hours}h ${minutes}m`;
    return `expira em ${minutes}m`;
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
            <Caption1>Comunicados para todos os usuários online. Eles somem após 24h.</Caption1>
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
            const sender = peers.find((peer) => peer.deviceId === message.senderDeviceId);
            const emoji = outgoing ? profile.avatarEmoji : sender?.avatarEmoji || '📢';
            const bg = outgoing ? profile.avatarBg : sender?.avatarBg || '#5b5fc7';
            const senderName = outgoing ? 'Você' : sender?.displayName || message.senderDeviceId;
            const summary = reactionsByMessageId[message.messageId] || { counts: {}, myReaction: null };
            const hasCounters = REACTIONS.some((reaction) => (summary.counts[reaction] || 0) > 0);
            const reactionPickerOpen = reactionPickerMessageId === message.messageId;
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
                  <div className={`bubble ${outgoing ? 'out' : 'in'}`}>
                    <div onContextMenu={(event) => handleBubbleContextMenu(event, message)}>
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
                          <span className="reply-reference-preview">{replyPreview}</span>
                        </button>
                      )}
                      <div className="announcement-meta">
                        <span className="announcement-sender">{senderName}</span>
                        <span className="announcement-expiry-clock">
                          <Clock20Regular />
                          {formatRemaining(message.createdAt)}
                        </span>
                      </div>
                      <div className="message-text">{renderMessageText(message.bodyText || '')}</div>
                      <div className="bubble-meta">
                        <span className="bubble-time">
                          <Checkmark20Regular />
                          <span>{formatTime(message.createdAt)}</span>
                        </span>
                      </div>
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
        placeholder="Enviar anúncio para todos online"
        disabled={!relayConnected}
        autoFocusKey="announcements"
        onSend={async (text, replyTo) => {
          await onSend(text, replyTo);
          setReplyDraft(null);
        }}
        replyDraft={replyDraft}
        onCancelReply={() => setReplyDraft(null)}
      />
      <ConfirmDialog
        open={Boolean(pendingDeleteMessageId)}
        title="Excluir anúncio"
        description="Este anúncio será removido para você e para os usuários online."
        confirmLabel="Excluir"
        onCancel={() => setPendingDeleteMessageId(null)}
        onConfirm={() => {
          if (pendingDeleteMessageId) {
            void onDeleteMessage(pendingDeleteMessageId);
          }
          setPendingDeleteMessageId(null);
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
    </div>
  );
};
