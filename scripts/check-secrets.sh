#!/bin/sh
# Verificação simples de segredos acidentais nos arquivos versionados. Não substitui uma ferramenta dedicada.
# Ignora arquivos de exemplo (*.example) e a pasta de documentação, que citam nomes de variáveis.
set -u
status=0
files=$(git ls-files | grep -v -E '(^docs/|\.example$|package-lock\.json$|^scripts/check-secrets\.sh$)')
check() {
  desc=$1; pattern=$2
  hits=$(echo "$files" | xargs grep -n -I -E "$pattern" 2>/dev/null || true)
  if [ -n "$hits" ]; then echo "POSSÍVEL SEGREDO ($desc):"; echo "$hits"; status=1; fi
}
check "chave privada"                 'BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY'
check "token da Cloudflare"           'CLOUDFLARE_API_TOKEN *[=:] *[A-Za-z0-9_-]{20,}'
check "AUTH_SECRET com valor"         'AUTH_SECRET *[=:] *["'"'"']?[A-Za-z0-9_+/=-]{12,}'
check "chave de licença literal"      'dabi_lic_[A-Za-z0-9_-]{32}'
check "token de acesso genérico"      '(ghp_|github_pat_|sk-live-|xox[bap]-)[A-Za-z0-9_-]{16,}'
[ "$status" -eq 0 ] && echo "Nenhum segredo óbvio encontrado." || echo "Revise os itens acima antes de seguir."
exit $status
