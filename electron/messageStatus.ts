// Estados visíveis da mensagem:
// - sent: ainda aguarda confirmação do Relay;
// - delivered: o Relay confirmou a persistência canônica;
// - read: o destinatário confirmou a leitura.
export const RELAY_ACCEPTED_MESSAGE_STATUS = 'delivered' as const;

