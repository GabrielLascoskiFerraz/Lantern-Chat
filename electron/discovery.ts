import dgram, { RemoteInfo, Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import BonjourService, { Browser, Service } from 'bonjour-service';
import {
  APP_VERSION,
  MDNS_PROTOCOL,
  MDNS_TYPE,
  UDP_BEACON_INTERVAL_MS,
  UDP_DISCOVERY_MAGIC,
  UDP_DISCOVERY_MULTICAST_GROUP,
  UDP_DISCOVERY_PORT,
  UDP_PEER_STALE_MS
} from './config';
import { Peer, Profile } from './types';

type PeerHandler = (peers: Peer[]) => void;

interface UdpBeaconPayload {
  magic: string;
  deviceId: string;
  displayName: string;
  avatarEmoji: string;
  avatarBg: string;
  statusMessage: string;
  wsPort: number;
  appVersion: string;
  sentAt: number;
}

const MDNS_DOWN_GRACE_MS = 20_000;
const MDNS_PEER_STALE_MS = 60_000;
const UDP_SWEEP_INTERVAL_MS = 4_000;

const SOURCE_PRIORITY: Record<Peer['source'], number> = {
  relay: 5,
  manual: 4,
  udp: 3,
  mdns: 2,
  cache: 1
};

const isIPv4 = (value: string): boolean => /^\d+\.\d+\.\d+\.\d+$/.test(value);

const normalizeRemoteAddress = (value: string | undefined): string => {
  if (!value) return '';
  const cleaned = value.replace(/^::ffff:/, '').trim();
  if (cleaned === '::1' || cleaned.startsWith('127.')) return '';
  return cleaned;
};

const sanitizeHost = (value: string | undefined): string | null => {
  if (!value) return null;
  return value.replace(/\.$/, '').trim() || null;
};

const parseTxt = (service: Service): Record<string, string | undefined> => {
  const txtRaw = (service.txt || {}) as Record<string, unknown>;
  const normalized: Record<string, string | undefined> = {};
  for (const [key, rawValue] of Object.entries(txtRaw)) {
    if (typeof rawValue === 'string') {
      normalized[key] = rawValue;
      continue;
    }
    if (Buffer.isBuffer(rawValue)) {
      normalized[key] = rawValue.toString('utf8');
      continue;
    }
    if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      normalized[key] = String(rawValue);
      continue;
    }
    normalized[key] = undefined;
  }
  return normalized;
};

const pickBestAddress = (service: Service): string | null => {
  const addresses = (service.addresses || []).map((value) => normalizeRemoteAddress(value)).filter(Boolean);
  const ipv4 = addresses.filter(isIPv4);
  const nonLoopbackIPv4 = ipv4.find((addr) => !addr.startsWith('127.'));
  if (nonLoopbackIPv4) return nonLoopbackIPv4;

  const host = sanitizeHost(service.host);
  if (host) return host;

  const firstIPv4 = ipv4[0];
  if (firstIPv4) return firstIPv4;

  return addresses[0] || null;
};

const ipToInt = (ip: string): number | null => {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
    out = (out << 8) + num;
  }
  return out >>> 0;
};

const intToIp = (value: number): string =>
  [24, 16, 8, 0].map((shift) => String((value >>> shift) & 0xff)).join('.');

const computeBroadcastAddress = (address: string, netmask: string): string | null => {
  const addrInt = ipToInt(address);
  const maskInt = ipToInt(netmask);
  if (addrInt === null || maskInt === null) return null;
  const network = addrInt & maskInt;
  const hostBits = (~maskInt) >>> 0;
  return intToIp((network | hostBits) >>> 0);
};

export class DiscoveryService {
  private readonly bonjour: BonjourService;
  private browser: Browser | null = null;
  private published: Service | null = null;

  private readonly mdnsPeers = new Map<string, Peer>();
  private readonly udpPeers = new Map<string, Peer>();
  private readonly manualPeers = new Map<string, Peer>();

  private onUpdate: PeerHandler = () => undefined;
  private readonly localDeviceId: string;
  private rebrowseTimer: NodeJS.Timeout | null = null;
  private udpBeaconTimer: NodeJS.Timeout | null = null;
  private udpSweepTimer: NodeJS.Timeout | null = null;
  private udpSocket: Socket | null = null;

  private readonly pendingDownTimers = new Map<string, NodeJS.Timeout>();
  private readonly debugEnabled = process.env.LANTERN_DEBUG_DISCOVERY === '1';
  private lastEmitSignature = '';

  private advertisedProfile: Profile;
  private advertisedWsPort = 0;

  constructor(localProfile: Profile) {
    this.bonjour = new BonjourService({}, (error: unknown) => {
      if (this.debugEnabled) {
        console.warn('[Lantern][Discovery] mDNS warning/error:', error);
      }
    });
    this.localDeviceId = localProfile.deviceId;
    this.advertisedProfile = { ...localProfile };
  }

  startAdvertising(profile: Profile, wsPort: number): void {
    this.advertisedProfile = { ...profile };
    this.advertisedWsPort = wsPort;

    this.stopAdvertising();
    this.published = this.bonjour.publish({
      name: `Lantern-${profile.deviceId.slice(0, 8)}`,
      type: MDNS_TYPE,
      protocol: MDNS_PROTOCOL,
      port: wsPort,
      txt: {
        deviceId: profile.deviceId,
        displayName: profile.displayName,
        avatarEmoji: profile.avatarEmoji,
        avatarBg: profile.avatarBg,
        statusMessage: profile.statusMessage,
        wsPort: String(wsPort),
        appVersion: APP_VERSION
      }
    });

    this.published.on('error', (error: unknown) => {
      if (this.debugEnabled) {
        console.warn('[Lantern][Discovery] publish error:', error);
      }
    });

    this.broadcastUdpBeacon();
  }

  startBrowsing(onUpdate: PeerHandler): void {
    this.onUpdate = onUpdate;

    if (this.browser) {
      this.browser.stop();
      this.browser = null;
    }

    this.browser = this.bonjour.find({ type: MDNS_TYPE, protocol: MDNS_PROTOCOL });
    this.browser.on('up', (service: Service) => this.handleUp(service));
    this.browser.on('down', (service: Service) => this.handleDown(service));

    if (this.rebrowseTimer) {
      clearInterval(this.rebrowseTimer);
      this.rebrowseTimer = null;
    }

    this.rebrowseTimer = setInterval(() => {
      try {
        this.browser?.update();
      } catch {
        // ignora falhas pontuais de refresh mDNS
      }
      this.sweepStaleMdnsPeers();
    }, 8_000);
    this.rebrowseTimer.unref?.();

    this.startUdpDiscovery();
    this.emit();
  }

  addManualPeer(address: string, port: number): void {
    const normalizedAddress = normalizeRemoteAddress(address);
    if (!normalizedAddress || !Number.isFinite(port) || port <= 0) {
      return;
    }
    const key = `manual:${normalizedAddress}:${port}`;
    this.manualPeers.set(key, {
      deviceId: key,
      displayName: `${normalizedAddress}:${port}`,
      avatarEmoji: '🧭',
      avatarBg: '#666666',
      statusMessage: 'Conexão manual',
      address: normalizedAddress,
      port,
      appVersion: APP_VERSION,
      lastSeenAt: Date.now(),
      source: 'manual'
    });
    this.emit();
  }

  removeManualPeer(deviceId: string): void {
    if (!deviceId.startsWith('manual:')) {
      return;
    }
    const removed = this.manualPeers.delete(deviceId);
    if (removed) {
      this.emit();
    }
  }

  listPeers(): Peer[] {
    return this.buildMergedPeers();
  }

  stopAdvertising(): void {
    if (this.published) {
      this.published.stop?.();
      this.published = null;
    }
  }

  stop(): void {
    this.stopAdvertising();

    if (this.rebrowseTimer) {
      clearInterval(this.rebrowseTimer);
      this.rebrowseTimer = null;
    }

    if (this.udpBeaconTimer) {
      clearInterval(this.udpBeaconTimer);
      this.udpBeaconTimer = null;
    }

    if (this.udpSweepTimer) {
      clearInterval(this.udpSweepTimer);
      this.udpSweepTimer = null;
    }

    for (const timer of this.pendingDownTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingDownTimers.clear();

    if (this.browser) {
      this.browser.stop();
      this.browser = null;
    }

    if (this.udpSocket) {
      try {
        this.udpSocket.close();
      } catch {
        // ignore
      }
      this.udpSocket = null;
    }

    this.mdnsPeers.clear();
    this.udpPeers.clear();
    this.manualPeers.clear();

    this.bonjour.destroy();
  }

  private handleUp(service: Service): void {
    const txt = parseTxt(service);
    const deviceId = txt.deviceId;

    if (this.debugEnabled) {
      console.log(
        '[Lantern][Discovery] up',
        JSON.stringify({
          name: service.name,
          type: service.type,
          host: service.host,
          addresses: service.addresses,
          txt
        })
      );
    }

    if (!deviceId || deviceId === this.localDeviceId) {
      return;
    }

    const pendingDown = this.pendingDownTimers.get(deviceId);
    if (pendingDown) {
      clearTimeout(pendingDown);
      this.pendingDownTimers.delete(deviceId);
    }

    const address = pickBestAddress(service);
    const port = Number(txt.wsPort || service.port || 0);
    if (!address || !Number.isFinite(port) || port <= 0) {
      return;
    }

    const now = Date.now();
    const existing = this.mdnsPeers.get(deviceId) || this.udpPeers.get(deviceId);

    this.mdnsPeers.set(deviceId, {
      deviceId,
      displayName: txt.displayName || existing?.displayName || `User ${deviceId.slice(0, 6)}`,
      avatarEmoji: txt.avatarEmoji || existing?.avatarEmoji || '🙂',
      avatarBg: txt.avatarBg || existing?.avatarBg || '#5c8aff',
      statusMessage: txt.statusMessage || existing?.statusMessage || 'Disponível',
      port,
      address,
      appVersion: txt.appVersion || existing?.appVersion || APP_VERSION,
      lastSeenAt: now,
      source: 'mdns'
    });

    this.emit();
  }

  private handleDown(service: Service): void {
    const txt = parseTxt(service);
    const deviceId = txt.deviceId;

    if (this.debugEnabled) {
      console.log(
        '[Lantern][Discovery] down',
        JSON.stringify({
          name: service.name,
          type: service.type,
          txt
        })
      );
    }

    if (!deviceId) {
      return;
    }
    if (this.pendingDownTimers.has(deviceId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.pendingDownTimers.delete(deviceId);
      const removed = this.mdnsPeers.delete(deviceId);
      if (removed) {
        this.emit();
      }
    }, MDNS_DOWN_GRACE_MS);
    timer.unref?.();
    this.pendingDownTimers.set(deviceId, timer);
  }

  private startUdpDiscovery(): void {
    if (this.udpSocket) {
      return;
    }

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udpSocket = socket;

    socket.on('error', (error) => {
      if (this.debugEnabled) {
        console.warn('[Lantern][Discovery] UDP error:', error);
      }
    });

    socket.on('message', (raw, rinfo) => {
      this.handleUdpMessage(raw, rinfo);
    });

    socket.bind(UDP_DISCOVERY_PORT, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        // ignore
      }

      try {
        socket.setMulticastTTL(1);
      } catch {
        // ignore
      }

      try {
        socket.addMembership(UDP_DISCOVERY_MULTICAST_GROUP);
      } catch {
        // em alguns ambientes addMembership pode falhar
      }

      this.broadcastUdpBeacon();
    });

    if (!this.udpBeaconTimer) {
      this.udpBeaconTimer = setInterval(() => {
        this.broadcastUdpBeacon();
      }, UDP_BEACON_INTERVAL_MS);
      this.udpBeaconTimer.unref?.();
    }

    if (!this.udpSweepTimer) {
      this.udpSweepTimer = setInterval(() => {
        this.sweepStaleUdpPeers();
        this.sweepStaleMdnsPeers();
      }, UDP_SWEEP_INTERVAL_MS);
      this.udpSweepTimer.unref?.();
    }
  }

  private buildBeaconPayload(): UdpBeaconPayload | null {
    if (!this.advertisedProfile?.deviceId || !Number.isFinite(this.advertisedWsPort) || this.advertisedWsPort <= 0) {
      return null;
    }

    return {
      magic: UDP_DISCOVERY_MAGIC,
      deviceId: this.advertisedProfile.deviceId,
      displayName: this.advertisedProfile.displayName,
      avatarEmoji: this.advertisedProfile.avatarEmoji,
      avatarBg: this.advertisedProfile.avatarBg,
      statusMessage: this.advertisedProfile.statusMessage,
      wsPort: this.advertisedWsPort,
      appVersion: APP_VERSION,
      sentAt: Date.now()
    };
  }

  private collectUdpTargets(): string[] {
    const targets = new Set<string>();
    targets.add('255.255.255.255');
    targets.add(UDP_DISCOVERY_MULTICAST_GROUP);

    const nets = networkInterfaces();
    for (const entries of Object.values(nets)) {
      if (!entries) continue;
      for (const entry of entries) {
        if (!entry || entry.family !== 'IPv4' || entry.internal) continue;
        const broadcast = computeBroadcastAddress(entry.address, entry.netmask);
        if (broadcast) {
          targets.add(broadcast);
        }
      }
    }

    const knownPeers = [...this.mdnsPeers.values(), ...this.udpPeers.values(), ...this.manualPeers.values()];
    for (const peer of knownPeers) {
      if (isIPv4(peer.address)) {
        targets.add(peer.address);
      }
    }

    return Array.from(targets);
  }

  private broadcastUdpBeacon(): void {
    if (!this.udpSocket) {
      return;
    }

    const payload = this.buildBeaconPayload();
    if (!payload) {
      return;
    }

    const packet = Buffer.from(JSON.stringify(payload));
    const targets = this.collectUdpTargets();

    for (const target of targets) {
      this.udpSocket.send(packet, UDP_DISCOVERY_PORT, target, (error) => {
        if (error && this.debugEnabled) {
          console.warn('[Lantern][Discovery] UDP send error:', target, error.message);
        }
      });
    }
  }

  private handleUdpMessage(raw: Buffer, rinfo: RemoteInfo): void {
    let payload: Partial<UdpBeaconPayload>;
    try {
      payload = JSON.parse(raw.toString('utf8')) as Partial<UdpBeaconPayload>;
    } catch {
      return;
    }

    if (!payload || payload.magic !== UDP_DISCOVERY_MAGIC) {
      return;
    }

    const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : '';
    if (!deviceId || deviceId === this.localDeviceId) {
      return;
    }

    const port = Number(payload.wsPort || 0);
    if (!Number.isFinite(port) || port <= 0) {
      return;
    }

    const address = normalizeRemoteAddress(rinfo.address);
    if (!address) {
      return;
    }

    const pendingDown = this.pendingDownTimers.get(deviceId);
    if (pendingDown) {
      clearTimeout(pendingDown);
      this.pendingDownTimers.delete(deviceId);
    }

    const now = Date.now();
    const existingUdp = this.udpPeers.get(deviceId);
    const existingAny = existingUdp || this.mdnsPeers.get(deviceId);

    const next: Peer = {
      deviceId,
      displayName: payload.displayName || existingAny?.displayName || `User ${deviceId.slice(0, 6)}`,
      avatarEmoji: payload.avatarEmoji || existingAny?.avatarEmoji || '🙂',
      avatarBg: payload.avatarBg || existingAny?.avatarBg || '#5c8aff',
      statusMessage: payload.statusMessage || existingAny?.statusMessage || 'Disponível',
      address,
      port,
      appVersion: payload.appVersion || existingAny?.appVersion || APP_VERSION,
      lastSeenAt: now,
      source: 'udp'
    };

    this.udpPeers.set(deviceId, next);

    const mdnsPeer = this.mdnsPeers.get(deviceId);
    if (mdnsPeer) {
      this.mdnsPeers.set(deviceId, {
        ...mdnsPeer,
        displayName: next.displayName || mdnsPeer.displayName,
        avatarEmoji: next.avatarEmoji || mdnsPeer.avatarEmoji,
        avatarBg: next.avatarBg || mdnsPeer.avatarBg,
        statusMessage: next.statusMessage || mdnsPeer.statusMessage,
        port: next.port || mdnsPeer.port,
        lastSeenAt: now
      });
    }

    const changed =
      !existingUdp ||
      existingUdp.address !== next.address ||
      existingUdp.port !== next.port ||
      existingUdp.displayName !== next.displayName ||
      existingUdp.avatarEmoji !== next.avatarEmoji ||
      existingUdp.avatarBg !== next.avatarBg ||
      existingUdp.statusMessage !== next.statusMessage ||
      existingUdp.appVersion !== next.appVersion;

    if (changed) {
      if (this.debugEnabled) {
        console.log('[Lantern][Discovery] udp', JSON.stringify(next));
      }
      this.emit();
    }
  }

  private sweepStaleUdpPeers(): void {
    const now = Date.now();
    let changed = false;

    for (const [deviceId, peer] of Array.from(this.udpPeers.entries())) {
      if (now - peer.lastSeenAt > UDP_PEER_STALE_MS) {
        this.udpPeers.delete(deviceId);
        changed = true;
      }
    }

    if (changed) {
      this.emit();
    }
  }

  private sweepStaleMdnsPeers(): void {
    const now = Date.now();
    let changed = false;

    for (const [deviceId, peer] of Array.from(this.mdnsPeers.entries())) {
      if (this.udpPeers.has(deviceId)) {
        continue;
      }
      if (now - (peer.lastSeenAt || 0) > MDNS_PEER_STALE_MS) {
        this.mdnsPeers.delete(deviceId);
        changed = true;
      }
    }

    if (changed) {
      this.emit();
    }
  }

  private mergePeers(a: Peer, b: Peer): Peer {
    const aPriority = SOURCE_PRIORITY[a.source] || 0;
    const bPriority = SOURCE_PRIORITY[b.source] || 0;

    const preferredSource =
      aPriority === bPriority
        ? (a.lastSeenAt >= b.lastSeenAt ? a.source : b.source)
        : (aPriority > bPriority ? a.source : b.source);

    const newest = a.lastSeenAt >= b.lastSeenAt ? a : b;
    const oldest = newest === a ? b : a;

    return {
      deviceId: newest.deviceId,
      displayName: newest.displayName || oldest.displayName,
      avatarEmoji: newest.avatarEmoji || oldest.avatarEmoji,
      avatarBg: newest.avatarBg || oldest.avatarBg,
      statusMessage: newest.statusMessage || oldest.statusMessage,
      address: newest.address || oldest.address,
      port: newest.port || oldest.port,
      appVersion: newest.appVersion || oldest.appVersion || APP_VERSION,
      lastSeenAt: Math.max(newest.lastSeenAt || 0, oldest.lastSeenAt || 0),
      source: preferredSource
    };
  }

  private buildMergedPeers(): Peer[] {
    const mergedByDevice = new Map<string, Peer>();

    const applyPeer = (peer: Peer): void => {
      if (!peer.deviceId || peer.deviceId === this.localDeviceId) return;
      const current = mergedByDevice.get(peer.deviceId);
      if (!current) {
        mergedByDevice.set(peer.deviceId, peer);
        return;
      }
      mergedByDevice.set(peer.deviceId, this.mergePeers(current, peer));
    };

    for (const peer of this.mdnsPeers.values()) {
      applyPeer(peer);
    }
    for (const peer of this.udpPeers.values()) {
      applyPeer(peer);
    }
    for (const peer of this.manualPeers.values()) {
      applyPeer(peer);
    }

    return Array.from(mergedByDevice.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  private emit(): void {
    const peers = this.buildMergedPeers();
    const signature = peers
      .map((peer) =>
        [
          peer.deviceId,
          peer.displayName,
          peer.avatarEmoji,
          peer.avatarBg,
          peer.statusMessage,
          peer.address,
          String(peer.port),
          peer.appVersion,
          peer.source
        ].join('|')
      )
      .join('||');

    if (signature === this.lastEmitSignature) {
      return;
    }

    this.lastEmitSignature = signature;
    this.onUpdate(peers);
  }
}
