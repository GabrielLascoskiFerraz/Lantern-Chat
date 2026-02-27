import { Spinner } from '@fluentui/react-components';
import { useCallback, useMemo } from 'react';
import { ipcClient } from '../api/ipcClient';
import { useLanternStore } from '../state/store';
import { AnnouncementsView } from './AnnouncementsView';
import { ChatView } from './ChatView';
import { SettingsModal } from './SettingsModal';
import { Sidebar } from './Sidebar';

const ANNOUNCEMENTS_ID = 'announcements';

export const Shell = () => {
  const {
    ready,
    profile,
    relaySettings,
    startupSettings,
    peers,
    onlinePeerIds,
    search,
    setSearch,
    selectedConversationId,
    selectConversation,
    messagesByConversation,
    hasMoreHistoryByConversation,
    loadingOlderByConversation,
    announcementReactionsByMessage,
    conversationPreviewById,
    recentMessageIds,
    unreadByConversation,
    typingByConversation,
    sendText,
    sendTyping,
    sendAnnouncement,
    sendFile,
    reactToMessage,
    deleteMessageForEveryone,
    markConversationUnread,
    clearConversation,
    forgetContactConversation,
    openFile,
    saveFileAs,
    settingsOpen,
    setSettingsOpen,
    updateProfile,
    updateRelaySettings,
    updateStartupSettings,
    transfers,
    toasts,
    dismissToast,
    themeMode,
    setThemeMode,
    syncActive,
    loadingConversationId,
    loadOlderMessages,
    ensureConversationMessagesLoaded
  } = useLanternStore();

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
    }
  );

  const renderConversationPane = (conversationId: string) => {
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
          reactionsByMessageId={announcementReactionsByMessage}
          onSend={sendAnnouncement}
          relayConnected={Boolean(relaySettings?.connected)}
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

    const peerId = conversationId.startsWith('dm:') ? conversationId.replace('dm:', '') : '';
    const peer = peers.find((candidate) => candidate.deviceId === peerId) || null;
    const peerOnline = peer ? onlinePeerIds.includes(peer.deviceId) : false;

    return (
      <ChatView
        conversationId={conversationId}
        peer={peer}
        peerOnline={peerOnline}
        peerTyping={Boolean(typingByConversation[conversationId])}
        loading={loadingConversationId === conversationId}
        localProfile={profile}
        messages={conversationMessages}
        reactionsByMessageId={announcementReactionsByMessage}
        transferByFileId={transferMap}
        hasMoreOlder={hasMoreHistory}
        loadingOlder={loadingOlderHistory}
        onSend={(text) =>
          peer ? sendText(peer.deviceId, text) : Promise.resolve()
        }
        onTyping={(isTyping) =>
          peer
            ? sendTyping(peer.deviceId, isTyping)
            : Promise.resolve()
        }
        onSendFile={(filePath) =>
          peer
            ? sendFile(peer.deviceId, filePath)
            : Promise.resolve()
        }
        onReactToMessage={(messageId, reaction) =>
          reactToMessage(conversationId, messageId, reaction)
        }
        onDeleteMessage={(messageId) =>
          deleteMessageForEveryone(conversationId, messageId)
        }
        onClearConversation={() => clearConversation(conversationId)}
        onForgetContactConversation={() => forgetContactConversation(conversationId)}
        onOpenFile={openFile}
        onSaveFileAs={saveFileAs}
        recentMessageIds={recentMessageIds}
        onSearchMessageIds={(query) => searchMessageIds(conversationId, query)}
        onLoadOlderMessages={() => loadOlderMessages(conversationId)}
        onEnsureMessagesLoaded={(messageIds) =>
          ensureConversationMessagesLoaded(conversationId, messageIds)
        }
      />
    );
  };

  if (!ready || !profile) {
    return (
      <div className="loading-screen">
        <Spinner size="large" />
      </div>
    );
  }

  return (
    <div className="shell">
      <Sidebar
        profile={profile}
        peers={peers}
        search={search}
        selectedConversationId={selectedConversationId}
        unreadByConversation={unreadByConversation}
        conversationPreviewById={conversationPreviewById}
        typingByConversation={typingByConversation}
        onlinePeerIds={onlinePeerIds}
        onSearch={setSearch}
        onSelectConversation={(id) => void selectConversation(id)}
        onMarkConversationUnread={markConversationUnread}
        onClearConversation={clearConversation}
        onForgetContactConversation={forgetContactConversation}
        onOpenSettings={() => setSettingsOpen(true)}
        onQuickStatusChange={async (statusMessage) => {
          await updateProfile({
            displayName: profile.displayName,
            avatarEmoji: profile.avatarEmoji,
            avatarBg: profile.avatarBg,
            statusMessage
          });
        }}
        themeMode={themeMode}
        onThemeModeChange={setThemeMode}
        relayConnected={Boolean(relaySettings?.connected)}
        relayEndpoint={relaySettings?.endpoint || null}
        syncActive={syncActive}
      />

      <div className="pane-switcher">
        <div key={selectedConversationId} className="pane-layer is-entering">
          {renderConversationPane(selectedConversationId)}
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        profile={profile}
        relaySettings={relaySettings}
        startupSettings={startupSettings}
        onClose={() => setSettingsOpen(false)}
        onSave={async (payload) => {
          await updateProfile(payload.profile);
          await updateRelaySettings(payload.relay);
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
