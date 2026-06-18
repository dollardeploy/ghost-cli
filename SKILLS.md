---
name: ghost-cli
description: Use when managing a Ghost site from the terminal — listing/adding/removing members, subscribing or unsubscribing newsletters, or listing/adding/editing blog, docs, and release-note (changelog) posts. Triggers on "ghost-cli members", "ghost-cli post", "newsletter subscriber", "add blog post", "edit docs post", "publish changelog", "markdown import to ghost".
---

# Ghost CLI (ghost-cli)

Manage [Ghost](https://ghost.org) members and posts from the command line. Zero
dependencies — uses native Node `fetch` and `crypto` against the Ghost Admin API.

## Setup

Set credentials once (or pass `--url` / `--key` per command):

```bash
export GHOST_API_URL="https://example.com/ghost/api/admin/"
export GHOST_ADMIN_API_KEY="<id>:<secret>"   # Settings → Advanced → Integrations → custom integration
```

Run from `tools/ghost-cli/`:

```bash
node cli.js <group> <command> [options]
# or, if installed globally / linked:
ghost-cli <group> <command> [options]
```

## Members

| Task                        | Command                                                                  |
| --------------------------- | ------------------------------------------------------------------------ |
| List members                | `ghost-cli members list [--limit 10] [--page 2] [--json]`                |
| List everyone               | `ghost-cli members list --limit all` (auto-paginates)                    |
| Filter members              | `ghost-cli members list --filter "status:paid"`                          |
| Add member                  | `ghost-cli members add jane@example.com --name "Jane" --labels vip,beta` |
| Add, no newsletter          | `ghost-cli members add bob@example.com --no-subscribe`                   |
| Remove member               | `ghost-cli members remove jane@example.com`                              |
| Subscribe (all newsletters) | `ghost-cli members subscribe jane@example.com`                           |
| Unsubscribe (all)           | `ghost-cli members unsubscribe jane@example.com`                         |

Member lookup for `remove`/`subscribe`/`unsubscribe` is by **email**; the id is
resolved internally. `subscribe` sets all `status:active` newsletters;
`unsubscribe` clears them.

## Posts

Content sections are separated by internal tags — pick one with a **section flag**:

| Flag          | Tag (slug)  | Content       |
| ------------- | ----------- | ------------- |
| `--blog`      | `hash-blog` | Blog          |
| `--docs`      | `hash-docs` | Docs          |
| `--changelog` | `changelog` | Release notes |

| Task                            | Command                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| List a section                  | `ghost-cli post list --docs --limit 20`                                                                      |
| List release notes              | `ghost-cli post list --changelog`                                                                            |
| Add docs page (Markdown file)   | `ghost-cli post add --docs --title "Install" --markdown ./install.md --status published`                     |
| Add blog post (inline Markdown) | `ghost-cli post add --blog --title "Launch" --content "We **shipped**!"`                                     |
| Add with cover + meta           | `ghost-cli post add --blog --title "X" --markdown ./x.md --cover https://cdn/x.png --meta-description "..."` |
| Edit by id or slug              | `ghost-cli post edit install --title "Installation" --meta-description "How to install"`                     |
| Move/append a section on edit   | `ghost-cli post edit my-slug --blog` (keeps existing tags)                                                   |

Post fields: `--title`, `--markdown`/`--html`/`--content`, `--meta-description`,
`--cover` (feature image), `--excerpt`, `--tags a,b`, `--status draft|published`.

## Key Behaviors

- **Markdown import** works via a Mobiledoc markdown card — no Markdown parser
  needed; Ghost renders it. `--markdown`/`--html` accept a **file path or inline
  text**.
- **`--cover` is a URL only.** This client has no multipart/`FormData` upload, so
  it cannot upload a local image — pass an already-hosted URL.
- **`post edit`** reads the post first (needed for Ghost's `updated_at` collision
  check) and **preserves existing tags**, appending any section/`--tags` you add.
- **`post add` defaults to `--status draft`.** Pass `--status published` to publish.
- **Auto-pagination:** `--limit` over 100 (or `all`) transparently pages the API
  (Ghost caps each request at 100).
- **`--json`** on any command prints the raw API response (good for `jq`/agents).
- Credential resolution: `--url`/`--key` flag > `GHOST_API_URL`/`GHOST_ADMIN_API_KEY` env.

## Safety Notes

- `members remove` and `post` publishing/editing mutate live data — confirm the
  email/slug and target site before running against production.
- Adding subscribed members may trigger a welcome email; use `--no-subscribe` for
  test members. New posts default to draft.

## Library Use

`api.js` can be required directly for scripting beyond these commands
(`posts`, `pages`, `tags`, `newsletters`, `users`, `site`, `config`,
`themes.activate`). See `README.md` for the full API surface. Upload/multipart
endpoints are not included.
