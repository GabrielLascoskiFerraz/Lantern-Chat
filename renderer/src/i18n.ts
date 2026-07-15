import { ClientLocale } from './api/ipcClient';

export const localeLabels: Record<ClientLocale, string> = {
  'pt-BR': 'Português',
  en: 'English',
  es: 'Español'
};

const messages = {
  'pt-BR': {
    welcome: 'Conecte-se ao seu espaço Lantern',
    relay: 'Conexão com o Relay', localAuto: 'Local automático', localManual: 'Local manual',
    external: 'Externo', host: 'Endereço', port: 'Porta', secure: 'Conexão segura (WSS)',
    discover: 'Procurar na rede', searching: 'Procurando...', found: 'Relay encontrado',
    username: 'Usuário', password: 'Senha', enter: 'Entrar', entering: 'Entrando...',
    logout: 'Sair da conta', noRelay: 'Nenhum Relay foi encontrado na rede.', createAccount: 'Criar conta',
    haveAccount: 'Já tenho uma conta', displayName: 'Nome de exibição', accountHint: 'O setor será definido pelo administrador do Relay.'
  },
  en: {
    welcome: 'Connect to your Lantern workspace',
    relay: 'Relay connection', localAuto: 'Local automatic', localManual: 'Local manual',
    external: 'External', host: 'Address', port: 'Port', secure: 'Secure connection (WSS)',
    discover: 'Search network', searching: 'Searching...', found: 'Relay found',
    username: 'Username', password: 'Password', enter: 'Sign in', entering: 'Signing in...',
    logout: 'Sign out', noRelay: 'No Relay was found on the network.', createAccount: 'Create account',
    haveAccount: 'I already have an account', displayName: 'Display name', accountHint: 'Your department will be assigned by the Relay administrator.'
  },
  es: {
    welcome: 'Conéctate a tu espacio Lantern',
    relay: 'Conexión con Relay', localAuto: 'Local automático', localManual: 'Local manual',
    external: 'Externo', host: 'Dirección', port: 'Puerto', secure: 'Conexión segura (WSS)',
    discover: 'Buscar en la red', searching: 'Buscando...', found: 'Relay encontrado',
    username: 'Usuario', password: 'Contraseña', enter: 'Entrar', entering: 'Entrando...',
    logout: 'Cerrar sesión', noRelay: 'No se encontró ningún Relay en la red.', createAccount: 'Crear cuenta',
    haveAccount: 'Ya tengo una cuenta', displayName: 'Nombre visible', accountHint: 'El administrador del Relay asignará tu sector.'
  }
} as const;

export type TranslationKey = keyof typeof messages['pt-BR'];
export const translate = (locale: ClientLocale, key: TranslationKey): string => messages[locale][key];
