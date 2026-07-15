import type { MessageRow } from '../api/ipcClient';

const statusRank: Record<string, number> = {
  failed: -1,
  sent: 1,
  delivered: 2,
  read: 3
};

const mergeOne = (snapshot: MessageRow, live: MessageRow): MessageRow => {
  const liveHasNewerEdit = (live.editedAt || 0) > (snapshot.editedAt || 0);
  const liveStatusIsNewer =
    (statusRank[live.status || ''] || 0) > (statusRank[snapshot.status || ''] || 0);
  return {
    ...snapshot,
    ...(liveHasNewerEdit
      ? { bodyText: live.bodyText, editedAt: live.editedAt }
      : {}),
    filePath: live.filePath || snapshot.filePath,
    fileSha256: live.fileSha256 || snapshot.fileSha256,
    fileSize: live.fileSize ?? snapshot.fileSize,
    status: live.filePath || liveStatusIsNewer ? live.status : snapshot.status
  };
};

export const mergeFetchedMessagesWithLiveUpdates = (
  fetched: MessageRow[],
  baseline: MessageRow[],
  live: MessageRow[]
): MessageRow[] => {
  const baselineIds = new Set(baseline.map((message) => message.messageId));
  const liveById = new Map(live.map((message) => [message.messageId, message]));
  const result: MessageRow[] = [];
  const resultIds = new Set<string>();

  for (const message of fetched) {
    const current = liveById.get(message.messageId);
    // Existia quando a seleção começou e desapareceu durante o carregamento:
    // uma remoção ao vivo não pode ser ressuscitada pelo snapshot antigo.
    if (baselineIds.has(message.messageId) && !current) continue;
    const merged = current ? mergeOne(message, current) : message;
    result.push(merged);
    resultIds.add(merged.messageId);
  }

  // Preserva mensagens que chegaram pelo canal ao vivo enquanto o histórico
  // estava em trânsito e ainda não faziam parte do snapshot retornado.
  for (const message of live) {
    if (!resultIds.has(message.messageId) && !baselineIds.has(message.messageId)) {
      result.push(message);
    }
  }

  return result.sort(
    (left, right) => left.createdAt - right.createdAt || left.messageId.localeCompare(right.messageId)
  );
};

export const mergeRepairedConversationPage = (
  fetched: MessageRow[],
  baseline: MessageRow[],
  live: MessageRow[]
): MessageRow[] => {
  const refreshedPage = mergeFetchedMessagesWithLiveUpdates(fetched, baseline, live);
  const byId = new Map(live.map((message) => [message.messageId, message]));
  for (const message of refreshedPage) {
    byId.set(message.messageId, message);
  }
  return Array.from(byId.values()).sort(
    (left, right) => left.createdAt - right.createdAt || left.messageId.localeCompare(right.messageId)
  );
};
