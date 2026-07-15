import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DrawerBody,
  DrawerHeader,
  DrawerHeaderTitle,
  Field,
  Input,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  OverlayDrawer,
  SearchBox,
  Spinner,
  Switch,
  Tab,
  TabList,
  Text,
  Textarea
} from '@fluentui/react-components';
import {
  Add20Regular,
  Delete20Regular,
  Dismiss20Regular,
  MoreHorizontal20Regular,
  Save20Regular
} from '@fluentui/react-icons';
import { GroupInfo, GroupMember, Peer, Profile } from '../api/ipcClient';
import { Avatar } from './Avatar';
import { ConfirmDialog } from './ConfirmDialog';
import { ProfileIdentityEditor } from './ProfileIdentityEditor';
import { isProfileColor } from './profileIdentityOptions';

interface GroupDetailsModalProps {
  open: boolean; group: GroupInfo | null; members: GroupMember[]; peers: Peer[];
  onlinePeerIds: string[]; localProfile: Profile; onClose: () => void;
  onUpdateGroup: (groupId: string, input: { name?: string; emoji?: string; avatarBg?: string; description?: string; settings?: { allowMembersToPin?: boolean; allowMembersToEditInfo?: boolean } }) => Promise<void>;
  onAddMembers: (groupId: string, memberDeviceIds: string[]) => Promise<void>;
  onRemoveMember: (groupId: string, deviceId: string) => Promise<void>;
  onSetMemberRole: (groupId: string, deviceId: string, role: 'admin' | 'member') => Promise<void>;
  onTransferOwnership: (groupId: string, deviceId: string) => Promise<void>;
  onDeleteGroup: (groupId: string) => Promise<void>;
  onLeaveGroup: (groupId: string) => Promise<void>;
}

type Section = 'general' | 'members' | 'permissions';
interface EditableGroup { name: string; emoji: string; avatarBg: string; description: string; allowMembersToPin: boolean; allowMembersToEditInfo: boolean }
const normalize = (value: string): string => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
const memberName = (member: GroupMember, peers: Map<string, Peer>, profile: Profile): string => member.deviceId === profile.deviceId
  ? `${profile.displayName} (você)`
  : peers.get(member.deviceId)?.displayName || member.displayNameSnapshot || `Participante ${member.deviceId.slice(0, 6)}`;
const editableFromGroup = (group: GroupInfo): EditableGroup => ({
  name: group.name, emoji: group.emoji || '👥', avatarBg: group.avatarBg || '#147ad6', description: group.description || '',
  allowMembersToPin: group.settings.allowMembersToPin !== false,
  allowMembersToEditInfo: group.settings.allowMembersToEditInfo === true
});

export const GroupDetailsModal = (props: GroupDetailsModalProps) => {
  const { open, group, members, peers, onlinePeerIds, localProfile, onClose, onUpdateGroup, onAddMembers, onRemoveMember, onSetMemberRole, onTransferOwnership, onDeleteGroup, onLeaveGroup } = props;
  const [section, setSection] = useState<Section>('general');
  const [draft, setDraft] = useState<EditableGroup | null>(null);
  const [baseline, setBaseline] = useState<EditableGroup | null>(null);
  const [memberQuery, setMemberQuery] = useState('');
  const [operation, setOperation] = useState('');
  const [error, setError] = useState('');
  const [savedNotice, setSavedNotice] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [selectedNewMemberIds, setSelectedNewMemberIds] = useState<string[]>([]);
  const [pendingRemoveDeviceId, setPendingRemoveDeviceId] = useState<string | null>(null);
  const [pendingTransferDeviceId, setPendingTransferDeviceId] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);

  useEffect(() => {
    if (!open || !group) return;
    const initial = editableFromGroup(group);
    setDraft(initial); setBaseline(initial); setSection('general'); setMemberQuery(''); setError(''); setSavedNotice(false);
    setAddOpen(false); setSelectedNewMemberIds([]); setOperation('');
  }, [group?.groupId, open]);

  const activeMembers = useMemo(() => members.filter((member) => member.status === 'active'), [members]);
  const peersById = useMemo(() => new Map(peers.map((peer) => [peer.deviceId, peer])), [peers]);
  const onlineSet = useMemo(() => new Set(onlinePeerIds), [onlinePeerIds]);
  const currentMember = activeMembers.find((member) => member.deviceId === localProfile.deviceId) || null;
  const isOwner = currentMember?.role === 'owner';
  const canManageMembers = isOwner || currentMember?.role === 'admin';
  const canEditInfo = canManageMembers || group?.settings.allowMembersToEditInfo === true;
  const memberIds = useMemo(() => new Set(activeMembers.map((member) => member.deviceId)), [activeMembers]);
  const hasChanges = Boolean(draft && baseline && JSON.stringify(draft) !== JSON.stringify(baseline));
  const busy = Boolean(operation);

  const visibleMembers = useMemo(() => {
    const query = normalize(memberQuery.trim());
    const rank = (role: GroupMember['role']) => role === 'owner' ? 0 : role === 'admin' ? 1 : 2;
    return activeMembers.filter((member) => !query || normalize(`${memberName(member, peersById, localProfile)} ${peersById.get(member.deviceId)?.department || ''}`).includes(query))
      .sort((left, right) => rank(left.role) - rank(right.role) || memberName(left, peersById, localProfile).localeCompare(memberName(right, peersById, localProfile), 'pt-BR'));
  }, [activeMembers, localProfile, memberQuery, peersById]);
  const availablePeers = useMemo(() => {
    const query = normalize(addQuery.trim());
    return peers.filter((peer) => !memberIds.has(peer.deviceId) && (!query || normalize(`${peer.displayName} ${peer.department || ''}`).includes(query)))
      .sort((left, right) => Number(onlineSet.has(right.deviceId)) - Number(onlineSet.has(left.deviceId)) || left.displayName.localeCompare(right.displayName, 'pt-BR'));
  }, [addQuery, memberIds, onlineSet, peers]);

  if (!group || !draft || !baseline) return null;
  const pendingRemoveMember = pendingRemoveDeviceId ? activeMembers.find((member) => member.deviceId === pendingRemoveDeviceId) : null;
  const pendingTransferMember = pendingTransferDeviceId ? activeMembers.find((member) => member.deviceId === pendingTransferDeviceId) : null;

  const run = async (key: string, action: () => Promise<void>): Promise<boolean> => {
    if (busy) return false; setOperation(key); setError(''); setSavedNotice(false);
    try { await action(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível concluir a operação.'); return false; }
    finally { setOperation(''); }
  };
  const requestClose = (): void => { if (hasChanges) setDiscardConfirmOpen(true); else onClose(); };
  const save = async (): Promise<void> => {
    if (!draft.name.trim() || !isProfileColor(draft.avatarBg)) return;
    const success = await run('save', () => onUpdateGroup(group.groupId, {
      name: draft.name.trim(), emoji: draft.emoji.trim() || '👥', avatarBg: draft.avatarBg,
      description: draft.description.trim(),
      ...(canManageMembers ? { settings: { allowMembersToPin: draft.allowMembersToPin, allowMembersToEditInfo: draft.allowMembersToEditInfo } } : {})
    }));
    if (success) { const saved = { ...draft, name: draft.name.trim(), description: draft.description.trim() }; setDraft(saved); setBaseline(saved); setSavedNotice(true); }
  };
  const addMembers = async (): Promise<void> => {
    if (!selectedNewMemberIds.length) return;
    const success = await run('add', () => onAddMembers(group.groupId, selectedNewMemberIds));
    if (success) { setAddOpen(false); setSelectedNewMemberIds([]); setAddQuery(''); }
  };

  return <>
    <OverlayDrawer open={open} position="end" size="large" className="group-details-drawer" onOpenChange={(_, data) => !data.open && requestClose()}>
      <DrawerHeader className="group-drawer-header">
        <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="Fechar detalhes do grupo" onClick={requestClose} />}>
          Detalhes do grupo
        </DrawerHeaderTitle>
        <div className="group-drawer-identity"><Avatar emoji={draft.emoji} bg={draft.avatarBg} size={56} /><div><Text size={500} weight="semibold">{draft.name || group.name}</Text><Caption1>{activeMembers.length} participante{activeMembers.length === 1 ? '' : 's'} · {isOwner ? 'Você é o dono' : currentMember?.role === 'admin' ? 'Você é administrador' : 'Você é membro'}</Caption1></div></div>
        <TabList selectedValue={section} onTabSelect={(_, data) => setSection(data.value as Section)} aria-label="Seções do grupo">
          <Tab value="general">Geral</Tab><Tab value="members">Participantes</Tab>{canManageMembers && <Tab value="permissions">Permissões</Tab>}
        </TabList>
      </DrawerHeader>
      <DrawerBody className="group-drawer-body">
        {section === 'general' && <div className="group-drawer-section">
          <div className="group-section-heading"><div><Text size={400} weight="semibold">Informações do grupo</Text><Caption1>{canEditInfo ? 'Edite a identidade e salve quando terminar.' : 'Somente administradores podem editar estas informações.'}</Caption1></div></div>
          {canEditInfo ? <>
            <div className="group-general-fields">
              <Field label="Nome do grupo" required><Input value={draft.name} maxLength={80} onChange={(_, data) => setDraft((current) => current && ({ ...current, name: data.value }))} /></Field>
              <Field label="Descrição" hint={`${draft.description.length}/240 · opcional`}><Textarea value={draft.description} maxLength={240} resize="vertical" onChange={(_, data) => setDraft((current) => current && ({ ...current, description: data.value }))} /></Field>
            </div>
            <div className="group-identity-editor-card"><ProfileIdentityEditor emoji={draft.emoji} color={draft.avatarBg} onEmojiChange={(emoji) => setDraft((current) => current && ({ ...current, emoji }))} onColorChange={(avatarBg) => setDraft((current) => current && ({ ...current, avatarBg }))} compact ariaLabel="Aparência do grupo" emojiDescription="Escolha o símbolo que identifica o grupo." colorDescription="A cor será usada no avatar do grupo." /></div>
          </> : <div className="group-readonly-card"><Avatar emoji={draft.emoji} bg={draft.avatarBg} size={72} /><div><Text size={500} weight="semibold">{draft.name}</Text><Text>{draft.description || 'Este grupo não possui descrição.'}</Text></div></div>}
        </div>}

        {section === 'members' && <div className="group-drawer-section">
          <div className="group-section-heading"><div><Text size={400} weight="semibold">Participantes</Text><Caption1>Gerencie funções e acompanhe quem está disponível.</Caption1></div>{canManageMembers && <Button appearance="primary" icon={<Add20Regular />} onClick={() => { setAddOpen(true); setSelectedNewMemberIds([]); setAddQuery(''); }}>Adicionar</Button>}</div>
          <SearchBox value={memberQuery} onChange={(_, data) => setMemberQuery(data.value)} placeholder="Buscar no grupo" aria-label="Buscar participantes do grupo" />
          <div className="group-managed-member-list">
            {visibleMembers.map((member) => {
              const peer = peersById.get(member.deviceId); const online = member.deviceId === localProfile.deviceId || onlineSet.has(member.deviceId); const name = memberName(member, peersById, localProfile);
              const canAct = canManageMembers && member.deviceId !== localProfile.deviceId && member.role !== 'owner';
              return <div key={member.deviceId} className="group-managed-member-row">
                <Avatar emoji={peer?.avatarEmoji || member.avatarEmojiSnapshot || '🙂'} bg={peer?.avatarBg || member.avatarBgSnapshot || '#6b7280'} size={36} />
                <div className="group-managed-member-text"><Text weight="semibold">{name}</Text><span><i className={`presence-dot inline ${online ? 'online' : 'offline'}`} />{online ? 'Online' : 'Offline'}{peer?.department ? ` · ${peer.department}` : ''}</span></div>
                <Badge appearance="tint">{member.role === 'owner' ? 'Dono' : member.role === 'admin' ? 'Admin do grupo' : 'Membro'}</Badge>
                {canAct && <Menu><MenuTrigger disableButtonEnhancement><Button appearance="subtle" icon={<MoreHorizontal20Regular />} aria-label={`Mais opções para ${name}`} disabled={busy} /></MenuTrigger><MenuPopover><MenuList>
                  {isOwner && <MenuItem onClick={() => void run(`role-${member.deviceId}`, () => onSetMemberRole(group.groupId, member.deviceId, member.role === 'admin' ? 'member' : 'admin'))}>{member.role === 'admin' ? 'Remover função de admin' : 'Tornar admin do grupo'}</MenuItem>}
                  {isOwner && <MenuItem onClick={() => setPendingTransferDeviceId(member.deviceId)}>Transferir propriedade</MenuItem>}
                  <MenuItem icon={<Delete20Regular />} onClick={() => setPendingRemoveDeviceId(member.deviceId)}>Remover do grupo</MenuItem>
                </MenuList></MenuPopover></Menu>}
              </div>;
            })}
            {!visibleMembers.length && <div className="group-list-empty"><Text weight="semibold">Nenhum participante encontrado</Text><Caption1>Tente outro termo de busca.</Caption1></div>}
          </div>
        </div>}

        {section === 'permissions' && canManageMembers && <div className="group-drawer-section">
          <div className="group-section-heading"><div><Text size={400} weight="semibold">Permissões do grupo</Text><Caption1>Defina o que participantes comuns podem alterar.</Caption1></div></div>
          <div className="group-permission-list">
            <Switch checked={draft.allowMembersToPin} label="Permitir que membros fixem mensagens" onChange={(_, data) => setDraft((current) => current && ({ ...current, allowMembersToPin: data.checked }))} />
            <Text size={200}>Administradores e o dono sempre podem fixar mensagens.</Text>
            <Switch checked={draft.allowMembersToEditInfo} label="Permitir que membros editem as informações do grupo" onChange={(_, data) => setDraft((current) => current && ({ ...current, allowMembersToEditInfo: data.checked }))} />
            <Text size={200}>Inclui nome, descrição, emoji e cor do avatar.</Text>
          </div>
          <div className="group-danger-zone"><div><Text weight="semibold">Área de perigo</Text><Caption1>Ações que alteram permanentemente sua participação.</Caption1></div><div>
            <Button appearance="secondary" disabled={isOwner || busy} onClick={() => setLeaveConfirmOpen(true)}>Sair do grupo</Button>
            {isOwner && <Button appearance="secondary" icon={<Delete20Regular />} disabled={busy} onClick={() => setDeleteConfirmOpen(true)}>Excluir grupo</Button>}
          </div>{isOwner && <Caption1>Transfira a propriedade antes de sair do grupo.</Caption1>}</div>
        </div>}
        {error && <div className="group-operation-error" role="alert">{error}</div>}
      </DrawerBody>
      {canEditInfo && <div className="group-drawer-footer"><span className={error ? 'error' : hasChanges ? 'dirty' : ''}>{operation === 'save' ? 'Salvando alterações…' : error ? 'Não foi possível salvar.' : hasChanges ? 'Alterações não salvas' : savedNotice ? 'Tudo atualizado.' : 'Nenhuma alteração pendente.'}</span><Button appearance="secondary" disabled={!hasChanges || busy} onClick={() => { setDraft({ ...baseline }); setError(''); }}>Descartar</Button><Button appearance="primary" icon={operation === 'save' ? <Spinner size="tiny" /> : <Save20Regular />} disabled={!hasChanges || busy || !draft.name.trim() || !isProfileColor(draft.avatarBg)} onClick={() => void save()}>Salvar alterações</Button></div>}
    </OverlayDrawer>

    <Dialog open={addOpen} onOpenChange={(_, data) => !data.open && !busy && setAddOpen(false)}>
      <DialogSurface className="group-add-dialog"><DialogBody><DialogTitle>Adicionar participantes</DialogTitle><DialogContent className="group-add-dialog-content">
        <SearchBox autoFocus value={addQuery} onChange={(_, data) => setAddQuery(data.value)} placeholder="Buscar pessoas ou setores" />
        <div className="group-add-dialog-summary">{selectedNewMemberIds.length} selecionado{selectedNewMemberIds.length === 1 ? '' : 's'}</div>
        <div className="group-add-dialog-list">{availablePeers.map((peer) => { const checked = selectedNewMemberIds.includes(peer.deviceId); const online = onlineSet.has(peer.deviceId); return <label key={peer.deviceId} className={checked ? 'selected' : ''}><Checkbox checked={checked} onChange={() => setSelectedNewMemberIds((current) => current.includes(peer.deviceId) ? current.filter((id) => id !== peer.deviceId) : [...current, peer.deviceId])} /><Avatar emoji={peer.avatarEmoji} bg={peer.avatarBg} size={32} /><span><strong>{peer.displayName}</strong><small>{peer.department || (online ? 'Online' : 'Offline')}</small></span><i className={`presence-dot inline ${online ? 'online' : 'offline'}`} /></label>; })}{!availablePeers.length && <div className="group-list-empty"><Text weight="semibold">Nenhuma pessoa disponível</Text><Caption1>Todos já participam ou não correspondem à busca.</Caption1></div>}</div>
        {error && <div className="group-operation-error" role="alert">{error}</div>}
      </DialogContent><DialogActions><Button appearance="secondary" disabled={busy} onClick={() => setAddOpen(false)}>Cancelar</Button><Button appearance="primary" disabled={!selectedNewMemberIds.length || busy} onClick={() => void addMembers()}>{operation === 'add' ? <><Spinner size="tiny" /> Adicionando…</> : `Adicionar ${selectedNewMemberIds.length || ''}`}</Button></DialogActions></DialogBody></DialogSurface>
    </Dialog>

    <ConfirmDialog open={discardConfirmOpen} title="Descartar alterações?" description="As alterações ainda não salvas serão perdidas." confirmLabel="Descartar" onCancel={() => setDiscardConfirmOpen(false)} onConfirm={() => { setDiscardConfirmOpen(false); onClose(); }} />
    <ConfirmDialog open={Boolean(pendingRemoveMember)} title="Remover participante?" description={pendingRemoveMember ? `${memberName(pendingRemoveMember, peersById, localProfile)} será removido deste grupo.` : ''} confirmLabel="Remover" onCancel={() => setPendingRemoveDeviceId(null)} onConfirm={() => { if (!pendingRemoveMember) return; const id = pendingRemoveMember.deviceId; setPendingRemoveDeviceId(null); void run(`remove-${id}`, () => onRemoveMember(group.groupId, id)); }} />
    <ConfirmDialog open={Boolean(pendingTransferMember)} title="Transferir propriedade?" description={pendingTransferMember ? `${memberName(pendingTransferMember, peersById, localProfile)} passará a ser o dono do grupo. Você não poderá desfazer isso sem a colaboração do novo dono.` : ''} confirmLabel="Transferir" onCancel={() => setPendingTransferDeviceId(null)} onConfirm={() => { if (!pendingTransferMember) return; const id = pendingTransferMember.deviceId; setPendingTransferDeviceId(null); void run(`transfer-${id}`, () => onTransferOwnership(group.groupId, id)); }} />
    <ConfirmDialog open={deleteConfirmOpen} title="Excluir grupo?" description="O grupo será encerrado para todos os participantes. Essa ação não pode ser desfeita." confirmLabel="Excluir grupo" onCancel={() => setDeleteConfirmOpen(false)} onConfirm={() => { setDeleteConfirmOpen(false); void run('delete', () => onDeleteGroup(group.groupId)).then((success) => success && onClose()); }} />
    <ConfirmDialog open={leaveConfirmOpen} title="Sair do grupo?" description="Você deixará de receber novas mensagens deste grupo." confirmLabel="Sair" onCancel={() => setLeaveConfirmOpen(false)} onConfirm={() => { setLeaveConfirmOpen(false); void run('leave', () => onLeaveGroup(group.groupId)).then((success) => success && onClose()); }} />
  </>;
};
