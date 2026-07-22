import { ClipboardEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Input,
  Textarea
} from '@fluentui/react-components';
import {
  AnimalCat20Regular,
  ArrowReply20Regular,
  Attach20Regular,
  ClipboardEdit20Regular,
  ClipboardPaste20Regular,
  Copy20Regular,
  Cut20Regular,
  Dismiss12Regular,
  Delete16Regular,
  Emoji20Regular,
  Flag20Regular,
  Food20Regular,
  Games20Regular,
  Gif20Regular,
  HandWave20Regular,
  Heart20Regular,
  History20Regular,
  LeafTwo20Regular,
  People20Regular,
  Search20Regular,
  Send20Filled,
  Toolbox20Regular,
  VehicleCar20Regular
} from '@fluentui/react-icons';
import { ipcClient, MessageReplyReference, StickerCatalogItem } from '../api/ipcClient';
import { PlatformEmoji, PlatformEmojiText } from './PlatformEmoji';

interface MessageComposerProps {
  disabled?: boolean;
  autoFocusKey?: string;
  onSend: (text: string, replyTo?: MessageReplyReference | null) => Promise<void>;
  onSubmitEdit?: (text: string) => Promise<void>;
  onTypingChange?: (isTyping: boolean) => Promise<void>;
  onSendFile?: (filePath: string, replyTo?: MessageReplyReference | null) => Promise<void>;
  onPaste?: () => void;
  replyDraft?: ComposerReplyDraft | null;
  onCancelReply?: () => void;
  editDraft?: ComposerEditDraft | null;
  onCancelEdit?: () => void;
  placeholder: string;
}

interface ComposerReplyDraft extends MessageReplyReference {
  senderLabel: string;
}

interface ComposerEditDraft {
  messageId: string;
  text: string;
}

interface PendingAttachmentInfo {
  name: string;
  size: number;
  ext: string;
  isImage: boolean;
}

type PasteProgressStage = 'reading' | 'saving' | 'done' | 'error';

interface PasteProgressItem {
  id: string;
  name: string;
  progress: number;
  stage: PasteProgressStage;
}

type EmojiCategory =
  | 'rostos'
  | 'gestos'
  | 'pessoas'
  | 'animais'
  | 'comida'
  | 'objetos'
  | 'natureza'
  | 'atividades'
  | 'viagens'
  | 'bandeiras'
  | 'simbolos';
type EmojiPickerCategory = 'recentes' | EmojiCategory;

interface EmojiItem {
  emoji: string;
  search: string;
}

const CHAT_RECENT_EMOJIS_KEY = 'lantern.chat.recent-emojis.v1';
const MAX_CHAT_RECENT_EMOJIS = 24;
const SKIN_TONES = ['🏻', '🏼', '🏽', '🏾', '🏿'];
const SKIN_TONE_EMOJIS = new Set([
  '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙',
  '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '🫶',
  '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳', '💪', '🦵', '🦶', '👂', '🦻', '👃'
]);

const expandSkinTones = (emojis: string[]): string[] =>
  emojis.flatMap((emoji) => SKIN_TONE_EMOJIS.has(emoji)
    ? [emoji, ...SKIN_TONES.map((tone) => `${emoji.replace(/\uFE0F$/u, '')}${tone}`)]
    : [emoji]);

const readRecentChatEmojis = (): string[] => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CHAT_RECENT_EMOJIS_KEY) || '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').slice(0, MAX_CHAT_RECENT_EMOJIS)
      : [];
  } catch {
    return [];
  }
};

const normalizeSearchTerm = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();

const CATEGORY_EXACT_SEARCH_TERMS: Record<EmojiCategory, string[]> = {
  rostos: ['rosto', 'rostos', 'face', 'faces', 'emocao', 'emocoes'],
  gestos: ['gesto', 'gestos', 'mao', 'maos', 'mãos'],
  pessoas: ['pessoa', 'pessoas', 'profissao', 'profissoes', 'família', 'familia'],
  animais: ['animal', 'animais', 'bicho', 'bichos', 'pet', 'pets'],
  comida: ['comida', 'comidas', 'bebida', 'bebidas', 'alimento', 'alimentos'],
  objetos: ['objeto', 'objetos', 'ferramenta', 'ferramentas'],
  natureza: ['natureza', 'planta', 'plantas', 'clima', 'tempo', 'flor', 'flores'],
  atividades: ['atividade', 'atividades', 'esporte', 'esportes', 'jogo', 'jogos', 'musica', 'música'],
  viagens: ['viagem', 'viagens', 'transporte', 'transportes', 'veiculo', 'veiculos', 'lugar', 'lugares'],
  bandeiras: ['bandeira', 'bandeiras', 'pais', 'país', 'paises', 'países'],
  simbolos: ['simbolo', 'simbolos', 'símbolo', 'símbolos', 'icone', 'ícone', 'icones', 'ícones']
};

const EMOJI_ALIAS_MAP: Record<string, string[]> = {
  '😀': ['feliz', 'sorriso', 'alegre'],
  '😂': ['risada', 'rindo', 'kkkk'],
  '😭': ['chorando', 'tristeza'],
  '😡': ['bravo', 'raiva'],
  '😴': ['sono', 'dormindo'],
  '🫨': ['tremendo', 'choque', 'abalado', 'surpreso'],
  '🙂‍↔️': ['nao', 'negando', 'discordo'],
  '🙂‍↕️': ['sim', 'concordando', 'concordo'],
  '💀': ['caveira', 'cranio', 'morte', 'esqueleto'],
  '☠️': ['caveira', 'ossos', 'perigo', 'veneno', 'pirata'],
  '👻': ['fantasma', 'assombracao', 'halloween'],
  '🤖': ['robo', 'maquina', 'tecnologia'],
  '❤️': ['coracao', 'amor'],
  '💔': ['coracao partido', 'termino'],
  '👍': ['positivo', 'ok', 'joinha'],
  '👎': ['negativo'],
  '🙏': ['obrigado', 'por favor', 'reza'],
  '👏': ['aplausos', 'parabens'],
  '💪': ['forca', 'musculo'],
  '🐶': ['cachorro', 'dog'],
  '🐱': ['gato', 'cat'],
  '🦊': ['raposa', 'fox'],
  '🐼': ['panda'],
  '🐧': ['pinguim'],
  '🦁': ['leao'],
  '🐸': ['sapo'],
  '🐢': ['tartaruga'],
  '🦄': ['unicornio'],
  '🍕': ['pizza'],
  '🍔': ['hamburguer'],
  '🍟': ['batata frita', 'fritas'],
  '🌮': ['taco'],
  '🍣': ['sushi'],
  '🍜': ['lamen', 'ramen'],
  '🍰': ['bolo', 'doce'],
  '🍩': ['donut'],
  '🍫': ['chocolate'],
  '🍓': ['morango'],
  '🍉': ['melancia'],
  '☕': ['cafe'],
  '🧋': ['bubble tea', 'cha'],
  '🍺': ['cerveja'],
  '🍷': ['vinho'],
  '💻': ['notebook', 'computador'],
  '📱': ['celular', 'telefone'],
  '📎': ['anexo', 'clipe'],
  '🛠️': ['ferramentas'],
  '⚙️': ['configuracao'],
  '🚀': ['foguete', 'lancamento'],
  '📦': ['pacote', 'caixa'],
  '🧠': ['cerebro', 'ideia'],
  '🫆': ['impressao digital', 'biometria', 'digital'],
  '🔔': ['notificacao', 'alerta'],
  '✅': ['confirmado', 'check'],
  '❌': ['erro', 'cancelar'],
  '⚠️': ['atencao', 'aviso'],
  '🔒': ['trancado', 'privado'],
  '🔓': ['destrancado'],
  '🟢': ['online', 'verde'],
  '⚫': ['offline', 'preto'],
  '🔴': ['urgente', 'vermelho'],
  '➡️': ['direita'],
  '⬅️': ['esquerda'],
  '⬆️': ['cima'],
  '⬇️': ['baixo'],
  '💬': ['chat', 'mensagem'],
  '🗨️': ['conversa'],
  '📢': ['anuncio', 'broadcast'],
  '⏰': ['alarme', 'relogio'],
  '🕒': ['hora', 'tempo'],
  '🏁': ['bandeira quadriculada', 'corrida', 'chegada'],
  '🚩': ['bandeira vermelha', 'alerta'],
  '🎌': ['bandeiras cruzadas', 'japao', 'japão'],
  '🏴': ['bandeira preta'],
  '🏳️': ['bandeira branca'],
  '🏳️‍🌈': ['bandeira arco-iris', 'arco iris', 'lgbt', 'orgulho'],
  '🏳️‍⚧️': ['bandeira trans', 'transgenero', 'transgênero'],
  '🏴‍☠️': ['bandeira pirata', 'pirata'],
  '🐦‍🔥': ['fenix', 'fênix', 'passaro de fogo', 'renascimento'],
  '🪾': ['arvore sem folhas', 'arvore seca', 'seca'],
  '🍄‍🟫': ['cogumelo marrom', 'cogumelo'],
  '🫜': ['raiz', 'raiz vegetal', 'legume'],
  '🪉': ['harpa', 'instrumento musical'],
  '🪏': ['pa', 'pá', 'cavar', 'ferramenta'],
  '⛓️‍💥': ['corrente quebrada', 'quebrar corrente', 'liberdade'],
  '🫟': ['mancha', 'respingos', 'tinta'],
  '🇧🇷': ['brasil', 'brazil'],
  '🇦🇷': ['argentina'],
  '🇺🇾': ['uruguai', 'uruguay'],
  '🇵🇾': ['paraguai', 'paraguay'],
  '🇨🇱': ['chile'],
  '🇧🇴': ['bolivia', 'bolívia'],
  '🇵🇪': ['peru', 'perú'],
  '🇨🇴': ['colombia', 'colômbia'],
  '🇻🇪': ['venezuela'],
  '🇪🇨': ['equador', 'ecuador'],
  '🇲🇽': ['mexico', 'méxico'],
  '🇵🇦': ['panama', 'panamá'],
  '🇨🇷': ['costa rica'],
  '🇨🇺': ['cuba'],
  '🇺🇸': ['estados unidos', 'eua', 'usa'],
  '🇨🇦': ['canada', 'canadá'],
  '🇬🇧': ['reino unido', 'inglaterra', 'uk'],
  '🇮🇪': ['irlanda', 'ireland'],
  '🇫🇷': ['franca', 'frança', 'france'],
  '🇪🇸': ['espanha', 'spain'],
  '🇵🇹': ['portugal'],
  '🇩🇪': ['alemanha', 'germany'],
  '🇮🇹': ['italia', 'itália', 'italy'],
  '🇳🇱': ['holanda', 'netherlands'],
  '🇧🇪': ['belgica', 'bélgica', 'belgium'],
  '🇨🇭': ['suica', 'suíça', 'switzerland'],
  '🇦🇹': ['austria', 'áustria'],
  '🇵🇱': ['polonia', 'polônia', 'poland'],
  '🇨🇿': ['tchequia', 'rep tcheca', 'czechia'],
  '🇩🇰': ['dinamarca', 'denmark'],
  '🇳🇴': ['noruega', 'norway'],
  '🇸🇪': ['suecia', 'suécia', 'sweden'],
  '🇫🇮': ['finlandia', 'finlândia', 'finland'],
  '🇺🇦': ['ucrania', 'ucrânia', 'ukraine'],
  '🇷🇺': ['russia', 'rússia'],
  '🇬🇷': ['grecia', 'grécia', 'greece'],
  '🇹🇷': ['turquia', 'turkiye', 'türkiye', 'turkey'],
  '🇭🇷': ['croacia', 'croácia', 'croatia'],
  '🇷🇴': ['romenia', 'romênia', 'romania'],
  '🇭🇺': ['hungria', 'hungary'],
  '🇯🇵': ['japao', 'japão', 'japan'],
  '🇰🇷': ['coreia do sul', 'coreia', 'korea'],
  '🇨🇳': ['china'],
  '🇹🇼': ['taiwan', 'taiwan'],
  '🇭🇰': ['hong kong'],
  '🇮🇳': ['india', 'índia', 'india'],
  '🇵🇰': ['paquistao', 'paquistão', 'pakistan'],
  '🇧🇩': ['bangladesh'],
  '🇸🇬': ['singapura', 'singapore'],
  '🇲🇾': ['malasia', 'malásia', 'malaysia'],
  '🇮🇩': ['indonesia', 'indonésia', 'indonesia'],
  '🇹🇭': ['tailandia', 'tailândia', 'thailand'],
  '🇻🇳': ['vietnam', 'vietnã', 'vietna'],
  '🇵🇭': ['filipinas', 'philippines'],
  '🇦🇺': ['australia', 'austrália', 'australia'],
  '🇳🇿': ['nova zelandia', 'nova zelândia', 'new zealand'],
  '🇦🇪': ['emirados arabes', 'emirados árabes', 'uae'],
  '🇸🇦': ['arabia saudita', 'arábia saudita', 'saudi'],
  '🇮🇱': ['israel'],
  '🇪🇬': ['egito', 'egypt'],
  '🇿🇦': ['africa do sul', 'áfrica do sul', 'south africa'],
  '🇳🇬': ['nigeria', 'nigéria'],
  '🇲🇦': ['marrocos', 'morocco'],
  '🇰🇪': ['quenia', 'kenya', 'quênia'],
  '🇦🇴': ['angola'],
  '🇲🇿': ['mocambique', 'moçambique', 'mozambique'],
  '🇨🇻': ['cabo verde', 'cape verde'],
  '🇪🇹': ['etiopia', 'etiópia', 'ethiopia'],
  '🇬🇭': ['gana', 'ghana'],
  '🇸🇳': ['senegal', 'senegal'],
  '🇩🇿': ['argelia', 'argélia', 'algeria'],
  '🇹🇳': ['tunisia', 'tunísia', 'tunisia'],
  '🇺🇳': ['onu', 'united nations', 'nacoes unidas', 'nações unidas'],
  '🇪🇺': ['uniao europeia', 'união europeia', 'european union', 'ue']
};

const EMOJI_ALIAS_GROUPS: Array<{ emojis: string[]; terms: string[] }> = [
  {
    emojis: ['😀', '😃', '😄', '😁', '😆', '🙂', '😊', '😇', '🥰', '😍', '🤩', '😺', '😸', '😻'],
    terms: ['feliz', 'alegre', 'sorrindo', 'sorriso']
  },
  {
    emojis: ['🥳', '🤠', '😎', '🤗'],
    terms: ['animado', 'empolgado', 'festa', 'comemorando']
  },
  {
    emojis: ['😢', '😭', '😞', '🙁', '☹️', '😟', '😿'],
    terms: ['triste', 'deprimido', 'chorando']
  },
  {
    emojis: ['😡', '😠', '🤬', '👿'],
    terms: ['raiva', 'bravo', 'irritado']
  },
  {
    emojis: ['😴', '😪', '🥱'],
    terms: ['sono', 'dormindo', 'cansado']
  },
  {
    emojis: ['😮', '😯', '😲', '😳', '🤯', '🙀'],
    terms: ['surpreso', 'espanto', 'chocado']
  },
  {
    emojis: ['😂', '🤣', '😹'],
    terms: ['rindo', 'risada', 'engracado', 'kkkk', 'kkk']
  },
  {
    emojis: ['😘', '😗', '😚', '😙', '❤️', '💕', '💖', '💘'],
    terms: ['amor', 'romantico', 'carinho', 'beijo']
  }
];

const buildEmojiSearchAliasMap = (): Record<string, string[]> => {
  const merged = new Map<string, Set<string>>();

  for (const [emoji, aliases] of Object.entries(EMOJI_ALIAS_MAP)) {
    const current = merged.get(emoji) || new Set<string>();
    for (const alias of aliases) {
      current.add(alias);
    }
    merged.set(emoji, current);
  }

  for (const group of EMOJI_ALIAS_GROUPS) {
    for (const emoji of group.emojis) {
      const current = merged.get(emoji) || new Set<string>();
      for (const alias of group.terms) {
        current.add(alias);
      }
      merged.set(emoji, current);
    }
  }

  const result: Record<string, string[]> = {};
  for (const [emoji, aliases] of merged.entries()) {
    result[emoji] = Array.from(aliases);
  }
  return result;
};

const EMOJI_SEARCH_ALIAS_MAP = buildEmojiSearchAliasMap();

const createEmojiItems = (category: EmojiCategory, emojis: string[]): EmojiItem[] =>
  emojis.map((emoji) => {
    const categoryTerms = CATEGORY_EXACT_SEARCH_TERMS[category] || [];
    const terms = [
      emoji,
      ...(EMOJI_SEARCH_ALIAS_MAP[emoji] || []),
      category,
      ...categoryTerms
    ];
    return {
      emoji,
      search: normalizeSearchTerm(Array.from(new Set(terms)).join(' '))
    };
  });

const EMOJI_CATEGORIES: Record<EmojiCategory, { label: string; emojis: EmojiItem[] }> = {
  rostos: {
    label: 'Rostos',
    emojis: createEmojiItems('rostos', [
      '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩',
      '😘', '😗', '☺️', '😚', '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🫢', '🫣',
      '🤫', '🤔', '🫡', '🤐', '🤨', '😐', '😑', '😶', '🫥', '😶‍🌫️', '😏', '😒', '🙄', '😬', '😮‍💨',
      '🤥', '😌', '😔', '😪', '🤤', '😴', '🫩', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴',
      '😵', '😵‍💫', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐', '😕', '🫤', '😟', '🙁', '☹️', '😮',
      '😯', '😲', '😳', '🥺', '🥹', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞',
      '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👹', '👺',
      '👻', '👽', '👾', '🤖', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾', '🫨', '🙂‍↔️', '🙂‍↕️'
    ])
  },
  gestos: {
    label: 'Gestos',
    emojis: createEmojiItems('gestos', expandSkinTones([
      '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙', '👈', '👉',
      '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '🫶', '👐', '🤲', '🤝',
      '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🫁', '🦷',
      '🦴', '👀', '👁️', '👅', '👄', '🫦', '🫆'
    ]))
  },
  pessoas: {
    label: 'Pessoas',
    emojis: createEmojiItems('pessoas', [
      '👶', '🧒', '👦', '👧', '🧑', '👨', '👩', '🧔', '🧔‍♂️', '🧔‍♀️', '🧑‍🦰', '🧑‍🦱', '🧑‍🦳', '🧑‍🦲',
      '👱', '👱‍♂️', '👱‍♀️', '🧓', '👴', '👵', '🙍', '🙍‍♂️', '🙍‍♀️', '🙎', '🙎‍♂️', '🙎‍♀️', '🙅', '🙅‍♂️',
      '🙅‍♀️', '🙆', '🙆‍♂️', '🙆‍♀️', '💁', '💁‍♂️', '💁‍♀️', '🙋', '🙋‍♂️', '🙋‍♀️', '🧏', '🧏‍♂️', '🧏‍♀️',
      '🙇', '🙇‍♂️', '🙇‍♀️', '🤦', '🤦‍♂️', '🤦‍♀️', '🤷', '🤷‍♂️', '🤷‍♀️', '🧑‍⚕️', '👨‍⚕️', '👩‍⚕️',
      '🧑‍🎓', '👨‍🎓', '👩‍🎓', '🧑‍🏫', '👨‍🏫', '👩‍🏫', '🧑‍⚖️', '👨‍⚖️', '👩‍⚖️', '🧑‍🌾', '👨‍🌾', '👩‍🌾',
      '🧑‍🍳', '👨‍🍳', '👩‍🍳', '🧑‍🔧', '👨‍🔧', '👩‍🔧', '🧑‍🏭', '👨‍🏭', '👩‍🏭', '🧑‍💼', '👨‍💼', '👩‍💼',
      '🧑‍🔬', '👨‍🔬', '👩‍🔬', '🧑‍💻', '👨‍💻', '👩‍💻', '🧑‍🎤', '👨‍🎤', '👩‍🎤', '🧑‍🎨', '👨‍🎨', '👩‍🎨',
      '🧑‍✈️', '👨‍✈️', '👩‍✈️', '🧑‍🚀', '👨‍🚀', '👩‍🚀', '👮', '👮‍♂️', '👮‍♀️', '🕵️', '🕵️‍♂️', '🕵️‍♀️',
      '👷', '👷‍♂️', '👷‍♀️', '🥷', '👸', '🤴', '🫅', '👳', '👲', '🧕', '🤵', '👰', '🤰', '🫃', '🫄',
      '🤱', '👩‍🍼', '👨‍🍼', '🧑‍🍼', '🧍', '🧎', '🚶', '🏃', '💃', '🕺', '👯', '🧖', '🧘',
      '👭', '👫', '👬', '💏', '💑', '👪', '🗣️', '👤', '👥'
    ])
  },
  animais: {
    label: 'Animais',
    emojis: createEmojiItems('animais', [
      '🐶', '🐕', '🦮', '🐕‍🦺', '🐩', '🐺', '🦊', '🦝', '🐱', '🐈', '🐈‍⬛', '🦁', '🐯', '🐅', '🐆', '🐴',
      '🫎', '🫏', '🐎', '🦄', '🦓', '🦌', '🦬', '🐮', '🐂', '🐃', '🐄', '🐷', '🐖', '🐗', '🐽', '🐏',
      '🐑', '🐐', '🐪', '🐫', '🦙', '🦒', '🐘', '🦣', '🦏', '🦛', '🐭', '🐁', '🐀', '🐹', '🐰', '🐇',
      '🐿️', '🦫', '🦔', '🦇', '🐻', '🐻‍❄️', '🐨', '🐼', '🦥', '🦦', '🦨', '🦘', '🦡', '🦃', '🐔', '🐓',
      '🐣', '🐤', '🐥', '🐦', '🐧', '🕊️', '🦅', '🦆', '🦢', '🦉', '🦤', '🪶', '🦩', '🦚', '🦜', '🪽',
      '🐦‍⬛', '🪿', '🐸', '🐊', '🐢', '🦎', '🐍', '🐲', '🐉', '🦕', '🦖', '🐳', '🐋', '🐬', '🦭', '🐟',
      '🐠', '🐡', '🦈', '🐙', '🐚', '🪸', '🪼', '🦀', '🦞', '🦐', '🦑', '🦪', '🐌', '🦋', '🐛', '🐜',
      '🐝', '🪲', '🐞', '🦗', '🪳', '🕷️', '🕸️', '🦂', '🦟', '🪰', '🪱', '🦠', '🐦‍🔥'
    ])
  },
  comida: {
    label: 'Comidas',
    emojis: createEmojiItems('comida', [
      '🍏', '🍎', '🍐', '🍊', '🍋', '🍋‍🟩', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍',
      '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🫛', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅',
      '🥔', '🍠', '🫚', '🫜', '🍄‍🟫', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩',
      '🍗', '🍖', '🌭', '🍔', '🍟', '🍕', '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗', '🥘', '🫕',
      '🥫', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮',
      '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪',
      '🌰', '🥜', '🍯', '🥛', '🍼', '☕', '🍵', '🧃', '🥤', '🧋', '🍶', '🍺', '🍻', '🥂', '🍷', '🫗',
      '🥃', '🍸', '🍹', '🧉', '🍾', '🧊', '🥄', '🍴', '🍽️', '🥣', '🥡', '🥢', '🧂'
    ])
  },
  objetos: {
    label: 'Objetos',
    emojis: createEmojiItems('objetos', [
      '⌚', '📱', '📲', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '🖲️', '🕹️', '💽', '💾', '💿', '📀', '🧮', '🎥',
      '🎞️', '📷', '📸', '📹', '📼', '🔍', '🔎', '💡', '🔦', '🏮', '🪔', '📔', '📕', '📖', '📗', '📘',
      '📙', '📚', '📓', '📒', '📃', '📜', '📄', '📰', '🗞️', '📑', '🔖', '🏷️', '💰', '🪙', '💴', '💵',
      '💶', '💷', '💸', '💳', '🧾', '✉️', '📧', '📨', '📩', '📤', '📥', '📦', '📫', '📪', '📬', '📭',
      '📮', '🗳️', '✏️', '✒️', '🖋️', '🖊️', '🖌️', '🖍️', '📝', '📁', '📂', '🗂️', '📅', '📆', '🗒️',
      '🗓️', '📇', '📈', '📉', '📊', '📋', '📌', '📍', '📎', '🖇️', '📏', '📐', '✂️', '🗃️', '🗄️',
      '🗑️', '🔒', '🔓', '🔏', '🔐', '🔑', '🗝️', '🔨', '🪓', '⛏️', '⚒️', '🛠️', '🗡️', '⚔️', '🔫',
      '🪃', '🏹', '🛡️', '🪚', '🔧', '🪛', '🔩', '⚙️', '🗜️', '⚖️', '🦯', '🔗', '⛓️', '🪝', '🧰',
      '🧲', '🪜', '🪏', '⚗️', '🧪', '🧫', '🧬', '🔬', '🔭', '📡', '💉', '🩸', '💊', '🩹', '🩺', '🚪', '🪞',
      '🪟', '🛏️', '🛋️', '🪑', '🚽', '🚿', '🛁', '🪤', '🪒', '🧴', '🧷', '🧹', '🧺', '🧻', '🪠', '🧼',
      '🫧', '🪥', '🧽', '🧯', '🛒', '🚬', '⚰️', '🪦', '⚱️', '🗿', '🪧', '⛓️‍💥'
    ])
  },
  natureza: {
    label: 'Natureza',
    emojis: createEmojiItems('natureza', [
      '🌍', '🌎', '🌏', '🌐', '🗺️', '🗾', '🧭', '🏔️', '⛰️', '🌋', '🗻', '🏕️', '🏞️', '🏜️', '🏝️', '🏖️',
      '🏛️', '🏟️', '🏞️', '🌅', '🌄', '🌠', '🎑', '🌇', '🌆', '🏙️', '🌃', '🌌', '🌉', '🌁', '🧱', '🌳',
      '🌲', '🎄', '🌴', '🌵', '🌾', '🌿', '☘️', '🍀', '🍁', '🍂', '🍃', '🪹', '🪺', '🌱', '🌷', '🌸',
      '🌹', '🥀', '🌺', '🌻', '🌼', '🌞', '🌝', '🌛', '🌜', '🌚', '🌕', '🌖', '🌗', '🌘', '🌑', '🌒',
      '🌓', '🌔', '🌙', '🌎', '☀️', '⭐', '🌟', '✨', '⚡', '☄️', '💥', '🔥', '🌪️', '🌈', '☁️', '⛅',
      '⛈️', '🌤️', '🌥️', '🌦️', '🌧️', '🌨️', '🌩️', '❄️', '☃️', '⛄', '🌬️', '💨', '💧', '💦', '☔', '☂️',
      '🌊', '🫧', '🪨', '🪵', '🪾', '🛰️'
    ])
  },
  atividades: {
    label: 'Atividades',
    emojis: createEmojiItems('atividades', [
      '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍',
      '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸️', '🥌',
      '🎿', '⛷️', '🏂', '🪂', '🏋️', '🤼', '🤸', '⛹️', '🤺', '🤾', '🏌️', '🏇', '🧘', '🏄', '🏊', '🤽',
      '🚣', '🧗', '🚴', '🚵', '🎯', '🎳', '🎮', '🕹️', '🎲', '♟️', '🧩', '🧸', '🪅', '🪩', '🎨', '🧵',
      '🪡', '🧶', '🪢', '🎭', '🎪', '🎫', '🎟️', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🪘', '🎷', '🎺',
      '🪗', '🎸', '🪕', '🎻', '📯', '🎚️', '🎛️', '🎙️', '📻', '📺', '📽️', '🎞️', '🎥', '📸', '📹', '📼',
      '🕺', '💃', '🪭', '🪇', '🪉'
    ])
  },
  viagens: {
    label: 'Viagens',
    emojis: createEmojiItems('viagens', [
      '🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚛', '🚜', '🦯',
      '🦽', '🦼', '🛴', '🚲', '🛵', '🏍️', '🛺', '🚨', '🚔', '🚍', '🚘', '🚖', '🛞', '🚡', '🚠',
      '🚟', '🚃', '🚋', '🚞', '🚝', '🚄', '🚅', '🚈', '🚂', '🚆', '🚇', '🚊', '🚉', '✈️', '🛫',
      '🛬', '🛩️', '💺', '🛰️', '🚀', '🛸', '🚁', '🛶', '⛵', '🚤', '🛥️', '🛳️', '⛴️', '🚢',
      '⚓', '🛟', '⛽', '🚧', '🚦', '🚥', '🗺️', '🗿', '🗽', '🗼', '🏰', '🏯', '🏟️', '🎡', '🎢',
      '🎠', '⛲', '⛱️', '🏖️', '🏝️', '🏜️', '🌋', '⛰️', '🏕️', '⛺', '🛖', '🏠', '🏡', '🏢',
      '🏥', '🏦', '🏨', '🏪', '🏫', '🏬', '🏭', '🏛️', '⛪', '🕌', '🛕', '🕍', '⛩️', '🕋', '🌁',
      '🌃', '🏙️', '🌄', '🌅', '🌆', '🌇', '🌉', '♨️', '🎇', '🎆'
    ])
  },
  bandeiras: {
    label: 'Bandeiras',
    emojis: createEmojiItems('bandeiras', [
      '🏁', '🚩', '🎌', '🏴', '🏳️', '🏳️‍🌈', '🏳️‍⚧️', '🏴‍☠️',
      '🇧🇷', '🇦🇷', '🇺🇾', '🇵🇾', '🇨🇱', '🇧🇴', '🇵🇪', '🇨🇴', '🇻🇪', '🇪🇨', '🇲🇽', '🇵🇦', '🇨🇷', '🇨🇺',
      '🇺🇸', '🇨🇦', '🇬🇧', '🇮🇪', '🇫🇷', '🇪🇸', '🇵🇹', '🇩🇪', '🇮🇹', '🇳🇱', '🇧🇪', '🇨🇭', '🇦🇹', '🇵🇱',
      '🇨🇿', '🇩🇰', '🇳🇴', '🇸🇪', '🇫🇮', '🇺🇦', '🇷🇺', '🇬🇷', '🇹🇷', '🇭🇷', '🇷🇴', '🇭🇺',
      '🇯🇵', '🇰🇷', '🇨🇳', '🇹🇼', '🇭🇰', '🇮🇳', '🇵🇰', '🇧🇩', '🇸🇬', '🇲🇾', '🇮🇩', '🇹🇭', '🇻🇳', '🇵🇭',
      '🇦🇺', '🇳🇿', '🇦🇪', '🇸🇦', '🇮🇱', '🇪🇬', '🇿🇦', '🇳🇬', '🇲🇦', '🇰🇪',
      '🇦🇴', '🇲🇿', '🇨🇻', '🇪🇹', '🇬🇭', '🇸🇳', '🇩🇿', '🇹🇳',
      '🇺🇳', '🇪🇺'
    ])
  },
  simbolos: {
    label: 'Símbolos',
    emojis: createEmojiItems('simbolos', [
      '❤️', '🩷', '🧡', '💛', '💚', '💙', '🩵', '💜', '🤎', '🖤', '🩶', '🤍', '💔', '❣️', '💕', '💞',
      '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️',
      '🛐', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '🆔', '⚛️', '🉑',
      '☢️', '☣️', '📴', '📳', '🈶', '🈚', '🈸', '🈺', '🈷️', '✴️', '🆚', '💮', '🉐', '㊙️', '㊗️',
      '🈴', '🈵', '🈹', '🈲', '🅰️', '🅱️', '🆎', '🆑', '🅾️', '🆘', '❌', '⭕', '🛑', '⛔', '📛', '🚫',
      '💯', '💢', '♨️', '🚷', '🚯', '🚳', '🚱', '🔞', '📵', '🚭', '❗', '❕', '❓', '❔', '‼️', '⁉️',
      '🔅', '🔆', '〽️', '⚠️', '🚸', '🔱', '⚜️', '🔰', '♻️', '✅', '🈯', '💹', '❇️', '✳️', '❎', '🌐',
      '💠', 'Ⓜ️', '🌀', '💤', '🏧', '🚾', '♿', '🅿️', '🛗', '🈳', '🈂️', '🛂', '🛃', '🛄', '🛅', '🚹',
      '🚺', '🚼', '⚧', '🚻', '🚮', '🎦', '📶', '🈁', '🔣', 'ℹ️', '🔤', '🔡', '🔠', '🆖', '🆗', '🆙',
      '🆒', '🆕', '🆓', '0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟',
      '🔢', '#️⃣', '*️⃣', '⏏️', '▶️', '⏸️', '⏯️', '⏹️', '⏺️', '⏭️', '⏮️', '⏩', '⏪', '⏫', '⏬',
      '◀️', '🔼', '🔽', '➡️', '⬅️', '⬆️', '⬇️', '↗️', '↘️', '↙️', '↖️', '↕️', '↔️', '↪️', '↩️', '⤴️',
      '⤵️', '🔀', '🔁', '🔂', '🔄', '🔃', '🎵', '🎶', '➕', '➖', '➗', '✖️', '🟰', '♾️', '💲', '💱',
      '™️', '©️', '®️', '〰️', '➰', '➿', '🔚', '🔙', '🔛', '🔝', '🔜', '✔️', '☑️', '🔘', '⚪', '🟠',
      '🟡', '🟢', '🔵', '🟣', '🟤', '⚫', '🔴', '🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '🟫', '⬛', '⬜',
      '◼️', '◻️', '◾', '◽', '▪️', '▫️', '🔶', '🔷', '🔸', '🔹', '🔺', '🔻', '💭', '🗯️', '💬', '🗨️', '🫟'
    ])
  }
};
const EMOJI_CATEGORY_ORDER: EmojiCategory[] = [
  'rostos',
  'gestos',
  'pessoas',
  'animais',
  'comida',
  'objetos',
  'natureza',
  'atividades',
  'viagens',
  'bandeiras',
  'simbolos'
];

const EMOJI_CATEGORY_PRESENTATION = {
  recentes: { label: 'Recentes', icon: History20Regular },
  rostos: { label: 'Rostos', icon: Emoji20Regular },
  gestos: { label: 'Gestos', icon: HandWave20Regular },
  pessoas: { label: 'Pessoas', icon: People20Regular },
  animais: { label: 'Animais', icon: AnimalCat20Regular },
  comida: { label: 'Comidas', icon: Food20Regular },
  objetos: { label: 'Objetos', icon: Toolbox20Regular },
  natureza: { label: 'Natureza', icon: LeafTwo20Regular },
  atividades: { label: 'Atividades', icon: Games20Regular },
  viagens: { label: 'Viagens', icon: VehicleCar20Regular },
  bandeiras: { label: 'Bandeiras', icon: Flag20Regular },
  simbolos: { label: 'Símbolos', icon: Heart20Regular }
} satisfies Record<EmojiPickerCategory, { label: string; icon: typeof Emoji20Regular }>;

export const MessageComposer = ({
  disabled,
  autoFocusKey,
  onSend,
  onSubmitEdit,
  onTypingChange,
  onSendFile,
  onPaste,
  replyDraft,
  onCancelReply,
  editDraft,
  onCancelEdit,
  placeholder
}: MessageComposerProps) => {
  const [text, setText] = useState('');
  const [pendingFilePaths, setPendingFilePaths] = useState<string[]>([]);
  const [pendingAttachmentByPath, setPendingAttachmentByPath] = useState<
    Record<string, PendingAttachmentInfo | null>
  >({});
  const [pendingAttachmentPreviewByPath, setPendingAttachmentPreviewByPath] = useState<
    Record<string, string | null>
  >({});
  const [removingFilePaths, setRemovingFilePaths] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPastingFiles, setIsPastingFiles] = useState(false);
  const [isDragOverFiles, setIsDragOverFiles] = useState(false);
  const [pasteFeedback, setPasteFeedback] = useState<string | null>(null);
  const [pasteProgressItems, setPasteProgressItems] = useState<PasteProgressItem[]>([]);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [stickerOpen, setStickerOpen] = useState(false);
  const [stickers, setStickers] = useState<StickerCatalogItem[]>([]);
  const [stickerLoading, setStickerLoading] = useState(false);
  const [stickerError, setStickerError] = useState<string | null>(null);
  const [failedStickerIds, setFailedStickerIds] = useState<string[]>([]);
  const [stickerSendingId, setStickerSendingId] = useState<string | null>(null);
  const [textContextMenu, setTextContextMenu] = useState<{
    x: number;
    y: number;
    hasSelection: boolean;
  } | null>(null);
  const [emojiCategory, setEmojiCategory] = useState<EmojiPickerCategory>('rostos');
  const [emojiSearch, setEmojiSearch] = useState('');
  const [recentEmojis, setRecentEmojis] = useState<string[]>(readRecentChatEmojis);
  const emojiPickerRef = useRef<HTMLDivElement | null>(null);
  const stickerPickerRef = useRef<HTMLDivElement | null>(null);
  const composerRootRef = useRef<HTMLDivElement | null>(null);
  const composerMirrorRef = useRef<HTMLDivElement | null>(null);
  const typingStateRef = useRef(false);
  const typingTimeoutRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dragDepthRef = useRef(0);
  const dragOverlayVisibleRef = useRef(false);
  const editing = Boolean(editDraft);
  const appendPendingFiles = useCallback((filePaths: string[]) => {
    if (filePaths.length === 0) return;
    setPendingFilePaths((current) => {
      const existing = new Set(current);
      const merged = [...current];
      for (const filePath of filePaths) {
        if (!existing.has(filePath)) {
          merged.push(filePath);
          existing.add(filePath);
        }
      }
      return merged;
    });
  }, []);
  const removePasteProgressItem = useCallback((id: string) => {
    setPasteProgressItems((current) => current.filter((item) => item.id !== id));
  }, []);
  const processFileBlobsAsPending = useCallback(
    async (files: File[], successVerb: 'anexado' | 'colado'): Promise<number> => {
      if (files.length === 0 || !onSendFile || disabled || isSubmitting) {
        return 0;
      }

      setIsPastingFiles(true);
      setPasteFeedback(null);
      let addedCount = 0;

      const updatePasteItem = (id: string, patch: Partial<PasteProgressItem>) => {
        setPasteProgressItems((current) =>
          current.map((item) => (item.id === id ? { ...item, ...patch } : item))
        );
      };

      await Promise.all(
        files.map(
          (file) =>
            new Promise<void>((resolve) => {
              const itemName = (file.name || '').trim() || 'arquivo';
              const pasteId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${itemName}`;
              setPasteProgressItems((current) => [
                ...current,
                {
                  id: pasteId,
                  name: itemName,
                  progress: 2,
                  stage: 'reading'
                }
              ]);

              const reader = new FileReader();
              reader.onprogress = (progressEvent) => {
                const total = progressEvent.total || file.size || 0;
                if (!total) return;
                const fraction = Math.max(0, Math.min(1, progressEvent.loaded / total));
                const progress = Math.max(4, Math.min(86, Math.round(fraction * 86)));
                updatePasteItem(pasteId, { progress, stage: 'reading' });
              };

              reader.onload = () => {
                const dataUrl = typeof reader.result === 'string' ? reader.result : null;
                if (!dataUrl) {
                  updatePasteItem(pasteId, { progress: 100, stage: 'error' });
                  resolve();
                  return;
                }
                updatePasteItem(pasteId, { progress: 92, stage: 'saving' });
                const isImage = (file.type || '').startsWith('image/');
                const extension =
                  ((file.type || '').split('/')[1] || 'bin').replace(/[^a-zA-Z0-9]/g, '') || 'bin';
                const fileName = itemName || undefined;
                const savePromise = isImage
                  ? ipcClient.saveClipboardImage(dataUrl, extension)
                  : ipcClient.saveClipboardFileData(dataUrl, fileName);

                void savePromise
                  .then((savedPath) => {
                    if (savedPath) {
                      addedCount += 1;
                      removePasteProgressItem(pasteId);
                      appendPendingFiles([savedPath]);
                    } else {
                      updatePasteItem(pasteId, { progress: 100, stage: 'error' });
                    }
                  })
                  .catch(() => {
                    updatePasteItem(pasteId, { progress: 100, stage: 'error' });
                  })
                  .finally(() => resolve());
              };

              reader.onerror = () => {
                updatePasteItem(pasteId, { progress: 100, stage: 'error' });
                resolve();
              };

              reader.readAsDataURL(file);
            })
        )
      );

      setIsPastingFiles(false);
      if (addedCount > 0) {
        setPasteFeedback(
          `${addedCount} arquivo${addedCount > 1 ? 's' : ''} ${successVerb}${addedCount > 1 ? 's' : ''}`
        );
      }
      return addedCount;
    },
    [appendPendingFiles, disabled, isSubmitting, onSendFile, removePasteProgressItem]
  );
  const normalizedEmojiSearch = useMemo(() => normalizeSearchTerm(emojiSearch), [emojiSearch]);
  const isEmojiSearching = normalizedEmojiSearch.length > 0;
  const recentEmojiItems = useMemo<EmojiItem[]>(
    () => recentEmojis.map((emoji) => ({ emoji, search: normalizeSearchTerm(`${emoji} ${EMOJI_SEARCH_ALIAS_MAP[emoji]?.join(' ') || ''}`) })),
    [recentEmojis]
  );
  const emojiItems = useMemo(() => {
    if (!normalizedEmojiSearch) {
      if (emojiCategory === 'recentes') return recentEmojiItems;
      return EMOJI_CATEGORIES[emojiCategory].emojis;
    }
    const found: EmojiItem[] = [];
    const seen = new Set<string>();
    for (const category of Object.values(EMOJI_CATEGORIES)) {
      for (const item of category.emojis) {
        if (seen.has(item.emoji)) continue;
        if (item.search.includes(normalizedEmojiSearch)) {
          seen.add(item.emoji);
          found.push(item);
        }
      }
    }

    if (found.length > 0) {
      return found;
    }

    const exactCategoryMatches = EMOJI_CATEGORY_ORDER.filter((category) =>
      CATEGORY_EXACT_SEARCH_TERMS[category].some((term) => normalizeSearchTerm(term) === normalizedEmojiSearch)
    );

    if (exactCategoryMatches.length === 0) {
      return [];
    }

    const categoryFallback: EmojiItem[] = [];
    for (const category of exactCategoryMatches) {
      for (const item of EMOJI_CATEGORIES[category].emojis) {
        if (seen.has(item.emoji)) continue;
        seen.add(item.emoji);
        categoryFallback.push(item);
      }
    }
    return categoryFallback;
  }, [emojiCategory, normalizedEmojiSearch, recentEmojiItems]);

  const chooseChatEmoji = useCallback((emoji: string): void => {
    setText((current) => `${current}${emoji}`);
    setRecentEmojis((current) => {
      const next = [emoji, ...current.filter((item) => item !== emoji)].slice(0, MAX_CHAT_RECENT_EMOJIS);
      try {
        window.localStorage.setItem(CHAT_RECENT_EMOJIS_KEY, JSON.stringify(next));
      } catch {
        // O seletor continua funcional quando o armazenamento local está indisponível.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (emojiPickerRef.current?.contains(target) || stickerPickerRef.current?.contains(target)) {
        return;
      }
      setEmojiOpen(false);
      setStickerOpen(false);
    };

    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, []);

  useEffect(() => {
    if (!emojiOpen) {
      setEmojiSearch('');
      setEmojiCategory('rostos');
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const searchInput = emojiPickerRef.current?.querySelector('input');
      if (searchInput instanceof HTMLInputElement) {
        searchInput.focus();
        searchInput.select();
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [emojiOpen]);

  useEffect(() => {
    if (stickerOpen) {
      setEmojiOpen(false);
    }
  }, [stickerOpen]);

  useEffect(() => {
    if (!stickerOpen) {
      setStickers([]);
      setFailedStickerIds([]);
      setStickerError(null);
      return;
    }
    let cancelled = false;
    setStickerLoading(true);
    setStickerError(null);
    void ipcClient
      .getRelayStickers()
      .then((items) => {
        if (cancelled) return;
        setStickers(items);
        setFailedStickerIds([]);
        setStickerError(items.length === 0 ? 'Nenhuma GIF disponível no Relay.' : null);
      })
      .catch(() => {
        if (cancelled) return;
        setStickers([]);
        setStickerError('Não foi possível carregar GIFs do Relay.');
      })
      .finally(() => {
        if (!cancelled) {
          setStickerLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [stickerOpen]);

  useEffect(() => {
    if (!emojiOpen) return;

    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        !composerRootRef.current?.contains(active) &&
        !emojiPickerRef.current?.contains(active)
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setEmojiOpen(false);

      window.requestAnimationFrame(() => {
        const textarea = composerRootRef.current?.querySelector('textarea');
        if (!(textarea instanceof HTMLTextAreaElement)) return;
        textarea.focus();
        const end = textarea.value.length;
        textarea.setSelectionRange(end, end);
      });
    };

    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, [emojiOpen]);

  useEffect(() => {
    if (!stickerOpen) return;

    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        !composerRootRef.current?.contains(active) &&
        !stickerPickerRef.current?.contains(active)
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setStickerOpen(false);

      window.requestAnimationFrame(() => {
        const textarea = composerRootRef.current?.querySelector('textarea');
        if (!(textarea instanceof HTMLTextAreaElement)) return;
        textarea.focus();
        const end = textarea.value.length;
        textarea.setSelectionRange(end, end);
      });
    };

    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, [stickerOpen]);

  useEffect(() => {
    if (!editDraft) return;
    setText(editDraft.text);
    setPendingFilePaths([]);
    setPendingAttachmentByPath({});
    setPendingAttachmentPreviewByPath({});
    setRemovingFilePaths([]);
    const frame = window.requestAnimationFrame(() => {
      const textarea = getComposerTextarea();
      if (!textarea) return;
      textarea.focus();
      const end = editDraft.text.length;
      textarea.setSelectionRange(end, end);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editDraft?.messageId]);

  useEffect(() => {
    if (disabled) return;
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      const isEditingElsewhere =
        Boolean(active) &&
        (active!.tagName === 'INPUT' ||
          active!.tagName === 'TEXTAREA' ||
          active!.isContentEditable) &&
        !composerRootRef.current?.contains(active);

      if (isEditingElsewhere) {
        return;
      }

      const textarea = composerRootRef.current?.querySelector('textarea');
      if (textarea instanceof HTMLTextAreaElement) {
        textarea.focus();
        const end = textarea.value.length;
        textarea.setSelectionRange(end, end);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocusKey, disabled]);

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        window.clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      if (typingStateRef.current && onTypingChange) {
        void onTypingChange(false);
      }
    };
  }, [onTypingChange]);

  useEffect(() => {
    if (!textContextMenu) return;
    const close = () => setTextContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [textContextMenu]);

  useEffect(() => {
    if (!pasteFeedback) return;
    const timer = window.setTimeout(() => setPasteFeedback(null), 1800);
    return () => window.clearTimeout(timer);
  }, [pasteFeedback]);

  useEffect(() => {
    if (!onSendFile || disabled || isSubmitting) {
      setIsDragOverFiles(false);
      dragDepthRef.current = 0;
      dragOverlayVisibleRef.current = false;
      return;
    }

    const hasFiles = (event: DragEvent): boolean => {
      const filesLen = event.dataTransfer?.files?.length || 0;
      if (filesLen > 0) return true;
      const types = event.dataTransfer?.types;
      if (!types) return false;
      const normalized = Array.from(types).map((type) => type.toLowerCase());
      return normalized.some((type) => type === 'files' || type.includes('file') || type.includes('uri'));
    };

    const decodeFileUri = (uri: string): string | null => {
      const value = uri.trim();
      if (!value.toLowerCase().startsWith('file://')) {
        return null;
      }
      try {
        const parsed = decodeURI(value.replace(/^file:\/\//i, ''));
        if (!parsed) return null;
        if (/^\/[A-Za-z]:\//.test(parsed)) {
          return parsed.slice(1);
        }
        return parsed;
      } catch {
        return null;
      }
    };

    const collectDroppedFilePaths = (event: DragEvent): string[] => {
      const files = Array.from(event.dataTransfer?.files || []);
      const paths: string[] = [];
      for (const file of files) {
        const filePath = (file as File & { path?: string }).path;
        if (typeof filePath === 'string' && filePath.trim()) {
          paths.push(filePath);
        }
      }
      if (paths.length > 0) {
        return paths;
      }

      const uriListRaw = event.dataTransfer?.getData('text/uri-list') || '';
      if (uriListRaw.trim()) {
        for (const line of uriListRaw.split(/\r?\n/)) {
          const entry = line.trim();
          if (!entry || entry.startsWith('#')) continue;
          const decoded = decodeFileUri(entry);
          if (decoded) {
            paths.push(decoded);
          }
        }
      }

      if (paths.length > 0) {
        return paths;
      }

      const plainText = event.dataTransfer?.getData('text/plain') || '';
      if (plainText.trim()) {
        for (const line of plainText.split(/\r?\n/)) {
          const decoded = decodeFileUri(line);
          if (decoded) {
            paths.push(decoded);
          }
        }
      }
      return paths;
    };

    const addDroppedPaths = (paths: string[]) => {
      if (paths.length === 0) return;
      const uniquePathSet = new Set(paths);
      appendPendingFiles(Array.from(uniquePathSet));
      setPasteFeedback(
        `${uniquePathSet.size} arquivo${uniquePathSet.size > 1 ? 's' : ''} anexado${uniquePathSet.size > 1 ? 's' : ''}`
      );
    };

    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current += 1;
      if (!dragOverlayVisibleRef.current) {
        dragOverlayVisibleRef.current = true;
        setIsDragOverFiles(true);
      }
    };

    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      if (!dragOverlayVisibleRef.current) {
        dragOverlayVisibleRef.current = true;
        setIsDragOverFiles(true);
      }
    };

    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0 && dragOverlayVisibleRef.current) {
        dragOverlayVisibleRef.current = false;
        setIsDragOverFiles(false);
      }
    };

    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepthRef.current = 0;
      dragOverlayVisibleRef.current = false;
      setIsDragOverFiles(false);
      const droppedFiles = Array.from(event.dataTransfer?.files || []);
      const filePaths = collectDroppedFilePaths(event);
      if (filePaths.length > 0) {
        addDroppedPaths(filePaths);
        return;
      }
      if (droppedFiles.length > 0) {
        void processFileBlobsAsPending(droppedFiles, 'anexado').then((addedCount) => {
          if (addedCount <= 0) {
            setPasteFeedback('Não foi possível anexar os arquivos soltos.');
          }
        });
        return;
      }
      setPasteFeedback('Não foi possível anexar os arquivos soltos.');
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      dragDepthRef.current = 0;
      dragOverlayVisibleRef.current = false;
    };
  }, [appendPendingFiles, disabled, isSubmitting, onSendFile, processFileBlobsAsPending]);

  useEffect(() => {
    if (pasteProgressItems.length === 0) return;
    const hasDisposableItems = pasteProgressItems.some(
      (item) => item.stage === 'done' || item.stage === 'error'
    );
    if (!hasDisposableItems) return;
    const timer = window.setTimeout(() => {
      setPasteProgressItems((current) =>
        current.filter((item) => item.stage !== 'done' && item.stage !== 'error')
      );
    }, 700);
    return () => window.clearTimeout(timer);
  }, [pasteProgressItems]);

  useEffect(() => {
    let cancelled = false;

    const loadPendingAttachments = async () => {
      if (pendingFilePaths.length === 0) {
        setPendingAttachmentByPath({});
        setPendingAttachmentPreviewByPath({});
        return;
      }

      const results = await Promise.allSettled(
        pendingFilePaths.map(async (filePath) => {
          const [info, preview] = await Promise.all([
            ipcClient.getFileInfo(filePath),
            ipcClient.getFilePreview(filePath)
          ]);
          return { filePath, info, preview };
        })
      );

      if (cancelled) return;
      const nextInfo: Record<string, PendingAttachmentInfo | null> = {};
      const nextPreview: Record<string, string | null> = {};
      for (let i = 0; i < results.length; i += 1) {
        const fallbackPath = pendingFilePaths[i];
        const result = results[i];
        if (result.status === 'fulfilled') {
          nextInfo[result.value.filePath] = result.value.info;
          nextPreview[result.value.filePath] = result.value.preview;
          continue;
        }
        // Mantém os outros anexos carregando mesmo que um único arquivo falhe.
        if (fallbackPath) {
          nextInfo[fallbackPath] = null;
          nextPreview[fallbackPath] = null;
        }
      }
      setPendingAttachmentByPath(nextInfo);
      setPendingAttachmentPreviewByPath(nextPreview);
    };

    void loadPendingAttachments();
    return () => {
      cancelled = true;
    };
  }, [pendingFilePaths]);

  const getFileName = (filePath: string): string => {
    const parts = filePath.split(/[\\/]/);
    return parts[parts.length - 1] || filePath;
  };

  const submit = async (): Promise<void> => {
    const trimmed = text.trim();
    if (editing) {
      if (!trimmed || disabled || isSubmitting || !onSubmitEdit) return;
      setIsSubmitting(true);
      try {
        await onSubmitEdit(trimmed);
        setText('');
        onCancelEdit?.();
      } finally {
        setIsSubmitting(false);
      }
      return;
    }
    if ((!trimmed && pendingFilePaths.length === 0) || disabled || isSubmitting) return;
    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    if (typingStateRef.current && onTypingChange) {
      typingStateRef.current = false;
      void onTypingChange(false);
    }
    setIsSubmitting(true);
    try {
      setText('');
      const replyTo =
        replyDraft
          ? {
              messageId: replyDraft.messageId,
              senderDeviceId: replyDraft.senderDeviceId,
              type: replyDraft.type,
              previewText: replyDraft.previewText || null,
              fileName: replyDraft.fileName || null
            }
          : null;
      let sentSomething = false;
      if (trimmed) {
        await onSend(trimmed, replyTo);
        sentSomething = true;
      }
      if (pendingFilePaths.length > 0 && onSendFile) {
        const filePathsToSend = [...pendingFilePaths];
        setPendingFilePaths([]);
        for (const filePath of filePathsToSend) {
          await onSendFile(filePath, replyTo);
        }
        sentSomething = true;
      }
      if (sentSomething && replyTo) {
        onCancelReply?.();
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const pickAttachment = async (): Promise<void> => {
    if (!onSendFile || disabled || isSubmitting) return;
    try {
      const filePaths = await ipcClient.pickFiles();
      if (!filePaths || filePaths.length === 0) return;
      const normalized = filePaths
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value) => value.length > 0)
        .map((value) => {
          if (!value.toLowerCase().startsWith('file://')) {
            return value;
          }
          try {
            const decoded = decodeURI(value.replace(/^file:\/\//i, ''));
            if (/^\/[A-Za-z]:\//.test(decoded)) {
              return decoded.slice(1);
            }
            return decoded;
          } catch {
            return value;
          }
        });
      const unique = Array.from(new Set(normalized));
      if (unique.length === 0) {
        setPasteFeedback('Nenhum arquivo válido foi selecionado.');
        return;
      }
      appendPendingFiles(unique);
      setPasteFeedback(
        `${unique.length} arquivo${unique.length > 1 ? 's' : ''} anexado${unique.length > 1 ? 's' : ''}`
      );
    } catch {
      setPasteFeedback('Falha ao selecionar arquivos.');
    }
  };

  const formatFileSize = (size: number): string => {
    if (!Number.isFinite(size) || size <= 0) return '0 B';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  const removePendingAttachment = (filePathToRemove: string): void => {
    if (isSubmitting) return;
    setRemovingFilePaths((current) => {
      if (current.includes(filePathToRemove)) return current;
      return [...current, filePathToRemove];
    });

    window.setTimeout(() => {
      setPendingFilePaths((current) => current.filter((filePath) => filePath !== filePathToRemove));
      setRemovingFilePaths((current) => current.filter((filePath) => filePath !== filePathToRemove));
    }, 170);
  };

  const removeAllPendingAttachments = (): void => {
    if (isSubmitting || pendingFilePaths.length <= 1) return;
    setRemovingFilePaths((current) => {
      const merged = new Set(current);
      for (const filePath of pendingFilePaths) {
        merged.add(filePath);
      }
      return Array.from(merged);
    });
    window.setTimeout(() => {
      setPendingFilePaths([]);
      setRemovingFilePaths([]);
    }, 170);
  };

  const processClipboardFiles = useCallback(
    async (files: File[]): Promise<boolean> => {
      if (files.length === 0) {
        return false;
      }
      const addedCount = await processFileBlobsAsPending(files, 'colado');
      return addedCount > 0;
    },
    [processFileBlobsAsPending]
  );

  const sendSticker = async (sticker: StickerCatalogItem): Promise<void> => {
    if (!onSendFile || disabled || isSubmitting || editing || stickerSendingId) return;
    setStickerSendingId(sticker.id);
    try {
      const savedPath = await ipcClient.prepareRelayStickerFile(sticker.relativePath);
      if (!savedPath) {
        throw new Error('Falha ao salvar figurinha.');
      }
      const replyTo =
        replyDraft
          ? {
              messageId: replyDraft.messageId,
              senderDeviceId: replyDraft.senderDeviceId,
              type: replyDraft.type,
              previewText: replyDraft.previewText || null,
              fileName: replyDraft.fileName || null
            }
          : null;
      await onSendFile(savedPath, replyTo);
      if (replyTo) {
        onCancelReply?.();
      }
      setStickerOpen(false);
    } catch {
      setPasteFeedback('Não foi possível enviar a figurinha.');
    } finally {
      setStickerSendingId(null);
    }
  };

  const handlePasteAttachment = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    onPaste?.();
    if (!onSendFile || disabled || isSubmitting) return;
    const items = Array.from(event.clipboardData?.items || []);
    const files = items
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (files.length > 0) {
      event.preventDefault();
      void processClipboardFiles(files);
      return;
    }

    // Fallback para macOS/Windows quando Finder/Explorer copia como file-url.
    const plainText = event.clipboardData?.getData('text/plain') || '';
    if (!/(^|\n)\s*file:\/\//i.test(plainText)) {
      return;
    }
    event.preventDefault();
    setIsPastingFiles(true);
    setPasteFeedback(null);
    void ipcClient
      .getClipboardFilePaths()
      .then((paths) => {
        if (!paths || paths.length === 0) return;
        setPasteFeedback(
          `${paths.length} arquivo${paths.length > 1 ? 's' : ''} colado${paths.length > 1 ? 's' : ''}`
        );
        appendPendingFiles(paths);
      })
      .catch(() => undefined)
      .finally(() => setIsPastingFiles(false));
  };

  const setTyping = (isTyping: boolean): void => {
    if (!onTypingChange) return;
    if (typingStateRef.current === isTyping) return;
    typingStateRef.current = isTyping;
    void onTypingChange(isTyping);
  };

  const getComposerTextarea = (): HTMLTextAreaElement | null => {
    const found = composerRootRef.current?.querySelector('textarea');
    if (found instanceof HTMLTextAreaElement) {
      textareaRef.current = found;
      return found;
    }
    return textareaRef.current;
  };

  const syncComposerMirror = useCallback((): void => {
    const textarea = textareaRef.current;
    const mirror = composerMirrorRef.current;
    if (!textarea || !mirror) return;

    const styles = window.getComputedStyle(textarea);
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.minHeight = `${textarea.clientHeight}px`;
    mirror.style.paddingTop = styles.paddingTop;
    mirror.style.paddingRight = styles.paddingRight;
    mirror.style.paddingBottom = styles.paddingBottom;
    mirror.style.paddingLeft = styles.paddingLeft;
    mirror.style.fontFamily = styles.fontFamily;
    mirror.style.fontSize = styles.fontSize;
    mirror.style.fontWeight = styles.fontWeight;
    mirror.style.fontStyle = styles.fontStyle;
    mirror.style.lineHeight = styles.lineHeight;
    mirror.style.letterSpacing = styles.letterSpacing;
    mirror.style.textAlign = styles.textAlign;
    mirror.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
  }, []);

  useLayoutEffect(() => {
    syncComposerMirror();
  }, [text, syncComposerMirror]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(syncComposerMirror);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [syncComposerMirror]);

  const copyToClipboard = async (value: string): Promise<void> => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // fallback legado
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand('copy');
    } finally {
      document.body.removeChild(textarea);
    }
  };

  const handleComposerContextMenu = (event: ReactMouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const editable = target?.closest('textarea');
    if (!editable) {
      setTextContextMenu(null);
      return;
    }

    const textarea = getComposerTextarea();
    if (!textarea) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const hasSelection = end > start;

    event.preventDefault();
    const menuWidth = 188;
    const menuHeight = hasSelection ? 164 : 68;
    const rootRect = composerRootRef.current?.getBoundingClientRect();
    const rootLeft = rootRect?.left ?? 0;
    const rootTop = rootRect?.top ?? 0;
    const minX = 8 - rootLeft;
    const maxX = window.innerWidth - 8 - rootLeft - menuWidth;
    const minY = 8 - rootTop;
    const maxY = window.innerHeight - 8 - rootTop - menuHeight;
    const x = Math.min(Math.max(event.clientX - rootLeft, minX), maxX);
    const y = Math.min(Math.max(event.clientY - rootTop, minY), maxY);
    setTextContextMenu({ x, y, hasSelection });
  };

  const handleCopySelection = async (): Promise<void> => {
    const textarea = getComposerTextarea();
    if (!textarea) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    if (end <= start) return;
    const selected = textarea.value.slice(start, end);
    await copyToClipboard(selected);
  };

  const handleCutSelection = async (): Promise<void> => {
    const textarea = getComposerTextarea();
    if (!textarea) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    if (end <= start) return;
    const selected = textarea.value.slice(start, end);
    await copyToClipboard(selected);
    const nextValue = `${textarea.value.slice(0, start)}${textarea.value.slice(end)}`;
    setText(nextValue);
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start, start);
    });
  };

  const handlePasteAtCursor = async (): Promise<void> => {
    const textarea = getComposerTextarea();
    if (!textarea) return;
    onPaste?.();
    textarea.focus();
    await ipcClient.nativePaste();
    window.requestAnimationFrame(() => {
      const target = getComposerTextarea();
      if (!target) return;
      target.focus();
      const end = target.value.length;
      target.setSelectionRange(end, end);
    });
  };

  const showAttachmentPanel =
    !editing &&
    (pendingFilePaths.length > 0 ||
      pasteProgressItems.length > 0 ||
      isPastingFiles ||
      Boolean(pasteFeedback));
  const replyPreviewText = useMemo(() => {
    if (!replyDraft) return '';
    if (replyDraft.type === 'file') {
      return replyDraft.fileName || replyDraft.previewText || 'Arquivo';
    }
    return replyDraft.previewText || 'Mensagem';
  }, [replyDraft]);

  return (
    <div className={`composer ${isDragOverFiles ? 'drag-over' : ''}`} ref={composerRootRef}>
      {replyDraft && (
        <div className="composer-reply-draft" role="status">
          <span className="composer-reply-draft-icon" aria-hidden>
            <ArrowReply20Regular />
          </span>
          <div className="composer-reply-draft-content">
            <span className="composer-reply-draft-title">Respondendo a {replyDraft.senderLabel}</span>
            <span className="composer-reply-draft-preview">{replyPreviewText}</span>
          </div>
          <button
            type="button"
            className="composer-reply-draft-cancel"
            onClick={() => onCancelReply?.()}
            aria-label="Cancelar resposta"
            title="Cancelar resposta"
          >
            <Dismiss12Regular />
          </button>
        </div>
      )}
      {editDraft && (
        <div className="composer-reply-draft composer-edit-draft" role="status">
          <span className="composer-reply-draft-icon" aria-hidden>
            <ClipboardEdit20Regular />
          </span>
          <div className="composer-reply-draft-content">
            <span className="composer-reply-draft-title">Editando mensagem</span>
            <span className="composer-reply-draft-preview">Você pode editar por até 10 minutos.</span>
          </div>
          <button
            type="button"
            className="composer-reply-draft-cancel"
            onClick={() => {
              setText('');
              onCancelEdit?.();
            }}
            aria-label="Cancelar edição"
            title="Cancelar edição"
          >
            <Dismiss12Regular />
          </button>
        </div>
      )}
      {showAttachmentPanel && (
        <div
          className={`composer-attachment-pending ${isSubmitting ? 'sending' : ''} ${
            isPastingFiles || pasteProgressItems.length > 0 ? 'attaching' : ''
          }`}
        >
          <div className="composer-attachments-list">
            {(isPastingFiles || pasteProgressItems.length > 0 || pasteFeedback) && (
              <div className="composer-paste-progress-list" aria-live="polite">
                {isPastingFiles && pasteProgressItems.length === 0 && (
                  <div className="composer-paste-progress-item reading">
                    <div className="composer-paste-progress-top">
                      <span className="composer-paste-progress-name">Lendo clipboard…</span>
                      <span className="composer-paste-progress-state">lendo</span>
                    </div>
                    <div className="composer-paste-progress-bar">
                      <span style={{ width: '24%' }} />
                    </div>
                  </div>
                )}
                {pasteProgressItems.map((item) => (
                  <div key={item.id} className={`composer-paste-progress-item ${item.stage}`}>
                    <div className="composer-paste-progress-top">
                      <span className="composer-paste-progress-name">{item.name}</span>
                      <span className="composer-paste-progress-state">
                        {item.stage === 'reading' ? 'lendo' : ''}
                        {item.stage === 'saving' ? 'salvando' : ''}
                        {item.stage === 'done' ? 'pronto' : ''}
                        {item.stage === 'error' ? 'falha' : ''}
                      </span>
                    </div>
                    <div className="composer-paste-progress-bar">
                      <span style={{ width: `${item.progress}%` }} />
                    </div>
                  </div>
                ))}
                {pasteFeedback && !isPastingFiles && (
                  <div className="composer-attachment-sub composer-attachment-total">
                    {pasteFeedback}
                  </div>
                )}
              </div>
            )}
            {pendingFilePaths.map((pendingFilePath) => {
              const pendingAttachment = pendingAttachmentByPath[pendingFilePath] || null;
              const pendingAttachmentPreview = pendingAttachmentPreviewByPath[pendingFilePath] || null;
              const pendingAttachmentLabel = pendingAttachment?.name || getFileName(pendingFilePath) || 'Anexo';
              const isRemoving = removingFilePaths.includes(pendingFilePath);
              return (
                <div
                  key={pendingFilePath}
                  className={`composer-attachment-item ${isRemoving ? 'removing' : ''}`}
                >
                  <div className="composer-attachment-main">
                    {pendingAttachmentPreview && (
                      <img
                        src={pendingAttachmentPreview}
                        alt={pendingAttachmentLabel}
                        className="composer-attachment-preview"
                      />
                    )}
                    <div className="composer-attachment-meta">
                      <span className="composer-attachment-name">📎 {pendingAttachmentLabel}</span>
                      <span className="composer-attachment-sub">
                        {pendingAttachment ? formatFileSize(pendingAttachment.size) : 'Arquivo selecionado'}
                        {pendingAttachment?.isImage ? ' · imagem' : ''}
                        {isSubmitting ? ' · enviando...' : ''}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="composer-attachment-remove"
                    onClick={() => removePendingAttachment(pendingFilePath)}
                    disabled={isSubmitting || isRemoving}
                  >
                    <span className="composer-attachment-remove-icon">
                      <Dismiss12Regular />
                    </span>
                    <span>Remover</span>
                  </button>
                </div>
              );
            })}
            {pendingFilePaths.length > 0 && (
              <div className="composer-attachment-sub composer-attachment-total">
                {pendingFilePaths.length} arquivo(s) pronto(s) para envio
              </div>
            )}
            {pendingFilePaths.length > 1 && (
              <div className="composer-attachment-bulk-actions">
                <button
                  type="button"
                  className="composer-attachment-remove-all"
                  onClick={removeAllPendingAttachments}
                  disabled={isSubmitting}
                >
                  <span className="composer-attachment-remove-icon">
                    <Delete16Regular />
                  </span>
                  <span>Remover todos</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="composer-row">
        <div className="composer-picker-stack">
          <div className="emoji-picker-wrapper" ref={emojiPickerRef}>
            <Button
              appearance="subtle"
              icon={<Emoji20Regular />}
              disabled={disabled}
              onClick={() => {
                setStickerOpen(false);
                setEmojiOpen((open) => !open);
              }}
              title="Emojis"
              aria-label="Emojis"
            />
            <div className={`emoji-picker ${emojiOpen ? 'is-open' : 'is-closed'}`} aria-hidden={!emojiOpen}>
              <div className="emoji-picker-header">
                <div>
                  <strong>Emojis</strong>
                  <span>Escolha um emoji para adicionar à mensagem.</span>
                </div>
              </div>
              <div className="emoji-picker-search">
                <Input
                  size="small"
                  contentBefore={<Search20Regular aria-hidden="true" />}
                  value={emojiSearch}
                  placeholder="Buscar por coração, pizza, gato..."
                  onChange={(_, data) => setEmojiSearch(data.value)}
                  className="emoji-search-input"
                  aria-label="Buscar emoji"
                />
              </div>
              <div className="emoji-picker-content">
                <div className={`emoji-picker-categories ${isEmojiSearching ? 'is-hidden' : 'is-visible'}`} role="tablist" aria-label="Categorias de emoji">
                  {(['recentes', ...EMOJI_CATEGORY_ORDER] as EmojiPickerCategory[])
                    .filter((category) => category !== 'recentes' || recentEmojis.length > 0)
                    .map((category) => {
                      const presentation = EMOJI_CATEGORY_PRESENTATION[category];
                      const Icon = presentation.icon;
                      return (
                        <button
                          key={category}
                          type="button"
                          role="tab"
                          aria-selected={emojiCategory === category}
                          className={`emoji-cat-btn ${emojiCategory === category ? 'active' : ''}`}
                          onClick={() => setEmojiCategory(category)}
                          title={presentation.label}
                        >
                          <Icon aria-hidden="true" />
                          <span>{presentation.label}</span>
                        </button>
                      );
                    })}
                </div>
                <div className="emoji-picker-grid" role="listbox" aria-label={isEmojiSearching ? 'Resultados da busca' : EMOJI_CATEGORY_PRESENTATION[emojiCategory].label}>
                  {emojiItems.map((item) => (
                    <button
                      type="button"
                      key={item.emoji}
                      className="emoji-btn"
                      role="option"
                      aria-selected="false"
                      aria-label={`Adicionar ${item.emoji}`}
                      title={`Adicionar ${item.emoji}`}
                      onClick={() => chooseChatEmoji(item.emoji)}
                    >
                      <PlatformEmoji emoji={item.emoji} decorative />
                    </button>
                  ))}
                </div>
                {emojiItems.length === 0 && (
                  <div className="emoji-picker-empty">
                    {emojiCategory === 'recentes' && !isEmojiSearching
                      ? 'Seus emojis usados recentemente aparecerão aqui.'
                      : <>Nenhum emoji encontrado para &quot;{emojiSearch.trim()}&quot;.</>}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="sticker-picker-wrapper" ref={stickerPickerRef}>
            <Button
              appearance="subtle"
              icon={<Gif20Regular />}
              disabled={disabled || editing || !onSendFile}
              onClick={() => setStickerOpen((open) => !open)}
              title="Figurinhas"
              aria-label="Figurinhas"
            />
            <div className={`sticker-picker ${stickerOpen ? 'is-open' : 'is-closed'}`} aria-hidden={!stickerOpen}>
              <div className="sticker-picker-title">
                <span>Figurinhas do Relay</span>
                <span>{stickerLoading ? 'Carregando...' : `${stickers.length} disponíveis`}</span>
              </div>
              {stickerError ? (
                <div className="sticker-picker-empty">{stickerError}</div>
              ) : stickers.filter((sticker) => !failedStickerIds.includes(sticker.id)).length === 0 ? (
                <div className="sticker-picker-empty">
                  {stickerLoading ? 'Carregando figurinhas...' : 'Nenhuma figurinha válida no Relay.'}
                </div>
              ) : (
                <div className="sticker-picker-grid">
                  {stickers
                    .filter((sticker) => !failedStickerIds.includes(sticker.id))
                    .map((sticker) => (
                    <button
                      key={sticker.id}
                      type="button"
                      className="sticker-btn"
                      disabled={Boolean(stickerSendingId)}
                      onClick={() => void sendSticker(sticker)}
                      title={sticker.label}
                    >
                      {sticker.previewDataUrl ? (
                        <img
                          src={sticker.previewDataUrl}
                          alt={sticker.label}
                          onError={() => {
                            setFailedStickerIds((current) =>
                              current.includes(sticker.id) ? current : [...current, sticker.id]
                            );
                          }}
                        />
                      ) : (
                        <span className="sticker-preview-unavailable" aria-hidden>
                          GIF
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className={`composer-input-shell ${text ? 'has-text' : ''}`}>
          <div className="composer-input-mirror-viewport" aria-hidden="true">
            <div ref={composerMirrorRef} className="composer-input-mirror-content">
              <PlatformEmojiText>{text}</PlatformEmojiText>
              {text.endsWith('\n') ? '\u00a0' : null}
            </div>
          </div>
          <Textarea
            ref={textareaRef}
            className="composer-input"
            value={text}
            disabled={disabled}
            onChange={(_, data) => {
              const next = data.value;
              setText(next);
              if (disabled || !onTypingChange) return;

              if (next.trim().length > 0) {
                setTyping(true);
                if (typingTimeoutRef.current) {
                  window.clearTimeout(typingTimeoutRef.current);
                }
                typingTimeoutRef.current = window.setTimeout(() => {
                  typingTimeoutRef.current = null;
                  setTyping(false);
                }, 1200);
              } else {
                if (typingTimeoutRef.current) {
                  window.clearTimeout(typingTimeoutRef.current);
                  typingTimeoutRef.current = null;
                }
                setTyping(false);
              }
            }}
            placeholder={placeholder}
            resize="none"
            rows={1}
            onScroll={syncComposerMirror}
            onBlur={() => {
              if (!onTypingChange) return;
              if (typingTimeoutRef.current) {
                window.clearTimeout(typingTimeoutRef.current);
                typingTimeoutRef.current = null;
              }
              setTyping(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            onPaste={handlePasteAttachment}
            onContextMenu={handleComposerContextMenu}
          />
        </div>
        <div className="composer-actions">
          {onSendFile && (
            <Button
              className="composer-action-button composer-attach-button"
              icon={<Attach20Regular />}
              onClick={() => void pickAttachment()}
              appearance="secondary"
              disabled={disabled || isSubmitting || editing}
              title="Anexar arquivo"
              aria-label="Anexar arquivo"
            >
              <span className="composer-action-label">Anexar</span>
            </Button>
          )}
          <Button
            className="composer-action-button composer-send-button"
            icon={<Send20Filled />}
            onClick={() => void submit()}
            appearance="primary"
            disabled={disabled || isSubmitting || (!text.trim() && pendingFilePaths.length === 0)}
            title={editing ? 'Salvar alteração' : 'Enviar mensagem'}
            aria-label={editing ? 'Salvar alteração' : 'Enviar mensagem'}
          >
            <span className="composer-action-label">{editing ? 'Salvar' : 'Enviar'}</span>
          </Button>
        </div>
      </div>
      {isDragOverFiles && (
        <div className="composer-drop-overlay" aria-hidden>
          <div className="composer-drop-overlay-card">
            <span className="composer-drop-overlay-icon">📎</span>
            <span>Solte os arquivos para anexar</span>
          </div>
        </div>
      )}

      {textContextMenu && (
        <div
          className="chat-context-menu"
          style={{ left: textContextMenu.x, top: textContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {textContextMenu.hasSelection && (
            <>
              <button
                type="button"
                className="chat-context-item"
                onClick={() => {
                  void handleCopySelection();
                  setTextContextMenu(null);
                }}
              >
                <span className="menu-item-icon">
                  <Copy20Regular />
                </span>
                <span>Copiar</span>
              </button>
              <button
                type="button"
                className="chat-context-item"
                onClick={() => {
                  void handleCutSelection();
                  setTextContextMenu(null);
                }}
              >
                <span className="menu-item-icon">
                  <Cut20Regular />
                </span>
                <span>Recortar</span>
              </button>
            </>
          )}
          <button
            type="button"
            className="chat-context-item"
            onClick={() => {
              setTextContextMenu(null);
              void handlePasteAtCursor();
            }}
          >
            <span className="menu-item-icon">
              <ClipboardPaste20Regular />
            </span>
            <span>Colar</span>
          </button>
        </div>
      )}
    </div>
  );
};
