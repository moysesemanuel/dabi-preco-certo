# Diagnóstico de conflito recorrente em `packagingItems`

## Causa

Havia duas causas locais capazes de produzir o aviso sem concorrência real:

1. O comparador canônico tratava a propriedade `packagingItems` ausente (formato legado) como diferente de `[]` (formato novo sem embalagens). Também comparava a ordem da lista, embora a associação seja um conjunto de itens identificados por `packagingId`.
2. No merge de três vias, quando a nuvem devolvia a mesma versão da base e só o registro local havia mudado, o motor não reconhecia que a alteração era exclusivamente local. Caía no ramo de conflito real. Isso aparece ao salvar uma receita que ganha `packagingItems: []` sem alterar embalagens.

Há ainda uma incompatibilidade possível no fluxo `npm run dev:staging`: o Vite encaminha `/api` para o Worker publicado de staging. O Worker anterior à implementação de embalagens não persiste `packagingItems`. Nesse caso, um push pode ser aceito e o pull devolver a receita sem os itens. Esse estado não representa uma edição concorrente. O motor agora o reconhece como incompatibilidade do servidor, mantém os dados locais e pede atenção; não cria conflito nem repete o ciclo de push dentro da mesma sincronização. O Worker remoto e a migração não foram consultados nem alterados nesta correção local.

## Regras de comparação

- Em receitas, propriedade ausente, `null` e lista vazia representam “nenhuma embalagem”.
- Listas não vazias são comparadas por conteúdo, sem depender da ordem.
- `packagingId`, quantidade e demais campos continuam fazendo parte da comparação. Conteúdos diferentes permanecem diferentes.
- A canonicalização opera em cópia e não altera os arrays recebidos.
- Se a nuvem está igual à base, o motor mantém a edição local e avança a revisão/base da nuvem.
- Se ambas as versões se afastaram da base, o conflito permanece e as duas versões ficam preservadas.
- Se um push com embalagem recebe confirmação mas o pull não contém o dado nessa revisão, o cliente retorna `needs-attention`, retém a edição local e informa que o Worker/banco precisam suportar o campo.

## Modal de conflito

`Embalagens da receita` é exibido por nome, quantidade por unidade e custo unitário quando disponível. Lista vazia aparece como “Nenhuma embalagem”; campo ausente aparece como “Registro legado sem informação de embalagens”. A interface não serializa objetos para o usuário.

## Evidências locais

Os testes determinísticos cobrem equivalência legado/vazio, ordem semântica, conteúdos divergentes, edição exclusivamente local, Worker antigo simulado que descarta o campo, conflito real entre dois dispositivos, resolução local e remota, recarga de metadados via IndexedDB e resolução offline seguida de reconexão.

Para desenvolvimento local contra o Worker compilado no repositório, use `npm run dev`. `npm run dev:staging` é uma integração com o Worker remoto de staging e pode expor incompatibilidade de versão até o deploy autorizado do backend e a aplicação remota da migração correspondente. Não tente corrigir essa diferença apagando IndexedDB ou enviando repetidamente o formato novo.

## Limites

Os testes usam o Worker local e uma simulação explícita do comportamento legado. Não comprovam a versão atualmente publicada no staging nem aplicam migrações remotas. Antes de homologar sincronização de embalagens no staging, publicar o Worker e a migração correspondente em uma janela autorizada e verificar uma receita de teste com embalagem. Nenhuma alteração remota foi executada nesta tarefa.
