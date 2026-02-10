import {
  CSSProperties,
  KeyboardEvent,
  MouseEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import {
  Badge,
  Button,
  Caption1,
  Input,
  Text
} from '@fluentui/react-components';
import {
  ArrowSync20Regular,
  Dismiss20Regular,
  PlugConnected20Regular,
  PlugDisconnected20Regular,
  Pin20Regular,
  Delete20Regular,
  Megaphone20Regular,
  WeatherMoon20Regular,
  WeatherSunny20Regular,
  Desktop20Regular,
  Settings20Regular,
  Chat20Regular
} from '@fluentui/react-icons';
import { Peer, Profile } from '../api/ipcClient';
import { Avatar } from './Avatar';
import { ConfirmDialog } from './ConfirmDialog';

interface SidebarProps {
  profile: Profile;
  peers: Peer[];
  search: string;
  selectedConversationId: string;
  unreadByConversation: Record<string, number>;
  conversationPreviewById: Record<string, string>;
  typingByConversation: Record<string, boolean>;
  onlinePeerIds: string[];
  onSearch: (value: string) => void;
  onSelectConversation: (id: string) => void;
  onClearConversation: (id: string) => Promise<void>;
  onForgetContactConversation: (id: string) => Promise<void>;
  onOpenSettings: () => void;
  onQuickStatusChange: (statusMessage: string) => Promise<void>;
  themeMode: 'system' | 'light' | 'dark';
  onThemeModeChange: (mode: 'system' | 'light' | 'dark') => void;
  relayConnected: boolean;
  relayEndpoint: string | null;
  syncActive: boolean;
}

export const Sidebar = ({
  profile,
  peers,
  search,
  selectedConversationId,
  unreadByConversation,
  conversationPreviewById,
  typingByConversation,
  onlinePeerIds,
  onSearch,
  onSelectConversation,
  onClearConversation,
  onForgetContactConversation,
  onOpenSettings,
  onQuickStatusChange,
  themeMode,
  onThemeModeChange,
  relayConnected,
  relayEndpoint,
  syncActive
}: SidebarProps) => {
  const pinnedStorageKey = 'lantern.sidebar.pinnedConversations';
  const filtered = useMemo(
    () => peers.filter((peer) => peer.displayName.toLowerCase().includes(search.toLowerCase())),
    [peers, search]
  );
  const [pinnedConversationIds, setPinnedConversationIds] = useState<string[]>(() => {
    try {
      if (typeof window === 'undefined') return [];
      const raw = window.localStorage.getItem(pinnedStorageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (value): value is string => typeof value === 'string' && value.startsWith('dm:')
      );
    } catch {
      return [];
    }
  });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; conversationId: string } | null>(null);
  const [pendingClearConversationId, setPendingClearConversationId] = useState<string | null>(null);
  const [pendingForgetConversationId, setPendingForgetConversationId] = useState<string | null>(null);
  const [quickStatusOpen, setQuickStatusOpen] = useState(false);
  const [customStatusDraft, setCustomStatusDraft] = useState('');
  const quickStatusRef = useRef<HTMLDivElement | null>(null);
  const quickStatusButtonRef = useRef<HTMLButtonElement | null>(null);
  const contactsListRef = useRef<HTMLDivElement | null>(null);
  const [quickStatusMenuStyle, setQuickStatusMenuStyle] = useState<CSSProperties>({});
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const previousTopById = useRef<Map<string, number>>(new Map());
  const previousOrderSignature = useRef<string>('');
  const [contactsScrollTop, setContactsScrollTop] = useState(0);
  const [contactsViewportHeight, setContactsViewportHeight] = useState(0);
  const statusOptions = ['Disponível', 'Em reunião', 'Foco total', 'Volto já', 'Não perturbe'];
  const CONTACT_ITEM_HEIGHT = 70;
  const CONTACT_OVERSCAN = 8;

  const TypingInline = () => (
    <span className="sidebar-typing-inline" aria-label="Digitando">
      <span className="sidebar-typing-dot" />
      <span className="sidebar-typing-dot" />
      <span className="sidebar-typing-dot" />
    </span>
  );

  const orderedFiltered = useMemo(() => {
    const pinnedSet = new Set(pinnedConversationIds);
    return [...filtered].sort((a, b) => {
      const aPinned = pinnedSet.has(`dm:${a.deviceId}`) ? 1 : 0;
      const bPinned = pinnedSet.has(`dm:${b.deviceId}`) ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;

      const aUnread = unreadByConversation[`dm:${a.deviceId}`] || 0;
      const bUnread = unreadByConversation[`dm:${b.deviceId}`] || 0;
      const aHasUnread = aUnread > 0 ? 1 : 0;
      const bHasUnread = bUnread > 0 ? 1 : 0;
      if (aHasUnread !== bHasUnread) return bHasUnread - aHasUnread;
      if (aUnread !== bUnread) return bUnread - aUnread;

      return a.displayName.localeCompare(b.displayName, 'pt-BR', { sensitivity: 'base' });
    });
  }, [filtered, pinnedConversationIds, unreadByConversation]);

  const orderSignature = useMemo(
    () => orderedFiltered.map((peer) => peer.deviceId).join('|'),
    [orderedFiltered]
  );
  const totalUnreadCount = useMemo(
    () =>
      Object.values(unreadByConversation).reduce(
        (sum, value) => sum + Math.max(0, Number(value) || 0),
        0
      ),
    [unreadByConversation]
  );
  const unreadLabel = totalUnreadCount === 1 ? '1 não lida' : `${totalUnreadCount} não lidas`;
  const shouldVirtualizeContacts = orderedFiltered.length > 70;
  const contactVisibleStart = shouldVirtualizeContacts
    ? Math.max(0, Math.floor(contactsScrollTop / CONTACT_ITEM_HEIGHT) - CONTACT_OVERSCAN)
    : 0;
  const contactVisibleCount = shouldVirtualizeContacts
    ? Math.ceil(contactsViewportHeight / CONTACT_ITEM_HEIGHT) + CONTACT_OVERSCAN * 2
    : orderedFiltered.length;
  const contactVisibleEnd = shouldVirtualizeContacts
    ? Math.min(orderedFiltered.length, contactVisibleStart + contactVisibleCount)
    : orderedFiltered.length;
  const visiblePeers = shouldVirtualizeContacts
    ? orderedFiltered.slice(contactVisibleStart, contactVisibleEnd)
    : orderedFiltered;
  const contactTopSpacerHeight = shouldVirtualizeContacts
    ? contactVisibleStart * CONTACT_ITEM_HEIGHT
    : 0;
  const contactBottomSpacerHeight = shouldVirtualizeContacts
    ? Math.max(0, (orderedFiltered.length - contactVisibleEnd) * CONTACT_ITEM_HEIGHT)
    : 0;

  useEffect(() => {
    try {
      window.localStorage.setItem(pinnedStorageKey, JSON.stringify(pinnedConversationIds));
    } catch {
      // ignore
    }
  }, [pinnedConversationIds]);

  useEffect(() => {
    const onClose = () => setContextMenu(null);
    const onCloseQuickStatus = (event: MouseEvent) => {
      if (!quickStatusRef.current) return;
      if (!quickStatusRef.current.contains(event.target as Node)) {
        setQuickStatusOpen(false);
      }
    };
    window.addEventListener('click', onClose);
    window.addEventListener('mousedown', onCloseQuickStatus);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('click', onClose);
      window.removeEventListener('mousedown', onCloseQuickStatus);
      window.removeEventListener('scroll', onClose, true);
    };
  }, []);

  useEffect(() => {
    setCustomStatusDraft(profile.statusMessage || '');
  }, [profile.statusMessage]);

  useLayoutEffect(() => {
    if (!quickStatusOpen) return;

    const reposition = () => {
      const buttonEl = quickStatusButtonRef.current;
      if (!buttonEl) return;
      const rect = buttonEl.getBoundingClientRect();
      const menuWidth = Math.min(280, Math.max(220, window.innerWidth - 24));
      const horizontalPadding = 8;
      const left = Math.min(
        Math.max(horizontalPadding, rect.right - menuWidth),
        window.innerWidth - menuWidth - horizontalPadding
      );
      const preferredTop = rect.bottom + 8;
      const viewportBottomPadding = 8;
      const availableBelow = window.innerHeight - preferredTop - viewportBottomPadding;
      const maxHeight = Math.max(160, Math.min(360, availableBelow));
      const top =
        availableBelow >= 170
          ? preferredTop
          : Math.max(8, rect.top - Math.min(360, window.innerHeight - 24) - 8);

      setQuickStatusMenuStyle({
        position: 'fixed',
        left,
        top,
        width: menuWidth,
        maxHeight
      });
    };

    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [quickStatusOpen]);

  useLayoutEffect(() => {
    if (shouldVirtualizeContacts) {
      previousTopById.current = new Map();
      previousOrderSignature.current = orderSignature;
      return;
    }
    if (orderSignature === previousOrderSignature.current) {
      return;
    }
    previousOrderSignature.current = orderSignature;

    const currentTopById = new Map<string, number>();
    for (const peer of orderedFiltered) {
      const element = itemRefs.current[peer.deviceId];
      if (!element) continue;
      currentTopById.set(peer.deviceId, element.getBoundingClientRect().top);
    }

    for (const [deviceId, top] of currentTopById.entries()) {
      const previousTop = previousTopById.current.get(deviceId);
      if (typeof previousTop !== 'number') continue;
      const delta = previousTop - top;
      if (Math.abs(delta) < 1) continue;
      const element = itemRefs.current[deviceId];
      if (!element) continue;
      try {
        if (typeof element.animate === 'function') {
          element.animate(
            [
              { transform: `translateY(${delta}px)` },
              { transform: 'translateY(0px)' }
            ],
            {
              duration: 230,
              easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)'
            }
          );
        }
      } catch {
        // fallback silencioso se Web Animations falhar neste renderer
      }
    }

    previousTopById.current = currentTopById;
  }, [orderSignature, orderedFiltered, shouldVirtualizeContacts]);

  useLayoutEffect(() => {
    const node = contactsListRef.current;
    if (!node) return;

    const syncMetrics = () => {
      setContactsScrollTop(node.scrollTop);
      setContactsViewportHeight(node.clientHeight);
    };

    syncMetrics();
    const onScroll = () => {
      setContactsScrollTop(node.scrollTop);
    };
    node.addEventListener('scroll', onScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => {
      setContactsViewportHeight(node.clientHeight);
    });
    resizeObserver.observe(node);

    return () => {
      node.removeEventListener('scroll', onScroll);
      resizeObserver.disconnect();
    };
  }, [shouldVirtualizeContacts]);

  const openContextMenu = (
    event: MouseEvent<HTMLElement>,
    conversationId: string
  ): void => {
    if (conversationId === 'announcements') {
      return;
    }
    event.preventDefault();
    const menuWidth = 208;
    const isDm = conversationId.startsWith('dm:');
    const menuHeight = isDm ? 156 : 44;
    const x = Math.min(event.clientX, window.innerWidth - menuWidth - 12);
    const y = Math.min(event.clientY, window.innerHeight - menuHeight - 12);
    setContextMenu({ x, y, conversationId });
  };

  const isConversationPinned = (conversationId: string): boolean =>
    pinnedConversationIds.includes(conversationId);

  const toggleConversationPinned = (conversationId: string): void => {
    if (!conversationId.startsWith('dm:')) return;
    setPinnedConversationIds((current) => {
      if (current.includes(conversationId)) {
        return current.filter((id) => id !== conversationId);
      }
      return [conversationId, ...current];
    });
  };

  const handleConversationKeyDown = (
    event: KeyboardEvent<HTMLElement>,
    conversationId: string
  ): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelectConversation(conversationId);
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-topbar">
        <div className="sidebar-profile">
          <Avatar emoji={profile.avatarEmoji} bg={profile.avatarBg} size={34} />
          <div className="conversation-text">
            <Text weight="semibold">{profile.displayName}</Text>
            <Caption1>{profile.statusMessage || profile.deviceId.slice(0, 8)}</Caption1>
          </div>
        </div>
        <div className="sidebar-topbar-actions">
          <div className="quick-status-wrap" ref={quickStatusRef}>
            <Button
              ref={quickStatusButtonRef}
              appearance="subtle"
              icon={<Chat20Regular />}
              aria-label="Trocar status"
              title="Trocar status"
              onClick={() => setQuickStatusOpen((open) => !open)}
            />
            {quickStatusOpen && (
              <div
                className="quick-status-menu"
                style={quickStatusMenuStyle}
                onClick={(event) => event.stopPropagation()}
              >
                <div className="quick-status-title">Trocar status</div>
                <div className="quick-status-list">
                  {statusOptions.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className={`quick-status-item ${profile.statusMessage === option ? 'active' : ''}`}
                      onClick={() => {
                        void onQuickStatusChange(option);
                        setCustomStatusDraft(option);
                        setQuickStatusOpen(false);
                      }}
                    >
                      {option}
                    </button>
                  ))}
                </div>
                <div className="quick-status-custom">
                  <Input
                    value={customStatusDraft}
                    placeholder="Status personalizado"
                    onChange={(_, data) => setCustomStatusDraft(data.value)}
                    maxLength={120}
                  />
                  <Button
                    appearance="primary"
                    onClick={() => {
                      const value = customStatusDraft.trim() || 'Disponível';
                      void onQuickStatusChange(value);
                      setQuickStatusOpen(false);
                    }}
                  >
                    Aplicar
                  </Button>
                </div>
              </div>
            )}
          </div>
          <Button appearance="subtle" icon={<Settings20Regular />} onClick={onOpenSettings} />
          <Button
            appearance={themeMode === 'system' ? 'primary' : 'subtle'}
            icon={<Desktop20Regular />}
            onClick={() => onThemeModeChange('system')}
          />
          <Button
            appearance={themeMode === 'light' ? 'primary' : 'subtle'}
            icon={<WeatherSunny20Regular />}
            onClick={() => onThemeModeChange('light')}
          />
          <Button
            appearance={themeMode === 'dark' ? 'primary' : 'subtle'}
            icon={<WeatherMoon20Regular />}
            onClick={() => onThemeModeChange('dark')}
          />
        </div>
      </div>

      <div className="search-wrap">
        <Input
          className="search-input"
          value={search}
          placeholder="Pesquisar contatos"
          onChange={(_, data) => onSearch(data.value)}
        />
      </div>

      <button
        className={`conversation-item ${selectedConversationId === 'announcements' ? 'active' : ''}`}
        onClick={() => onSelectConversation('announcements')}
      >
        <div className="conversation-meta">
            <Megaphone20Regular className="conversation-leading-icon" />
            <div className="conversation-text">
              <Text weight="semibold">Anúncios</Text>
              <Caption1 className="conversation-preview conversation-preview-slot">
                {conversationPreviewById.announcements || 'Mensagens para todos'}
              </Caption1>
            </div>
          </div>
        {(unreadByConversation.announcements || 0) > 0 && (
          <Badge appearance="filled" color="important">
            {unreadByConversation.announcements}
          </Badge>
        )}
      </button>

      <div className="sidebar-section-title">
        <Caption1>Contatos</Caption1>
        <Caption1 className="sidebar-section-summary">
          {onlinePeerIds.length} online · {unreadLabel}
        </Caption1>
      </div>
      <div className="contacts-list" ref={contactsListRef}>
        {contactTopSpacerHeight > 0 && (
          <div style={{ height: contactTopSpacerHeight }} aria-hidden />
        )}
        {visiblePeers.map((peer) => {
          const conversationId = `dm:${peer.deviceId}`;
          const unread = unreadByConversation[conversationId] || 0;
          const isPinned = isConversationPinned(conversationId);
          const isOnline = onlinePeerIds.includes(peer.deviceId);
          const statusText = isOnline
            ? (peer.statusMessage || '').trim() || 'Online'
            : 'Offline';
          const previewText =
            conversationPreviewById[conversationId] ||
            (isOnline ? 'Sem mensagens ainda' : 'Offline');
          return (
            <div
              key={peer.deviceId}
              role="button"
              tabIndex={0}
              className={`conversation-item ${selectedConversationId === conversationId ? 'active' : ''}`}
              ref={(element) => {
                itemRefs.current[peer.deviceId] = element;
              }}
              onClick={() => onSelectConversation(conversationId)}
              onKeyDown={(event) => handleConversationKeyDown(event, conversationId)}
              onContextMenu={(event) => openContextMenu(event, conversationId)}
            >
              <div className="conversation-meta">
                <div className="avatar-presence-wrap">
                  <Avatar emoji={peer.avatarEmoji} bg={peer.avatarBg} size={36} />
                  <span className={`presence-dot ${isOnline ? 'online' : 'offline'}`} />
                </div>
                <div className="conversation-text">
                  <Text weight="semibold">{peer.displayName}</Text>
                  <div className="conversation-submeta">
                    <Caption1 className="conversation-status-line">
                      <span className={`conversation-status-pill ${isOnline ? 'online' : 'offline'}`}>
                        {statusText}
                      </span>
                    </Caption1>
                    <Caption1 className="conversation-preview conversation-preview-slot">
                      {typingByConversation[conversationId] ? (
                        <TypingInline />
                      ) : (
                        <span className="conversation-preview-text">{previewText}</span>
                      )}
                    </Caption1>
                  </div>
                </div>
              </div>
              <div className="conversation-right">
                <button
                  type="button"
                  className={`conversation-pin-btn ${isPinned ? 'pinned' : ''}`}
                  title={isPinned ? 'Desfixar conversa' : 'Fixar conversa no topo'}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleConversationPinned(conversationId);
                  }}
                >
                  <Pin20Regular />
                </button>
                {unread > 0 && (
                  <Badge appearance="filled" color="danger">
                    {unread}
                  </Badge>
                )}
              </div>
            </div>
          );
        })}
        {contactBottomSpacerHeight > 0 && (
          <div style={{ height: contactBottomSpacerHeight }} aria-hidden />
        )}
      </div>

      <div className="sidebar-footer">
        {relayConnected ? (
          <PlugConnected20Regular className="sidebar-footer-icon relay-online" />
        ) : (
          <PlugDisconnected20Regular className="sidebar-footer-icon relay-offline" />
        )}
        <Caption1 title={relayEndpoint || undefined}>
          {relayConnected ? 'Conectado ao Relay' : 'Não conectado ao Relay'}
        </Caption1>
        {syncActive && <ArrowSync20Regular className="sidebar-footer-sync" />}
      </div>

      {contextMenu && (
        <div
          className="chat-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {contextMenu.conversationId.startsWith('dm:') && (
            <button
              type="button"
              className="chat-context-item"
              onClick={() => {
                toggleConversationPinned(contextMenu.conversationId);
                setContextMenu(null);
              }}
            >
              <span className="menu-item-icon">
                <Pin20Regular />
              </span>
              <span>
                {isConversationPinned(contextMenu.conversationId)
                  ? 'Desfixar do topo'
                  : 'Fixar no topo'}
              </span>
            </button>
          )}
          <button
            type="button"
            className="chat-context-item danger"
            onClick={() => {
              setPendingClearConversationId(contextMenu.conversationId);
              setContextMenu(null);
            }}
          >
            <span className="menu-item-icon">
              <Delete20Regular />
            </span>
            <span>Limpar conversa</span>
          </button>
          {contextMenu.conversationId.startsWith('dm:') && (
            <button
              type="button"
              className="chat-context-item danger"
              onClick={() => {
                setPendingForgetConversationId(contextMenu.conversationId);
                setContextMenu(null);
              }}
            >
              <span className="menu-item-icon">
                <Dismiss20Regular />
              </span>
              <span>Excluir contato e conversa</span>
            </button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(pendingClearConversationId)}
        title="Limpar conversa"
        description="Esta ação remove toda a conversa e anexos salvos pelo Lantern neste dispositivo."
        confirmLabel="Excluir"
        onCancel={() => setPendingClearConversationId(null)}
        onConfirm={() => {
          if (pendingClearConversationId) {
            void onClearConversation(pendingClearConversationId);
          }
          setPendingClearConversationId(null);
        }}
      />
      <ConfirmDialog
        open={Boolean(pendingForgetConversationId)}
        title="Excluir contato e conversa"
        description="Isto remove a conversa para ambos e oculta o contato até ele aparecer novamente no Relay."
        confirmLabel="Excluir"
        onCancel={() => setPendingForgetConversationId(null)}
        onConfirm={() => {
          if (pendingForgetConversationId) {
            void onForgetContactConversation(pendingForgetConversationId);
          }
          setPendingForgetConversationId(null);
        }}
      />
    </aside>
  );
};
