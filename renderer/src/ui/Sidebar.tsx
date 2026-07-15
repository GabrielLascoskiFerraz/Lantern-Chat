import {
  CSSProperties,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
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
  ArchiveArrowBack20Regular,
  ArrowSync20Regular,
  Box20Regular,
  ChevronDown20Regular,
  ChevronUp20Regular,
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
  Chat20Regular,
  MailUnread20Regular,
  PeopleTeam20Regular,
  Add20Regular
  ,SignOut20Regular
} from '@fluentui/react-icons';
import { GroupInfo, GroupMember, Peer, Profile, StartupSettings } from '../api/ipcClient';
import { Avatar } from './Avatar';
import { ConfirmDialog } from './ConfirmDialog';
import { CreateGroupDialog } from './CreateGroupDialog';

interface SidebarProps {
  profile: Profile;
  peers: Peer[];
  groups: GroupInfo[];
  groupMembersById: Record<string, GroupMember[]>;
  search: string;
  selectedConversationId: string;
  unreadByConversation: Record<string, number>;
  conversationPreviewById: Record<string, string>;
  typingByConversation: Record<string, boolean>;
  archivedConversationIds: string[];
  pinnedConversationIds: string[];
  onlinePeerIds: string[];
  onSearch: (value: string) => void;
  onSelectConversation: (id: string) => void;
  onMarkConversationUnread: (id: string) => Promise<void>;
  onArchiveConversation: (id: string) => Promise<void>;
  onUnarchiveConversation: (id: string) => Promise<void>;
  onSetConversationPinned: (id: string, pinned: boolean) => Promise<void>;
  onClearConversation: (id: string) => Promise<void>;
  onResyncConversation: (id: string) => Promise<void>;
  onOpenGroupDetails: (groupId: string) => void;
  onLeaveGroup: (groupId: string) => Promise<void>;
  onDeleteGroup: (groupId: string) => Promise<void>;
  onCreateGroup: (input: {
    name: string;
    emoji: string;
    avatarBg: string;
    description: string;
    memberDeviceIds: string[];
  }) => Promise<void>;
  onOpenSettings: () => void;
  onLogout: () => Promise<void>;
  onQuickStatusChange: (statusMessage: string) => Promise<void>;
  startupSettings: StartupSettings | null;
  onDoNotDisturbUntilChange: (value: number) => Promise<void>;
  themeMode: 'system' | 'light' | 'dark';
  onThemeModeChange: (mode: 'system' | 'light' | 'dark') => void;
  relayConnected: boolean;
  relayEndpoint: string | null;
  syncActive: boolean;
}

export const Sidebar = ({
  profile,
  peers,
  groups,
  groupMembersById,
  search,
  selectedConversationId,
  unreadByConversation,
  conversationPreviewById,
  typingByConversation,
  archivedConversationIds,
  pinnedConversationIds,
  onlinePeerIds,
  onSearch,
  onSelectConversation,
  onMarkConversationUnread,
  onArchiveConversation,
  onUnarchiveConversation,
  onSetConversationPinned,
  onClearConversation,
  onResyncConversation,
  onOpenGroupDetails,
  onLeaveGroup,
  onDeleteGroup,
  onCreateGroup,
  onOpenSettings,
  onLogout,
  onQuickStatusChange,
  startupSettings,
  onDoNotDisturbUntilChange,
  themeMode,
  onThemeModeChange,
  relayConnected,
  relayEndpoint,
  syncActive
}: SidebarProps) => {
  const filtered = useMemo(
    () => peers.filter((peer) => peer.displayName.toLowerCase().includes(search.toLowerCase())),
    [peers, search]
  );
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; conversationId: string } | null>(null);
  const [pendingClearConversationId, setPendingClearConversationId] = useState<string | null>(null);
  const [pendingLeaveGroupId, setPendingLeaveGroupId] = useState<string | null>(null);
  const [pendingDeleteGroupId, setPendingDeleteGroupId] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [quickStatusOpen, setQuickStatusOpen] = useState(false);
  const [quickStatusClosing, setQuickStatusClosing] = useState(false);
  const [customStatusDraft, setCustomStatusDraft] = useState('');
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const quickStatusRef = useRef<HTMLDivElement | null>(null);
  const quickStatusButtonRef = useRef<HTMLButtonElement | null>(null);
  const quickStatusCloseTimeoutRef = useRef<number | null>(null);
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
  const activeDoNotDisturbUntil = Math.max(0, Number(startupSettings?.doNotDisturbUntil || 0));
  const setDoNotDisturbFor = (milliseconds: number): void => {
    void onDoNotDisturbUntilChange(Date.now() + milliseconds);
  };
  const setDoNotDisturbUntilTomorrow = (): void => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(8, 0, 0, 0);
    void onDoNotDisturbUntilChange(tomorrow.getTime());
  };

  const TypingInline = () => (
    <span className="sidebar-typing-inline" aria-label="Digitando">
      <span className="sidebar-typing-dot" />
      <span className="sidebar-typing-dot" />
      <span className="sidebar-typing-dot" />
    </span>
  );

  const archivedSet = useMemo(
    () => new Set(archivedConversationIds),
    [archivedConversationIds]
  );
  const orderSidebarPeers = (items: Peer[], includePinned: boolean): Peer[] => {
    const pinnedSet = new Set(pinnedConversationIds);
    const onlineSet = new Set(onlinePeerIds);
    return [...items].sort((a, b) => {
      const aPinned = pinnedSet.has(`dm:${a.deviceId}`) ? 1 : 0;
      const bPinned = pinnedSet.has(`dm:${b.deviceId}`) ? 1 : 0;
      if (includePinned && aPinned !== bPinned) return bPinned - aPinned;

      const aUnread = unreadByConversation[`dm:${a.deviceId}`] || 0;
      const bUnread = unreadByConversation[`dm:${b.deviceId}`] || 0;
      const aHasUnread = aUnread > 0 ? 1 : 0;
      const bHasUnread = bUnread > 0 ? 1 : 0;
      if (aHasUnread !== bHasUnread) return bHasUnread - aHasUnread;

      const aOnline = onlineSet.has(a.deviceId) ? 1 : 0;
      const bOnline = onlineSet.has(b.deviceId) ? 1 : 0;
      if (aOnline !== bOnline) return bOnline - aOnline;

      if (aUnread !== bUnread) return bUnread - aUnread;

      return a.displayName.localeCompare(b.displayName, 'pt-BR', { sensitivity: 'base' });
    });
  };

  const orderedFiltered = useMemo(() => {
    const mainPeers = filtered.filter((peer) => !archivedSet.has(`dm:${peer.deviceId}`));
    return orderSidebarPeers(mainPeers, true);
  }, [filtered, archivedSet, pinnedConversationIds, unreadByConversation, onlinePeerIds]);

  const archivedPeers = useMemo(() => {
    const archived = filtered.filter((peer) => archivedSet.has(`dm:${peer.deviceId}`));
    return orderSidebarPeers(archived, false);
  }, [filtered, archivedSet, pinnedConversationIds, unreadByConversation, onlinePeerIds]);
  const totalArchivedCount = useMemo(
    () => peers.filter((peer) => archivedSet.has(`dm:${peer.deviceId}`)).length,
    [peers, archivedSet]
  );
  const archivedUnreadCount = useMemo(
    () =>
      peers.reduce((sum, peer) => {
        const conversationId = `dm:${peer.deviceId}`;
        if (!archivedSet.has(conversationId)) return sum;
        return sum + Math.max(0, unreadByConversation[conversationId] || 0);
      }, 0),
    [peers, archivedSet, unreadByConversation]
  );

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
  const filteredGroups = useMemo(
    () => groups.filter((group) => group.name.toLowerCase().includes(search.toLowerCase())),
    [groups, search]
  );
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

  const closeQuickStatusMenu = (): void => {
    if (!quickStatusOpen || quickStatusClosing) return;
    setQuickStatusClosing(true);
    if (quickStatusCloseTimeoutRef.current) {
      window.clearTimeout(quickStatusCloseTimeoutRef.current);
    }
    quickStatusCloseTimeoutRef.current = window.setTimeout(() => {
      setQuickStatusOpen(false);
      setQuickStatusClosing(false);
      quickStatusCloseTimeoutRef.current = null;
    }, 150);
  };

  const openQuickStatusMenu = (): void => {
    if (quickStatusCloseTimeoutRef.current) {
      window.clearTimeout(quickStatusCloseTimeoutRef.current);
      quickStatusCloseTimeoutRef.current = null;
    }
    setQuickStatusClosing(false);
    setQuickStatusOpen(true);
  };

  const toggleQuickStatusMenu = (): void => {
    if (quickStatusOpen && !quickStatusClosing) {
      closeQuickStatusMenu();
      return;
    }
    openQuickStatusMenu();
  };

  useEffect(() => {
    const onClose = () => setContextMenu(null);
    const onCloseQuickStatus = (event: globalThis.MouseEvent) => {
      if (!quickStatusRef.current) return;
      if (!quickStatusRef.current.contains(event.target as Node)) {
        closeQuickStatusMenu();
      }
    };
    window.addEventListener('click', onClose);
    window.addEventListener('mousedown', onCloseQuickStatus);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('click', onClose);
      window.removeEventListener('mousedown', onCloseQuickStatus);
      window.removeEventListener('scroll', onClose, true);
      if (quickStatusCloseTimeoutRef.current) {
        window.clearTimeout(quickStatusCloseTimeoutRef.current);
        quickStatusCloseTimeoutRef.current = null;
      }
    };
  }, [quickStatusOpen, quickStatusClosing]);

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
    event: ReactMouseEvent<HTMLElement>,
    conversationId: string
  ): void => {
    if (conversationId === 'announcements') {
      return;
    }
    event.preventDefault();
    const menuWidth = Math.max(140, Math.min(228, window.innerWidth - 24));
    const isDm = conversationId.startsWith('dm:');
    const groupId = conversationId.startsWith('group:') ? conversationId.slice('group:'.length) : '';
    const group = groupId ? groups.find((candidate) => candidate.groupId === groupId) : null;
    const localMember = group
      ? (groupMembersById[group.groupId] || []).find(
          (member) => member.deviceId === profile.deviceId && member.status === 'active'
        )
      : null;
    const canDeleteGroup = Boolean(localMember?.role === 'owner');
    const actionCount = isDm ? 5 : group ? 5 + (canDeleteGroup ? 1 : 0) : 2;
    const menuHeight = Math.max(112, Math.min(actionCount * 46 + 16, window.innerHeight - 24));
    const x = Math.max(12, Math.min(event.clientX, window.innerWidth - menuWidth - 12));
    const y = Math.max(12, Math.min(event.clientY, window.innerHeight - menuHeight - 12));
    setContextMenu({ x, y, conversationId });
  };

  const contextGroup = useMemo(() => {
    if (!contextMenu?.conversationId.startsWith('group:')) return null;
    const groupId = contextMenu.conversationId.slice('group:'.length);
    return groups.find((group) => group.groupId === groupId) || null;
  }, [contextMenu, groups]);

  const contextGroupMembership = contextGroup
    ? (groupMembersById[contextGroup.groupId] || []).find(
        (member) => member.deviceId === profile.deviceId && member.status === 'active'
      )
    : null;
  const canDeleteContextGroup = Boolean(
    contextGroupMembership?.role === 'owner'
  );

  const isConversationPinned = (conversationId: string): boolean =>
    pinnedConversationIds.includes(conversationId);

  const isConversationArchived = (conversationId: string): boolean =>
    archivedSet.has(conversationId);

  const toggleConversationPinned = (conversationId: string): void => {
    if (!conversationId.startsWith('dm:')) return;
    void onSetConversationPinned(conversationId, !isConversationPinned(conversationId));
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

  const renderConversationItem = (peer: Peer, archived = false) => {
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
        className={`conversation-item ${archived ? 'archived' : ''} ${
          selectedConversationId === conversationId ? 'active' : ''
        }`}
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
            <div className="conversation-name-row">
              <Text weight="semibold">{peer.displayName}</Text>
              {peer.department && <span className="department-tag">{peer.department}</span>}
            </div>
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
          {!archived && (
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
          )}
          {unread > 0 && (
            <Badge appearance="filled" color="danger">
              {unread}
            </Badge>
          )}
        </div>
      </div>
    );
  };

  const renderGroupItem = (group: GroupInfo) => {
    const conversationId = `group:${group.groupId}`;
    const unread = unreadByConversation[conversationId] || 0;
    const previewText = conversationPreviewById[conversationId] || group.description || 'Grupo';
    const activeMembers = (groupMembersById[group.groupId] || []).filter(
      (member) => member.status === 'active'
    );
    const onlineMemberCount = relayConnected
      ? activeMembers.filter(
          (member) =>
            member.deviceId === profile.deviceId || onlinePeerIds.includes(member.deviceId)
        ).length
      : 0;
    const totalMemberCount = activeMembers.length;
    const groupPresenceLabel = relayConnected
      ? totalMemberCount > 0
        ? `${onlineMemberCount}/${totalMemberCount} ${
          totalMemberCount === 1 ? 'participante online' : 'participantes online'
        }`
        : 'Sincronizando participantes...'
      : 'Relay offline';

    return (
      <div
        key={group.groupId}
        role="button"
        tabIndex={0}
        className={`conversation-item group ${selectedConversationId === conversationId ? 'active' : ''}`}
        onClick={() => onSelectConversation(conversationId)}
        onKeyDown={(event) => handleConversationKeyDown(event, conversationId)}
        onContextMenu={(event) => openContextMenu(event, conversationId)}
      >
        <div className="conversation-meta">
          <div className="avatar-presence-wrap">
            <Avatar emoji={group.emoji} bg={group.avatarBg} size={36} />
            <span className={`presence-dot ${relayConnected ? 'online' : 'offline'}`} />
          </div>
          <div className="conversation-text">
            <Text weight="semibold">{group.name}</Text>
            <div className="conversation-submeta">
              <Caption1 className="conversation-status-line">
                <span className={`conversation-status-pill ${relayConnected ? 'online' : 'offline'}`}>
                  {groupPresenceLabel}
                </span>
              </Caption1>
              <Caption1 className="conversation-preview conversation-preview-slot">
                <span className="conversation-preview-text">{previewText}</span>
              </Caption1>
            </div>
          </div>
        </div>
        {unread > 0 && (
          <Badge appearance="filled" color="danger">
            {unread}
          </Badge>
        )}
      </div>
    );
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
              onClick={toggleQuickStatusMenu}
            />
            {quickStatusOpen && (
              <div
                className={`quick-status-menu ${quickStatusClosing ? 'closing' : 'open'}`}
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
                        closeQuickStatusMenu();
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
                      closeQuickStatusMenu();
                    }}
                  >
                    Aplicar
                  </Button>
                </div>
                <div className="quick-status-dnd">
                  <div className="quick-status-dnd-title">
                    <WeatherMoon20Regular />
                    <span>Não perturbe</span>
                    <span className={`quick-status-dnd-badge ${activeDoNotDisturbUntil > Date.now() ? 'active' : ''}`}>
                      {activeDoNotDisturbUntil > Date.now() ? 'Ativo' : 'Desativado'}
                    </span>
                  </div>
                  <div className="quick-status-dnd-actions">
                    <button type="button" onClick={() => setDoNotDisturbFor(15 * 60 * 1000)}>
                      15 min
                    </button>
                    <button type="button" onClick={() => setDoNotDisturbFor(60 * 60 * 1000)}>
                      1h
                    </button>
                    <button type="button" onClick={setDoNotDisturbUntilTomorrow}>
                      Até amanhã
                    </button>
                    {activeDoNotDisturbUntil > Date.now() && (
                      <button type="button" onClick={() => void onDoNotDisturbUntilChange(0)}>
                        Desativar
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
          <Button appearance="subtle" icon={<Settings20Regular />} onClick={onOpenSettings} />
          <Button appearance="subtle" icon={<SignOut20Regular />} aria-label="Sair da conta" title="Sair da conta" onClick={() => void onLogout()} />
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
          <Badge appearance="filled" color="danger">
            {unreadByConversation.announcements}
          </Badge>
        )}
      </button>

      {(groups.length > 0 || search.trim().length === 0) && (
        <div className="sidebar-groups-section">
          <div className="sidebar-section-title">
            <Caption1>Grupos</Caption1>
            <Button
              size="small"
              appearance="subtle"
              icon={<Add20Regular />}
              onClick={() => setCreateGroupOpen(true)}
            >
              Novo
            </Button>
          </div>
          <div className="groups-list">
            {filteredGroups.map((group) => renderGroupItem(group))}
            {filteredGroups.length === 0 && groups.length > 0 && (
              <Caption1 className="archived-conversations-empty">
                Nenhum grupo corresponde à pesquisa.
              </Caption1>
            )}
            {groups.length === 0 && (
              <button
                type="button"
                className="archived-conversations-toggle create-group-empty"
                onClick={() => setCreateGroupOpen(true)}
              >
                <span className="archived-conversations-label">
                  <PeopleTeam20Regular />
                  <span>Criar primeiro grupo</span>
                </span>
                <Add20Regular />
              </button>
            )}
          </div>
        </div>
      )}

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
        {visiblePeers.map((peer) => renderConversationItem(peer))}
        {contactBottomSpacerHeight > 0 && (
          <div style={{ height: contactBottomSpacerHeight }} aria-hidden />
        )}
        {totalArchivedCount > 0 && (
          <div className="archived-conversations-block">
            <button
              type="button"
              className={`archived-conversations-toggle ${archivedOpen ? 'open' : ''}`}
              onClick={() => setArchivedOpen((current) => !current)}
              aria-expanded={archivedOpen}
            >
              <span className="archived-conversations-label">
                <Box20Regular />
                <span>Arquivadas</span>
              </span>
              <span className="archived-conversations-meta">
                <span>{totalArchivedCount}</span>
                {archivedUnreadCount > 0 && (
                  <Badge appearance="filled" color="danger">
                    {archivedUnreadCount}
                  </Badge>
                )}
                {archivedOpen ? <ChevronUp20Regular /> : <ChevronDown20Regular />}
              </span>
            </button>
            {archivedOpen && (
              <div className="archived-conversations-list">
                {archivedPeers.length > 0 ? (
                  archivedPeers.map((peer) => renderConversationItem(peer, true))
                ) : (
                  <Caption1 className="archived-conversations-empty">
                    Nenhuma conversa arquivada corresponde à pesquisa.
                  </Caption1>
                )}
              </div>
            )}
          </div>
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
          {contextGroup && (
            <button
              type="button"
              className="chat-context-item"
              onClick={() => {
                onSelectConversation(contextMenu.conversationId);
                onOpenGroupDetails(contextGroup.groupId);
                setContextMenu(null);
              }}
            >
              <span className="menu-item-icon">
                <PeopleTeam20Regular />
              </span>
              <span>Detalhes do grupo</span>
            </button>
          )}
          {contextGroup && (
            <button
              type="button"
              className="chat-context-item"
              onClick={() => {
                onSelectConversation(contextMenu.conversationId);
                void onResyncConversation(contextMenu.conversationId);
                setContextMenu(null);
              }}
            >
              <span className="menu-item-icon">
                <ArrowSync20Regular />
              </span>
              <span>Reparar cache do grupo</span>
            </button>
          )}
          {contextMenu.conversationId.startsWith('dm:') &&
            !isConversationArchived(contextMenu.conversationId) && (
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
          {contextMenu.conversationId.startsWith('dm:') && (
            <button
              type="button"
              className="chat-context-item"
              onClick={() => {
                const conversationId = contextMenu.conversationId;
                if (isConversationArchived(conversationId)) {
                  void onUnarchiveConversation(conversationId);
                } else {
                  void onArchiveConversation(conversationId);
                }
                setContextMenu(null);
              }}
            >
              <span className="menu-item-icon">
                {isConversationArchived(contextMenu.conversationId) ? (
                  <ArchiveArrowBack20Regular />
                ) : (
                  <Box20Regular />
                )}
              </span>
              <span>
                {isConversationArchived(contextMenu.conversationId)
                  ? 'Desarquivar conversa'
                  : 'Arquivar conversa'}
              </span>
            </button>
          )}
          <button
            type="button"
            className="chat-context-item"
            onClick={() => {
              void onMarkConversationUnread(contextMenu.conversationId);
              setContextMenu(null);
            }}
          >
            <span className="menu-item-icon">
              <MailUnread20Regular />
            </span>
            <span>Marcar como não lida</span>
          </button>
          {contextMenu.conversationId.startsWith('dm:') && <button
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
            <span>Limpar conversa para mim</span>
          </button>}
          {contextGroup && (
            <button
              type="button"
              className="chat-context-item danger"
              onClick={() => {
                setPendingLeaveGroupId(contextGroup.groupId);
                setContextMenu(null);
              }}
            >
              <span className="menu-item-icon">
                <Dismiss20Regular />
              </span>
              <span>Sair do grupo</span>
            </button>
          )}
          {contextGroup && canDeleteContextGroup && (
            <button
              type="button"
              className="chat-context-item danger"
              onClick={() => {
                setPendingDeleteGroupId(contextGroup.groupId);
                setContextMenu(null);
              }}
            >
              <span className="menu-item-icon">
                <Delete20Regular />
              </span>
              <span>Excluir grupo</span>
            </button>
          )}
        </div>
      )}

      <CreateGroupDialog
        open={createGroupOpen}
        peers={peers}
        onlinePeerIds={onlinePeerIds}
        onClose={() => setCreateGroupOpen(false)}
        onCreate={onCreateGroup}
      />

      <ConfirmDialog
        open={Boolean(pendingClearConversationId)}
        title="Limpar conversa para mim"
        description="O histórico anterior será ocultado para a sua conta. A outra pessoa continuará com a conversa."
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
        open={Boolean(pendingLeaveGroupId)}
        title="Sair do grupo"
        description="Você deixará de receber novas mensagens deste grupo. Se você for o dono, transfira a propriedade para um administrador antes de sair."
        confirmLabel="Sair"
        onCancel={() => setPendingLeaveGroupId(null)}
        onConfirm={() => {
          if (pendingLeaveGroupId) {
            void onLeaveGroup(pendingLeaveGroupId);
          }
          setPendingLeaveGroupId(null);
        }}
      />
      <ConfirmDialog
        open={Boolean(pendingDeleteGroupId)}
        title="Excluir grupo"
        description="Esta ação exclui o grupo para todos os participantes e não pode ser desfeita."
        confirmLabel="Excluir"
        onCancel={() => setPendingDeleteGroupId(null)}
        onConfirm={() => {
          if (pendingDeleteGroupId) {
            void onDeleteGroup(pendingDeleteGroupId);
          }
          setPendingDeleteGroupId(null);
        }}
      />
    </aside>
  );
};
