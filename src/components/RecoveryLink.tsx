import { accountErrorAction } from "../account-errors";

export function RecoveryLink({ code }: { readonly code: string | null }) {
  const action = accountErrorAction(code);
  return action ? <a className="account-recovery" href={action.href}>{action.label}</a> : null;
}
