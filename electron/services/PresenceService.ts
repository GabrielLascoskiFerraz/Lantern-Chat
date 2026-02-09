import { DbService } from '../db';
import { Peer, Profile } from '../types';

export class PresenceService {
  private peersById = new Map<string, Peer>();

  updateOnlinePeers(peers: Peer[], db: DbService): void {
    for (const peer of peers) {
      this.touchOnlinePeer(peer, db, { bypassCooldown: true });
    }
  }

  markPeerOffline(peerId: string): boolean {
    return this.peersById.delete(peerId);
  }

  clearOnlinePeers(): boolean {
    if (this.peersById.size === 0) {
      return false;
    }
    this.peersById.clear();
    return true;
  }

  getOnlinePeers(): Peer[] {
    return Array.from(this.peersById.values());
  }

  getPeer(peerId: string): Peer | undefined {
    return this.peersById.get(peerId);
  }

  touchOnlinePeer(
    peer: Peer,
    db: DbService,
    _options?: {
      bypassCooldown?: boolean;
    }
  ): boolean {
    const observedAt =
      Number.isFinite(peer.lastSeenAt) && (peer.lastSeenAt || 0) > 0
        ? (peer.lastSeenAt as number)
        : Date.now();

    const existingOnline = this.peersById.get(peer.deviceId);
    const existingKnown = existingOnline || db.getCachedPeerById(peer.deviceId) || undefined;

    const next = this.mergePeer(
      {
        ...peer,
        lastSeenAt: observedAt
      },
      existingKnown,
      observedAt,
      peer.source || existingKnown?.source || 'cache'
    );

    this.peersById.set(peer.deviceId, next);
    this.touchPeerCache(next, db);

    if (!existingOnline) return true;

    return (
      existingOnline.address !== next.address ||
      existingOnline.port !== next.port ||
      existingOnline.displayName !== next.displayName ||
      existingOnline.avatarEmoji !== next.avatarEmoji ||
      existingOnline.avatarBg !== next.avatarBg ||
      existingOnline.statusMessage !== next.statusMessage ||
      existingOnline.source !== next.source
    );
  }

  getKnownPeers(db: DbService, profile: Profile): Peer[] {
    const onlinePeers = this.getOnlinePeers();
    const onlineById = new Map(onlinePeers.map((peer) => [peer.deviceId, peer]));
    const cached = db.getCachedPeers();
    const merged = new Map<string, Peer>();

    for (const peer of cached) {
      if (peer.deviceId === profile.deviceId) continue;
      merged.set(peer.deviceId, peer);
    }

    for (const peer of onlinePeers) {
      if (peer.deviceId === profile.deviceId) continue;
      merged.set(peer.deviceId, peer);
    }

    return Array.from(merged.values()).sort((a, b) => {
      const aOnline = onlineById.has(a.deviceId) ? 1 : 0;
      const bOnline = onlineById.has(b.deviceId) ? 1 : 0;
      if (aOnline !== bOnline) return bOnline - aOnline;
      const byName = a.displayName.localeCompare(b.displayName, 'pt-BR', {
        sensitivity: 'base'
      });
      if (byName !== 0) return byName;
      return a.deviceId.localeCompare(b.deviceId);
    });
  }

  private mergePeer(
    incoming: Peer,
    existing: Peer | undefined,
    now: number,
    source: Peer['source']
  ): Peer {
    return {
      deviceId: incoming.deviceId,
      displayName:
        incoming.displayName || existing?.displayName || `Contato ${incoming.deviceId.slice(0, 6)}`,
      avatarEmoji: incoming.avatarEmoji || existing?.avatarEmoji || '🙂',
      avatarBg: incoming.avatarBg || existing?.avatarBg || '#5b5fc7',
      statusMessage: incoming.statusMessage || existing?.statusMessage || 'Disponível',
      appVersion: incoming.appVersion || existing?.appVersion || 'unknown',
      address: incoming.address || existing?.address || '',
      port: incoming.port || existing?.port || 0,
      lastSeenAt: now,
      source
    };
  }

  private touchPeerCache(peer: Peer, db: DbService): void {
    db.upsertPeerCache(peer);
    db.ensureDmConversation(peer.deviceId, peer.displayName);
  }
}
