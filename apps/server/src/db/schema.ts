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

  /* 10: canvases and lists — collaborative documents and typed trackers with their own access lists, one search index */ `
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
];
