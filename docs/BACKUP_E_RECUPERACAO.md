# Backup e recuperação

Há dois níveis: os dados **da pessoa** (no aparelho dela) e os dados **do servidor** (D1).

## 1. Dados da pessoa (aparelho)

- Em **Backup**, a pessoa exporta um arquivo `.json` com ingredientes, receitas, encomendas (com custos históricos e recebimentos) e configurações. A restauração **valida tudo antes** (ids duplicados, relacionamentos, valores, datas): se algo estiver inválido, nada é restaurado.
- O arquivo **não contém** senhas, sessões nem chaves, mas contém dados de clientes (nomes): orientar a guardá-lo com cuidado.
- Com conta, o servidor também guarda os dados; ainda assim, recomendar um backup antes de ações grandes (trocar de dispositivo, "Substituir dados deste dispositivo").

## 2. Dados do servidor (D1)

O que existe no banco: usuários, sessões, licenças, dados sincronizados (ingredientes, receitas, itens, encomendas, recebimentos) e orçamentos publicados.

### Backup manual (exportação SQL)

```bash
npx wrangler d1 export dabi-orcamentos-producao --remote --env production --config worker/wrangler.toml --output backup-AAAA-MM-DD.sql
```

- Guarde o arquivo em local seguro e **privado**: ele contém e-mails e dados dos clientes. O hash das chaves de licença também está nele.
- Rotina sugerida: exportar antes de cada migração e em intervalo fixo (ex.: semanal). Mantenha várias cópias e registre a data.

### Recuperação a um ponto no tempo (Time Travel)

O D1 oferece recuperação a um instante anterior (a retenção depende do plano: **confirme na documentação atual da Cloudflare**):

```bash
npx wrangler d1 time-travel info dabi-orcamentos-producao --env production --config worker/wrangler.toml
npx wrangler d1 time-travel restore dabi-orcamentos-producao --timestamp=<ISO-8601> --env production --config worker/wrangler.toml
```

Restaurar **substitui o estado atual do banco**: avise os usuários e anote o horário.

### Restaurar de um arquivo `.sql`

Prefira restaurar **primeiro num banco novo** (homologação), conferir e só então decidir:

```bash
npx wrangler d1 create dabi-orcamentos-restauracao
npx wrangler d1 execute dabi-orcamentos-restauracao --remote --file backup-AAAA-MM-DD.sql
```

**Ensaio já realizado (local):** exportar o D1 local e restaurá-lo em um banco novo preservou as 12 tabelas e os dados (licença e e-mail conferidos). Repita o ensaio em homologação antes de depender do procedimento em produção.

## Checklist de recuperação

1. Identifique o problema e o horário em que começou.
2. Pare de escrever, se possível (ex.: retirar a rota do Worker) para não piorar.
3. Escolha: Time Travel para um instante anterior ao problema, ou restauração de um `.sql` em banco novo.
4. Valide: contagem de usuários/licenças, uma conta de teste sincronizando, página pública de um orçamento.
5. Comunique os usuários afetados. Os aparelhos guardam cópia local e reenviam alterações pendentes ao reconectar (o servidor trata reenvios idênticos como "sem alteração").
6. Registre o ocorrido e o que mudar para evitar repetição.

## O que NÃO é recuperável

- Orçamentos **revogados** continuam no banco (revogação é lógica), mas estão indisponíveis ao público.
- Dados que só existiam em um aparelho, sem conta e sem backup `.json`, se o aparelho for perdido.
