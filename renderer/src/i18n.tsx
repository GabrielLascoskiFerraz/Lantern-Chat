import { createContext, ReactNode, useContext, useEffect, useMemo } from 'react';

export type SupportedLocale = 'pt-BR' | 'en' | 'es' | 'fr';
export type LanguageMode = 'auto' | SupportedLocale;

export interface LanguageSettings {
  mode: LanguageMode;
  resolved: SupportedLocale;
  systemLocale: string;
}

type TranslationParams = Record<string, string | number>;
type TranslationTable = Record<string, string>;

const translations: Record<SupportedLocale, TranslationTable> = {
  'pt-BR': {
    'Profile': 'Perfil',
    'Display name': 'Nome de exibição',
    'Status message': 'Mensagem de status',
    'Choose your emoji': 'Escolha seu emoji',
    'Profile color': 'Cor do perfil',
    'Relay connection': 'Conexão com Relay',
    'Automatic': 'Automático',
    'Connected': 'Conectado',
    'Disconnected': 'Desconectado',
    'Rediscover now': 'Redetectar agora',
    'Rediscovering...': 'Redetectando...',
    'Startup': 'Inicialização',
    'Start with the system': 'Iniciar com o sistema',
    'Enabled': 'Ativado',
    'Disabled': 'Desativado',
    'Do not disturb': 'Não perturbe',
    'Turn off': 'Desativar',
    'Until tomorrow': 'Até amanhã',
    'Default download folder': 'Pasta padrão de recebimento',
    'Choose folder': 'Escolher pasta',
    'Local backup and restore': 'Backup e restauração local',
    'Create backup': 'Criar backup',
    'Restore backup': 'Restaurar backup',
    'Language': 'Idioma',
    'Use system language': 'Usar idioma do sistema',
    Theme: 'Tema',
    'Choose how Lantern looks on this device.': 'Escolha como o Lantern aparece neste dispositivo.',
    System: 'Sistema',
    Light: 'Claro',
    Dark: 'Escuro',
    'Follow device': 'Acompanha o dispositivo',
    'Bright surfaces': 'Superfícies luminosas',
    'Less screen glare': 'Menos brilho na tela',
    'Portuguese (Brazil)': 'Português (Brasil)',
    'English': 'Inglês',
    'Spanish': 'Espanhol',
    'French': 'Francês',
    'Cancel': 'Cancelar',
    'Save': 'Salvar',
    'Available': 'Disponível',
    'In a meeting': 'Em reunião',
    'Focused': 'Foco total',
    'Be right back': 'Volto já',
    'Use emoji': 'Usar Emoji',
    'Copy your custom emoji here': 'Cole seu emoji personalizado aqui',
    'IP/Relay host (e.g. 192.168.0.50)': 'IP/host do Relay (ex.: 192.168.0.50)',
    'Port': 'Porta',
    'Automatic uses local network discovery. Manual forces a specific Relay.': 'Automático usa descoberta na rede local. Manual força um Relay específico.',
    'Native notifications and sounds are silenced for the selected period.': 'Silencia notificações nativas e sons pelo período escolhido.',
    'New received files will be saved in this folder.': 'Os novos arquivos recebidos serão salvos nesta pasta.',
    'The backup includes local history (SQLite) and Lantern attachments.': 'O backup inclui histórico local (SQLite) e anexos do Lantern.',
    'After restoring, the app restarts automatically to apply the data.': 'Ao restaurar, o aplicativo reinicia automaticamente para aplicar os dados.',
    'No conversation open': 'Nenhuma conversa aberta',
    'Select a conversation, group, or announcement in the sidebar.': 'Selecione uma conversa, grupo ou anúncio na sidebar.',
    'Could not open this conversation': 'Não foi possível abrir esta conversa',
    'Try again': 'Tentar novamente',
    'Today': 'Hoje',
    'Yesterday': 'Ontem',
    'Delivered': 'Entregue',
    'Not sent': 'Não enviada',
    'Pending': 'Pendente',
    'Offline': 'Offline',
    'Online': 'Online',
    'Contacts': 'Contatos',
    'Announcements': 'Anúncios',
    'Search': 'Pesquisar',
    'Settings': 'Configurações',
    'New': 'Novo',
    'Groups': 'Grupos',
    'Archived': 'Arquivadas',
    'Messages for everyone': 'Mensagens para todos',
    '{online}/{total} participants online': '{online}/{total} participantes online',
    'Syncing participants...': 'Sincronizando participantes...',
    'Relay offline': 'Relay offline',
    '{count} unread singular': '{count} não lida',
    '{count} unread plural': '{count} não lidas',
    '{count} online': '{count} online',
    '{count} participant singular': '{count} participante',
    '{count} participant plural': '{count} participantes',
    'No messages yet': 'Sem mensagens ainda',
    'Type a message': 'Digite sua mensagem',
    'Attach': 'Anexar',
    'Send': 'Enviar',
    'Connected to Relay': 'Conectado ao Relay',
    'Not connected to Relay': 'Não conectado ao Relay',
    'Custom status': 'Status personalizado',
    'Group': 'Grupo',
    'Typing...': 'digitando...',
    'Offline · no connection right now': 'Offline · sem conexão no momento',
    'Search in conversation': 'Buscar nesta conversa',
    'Pin conversation to top': 'Fixar conversa no topo',
    'Unpin conversation': 'Desfixar conversa'
    , 'This group no longer exists on Relay. Sending is blocked, but you can delete the conversation locally.': 'Este grupo não existe mais no Relay. O envio está bloqueado, mas você pode excluir a conversa localmente.'
    , 'No Relay connection. Messages and attachments cannot be sent to this group right now.': 'Sem conexão com o Relay. Não é possível enviar mensagens ou anexos neste grupo agora.'
    , 'This contact is offline. Your messages and attachments will stay pending and send when they return.': 'Este contato está offline. Suas mensagens e anexos ficarão pendentes e serão enviados quando ele voltar.'
  },
  en: {
    'Profile': 'Profile',
    'Display name': 'Display name',
    'Status message': 'Status message',
    'Choose your emoji': 'Choose your emoji',
    'Profile color': 'Profile color',
    'Relay connection': 'Relay connection',
    'Automatic': 'Automatic',
    'Connected': 'Connected',
    'Disconnected': 'Disconnected',
    'Rediscover now': 'Rediscover now',
    'Rediscovering...': 'Rediscovering...',
    'Startup': 'Startup',
    'Start with the system': 'Start with the system',
    'Enabled': 'Enabled',
    'Disabled': 'Disabled',
    'Do not disturb': 'Do not disturb',
    'Turn off': 'Turn off',
    'Until tomorrow': 'Until tomorrow',
    'Default download folder': 'Default download folder',
    'Choose folder': 'Choose folder',
    'Local backup and restore': 'Local backup and restore',
    'Create backup': 'Create backup',
    'Restore backup': 'Restore backup',
    'Language': 'Language',
    'Use system language': 'Use system language',
    'Theme': 'Theme',
    'Choose how Lantern looks on this device.': 'Choose how Lantern looks on this device.',
    'System': 'System',
    'Light': 'Light',
    'Dark': 'Dark',
    'Follow device': 'Follow device',
    'Bright surfaces': 'Bright surfaces',
    'Less screen glare': 'Less screen glare',
    'Portuguese (Brazil)': 'Portuguese (Brazil)',
    'English': 'English',
    'Spanish': 'Spanish',
    'French': 'French',
    'Cancel': 'Cancel',
    'Save': 'Save',
    'Available': 'Available',
    'In a meeting': 'In a meeting',
    'Focused': 'Focused',
    'Be right back': 'Be right back',
    'Use emoji': 'Use emoji',
    'Copy your custom emoji here': 'Paste your custom emoji here',
    'IP/Relay host (e.g. 192.168.0.50)': 'Relay IP/host (e.g. 192.168.0.50)',
    'Port': 'Port',
    'Automatic uses local network discovery. Manual forces a specific Relay.': 'Automatic uses local network discovery. Manual forces a specific Relay.',
    'Native notifications and sounds are silenced for the selected period.': 'Native notifications and sounds are silenced for the selected period.',
    'New received files will be saved in this folder.': 'New received files will be saved in this folder.',
    'The backup includes local history (SQLite) and Lantern attachments.': 'The backup includes local history (SQLite) and Lantern attachments.',
    'After restoring, the app restarts automatically to apply the data.': 'After restoring, the app restarts automatically to apply the data.',
    'No conversation open': 'No conversation open',
    'Select a conversation, group, or announcement in the sidebar.': 'Select a conversation, group, or announcement in the sidebar.',
    'Could not open this conversation': 'Could not open this conversation',
    'Try again': 'Try again',
    'Today': 'Today',
    'Yesterday': 'Yesterday',
    'Delivered': 'Delivered',
    'Not sent': 'Not sent',
    'Pending': 'Pending',
    'Offline': 'Offline',
    'Online': 'Online',
    'Contacts': 'Contacts',
    'Announcements': 'Announcements',
    'Search': 'Search',
    'Settings': 'Settings',
    'New': 'New',
    'Groups': 'Groups',
    'Archived': 'Archived',
    'Messages for everyone': 'Messages for everyone',
    '{online}/{total} participants online': '{online}/{total} participants online',
    'Syncing participants...': 'Syncing participants...',
    'Relay offline': 'Relay offline',
    '{count} unread singular': '{count} unread',
    '{count} unread plural': '{count} unread',
    '{count} online': '{count} online',
    '{count} participant singular': '{count} participant',
    '{count} participant plural': '{count} participants',
    'No messages yet': 'No messages yet',
    'Type a message': 'Type a message',
    'Attach': 'Attach',
    'Send': 'Send',
    'Connected to Relay': 'Connected to Relay',
    'Not connected to Relay': 'Not connected to Relay',
    'Custom status': 'Custom status',
    'Group': 'Group',
    'Typing...': 'typing...',
    'Offline · no connection right now': 'Offline · no connection right now',
    'Search in conversation': 'Search in conversation',
    'Pin conversation to top': 'Pin conversation to top',
    'Unpin conversation': 'Unpin conversation'
    , 'This group no longer exists on Relay. Sending is blocked, but you can delete the conversation locally.': 'This group no longer exists on Relay. Sending is blocked, but you can delete the conversation locally.'
    , 'No Relay connection. Messages and attachments cannot be sent to this group right now.': 'No Relay connection. Messages and attachments cannot be sent to this group right now.'
    , 'This contact is offline. Your messages and attachments will stay pending and send when they return.': 'This contact is offline. Your messages and attachments will stay pending and send when they return.'
  },
  es: {
    'Profile': 'Perfil',
    'Display name': 'Nombre para mostrar',
    'Status message': 'Mensaje de estado',
    'Choose your emoji': 'Elige tu emoji',
    'Profile color': 'Color del perfil',
    'Relay connection': 'Conexión con Relay',
    'Automatic': 'Automático',
    'Connected': 'Conectado',
    'Disconnected': 'Desconectado',
    'Rediscover now': 'Buscar de nuevo',
    'Rediscovering...': 'Buscando...',
    'Startup': 'Inicio',
    'Start with the system': 'Iniciar con el sistema',
    'Enabled': 'Activado',
    'Disabled': 'Desactivado',
    'Do not disturb': 'No molestar',
    'Turn off': 'Desactivar',
    'Until tomorrow': 'Hasta mañana',
    'Default download folder': 'Carpeta de descargas predeterminada',
    'Choose folder': 'Elegir carpeta',
    'Local backup and restore': 'Copia y restauración local',
    'Create backup': 'Crear copia',
    'Restore backup': 'Restaurar copia',
    'Language': 'Idioma',
    'Use system language': 'Usar idioma del sistema',
    'Theme': 'Tema',
    'Choose how Lantern looks on this device.': 'Elige cómo se ve Lantern en este dispositivo.',
    'System': 'Sistema',
    'Light': 'Claro',
    'Dark': 'Oscuro',
    'Follow device': 'Sigue al dispositivo',
    'Bright surfaces': 'Superficies claras',
    'Less screen glare': 'Menos brillo en pantalla',
    'Portuguese (Brazil)': 'Portugués (Brasil)',
    'English': 'Inglés',
    'Spanish': 'Español',
    'French': 'Francés',
    'Cancel': 'Cancelar',
    'Save': 'Guardar',
    'Available': 'Disponible',
    'In a meeting': 'En reunión',
    'Focused': 'Concentrado',
    'Be right back': 'Vuelvo enseguida',
    'Use emoji': 'Usar emoji',
    'No conversation open': 'Ninguna conversación abierta',
    'Select a conversation, group, or announcement in the sidebar.': 'Selecciona una conversación, grupo o anuncio en la barra lateral.',
    'Could not open this conversation': 'No se pudo abrir esta conversación',
    'Try again': 'Intentar de nuevo',
    'Today': 'Hoy',
    'Yesterday': 'Ayer',
    'Delivered': 'Entregado',
    'Not sent': 'No enviado',
    'Pending': 'Pendiente',
    'Offline': 'Sin conexión',
    'Online': 'En línea',
    'Contacts': 'Contactos',
    'Announcements': 'Anuncios',
    'Search': 'Buscar',
    'Settings': 'Configuración',
    'New': 'Nuevo',
    'Groups': 'Grupos',
    'Archived': 'Archivadas',
    'Messages for everyone': 'Mensajes para todos',
    '{online}/{total} participants online': '{online}/{total} participantes en línea',
    'Syncing participants...': 'Sincronizando participantes...',
    'Relay offline': 'Relay sin conexión',
    '{count} unread singular': '{count} no leída',
    '{count} unread plural': '{count} no leídas',
    '{count} online': '{count} en línea',
    '{count} participant singular': '{count} participante',
    '{count} participant plural': '{count} participantes',
    'No messages yet': 'Aún no hay mensajes',
    'Type a message': 'Escribe un mensaje',
    'Attach': 'Adjuntar',
    'Send': 'Enviar',
    'Connected to Relay': 'Conectado al Relay',
    'Not connected to Relay': 'No conectado al Relay',
    'Custom status': 'Estado personalizado',
    'Group': 'Grupo',
    'Typing...': 'escribiendo...',
    'Offline · no connection right now': 'Sin conexión · sin conexión en este momento',
    'Search in conversation': 'Buscar en la conversación',
    'Pin conversation to top': 'Fijar conversación arriba',
    'Unpin conversation': 'Desfijar conversación'
    , 'This group no longer exists on Relay. Sending is blocked, but you can delete the conversation locally.': 'Este grupo ya no existe en el Relay. El envío está bloqueado, pero puedes eliminar la conversación local.'
    , 'No Relay connection. Messages and attachments cannot be sent to this group right now.': 'Sin conexión con el Relay. No se pueden enviar mensajes ni adjuntos a este grupo ahora.'
    , 'This contact is offline. Your messages and attachments will stay pending and send when they return.': 'Este contacto está sin conexión. Tus mensajes y adjuntos quedarán pendientes y se enviarán cuando vuelva.'
  },
  fr: {
    'Profile': 'Profil',
    'Display name': 'Nom affiché',
    'Status message': 'Message de statut',
    'Choose your emoji': 'Choisissez votre emoji',
    'Profile color': 'Couleur du profil',
    'Relay connection': 'Connexion au Relay',
    'Automatic': 'Automatique',
    'Connected': 'Connecté',
    'Disconnected': 'Déconnecté',
    'Rediscover now': 'Rechercher à nouveau',
    'Rediscovering...': 'Recherche en cours...',
    'Startup': 'Démarrage',
    'Start with the system': 'Démarrer avec le système',
    'Enabled': 'Activé',
    'Disabled': 'Désactivé',
    'Do not disturb': 'Ne pas déranger',
    'Turn off': 'Désactiver',
    'Until tomorrow': 'Jusqu’à demain',
    'Default download folder': 'Dossier de réception par défaut',
    'Choose folder': 'Choisir un dossier',
    'Local backup and restore': 'Sauvegarde et restauration locales',
    'Create backup': 'Créer une sauvegarde',
    'Restore backup': 'Restaurer une sauvegarde',
    'Language': 'Langue',
    'Use system language': 'Utiliser la langue du système',
    'Theme': 'Thème',
    'Choose how Lantern looks on this device.': 'Choisissez l’apparence de Lantern sur cet appareil.',
    'System': 'Système',
    'Light': 'Clair',
    'Dark': 'Sombre',
    'Follow device': 'Suit l’appareil',
    'Bright surfaces': 'Surfaces lumineuses',
    'Less screen glare': 'Moins de luminosité à l’écran',
    'Portuguese (Brazil)': 'Portugais (Brésil)',
    'English': 'Anglais',
    'Spanish': 'Espagnol',
    'French': 'Français',
    'Cancel': 'Annuler',
    'Save': 'Enregistrer',
    'Available': 'Disponible',
    'In a meeting': 'En réunion',
    'Focused': 'Concentré',
    'Be right back': 'Je reviens',
    'Use emoji': 'Utiliser l’emoji',
    'No conversation open': 'Aucune conversation ouverte',
    'Select a conversation, group, or announcement in the sidebar.': 'Sélectionnez une conversation, un groupe ou une annonce dans la barre latérale.',
    'Could not open this conversation': 'Impossible d’ouvrir cette conversation',
    'Try again': 'Réessayer',
    'Today': 'Aujourd’hui',
    'Yesterday': 'Hier',
    'Delivered': 'Distribué',
    'Not sent': 'Non envoyé',
    'Pending': 'En attente',
    'Offline': 'Hors ligne',
    'Online': 'En ligne',
    'Contacts': 'Contacts',
    'Announcements': 'Annonces',
    'Search': 'Rechercher',
    'Settings': 'Paramètres',
    'New': 'Nouveau',
    'Groups': 'Groupes',
    'Archived': 'Archivées',
    'Messages for everyone': 'Messages pour tous',
    '{online}/{total} participants online': '{online}/{total} participants en ligne',
    'Syncing participants...': 'Synchronisation des participants...',
    'Relay offline': 'Relay hors ligne',
    '{count} unread singular': '{count} non lu',
    '{count} unread plural': '{count} non lus',
    '{count} online': '{count} en ligne',
    '{count} participant singular': '{count} participant',
    '{count} participant plural': '{count} participants',
    'No messages yet': 'Aucun message pour le moment',
    'Type a message': 'Écrivez un message',
    'Attach': 'Joindre',
    'Send': 'Envoyer',
    'Connected to Relay': 'Connecté au Relay',
    'Not connected to Relay': 'Non connecté au Relay',
    'Custom status': 'Statut personnalisé',
    'Group': 'Groupe',
    'Typing...': 'écrit...',
    'Offline · no connection right now': 'Hors ligne · aucune connexion actuellement',
    'Search in conversation': 'Rechercher dans la conversation',
    'Pin conversation to top': 'Épingler la conversation en haut',
    'Unpin conversation': 'Désépingler la conversation'
    , 'This group no longer exists on Relay. Sending is blocked, but you can delete the conversation locally.': 'Ce groupe n’existe plus sur le Relay. L’envoi est bloqué, mais vous pouvez supprimer la conversation locale.'
    , 'No Relay connection. Messages and attachments cannot be sent to this group right now.': 'Aucune connexion au Relay. Les messages et pièces jointes ne peuvent pas être envoyés à ce groupe pour le moment.'
    , 'This contact is offline. Your messages and attachments will stay pending and send when they return.': 'Ce contact est hors ligne. Vos messages et pièces jointes resteront en attente et seront envoyés à son retour.'
  }
};

const replaceParams = (value: string, params?: TranslationParams): string =>
  value.replace(/\{(\w+)\}/g, (_, key: string) => String(params?.[key] ?? `{${key}}`));

export const translate = (locale: SupportedLocale, key: string, params?: TranslationParams): string =>
  replaceParams(translations[locale][key] || legacyTranslations[key]?.[locale] || key, params);

interface I18nContextValue {
  locale: SupportedLocale;
  languageSettings: LanguageSettings;
  t: (key: string, params?: TranslationParams) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export const I18nProvider = ({
  settings,
  children
}: {
  settings: LanguageSettings;
  children: ReactNode;
}) => {
  const value = useMemo<I18nContextValue>(
    () => ({
      locale: settings.resolved,
      languageSettings: settings,
      t: (key, params) => translate(settings.resolved, key, params)
    }),
    [settings]
  );
  return (
    <I18nContext.Provider value={value}>
      {children}
      <LegacyDomLocalizer />
    </I18nContext.Provider>
  );
};

export const useI18n = (): I18nContextValue => {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error('useI18n must be used inside I18nProvider.');
  }
  return value;
};

export const localeForDate = (locale: SupportedLocale): string => locale;

/*
 * Most of the application predates the i18n layer and still renders static
 * Portuguese labels directly. This bridge localizes only known UI phrases and
 * attributes, deliberately leaving message bodies, names and user text alone.
 */
const legacyTranslations: Record<string, Record<SupportedLocale, string>> = {
  'Confirmar': { 'pt-BR': 'Confirmar', en: 'Confirm', es: 'Confirmar', fr: 'Confirmer' },
  'Cancelar': { 'pt-BR': 'Cancelar', en: 'Cancel', es: 'Cancelar', fr: 'Annuler' },
  'Fechar': { 'pt-BR': 'Fechar', en: 'Close', es: 'Cerrar', fr: 'Fermer' },
  'Salvar': { 'pt-BR': 'Salvar', en: 'Save', es: 'Guardar', fr: 'Enregistrer' },
  'Excluir': { 'pt-BR': 'Excluir', en: 'Delete', es: 'Eliminar', fr: 'Supprimer' },
  'Editar': { 'pt-BR': 'Editar', en: 'Edit', es: 'Editar', fr: 'Modifier' },
  'Responder': { 'pt-BR': 'Responder', en: 'Reply', es: 'Responder', fr: 'Répondre' },
  'Encaminhar': { 'pt-BR': 'Encaminhar', en: 'Forward', es: 'Reenviar', fr: 'Transférer' },
  'Copiar': { 'pt-BR': 'Copiar', en: 'Copy', es: 'Copiar', fr: 'Copier' },
  'Colar': { 'pt-BR': 'Colar', en: 'Paste', es: 'Pegar', fr: 'Coller' },
  'Recortar': { 'pt-BR': 'Recortar', en: 'Cut', es: 'Cortar', fr: 'Couper' },
  'Copiar texto': { 'pt-BR': 'Copiar texto', en: 'Copy text', es: 'Copiar texto', fr: 'Copier le texte' },
  'Apagar para mim': { 'pt-BR': 'Apagar para mim', en: 'Delete for me', es: 'Eliminar para mí', fr: 'Supprimer pour moi' },
  'Apagar para todos': { 'pt-BR': 'Apagar para todos', en: 'Delete for everyone', es: 'Eliminar para todos', fr: 'Supprimer pour tous' },
  'Limpar conversa': { 'pt-BR': 'Limpar conversa', en: 'Clear conversation', es: 'Limpiar conversación', fr: 'Effacer la conversation' },
  'Excluir contato e conversa': { 'pt-BR': 'Excluir contato e conversa', en: 'Delete contact and conversation', es: 'Eliminar contacto y conversación', fr: 'Supprimer le contact et la conversation' },
  'Ressincronizar conversa': { 'pt-BR': 'Ressincronizar conversa', en: 'Resync conversation', es: 'Resincronizar conversación', fr: 'Resynchroniser la conversation' },
  'Ressincronizar grupo': { 'pt-BR': 'Ressincronizar grupo', en: 'Resync group', es: 'Resincronizar grupo', fr: 'Resynchroniser le groupe' },
  'Exportar TXT': { 'pt-BR': 'Exportar TXT', en: 'Export TXT', es: 'Exportar TXT', fr: 'Exporter en TXT' },
  'Exportar HTML': { 'pt-BR': 'Exportar HTML', en: 'Export HTML', es: 'Exportar HTML', fr: 'Exporter en HTML' },
  'Marcar como não lida': { 'pt-BR': 'Marcar como não lida', en: 'Mark as unread', es: 'Marcar como no leída', fr: 'Marquer comme non lu' },
  'Favoritar mensagem': { 'pt-BR': 'Favoritar mensagem', en: 'Favorite message', es: 'Destacar mensaje', fr: 'Ajouter aux favoris' },
  'Remover dos favoritos': { 'pt-BR': 'Remover dos favoritos', en: 'Remove from favorites', es: 'Quitar de destacados', fr: 'Retirer des favoris' },
  'Fixar no grupo': { 'pt-BR': 'Fixar no grupo', en: 'Pin in group', es: 'Fijar en el grupo', fr: 'Épingler dans le groupe' },
  'Desfixar no grupo': { 'pt-BR': 'Desfixar no grupo', en: 'Unpin in group', es: 'Desfijar en el grupo', fr: 'Désépingler du groupe' },
  'Grupos': { 'pt-BR': 'Grupos', en: 'Groups', es: 'Grupos', fr: 'Groupes' },
  'Arquivadas': { 'pt-BR': 'Arquivadas', en: 'Archived', es: 'Archivadas', fr: 'Archivées' },
  'Criar grupo': { 'pt-BR': 'Criar grupo', en: 'Create group', es: 'Crear grupo', fr: 'Créer un groupe' },
  'Criar primeiro grupo': { 'pt-BR': 'Criar primeiro grupo', en: 'Create your first group', es: 'Crear el primer grupo', fr: 'Créer votre premier groupe' },
  'Novo grupo': { 'pt-BR': 'Novo grupo', en: 'New group', es: 'Nuevo grupo', fr: 'Nouveau groupe' },
  'Detalhes do grupo': { 'pt-BR': 'Detalhes do grupo', en: 'Group details', es: 'Detalles del grupo', fr: 'Détails du groupe' },
  'Sair do grupo': { 'pt-BR': 'Sair do grupo', en: 'Leave group', es: 'Salir del grupo', fr: 'Quitter le groupe' },
  'Excluir grupo': { 'pt-BR': 'Excluir grupo', en: 'Delete group', es: 'Eliminar grupo', fr: 'Supprimer le groupe' },
  'Participantes': { 'pt-BR': 'Participantes', en: 'Participants', es: 'Participantes', fr: 'Participants' },
  'Adicionar participantes': { 'pt-BR': 'Adicionar participantes', en: 'Add participants', es: 'Agregar participantes', fr: 'Ajouter des participants' },
  'Adicionar selecionados': { 'pt-BR': 'Adicionar selecionados', en: 'Add selected', es: 'Agregar seleccionados', fr: 'Ajouter la sélection' },
  'Nenhum contato disponível para adicionar.': { 'pt-BR': 'Nenhum contato disponível para adicionar.', en: 'No contacts available to add.', es: 'No hay contactos disponibles para agregar.', fr: 'Aucun contact disponible à ajouter.' },
  'Permissões': { 'pt-BR': 'Permissões', en: 'Permissions', es: 'Permisos', fr: 'Autorisations' },
  'Tornar admin': { 'pt-BR': 'Tornar admin', en: 'Make admin', es: 'Hacer administrador', fr: 'Nommer administrateur' },
  'Tornar membro': { 'pt-BR': 'Tornar membro', en: 'Make member', es: 'Hacer miembro', fr: 'Nommer membre' },
  'Tornar dono': { 'pt-BR': 'Tornar dono', en: 'Make owner', es: 'Hacer propietario', fr: 'Nommer propriétaire' },
  'Encaminhar para': { 'pt-BR': 'Encaminhar para', en: 'Forward to', es: 'Reenviar a', fr: 'Transférer à' },
  'Contatos para encaminhar': { 'pt-BR': 'Contatos para encaminhar', en: 'Contacts to forward to', es: 'Contactos para reenviar', fr: 'Contacts destinataires' },
  'Nenhum contato encontrado.': { 'pt-BR': 'Nenhum contato encontrado.', en: 'No contacts found.', es: 'No se encontraron contactos.', fr: 'Aucun contact trouvé.' },
  'Pesquisar contatos': { 'pt-BR': 'Pesquisar contatos', en: 'Search contacts', es: 'Buscar contactos', fr: 'Rechercher des contacts' },
  'Buscar contato...': { 'pt-BR': 'Buscar contato...', en: 'Search contact...', es: 'Buscar contacto...', fr: 'Rechercher un contact...' },
  'Buscar nesta conversa': { 'pt-BR': 'Buscar nesta conversa', en: 'Search in this conversation', es: 'Buscar en esta conversación', fr: 'Rechercher dans cette conversation' },
  'Nenhuma mensagem favorita nesta conversa.': { 'pt-BR': 'Nenhuma mensagem favorita nesta conversa.', en: 'No favorite messages in this conversation.', es: 'No hay mensajes destacados en esta conversación.', fr: 'Aucun message favori dans cette conversation.' },
  'Nenhuma mensagem fixada neste grupo.': { 'pt-BR': 'Nenhuma mensagem fixada neste grupo.', en: 'No messages pinned in this group.', es: 'No hay mensajes fijados en este grupo.', fr: 'Aucun message épinglé dans ce groupe.' },
  'Novas mensagens': { 'pt-BR': 'Novas mensagens', en: 'New messages', es: 'Mensajes nuevos', fr: 'Nouveaux messages' },
  'Encaminhada': { 'pt-BR': 'Encaminhada', en: 'Forwarded', es: 'Reenviado', fr: 'Transféré' },
  'Esta mensagem foi apagada.': { 'pt-BR': 'Esta mensagem foi apagada.', en: 'This message was deleted.', es: 'Este mensaje fue eliminado.', fr: 'Ce message a été supprimé.' },
  'editada': { 'pt-BR': 'editada', en: 'edited', es: 'editado', fr: 'modifié' },
  'Reações da mensagem': { 'pt-BR': 'Reações da mensagem', en: 'Message reactions', es: 'Reacciones del mensaje', fr: 'Réactions au message' },
  'Nenhuma reação nesta mensagem.': { 'pt-BR': 'Nenhuma reação nesta mensagem.', en: 'No reactions on this message.', es: 'No hay reacciones en este mensaje.', fr: 'Aucune réaction sur ce message.' },
  'Carregando...': { 'pt-BR': 'Carregando...', en: 'Loading...', es: 'Cargando...', fr: 'Chargement...' },
  'Nenhum registro ainda.': { 'pt-BR': 'Nenhum registro ainda.', en: 'No records yet.', es: 'Aún no hay registros.', fr: 'Aucun enregistrement pour le moment.' },
  'Não foi possível enviar este anexo.': { 'pt-BR': 'Não foi possível enviar este anexo.', en: 'Could not send this attachment.', es: 'No se pudo enviar este archivo adjunto.', fr: 'Impossible d’envoyer cette pièce jointe.' },
  'Anexo indisponível neste dispositivo.': { 'pt-BR': 'Anexo indisponível neste dispositivo.', en: 'Attachment unavailable on this device.', es: 'Archivo adjunto no disponible en este dispositivo.', fr: 'Pièce jointe indisponible sur cet appareil.' },
  'Anexo pendente. Envia quando o contato voltar.': { 'pt-BR': 'Anexo pendente. Envia quando o contato voltar.', en: 'Attachment pending. It will send when the contact returns.', es: 'Archivo adjunto pendiente. Se enviará cuando el contacto vuelva.', fr: 'Pièce jointe en attente. Elle sera envoyée au retour du contact.' },
  'aguardando arquivo completo...': { 'pt-BR': 'aguardando arquivo completo...', en: 'waiting for the complete file...', es: 'esperando el archivo completo...', fr: 'en attente du fichier complet...' },
  'Carregando imagem...': { 'pt-BR': 'Carregando imagem...', en: 'Loading image...', es: 'Cargando imagen...', fr: 'Chargement de l’image...' },
  'Pré-visualização indisponível': { 'pt-BR': 'Pré-visualização indisponível', en: 'Preview unavailable', es: 'Vista previa no disponible', fr: 'Aperçu indisponible' },
  'Abrir': { 'pt-BR': 'Abrir', en: 'Open', es: 'Abrir', fr: 'Ouvrir' },
  'Salvar como': { 'pt-BR': 'Salvar como', en: 'Save as', es: 'Guardar como', fr: 'Enregistrer sous' },
  'Concluído': { 'pt-BR': 'Concluído', en: 'Completed', es: 'Completado', fr: 'Terminé' },
  'Editando mensagem': { 'pt-BR': 'Editando mensagem', en: 'Editing message', es: 'Editando mensaje', fr: 'Modification du message' },
  'Você pode editar por até 10 minutos.': { 'pt-BR': 'Você pode editar por até 10 minutos.', en: 'You can edit for up to 10 minutes.', es: 'Puedes editar durante hasta 10 minutos.', fr: 'Vous pouvez modifier pendant 10 minutes maximum.' },
  'Lendo clipboard…': { 'pt-BR': 'Lendo clipboard…', en: 'Reading clipboard…', es: 'Leyendo el portapapeles…', fr: 'Lecture du presse-papiers…' },
  'lendo': { 'pt-BR': 'lendo', en: 'reading', es: 'leyendo', fr: 'lecture' },
  'Remover': { 'pt-BR': 'Remover', en: 'Remove', es: 'Quitar', fr: 'Retirer' },
  'Remover todos': { 'pt-BR': 'Remover todos', en: 'Remove all', es: 'Quitar todos', fr: 'Tout retirer' },
  'Figurinhas do Relay': { 'pt-BR': 'Figurinhas do Relay', en: 'Relay stickers', es: 'Stickers del Relay', fr: 'Stickers du Relay' },
  'Solte os arquivos para anexar': { 'pt-BR': 'Solte os arquivos para anexar', en: 'Drop files to attach', es: 'Suelta archivos para adjuntar', fr: 'Déposez les fichiers à joindre' },
  'Comunicados para todos os usuários online. Eles somem após 24h.': { 'pt-BR': 'Comunicados para todos os usuários online. Eles somem após 24h.', en: 'Announcements for all online users. They expire after 24 hours.', es: 'Anuncios para todos los usuarios en línea. Caducan después de 24 horas.', fr: 'Annonces pour tous les utilisateurs en ligne. Elles expirent après 24 heures.' },
  'Editar anúncio': { 'pt-BR': 'Editar anúncio', en: 'Edit announcement', es: 'Editar anuncio', fr: 'Modifier l’annonce' },
  'Não foi possível renderizar a interface': { 'pt-BR': 'Não foi possível renderizar a interface', en: 'Could not render the interface', es: 'No se pudo mostrar la interfaz', fr: 'Impossible d’afficher l’interface' },
  'O Lantern manteve o processo ativo. Recarregue a interface para tentar novamente.': { 'pt-BR': 'O Lantern manteve o processo ativo. Recarregue a interface para tentar novamente.', en: 'Lantern kept the process running. Reload the interface to try again.', es: 'Lantern mantuvo el proceso activo. Recarga la interfaz para intentarlo de nuevo.', fr: 'Lantern a maintenu le processus actif. Rechargez l’interface pour réessayer.' },
  'Selecione um contato para abrir o histórico da conversa.': { 'pt-BR': 'Selecione um contato para abrir o histórico da conversa.', en: 'Select a contact to open the conversation history.', es: 'Selecciona un contacto para abrir el historial de la conversación.', fr: 'Sélectionnez un contact pour ouvrir l’historique de la conversation.' },
  'Não perturbe': { 'pt-BR': 'Não perturbe', en: 'Do not disturb', es: 'No molestar', fr: 'Ne pas déranger' },
  'Trocar status': { 'pt-BR': 'Trocar status', en: 'Change status', es: 'Cambiar estado', fr: 'Changer le statut' }
  , 'Status personalizado': { 'pt-BR': 'Status personalizado', en: 'Custom status', es: 'Estado personalizado', fr: 'Statut personnalisé' }
  , 'Até amanhã': { 'pt-BR': 'Até amanhã', en: 'Until tomorrow', es: 'Hasta mañana', fr: 'Jusqu’à demain' }
  , 'Nenhum grupo corresponde à pesquisa.': { 'pt-BR': 'Nenhum grupo corresponde à pesquisa.', en: 'No groups match your search.', es: 'Ningún grupo coincide con la búsqueda.', fr: 'Aucun groupe ne correspond à votre recherche.' }
  , 'Nenhuma conversa arquivada corresponde à pesquisa.': { 'pt-BR': 'Nenhuma conversa arquivada corresponde à pesquisa.', en: 'No archived conversations match your search.', es: 'Ninguna conversación archivada coincide con la búsqueda.', fr: 'Aucune conversation archivée ne correspond à votre recherche.' }
  , 'Conectado ao Relay': { 'pt-BR': 'Conectado ao Relay', en: 'Connected to Relay', es: 'Conectado al Relay', fr: 'Connecté au Relay' }
  , 'Não conectado ao Relay': { 'pt-BR': 'Não conectado ao Relay', en: 'Not connected to Relay', es: 'No conectado al Relay', fr: 'Non connecté au Relay' }
  , 'Escolher cor customizada': { 'pt-BR': 'Escolher cor customizada', en: 'Choose custom color', es: 'Elegir color personalizado', fr: 'Choisir une couleur personnalisée' }
  , 'Descrição': { 'pt-BR': 'Descrição', en: 'Description', es: 'Descripción', fr: 'Description' }
  , 'Descrição do grupo': { 'pt-BR': 'Descrição do grupo', en: 'Group description', es: 'Descripción del grupo', fr: 'Description du groupe' }
  , 'Excluir localmente': { 'pt-BR': 'Excluir localmente', en: 'Delete locally', es: 'Eliminar localmente', fr: 'Supprimer localement' }
  , 'Mensagem favoritada': { 'pt-BR': 'Mensagem favoritada', en: 'Favorite message', es: 'Mensaje destacado', fr: 'Message favori' }
  , 'Mensagem fixada no grupo': { 'pt-BR': 'Mensagem fixada no grupo', en: 'Message pinned in group', es: 'Mensaje fijado en el grupo', fr: 'Message épinglé dans le groupe' }
  , 'Editar mensagem': { 'pt-BR': 'Editar mensagem', en: 'Edit message', es: 'Editar mensaje', fr: 'Modifier le message' }
  , 'Cancelar edição': { 'pt-BR': 'Cancelar edição', en: 'Cancel editing', es: 'Cancelar edición', fr: 'Annuler la modification' }
  , 'Enviar': { 'pt-BR': 'Enviar', en: 'Send', es: 'Enviar', fr: 'Envoyer' }
  , 'Nenhum emoji encontrado para': { 'pt-BR': 'Nenhum emoji encontrado para', en: 'No emoji found for', es: 'No se encontró ningún emoji para', fr: 'Aucun emoji trouvé pour' }
  , 'Buscar emoji (ex.: coração, pizza, gato...)': { 'pt-BR': 'Buscar emoji (ex.: coração, pizza, gato...)', en: 'Search emoji (e.g. heart, pizza, cat...)', es: 'Buscar emoji (p. ej., corazón, pizza, gato...)', fr: 'Rechercher un emoji (ex. cœur, pizza, chat...)' }
  , 'Carregando figurinhas...': { 'pt-BR': 'Carregando figurinhas...', en: 'Loading stickers...', es: 'Cargando stickers...', fr: 'Chargement des stickers...' }
  , 'Nenhuma figurinha válida no Relay.': { 'pt-BR': 'Nenhuma figurinha válida no Relay.', en: 'No valid sticker on Relay.', es: 'No hay stickers válidos en el Relay.', fr: 'Aucun sticker valide sur le Relay.' }
  , 'Nenhuma GIF disponível no Relay.': { 'pt-BR': 'Nenhuma GIF disponível no Relay.', en: 'No GIF available on Relay.', es: 'No hay GIF disponible en el Relay.', fr: 'Aucun GIF disponible sur le Relay.' }
  , 'Não foi possível carregar GIFs do Relay.': { 'pt-BR': 'Não foi possível carregar GIFs do Relay.', en: 'Could not load GIFs from Relay.', es: 'No se pudieron cargar los GIF del Relay.', fr: 'Impossible de charger les GIF du Relay.' }
  , 'Aguardando reconexão': { 'pt-BR': 'Aguardando reconexão', en: 'Waiting to reconnect', es: 'Esperando reconexión', fr: 'En attente de reconnexion' }
  , 'Falha definitiva': { 'pt-BR': 'Falha definitiva', en: 'Permanent failure', es: 'Error definitivo', fr: 'Échec définitif' }
  , 'Falha no envio': { 'pt-BR': 'Falha no envio', en: 'Sending failed', es: 'Error al enviar', fr: 'Échec de l’envoi' }
  , 'Baixando novamente{attempt}': { 'pt-BR': 'Baixando novamente{attempt}', en: 'Downloading again{attempt}', es: 'Descargando de nuevo{attempt}', fr: 'Nouveau téléchargement{attempt}' }
  , 'tentativa': { 'pt-BR': 'tentativa', en: 'attempt', es: 'intento', fr: 'tentative' }
  , 'Enviando {percent}%': { 'pt-BR': 'Enviando {percent}%', en: 'Sending {percent}%', es: 'Enviando {percent}%', fr: 'Envoi {percent}%' }
  , 'Recebendo {percent}%': { 'pt-BR': 'Recebendo {percent}%', en: 'Receiving {percent}%', es: 'Recibiendo {percent}%', fr: 'Réception {percent}%' }
  , 'Preparando envio': { 'pt-BR': 'Preparando envio', en: 'Preparing to send', es: 'Preparando el envío', fr: 'Préparation de l’envoi' }
  , 'Processando': { 'pt-BR': 'Processando', en: 'Processing', es: 'Procesando', fr: 'Traitement en cours' }
  , 'Transferência:': { 'pt-BR': 'Transferência:', en: 'Transfer:', es: 'Transferencia:', fr: 'Transfert :' }
  , 'Offline · sem conexão no momento': { 'pt-BR': 'Offline · sem conexão no momento', en: 'Offline · no connection right now', es: 'Sin conexión · sin conexión en este momento', fr: 'Hors ligne · aucune connexion actuellement' }
  , 'digitando...': { 'pt-BR': 'digitando...', en: 'typing...', es: 'escribiendo...', fr: 'écrit...' }
  , 'Grupo': { 'pt-BR': 'Grupo', en: 'Group', es: 'Grupo', fr: 'Groupe' }
  , 'Mensagem': { 'pt-BR': 'Mensagem', en: 'Message', es: 'Mensaje', fr: 'Message' }
  , 'Mensagem sem conteúdo': { 'pt-BR': 'Mensagem sem conteúdo', en: 'Message with no content', es: 'Mensaje sin contenido', fr: 'Message sans contenu' }
  , 'Mensagem indisponível': { 'pt-BR': 'Mensagem indisponível', en: 'Message unavailable', es: 'Mensaje no disponible', fr: 'Message indisponible' }
  , 'Arquivo': { 'pt-BR': 'Arquivo', en: 'File', es: 'Archivo', fr: 'Fichier' }
  , 'Anúncio': { 'pt-BR': 'Anúncio', en: 'Announcement', es: 'Anuncio', fr: 'Annonce' }
  , 'Você': { 'pt-BR': 'Você', en: 'You', es: 'Tú', fr: 'Vous' }
  , 'Participante': { 'pt-BR': 'Participante', en: 'Participant', es: 'Participante', fr: 'Participant' }
  , 'Contato': { 'pt-BR': 'Contato', en: 'Contact', es: 'Contacto', fr: 'Contact' }
  , 'Imagem': { 'pt-BR': 'Imagem', en: 'Image', es: 'Imagen', fr: 'Image' }
  , 'Nenhuma conversa aberta': { 'pt-BR': 'Nenhuma conversa aberta', en: 'No conversation open', es: 'Ninguna conversación abierta', fr: 'Aucune conversation ouverte' }
  , 'Não foi possível abrir esta conversa': { 'pt-BR': 'Não foi possível abrir esta conversa', en: 'Could not open this conversation', es: 'No se pudo abrir esta conversación', fr: 'Impossible d’ouvrir cette conversation' }
  , 'Não foi possível carregar o Lantern': { 'pt-BR': 'Não foi possível carregar o Lantern', en: 'Could not load Lantern', es: 'No se pudo cargar Lantern', fr: 'Impossible de charger Lantern' }
  , 'O perfil local ainda não está disponível.': { 'pt-BR': 'O perfil local ainda não está disponível.', en: 'The local profile is not available yet.', es: 'El perfil local aún no está disponible.', fr: 'Le profil local n’est pas encore disponible.' }
  , 'A conexão com o Relay não deve bloquear a abertura do app. Tente recarregar o estado local.': { 'pt-BR': 'A conexão com o Relay não deve bloquear a abertura do app. Tente recarregar o estado local.', en: 'The Relay connection should not block the app from opening. Try reloading local state.', es: 'La conexión con el Relay no debería impedir que se abra la aplicación. Intenta recargar el estado local.', fr: 'La connexion au Relay ne doit pas empêcher l’ouverture de l’application. Essayez de recharger l’état local.' }
  , 'Sem conexão com o Relay. Não é possível enviar anúncios no momento.': { 'pt-BR': 'Sem conexão com o Relay. Não é possível enviar anúncios no momento.', en: 'No Relay connection. Announcements cannot be sent right now.', es: 'Sin conexión con el Relay. No se pueden enviar anuncios ahora.', fr: 'Aucune connexion au Relay. Les annonces ne peuvent pas être envoyées pour le moment.' }
  , 'Enviar anúncio para todos online': { 'pt-BR': 'Enviar anúncio para todos online', en: 'Send announcement to everyone online', es: 'Enviar anuncio a todos en línea', fr: 'Envoyer une annonce à tous les utilisateurs en ligne' }
  , 'Excluir anúncio': { 'pt-BR': 'Excluir anúncio', en: 'Delete announcement', es: 'Eliminar anuncio', fr: 'Supprimer l’annonce' }
  , 'Reações do anúncio': { 'pt-BR': 'Reações do anúncio', en: 'Announcement reactions', es: 'Reacciones del anuncio', fr: 'Réactions à l’annonce' }
  , 'Leituras do anúncio': { 'pt-BR': 'Leituras do anúncio', en: 'Announcement reads', es: 'Lecturas del anuncio', fr: 'Lectures de l’annonce' }
  , 'Este contato está offline. Suas mensagens e anexos ficarão pendentes e serão enviados quando ele voltar.': { 'pt-BR': 'Este contato está offline. Suas mensagens e anexos ficarão pendentes e serão enviados quando ele voltar.', en: 'This contact is offline. Your messages and attachments will stay pending and send when they return.', es: 'Este contacto está sin conexión. Tus mensajes y adjuntos quedarán pendientes y se enviarán cuando vuelva.', fr: 'Ce contact est hors ligne. Vos messages et pièces jointes resteront en attente et seront envoyés à son retour.' }
  , 'Sem conexão com o Relay. Não é possível enviar mensagens ou anexos neste grupo agora.': { 'pt-BR': 'Sem conexão com o Relay. Não é possível enviar mensagens ou anexos neste grupo agora.', en: 'No Relay connection. Messages or attachments cannot be sent to this group right now.', es: 'Sin conexión con el Relay. No se pueden enviar mensajes ni adjuntos a este grupo ahora.', fr: 'Aucune connexion au Relay. Les messages ou pièces jointes ne peuvent pas être envoyés à ce groupe pour le moment.' }
  , 'Este grupo não existe mais no Relay. O envio está bloqueado, mas você pode excluir a conversa localmente.': { 'pt-BR': 'Este grupo não existe mais no Relay. O envio está bloqueado, mas você pode excluir a conversa localmente.', en: 'This group no longer exists on Relay. Sending is blocked, but you can delete the local conversation.', es: 'Este grupo ya no existe en el Relay. El envío está bloqueado, pero puedes eliminar la conversación local.', fr: 'Ce groupe n’existe plus sur le Relay. L’envoi est bloqué, mais vous pouvez supprimer la conversation locale.' }
  , 'Novo': { 'pt-BR': 'Novo', en: 'New', es: 'Nuevo', fr: 'Nouveau' }
  , 'Arquivar conversa': { 'pt-BR': 'Arquivar conversa', en: 'Archive conversation', es: 'Archivar conversación', fr: 'Archiver la conversation' }
  , 'Desarquivar conversa': { 'pt-BR': 'Desarquivar conversa', en: 'Unarchive conversation', es: 'Desarchivar conversación', fr: 'Désarchiver la conversation' }
  , 'Fixar conversa no topo': { 'pt-BR': 'Fixar conversa no topo', en: 'Pin conversation to top', es: 'Fijar conversación arriba', fr: 'Épingler la conversation en haut' }
  , 'Desfixar conversa': { 'pt-BR': 'Desfixar conversa', en: 'Unpin conversation', es: 'Desfijar conversación', fr: 'Désépingler la conversation' }
  , 'Fixar no topo': { 'pt-BR': 'Fixar no topo', en: 'Pin to top', es: 'Fijar arriba', fr: 'Épingler en haut' }
  , 'Desfixar do topo': { 'pt-BR': 'Desfixar do topo', en: 'Unpin from top', es: 'Desfijar de arriba', fr: 'Désépingler du haut' }
  , 'Limpar conversa local': { 'pt-BR': 'Limpar conversa local', en: 'Clear local conversation', es: 'Limpiar conversación local', fr: 'Effacer la conversation locale' }
  , 'Remover grupo local': { 'pt-BR': 'Remover grupo local', en: 'Remove local group', es: 'Quitar grupo local', fr: 'Retirer le groupe local' }
  , 'Sem mensagens ainda': { 'pt-BR': 'Sem mensagens ainda', en: 'No messages yet', es: 'Aún no hay mensajes', fr: 'Aucun message pour le moment' }
  , 'Sincronizando participantes...': { 'pt-BR': 'Sincronizando participantes...', en: 'Syncing participants...', es: 'Sincronizando participantes...', fr: 'Synchronisation des participants...' }
  , 'Relay offline': { 'pt-BR': 'Relay offline', en: 'Relay offline', es: 'Relay sin conexión', fr: 'Relay hors ligne' }
  , 'Ativo': { 'pt-BR': 'Ativo', en: 'Active', es: 'Activo', fr: 'Actif' }
  , 'Não suportado neste sistema': { 'pt-BR': 'Não suportado neste sistema', en: 'Not supported on this system', es: 'No compatible con este sistema', fr: 'Non pris en charge sur ce système' }
  , 'Emoji': { 'pt-BR': 'Emoji', en: 'Emoji', es: 'Emoji', fr: 'Emoji' }
  , 'Nome do grupo': { 'pt-BR': 'Nome do grupo', en: 'Group name', es: 'Nombre del grupo', fr: 'Nom du groupe' }
  , 'Emoji do grupo': { 'pt-BR': 'Emoji do grupo', en: 'Group emoji', es: 'Emoji del grupo', fr: 'Emoji du groupe' }
  , 'Membros podem fixar mensagens': { 'pt-BR': 'Membros podem fixar mensagens', en: 'Members can pin messages', es: 'Los miembros pueden fijar mensajes', fr: 'Les membres peuvent épingler des messages' }
  , 'Membros podem editar nome, emoji, cor e descrição': { 'pt-BR': 'Membros podem editar nome, emoji, cor e descrição', en: 'Members can edit name, emoji, color, and description', es: 'Los miembros pueden editar el nombre, emoji, color y descripción', fr: 'Les membres peuvent modifier le nom, l’emoji, la couleur et la description' }
  , 'Dono': { 'pt-BR': 'Dono', en: 'Owner', es: 'Propietario', fr: 'Propriétaire' }
  , 'Membro': { 'pt-BR': 'Membro', en: 'Member', es: 'Miembro', fr: 'Membre' }
  , 'Admin': { 'pt-BR': 'Admin', en: 'Admin', es: 'Admin', fr: 'Admin' }
  , 'Remover admin': { 'pt-BR': 'Remover admin', en: 'Remove admin', es: 'Quitar administrador', fr: 'Retirer administrateur' }
  , 'Remover participante': { 'pt-BR': 'Remover participante', en: 'Remove participant', es: 'Quitar participante', fr: 'Retirer le participant' }
  , 'Remover participante?': { 'pt-BR': 'Remover participante?', en: 'Remove participant?', es: '¿Quitar participante?', fr: 'Retirer le participant ?' }
  , 'Transferir propriedade?': { 'pt-BR': 'Transferir propriedade?', en: 'Transfer ownership?', es: '¿Transferir propiedad?', fr: 'Transférer la propriété ?' }
  , 'Transferir': { 'pt-BR': 'Transferir', en: 'Transfer', es: 'Transferir', fr: 'Transférer' }
  , 'Sair': { 'pt-BR': 'Sair', en: 'Leave', es: 'Salir', fr: 'Quitter' }
  , 'Ver quem reagiu': { 'pt-BR': 'Ver quem reagiu', en: 'See who reacted', es: 'Ver quién reaccionó', fr: 'Voir qui a réagi' }
  , 'Detalhes': { 'pt-BR': 'Detalhes', en: 'Details', es: 'Detalles', fr: 'Détails' }
  , 'Emojis': { 'pt-BR': 'Emojis', en: 'Emojis', es: 'Emojis', fr: 'Emojis' }
  , 'Cancelar resposta': { 'pt-BR': 'Cancelar resposta', en: 'Cancel reply', es: 'Cancelar respuesta', fr: 'Annuler la réponse' }
  , 'Aguardando o Relay': { 'pt-BR': 'Aguardando o Relay', en: 'Waiting for Relay', es: 'Esperando al Relay', fr: 'En attente du Relay' }
  , 'Enviando': { 'pt-BR': 'Enviando', en: 'Sending', es: 'Enviando', fr: 'Envoi en cours' }
  , 'Recebendo': { 'pt-BR': 'Recebendo', en: 'Receiving', es: 'Recibiendo', fr: 'Réception en cours' }
  , 'Backup cancelado.': { 'pt-BR': 'Backup cancelado.', en: 'Backup cancelled.', es: 'Copia cancelada.', fr: 'Sauvegarde annulée.' }
  , 'Restauração cancelada.': { 'pt-BR': 'Restauração cancelada.', en: 'Restore cancelled.', es: 'Restauración cancelada.', fr: 'Restauration annulée.' }
  , 'Restauração preparada. O aplicativo será reiniciado.': { 'pt-BR': 'Restauração preparada. O aplicativo será reiniciado.', en: 'Restore prepared. The app will restart.', es: 'Restauración preparada. La aplicación se reiniciará.', fr: 'Restauration préparée. L’application va redémarrer.' }
  , 'Gerando backup...': { 'pt-BR': 'Gerando backup...', en: 'Creating backup...', es: 'Creando copia...', fr: 'Création de la sauvegarde...' }
  , 'Preparando restauração...': { 'pt-BR': 'Preparando restauração...', en: 'Preparing restore...', es: 'Preparando restauración...', fr: 'Préparation de la restauration...' }
  , 'Não foi possível criar o backup local.': { 'pt-BR': 'Não foi possível criar o backup local.', en: 'Could not create the local backup.', es: 'No se pudo crear la copia local.', fr: 'Impossible de créer la sauvegarde locale.' }
  , 'Não foi possível restaurar o backup.': { 'pt-BR': 'Não foi possível restaurar o backup.', en: 'Could not restore the backup.', es: 'No se pudo restaurar la copia.', fr: 'Impossible de restaurer la sauvegarde.' }
  , 'Selecione a pasta para arquivos recebidos': { 'pt-BR': 'Selecione a pasta para arquivos recebidos', en: 'Select the folder for received files', es: 'Selecciona la carpeta para archivos recibidos', fr: 'Sélectionnez le dossier des fichiers reçus' }
  , 'Falha ao encaminhar.': { 'pt-BR': 'Falha ao encaminhar.', en: 'Forwarding failed.', es: 'Error al reenviar.', fr: 'Échec du transfert.' }
  , 'Não foi possível anexar os arquivos soltos.': { 'pt-BR': 'Não foi possível anexar os arquivos soltos.', en: 'Could not attach the dropped files.', es: 'No se pudieron adjuntar los archivos soltados.', fr: 'Impossible de joindre les fichiers déposés.' }
  , 'Nenhum arquivo válido foi selecionado.': { 'pt-BR': 'Nenhum arquivo válido foi selecionado.', en: 'No valid file was selected.', es: 'No se seleccionó ningún archivo válido.', fr: 'Aucun fichier valide n’a été sélectionné.' }
  , 'Falha ao selecionar arquivos.': { 'pt-BR': 'Falha ao selecionar arquivos.', en: 'Could not select files.', es: 'No se pudieron seleccionar archivos.', fr: 'Impossible de sélectionner les fichiers.' }
  , 'Não foi possível enviar a figurinha.': { 'pt-BR': 'Não foi possível enviar a figurinha.', en: 'Could not send the sticker.', es: 'No se pudo enviar el sticker.', fr: 'Impossible d’envoyer le sticker.' }
  , 'Conexão com Relay perdida. Tentando reconectar...': { 'pt-BR': 'Conexão com Relay perdida. Tentando reconectar...', en: 'Relay connection lost. Trying to reconnect...', es: 'Se perdió la conexión con el Relay. Intentando reconectar...', fr: 'Connexion au Relay perdue. Nouvelle tentative de connexion...' }
  , 'Não foi possível iniciar conexão com o Relay. A UI continua disponível.': { 'pt-BR': 'Não foi possível iniciar conexão com o Relay. A UI continua disponível.', en: 'Could not start the Relay connection. The interface remains available.', es: 'No se pudo iniciar la conexión con el Relay. La interfaz sigue disponible.', fr: 'Impossible de démarrer la connexion au Relay. L’interface reste disponible.' }
  , 'Não foi possível usar descoberta automática do relay (mDNS).': { 'pt-BR': 'Não foi possível usar descoberta automática do relay (mDNS).', en: 'Could not use automatic Relay discovery (mDNS).', es: 'No se pudo usar la detección automática del Relay (mDNS).', fr: 'Impossible d’utiliser la découverte automatique du Relay (mDNS).' }
  , 'Relay offline. Reação do grupo não enviada.': { 'pt-BR': 'Relay offline. Reação do grupo não enviada.', en: 'Relay offline. Group reaction was not sent.', es: 'Relay sin conexión. No se envió la reacción del grupo.', fr: 'Relay hors ligne. La réaction du groupe n’a pas été envoyée.' }
  , 'Relay offline. Reação não enviada.': { 'pt-BR': 'Relay offline. Reação não enviada.', en: 'Relay offline. Reaction was not sent.', es: 'Relay sin conexión. No se envió la reacción.', fr: 'Relay hors ligne. La réaction n’a pas été envoyée.' }
  , 'Contato offline. A reação será sincronizada quando ele voltar.': { 'pt-BR': 'Contato offline. A reação será sincronizada quando ele voltar.', en: 'Contact offline. The reaction will sync when they return.', es: 'Contacto sin conexión. La reacción se sincronizará cuando vuelva.', fr: 'Contact hors ligne. La réaction sera synchronisée à son retour.' }
  , 'Contato offline. A edição será sincronizada quando ele voltar.': { 'pt-BR': 'Contato offline. A edição será sincronizada quando ele voltar.', en: 'Contact offline. The edit will sync when they return.', es: 'Contacto sin conexión. La edición se sincronizará cuando vuelva.', fr: 'Contact hors ligne. La modification sera synchronisée à son retour.' }
  , 'Relay offline. A exclusão do grupo será aplicada apenas localmente por enquanto.': { 'pt-BR': 'Relay offline. A exclusão do grupo será aplicada apenas localmente por enquanto.', en: 'Relay offline. The group deletion will only be applied locally for now.', es: 'Relay sin conexión. La eliminación del grupo solo se aplicará localmente por ahora.', fr: 'Relay hors ligne. La suppression du groupe sera appliquée uniquement localement pour le moment.' }
  , 'Contato offline no momento. A exclusão será sincronizada quando a conexão voltar.': { 'pt-BR': 'Contato offline no momento. A exclusão será sincronizada quando a conexão voltar.', en: 'Contact is offline right now. The deletion will sync when the connection returns.', es: 'El contacto está sin conexión ahora. La eliminación se sincronizará cuando vuelva la conexión.', fr: 'Le contact est actuellement hors ligne. La suppression sera synchronisée au retour de la connexion.' }
  , 'Conversa limpa localmente. Será sincronizada quando o contato voltar online.': { 'pt-BR': 'Conversa limpa localmente. Será sincronizada quando o contato voltar online.', en: 'Conversation cleared locally. It will sync when the contact comes back online.', es: 'Conversación borrada localmente. Se sincronizará cuando el contacto vuelva a estar en línea.', fr: 'Conversation effacée localement. Elle sera synchronisée au retour du contact en ligne.' }
  , 'Contato removido localmente. A remoção será sincronizada quando o contato voltar online.': { 'pt-BR': 'Contato removido localmente. A remoção será sincronizada quando o contato voltar online.', en: 'Contact removed locally. The removal will sync when the contact comes back online.', es: 'Contacto eliminado localmente. La eliminación se sincronizará cuando el contacto vuelva a estar en línea.', fr: 'Contact supprimé localement. La suppression sera synchronisée au retour du contact en ligne.' }
  , 'Este grupo não existe mais no Relay. O envio foi bloqueado; você pode excluir a conversa localmente.': { 'pt-BR': 'Este grupo não existe mais no Relay. O envio foi bloqueado; você pode excluir a conversa localmente.', en: 'This group no longer exists on Relay. Sending was blocked; you can delete the conversation locally.', es: 'Este grupo ya no existe en el Relay. El envío fue bloqueado; puedes eliminar la conversación localmente.', fr: 'Ce groupe n’existe plus sur le Relay. L’envoi a été bloqué ; vous pouvez supprimer la conversation localement.' }
  , 'Ressincronização do grupo solicitada ao Relay.': { 'pt-BR': 'Ressincronização do grupo solicitada ao Relay.', en: 'Group resync requested from Relay.', es: 'Resincronización del grupo solicitada al Relay.', fr: 'Resynchronisation du groupe demandée au Relay.' }
  , 'Ressincronização iniciada. A conversa será alinhada nos dois clientes.': { 'pt-BR': 'Ressincronização iniciada. A conversa será alinhada nos dois clientes.', en: 'Resync started. The conversation will be aligned on both clients.', es: 'Resincronización iniciada. La conversación se alineará en ambos clientes.', fr: 'Resynchronisation démarrée. La conversation sera alignée sur les deux clients.' }
  , 'Falha na validação do anexo recebido. O remetente irá reenviar.': { 'pt-BR': 'Falha na validação do anexo recebido. O remetente irá reenviar.', en: 'Received attachment validation failed. The sender will resend it.', es: 'Falló la validación del archivo recibido. El remitente lo reenviará.', fr: 'La validation de la pièce jointe reçue a échoué. L’expéditeur va la renvoyer.' }
  , 'Restauração preparada. O Lantern será reiniciado para aplicar o backup.': { 'pt-BR': 'Restauração preparada. O Lantern será reiniciado para aplicar o backup.', en: 'Restore prepared. Lantern will restart to apply the backup.', es: 'Restauración preparada. Lantern se reiniciará para aplicar la copia.', fr: 'Restauration préparée. Lantern va redémarrer pour appliquer la sauvegarde.' }
  , 'Relay offline.': { 'pt-BR': 'Relay offline.', en: 'Relay offline.', es: 'Relay sin conexión.', fr: 'Relay hors ligne.' }
  , 'Relay desconectado.': { 'pt-BR': 'Relay desconectado.', en: 'Relay disconnected.', es: 'Relay desconectado.', fr: 'Relay déconnecté.' }
  , 'Conexão com relay perdida.': { 'pt-BR': 'Conexão com relay perdida.', en: 'Relay connection lost.', es: 'Conexión con el Relay perdida.', fr: 'Connexion au Relay perdue.' }
  , 'Erro no relay.': { 'pt-BR': 'Erro no relay.', en: 'Relay error.', es: 'Error del Relay.', fr: 'Erreur du Relay.' }
  , 'Conversa exportada.': { 'pt-BR': 'Conversa exportada.', en: 'Conversation exported.', es: 'Conversación exportada.', fr: 'Conversation exportée.' }
  , 'Falha ao enviar anúncio.': { 'pt-BR': 'Falha ao enviar anúncio.', en: 'Could not send announcement.', es: 'No se pudo enviar el anuncio.', fr: 'Impossible d’envoyer l’annonce.' }
  , 'Não foi possível enviar mensagem no grupo.': { 'pt-BR': 'Não foi possível enviar mensagem no grupo.', en: 'Could not send the group message.', es: 'No se pudo enviar el mensaje al grupo.', fr: 'Impossible d’envoyer le message au groupe.' }
  , 'Não foi possível enviar o anexo.': { 'pt-BR': 'Não foi possível enviar o anexo.', en: 'Could not send the attachment.', es: 'No se pudo enviar el archivo adjunto.', fr: 'Impossible d’envoyer la pièce jointe.' }
  , 'Não foi possível enviar o anexo no grupo.': { 'pt-BR': 'Não foi possível enviar o anexo no grupo.', en: 'Could not send the attachment to the group.', es: 'No se pudo enviar el archivo adjunto al grupo.', fr: 'Impossible d’envoyer la pièce jointe au groupe.' }
  , 'Não foi possível encaminhar a mensagem.': { 'pt-BR': 'Não foi possível encaminhar a mensagem.', en: 'Could not forward the message.', es: 'No se pudo reenviar el mensaje.', fr: 'Impossible de transférer le message.' }
  , 'Não foi possível editar a mensagem.': { 'pt-BR': 'Não foi possível editar a mensagem.', en: 'Could not edit the message.', es: 'No se pudo editar el mensaje.', fr: 'Impossible de modifier le message.' }
  , 'Não foi possível exportar a conversa.': { 'pt-BR': 'Não foi possível exportar a conversa.', en: 'Could not export the conversation.', es: 'No se pudo exportar la conversación.', fr: 'Impossible d’exporter la conversation.' }
  , 'Não foi possível ressincronizar a conversa.': { 'pt-BR': 'Não foi possível ressincronizar a conversa.', en: 'Could not resync the conversation.', es: 'No se pudo resincronizar la conversación.', fr: 'Impossible de resynchroniser la conversation.' }
  , 'Não foi possível criar o grupo.': { 'pt-BR': 'Não foi possível criar o grupo.', en: 'Could not create the group.', es: 'No se pudo crear el grupo.', fr: 'Impossible de créer le groupe.' }
  , 'Não foi possível atualizar o grupo.': { 'pt-BR': 'Não foi possível atualizar o grupo.', en: 'Could not update the group.', es: 'No se pudo actualizar el grupo.', fr: 'Impossible de mettre à jour le groupe.' }
  , 'Não foi possível adicionar participantes.': { 'pt-BR': 'Não foi possível adicionar participantes.', en: 'Could not add participants.', es: 'No se pudieron agregar participantes.', fr: 'Impossible d’ajouter des participants.' }
  , 'Não foi possível remover o participante.': { 'pt-BR': 'Não foi possível remover o participante.', en: 'Could not remove the participant.', es: 'No se pudo eliminar al participante.', fr: 'Impossible de retirer le participant.' }
  , 'Não foi possível alterar a função do participante.': { 'pt-BR': 'Não foi possível alterar a função do participante.', en: 'Could not change the participant role.', es: 'No se pudo cambiar el rol del participante.', fr: 'Impossible de modifier le rôle du participant.' }
  , 'Não foi possível transferir a propriedade do grupo.': { 'pt-BR': 'Não foi possível transferir a propriedade do grupo.', en: 'Could not transfer group ownership.', es: 'No se pudo transferir la propiedad del grupo.', fr: 'Impossible de transférer la propriété du groupe.' }
  , 'Não foi possível excluir o grupo.': { 'pt-BR': 'Não foi possível excluir o grupo.', en: 'Could not delete the group.', es: 'No se pudo eliminar el grupo.', fr: 'Impossible de supprimer le groupe.' }
  , 'Não foi possível sair do grupo.': { 'pt-BR': 'Não foi possível sair do grupo.', en: 'Could not leave the group.', es: 'No se pudo salir del grupo.', fr: 'Impossible de quitter le groupe.' }
  , 'Não foi possível atualizar o pino do grupo.': { 'pt-BR': 'Não foi possível atualizar o pino do grupo.', en: 'Could not update the group pin.', es: 'No se pudo actualizar el mensaje fijado del grupo.', fr: 'Impossible de mettre à jour l’épingle du groupe.' }
  , 'Não foi possível carregar o estado inicial do Lantern.': { 'pt-BR': 'Não foi possível carregar o estado inicial do Lantern.', en: 'Could not load Lantern’s initial state.', es: 'No se pudo cargar el estado inicial de Lantern.', fr: 'Impossible de charger l’état initial de Lantern.' }
  , 'Falha na validação de integridade do arquivo.': { 'pt-BR': 'Falha na validação de integridade do arquivo.', en: 'File integrity validation failed.', es: 'Falló la validación de integridad del archivo.', fr: 'La validation de l’intégrité du fichier a échoué.' }
  , 'Não foi possível baixar o anexo.': { 'pt-BR': 'Não foi possível baixar o anexo.', en: 'Could not download the attachment.', es: 'No se pudo descargar el archivo adjunto.', fr: 'Impossible de télécharger la pièce jointe.' }
  , 'Não foi possível concluir o envio': { 'pt-BR': 'Não foi possível concluir o envio', en: 'Could not complete the send', es: 'No se pudo completar el envío', fr: 'Impossible de terminer l’envoi' }
  , 'Não foi possível iniciar o download.': { 'pt-BR': 'Não foi possível iniciar o download.', en: 'Could not start the download.', es: 'No se pudo iniciar la descarga.', fr: 'Impossible de démarrer le téléchargement.' }
  , 'Ressincronização disponível apenas para conversas diretas.': { 'pt-BR': 'Ressincronização disponível apenas para conversas diretas.', en: 'Resync is available only for direct conversations.', es: 'La resincronización solo está disponible para conversaciones directas.', fr: 'La resynchronisation est disponible uniquement pour les conversations directes.' }
  , 'Falha ao enviar ação de grupo ao relay.': { 'pt-BR': 'Falha ao enviar ação de grupo ao relay.', en: 'Could not send the group action to Relay.', es: 'No se pudo enviar la acción del grupo al Relay.', fr: 'Impossible d’envoyer l’action du groupe au Relay.' }
  , 'Falha ao enviar chunk de grupo ao Relay.': { 'pt-BR': 'Falha ao enviar chunk de grupo ao Relay.', en: 'Could not send the group chunk to Relay.', es: 'No se pudo enviar el fragmento del grupo al Relay.', fr: 'Impossible d’envoyer le bloc du groupe au Relay.' }
  , 'Falha ao enviar envelope ao relay': { 'pt-BR': 'Falha ao enviar envelope ao relay', en: 'Could not send envelope to Relay', es: 'No se pudo enviar el paquete al Relay', fr: 'Impossible d’envoyer l’enveloppe au Relay' }
  , 'Falha ao enviar frame para o relay.': { 'pt-BR': 'Falha ao enviar frame para o relay.', en: 'Could not send frame to Relay.', es: 'No se pudo enviar el paquete al Relay.', fr: 'Impossible d’envoyer la trame au Relay.' }
  , 'Falha ao finalizar anexo de grupo.': { 'pt-BR': 'Falha ao finalizar anexo de grupo.', en: 'Could not finalize the group attachment.', es: 'No se pudo finalizar el archivo adjunto del grupo.', fr: 'Impossible de finaliser la pièce jointe du groupe.' }
  , 'Falha ao gravar chunk no Relay.': { 'pt-BR': 'Falha ao gravar chunk no Relay.', en: 'Could not write chunk to Relay.', es: 'No se pudo guardar el fragmento en el Relay.', fr: 'Impossible d’écrire le bloc sur le Relay.' }
  , 'Falha ao obter anexo de grupo.': { 'pt-BR': 'Falha ao obter anexo de grupo.', en: 'Could not retrieve the group attachment.', es: 'No se pudo obtener el archivo adjunto del grupo.', fr: 'Impossible de récupérer la pièce jointe du groupe.' }
  , 'Falha ao solicitar anexo de grupo ao Relay.': { 'pt-BR': 'Falha ao solicitar anexo de grupo ao Relay.', en: 'Could not request the group attachment from Relay.', es: 'No se pudo solicitar el archivo adjunto del grupo al Relay.', fr: 'Impossible de demander la pièce jointe du groupe au Relay.' }
  , 'Falha na ação de grupo.': { 'pt-BR': 'Falha na ação de grupo.', en: 'Group action failed.', es: 'Falló la acción del grupo.', fr: 'L’action du groupe a échoué.' }
  , 'Relay indisponível.': { 'pt-BR': 'Relay indisponível.', en: 'Relay unavailable.', es: 'Relay no disponible.', fr: 'Relay indisponible.' }
  , 'Peer não encontrado no Relay.': { 'pt-BR': 'Peer não encontrado no Relay.', en: 'Peer not found on Relay.', es: 'Contacto no encontrado en el Relay.', fr: 'Pair introuvable sur le Relay.' }
  , 'Informe o host/IP do Relay para usar o modo manual.': { 'pt-BR': 'Informe o host/IP do Relay para usar o modo manual.', en: 'Enter the Relay host/IP to use manual mode.', es: 'Introduce el host/IP del Relay para usar el modo manual.', fr: 'Indiquez l’hôte/IP du Relay pour utiliser le mode manuel.' }
  , 'Contato inválido para ressincronizar.': { 'pt-BR': 'Contato inválido para ressincronizar.', en: 'Invalid contact to resync.', es: 'Contacto no válido para resincronizar.', fr: 'Contact invalide à resynchroniser.' }
  , 'Contato offline no relay.': { 'pt-BR': 'Contato offline no relay.', en: 'Contact offline on Relay.', es: 'Contacto sin conexión en el Relay.', fr: 'Contact hors ligne sur le Relay.' }
  , 'Contato de destino inválido para encaminhar.': { 'pt-BR': 'Contato de destino inválido para encaminhar.', en: 'Invalid destination contact for forwarding.', es: 'Contacto de destino no válido para reenviar.', fr: 'Contact de destination invalide pour le transfert.' }
  , 'Mensagem de origem inválida para encaminhar.': { 'pt-BR': 'Mensagem de origem inválida para encaminhar.', en: 'Invalid source message for forwarding.', es: 'Mensaje de origen no válido para reenviar.', fr: 'Message source invalide pour le transfert.' }
  , 'Não é possível encaminhar para você mesmo.': { 'pt-BR': 'Não é possível encaminhar para você mesmo.', en: 'You cannot forward to yourself.', es: 'No puedes reenviar a ti mismo.', fr: 'Vous ne pouvez pas vous transférer un message.' }
  , 'Mensagem de origem não encontrada.': { 'pt-BR': 'Mensagem de origem não encontrada.', en: 'Source message not found.', es: 'Mensaje de origen no encontrado.', fr: 'Message source introuvable.' }
  , 'Contato de destino não encontrado.': { 'pt-BR': 'Contato de destino não encontrado.', en: 'Destination contact not found.', es: 'Contacto de destino no encontrado.', fr: 'Contact de destination introuvable.' }
  , 'Este anexo ainda está sendo baixado do Relay. Tente novamente em instantes.': { 'pt-BR': 'Este anexo ainda está sendo baixado do Relay. Tente novamente em instantes.', en: 'This attachment is still downloading from Relay. Try again shortly.', es: 'Este archivo adjunto aún se está descargando del Relay. Inténtalo de nuevo en breve.', fr: 'Cette pièce jointe est encore en cours de téléchargement depuis le Relay. Réessayez dans un instant.' }
  , 'Este anexo ainda está sendo recebido. Tente novamente em instantes.': { 'pt-BR': 'Este anexo ainda está sendo recebido. Tente novamente em instantes.', en: 'This attachment is still being received. Try again shortly.', es: 'Este archivo adjunto aún se está recibiendo. Inténtalo de nuevo en breve.', fr: 'Cette pièce jointe est encore en cours de réception. Réessayez dans un instant.' }
  , 'Este anexo não está mais disponível neste dispositivo.': { 'pt-BR': 'Este anexo não está mais disponível neste dispositivo.', en: 'This attachment is no longer available on this device.', es: 'Este archivo adjunto ya no está disponible en este dispositivo.', fr: 'Cette pièce jointe n’est plus disponible sur cet appareil.' }
  , 'Esta mensagem não possui conteúdo para encaminhar.': { 'pt-BR': 'Esta mensagem não possui conteúdo para encaminhar.', en: 'This message has no content to forward.', es: 'Este mensaje no tiene contenido para reenviar.', fr: 'Ce message ne contient aucun contenu à transférer.' }
  , 'Mensagem não encontrada para favoritar.': { 'pt-BR': 'Mensagem não encontrada para favoritar.', en: 'Message not found to favorite.', es: 'Mensaje no encontrado para destacar.', fr: 'Message introuvable à ajouter aux favoris.' }
  , 'Mensagem não pertence a esta conversa.': { 'pt-BR': 'Mensagem não pertence a esta conversa.', en: 'This message does not belong to this conversation.', es: 'Este mensaje no pertenece a esta conversación.', fr: 'Ce message n’appartient pas à cette conversation.' }
  , 'Somente mensagens de texto podem ser editadas.': { 'pt-BR': 'Somente mensagens de texto podem ser editadas.', en: 'Only text messages can be edited.', es: 'Solo se pueden editar mensajes de texto.', fr: 'Seuls les messages texte peuvent être modifiés.' }
  , 'Somente mensagens enviadas por você podem ser editadas.': { 'pt-BR': 'Somente mensagens enviadas por você podem ser editadas.', en: 'Only messages sent by you can be edited.', es: 'Solo puedes editar mensajes enviados por ti.', fr: 'Seuls les messages que vous avez envoyés peuvent être modifiés.' }
  , 'Não é possível editar uma mensagem apagada.': { 'pt-BR': 'Não é possível editar uma mensagem apagada.', en: 'A deleted message cannot be edited.', es: 'No se puede editar un mensaje eliminado.', fr: 'Un message supprimé ne peut pas être modifié.' }
  , 'O prazo para editar esta mensagem terminou.': { 'pt-BR': 'O prazo para editar esta mensagem terminou.', en: 'The time limit to edit this message has expired.', es: 'El plazo para editar este mensaje terminó.', fr: 'Le délai de modification de ce message a expiré.' }
  , 'Somente mensagens enviadas por você podem ser apagadas para todos.': { 'pt-BR': 'Somente mensagens enviadas por você podem ser apagadas para todos.', en: 'Only messages sent by you can be deleted for everyone.', es: 'Solo los mensajes enviados por ti se pueden eliminar para todos.', fr: 'Seuls les messages que vous avez envoyés peuvent être supprimés pour tous.' }
  , 'Grupo não existe mais no Relay.': { 'pt-BR': 'Grupo não existe mais no Relay.', en: 'Group no longer exists on Relay.', es: 'El grupo ya no existe en el Relay.', fr: 'Le groupe n’existe plus sur le Relay.' }
  , 'Grupo não encontrado.': { 'pt-BR': 'Grupo não encontrado.', en: 'Group not found.', es: 'Grupo no encontrado.', fr: 'Groupe introuvable.' }
  , 'Relay não retornou o grupo criado.': { 'pt-BR': 'Relay não retornou o grupo criado.', en: 'Relay did not return the created group.', es: 'El Relay no devolvió el grupo creado.', fr: 'Le Relay n’a pas renvoyé le groupe créé.' }
  , 'Arquivo local não está mais disponível para envio.': { 'pt-BR': 'Arquivo local não está mais disponível para envio.', en: 'The local file is no longer available to send.', es: 'El archivo local ya no está disponible para enviar.', fr: 'Le fichier local n’est plus disponible pour l’envoi.' }
  , 'Personalize Lantern on this device.': { 'pt-BR': 'Personalize o Lantern neste dispositivo.', en: 'Personalize Lantern on this device.', es: 'Personaliza Lantern en este dispositivo.', fr: 'Personnalisez Lantern sur cet appareil.' }
  , 'Settings sections': { 'pt-BR': 'Seções das configurações', en: 'Settings sections', es: 'Secciones de configuración', fr: 'Sections des paramètres' }
  , 'Name, status and visual identity': { 'pt-BR': 'Nome, status e identidade visual', en: 'Name, status and visual identity', es: 'Nombre, estado e identidad visual', fr: 'Nom, statut et identité visuelle' }
  , 'Relay': { 'pt-BR': 'Relay', en: 'Relay', es: 'Relay', fr: 'Relay' }
  , 'Connection and discovery preferences': { 'pt-BR': 'Preferências de conexão e descoberta', en: 'Connection and discovery preferences', es: 'Preferencias de conexión y detección', fr: 'Préférences de connexion et de découverte' }
  , 'Notifications': { 'pt-BR': 'Notificações', en: 'Notifications', es: 'Notificaciones', fr: 'Notifications' }
  , 'Quiet hours and alerts': { 'pt-BR': 'Silêncio e alertas do aplicativo', en: 'Quiet hours and alerts', es: 'Silencio y alertas de la aplicación', fr: 'Silence et alertes de l’application' }
  , 'Application': { 'pt-BR': 'Aplicativo', en: 'Application', es: 'Aplicación', fr: 'Application' }
  , 'Startup, files, language and backup': { 'pt-BR': 'Inicialização, arquivos, idioma e backup', en: 'Startup, files, language and backup', es: 'Inicio, archivos, idioma y copia de seguridad', fr: 'Démarrage, fichiers, langue et sauvegarde' }
  , 'These settings only apply to this device.': { 'pt-BR': 'Estas preferências valem somente para este dispositivo.', en: 'These settings only apply to this device.', es: 'Estas preferencias solo se aplican a este dispositivo.', fr: 'Ces préférences s’appliquent uniquement à cet appareil.' }
  , 'Profile preview': { 'pt-BR': 'Prévia do perfil', en: 'Profile preview', es: 'Vista previa del perfil', fr: 'Aperçu du profil' }
  , 'Preview': { 'pt-BR': 'PRÉVIA', en: 'PREVIEW', es: 'VISTA PREVIA', fr: 'APERÇU' }
  , 'E.g. In a meeting, I will reply later': { 'pt-BR': 'Ex.: Em reunião, respondo depois', en: 'E.g. In a meeting, I will reply later', es: 'Ej.: En reunión, responderé más tarde', fr: 'Ex. : En réunion, je répondrai plus tard' }
  , 'Status suggestions': { 'pt-BR': 'Sugestões de status', en: 'Status suggestions', es: 'Sugerencias de estado', fr: 'Suggestions de statut' }
  , 'Faces': { 'pt-BR': 'Rostos', en: 'Faces', es: 'Caras', fr: 'Visages' }
  , 'Work': { 'pt-BR': 'Trabalho', en: 'Work', es: 'Trabajo', fr: 'Travail' }
  , 'Animals': { 'pt-BR': 'Animais', en: 'Animals', es: 'Animales', fr: 'Animaux' }
  , 'Food': { 'pt-BR': 'Comida', en: 'Food', es: 'Comida', fr: 'Alimentation' }
  , 'Start Lantern automatically after you sign in to your computer.': { 'pt-BR': 'Inicie o Lantern automaticamente após entrar no computador.', en: 'Start Lantern automatically after you sign in to your computer.', es: 'Inicia Lantern automáticamente después de iniciar sesión en tu equipo.', fr: 'Démarrez Lantern automatiquement après votre ouverture de session.' }
  , 'Not supported on this system': { 'pt-BR': 'Não suportado neste sistema', en: 'Not supported on this system', es: 'No compatible con este sistema', fr: 'Non pris en charge sur ce système' }
  , 'Select a folder for received files': { 'pt-BR': 'Selecione a pasta para arquivos recebidos', en: 'Select a folder for received files', es: 'Selecciona la carpeta para los archivos recibidos', fr: 'Sélectionnez le dossier des fichiers reçus' }
  , 'Choose the language used by Lantern on this device.': { 'pt-BR': 'Escolha o idioma usado pelo Lantern neste dispositivo.', en: 'Choose the language used by Lantern on this device.', es: 'Elige el idioma utilizado por Lantern en este dispositivo.', fr: 'Choisissez la langue utilisée par Lantern sur cet appareil.' }
  , 'Creating backup...': { 'pt-BR': 'Gerando backup...', en: 'Creating backup...', es: 'Creando copia de seguridad...', fr: 'Création de la sauvegarde...' }
  , 'Preparing restore...': { 'pt-BR': 'Preparando restauração...', en: 'Preparing restore...', es: 'Preparando restauración...', fr: 'Préparation de la restauration...' }
  , 'Backup canceled.': { 'pt-BR': 'Backup cancelado.', en: 'Backup canceled.', es: 'Copia de seguridad cancelada.', fr: 'Sauvegarde annulée.' }
  , 'Backup created at:': { 'pt-BR': 'Backup criado em:', en: 'Backup created at:', es: 'Copia de seguridad creada en:', fr: 'Sauvegarde créée dans :' }
  , 'selected folder': { 'pt-BR': 'pasta selecionada', en: 'selected folder', es: 'carpeta seleccionada', fr: 'dossier sélectionné' }
  , 'Could not create the local backup.': { 'pt-BR': 'Não foi possível criar o backup local.', en: 'Could not create the local backup.', es: 'No se pudo crear la copia de seguridad local.', fr: 'Impossible de créer la sauvegarde locale.' }
  , 'Restore canceled.': { 'pt-BR': 'Restauração cancelada.', en: 'Restore canceled.', es: 'Restauración cancelada.', fr: 'Restauration annulée.' }
  , 'Restore prepared. The app will restart.': { 'pt-BR': 'Restauração preparada. O aplicativo será reiniciado.', en: 'Restore prepared. The app will restart.', es: 'Restauración preparada. La aplicación se reiniciará.', fr: 'Restauration préparée. L’application va redémarrer.' }
  , 'Could not restore the local backup.': { 'pt-BR': 'Não foi possível restaurar o backup local.', en: 'Could not restore the local backup.', es: 'No se pudo restaurar la copia de seguridad local.', fr: 'Impossible de restaurer la sauvegarde locale.' }
  , 'Recently used': { 'pt-BR': 'Recentes', en: 'Recently used', es: 'Usados recientemente', fr: 'Récents' }
  , 'Gestures': { 'pt-BR': 'Gestos', en: 'Gestures', es: 'Gestos', fr: 'Gestes' }
  , 'People': { 'pt-BR': 'Pessoas', en: 'People', es: 'Personas', fr: 'Personnes' }
  , 'Objects': { 'pt-BR': 'Objetos', en: 'Objects', es: 'Objetos', fr: 'Objets' }
  , 'Nature': { 'pt-BR': 'Natureza', en: 'Nature', es: 'Naturaleza', fr: 'Nature' }
  , 'Activities': { 'pt-BR': 'Atividades', en: 'Activities', es: 'Actividades', fr: 'Activités' }
  , 'Travel': { 'pt-BR': 'Viagens', en: 'Travel', es: 'Viajes', fr: 'Voyages' }
  , 'Flags': { 'pt-BR': 'Bandeiras', en: 'Flags', es: 'Banderas', fr: 'Drapeaux' }
  , 'Symbols': { 'pt-BR': 'Símbolos', en: 'Symbols', es: 'Símbolos', fr: 'Symboles' }
  , 'Choose an emoji to add to your message.': { 'pt-BR': 'Escolha um emoji para adicionar à mensagem.', en: 'Choose an emoji to add to your message.', es: 'Elige un emoji para añadir al mensaje.', fr: 'Choisissez un emoji à ajouter au message.' }
  , 'Search emoji (e.g. heart, pizza, cat...)': { 'pt-BR': 'Buscar emoji (ex.: coração, pizza, gato...)', en: 'Search emoji (e.g. heart, pizza, cat...)', es: 'Buscar emoji (p. ej., corazón, pizza, gato...)', fr: 'Rechercher un emoji (ex. cœur, pizza, chat...)' }
  , 'Emoji categories': { 'pt-BR': 'Categorias de emoji', en: 'Emoji categories', es: 'Categorías de emojis', fr: 'Catégories d’emojis' }
  , 'Emoji search results': { 'pt-BR': 'Resultados da busca de emoji', en: 'Emoji search results', es: 'Resultados de búsqueda de emojis', fr: 'Résultats de recherche d’emojis' }
  , 'Add emoji': { 'pt-BR': 'Adicionar emoji', en: 'Add emoji', es: 'Agregar emoji', fr: 'Ajouter un emoji' }
  , 'Your recently used emojis will appear here.': { 'pt-BR': 'Seus emojis usados recentemente aparecerão aqui.', en: 'Your recently used emojis will appear here.', es: 'Tus emojis usados recientemente aparecerán aquí.', fr: 'Vos emojis récemment utilisés apparaîtront ici.' }
  , 'Visual identity': { 'pt-BR': 'Identidade visual', en: 'Visual identity', es: 'Identidad visual', fr: 'Identité visuelle' }
  , 'Choose how you appear in conversations.': { 'pt-BR': 'Escolha como você aparece nas conversas.', en: 'Choose how you appear in conversations.', es: 'Elige cómo apareces en las conversaciones.', fr: 'Choisissez comment vous apparaissez dans les conversations.' }
  , 'Search by cat, work, party...': { 'pt-BR': 'Buscar por gato, trabalho, festa...', en: 'Search by cat, work, party...', es: 'Buscar por gato, trabajo, fiesta...', fr: 'Rechercher chat, travail, fête...' }
  , 'Search profile emoji': { 'pt-BR': 'Buscar emoji de perfil', en: 'Search profile emoji', es: 'Buscar emoji de perfil', fr: 'Rechercher un emoji de profil' }
  , 'No profile emoji found.': { 'pt-BR': 'Nenhum emoji de perfil encontrado.', en: 'No profile emoji found.', es: 'No se encontró ningún emoji de perfil.', fr: 'Aucun emoji de profil trouvé.' }
  , 'Paste an emoji': { 'pt-BR': 'Cole um emoji', en: 'Paste an emoji', es: 'Pega un emoji', fr: 'Collez un emoji' }
  , 'Custom emoji': { 'pt-BR': 'Emoji personalizado', en: 'Custom emoji', es: 'Emoji personalizado', fr: 'Emoji personnalisé' }
  , 'Choose the color of your avatar.': { 'pt-BR': 'Escolha a cor do seu avatar.', en: 'Choose the color of your avatar.', es: 'Elige el color de tu avatar.', fr: 'Choisissez la couleur de votre avatar.' }
  , 'Use color': { 'pt-BR': 'Usar cor', en: 'Use color', es: 'Usar color', fr: 'Utiliser la couleur' }
  , 'Custom color': { 'pt-BR': 'Cor personalizada', en: 'Custom color', es: 'Color personalizado', fr: 'Couleur personnalisée' }
};

const sourceTextByNode = new WeakMap<Text, string>();
const sourceAttributesByElement = new WeakMap<Element, Map<string, string>>();
const legacyAttributes = ['title', 'aria-label', 'placeholder'];
const excludedLegacyTextLocalization = '.message-text, .message-link, .message-file-title, .reply-reference-preview, textarea, input';
const excludedLegacyAttributeLocalization = '.message-text, .message-link, .message-file-title, .reply-reference-preview';

const isLegacyTextSafeToTranslate = (element: Element | null): boolean =>
  !element?.closest(excludedLegacyTextLocalization);

const isLegacyAttributeSafeToTranslate = (element: Element): boolean =>
  !element.closest(excludedLegacyAttributeLocalization);

const translateLegacy = (source: string, locale: SupportedLocale): string => {
  const exact = legacyTranslations[source];
  if (exact) return exact[locale];
  const participants = source.match(/^(\d+) participantes?$/);
  if (participants) {
    const count = participants[1];
    return locale === 'en' ? `${count} participant${count === '1' ? '' : 's'}`
      : locale === 'es' ? `${count} participante${count === '1' ? '' : 's'}`
      : locale === 'fr' ? `${count} participant${count === '1' ? '' : 's'}`
      : source;
  }
  const online = source.match(/^(\d+) online$/);
  if (online) {
    const count = online[1];
    return locale === 'en' ? `${count} online` : locale === 'es' ? `${count} en línea` : locale === 'fr' ? `${count} en ligne` : source;
  }
  return source;
};

// Electron and Relay emit runtime notices outside React. Localize them at the
// renderer boundary so process-level messages follow the selected language too.
export const localizeRuntimeText = (source: string, locale: SupportedLocale): string => {
  const connected = source.match(/^Conectado ao Relay(?: \((.+)\))?$/);
  if (connected) {
    const label = translateLegacy('Conectado ao Relay', locale);
    return connected[1] ? `${label} (${connected[1]})` : label;
  }

  const relayError = source.match(/^\[relay:([^\]]+)\]\s*(.*)$/);
  if (relayError) {
    const [, code, detail] = relayError;
    const localizedDetail = translateLegacy(detail, locale);
    // Do not leak a Portuguese server-side detail into another selected UI
    // language when a newer Relay returns an unknown error message.
    const safeDetail =
      localizedDetail === detail && locale !== 'pt-BR'
        ? translateLegacy('Erro no relay.', locale)
        : localizedDetail;
    return `[relay:${code}] ${safeDetail}`;
  }

  return translateLegacy(source, locale);
};

const knownLocalizedValue = (source: string, value: string): boolean =>
  value === source || Object.values(legacyTranslations[source] || {}).includes(value);

const localizeTextNode = (node: Text, locale: SupportedLocale): void => {
  if (!isLegacyTextSafeToTranslate(node.parentElement)) return;
  const current = node.nodeValue || '';
  let source = sourceTextByNode.get(node);
  if (!source || !knownLocalizedValue(source, current)) {
    if (!legacyTranslations[current] && !/^(\d+) (participantes?|online)$/.test(current)) return;
    source = current;
    sourceTextByNode.set(node, source);
  }
  const localized = translateLegacy(source, locale);
  if (localized !== current) node.nodeValue = localized;
};

const localizeAttributes = (element: Element, locale: SupportedLocale): void => {
  if (!isLegacyAttributeSafeToTranslate(element)) return;
  let stored = sourceAttributesByElement.get(element);
  if (!stored) {
    stored = new Map<string, string>();
    sourceAttributesByElement.set(element, stored);
  }
  for (const attribute of legacyAttributes) {
    const current = element.getAttribute(attribute);
    if (!current) continue;
    let source = stored.get(attribute);
    if (!source || !knownLocalizedValue(source, current)) {
      if (!legacyTranslations[current]) continue;
      source = current;
      stored.set(attribute, source);
    }
    const localized = translateLegacy(source, locale);
    if (localized !== current) element.setAttribute(attribute, localized);
  }
};

const localizeLegacyTree = (node: Node, locale: SupportedLocale): void => {
  if (node.nodeType === Node.TEXT_NODE) {
    localizeTextNode(node as Text, locale);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as Element;
  localizeAttributes(element, locale);
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let textNode = walker.nextNode();
  while (textNode) {
    localizeTextNode(textNode as Text, locale);
    textNode = walker.nextNode();
  }
  element.querySelectorAll('*').forEach((child) => localizeAttributes(child, locale));
};

const LegacyDomLocalizer = () => {
  const { locale } = useI18n();
  useEffect(() => {
    const root = document.body;
    localizeLegacyTree(root, locale);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') {
          localizeTextNode(record.target as Text, locale);
        } else if (record.type === 'attributes') {
          localizeAttributes(record.target as Element, locale);
        } else {
          record.addedNodes.forEach((node) => localizeLegacyTree(node, locale));
        }
      }
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: legacyAttributes
    });
    return () => observer.disconnect();
  }, [locale]);
  return null;
};
