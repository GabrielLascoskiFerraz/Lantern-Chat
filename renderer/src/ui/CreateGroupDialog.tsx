import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Caption1,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  SearchBox,
  Spinner,
  Text,
  Textarea
} from '@fluentui/react-components';
import { Dismiss20Regular, PeopleTeam20Regular } from '@fluentui/react-icons';
import { Peer } from '../api/ipcClient';
import { Avatar } from './Avatar';
import { ProfileIdentityEditor } from './ProfileIdentityEditor';
import { isProfileColor } from './profileIdentityOptions';

interface CreateGroupDialogProps {
  open: boolean;
  peers: Peer[];
  onlinePeerIds: string[];
  onClose: () => void;
  onCreate: (input: {
    name: string;
    emoji: string;
    avatarBg: string;
    description: string;
    memberDeviceIds: string[];
  }) => Promise<void>;
}

const normalize = (value: string): string => value
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('pt-BR');

export const CreateGroupDialog = ({ open, peers, onlinePeerIds, onClose, onCreate }: CreateGroupDialogProps) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [emoji, setEmoji] = useState('👥');
  const [avatarBg, setAvatarBg] = useState('#147ad6');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(''); setDescription(''); setEmoji('👥'); setAvatarBg('#147ad6');
    setSelectedIds([]); setQuery(''); setBusy(false); setError('');
  }, [open]);

  const onlineSet = useMemo(() => new Set(onlinePeerIds), [onlinePeerIds]);
  const visiblePeers = useMemo(() => {
    const search = normalize(query.trim());
    return peers
      .filter((peer) => !search || normalize(`${peer.displayName} ${peer.department || ''}`).includes(search))
      .sort((left, right) => {
        const selectedDifference = Number(selectedIds.includes(right.deviceId)) - Number(selectedIds.includes(left.deviceId));
        if (selectedDifference) return selectedDifference;
        const onlineDifference = Number(onlineSet.has(right.deviceId)) - Number(onlineSet.has(left.deviceId));
        return onlineDifference || left.displayName.localeCompare(right.displayName, 'pt-BR', { sensitivity: 'base' });
      });
  }, [onlineSet, peers, query, selectedIds]);

  const close = (): void => { if (!busy) onClose(); };
  const toggleMember = (deviceId: string): void => setSelectedIds((current) =>
    current.includes(deviceId) ? current.filter((id) => id !== deviceId) : [...current, deviceId]
  );
  const submit = async (): Promise<void> => {
    if (!name.trim() || !isProfileColor(avatarBg) || busy) return;
    setBusy(true); setError('');
    try {
      await onCreate({ name: name.trim(), emoji: emoji.trim() || '👥', avatarBg, description: description.trim(), memberDeviceIds: selectedIds });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível criar o grupo.');
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(_, data) => !data.open && close()}>
      <DialogSurface className="create-group-dialog">
        <DialogBody>
          <DialogTitle
            action={<DialogTrigger action="close" disableButtonEnhancement><Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Fechar criação de grupo" disabled={busy} /></DialogTrigger>}
          >
            <span className="create-group-dialog-title"><PeopleTeam20Regular /> Novo grupo</span>
          </DialogTitle>
          <DialogContent className="create-group-content">
            <section className="create-group-basics" aria-labelledby="create-group-basics-title">
              <div className="create-group-preview">
                <Avatar emoji={emoji} bg={avatarBg} size={64} />
                <div><Text id="create-group-basics-title" weight="semibold" size={400}>{name.trim() || 'Nome do grupo'}</Text><Caption1>{selectedIds.length ? `${selectedIds.length} pessoa${selectedIds.length === 1 ? '' : 's'} convidada${selectedIds.length === 1 ? '' : 's'}` : 'Somente você por enquanto'}</Caption1></div>
              </div>
              <Field label="Nome do grupo" required validationMessage={!name.trim() && name.length > 0 ? 'Informe um nome para o grupo.' : undefined}>
                <Input autoFocus value={name} maxLength={80} onChange={(_, data) => setName(data.value)} placeholder="Ex.: Equipe comercial" />
              </Field>
              <Field label="Descrição" hint={`${description.length}/240 · opcional`}>
                <Textarea value={description} maxLength={240} resize="vertical" onChange={(_, data) => setDescription(data.value)} placeholder="Qual é o objetivo deste grupo?" />
              </Field>
            </section>

            <section className="create-group-identity-card">
              <ProfileIdentityEditor emoji={emoji} color={avatarBg} onEmojiChange={setEmoji} onColorChange={setAvatarBg} compact ariaLabel="Aparência do grupo" emojiDescription="Escolha o símbolo que identifica o grupo." colorDescription="A cor será usada no avatar do grupo." />
            </section>

            <section className="create-group-people" aria-labelledby="create-group-people-title">
              <div className="create-group-section-heading"><div><Text id="create-group-people-title" weight="semibold">Participantes</Text><Caption1>Você será incluído automaticamente.</Caption1></div><span>{selectedIds.length} selecionado{selectedIds.length === 1 ? '' : 's'}</span></div>
              <SearchBox value={query} onChange={(_, data) => setQuery(data.value)} placeholder="Buscar pessoas ou setores" aria-label="Buscar participantes" />
              <div className="create-group-people-list">
                {visiblePeers.map((peer) => {
                  const checked = selectedIds.includes(peer.deviceId); const online = onlineSet.has(peer.deviceId);
                  return <label key={peer.deviceId} className={`create-group-person${checked ? ' selected' : ''}`}>
                    <Checkbox checked={checked} onChange={() => toggleMember(peer.deviceId)} aria-label={`Adicionar ${peer.displayName}`} />
                    <Avatar emoji={peer.avatarEmoji} bg={peer.avatarBg} size={32} />
                    <span className="create-group-person-text"><strong>{peer.displayName}</strong><small>{peer.department || (online ? 'Online' : 'Offline')}</small></span>
                    <span className={`presence-dot inline ${online ? 'online' : 'offline'}`} aria-label={online ? 'Online' : 'Offline'} />
                  </label>;
                })}
                {!visiblePeers.length && <div className="create-group-empty"><Text weight="semibold">Nenhuma pessoa encontrada</Text><Caption1>Tente outro nome ou setor.</Caption1></div>}
              </div>
            </section>
            {error && <div className="group-operation-error" role="alert">{error}</div>}
          </DialogContent>
          <DialogActions className="create-group-actions">
            <Button appearance="secondary" onClick={close} disabled={busy}>Cancelar</Button>
            <Button appearance="primary" onClick={() => void submit()} disabled={busy || !name.trim() || !isProfileColor(avatarBg)}>{busy ? <><Spinner size="tiny" /> Criando…</> : 'Criar grupo'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
