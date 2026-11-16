# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on this repository ("Security" tab → "Report a vulnerability"). You will get an acknowledgement within a few days.

Include what you found, how to reproduce it, and which version or commit you tested.

## What is in scope

- Reading or changing data without the right to: messages or files in conversations the caller does not belong to, other people's sessions or tokens.
- Running script in another person's browser through message content, file uploads or profile fields.
- Making the server call internal network addresses.
- Bypassing sign-in, invitations or roles.

## What operators should know

- All state is in `DATA_DIR`: one SQLite database and the uploaded files. Protect and back up that directory.
- Put the server behind HTTPS and set `PUBLIC_URL` to the public address; the session cookie is marked `Secure` only when that address is `https://`.
- API tokens are stored hashed and shown once when created.
