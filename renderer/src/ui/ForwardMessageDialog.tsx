import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Text
} from '@fluentui/react-components';
import { useEffect, useMemo, useState } from 'react';
import { MessageRow, Peer } from '../api/ipcClient';
import { Avatar } from './Avatar';

interface ForwardMessageDialogProps {
  open: boolean;
  sourceMessage: MessageRow | null;
  contacts: Peer[];
  onlinePeerIds: string[];
  onCancel: () => void;
  onConfirm: (targetPeerIds: string[]) => Promise<void>;
}

const buildSourcePreview = (message: MessageRow | null): string => {
  if (!message) return '';
  if (message.type === 'file') {
    return `📎 ${message.fileName || 'Arquivo'}`;
  }
  if (message.type === 'announcement') {
    const text = (message.bodyText || '').trim();
    return text ? `📢 ${text}` : '📢 Anúncio';
  }
  return (message.bodyText || '').trim();
};

export const ForwardMessageDialog = ({
  open,
  sourceMessage,
  contacts,
  onlinePeerIds,
  onCancel,
  onConfirm
}: ForwardMessageDialogProps) => {
  const [search, setSearch] = useState('');
  const [selectedPeerIds, setSelectedPeerIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const normalizedSearch = search.trim().toLowerCase();
  const onlinePeerIdSet = useMemo(() => new Set(onlinePeerIds), [onlinePeerIds]);
  const sortedContacts = useMemo(
    () =>
      [...contacts].sort((a, b) => {
        const aOnline = onlinePeerIdSet.has(a.deviceId);
        const bOnline = onlinePeerIdSet.has(b.deviceId);
        if (aOnline !== bOnline) {
          return aOnline ? -1 : 1;
        }
        return a.displayName.localeCompare(b.displayName, 'pt-BR');
      }),
    [contacts, onlinePeerIdSet]
  );
  const filteredContacts = useMemo(
    () =>
      sortedContacts.filter((peer) => {
        if (!normalizedSearch) return true;
        const haystack = `${peer.displayName} ${peer.statusMessage}`.toLowerCase();
        return haystack.includes(normalizedSearch);
      }),
    [sortedContacts, normalizedSearch]
  );
  const visibleIds = useMemo(() => new Set(filteredContacts.map((peer) => peer.deviceId)), [filteredContacts]);
  const selectedVisibleCount = selectedPeerIds.filter((id) => visibleIds.has(id)).length;
  const canSubmit = Boolean(sourceMessage && selectedPeerIds.length > 0 && !submitting);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setSubmitting(false);
    setErrorMessage(null);
    setSelectedPeerIds([]);
  }, [open, sortedContacts]);

  const handleConfirm = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await onConfirm(selectedPeerIds);
      onCancel();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Falha ao encaminhar.');
    } finally {
      setSubmitting(false);
    }
  };

  const togglePeerSelection = (peerId: string): void => {
    setSelectedPeerIds((current) =>
      current.includes(peerId)
        ? current.filter((id) => id !== peerId)
        : [...current, peerId]
    );
  };

  const sourcePreview = buildSourcePreview(sourceMessage);

  return (
    <Dialog open={open} onOpenChange={(_, data) => !data.open && onCancel()}>
      <DialogSurface className="forward-modal">
        <DialogBody>
          <DialogTitle>Encaminhar</DialogTitle>
          <DialogContent>
            <div className="forward-modal-content">
              <Text className="forward-source-preview" title={sourcePreview}>
                {sourcePreview || 'Mensagem sem conteúdo'}
              </Text>
              <Input
                value={search}
                onChange={(_, data) => setSearch(data.value)}
                placeholder="Buscar contato..."
                className="forward-search"
              />
              <Text className="forward-selection-count">
                {selectedPeerIds.length} selecionado(s)
                {search.trim().length > 0 ? ` • ${selectedVisibleCount} visível(is)` : ''}
              </Text>
              <div className="forward-contact-list" role="listbox" aria-label="Contatos para encaminhar">
                {filteredContacts.length === 0 && (
                  <div className="forward-empty">Nenhum contato encontrado.</div>
                )}
                {filteredContacts.map((peer) => (
                  <button
                    key={peer.deviceId}
                    type="button"
                    className={`forward-contact-item ${selectedPeerIds.includes(peer.deviceId) ? 'selected' : ''}`}
                    onClick={() => togglePeerSelection(peer.deviceId)}
                  >
                    <Avatar emoji={peer.avatarEmoji} bg={peer.avatarBg} size={26} />
                    <span className="forward-contact-meta">
                      <span className="forward-contact-name">{peer.displayName}</span>
                      <span className="forward-contact-status">
                        <span
                          className={`forward-contact-presence-dot ${
                            onlinePeerIdSet.has(peer.deviceId) ? 'online' : 'offline'
                          }`}
                        />
                        <span>{onlinePeerIdSet.has(peer.deviceId) ? 'Online' : 'Offline'}</span>
                        {peer.statusMessage ? <span>· {peer.statusMessage}</span> : null}
                      </span>
                    </span>
                    <span className={`forward-contact-check ${selectedPeerIds.includes(peer.deviceId) ? 'selected' : ''}`}>
                      {selectedPeerIds.includes(peer.deviceId) ? '✓' : ''}
                    </span>
                  </button>
                ))}
              </div>
              {errorMessage && <Text className="forward-error">{errorMessage}</Text>}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onCancel} disabled={submitting}>
              Cancelar
            </Button>
            <Button appearance="primary" onClick={() => void handleConfirm()} disabled={!canSubmit}>
              Encaminhar
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
