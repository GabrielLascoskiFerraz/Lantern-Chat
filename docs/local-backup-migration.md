# Migração de backups locais para o Relay

O aplicativo **Lantern Migration** consolida backups exportados pela edição antiga do Lantern em um Relay novo. Ele importa contas, perfis, mensagens diretas, anúncios, grupos, reações, leituras, preferências e anexos. O comando `migrate:local-backups` continua disponível para automação e usa o mesmo motor.

## Aplicativo com interface

Durante o desenvolvimento, abra com `npm run migration-ui:dev`. Os instaladores são produzidos com `npm run migration-ui:build:mac` ou `npm run migration-ui:build:win`.

1. Selecione a pasta que reúne os backups e a pasta `relay-data` de destino.
2. Opcionalmente, selecione o JSON de mapeamento e as opções de contingência.
3. Execute **Analisar backups**. A interface mostra totais, conflitos, avisos e o relatório sem alterar o Relay.
4. O botão **Aplicar migração** só é liberado para a mesma configuração que passou pela análise.
5. Encerre completamente o Relay, confirme o aviso e aplique. Ao final, abra o relatório e valide o rollback informado.

## Antes de começar

1. Peça para cada usuário exportar seu backup completo.
2. Coloque todas as pastas `LanternBackup-*` dentro de uma única pasta.
3. Pare completamente o Lantern Relay.
4. Use preferencialmente um Relay novo, sem histórico. Nenhuma conta administrativa padrão é criada automaticamente.

A ferramenta é estrita por padrão. Backups ausentes, `messageId` conflitante e anexos sem bytes impedem a aplicação.

## 1. Dry-run obrigatório

```bash
npm run migrate:local-backups -- \
  --backups "/caminho/para/backups-dos-usuarios" \
  --relay-data "/caminho/para/dados-do-relay"
```

Nenhum dado é alterado sem `--apply`. O relatório JSON informa backups e perfis encontrados, usuários propostos, totais, participantes ausentes e conflitos.

## 2. Mapeamento opcional de contas

Use `--mapping` para definir usuários, setores e senhas iniciais:

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

As chaves são os `deviceId` mostrados no dry-run. Sem senha informada, a ferramenta gera uma senha temporária aleatória. As credenciais ficam somente no relatório final, criado com permissão restrita ao usuário do sistema.

## 3. Aplicação

```bash
npm run migrate:local-backups -- \
  --backups "/caminho/para/backups-dos-usuarios" \
  --relay-data "/caminho/para/dados-do-relay" \
  --mapping "/caminho/migration-map.json" \
  --report "/caminho/relatorio-final.json" \
  --apply
```

A aplicação acontece em uma cópia de staging. Somente depois de validar e cifrar os dados essa cópia substitui o diretório do Relay. O diretório anterior é preservado como `<relay-data>.pre-migration-<data>`. Se a importação falhar antes da troca, o destino original permanece intocado. O relatório deve ser salvo fora de `<relay-data>`.

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

Depois da migração, inicie o Relay e valide usuários, grupos, mensagens antigas e alguns anexos antes de remover o rollback.
