#!/usr/bin/env node

const fs = require("fs");

const GhostAdminAPI = require("./api");

const logger = console;

// Ghost rejects a per-request page size larger than this.
const MAX_PAGE_SIZE = 100;

// Content sections, separated on the Ghost site by these (internal) tags.
// `tag` is referenced by display name (Ghost links posts to tags by name);
// `filter` is referenced by slug (NQL `tag:` matches the slug).
const SECTIONS = {
  blog: { tag: { name: "#blog" }, filter: "tag:hash-blog", label: "blog" },
  docs: { tag: { name: "#docs" }, filter: "tag:hash-docs", label: "docs" },
  changelog: { tag: { name: "Changelog" }, filter: "tag:changelog", label: "changelog" }
};

const USAGE = `ghost-cli — manage Ghost members and posts from the command line

Usage:
  ghost-cli <group> <command> [arguments] [options]

Member commands:
  members list                     List members (auto-paginates over 100 / "all")
  members add <email>              Create a new member
  members remove <email>           Delete a member permanently
  members subscribe <email>        Subscribe a member to all active newsletters
  members unsubscribe <email>      Unsubscribe a member from all newsletters

Post commands:
  post list                        List posts (use --blog/--docs/--changelog to scope)
  post add --title "..."           Create a post
  post edit <id|slug>              Update an existing post

Section flags (post commands):
  --blog                           Target the blog (#blog tag)
  --docs                           Target the docs (#docs tag)
  --changelog                      Target release notes (changelog tag)

Connection options:
  --url <url>                      Site URL (default: GHOST_API_URL)
  --key <id:secret>                Admin API key (default: GHOST_ADMIN_API_KEY)
  --version <vX.Y>                 Accept-Version (default: GHOST_API_VERSION or v5.0)

Member options:
  --name <name>                    [members add] Member name
  --note <note>                    [members add] Internal note
  --labels <a,b,c>                 [members add] Comma separated labels
  --no-subscribe                   [members add] Do not subscribe on creation
  --limit <n|all>                  [members/post list] Page size, default 50/15
  --page <n>                       [members/post list] Starting page (default 1)
  --filter <nql>                   [members/post list] Extra Ghost NQL filter

Post options:
  --title <title>                  Post title
  --markdown <file|text>           Body from a Markdown file path or inline text
  --html <file|text>               Body from an HTML file path or inline text
  --content <text>                 Inline Markdown body (alias of --markdown text)
  --meta-description <text>        SEO meta description
  --cover <url>                    Cover image (feature_image) URL
  --excerpt <text>                 Custom excerpt
  --tags <a,b,c>                   Extra comma separated tags (added to the section tag)
  --status <draft|published>       Post status (default: draft)

General:
  --json                           Print raw JSON instead of a table
  -h, --help                       Show this help

Environment:
  GHOST_API_URL, GHOST_ADMIN_API_KEY, GHOST_API_VERSION

Examples:
  ghost-cli members list --limit all
  ghost-cli members add jane@example.com --name "Jane" --labels vip
  ghost-cli post list --docs --limit 20
  ghost-cli post add --docs --title "Install guide" --markdown ./install.md --status published
  ghost-cli post add --blog --title "Launch" --content "We **shipped**!" --cover https://img/x.png
  ghost-cli post edit my-post-slug --title "New title" --meta-description "Updated summary"`;

function parseArgs(argv) {
  const positionals = [];
  const options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--no-subscribe") {
      options.subscribe = false;
      continue;
    }

    if (arg === "--blog" || arg === "--docs" || arg === "--changelog") {
      options[arg.slice(2)] = true;
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        options[key] = true;
      } else {
        options[key] = next;
        i += 1;
      }
      continue;
    }

    positionals.push(arg);
  }

  return {
    group: positionals[0],
    command: positionals[1],
    args: positionals.slice(2),
    options
  };
}

function deriveSiteUrl(rawUrl) {
  // Accepts either a site root or a full Admin API URL and returns the origin.
  const parsed = new URL(rawUrl);
  return parsed.origin;
}

function createClient(options) {
  const rawUrl = options.url || process.env.GHOST_API_URL;
  const key = options.key || process.env.GHOST_ADMIN_API_KEY;
  const version = options.version || process.env.GHOST_API_VERSION || "v5.0";

  if (!rawUrl) {
    throw new Error("Missing site URL. Pass --url or set GHOST_API_URL.");
  }
  if (!key) {
    throw new Error("Missing Admin API key. Pass --key or set GHOST_ADMIN_API_KEY.");
  }

  return GhostAdminAPI({ url: deriveSiteUrl(rawUrl), key, version });
}

function resolveSection(options) {
  if (options.blog) {
    return SECTIONS.blog;
  }
  if (options.docs) {
    return SECTIONS.docs;
  }
  if (options.changelog) {
    return SECTIONS.changelog;
  }
  return null;
}

// Fetch a resource across multiple pages (Ghost caps each request at 100). Uses
// a constant page size so page offsets stay consistent, then trims to `limit`.
async function browseAll(browseFn, baseOptions, limit) {
  const fetchAll = limit === "all";
  const target = fetchAll ? Infinity : Number(limit);

  const collected = [];
  let page = baseOptions.page || 1;
  let totalPages = Infinity;
  let total = 0;

  while (collected.length < target && page <= totalPages) {
    const result = await browseFn({ ...baseOptions, page, limit: MAX_PAGE_SIZE });
    const batch = Array.isArray(result) ? result : [result].filter(Boolean);

    if (result && result.meta && result.meta.pagination) {
      totalPages = result.meta.pagination.pages;
      total = result.meta.pagination.total;
    }

    collected.push(...batch);
    if (!batch.length) {
      break;
    }
    page += 1;
  }

  const items = fetchAll ? collected : collected.slice(0, target);
  items.meta = { pagination: { total, fetched: items.length, pages: totalPages } };
  return items;
}

function shouldAutoPaginate(limit) {
  if (limit === "all") {
    return true;
  }
  const numeric = Number(limit);
  return Number.isFinite(numeric) && numeric > MAX_PAGE_SIZE;
}

function printTable(columns, items) {
  if (!items.length) {
    logger.info("No results.");
    return;
  }

  const rows = items.map(item =>
    columns.reduce(
      (row, column) => Object.assign(row, { [column.key]: String(column.value(item)) }),
      {}
    )
  );

  const widths = columns.reduce((acc, column) => {
    const valueWidth = rows.reduce((max, row) => Math.max(max, row[column.key].length), 0);
    acc[column.key] = Math.max(column.header.length, valueWidth);
    return acc;
  }, {});

  const formatRow = getValue =>
    columns.map(column => getValue(column).padEnd(widths[column.key])).join("  ");

  logger.info(formatRow(column => column.header.toUpperCase()));
  logger.info(columns.map(column => "-".repeat(widths[column.key])).join("  "));
  rows.forEach(row => logger.info(formatRow(column => row[column.key])));
}

function printPaginationFooter(meta, noun) {
  if (!meta || !meta.pagination) {
    return;
  }
  const { page, pages, total, fetched } = meta.pagination;
  if (fetched !== undefined) {
    logger.info(`\nShowing ${fetched} of ${total} ${noun}.`);
  } else {
    logger.info(`\nPage ${page} of ${pages} — ${total} ${noun} total.`);
  }
}

async function browseWithPaging(browseFn, baseOptions, options, defaultLimit) {
  const limit = options.limit || defaultLimit;
  if (shouldAutoPaginate(limit)) {
    return browseAll(
      browseFn,
      { ...baseOptions, page: options.page ? Number(options.page) : 1 },
      limit
    );
  }
  return browseFn({
    ...baseOptions,
    page: options.page ? Number(options.page) : 1,
    limit
  });
}

// ---- Members ---------------------------------------------------------------

async function findMemberByEmail(api, email) {
  const members = await api.members.browse({ filter: `email:'${email}'`, limit: 1 });
  const list = Array.isArray(members) ? members : [members].filter(Boolean);
  if (!list.length) {
    throw new Error(`No member found with email ${email}`);
  }
  return list[0];
}

async function getActiveNewsletters(api) {
  const newsletters = await api.newsletters.browse({ filter: "status:active", limit: "all" });
  const list = Array.isArray(newsletters) ? newsletters : [newsletters].filter(Boolean);
  return list.map(newsletter => ({ id: newsletter.id }));
}

async function membersList(api, options) {
  const baseOptions = { order: "created_at DESC" };
  if (options.filter) {
    baseOptions.filter = options.filter;
  }

  const members = await browseWithPaging(api.members.browse, baseOptions, options, 50);
  const list = Array.isArray(members) ? members : [members].filter(Boolean);

  if (options.json) {
    logger.info(JSON.stringify(list, null, 2));
    return;
  }

  printTable(
    [
      { key: "email", header: "email", value: m => m.email || "" },
      { key: "name", header: "name", value: m => m.name || "" },
      { key: "status", header: "status", value: m => m.status || "" },
      {
        key: "newsletters",
        header: "newsletters",
        value: m => (m.newsletters ? m.newsletters.length : 0)
      },
      { key: "created", header: "created", value: m => (m.created_at || "").slice(0, 10) }
    ],
    list
  );
  printPaginationFooter(members.meta, "members");
}

async function membersAdd(api, email, options) {
  const data = { email };
  if (options.name) {
    data.name = options.name;
  }
  if (options.note) {
    data.note = options.note;
  }
  if (options.labels) {
    data.labels = String(options.labels)
      .split(",")
      .map(label => label.trim())
      .filter(Boolean)
      .map(name => ({ name }));
  }

  if (options.subscribe !== false) {
    data.newsletters = await getActiveNewsletters(api);
  }

  const member = await api.members.add(data);
  if (options.json) {
    logger.info(JSON.stringify(member, null, 2));
    return;
  }
  logger.info(`Added member ${member.email} (id: ${member.id}).`);
}

async function membersRemove(api, email, options) {
  const member = await findMemberByEmail(api, email);
  await api.members.delete({ id: member.id });
  if (options.json) {
    logger.info(JSON.stringify({ deleted: member.id, email: member.email }, null, 2));
    return;
  }
  logger.info(`Removed member ${member.email} (id: ${member.id}).`);
}

async function membersSubscribe(api, email, options) {
  const member = await findMemberByEmail(api, email);
  const newsletters = await getActiveNewsletters(api);
  const updated = await api.members.edit({ id: member.id, newsletters });
  if (options.json) {
    logger.info(JSON.stringify(updated, null, 2));
    return;
  }
  logger.info(`Subscribed ${updated.email} to ${newsletters.length} newsletter(s).`);
}

async function membersUnsubscribe(api, email, options) {
  const member = await findMemberByEmail(api, email);
  const updated = await api.members.edit({ id: member.id, newsletters: [] });
  if (options.json) {
    logger.info(JSON.stringify(updated, null, 2));
    return;
  }
  logger.info(`Unsubscribed ${updated.email} from all newsletters.`);
}

// ---- Posts -----------------------------------------------------------------

function buildMarkdownMobiledoc(markdown) {
  return JSON.stringify({
    version: "0.3.1",
    atoms: [],
    cards: [["markdown", { cardName: "markdown", markdown }]],
    markups: [],
    sections: [[10, 0]]
  });
}

function readInput(value) {
  // A value may be a path to a file or the literal content itself.
  if (value && fs.existsSync(value) && fs.statSync(value).isFile()) {
    return fs.readFileSync(value, "utf8");
  }
  return String(value);
}

// Returns the content-related fields and query params for a post add/edit.
function resolveContent(options) {
  if (options.html) {
    return { fields: { html: readInput(options.html) }, queryParams: { source: "html" } };
  }
  if (options.markdown) {
    return {
      fields: { mobiledoc: buildMarkdownMobiledoc(readInput(options.markdown)) },
      queryParams: {}
    };
  }
  if (options.content) {
    return {
      fields: { mobiledoc: buildMarkdownMobiledoc(String(options.content)) },
      queryParams: {}
    };
  }
  return { fields: {}, queryParams: {} };
}

function applyPostFields(data, options) {
  if (options.title) {
    data.title = options.title;
  }
  const metaDescription = options["meta-description"] || options.meta;
  if (metaDescription) {
    data.meta_description = metaDescription;
  }
  if (options.cover) {
    data.feature_image = options.cover;
  }
  if (options.excerpt) {
    data.custom_excerpt = options.excerpt;
  }
  if (options.status) {
    data.status = options.status;
  }
}

function parseTagList(value) {
  return String(value)
    .split(",")
    .map(tag => tag.trim())
    .filter(Boolean)
    .map(name => ({ name }));
}

async function findPost(api, idOrSlug) {
  const isId = /^[0-9a-f]{24}$/.test(idOrSlug);
  const selector = isId ? { id: idOrSlug } : { slug: idOrSlug };
  try {
    return await api.posts.read(selector, { include: "tags" });
  } catch (e) {
    throw new Error(`No post found for "${idOrSlug}"`);
  }
}

async function postList(api, options) {
  const filters = [];
  const section = resolveSection(options);
  if (section) {
    filters.push(section.filter);
  }
  if (options.status) {
    filters.push(`status:${options.status}`);
  }
  if (options.filter) {
    filters.push(`(${options.filter})`);
  }

  const baseOptions = {
    order: "updated_at DESC",
    fields: "id,title,slug,status,updated_at,url"
  };
  if (filters.length) {
    baseOptions.filter = filters.join("+");
  }

  const posts = await browseWithPaging(api.posts.browse, baseOptions, options, 15);
  const list = Array.isArray(posts) ? posts : [posts].filter(Boolean);

  if (options.json) {
    logger.info(JSON.stringify(list, null, 2));
    return;
  }

  printTable(
    [
      { key: "status", header: "status", value: p => p.status || "" },
      { key: "title", header: "title", value: p => p.title || "" },
      { key: "slug", header: "slug", value: p => p.slug || "" },
      { key: "updated", header: "updated", value: p => (p.updated_at || "").slice(0, 10) }
    ],
    list
  );
  printPaginationFooter(posts.meta, "posts");
}

async function postAdd(api, options) {
  if (!options.title) {
    throw new Error("post add requires --title");
  }

  const { fields, queryParams } = resolveContent(options);
  const data = { title: options.title, status: options.status || "draft", ...fields };
  applyPostFields(data, options);

  const tags = [];
  const section = resolveSection(options);
  if (section) {
    tags.push(section.tag);
  }
  if (options.tags) {
    tags.push(...parseTagList(options.tags));
  }
  if (tags.length) {
    data.tags = tags;
  }

  const post = await api.posts.add(data, queryParams);
  if (options.json) {
    logger.info(JSON.stringify(post, null, 2));
    return;
  }
  logger.info(`Created post "${post.title}" (${post.status}) — ${post.url || post.slug}`);
}

async function postEdit(api, idOrSlug, options) {
  const existing = await findPost(api, idOrSlug);

  const { fields, queryParams } = resolveContent(options);
  // updated_at is required by Ghost for optimistic concurrency on edits.
  const data = { id: existing.id, updated_at: existing.updated_at, ...fields };
  applyPostFields(data, options);

  const section = resolveSection(options);
  if (section || options.tags) {
    const merged = (existing.tags || []).map(tag =>
      tag.slug ? { slug: tag.slug } : { name: tag.name }
    );
    const hasTag = candidate =>
      merged.some(
        tag =>
          (tag.name &&
            candidate.name &&
            tag.name.toLowerCase() === candidate.name.toLowerCase()) ||
          (tag.slug && candidate.slug && tag.slug === candidate.slug)
      );

    if (section && !hasTag(section.tag)) {
      merged.push(section.tag);
    }
    if (options.tags) {
      parseTagList(options.tags).forEach(tag => {
        if (!hasTag(tag)) {
          merged.push(tag);
        }
      });
    }
    data.tags = merged;
  }

  const post = await api.posts.edit(data, queryParams);
  if (options.json) {
    logger.info(JSON.stringify(post, null, 2));
    return;
  }
  logger.info(`Updated post "${post.title}" (${post.status}) — ${post.url || post.slug}`);
}

// ---- Dispatch --------------------------------------------------------------

const COMMANDS = {
  members: {
    list: { run: (api, args, options) => membersList(api, options) },
    add: { needsArg: "email", run: (api, args, options) => membersAdd(api, args[0], options) },
    remove: {
      needsArg: "email",
      run: (api, args, options) => membersRemove(api, args[0], options)
    },
    subscribe: {
      needsArg: "email",
      run: (api, args, options) => membersSubscribe(api, args[0], options)
    },
    unsubscribe: {
      needsArg: "email",
      run: (api, args, options) => membersUnsubscribe(api, args[0], options)
    }
  },
  post: {
    list: { run: (api, args, options) => postList(api, options) },
    add: { run: (api, args, options) => postAdd(api, options) },
    edit: { needsArg: "id|slug", run: (api, args, options) => postEdit(api, args[0], options) }
  }
};

async function main() {
  const { group, command, args, options } = parseArgs(process.argv.slice(2));

  if (!group || options.help) {
    logger.info(USAGE);
    return;
  }

  const groupCommands = COMMANDS[group];
  if (!groupCommands) {
    throw new Error(
      `Unknown group "${group}". Expected "members" or "post". See "ghost-cli --help".`
    );
  }

  const handler = groupCommands[command];
  if (!handler) {
    const available = Object.keys(groupCommands).join(", ");
    throw new Error(`Unknown command "${group} ${command || ""}". Available: ${available}.`);
  }

  if (handler.needsArg && !args[0]) {
    throw new Error(`"${group} ${command}" requires a <${handler.needsArg}> argument.`);
  }

  const api = createClient(options);
  await handler.run(api, args, options);
}

main().catch(err => {
  logger.error(`Error: ${err.message}`);
  process.exit(1);
});
