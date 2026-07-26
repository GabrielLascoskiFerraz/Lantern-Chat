export interface CanonicallyOrderedMessage {
  messageId: string;
  createdAt: number;
  serverSeq?: number | null;
}

const normalizedSequence = (message: CanonicallyOrderedMessage): number | null => {
  const value = Number(message.serverSeq);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
};

/**
 * Mensagens confirmadas são ordenadas exclusivamente pela sequência emitida
 * pelo Relay. createdAt só participa enquanto a mensagem ainda é um
 * placeholder local ou ao abrir dados legados sem sequência.
 */
export const compareCanonicalMessages = (
  left: CanonicallyOrderedMessage,
  right: CanonicallyOrderedMessage
): number => {
  const leftSeq = normalizedSequence(left);
  const rightSeq = normalizedSequence(right);
  if (leftSeq !== null && rightSeq !== null) {
    if (leftSeq !== rightSeq) return leftSeq - rightSeq;
  } else if (leftSeq !== null) {
    return -1;
  } else if (rightSeq !== null) {
    return 1;
  }
  const leftTime = Number(left.createdAt) || 0;
  const rightTime = Number(right.createdAt) || 0;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.messageId.localeCompare(right.messageId);
};

export const sortCanonicalMessages = <T extends CanonicallyOrderedMessage>(rows: T[]): T[] =>
  [...rows].sort(compareCanonicalMessages);
