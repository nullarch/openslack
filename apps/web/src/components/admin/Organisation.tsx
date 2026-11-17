import { useCallback, useEffect, useState } from 'react';
import { attempt, toast } from '../../lib/actions';
import { call } from '../../lib/api';
import { displayName, useStore } from '../../lib/store';
import type { User } from '@app/shared';
import { S } from '../../strings';
import { confirmDialog, promptDialog } from '../dialogs/confirm';
import { Button, Field, Spinner } from '../ui';

/** Admin lists name people in full. */
const fullName = (user: User | undefined): string => user?.real_name || displayName(user);

interface OrgWorkspace {
  id: string;
  name: string;
  domain: string;
  description: string;
  members: string[];
}

interface OrgInfo {
  organisation: { id: string; name: string; domain: string };
  workspaces: OrgWorkspace[];
  roles: { id: string; name: string; scope: 'org' | 'team' }[];
  assignments: { role_id: string; entity_id: string; user_id: string; created: number }[];
}

/**
 * Administration → Organisation: further workspaces (each with its own members
 * and channels; everyone is in the organisation's own) and admin roles, which
 * let people who are not admins run parts of the administration.
 */
export function OrganisationAdmin() {
  const [info, setInfo] = useState<OrgInfo | null>(null);
  const isAdmin = useStore((state) => Boolean(state.self?.is_admin));
  const roles = useStore((state) => state.adminRoles);
  const load = useCallback(() => {
    call('client.org.info')
      .then((result) => setInfo(result as unknown as OrgInfo))
      .catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  if (!info) return <Spinner />;
  const org = info.organisation.id;
  // Role Admins manage roles; User Admins manage who is in which workspace.
  const roleAdmin = isAdmin || roles.some((entry) => entry.role_id === 'Rl02' && entry.entity_id === org);
  const userAdmin = (workspace: string): boolean => isAdmin || roles.some((entry) => entry.role_id === 'Rl03' && (entry.entity_id === org || entry.entity_id === workspace));

  return (
    <div className="org-admin">
      <section className="compliance-section">
        <h3 className="dialog-sub">{S.org.workspaces}</h3>
        <p className="field-hint">{S.org.workspacesHint}</p>
        <ul className="admin-list">
          <li>
            <div className="admin-meta">
              <strong>{info.organisation.name}</strong>
              <span className="muted">{S.org.everyone}</span>
            </div>
          </li>
        </ul>
        {info.workspaces.map((workspace) => (
          <WorkspaceRow key={workspace.id} workspace={workspace} canManage={userAdmin(workspace.id)} isAdmin={isAdmin} onChange={load} />
        ))}
        {isAdmin ? <CreateWorkspace onCreated={load} /> : null}
      </section>
      <RolesSection info={info} canManage={roleAdmin} isAdmin={isAdmin} onChange={load} />
    </div>
  );
}

function CreateWorkspace({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [busy, setBusy] = useState(false);
  const create = async (): Promise<void> => {
    setBusy(true);
    const result = await attempt(() => call('admin.teams.create', { team_name: name.trim(), team_domain: domain.trim() }));
    setBusy(false);
    if (!result) return;
    toast(S.org.created(name.trim()));
    setName('');
    setDomain('');
    onCreated();
  };
  return (
    <div className="org-create">
      <h4>{S.org.create}</h4>
      <Field label={S.org.name}>
        <input value={name} placeholder="Engineering" onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label={S.org.domain} hint={S.org.domainHint}>
        <input
          value={domain}
          placeholder="engineering"
          spellCheck={false}
          onChange={(event) => setDomain(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
        />
      </Field>
      <Button variant="primary" busy={busy} disabled={!name.trim() || !domain.trim()} onClick={() => void create()}>
        {S.org.create}
      </Button>
    </div>
  );
}

function WorkspaceRow({ workspace, canManage, isAdmin, onChange }: { workspace: OrgWorkspace; canManage: boolean; isAdmin: boolean; onChange: () => void }) {
  const users = useStore((state) => state.users);
  const [adding, setAdding] = useState('');
  const inside = new Set(workspace.members);
  const candidates = Object.values(users)
    .filter((user) => !user.deleted && !user.is_bot && !inside.has(user.id) && !user.team_name)
    .sort((a, b) => fullName(a).localeCompare(fullName(b)));
  const add = async (): Promise<void> => {
    if (!adding) return;
    if (await attempt(() => call('admin.users.assign', { team_id: workspace.id, user_id: adding }))) {
      setAdding('');
      onChange();
    }
  };
  const remove = async (userId: string): Promise<void> => {
    if (!(await confirmDialog(S.org.confirmRemove(fullName(users[userId]), workspace.name), S.org.remove))) return;
    if (await attempt(() => call('admin.users.remove', { team_id: workspace.id, user_id: userId }))) onChange();
  };
  const rename = async (): Promise<void> => {
    const name = await promptDialog({ title: S.org.rename, label: S.org.name, initial: workspace.name, confirmLabel: S.done });
    if (!name || name.trim() === workspace.name) return;
    if (await attempt(() => call('admin.teams.settings.setName', { team_id: workspace.id, name: name.trim() }))) onChange();
  };
  return (
    <div className="org-workspace">
      <div className="org-workspace-head">
        <strong>{workspace.name}</strong>
        <span className="muted">{S.org.memberCount(workspace.members.length)}</span>
        {isAdmin ? (
          <button type="button" className="link-btn" onClick={() => void rename()}>
            {S.org.rename}
          </button>
        ) : null}
      </div>
      <ul className="admin-list">
        {workspace.members.map((id) => (
          <li key={id}>
            <span className="admin-meta">{fullName(users[id])}</span>
            {canManage ? (
              <Button size="sm" onClick={() => void remove(id)}>
                {S.org.remove}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {canManage ? (
        <div className="org-add">
          <select aria-label={S.org.addPerson} value={adding} onChange={(event) => setAdding(event.target.value)}>
            <option value="">{S.org.addPerson}</option>
            {candidates.map((user) => (
              <option key={user.id} value={user.id}>
                {fullName(user)}
              </option>
            ))}
          </select>
          <Button size="sm" disabled={!adding} onClick={() => void add()}>
            {S.org.add}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function RolesSection({ info, canManage, isAdmin, onChange }: { info: OrgInfo; canManage: boolean; isAdmin: boolean; onChange: () => void }) {
  const users = useStore((state) => state.users);
  const channels = useStore((state) => state.channels);
  const [role, setRole] = useState('');
  const [person, setPerson] = useState('');
  const [entity, setEntity] = useState(info.organisation.id);
  const org = info.organisation.id;
  const roleName = (id: string): string => info.roles.find((entry) => entry.id === id)?.name ?? id;
  const where = (id: string): string => {
    if (id === org) return S.org.wholeOrg;
    const workspace = info.workspaces.find((entry) => entry.id === id);
    if (workspace) return workspace.name;
    return channels[id]?.name ? `#${channels[id]!.name}` : id;
  };
  const chosen = info.roles.find((entry) => entry.id === role);
  // Role Admin is handed out by admins only.
  const offered = info.roles.filter((entry) => isAdmin || entry.id !== 'Rl02');
  const people = Object.values(users)
    .filter((user) => !user.deleted && !user.is_bot && !user.team_name)
    .sort((a, b) => fullName(a).localeCompare(fullName(b)));
  const places: { id: string; label: string }[] = [
    { id: org, label: S.org.wholeOrg },
    ...(chosen?.scope === 'team' ? info.workspaces.map((entry) => ({ id: entry.id, label: entry.name })) : []),
    ...(role === 'Rl0A' ? Object.values(channels).filter((conv) => conv.is_channel && !conv.is_archived).map((conv) => ({ id: conv.id, label: `#${conv.name}` })) : []),
  ];

  const assign = async (): Promise<void> => {
    if (await attempt(() => call('admin.roles.addAssignments', { role_id: role, entity_ids: entity, user_ids: person }))) {
      toast(S.org.assigned(roleName(role), fullName(users[person])));
      setPerson('');
      onChange();
    }
  };
  const unassign = async (entry: OrgInfo['assignments'][number]): Promise<void> => {
    if (await attempt(() => call('admin.roles.removeAssignments', { role_id: entry.role_id, entity_ids: entry.entity_id, user_ids: entry.user_id }))) onChange();
  };

  return (
    <section className="compliance-section">
      <h3 className="dialog-sub">{S.org.roles}</h3>
      <p className="field-hint">{S.org.rolesHint}</p>
      {info.assignments.length === 0 ? <p className="muted">{S.org.noRoles}</p> : null}
      <ul className="admin-list">
        {info.assignments.map((entry) => (
          <li key={`${entry.role_id}:${entry.entity_id}:${entry.user_id}`}>
            <span className="admin-meta">
              <strong>{fullName(users[entry.user_id])}</strong>
              <span className="muted">
                {roleName(entry.role_id)} · {where(entry.entity_id)}
              </span>
            </span>
            {canManage && (isAdmin || entry.role_id !== 'Rl02') ? (
              <Button size="sm" onClick={() => void unassign(entry)}>
                {S.org.remove}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {canManage ? (
        <div className="org-assign">
          <select
            aria-label={S.org.role}
            value={role}
            onChange={(event) => {
              setRole(event.target.value);
              setEntity(org);
            }}
          >
            <option value="">{S.org.role}</option>
            {offered.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
          <select aria-label={S.org.person} value={person} onChange={(event) => setPerson(event.target.value)}>
            <option value="">{S.org.person}</option>
            {people.map((user) => (
              <option key={user.id} value={user.id}>
                {fullName(user)}
              </option>
            ))}
          </select>
          <select aria-label={S.org.where} value={entity} onChange={(event) => setEntity(event.target.value)}>
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.label}
              </option>
            ))}
          </select>
          <Button size="sm" variant="primary" disabled={!role || !person} onClick={() => void assign()}>
            {S.org.assign}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
