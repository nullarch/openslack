/**
 * Schema migrations, applied in order. `PRAGMA user_version` records how many have run.
 * Never edit a released migration; append a new one.
 */
export const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE team (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT NOT NULL,
    icon_key TEXT,
    prefs TEXT NOT NULL DEFAULT '{}',
    created INTEGER NOT NULL
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    real_name TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    email TEXT UNIQUE,
    password_hash TEXT,
    title TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    tz TEXT NOT NULL DEFAULT 'UTC',
    avatar_key TEXT,
    color TEXT NOT NULL DEFAULT '',
    status_text TEXT NOT NULL DEFAULT '',
    status_emoji TEXT NOT NULL DEFAULT '',
    status_expiration INTEGER NOT NULL DEFAULT 0,
    manual_presence TEXT NOT NULL DEFAULT 'auto',
    is_bot INTEGER NOT NULL DEFAULT 0,
    bot_id TEXT,
    app_id TEXT,
    role TEXT NOT NULL DEFAULT 'member',
    deleted INTEGER NOT NULL DEFAULT 0,
    prefs TEXT NOT NULL DEFAULT '{}',
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );
  CREATE INDEX users_bot ON users(bot_id) WHERE bot_id IS NOT NULL;

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    user_agent TEXT NOT NULL DEFAULT '',
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );

  CREATE TABLE invites (
    code TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    email TEXT,
    max_uses INTEGER NOT NULL DEFAULT 0,
    uses INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );

  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('public', 'private', 'im', 'mpim')),
    name TEXT,
    topic TEXT NOT NULL DEFAULT '',
    topic_creator TEXT NOT NULL DEFAULT '',
    topic_set INTEGER NOT NULL DEFAULT 0,
    purpose TEXT NOT NULL DEFAULT '',
    purpose_creator TEXT NOT NULL DEFAULT '',
    purpose_set INTEGER NOT NULL DEFAULT 0,
    creator TEXT NOT NULL,
    is_archived INTEGER NOT NULL DEFAULT 0,
    is_general INTEGER NOT NULL DEFAULT 0,
    im_key TEXT UNIQUE,
    last_ts TEXT NOT NULL DEFAULT '0000000000.000000',
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX conversations_name ON conversations(name) WHERE kind IN ('public', 'private');

  CREATE TABLE members (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    joined INTEGER NOT NULL,
    last_read TEXT NOT NULL DEFAULT '0000000000.000000',
    is_open INTEGER NOT NULL DEFAULT 1,
    is_starred INTEGER NOT NULL DEFAULT 0,
    is_muted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX members_user ON members(user_id);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    user_id TEXT,
    bot_id TEXT,
    app_id TEXT,
    subtype TEXT,
    text TEXT NOT NULL DEFAULT '',
    plain TEXT NOT NULL DEFAULT '',
    blocks TEXT,
    attachments TEXT,
    files TEXT,
    metadata TEXT,
    username TEXT,
    icon_url TEXT,
    icon_emoji TEXT,
    thread_ts TEXT,
    reply_count INTEGER NOT NULL DEFAULT 0,
    reply_users TEXT,
    latest_reply TEXT,
    is_broadcast INTEGER NOT NULL DEFAULT 0,
    edited_ts TEXT,
    edited_user TEXT,
    client_msg_id TEXT,
    streaming INTEGER NOT NULL DEFAULT 0,
    UNIQUE (conversation_id, ts)
  );
  CREATE INDEX messages_thread ON messages(conversation_id, thread_ts, ts) WHERE thread_ts IS NOT NULL;
  CREATE INDEX messages_user ON messages(user_id, ts);

  -- Trigram tokenizer: substring search that works for Korean, Japanese and Chinese too.
  CREATE VIRTUAL TABLE messages_fts USING fts5(plain, tokenize = 'trigram', content = 'messages', content_rowid = 'id');
  CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, plain) VALUES (new.id, new.plain);
  END;
  CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, plain) VALUES ('delete', old.id, old.plain);
  END;
  CREATE TRIGGER messages_fts_update AFTER UPDATE OF plain ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, plain) VALUES ('delete', old.id, old.plain);
    INSERT INTO messages_fts(rowid, plain) VALUES (new.id, new.plain);
  END;

  -- user_id '*' marks a channel-wide mention (@channel, @here, @everyone).
  CREATE TABLE mentions (
    conversation_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    user_id TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (conversation_id, ts, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX mentions_user ON mentions(user_id, conversation_id, ts);

  CREATE TABLE reactions (
    conversation_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, ts, name, user_id)
  ) WITHOUT ROWID;

  CREATE TABLE pins (
    conversation_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, ts)
  ) WITHOUT ROWID;

  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    mimetype TEXT NOT NULL,
    filetype TEXT NOT NULL,
    size INTEGER NOT NULL,
    storage_key TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    width INTEGER,
    height INTEGER,
    alt_txt TEXT,
    upload_secret TEXT,
    created INTEGER NOT NULL
  );

  CREATE TABLE file_shares (
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    PRIMARY KEY (file_id, conversation_id, ts)
  ) WITHOUT ROWID;
  CREATE INDEX file_shares_conversation ON file_shares(conversation_id, ts);

  CREATE TABLE emoji (
    name TEXT PRIMARY KEY,
    storage_key TEXT,
    mimetype TEXT,
    alias_for TEXT,
    created_by TEXT NOT NULL,
    created INTEGER NOT NULL
  );

  -- Apps, tokens and delivery. Compatibility layer: names mirror the Slack platform.
  CREATE TABLE apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    bot_user_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    signing_secret TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_secret TEXT NOT NULL,
    verification_token TEXT NOT NULL,
    socket_mode INTEGER NOT NULL DEFAULT 0,
    events_url TEXT,
    interactivity_url TEXT,
    bot_events TEXT NOT NULL DEFAULT '[]',
    bot_scopes TEXT NOT NULL DEFAULT '[]',
    config TEXT NOT NULL DEFAULT '{}',
    created INTEGER NOT NULL
  );

  CREATE TABLE tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('bot', 'user', 'app')),
    app_id TEXT,
    user_id TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '',
    hint TEXT NOT NULL DEFAULT '',
    created INTEGER NOT NULL,
    last_used INTEGER
  );
  CREATE INDEX tokens_app ON tokens(app_id);

  CREATE TABLE commands (
    command TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    url TEXT,
    description TEXT NOT NULL DEFAULT '',
    usage_hint TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE webhooks (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL,
    secret TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created INTEGER NOT NULL
  );

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY,
    app_id TEXT NOT NULL,
    url TEXT NOT NULL,
    body TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL,
    last_error TEXT,
    created INTEGER NOT NULL
  );
  CREATE INDEX outbox_due ON outbox(next_at);
  `,

  /* 2: app platform — demand for methods that do not exist yet */ `
  CREATE TABLE unknown_methods (
    name TEXT PRIMARY KEY,
    calls INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  `,

  /* 3: app platform — modal and App Home views */ `
  CREATE TABLE app_views (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('modal', 'home')),
    root_view_id TEXT,
    previous_view_id TEXT,
    depth INTEGER NOT NULL DEFAULT 0,
    external_id TEXT,
    hash TEXT NOT NULL,
    body TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT '{}',
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX app_views_home ON app_views(app_id, user_id) WHERE type = 'home';
  CREATE UNIQUE INDEX app_views_external ON app_views(app_id, external_id) WHERE external_id IS NOT NULL;
  CREATE INDEX app_views_user ON app_views(user_id, type);
  `,
  /* 4: messaging and attention — activity, threads, notification levels, DND, scheduled messages,
        reminders, saved items, bookmarks, posting permissions, drafts, link previews, snippets */ `
  ALTER TABLE members ADD COLUMN notify_level TEXT NOT NULL DEFAULT 'default';

  ALTER TABLE conversations ADD COLUMN post_policy TEXT NOT NULL DEFAULT '';
  ALTER TABLE conversations ADD COLUMN thread_policy TEXT NOT NULL DEFAULT '';
  ALTER TABLE conversations ADD COLUMN mention_policy TEXT NOT NULL DEFAULT '';
  CREATE TABLE channel_managers (
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (conversation_id, user_id)
  ) WITHOUT ROWID;

  ALTER TABLE files ADD COLUMN mode TEXT NOT NULL DEFAULT 'hosted';

  -- Built-in users that are not apps (the reminder bot).
  CREATE TABLE system_users (
    role TEXT PRIMARY KEY,
    user_id TEXT NOT NULL
  );

  CREATE TABLE thread_subs (
    conversation_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    user_id TEXT NOT NULL,
    subscribed INTEGER NOT NULL DEFAULT 1,
    last_read TEXT NOT NULL DEFAULT '0000000000.000000',
    PRIMARY KEY (conversation_id, thread_ts, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX thread_subs_user ON thread_subs(user_id, subscribed);

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    thread_ts TEXT,
    actor TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    created INTEGER NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, kind, conversation_id, ts, actor, detail)
  );
  CREATE INDEX activity_user ON activity(user_id, id);
  CREATE INDEX activity_message ON activity(conversation_id, ts);

  CREATE TABLE dnd (
    user_id TEXT PRIMARY KEY,
    snooze_until INTEGER NOT NULL DEFAULT 0,
    snooze_started INTEGER NOT NULL DEFAULT 0,
    schedule_enabled INTEGER NOT NULL DEFAULT 0,
    start_minute INTEGER NOT NULL DEFAULT 1320,
    end_minute INTEGER NOT NULL DEFAULT 480,
    days TEXT NOT NULL DEFAULT '0123456',
    ended_until INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE scheduled_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    bot_id TEXT,
    app_id TEXT,
    post_at INTEGER NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    blocks TEXT,
    attachments TEXT,
    metadata TEXT,
    thread_ts TEXT,
    reply_broadcast INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending',
    posted_ts TEXT,
    error TEXT,
    created INTEGER NOT NULL
  );
  CREATE INDEX scheduled_due ON scheduled_messages(state, post_at);
  CREATE INDEX scheduled_user ON scheduled_messages(user_id, state);

  CREATE TABLE reminders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    creator TEXT NOT NULL,
    text TEXT NOT NULL,
    time INTEGER NOT NULL,
    recurrence TEXT,
    complete_ts INTEGER NOT NULL DEFAULT 0,
    fired INTEGER NOT NULL DEFAULT 0,
    channel TEXT,
    message_ts TEXT,
    created INTEGER NOT NULL
  );
  CREATE INDEX reminders_due ON reminders(fired, time);
  CREATE INDEX reminders_user ON reminders(user_id);

  CREATE TABLE saved (
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'in_progress',
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    PRIMARY KEY (user_id, conversation_id, ts)
  ) WITHOUT ROWID;

  CREATE TABLE bookmarks (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    title TEXT NOT NULL,
    link TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '',
    rank TEXT NOT NULL,
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );
  CREATE INDEX bookmarks_conversation ON bookmarks(conversation_id, rank);

  CREATE TABLE drafts (
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    updated INTEGER NOT NULL,
    PRIMARY KEY (user_id, conversation_id, thread_ts)
  ) WITHOUT ROWID;

  CREATE TABLE link_previews (
    url TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    data TEXT,
    fetched INTEGER NOT NULL
  );
  `,

  /* 5: huddles — calls inside a conversation; media through LiveKit */ `
  CREATE TABLE huddles (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    room TEXT NOT NULL,
    created_by TEXT NOT NULL,
    started INTEGER NOT NULL,
    ended INTEGER,
    participants TEXT NOT NULL DEFAULT '[]',
    joined_at TEXT NOT NULL DEFAULT '{}',
    history TEXT NOT NULL DEFAULT '[]'
  );
  CREATE UNIQUE INDEX huddles_active ON huddles(conversation_id) WHERE ended IS NULL;
  CREATE INDEX huddles_message ON huddles(conversation_id, ts);
  `,

  /* 6: AI features — model connection, daily recaps, agent activity */ `
  CREATE TABLE ai_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    base_url TEXT,
    api_key TEXT,
    features TEXT NOT NULL DEFAULT '{}',
    updated INTEGER NOT NULL,
    updated_by TEXT NOT NULL
  );

  CREATE TABLE ai_recaps (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    channels TEXT NOT NULL,
    local_time TEXT NOT NULL,
    tz TEXT NOT NULL,
    next_at INTEGER NOT NULL,
    last_sent INTEGER,
    -- The newest message a recap has covered; the next one starts after it.
    last_ts TEXT,
    created INTEGER NOT NULL
  );
  CREATE INDEX ai_recaps_due ON ai_recaps(next_at);

  CREATE TABLE agent_threads (
    app_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    streaming INTEGER NOT NULL DEFAULT 0,
    last_activity INTEGER NOT NULL,
    PRIMARY KEY (app_id, conversation_id, thread_ts)
  ) WITHOUT ROWID;
  CREATE INDEX agent_threads_recent ON agent_threads(app_id, last_activity);
  `,

  /* 7: image thumbnails made by the uploading client — { w, h } of the stored thumbnail */ `
  ALTER TABLE files ADD COLUMN thumb TEXT;
  `,

  /* 8: public file links — the secret in a file's public URL, while it is shared */ `
  ALTER TABLE files ADD COLUMN public_secret TEXT;
  CREATE UNIQUE INDEX files_public_secret ON files(public_secret) WHERE public_secret IS NOT NULL;
  `,

  /* 9: Discord import — which Discord ids were already brought in, so a second run adds only what is new */ `
  CREATE TABLE import_discord_users (discord_id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
  CREATE TABLE import_discord_channels (discord_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL);
  CREATE TABLE import_discord_messages (discord_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, ts TEXT NOT NULL);
  `,

  /* 10: automation — workflows, their runs, custom responses */ `
  CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL REFERENCES users(id),
    -- {type, ...}: shortcut, link, schedule, reaction, member_joined, webhook
    trigger TEXT NOT NULL,
    -- ordered steps; a branch step nests its own two lists
    steps TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'disabled')),
    link_token TEXT UNIQUE,
    webhook_secret TEXT,
    -- for schedule triggers: when it next fires (seconds)
    next_run INTEGER,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );
  CREATE INDEX workflows_due ON workflows(next_run) WHERE status = 'published' AND next_run IS NOT NULL;
  CREATE INDEX workflows_owner ON workflows(created_by);

  CREATE TABLE workflow_runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    -- the person who set it off; NULL for schedules and webhooks
    runner TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'cancelled')),
    -- the steps as they were when the run started, compiled
    program TEXT NOT NULL,
    pc INTEGER NOT NULL DEFAULT 0,
    vars TEXT NOT NULL DEFAULT '{}',
    log TEXT NOT NULL DEFAULT '[]',
    -- what a waiting run waits for: {kind: 'form', view_id} or {kind: 'function', execution_id, expires}
    waiting TEXT,
    error TEXT,
    started INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    finished INTEGER
  );
  CREATE INDEX workflow_runs_recent ON workflow_runs(workflow_id, started);
  CREATE INDEX workflow_runs_waiting ON workflow_runs(status) WHERE status = 'waiting';

  CREATE TABLE custom_responses (
    id TEXT PRIMARY KEY,
    match_type TEXT NOT NULL CHECK (match_type IN ('exact', 'contains', 'regex')),
    pattern TEXT NOT NULL,
    reply TEXT NOT NULL,
    -- conversation ids; empty means every public channel
    channels TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  `,

  /* 11: app manifests and token rotation — expiring tokens, their refresh tokens, app configuration tokens */ `
  ALTER TABLE tokens ADD COLUMN expires INTEGER;
  CREATE TABLE refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('bot', 'user', 'config')),
    app_id TEXT,
    user_id TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT '',
    created INTEGER NOT NULL
  );
  CREATE INDEX refresh_tokens_app ON refresh_tokens(app_id);
  CREATE TABLE config_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    hint TEXT NOT NULL DEFAULT '',
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );
  `,

  /* 12: workspace analytics — which people were active on which day (UTC) */ `
  CREATE TABLE activity_days (
    day TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (day, user_id)
  ) WITHOUT ROWID;
  `,

  /* 13: message reports — members flag a message, admins dismiss it or remove the message */ `
  CREATE TABLE message_reports (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    author TEXT,
    reporter TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    -- a copy of the text, so the report still says what was reported after the message changes or goes
    excerpt TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'removed')),
    resolved_by TEXT,
    resolved INTEGER,
    created INTEGER NOT NULL,
    UNIQUE (conversation_id, ts, reporter)
  );
  CREATE INDEX message_reports_open ON message_reports(status, created);
  `,

  /* 14: audit log — who did what to the workspace, and when */ `
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    created INTEGER NOT NULL,
    action TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor_id TEXT,
    entity_type TEXT,
    entity_id TEXT,
    details TEXT NOT NULL DEFAULT '{}',
    ip TEXT,
    ua TEXT
  );
  CREATE INDEX audit_log_created ON audit_log(created);
  CREATE INDEX audit_log_action ON audit_log(action, created);
  `,

  /* 15: text inside files, for search — one row per file looked at (empty when there was nothing to read) */ `
  CREATE VIRTUAL TABLE file_text USING fts5(file_id UNINDEXED, body, tokenize = 'trigram');
  CREATE TRIGGER files_text_delete AFTER DELETE ON files BEGIN
    DELETE FROM file_text WHERE file_id = old.id;
  END;
  `,

  /* 16: canvases and lists — collaborative documents and typed trackers with their own access lists, one search index */ `
  CREATE TABLE docs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('canvas', 'list')),
    title TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL,
    -- The channel or DM whose tab shows this document, if any.
    conversation_id TEXT,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    updated_by TEXT NOT NULL DEFAULT '',
    deleted INTEGER NOT NULL DEFAULT 0,
    -- Searchable text: a canvas's words, or a list's titles and cells.
    plain TEXT NOT NULL DEFAULT '',
    -- Lists: schema, views, description, todo mode.
    extra TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX docs_conversation ON docs(conversation_id) WHERE conversation_id IS NOT NULL;
  CREATE INDEX docs_owner ON docs(owner, updated);

  CREATE VIRTUAL TABLE docs_fts USING fts5(search, tokenize = 'trigram', content = '', contentless_delete = 1);

  -- Who may open a document besides its owner: a person, or the members of a conversation.
  CREATE TABLE doc_access (
    doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    principal TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('read', 'write')),
    PRIMARY KEY (doc_id, principal)
  ) WITHOUT ROWID;
  CREATE INDEX doc_access_principal ON doc_access(principal);

  -- A canvas is a Yjs document stored as its updates, compacted from time to time.
  CREATE TABLE canvas_updates (
    id INTEGER PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    data BLOB NOT NULL,
    user_id TEXT NOT NULL DEFAULT '',
    created INTEGER NOT NULL
  );
  CREATE INDEX canvas_updates_doc ON canvas_updates(doc_id, id);

  CREATE TABLE canvas_versions (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    state BLOB NOT NULL,
    created INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX canvas_versions_doc ON canvas_versions(doc_id, created);

  CREATE TABLE canvas_comments (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    -- Replies point at the comment that started the thread.
    root_id TEXT,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    quote TEXT NOT NULL DEFAULT '',
    -- Yjs relative positions of the commented range, as JSON.
    anchor TEXT,
    created INTEGER NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    resolved_by TEXT
  );
  CREATE INDEX canvas_comments_doc ON canvas_comments(doc_id, created);

  -- Uploaded images shown in a canvas: people who can open the canvas can load them.
  CREATE TABLE doc_files (
    doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL,
    PRIMARY KEY (doc_id, file_id)
  ) WITHOUT ROWID;
  CREATE INDEX doc_files_file ON doc_files(file_id);

  -- People already told they were mentioned in a canvas.
  CREATE TABLE canvas_mentions (
    doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    PRIMARY KEY (doc_id, user_id)
  ) WITHOUT ROWID;

  CREATE TABLE list_items (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    parent_id TEXT,
    position REAL NOT NULL,
    fields TEXT NOT NULL DEFAULT '{}',
    archived INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    updated INTEGER NOT NULL,
    updated_by TEXT NOT NULL
  );
  CREATE INDEX list_items_doc ON list_items(doc_id, archived, position);

  CREATE TABLE list_comments (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE INDEX list_comments_item ON list_comments(doc_id, item_id, created);

  -- Due-date reminders already sent, so each is sent once per item and date.
  CREATE TABLE list_due_sent (
    item_id TEXT NOT NULL,
    due TEXT NOT NULL,
    PRIMARY KEY (item_id, due)
  ) WITHOUT ROWID;

  CREATE TABLE doc_templates (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('canvas', 'list')),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  `,

  /* 17: accounts — mail codes, two-factor, external sign-in, guests, user groups, profile fields, push, public pages */ `
  -- '' for members; 'multi' or 'single' for guests.
  ALTER TABLE users ADD COLUMN guest TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN guest_expires INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN invited_by TEXT;
  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
  -- Custom profile field values: { "Xf…": { "value": "…", "alt": "" } }.
  ALTER TABLE users ADD COLUMN fields TEXT NOT NULL DEFAULT '{}';

  ALTER TABLE invites ADD COLUMN guest TEXT NOT NULL DEFAULT '';
  ALTER TABLE invites ADD COLUMN guest_channels TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE invites ADD COLUMN guest_expires INTEGER NOT NULL DEFAULT 0;

  -- Readable on the web without signing in; files only when web_files is set.
  ALTER TABLE conversations ADD COLUMN web_public INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE conversations ADD COLUMN web_files INTEGER NOT NULL DEFAULT 0;

  -- One-time codes sent by mail: sign-in codes and password-reset links.
  CREATE TABLE mail_codes (
    code_hash TEXT PRIMARY KEY,
    purpose TEXT NOT NULL CHECK (purpose IN ('signin', 'reset')),
    user_id TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );
  CREATE INDEX mail_codes_user ON mail_codes(user_id, purpose);

  -- A password or external sign-in that still needs the second factor.
  CREATE TABLE login_challenges (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL
  );

  CREATE TABLE backup_codes (
    user_id TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, code_hash)
  ) WITHOUT ROWID;

  -- Accounts at external identity providers linked to people here.
  CREATE TABLE identities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id),
    email TEXT,
    created INTEGER NOT NULL,
    PRIMARY KEY (provider, subject)
  ) WITHOUT ROWID;

  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    invite_code TEXT,
    created INTEGER NOT NULL
  );

  CREATE TABLE invite_requests (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    requested_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
    decided_by TEXT,
    decided INTEGER,
    created INTEGER NOT NULL
  );

  CREATE TABLE profile_fields (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    hint TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'text',
    possible_values TEXT,
    ordering INTEGER NOT NULL DEFAULT 0,
    is_hidden INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE usergroups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    handle TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    channels TEXT NOT NULL DEFAULT '[]',
    created_by TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    deleted_by TEXT,
    date_create INTEGER NOT NULL,
    date_update INTEGER NOT NULL,
    date_delete INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX usergroups_handle ON usergroups(handle);
  CREATE UNIQUE INDEX usergroups_name ON usergroups(name);

  CREATE TABLE usergroup_members (
    usergroup_id TEXT NOT NULL REFERENCES usergroups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    PRIMARY KEY (usergroup_id, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX usergroup_members_user ON usergroup_members(user_id);

  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created INTEGER NOT NULL
  );
  CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

  -- Small server-wide values: generated keys and similar.
  CREATE TABLE server_values (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  /* 18: email notifications — when each person was last mailed about unread mentions and direct messages */ `
  CREATE TABLE email_digests (
    user_id TEXT PRIMARY KEY,
    last_sent INTEGER NOT NULL DEFAULT 0,
    -- the newest message already mailed about, so nothing is mailed twice
    watermark TEXT NOT NULL DEFAULT '0000000000.000000'
  ) WITHOUT ROWID;
  `,

  /* 19: calls — external calls (Zoom, Meet, …) that apps register and show as call cards */ `
  CREATE TABLE calls (
    id TEXT PRIMARY KEY,
    app_id TEXT,
    created_by TEXT,
    external_unique_id TEXT NOT NULL,
    external_display_id TEXT NOT NULL DEFAULT '',
    join_url TEXT NOT NULL,
    desktop_app_join_url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    -- [{ slack_id } | { external_id, display_name, avatar_url }]
    users TEXT NOT NULL DEFAULT '[]',
    date_start INTEGER NOT NULL,
    date_end INTEGER,
    duration INTEGER,
    UNIQUE (app_id, external_unique_id)
  );
  -- Conversations where a call card was posted, so changes reach the people who can see it.
  CREATE TABLE call_shares (
    call_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    PRIMARY KEY (call_id, conversation_id)
  ) WITHOUT ROWID;
  `,

  /* 20: session management — where and when each signed-in browser was last seen */ `
  ALTER TABLE sessions ADD COLUMN last_seen INTEGER;
  ALTER TABLE sessions ADD COLUMN ip TEXT;
  CREATE INDEX sessions_user ON sessions(user_id);
  `,

  /* 21: email to a channel — each channel's secret address */ `
  CREATE TABLE channel_email (
    conversation_id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    created_by TEXT NOT NULL,
    created INTEGER NOT NULL
  ) WITHOUT ROWID;
  `,

  /* 22: legal hold — what is under hold, and the versions of messages and files kept because of it */ `
  CREATE TABLE legal_holds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created INTEGER NOT NULL,
    released INTEGER
  );
  CREATE TABLE legal_hold_targets (
    hold_id TEXT NOT NULL REFERENCES legal_holds(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('user', 'conversation')),
    target_id TEXT NOT NULL,
    PRIMARY KEY (hold_id, kind, target_id)
  ) WITHOUT ROWID;
  CREATE INDEX legal_hold_targets_target ON legal_hold_targets(kind, target_id);
  CREATE TABLE held_versions (
    id INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    user_id TEXT,
    text TEXT NOT NULL,
    blocks TEXT,
    files TEXT,
    thread_ts TEXT,
    change TEXT NOT NULL CHECK (change IN ('edited', 'deleted')),
    at INTEGER NOT NULL
  );
  CREATE INDEX held_versions_message ON held_versions(conversation_id, ts);
  CREATE TABLE held_files (
    file_id TEXT PRIMARY KEY,
    row TEXT NOT NULL,
    deleted INTEGER NOT NULL
  ) WITHOUT ROWID;
  `,

  /* 23: information barriers — user groups that may not message or call each other directly */ `
  CREATE TABLE barriers (
    id TEXT PRIMARY KEY,
    primary_usergroup_id TEXT NOT NULL,
    barriered_from TEXT NOT NULL,
    restricted_subjects TEXT NOT NULL,
    created_by TEXT NOT NULL,
    date_update INTEGER NOT NULL
  );
  `,

  /* 24: the built-in assistant's memory — facts each person chose to keep, and proposals awaiting their answer */ `
  CREATE TABLE assistant_memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    text TEXT NOT NULL,
    state TEXT NOT NULL,
    source_channel TEXT,
    source_ts TEXT,
    created INTEGER NOT NULL
  );
  CREATE INDEX assistant_memories_user ON assistant_memories (user_id, state, created);
  `,

  /* 25: huddle captions — final lines kept while a huddle runs, turned into a transcript when it ends */ `
  CREATE TABLE huddle_captions (
    huddle_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    text TEXT NOT NULL
  );
  CREATE INDEX huddle_captions_huddle ON huddle_captions (huddle_id, at);
  `,

  /* 26: clips — WebVTT captions a recording browser attaches to an audio or video file */ `
  ALTER TABLE files ADD COLUMN transcript TEXT;
  ALTER TABLE files ADD COLUMN transcript_locale TEXT;
  `,

  /* 27: remote files — documents an app registers with files.remote.add; the bytes stay at external_url */ `
  ALTER TABLE files ADD COLUMN external_id TEXT;
  ALTER TABLE files ADD COLUMN external_url TEXT;
  ALTER TABLE files ADD COLUMN app_id TEXT;
  ALTER TABLE files ADD COLUMN remote_type TEXT;
  CREATE UNIQUE INDEX files_external ON files (app_id, external_id) WHERE external_id IS NOT NULL;
  `,

  /* 28: external search — messages waiting to be sent to Meilisearch (filled by triggers only while it is connected), and server settings */ `
  CREATE TABLE search_outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    op TEXT NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  /* 29: agent sessions — the state an agent reports for its work in a thread (agents.sessions.*) */ `
  ALTER TABLE agent_threads ADD COLUMN session_status TEXT NOT NULL DEFAULT '';
  ALTER TABLE agent_threads ADD COLUMN status_set INTEGER;
  ALTER TABLE agent_threads ADD COLUMN initiator TEXT;
  CREATE INDEX agent_threads_thread ON agent_threads (conversation_id, thread_ts);
  `,
];
