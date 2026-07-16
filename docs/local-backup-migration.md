# Migração de backups locais para o Relay

O aplicativo **Lantern Migration** consolida backups exportados pela edição antiga do Lantern em um Relay novo. Ele importa contas, perfis, mensagens diretas, anúncios, grupos, reações, leituras, preferências e anexos. O comando `migrate:local-backups` continua disponível para automação e usa o mesmo motor.

## Aplicativo com interface

Durante o desenvolvimento, abra com `npm run migration-ui:dev`. Os instaladores são produzidos com `npm run migration-ui:build:mac` ou `npm run migration-ui:build:win`.

1. Selecione a pasta que reúne os backups antigos.
2. Opcionalmente, selecione o JSON de mapeamento e as opções de contingência.
3. Execute **Analisar backups**. A interface mostra totais, conflitos, avisos e o relatório sem alterar o Relay.
4. Escolha onde salvar e use **Gerar backup convertido**. A ferramenta cria `Lantern-Backup-Convertido-<data>` com banco, anexos, manifesto SHA-256 e a relação das contas convertidas.
5. No **Lantern Relay UI**, use **Importar backup convertido** e selecione essa pasta. O Relay valida a integridade, interrompe o servidor, preserva os dados atuais para rollback, importa e volta a iniciar automaticamente caso estivesse em execução.

## Antes de começar

1. Peça para cada usuário exportar seu backup completo.
2. Coloque todas as pastas `LanternBackup-*` dentro de uma única pasta.
3. Use preferencialmente um Relay novo. A importação pela Relay UI não cria conta administrativa padrão; o bootstrap `admin` existe somente quando o Relay headless é iniciado diretamente com um banco vazio.

A ferramenta é estrita por padrão. Backups ausentes, `messageId` conflitante e anexos sem bytes impedem a aplicação.

## 1. Dry-run obrigatório

```bash
npm run migrate:local-backups -- \
  --backups "/caminho/para/backups-dos-usuarios"
```

Nenhum dado é alterado sem `--apply`. O relatório JSON informa backups e perfis encontrados, usuários propostos, totais, participantes ausentes e conflitos.

## 2. Mapeamento opcional de contas

Use `--mapping` para definir usuários, setores e, opcionalmente, senhas já conhecidas:

```json
{
  "users": {
    "device-id-do-backup": {
      "username": "gabriel",
      "password": "uma-senha-temporaria-segura",
      "department": "Tecnologia",
      "role": "user"
    }
  }
}
```

As chaves são os `deviceId` mostrados no dry-run. Quando o mapeamento não informa uma senha, a conta convertida fica com a criação de senha pendente: o usuário entra pela primeira vez informando apenas o nome de usuário e define sua senha obrigatoriamente no assistente inicial. Quando uma senha é informada no mapeamento, ela é preservada e essa etapa não aparece.

A relação fica no arquivo `contas-convertidas.json` dentro do backup convertido, criado com permissão restrita ao usuário do sistema. O arquivo indica quais contas ainda precisam criar uma senha, sem inventar ou armazenar senhas temporárias para elas.

## 3. Geração do backup convertido

```bash
npm run migrate:local-backups -- \
  --backups "/caminho/para/backups-dos-usuarios" \
  --output "/caminho/onde/salvar" \
  --mapping "/caminho/migration-map.json" \
  --report "/caminho/relatorio-final.json" \
  --convert
```

A conversão acontece em staging e não acessa a instalação do Relay. Na importação, o Relay UI confere todos os tamanhos e hashes antes da troca. O estado anterior é preservado como `<relay-data>.pre-import-<data>`; se houver falha, o destino original permanece intocado. GIFs já administradas pelo Relay UI são preservadas.

## Opções de contingência

Estas opções descartam dados e exigem revisão prévia do relatório:

- `--allow-missing-users`: ignora mensagens relacionadas a participantes sem backup.
- `--allow-missing-attachments`: ignora mensagens de arquivo cujos bytes não foram encontrados ou não conferem com tamanho/SHA-256.

## Regras de consolidação

- Perfis são identificados pelo `deviceId` antigo e convertidos em contas canônicas.
- Cópias da mesma mensagem são deduplicadas por `messageId`.
- Conteúdo divergente com o mesmo `messageId` é um conflito fatal.
- IDs de conversas diretas são reconstruídos com os novos `userId`.
- Grupos mantêm `groupId`, membros, funções, mensagens, reações e fixações.
- Reações de conversas e anúncios, além das leituras de anúncios, são vinculadas às novas contas.
- Anexos são verificados, divididos em chunks e cifrados com a chave do Relay.
- Arquivamento, leitura, favoritos e mensagens ocultas são associados à conta correta.

Depois da importação, valide usuários, grupos, mensagens antigas e alguns anexos antes de remover o rollback ou o arquivo com a relação das contas convertidas.
