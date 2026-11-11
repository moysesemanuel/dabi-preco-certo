import type { ReactNode } from 'react';
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div><label>{label}</label>{children}</div>;
}
