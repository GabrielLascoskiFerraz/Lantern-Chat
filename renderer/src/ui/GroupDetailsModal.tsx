import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Switch,
  Text,
  Textarea
} from '@fluentui/react-components';
import {
  Add20Regular,
  Delete20Regular,
  Dismiss20Regular
} from '@fluentui/react-icons';
import { GroupInfo, GroupMember, Peer, Profile } from '../api/ipcClient';
import { Avatar } from './Avatar';
import { ConfirmDialog } from './ConfirmDialog';

interface GroupDetailsModalProps {
  open: boolean;
  group: GroupInfo | null;
  members: GroupMember[];
  peers: Peer[];
  onlinePeerIds: string[];
  localProfile: Profile;
  onClose: () => void;
  onUpdateGroup: (
    groupId: string,
    input: {
      name?: string;
      emoji?: string;
      avatarBg?: string;
      description?: string;
      settings?: {
        allowMembersToPin?: boolean;
        allowMembersToEditInfo?: boolean;
      };
    }
  ) => Promise<void>;
  onAddMembers: (groupId: string, memberDeviceIds: string[]) => Promise<void>;
  onRemoveMember: (groupId: string, deviceId: string) => Promise<void>;
  onSetMemberRole: (groupId: string, deviceId: string, role: 'admin' | 'member') => Promise<void>;
  onTransferOwnership: (groupId: string, deviceId: string) => Promise<void>;
  onDeleteGroup: (groupId: string) => Promise<void>;
  onLeaveGroup: (groupId: string) => Promise<void>;
}

const GROUP_EMOJI_CHOICES = ['👥', '💬', '🏢', '🚀', '🎯', '🧠', '🛠️', '📌', '📣', '☕', '🐱', '🦊', '🍕', '🌟', '🔥', '✅'];
const GROUP_COLOR_CHOICES = [
  '#147ad6',
  '#00b7c3',
  '#8cbd18',
  '#ff8c00',
  '#d13438',
  '#8764b8',
  '#107c10',
  '#5c2e91',
  '#69797e',
  '#ca5010'
];

const memberLabel = (member: GroupMember, peersById: Map<string, Peer>, localProfile: Profile): string => {
  const memberDeviceId = typeof member.deviceId === 'string' ? member.deviceId : '';
  const shortId = memberDeviceId ? memberDeviceId.slice(0, 6) : 'desconhecido';
  if (memberDeviceId === localProfile.deviceId) return `${localProfile.displayName} (você)`;
  return (
    peersById.get(memberDeviceId)?.displayName ||
    member.displayNameSnapshot ||
    `Participante ${shortId}`
  );
};

export const GroupDetailsModal = ({
  open,
  group,
  members,
  peers,
  onlinePeerIds,
  localProfile,
  onClose,
  onUpdateGroup,
  onAddMembers,
  onRemoveMember,
  onSetMemberRole,
  onTransferOwnership,
  onDeleteGroup,
  onLeaveGroup
}: GroupDetailsModalProps) => {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('👥');
  const [avatarBg, setAvatarBg] = useState('#147ad6');
  const [description, setDescription] = useState('');
  const [allowMembersToPin, setAllowMembersToPin] = useState(true);
  const [allowMembersToEditInfo, setAllowMembersToEditInfo] = useState(false);
  const [selectedNewMemberIds, setSelectedNewMemberIds] = useState<string[]>([]);
  const [pendingRemoveDeviceId, setPendingRemoveDeviceId] = useState<string | null>(null);
  const [pendingTransferDeviceId, setPendingTransferDeviceId] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  const pendingInfoUpdateRef = useRef<{
    name?: string;
    emoji?: string;
    avatarBg?: string;
    description?: string;
  }>({});
  const pendingInfoUpdateTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open || !group) return;
    setName(group.name);
    setEmoji(group.emoji);
    setAvatarBg(group.avatarBg);
    setDescription(group.description || '');
    setAllowMembersToPin(group.settings.allowMembersToPin !== false);
    setAllowMembersToEditInfo(group.settings.allowMembersToEditInfo === true);
    setSelectedNewMemberIds([]);
  }, [group, open]);

  const activeMembers = useMemo(
    () => members.filter((member) => member.status === 'active'),
    [members]
  );
  const peersById = useMemo(
    () => new Map(peers.map((peer) => [peer.deviceId, peer])),
    [peers]
  );
  const onlineSet = useMemo(() => new Set(onlinePeerIds), [onlinePeerIds]);
  const activeMemberIdSet = useMemo(
    () => new Set(activeMembers.map((member) => member.deviceId)),
    [activeMembers]
  );
  const currentMember = activeMembers.find((member) => member.deviceId === localProfile.deviceId) || null;
  const isOwner = currentMember?.role === 'owner';
  const canManageMembers = currentMember?.role === 'owner' || currentMember?.role === 'admin';
  const canEditInfo = canManageMembers || group?.settings.allowMembersToEditInfo === true;
  const availablePeers = useMemo(
    () =>
      peers
        .filter((peer) => !activeMemberIdSet.has(peer.deviceId))
        .sort((a, b) => {
          const aOnline = onlineSet.has(a.deviceId) ? 1 : 0;
          const bOnline = onlineSet.has(b.deviceId) ? 1 : 0;
          if (aOnline !== bOnline) return bOnline - aOnline;
          return a.displayName.localeCompare(b.displayName, 'pt-BR', { sensitivity: 'base' });
        }),
    [activeMemberIdSet, onlineSet, peers]
  );
  const pendingRemoveMember = pendingRemoveDeviceId
    ? activeMembers.find((member) => member.deviceId === pendingRemoveDeviceId) || null
    : null;
  const pendingTransferMember = pendingTransferDeviceId
    ? activeMembers.find((member) => member.deviceId === pendingTransferDeviceId) || null
    : null;

  const toggleNewMember = (deviceId: string) => {
    setSelectedNewMemberIds((current) =>
      current.includes(deviceId)
        ? current.filter((id) => id !== deviceId)
        : [...current, deviceId]
    );
  };

  const queueInfoUpdate = (input: {
    name?: string;
    emoji?: string;
    avatarBg?: string;
    description?: string;
  }) => {
    if (!group || !canEditInfo) return;
    pendingInfoUpdateRef.current = { ...pendingInfoUpdateRef.current, ...input };
    if (pendingInfoUpdateTimerRef.current !== null) {
      window.clearTimeout(pendingInfoUpdateTimerRef.current);
    }
    pendingInfoUpdateTimerRef.current = window.setTimeout(() => {
      pendingInfoUpdateTimerRef.current = null;
      const pending = pendingInfoUpdateRef.current;
      pendingInfoUpdateRef.current = {};
      if (Object.keys(pending).length === 0) return;
      void onUpdateGroup(group.groupId, pending).catch(() => undefined);
    }, 420);
  };

  useEffect(
    () => () => {
      if (pendingInfoUpdateTimerRef.current !== null) {
        window.clearTimeout(pendingInfoUpdateTimerRef.current);
      }
    },
    []
  );

  const addMembers = async () => {
    if (!group || selectedNewMemberIds.length === 0) return;
    await onAddMembers(group.groupId, selectedNewMemberIds);
    setSelectedNewMemberIds([]);
  };

  if (!group) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
        <DialogSurface className="group-details-modal">
          <DialogBody>
            <DialogTitle>Detalhes do grupo</DialogTitle>
            <DialogContent className="group-details-content">
              <div className="group-details-profile">
                <Avatar emoji={emoji || '👥'} bg={avatarBg || '#147ad6'} size={54} />
                <div className="group-details-profile-fields">
                  <Input
                    value={name}
                    disabled={!canEditInfo}
                    placeholder="Nome do grupo"
                    onChange={(_, data) => {
                      setName(data.value);
                      if (data.value.trim()) queueInfoUpdate({ name: data.value.trim() });
                    }}
                  />
                  <div className="group-details-inline-fields">
                    <Input
                      value={emoji}
                      disabled={!canEditInfo}
                      maxLength={4}
                      aria-label="Emoji do grupo"
                      onChange={(_, data) => {
                        setEmoji(data.value);
                        if (data.value.trim()) queueInfoUpdate({ emoji: data.value.trim() });
                      }}
                    />
                    <Input
                      value={avatarBg}
                      disabled={!canEditInfo}
                      aria-label="Cor do grupo"
                      onChange={(_, data) => {
                        setAvatarBg(data.value);
                        if (/^#[0-9a-f]{6}$/i.test(data.value.trim())) {
                          queueInfoUpdate({ avatarBg: data.value.trim() });
                        }
                      }}
                    />
                  </div>
                  {canEditInfo && (
                    <>
                      <div className="group-choice-grid emoji">
                        {GROUP_EMOJI_CHOICES.map((choice) => (
                          <button
                            key={choice}
                            type="button"
                            className={`group-choice-btn ${emoji === choice ? 'selected' : ''}`}
                            onClick={() => {
                              setEmoji(choice);
                              queueInfoUpdate({ emoji: choice });
                            }}
                          >
                            {choice}
                          </button>
                        ))}
                      </div>
                      <div className="group-choice-grid colors">
                        {GROUP_COLOR_CHOICES.map((choice) => (
                          <button
                            key={choice}
                            type="button"
                            className={`group-color-btn ${avatarBg.toLowerCase() === choice.toLowerCase() ? 'selected' : ''}`}
                            style={{ background: choice }}
                            aria-label={`Usar cor ${choice}`}
                            onClick={() => {
                              setAvatarBg(choice);
                              queueInfoUpdate({ avatarBg: choice });
                            }}
                          />
                        ))}
                        <label
                          className="group-color-picker-btn"
                          title="Escolher cor customizada"
                          aria-label="Escolher cor customizada"
                        >
                          <input
                            type="color"
                            value={/^#[0-9a-f]{6}$/i.test(avatarBg) ? avatarBg : '#147ad6'}
                            onChange={(event) => {
                              setAvatarBg(event.target.value);
                              queueInfoUpdate({ avatarBg: event.target.value });
                            }}
                          />
                          <span style={{ background: avatarBg || '#147ad6' }} />
                        </label>
                      </div>
                    </>
                  )}
                </div>
              </div>

              <Textarea
                value={description}
                disabled={!canEditInfo}
                placeholder="Descrição do grupo"
                resize="vertical"
                onChange={(_, data) => {
                  setDescription(data.value);
                  queueInfoUpdate({ description: data.value.trim() });
                }}
              />

              {canManageMembers && (
                <div className="group-permissions-card">
                  <Text weight="semibold">Permissões</Text>
                  <Switch
                    checked={allowMembersToPin}
                    label="Membros podem fixar mensagens"
                    onChange={(_, data) => {
                      setAllowMembersToPin(data.checked);
                      void onUpdateGroup(group.groupId, {
                        settings: {
                          allowMembersToPin: data.checked,
                          allowMembersToEditInfo
                        }
                      }).catch(() => undefined);
                    }}
                  />
                  <Switch
                    checked={allowMembersToEditInfo}
                    label="Membros podem editar nome, emoji, cor e descrição"
                    onChange={(_, data) => {
                      setAllowMembersToEditInfo(data.checked);
                      void onUpdateGroup(group.groupId, {
                        settings: {
                          allowMembersToPin,
                          allowMembersToEditInfo: data.checked
                        }
                      }).catch(() => undefined);
                    }}
                  />
                </div>
              )}

              <div className="group-details-row between">
                <Text weight="semibold">{activeMembers.length} participante{activeMembers.length === 1 ? '' : 's'}</Text>
              </div>

              <div className="group-member-list">
                {activeMembers.map((member) => {
                  const peer = peersById.get(member.deviceId);
                  const isOnline = member.deviceId === localProfile.deviceId || onlineSet.has(member.deviceId);
                  const canRemove =
                    canManageMembers &&
                    member.deviceId !== localProfile.deviceId &&
                    member.role !== 'owner';
                  return (
                    <div key={member.deviceId} className="group-member-row">
                      <div className="group-member-main">
                        <Avatar
                          emoji={peer?.avatarEmoji || member.avatarEmojiSnapshot || '🙂'}
                          bg={peer?.avatarBg || member.avatarBgSnapshot || '#6b7280'}
                          size={32}
                        />
                        <div className="group-member-text">
                          <Text weight="semibold">{memberLabel(member, peersById, localProfile)}</Text>
                          <div className="group-member-subline">
                            <span className={`presence-dot inline ${isOnline ? 'online' : 'offline'}`} />
                            <span>{isOnline ? 'Online' : 'Offline'}</span>
                            <Badge appearance="tint">{member.role === 'owner' ? 'Dono' : member.role === 'admin' ? 'Admin' : 'Membro'}</Badge>
                          </div>
                        </div>
                      </div>
                      {canRemove && (
                        <div className="group-member-actions">
                          {isOwner && (
                            <>
                              <Button
                                size="small"
                                appearance="subtle"
                                onClick={() =>
                                  void onSetMemberRole(
                                    group.groupId,
                                    member.deviceId,
                                    member.role === 'admin' ? 'member' : 'admin'
                                  )
                                }
                              >
                                {member.role === 'admin' ? 'Remover admin' : 'Tornar admin'}
                              </Button>
                              <Button
                                size="small"
                                appearance="subtle"
                                onClick={() => setPendingTransferDeviceId(member.deviceId)}
                              >
                                Tornar dono
                              </Button>
                            </>
                          )}
                          <Button
                            size="small"
                            appearance="subtle"
                            icon={<Delete20Regular />}
                            aria-label="Remover participante"
                            onClick={() => setPendingRemoveDeviceId(member.deviceId)}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {canManageMembers && (
                <div className="group-add-members">
                  <Text weight="semibold">Adicionar participantes</Text>
                  <div className="group-add-members-list">
                    {availablePeers.length === 0 ? (
                      <Text size={200} className="muted-text">Nenhum contato disponível para adicionar.</Text>
                    ) : (
                      availablePeers.map((peer) => {
                        const selected = selectedNewMemberIds.includes(peer.deviceId);
                        const isOnline = onlineSet.has(peer.deviceId);
                        return (
                          <button
                            key={peer.deviceId}
                            type="button"
                            className={`group-add-member-option ${selected ? 'selected' : ''}`}
                            onClick={() => toggleNewMember(peer.deviceId)}
                          >
                            <Avatar emoji={peer.avatarEmoji} bg={peer.avatarBg} size={28} />
                            <span>{peer.displayName}</span>
                            <span className={`presence-dot inline ${isOnline ? 'online' : 'offline'}`} />
                          </button>
                        );
                      })
                    )}
                  </div>
                  <Button
                    appearance="primary"
                    icon={<Add20Regular />}
                    disabled={selectedNewMemberIds.length === 0}
                    onClick={() => void addMembers()}
                  >
                    Adicionar selecionados
                  </Button>
                </div>
              )}
            </DialogContent>
            <DialogActions className="group-details-actions">
              {isOwner && (
                <Button
                  appearance="subtle"
                  icon={<Delete20Regular />}
                  onClick={() => setDeleteConfirmOpen(true)}
                >
                  Excluir grupo
                </Button>
              )}
              <Button
                appearance="subtle"
                icon={<Dismiss20Regular />}
                onClick={() => setLeaveConfirmOpen(true)}
              >
                Sair do grupo
              </Button>
              <Button appearance="secondary" onClick={onClose}>
                Fechar
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <ConfirmDialog
        open={Boolean(pendingRemoveMember)}
        title="Remover participante?"
        description={
          pendingRemoveMember
            ? `${memberLabel(pendingRemoveMember, peersById, localProfile)} será removido deste grupo.`
            : ''
        }
        confirmLabel="Remover"
        onCancel={() => setPendingRemoveDeviceId(null)}
        onConfirm={() => {
          if (group && pendingRemoveMember) {
            void onRemoveMember(group.groupId, pendingRemoveMember.deviceId);
          }
          setPendingRemoveDeviceId(null);
        }}
      />

      <ConfirmDialog
        open={Boolean(pendingTransferMember)}
        title="Transferir propriedade?"
        description={
          pendingTransferMember
            ? `${memberLabel(pendingTransferMember, peersById, localProfile)} será o novo dono do grupo.`
            : ''
        }
        confirmLabel="Transferir"
        onCancel={() => setPendingTransferDeviceId(null)}
        onConfirm={() => {
          if (group && pendingTransferMember) {
            void onTransferOwnership(group.groupId, pendingTransferMember.deviceId);
          }
          setPendingTransferDeviceId(null);
        }}
      />

      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Excluir grupo?"
        description="O grupo será encerrado para todos os participantes. Essa ação não remove os arquivos locais já recebidos."
        confirmLabel="Excluir grupo"
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={() => {
          void onDeleteGroup(group.groupId);
          setDeleteConfirmOpen(false);
          onClose();
        }}
      />

      <ConfirmDialog
        open={leaveConfirmOpen}
        title="Sair do grupo?"
        description="Você deixará de receber novas mensagens deste grupo."
        confirmLabel="Sair"
        onCancel={() => setLeaveConfirmOpen(false)}
        onConfirm={() => {
          void onLeaveGroup(group.groupId);
          setLeaveConfirmOpen(false);
          onClose();
        }}
      />
    </>
  );
};
