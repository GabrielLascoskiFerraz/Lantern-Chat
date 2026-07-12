import { Button, Spinner, Text } from '@fluentui/react-components';
import { Component, ErrorInfo, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ipcClient } from '../api/ipcClient';
import { useLanternStore } from '../state/store';
import { AnnouncementsView } from './AnnouncementsView';
import { ChatView } from './ChatView';
import { GroupDetailsModal } from './GroupDetailsModal';
import { SettingsModal } from './SettingsModal';
import { Sidebar } from './Sidebar';

const ANNOUNCEMENTS_ID = 'announcements';

class PaneErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Lantern] erro ao renderizar painel da conversa:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="main-pane empty-chat-pane">
          <div className="empty-chat-card">
            <Text weight="semibold" size={500}>
              Não foi possível abrir esta conversa
            </Text>
            <Text size={300}>
              O Lantern isolou o erro para manter a interface ativa. Tente abrir outra conversa ou recarregar.
            </Text>
            <Button appearance="primary" onClick={() => this.setState({ error: null })}>
              Tentar novamente
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

const PaneLayer = ({
  conversationId,
  renderPane
}: {
  conversationId: string;
  renderPane: (conversationId: string) => ReactNode;
}) => (
  <div className="pane-layer is-entering">
    {renderPane(conversationId)}
  </div>
);

export const Shell = () => {
  const {
    ready,
    startupError,
    profile,
    relaySettings,
    startupSettings,
    peers,
    groups,
    groupMembersById,
    groupPinnedMessageIdsById,
    onlinePeerIds,
    search,
    setSearch,
    logout,
    selectedConversationId,
    selectConversation,
    closeConversation,
    messagesByConversation,
    hasMoreHistoryByConversation,
    loadingOlderByConversation,
    announcementReactionsByMessage,
    announcementReadsByMessage,
    favoriteByMessageId,
    archivedConversationIds,
    conversationPreviewById,
    recentMessageIds,
    unreadByConversation,
    openedUnreadCountByConversation,
    unreadAnchorMessageIdByConversation,
    typingByConversation,
    sendText,
    sendGroupText,
    sendTyping,
    sendAnnouncement,
    sendFile,
    sendGroupFile,
    forwardMessageToPeer,
    editMessage,
    reactToMessage,
    toggleMessageFavorite,
    getFavoriteMessages,
    deleteMessageForEveryone,
    deleteMessageForMe,
    exportConversation,
    resyncConversation,
    markConversationUnread,
    archiveConversation,
    unarchiveConversation,
    clearConversation,
    forgetContactConversation,
    createGroup,
    updateGroup,
    addGroupMembers,
    removeGroupMember,
    setGroupMemberRole,
    transferGroupOwnership,
    deleteGroup,
    leaveGroup,
    setGroupMessagePinned,
    openFile,
    saveFileAs,
    settingsOpen,
    setSettingsOpen,
    updateProfile,
    updateStartupSettings,
    transfers,
    toasts,
    dismissToast,
    themeMode,
    setThemeMode,
    syncActive,
    loadingConversationId,
    loadInitial,
    loadOlderMessages,
    ensureConversationMessagesLoaded
  } = useLanternStore();
  const [groupDetailsOpenId, setGroupDetailsOpenId] = useState<string | null>(null);

  const transferMap = useMemo(() => {
    const map: Record<string, { transferred: number; total: number }> = {};
    for (const transfer of Object.values(transfers)) {
      map[transfer.fileId] = {
        transferred: transfer.transferred,
        total: transfer.total
      };
    }
    return map;
  }, [transfers]);

  const searchMessageIds = useCallback(
    async (conversationId: string, query: string) => {
      const normalized = query.trim();
      if (!normalized) return [];
      const pageSize = 500;
      const maxResults = 20_000;
      const collected: string[] = [];
      let offset = 0;

      while (offset < maxResults) {
        const chunk = await ipcClient.searchConversationMessageIds(
          conversationId,
          normalized,
          pageSize,
          offset
        );
        if (chunk.length === 0) break;
        collected.push(...chunk);
        if (chunk.length < pageSize) break;
        offset += chunk.length;
      }

      return Array.from(new Set(collected));
    },
    []
  );

  const renderConversationPane = (conversationId: string) => {
    if (!profile) return null;

    if (!conversationId) {
      return (
        <div className="main-pane empty-chat-pane">
          <div className="empty-chat-card">
            <Text weight="semibold" size={500}>Nenhuma conversa aberta</Text>
            <Text size={300}>Selecione uma conversa, grupo ou anúncio na sidebar.</Text>
          </div>
        </div>
      );
    }

    const isAnnouncements = conversationId === ANNOUNCEMENTS_ID;
    const conversationMessages = messagesByConversation[conversationId] || [];
    const hasMoreHistory = Boolean(hasMoreHistoryByConversation[conversationId]);
    const loadingOlderHistory = Boolean(loadingOlderByConversation[conversationId]);

    if (isAnnouncements) {
      return (
        <AnnouncementsView
          messages={conversationMessages}
          loading={loadingConversationId === ANNOUNCEMENTS_ID}
          profile={profile}
          peers={peers}
          forwardTargets={peers}
          onlinePeerIds={onlinePeerIds}
          reactionsByMessageId={announcementReactionsByMessage}
          readsByMessageId={announcementReadsByMessage}
          onSend={(text, replyTo) => sendAnnouncement(text, replyTo)}
          onEditMessage={(messageId, text) => editMessage(ANNOUNCEMENTS_ID, messageId, text)}
          relayConnected={Boolean(relaySettings?.connected)}
          onForwardMessage={async (targetPeerIds, sourceMessageId) => {
            for (const targetPeerId of targetPeerIds) {
              await forwardMessageToPeer(targetPeerId, sourceMessageId);
            }
          }}
          onReactToMessage={(messageId, reaction) =>
            reactToMessage(ANNOUNCEMENTS_ID, messageId, reaction)
          }
          onDeleteMessage={(messageId) =>
            deleteMessageForEveryone(ANNOUNCEMENTS_ID, messageId)
          }
          recentMessageIds={recentMessageIds}
        />
      );
    }

    const groupId = conversationId.startsWith('group:') ? conversationId.replace('group:', '') : '';
    const group = groupId ? groups.find((candidate) => candidate.groupId === groupId) || null : null;
    const groupMembers = group ? groupMembersById[group.groupId] || [] : [];
    const peerId = conversationId.startsWith('dm:') ? conversationId.replace('dm:', '') : '';
    const peer =
      group
        ? {
            deviceId: group.groupId,
            displayName: group.name,
            avatarEmoji: group.emoji,
            avatarBg: group.avatarBg,
            statusMessage: group.description || 'Grupo',
            address: '',
            port: 0,
            appVersion: 'group',
            lastSeenAt: group.updatedAt,
            source: 'relay' as const
          }
        : peers.find((candidate) => candidate.deviceId === peerId) || null;
    const peerOnline = group ? Boolean(relaySettings?.connected) : peer ? onlinePeerIds.includes(peer.deviceId) : false;
    const forwardTargets = peers.filter((candidate) => candidate.deviceId !== peerId);
    const peerById = new Map(peers.map((candidate) => [candidate.deviceId, candidate]));
    const senderProfilesById = Object.fromEntries(
      groupMembers
        .filter((member) => typeof member.deviceId === 'string' && member.deviceId.length > 0)
        .map((member) => {
          const memberDeviceId = member.deviceId;
          const knownPeer = peerById.get(memberDeviceId);
          return [
            memberDeviceId,
            {
              displayName:
                memberDeviceId === profile.deviceId
                  ? profile.displayName
                  : knownPeer?.displayName ||
                    member.displayNameSnapshot ||
                    `Participante ${memberDeviceId.slice(0, 6)}`,
              avatarEmoji:
                memberDeviceId === profile.deviceId
                  ? profile.avatarEmoji
                  : knownPeer?.avatarEmoji || member.avatarEmojiSnapshot || '🙂',
              avatarBg:
                memberDeviceId === profile.deviceId
                  ? profile.avatarBg
                  : knownPeer?.avatarBg || member.avatarBgSnapshot || '#6b7280'
            }
          ];
        })
    );

    return (
      <ChatView
        conversationId={conversationId}
        peer={peer}
        isGroup={Boolean(group)}
        groupMemberCount={groupMembers.filter((member) => member.status === 'active').length}
        groupDescription={group?.description || ''}
        groupUnavailable={Boolean(group?.missingOnRelay)}
        groupPinnedMessageIds={group ? groupPinnedMessageIdsById[group.groupId] || [] : []}
        senderProfilesById={senderProfilesById}
        peerOnline={peerOnline}
        forwardTargets={forwardTargets}
        onlinePeerIds={onlinePeerIds}
        peerTyping={Boolean(typingByConversation[conversationId])}
        loading={loadingConversationId === conversationId}
        localProfile={profile}
        messages={conversationMessages}
        reactionsByMessageId={announcementReactionsByMessage}
        favoriteByMessageId={favoriteByMessageId}
        transferByFileId={transferMap}
        hasMoreOlder={hasMoreHistory}
        loadingOlder={loadingOlderHistory}
        onSend={(text, replyTo) =>
          group?.missingOnRelay
            ? Promise.resolve()
            : group
            ? sendGroupText(group.groupId, text, replyTo)
            : peer
            ? sendText(peer.deviceId, text, replyTo)
            : Promise.resolve()
        }
        onTyping={(isTyping) =>
          group
            ? Promise.resolve()
            : peer
            ? sendTyping(peer.deviceId, isTyping)
            : Promise.resolve()
        }
        onSendFile={(filePath, replyTo) =>
          group?.missingOnRelay
            ? Promise.resolve()
            : group
            ? sendGroupFile(group.groupId, filePath, replyTo)
            : peer
            ? sendFile(peer.deviceId, filePath, replyTo)
            : Promise.resolve()
        }
        onForwardMessage={async (targetPeerIds, sourceMessageId) => {
          for (const targetPeerId of targetPeerIds) {
            await forwardMessageToPeer(targetPeerId, sourceMessageId);
          }
        }}
        onReactToMessage={(messageId, reaction) =>
          reactToMessage(conversationId, messageId, reaction)
        }
        onEditMessage={(messageId, text) => editMessage(conversationId, messageId, text)}
        onToggleFavoriteMessage={(messageId, favorite) =>
          toggleMessageFavorite(conversationId, messageId, favorite)
        }
        onSetGroupMessagePinned={
          group
            ? (messageId, pinned) => setGroupMessagePinned(group.groupId, messageId, pinned)
            : undefined
        }
        onOpenGroupDetails={
          group ? () => setGroupDetailsOpenId(group.groupId) : undefined
        }
        onGetFavoriteMessages={getFavoriteMessages}
        onDeleteMessage={(messageId) =>
          deleteMessageForEveryone(conversationId, messageId)
        }
        onDeleteMessageForMe={(messageId) =>
          deleteMessageForMe(conversationId, messageId)
        }
        onExportConversation={(format) => exportConversation(conversationId, format)}
        onResyncConversation={() => resyncConversation(conversationId)}
        onClearConversation={() => clearConversation(conversationId)}
        onForgetContactConversation={() => forgetContactConversation(conversationId)}
        onOpenFile={openFile}
        onSaveFileAs={saveFileAs}
        recentMessageIds={recentMessageIds}
        unreadAtOpen={openedUnreadCountByConversation[conversationId] || 0}
        unreadAnchorMessageId={unreadAnchorMessageIdByConversation[conversationId] || null}
        onSearchMessageIds={(query) => searchMessageIds(conversationId, query)}
        onLoadOlderMessages={() => loadOlderMessages(conversationId)}
        onEnsureMessagesLoaded={(messageIds) =>
          ensureConversationMessagesLoaded(conversationId, messageIds)
        }
      />
    );
  };

  const groupDetailsGroup =
    groupDetailsOpenId
      ? groups.find((group) => group.groupId === groupDetailsOpenId) || null
      : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest('[role="dialog"]') ||
        target?.closest('.chat-context-menu') ||
        target?.closest('.reaction-picker')
      ) {
        return;
      }
      if (selectedConversationId) {
        void closeConversation();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeConversation, selectedConversationId]);

  if (!ready) {
    return (
      <div className="loading-screen">
        <Spinner size="large" />
      </div>
    );
  }

  if (startupError || !profile) {
    return (
      <div className="loading-screen loading-screen-error">
        <div className="startup-error-card">
          <Text weight="semibold" size={500}>
            Não foi possível carregar o Lantern
          </Text>
          <Text size={300}>
            {startupError || 'O perfil local ainda não está disponível.'}
          </Text>
          <Text size={200} className="startup-error-help">
            A conexão com o Relay não deve bloquear a abertura do app. Tente recarregar o estado local.
          </Text>
          <div className="startup-error-actions">
            <Button appearance="primary" onClick={() => void loadInitial()}>
              Tentar novamente
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <Sidebar
        profile={profile}
        peers={peers}
        groups={groups}
        groupMembersById={groupMembersById}
        search={search}
        selectedConversationId={selectedConversationId}
        unreadByConversation={unreadByConversation}
        conversationPreviewById={conversationPreviewById}
        typingByConversation={typingByConversation}
        archivedConversationIds={archivedConversationIds}
        onlinePeerIds={onlinePeerIds}
        onSearch={setSearch}
        onSelectConversation={(id) => void selectConversation(id)}
        onMarkConversationUnread={markConversationUnread}
        onArchiveConversation={archiveConversation}
        onUnarchiveConversation={unarchiveConversation}
        onClearConversation={clearConversation}
        onForgetContactConversation={forgetContactConversation}
        onResyncConversation={resyncConversation}
        onOpenGroupDetails={(groupId) => setGroupDetailsOpenId(groupId)}
        onLeaveGroup={leaveGroup}
        onDeleteGroup={deleteGroup}
        onCreateGroup={createGroup}
        onOpenSettings={() => setSettingsOpen(true)}
        onLogout={logout}
        onQuickStatusChange={async (statusMessage) => {
          await updateProfile({
            displayName: profile.displayName,
            avatarEmoji: profile.avatarEmoji,
            avatarBg: profile.avatarBg,
            statusMessage
          });
        }}
        startupSettings={startupSettings}
        onDoNotDisturbUntilChange={async (doNotDisturbUntil) => {
          if (!startupSettings) return;
          await updateStartupSettings({
            openAtLogin: startupSettings.openAtLogin,
            downloadsDir: startupSettings.downloadsDir,
            doNotDisturbUntil
          });
        }}
        themeMode={themeMode}
        onThemeModeChange={setThemeMode}
        relayConnected={Boolean(relaySettings?.connected)}
        relayEndpoint={relaySettings?.endpoint || null}
        syncActive={syncActive}
      />

      <div className="pane-switcher">
        <PaneErrorBoundary key={selectedConversationId || 'empty'}>
          <PaneLayer conversationId={selectedConversationId} renderPane={renderConversationPane} />
        </PaneErrorBoundary>
      </div>

      <GroupDetailsModal
        open={Boolean(groupDetailsGroup)}
        group={groupDetailsGroup}
        members={groupDetailsGroup ? groupMembersById[groupDetailsGroup.groupId] || [] : []}
        peers={peers}
        onlinePeerIds={onlinePeerIds}
        localProfile={profile}
        onClose={() => setGroupDetailsOpenId(null)}
        onUpdateGroup={updateGroup}
        onAddMembers={addGroupMembers}
        onRemoveMember={removeGroupMember}
        onSetMemberRole={setGroupMemberRole}
        onTransferOwnership={transferGroupOwnership}
        onDeleteGroup={deleteGroup}
        onLeaveGroup={leaveGroup}
      />

      <SettingsModal
        open={settingsOpen}
        profile={profile}
        startupSettings={startupSettings}
        onClose={() => setSettingsOpen(false)}
        onSave={async (payload) => {
          await updateProfile(payload.profile);
          await updateStartupSettings(payload.startup);
          setSettingsOpen(false);
        }}
      />
      <div className="toast-layer">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast-item ${toast.level}`}
            role="status"
            onClick={() => dismissToast(toast.id)}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
};
