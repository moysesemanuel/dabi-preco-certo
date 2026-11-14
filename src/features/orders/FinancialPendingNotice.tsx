import { useAccount } from '../../account/AccountContext';
import type { PageProps } from '../../utils';

export function FinancialPendingNotice({ focus }: { focus: PageProps['focus'] }) {
  const acc = useAccount();
  if (!acc.openFinancial) return null;
  return <div className="notice warn" role="alert"><strong>{acc.openFinancial === 1 ? 'Há um recebimento aguardando reconciliação.' : `Há ${acc.openFinancial} encomendas com recebimentos aguardando reconciliação.`}</strong> Foram lançados neste dispositivo, mas a encomenda mudou em outro. Nada foi descartado. <button className="secondary" onClick={() => focus('settings')}>Resolver em Configurações</button></div>;
}
