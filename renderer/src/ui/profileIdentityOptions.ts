export interface ProfileEmojiOption {
  emoji: string;
  label: string;
  keywords: string[];
}

export interface ProfileEmojiCategory {
  id: 'expressions' | 'people' | 'nature' | 'food' | 'activities';
  label: string;
  options: ProfileEmojiOption[];
}

export interface ProfileColorOption {
  value: string;
  label: string;
}

const option = (emoji: string, label: string, ...keywords: string[]): ProfileEmojiOption => ({
  emoji,
  label,
  keywords
});

export const PROFILE_EMOJI_CATEGORIES: ProfileEmojiCategory[] = [
  {
    id: 'expressions',
    label: 'Rostos e emoções',
    options: [
      option('🙂', 'Sorriso leve', 'feliz', 'rosto'),
      option('😀', 'Sorriso', 'feliz', 'alegre'),
      option('😄', 'Muito feliz', 'alegre', 'rindo'),
      option('😁', 'Sorriso aberto', 'feliz'),
      option('😂', 'Rindo com lágrimas', 'risada'),
      option('😊', 'Sorriso gentil', 'feliz'),
      option('😉', 'Piscadinha', 'brincadeira'),
      option('😍', 'Apaixonado', 'amor'),
      option('🥰', 'Carinhoso', 'amor', 'carinho'),
      option('😎', 'Descolado', 'óculos', 'legal'),
      option('🤓', 'Nerd', 'óculos', 'estudo'),
      option('🧐', 'Curioso', 'investigar'),
      option('🤠', 'Cowboy', 'chapéu'),
      option('🥳', 'Festa', 'comemoração'),
      option('🤩', 'Encantado', 'estrela'),
      option('🤗', 'Abraço', 'carinho'),
      option('🫡', 'Saudação', 'respeito'),
      option('🤔', 'Pensando', 'dúvida'),
      option('😴', 'Dormindo', 'sono'),
      option('🫠', 'Derretendo', 'calor'),
      option('😶‍🌫️', 'Nas nuvens', 'confuso'),
      option('🥺', 'Emocionado', 'pedido'),
      option('😭', 'Chorando', 'triste'),
      option('🤯', 'Surpreso', 'explodindo'),
      option('🤪', 'Divertido', 'maluco'),
      option('🫶', 'Coração com as mãos', 'amor'),
      option('🙌', 'Comemorando', 'vitória'),
      option('👏', 'Aplausos', 'parabéns')
    ]
  },
  {
    id: 'people',
    label: 'Pessoas e trabalho',
    options: [
      option('🧠', 'Cérebro', 'ideia', 'inteligência'),
      option('👩‍💻', 'Desenvolvedora', 'computador', 'trabalho'),
      option('👨‍💻', 'Desenvolvedor', 'computador', 'trabalho'),
      option('🧑‍💻', 'Pessoa desenvolvedora', 'computador', 'trabalho'),
      option('👩‍🔬', 'Cientista', 'pesquisa'),
      option('👨‍🔬', 'Cientista', 'pesquisa'),
      option('🧑‍🏫', 'Professor', 'ensino'),
      option('👩‍💼', 'Executiva', 'empresa'),
      option('👨‍💼', 'Executivo', 'empresa'),
      option('💼', 'Maleta', 'trabalho', 'negócios'),
      option('🖥️', 'Computador', 'tecnologia'),
      option('🛠️', 'Ferramentas', 'manutenção'),
      option('📚', 'Livros', 'estudo'),
      option('📝', 'Anotações', 'escrever'),
      option('📅', 'Calendário', 'agenda'),
      option('📌', 'Alfinete', 'fixar'),
      option('📈', 'Gráfico crescente', 'resultado'),
      option('📊', 'Gráfico', 'dados'),
      option('🎯', 'Alvo', 'objetivo'),
      option('🚀', 'Foguete', 'lançamento'),
      option('⚡', 'Raio', 'energia'),
      option('💡', 'Ideia', 'lâmpada'),
      option('✅', 'Concluído', 'check'),
      option('🔒', 'Cadeado', 'segurança')
    ]
  },
  {
    id: 'nature',
    label: 'Animais e natureza',
    options: [
      option('🐶', 'Cachorro', 'animal'),
      option('🐱', 'Gato', 'animal'),
      option('🐰', 'Coelho', 'animal'),
      option('🦊', 'Raposa', 'animal'),
      option('🐼', 'Panda', 'animal'),
      option('🐨', 'Coala', 'animal'),
      option('🦁', 'Leão', 'animal'),
      option('🐯', 'Tigre', 'animal'),
      option('🐸', 'Sapo', 'animal'),
      option('🐵', 'Macaco', 'animal'),
      option('🐧', 'Pinguim', 'animal'),
      option('🦄', 'Unicórnio', 'animal', 'fantasia'),
      option('🐢', 'Tartaruga', 'animal'),
      option('🐬', 'Golfinho', 'animal', 'mar'),
      option('🐙', 'Polvo', 'animal', 'mar'),
      option('🐳', 'Baleia', 'animal', 'mar'),
      option('🦉', 'Coruja', 'animal'),
      option('🦋', 'Borboleta', 'animal'),
      option('🐝', 'Abelha', 'animal'),
      option('🦦', 'Lontra', 'animal'),
      option('🌻', 'Girassol', 'flor'),
      option('🌵', 'Cacto', 'planta'),
      option('🌈', 'Arco-íris', 'natureza'),
      option('⭐', 'Estrela', 'céu')
    ]
  },
  {
    id: 'food',
    label: 'Comidas e bebidas',
    options: [
      option('🍕', 'Pizza', 'comida'),
      option('🍔', 'Hambúrguer', 'comida'),
      option('🍟', 'Batata frita', 'comida'),
      option('🌮', 'Taco', 'comida'),
      option('🍣', 'Sushi', 'comida'),
      option('🍜', 'Lámen', 'comida'),
      option('🍝', 'Macarrão', 'comida'),
      option('🥗', 'Salada', 'comida'),
      option('🥐', 'Croissant', 'comida'),
      option('🍩', 'Rosquinha', 'comida'),
      option('🍪', 'Biscoito', 'comida'),
      option('🧁', 'Cupcake', 'comida'),
      option('🍰', 'Bolo', 'comida'),
      option('🍫', 'Chocolate', 'comida'),
      option('🍓', 'Morango', 'fruta'),
      option('🍉', 'Melancia', 'fruta'),
      option('🍍', 'Abacaxi', 'fruta'),
      option('🥭', 'Manga', 'fruta'),
      option('☕', 'Café', 'bebida'),
      option('🍵', 'Chá', 'bebida'),
      option('🧃', 'Suco', 'bebida'),
      option('🧋', 'Chá de bolhas', 'bebida'),
      option('🍺', 'Cerveja', 'bebida'),
      option('🍷', 'Vinho', 'bebida')
    ]
  },
  {
    id: 'activities',
    label: 'Atividades e símbolos',
    options: [
      option('✨', 'Brilhos', 'especial'),
      option('🌟', 'Estrela brilhante', 'destaque'),
      option('🔥', 'Fogo', 'energia'),
      option('❤️', 'Coração', 'amor'),
      option('💜', 'Coração roxo', 'amor'),
      option('💙', 'Coração azul', 'amor'),
      option('🎉', 'Confete', 'festa'),
      option('🎈', 'Balão', 'festa'),
      option('🎵', 'Música', 'som'),
      option('🎮', 'Videogame', 'jogo'),
      option('🎨', 'Arte', 'pintura'),
      option('📷', 'Câmera', 'foto'),
      option('⚽', 'Futebol', 'esporte'),
      option('🏀', 'Basquete', 'esporte'),
      option('🏆', 'Troféu', 'vitória'),
      option('🥇', 'Medalha', 'vitória'),
      option('🧩', 'Quebra-cabeça', 'jogo'),
      option('🧭', 'Bússola', 'direção'),
      option('🔔', 'Sino', 'notificação'),
      option('📣', 'Megafone', 'anúncio'),
      option('🛡️', 'Escudo', 'proteção'),
      option('🔮', 'Bola de cristal', 'futuro'),
      option('💎', 'Diamante', 'joia'),
      option('🪄', 'Varinha mágica', 'magia')
    ]
  }
];

export const PROFILE_EMOJI_OPTIONS = PROFILE_EMOJI_CATEGORIES.flatMap(
  (category) => category.options
);

export const PROFILE_COLOR_OPTIONS: ProfileColorOption[] = [
  { value: '#147ad6', label: 'Azul Lantern' },
  { value: '#4f6bed', label: 'Azul vivo' },
  { value: '#5b5fc7', label: 'Índigo' },
  { value: '#8764b8', label: 'Violeta' },
  { value: '#c239b3', label: 'Magenta' },
  { value: '#d13438', label: 'Vermelho' },
  { value: '#e74856', label: 'Coral' },
  { value: '#f7630c', label: 'Laranja' },
  { value: '#ffb900', label: 'Amarelo' },
  { value: '#8cbd18', label: 'Lima' },
  { value: '#107c10', label: 'Verde' },
  { value: '#00a892', label: 'Verde água' },
  { value: '#00b7c3', label: 'Turquesa' },
  { value: '#69797e', label: 'Cinza azulado' },
  { value: '#6b7280', label: 'Grafite' },
  { value: '#8e8cd8', label: 'Lavanda' }
];

export const isProfileColor = (value: string): boolean => /^#[0-9a-fA-F]{6}$/.test(value.trim());
