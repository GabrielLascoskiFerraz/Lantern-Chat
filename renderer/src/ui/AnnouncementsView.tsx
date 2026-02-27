import { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { Button, Caption1, Text } from '@fluentui/react-components';
import { Checkmark20Regular } from '@fluentui/react-icons';
import { Clock20Regular } from '@fluentui/react-icons';
import { Copy20Regular } from '@fluentui/react-icons';
import { Delete20Regular } from '@fluentui/react-icons';
import { Dismiss20Regular } from '@fluentui/react-icons';
import { Emoji20Regular } from '@fluentui/react-icons';
import { Megaphone20Regular } from '@fluentui/react-icons';
import { useEffect, useRef, useState } from 'react';
import { AnnouncementReactionSummary, ipcClient, MessageRow, Peer, Profile } from '../api/ipcClient';
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
  onSend: (text: string) => Promise<void>;
  onReactToMessage: (messageId: string, reaction: '👍' | '👎' | '❤️' | '😢' | '😊' | '😂' | null) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
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
  const [selectionContextMenu, setSelectionContextMenu] = useState<{
    x: number;
    y: number;
    text: string;
  } | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

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

  const handleBubbleContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() || '';
    if (!selectedText || !selection || selection.rangeCount === 0) {
      setSelectionContextMenu(null);
      return;
    }

    const container = event.currentTarget;
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) {
      return;
    }

    event.preventDefault();
    const menuWidth = 188;
    const menuHeight = 52;
    const x = Math.min(event.clientX, window.innerWidth - menuWidth - 12);
    const y = Math.min(event.clientY, window.innerHeight - menuHeight - 12);
    setSelectionContextMenu({ x, y, text: selectedText });
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
    if (!selectionContextMenu) return;
    const close = () => setSelectionContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [selectionContextMenu]);

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
    <div className="main-pane">
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

            return (
              <div
                key={message.messageId}
                className={`bubble-row ${outgoing ? 'out' : 'in'} has-actions ${hasCounters ? 'has-static-reaction' : ''} ${recentMessageIds[message.messageId] ? 'is-new' : ''}`}
              >
                {!outgoing && <Avatar emoji={emoji} bg={bg} size={30} />}
                <div className={`bubble-block ${outgoing ? 'out' : 'in'}`}>
                  <div className={`bubble ${outgoing ? 'out' : 'in'}`}>
                    <div onContextMenu={handleBubbleContextMenu}>
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
                      {reactionPickerMessageId === message.messageId ? (
                        <Dismiss20Regular />
                      ) : (
                        <Emoji20Regular />
                      )}
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
        onSend={onSend}
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

      {selectionContextMenu && (
        <div
          className="chat-context-menu"
          style={{ left: selectionContextMenu.x, top: selectionContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="chat-context-item"
            onClick={() => {
              void copySelectedText(selectionContextMenu.text);
              setSelectionContextMenu(null);
            }}
          >
            <span className="menu-item-icon">
              <Copy20Regular />
            </span>
            <span>Copiar texto</span>
          </button>
        </div>
      )}
    </div>
  );
};
