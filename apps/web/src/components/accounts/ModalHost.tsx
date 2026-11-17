import { useAccounts } from '../../lib/accounts';
import { GroupsDialog } from './Groups';
import { RequestInviteDialog, SecurityDialog } from './Security';

/** Dialogs owned by the accounts module, kept out of the main modal list. */
export function AccountsModalHost() {
  const modal = useAccounts((state) => state.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case 'groups':
      return <GroupsDialog />;
    case 'security':
      return <SecurityDialog />;
    case 'requestInvite':
      return <RequestInviteDialog />;
  }
}
