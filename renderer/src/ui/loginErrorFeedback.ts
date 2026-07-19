import type { RelayConnectionMode } from '../api/ipcClient';

export type LoginFeedbackTone = 'info' | 'success' | 'warning' | 'error';
export type LoginFeedbackAction = 'retry' | 'discover' | 'review-connection' | null;

export interface LoginFeedbackState {
  title: string;
  message: string;
  tone: LoginFeedbackTone;
  action: LoginFeedbackAction;
}

export const readableLoginError = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim() || fallback;
};

export const describeLoginError = (
  error: unknown,
  mode: RelayConnectionMode,
  creating: boolean
): LoginFeedbackState => {
  const message = readableLoginError(error, creating ? 'Não foi possível criar a conta.' : 'Não foi possível entrar.');
  const normalized = message.toLocaleLowerCase('pt-BR');

  if (
    normalized.includes('usuário ou senha') ||
    normalized.includes('usuario ou senha') ||
    normalized.includes('credenciais')
  ) {
    return {
      title: 'Dados de acesso incorretos',
      message: 'Confira o usuário e a senha. Se esta for uma conta temporária, deixe a senha em branco no primeiro acesso.',
      tone: 'error',
      action: null
    };
  }

  if (normalized.includes('desativad') || normalized.includes('bloquead')) {
    return {
      title: 'Conta indisponível',
      message,
      tone: 'error',
      action: null
    };
  }

  if (normalized.includes('certific') || normalized.includes('conexão segura')) {
    return {
      title: 'Conexão segura não validada',
      message,
      tone: 'error',
      action: 'review-connection'
    };
  }

  if (normalized.includes('endereço') && normalized.includes('não foi encontrado')) {
    return {
      title: 'Relay não encontrado',
      message,
      tone: 'error',
      action: 'review-connection'
    };
  }

  if (normalized.includes('não parece ser um relay lantern')) {
    return {
      title: 'Endereço incompatível',
      message,
      tone: 'error',
      action: 'review-connection'
    };
  }

  const isConnectionError = [
    'conectar ao relay',
    'conexão com o relay',
    'não está aceitando conexões',
    'não foi possível alcançar',
    'demorou demais',
    'relay offline',
    'fetch failed',
    'econnrefused',
    'etimedout',
    'enotfound'
  ].some((term) => normalized.includes(term));

  if (isConnectionError) {
    return {
      title: 'Relay indisponível',
      message: mode === 'local-auto'
        ? 'Nenhum Relay respondeu. Confirme que o Relay está aberto neste computador ou na mesma rede e tente novamente.'
        : message,
      tone: 'error',
      action: mode === 'local-auto' ? 'discover' : 'retry'
    };
  }

  if (normalized.includes('informe o endereço') || normalized.includes('porta')) {
    return {
      title: 'Revise a conexão',
      message,
      tone: 'warning',
      action: 'review-connection'
    };
  }

  if (
    normalized.includes('já existe') ||
    normalized.includes('deve ter pelo menos') ||
    normalized.includes('inválido') ||
    normalized.includes('invalido')
  ) {
    return {
      title: creating ? 'Revise os dados da conta' : 'Não foi possível entrar',
      message,
      tone: 'error',
      action: null
    };
  }

  return {
    title: creating ? 'Não foi possível criar a conta' : 'Não foi possível entrar',
    message,
    tone: 'error',
    action: 'retry'
  };
};
