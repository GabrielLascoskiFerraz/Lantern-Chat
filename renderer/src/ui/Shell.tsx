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
    clearConversation,
    forgetContactConversation,
    openFile,
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
    ensureConversationMessagesLoaded
  } = useLanternStore();

  const selectedPeer = useMemo(() => {
    if (!selectedConversationId.startsWith('dm:')) return null;
    const peerId = selectedConversationId.replace('dm:', '');
    return peers.find((peer) => peer.deviceId === peerId) || null;
  }, [peers, selectedConversationId]);
  const selectedPeerOnline = selectedPeer ? onlinePeerIds.includes(selectedPeer.deviceId) : false;

  const currentMessages = messagesByConversation[selectedConversationId] || [];

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
    (query: string) => ipcClient.searchConversationMessageIds(selectedConversationId, query, 500),
    [selectedConversationId]
  );

  const ensureMessagesLoaded = useCallback(
    (messageIds: string[]) =>
      ensureConversationMessagesLoaded(selectedConversationId, messageIds),
    [ensureConversationMessagesLoaded, selectedConversationId]
  );

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

      {selectedConversationId === ANNOUNCEMENTS_ID ? (
        <AnnouncementsView
          messages={currentMessages}
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
      ) : (
        <ChatView
          conversationId={selectedConversationId}
          peer={selectedPeer}
          peerOnline={selectedPeerOnline}
          peerTyping={Boolean(typingByConversation[selectedConversationId])}
          loading={loadingConversationId === selectedConversationId}
          localProfile={profile}
          messages={currentMessages}
          reactionsByMessageId={announcementReactionsByMessage}
          transferByFileId={transferMap}
          onSend={(text) =>
            selectedPeer ? sendText(selectedPeer.deviceId, text) : Promise.resolve()
          }
          onTyping={(isTyping) =>
            selectedPeer
              ? sendTyping(selectedPeer.deviceId, isTyping)
              : Promise.resolve()
          }
          onSendFile={(filePath) =>
            selectedPeer
              ? sendFile(selectedPeer.deviceId, filePath)
              : Promise.resolve()
          }
          onReactToMessage={(messageId, reaction) =>
            reactToMessage(selectedConversationId, messageId, reaction)
          }
          onDeleteMessage={(messageId) =>
            deleteMessageForEveryone(selectedConversationId, messageId)
          }
          onClearConversation={() => clearConversation(selectedConversationId)}
          onForgetContactConversation={() => forgetContactConversation(selectedConversationId)}
          onOpenFile={openFile}
          recentMessageIds={recentMessageIds}
          onSearchMessageIds={searchMessageIds}
          onEnsureMessagesLoaded={ensureMessagesLoaded}
        />
      )}

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
