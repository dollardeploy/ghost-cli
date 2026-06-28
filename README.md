# @dollardeploy/ghost-cli

> A zero-dependency Ghost Admin API client and a `ghost-cli` for managing members and posts.

This package contains two things:

1. **`api.js`** — a small [Ghost Admin API](https://ghost.org/docs/admin-api/) client built on the native Node.js `fetch` and `crypto` modules. No `axios`, no `form-data`, no `jsonwebtoken` — nothing to install.
2. **`cli.js`** (`ghost-cli`) — a command line tool for managing Ghost **members** (list, add, remove, subscribe, unsubscribe) and **posts** (list, add, edit).

## Requirements

- Node.js >= 22 (for the global `fetch` API).

## Configuration

The CLI reads connection details from flags or environment variables:

| Setting       | Flag        | Environment variable  | Default      |
| ------------- | ----------- | --------------------- | ------------ |
| Site URL      | `--url`     | `GHOST_API_URL`       | — (required) |
| Admin API key | `--key`     | `GHOST_ADMIN_API_KEY` | — (required) |
| API version   | `--version` | `GHOST_API_VERSION`   | `v5.0`       |

The site URL may be either the site root (`https://example.com`) or a full Admin
API URL (`https://example.com/ghost/api/admin/`) — only the origin is used.

The **Admin API key** has the form `id:secret` and is created in Ghost under
**Settings → Advanced → Integrations → Add custom integration**.

```bash
export GHOST_API_URL="https://example.com/ghost/api/admin/"
export GHOST_ADMIN_API_KEY="0123...abcd:0123...def0"
```

## CLI Usage

```bash
ghost-cli <group> <command> [arguments] [options]
```

### Members

| Command                       | Description                                            |
| ----------------------------- | ------------------------------------------------------ |
| `members list`                | List members, newest first (auto-paginates, see below) |
| `members add <email>`         | Create a new member                                    |
| `members remove <email>`      | Delete a member permanently                            |
| `members subscribe <email>`   | Subscribe a member to all active newsletters           |
| `members unsubscribe <email>` | Unsubscribe a member from all newsletters              |

Member options: `--name`, `--note`, `--labels a,b,c`, `--no-subscribe` (for `add`);
`--limit`, `--page`, `--filter` (for `list`).

```bash
ghost-cli members list --limit all
ghost-cli members add jane@example.com --name "Jane Doe" --labels vip,beta
ghost-cli members unsubscribe jane@example.com
ghost-cli members remove jane@example.com
```

### Posts

| Command                  | Description                            |
| ------------------------ | -------------------------------------- |
| `post list`              | List posts (scope with a section flag) |
| `post add --title "..."` | Create a post                          |
| `post edit <id\|slug>`   | Update an existing post                |

**Section flags** map to the internal tags that separate content on the site:

| Flag          | Tag         | Use           |
| ------------- | ----------- | ------------- |
| `--blog`      | `#blog`     | Blog posts    |
| `--docs`      | `#docs`     | Documentation |
| `--changelog` | `changelog` | Release notes |

On `list` a section flag filters by that tag; on `add`/`edit` it attaches the
tag (existing tags are preserved on edit).

**Post options:**

| Option                        | Description                                                           |
| ----------------------------- | --------------------------------------------------------------------- |
| `--title <title>`             | Post title (required for `add`)                                       |
| `--markdown <file\|text>`     | Body from a Markdown **file path** or inline Markdown text            |
| `--html <file\|text>`         | Body from an HTML file path or inline HTML (sent with `?source=html`) |
| `--content <text>`            | Inline Markdown body (alias of `--markdown text`)                     |
| `--meta-description <text>`   | SEO meta description                                                  |
| `--cover <url>`               | Cover image (`feature_image`) — **URL only** (see note)               |
| `--excerpt <text>`            | Custom excerpt                                                        |
| `--tags <a,b,c>`              | Extra tags, added alongside the section tag                           |
| `--status <draft\|published>` | Status (default: `draft`)                                             |

```bash
# Import a Markdown doc as a published docs page
ghost-cli post add --docs --title "Install guide" --markdown ./install.md --status published

# New blog post from inline Markdown with a cover and meta description
ghost-cli post add --blog --title "We launched" \
  --content "Today we **shipped** it." \
  --cover "https://cdn.example.com/launch.png" \
  --meta-description "Our launch announcement"

# List and edit
ghost-cli post list --docs --limit 20
ghost-cli post edit install-guide --title "Installation guide" --meta-description "How to install"
```

> **Cover images are set by URL only.** This client intentionally does not use
> `FormData`/multipart, so it cannot upload a local image file. Pass `--cover`
> a URL that is already hosted (e.g. an existing Ghost/CDN image).

### Auto-pagination (`list`)

`members list` and `post list` accept `--limit <n|all>`. Ghost caps each request
at 100 items; when `--limit` is greater than 100 (or `all`), the CLI transparently
fetches successive pages and trims to the requested count. `--page` sets the
starting page.

### Output

Every command accepts `--json` to print the raw API response instead of a table —
handy for piping into `jq` or feeding other tools.

## Programmatic Usage

```js
const GhostAdminAPI = require("./api");

const api = GhostAdminAPI({
  url: "https://example.com",
  key: process.env.GHOST_ADMIN_API_KEY,
  version: "v5.0"
});

const posts = await api.posts.browse({ limit: 5, filter: "tag:hash-docs" });
console.log(posts);
```

The client exposes the standard Ghost Admin resources (`posts`, `pages`, `tags`,
`webhooks`, `members`, `users`, `newsletters`) with `browse`, `read`, `add`,
`edit`, and `delete` methods, plus `site.read()`, `config.read()`, and
`themes.activate(name)`.

> **Note:** file/image/theme **upload** endpoints are intentionally omitted —
> this client does not use `FormData`/multipart requests.

## How it works

- **Auth** — HS256 JWTs are signed on the fly with Node's `crypto.createHmac`,
  scoped to a 5-minute expiry and the `/admin/` audience, exactly as the Ghost
  Admin API expects.
- **Transport** — every request goes through the native `fetch`. Query
  parameters are comma-joined and URI encoded the way Ghost's NQL filters need.
- **Markdown import** — Markdown is wrapped in a Mobiledoc _markdown card_, which
  Ghost renders to its native format on save (no external Markdown parser needed).
- **Edits** — `post edit` first reads the post to obtain its `updated_at`, which
  Ghost requires for optimistic-concurrency collision detection.
- **Errors** — non-2xx responses are unwrapped into a normal `Error` whose
  `message` and `name` come from Ghost's `errors[]` payload.
