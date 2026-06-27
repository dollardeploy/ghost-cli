const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const packageInfo = require("./package.json");
const packageVersion = packageInfo.version;

// NOTE: bump this default when major versions are released
const defaultAcceptVersionHeader = "v6.0";
// Used when no version is supplied. v5+ needs no URL prefix and is the current
// stable line, so it's the safest default for callers who don't care.
const defaultVersion = "v5.0";
const supportedVersions = ["v2", "v3", "v4", "v5", "v6", "canary"];
const packageName = "@dollardeploy/ghost-cli";

const IMAGE_MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

function mimeTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  return IMAGE_MIME_TYPES[ext] || "application/octet-stream";
}

/**
 * Accept a site root or a full Admin/Content API URL (with or without a trailing
 * slash) and reduce it to a clean base the client can build endpoints from.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
function normalizeSiteUrl(rawUrl) {
  return String(rawUrl)
    .replace(/\/ghost\/api\/(admin|content)\/?$/i, "")
    .replace(/\/+$/, "");
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Sign a Ghost Admin API token (HS256 JWT) without external dependencies.
 *
 * @param {string} key - Admin API key in `{id}:{secret}` form
 * @param {string} audience - JWT audience, e.g. `/admin/`
 * @returns {string}
 */
function token(key, audience) {
  const [id, secret] = key.split(":");

  const header = { alg: "HS256", typ: "JWT", kid: id };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now, exp: now + 5 * 60, aud: audience };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac("sha256", Buffer.from(secret, "hex"))
    .update(unsignedToken)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  return `${unsignedToken}.${signature}`;
}

/**
 * Serialize query parameters using the same comma-joined format the Ghost API
 * expects (arrays become comma separated lists, values are URI encoded).
 *
 * @param {string} url
 * @param {Object} params
 * @returns {string}
 */
function serializeQuery(url, params = {}) {
  const keys = Object.keys(params);

  if (!keys.length) {
    return url;
  }

  const queryString = keys
    .reduce((parts, key) => {
      const value = encodeURIComponent([].concat(params[key]).join(","));
      return parts.concat(`${key}=${value}`);
    }, [])
    .join("&");

  if (!queryString) {
    return url;
  }

  return url.includes("?") ? `${url}&${queryString}` : `${url}?${queryString}`;
}

/**
 * This method can go away in favor of only sending 'Accept-Version` headers
 * once the Ghost API removes a concept of version from it's URLS (with Ghost v5)
 *
 * @param {string} [version] version in `v{major}` format
 * @returns {string}
 */
const resolveAPIPrefix = version => {
  let prefix;

  // Only v2, v3, v4, and canary need version prefixes in the URL
  if (version === "v2" || version === "v3" || version === "v4" || version === "canary") {
    prefix = `/${version}/admin/`;
  } else if (version && version.match(/^v[2-4]\.\d+/)) {
    const versionPrefix = /^(v[2-4])\.\d+/.exec(version)[1];
    prefix = `/${versionPrefix}/admin/`;
  } else {
    // Default for v5+, v6, undefined, etc. - no version prefix
    prefix = `/admin/`;
  }

  return prefix;
};

/**
 *
 * @param {Object} options
 * @param {String} options.url
 * @param {String} [options.ghostPath]
 * @param {String|Boolean} options.version - a version string like v3.2, v4.1, v5.8 or boolean value identifying presence of Accept-Version header
 * @param {String|Boolean} [options.userAgent] - flag controlling if the 'User-Agent' header should be sent with a request
 * @param {Function} [options.makeRequest]
 * @param {Function} [options.generateToken]
 * @param {String} [options.host] Deprecated
 */
module.exports = function GhostAdminAPI(options) {
  if (this instanceof GhostAdminAPI) {
    return GhostAdminAPI(options);
  }

  const defaultConfig = {
    ghostPath: "ghost",
    userAgent: true,
    generateToken: token,
    async makeRequest({ url, method, data, params = {}, headers = {} }) {
      const requestUrl = serializeQuery(url, params);
      const requestHeaders = Object.assign({}, headers);

      const fetchOptions = { method, headers: requestHeaders };

      // GET/HEAD must never carry a body (fetch throws if they do); some
      // read endpoints pass an empty object as the "body" placeholder.
      const allowsBody = method !== "GET" && method !== "HEAD";
      const hasBody = allowsBody && data !== undefined && data !== null && data !== "";
      if (hasBody) {
        const hasContentType = Object.keys(requestHeaders).some(
          key => key.toLowerCase() === "content-type"
        );
        if (!hasContentType) {
          requestHeaders["Content-Type"] = "application/json";
        }
        fetchOptions.body = typeof data === "string" ? data : JSON.stringify(data);
      }

      const response = await fetch(requestUrl, fetchOptions);

      const rawBody = await response.text();
      let parsedBody;
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch (e) {
          parsedBody = rawBody;
        }
      }

      if (!response.ok) {
        const error = new Error(`Request failed with status code ${response.status}`);
        error.response = { status: response.status, data: parsedBody };
        throw error;
      }

      return parsedBody;
    }
  };

  const config = Object.assign({}, defaultConfig, options);

  //
  /**
   * host parameter is deprecated
   * @deprecated use "url" instead
   * @example new GhostAdminAPI({host: '...'})
   */
  if (config.host) {
    // eslint-disable-next-line
    console.warn(
      `${packageName}: The 'host' parameter is deprecated, please use 'url' instead`
    );
    if (!config.url) {
      config.url = config.host;
    }
  }

  if (config.version === undefined) {
    config.version = defaultVersion;
  }

  if (typeof config.version === "boolean") {
    if (config.version === true) {
      config.acceptVersionHeader = defaultAcceptVersionHeader;
    }
    config.version = undefined;
  } else if (
    !supportedVersions.includes(config.version) &&
    !config.version.match(/^v\d+\.\d+/)
  ) {
    throw new Error(
      `${packageName} Config Invalid: 'version' ${config.version} is not supported`
    );
  } else if (
    supportedVersions.includes(config.version) ||
    config.version.match(/^v\d+\.\d+/)
  ) {
    if (config.version === "canary") {
      // eslint-disable-next-line
      console.warn(
        `${packageName}: The 'version' parameter has a deprecated format 'canary', please use 'v{major}.{minor}' format instead`
      );

      config.acceptVersionHeader = defaultAcceptVersionHeader;
    } else if (config.version.match(/^v\d+$/)) {
      // eslint-disable-next-line
      console.warn(
        `${packageName}: The 'version' parameter has a deprecated format 'v{major}', please use 'v{major}.{minor}' format instead`
      );

      // CASE: all the v1, v2, v4 ... strings should be normalized to fit 'v{major}.{minor}' format
      config.acceptVersionHeader = `${config.version}.0`;
    } else {
      config.acceptVersionHeader = config.version;
    }
  }

  if (typeof config.url === "string") {
    config.url = normalizeSiteUrl(config.url);
  }

  if (!config.url) {
    throw new Error(
      `${packageName} Config Missing: 'url' is required. E.g. 'https://site.com'`
    );
  }
  if (!/https?:\/\//.test(config.url)) {
    throw new Error(
      `${packageName} Config Invalid: 'url' ${config.url} requires a protocol. E.g. 'https://site.com'`
    );
  }
  if (config.url.endsWith("/")) {
    throw new Error(
      `${packageName} Config Invalid: 'url' ${config.url} must not have a trailing slash. E.g. 'https://site.com'`
    );
  }
  if (config.ghostPath.endsWith("/") || config.ghostPath.startsWith("/")) {
    throw new Error(
      `${packageName} Config Invalid: 'ghostPath' ${config.ghostPath} must not have a leading or trailing slash. E.g. 'ghost'`
    );
  }
  if (!config.key) {
    throw new Error(
      `${packageName} Config Invalid: 'key' ${config.key} must have 26 hex characters`
    );
  }
  if (!/[0-9a-f]{24}:[0-9a-f]{64}/.test(config.key)) {
    throw new Error(
      `${packageName} Config Invalid: 'key' ${config.key} must have the following format {A}:{B}, where A is 24 hex characters and B is 64 hex characters`
    );
  }

  const resources = ["posts", "pages", "tags", "webhooks", "members", "users", "newsletters"];

  if (typeof config.version === "string" && config.version.startsWith("v2")) {
    resources.push("subscribers");
  }

  const api = resources.reduce((apiObject, resourceType) => {
    function add(data, queryParams = {}) {
      if (!data || !Object.keys(data).length) {
        return Promise.reject(new Error("Missing data"));
      }

      const mapped = {};
      mapped[resourceType] = [data];

      return makeResourceRequest(resourceType, queryParams, mapped, "POST");
    }

    function edit(data, queryParams = {}) {
      if (!data) {
        return Promise.reject(new Error("Missing data"));
      }

      if (!data.id) {
        return Promise.reject(new Error("Must include data.id"));
      }

      const body = {};
      const urlParams = {};

      if (data.id) {
        urlParams.id = data.id;
        delete data.id;
      }

      body[resourceType] = [data];

      return makeResourceRequest(resourceType, queryParams, body, "PUT", urlParams);
    }

    function del(data, queryParams = {}) {
      if (!data) {
        return Promise.reject(new Error("Missing data"));
      }

      if (!data.id && !data.email) {
        return Promise.reject(new Error("Must include either data.id or data.email"));
      }

      const urlParams = data;

      return makeResourceRequest(resourceType, queryParams, data, "DELETE", urlParams);
    }

    function browse(opts = {}) {
      return makeResourceRequest(resourceType, opts);
    }

    function read(data, queryParams) {
      if (!data) {
        return Promise.reject(new Error("Missing data"));
      }

      if (!data.id && !data.slug && !data.email) {
        return Promise.reject(
          new Error("Must include either data.id or data.slug or data.email")
        );
      }

      const urlParams = {
        id: data.id,
        slug: data.slug,
        email: data.email
      };

      delete data.id;
      delete data.slug;
      delete data.email;

      queryParams = Object.assign({}, queryParams, data);

      return makeResourceRequest(resourceType, queryParams, "", "GET", urlParams);
    }

    let resourceAPI = {};
    if (resourceType === "webhooks") {
      resourceAPI = {
        [resourceType]: {
          add,
          edit,
          delete: del
        }
      };
    } else {
      resourceAPI = {
        [resourceType]: {
          read,
          browse,
          add,
          edit,
          delete: del
        }
      };
    }

    return Object.assign(apiObject, resourceAPI);
  }, {});

  api.config = {
    read() {
      return makeResourceRequest("config", {}, {});
    }
  };

  api.site = {
    read() {
      return makeResourceRequest("site", {}, {});
    }
  };

  api.themes = {
    activate(name) {
      if (!name) {
        return Promise.reject(new Error("Missing theme name"));
      }

      return makeResourceRequest("themes", {}, {}, "PUT", { id: `${name}/activate` });
    }
  };

  api.images = {
    /**
     * Upload an image to Ghost's content storage and return `{url, ref}`.
     *
     * Uses native `fetch` + `FormData` + `Blob` (Node 18+) for the multipart
     * request, so there are still no external dependencies.
     *
     * @param {string|Buffer} image - a file path or a raw image buffer
     * @param {Object} [opts]
     * @param {string} [opts.filename] - required when passing a Buffer
     * @param {string} [opts.contentType] - inferred from the filename if omitted
     * @param {string} [opts.ref] - optional reference echoed back in the response
     * @param {string} [opts.purpose] - 'image' (default), 'profile_image' or 'icon'
     * @returns {Promise<{url: string, ref: ?string}>}
     */
    async upload(image, opts = {}) {
      let buffer;
      let filename = opts.filename;

      if (Buffer.isBuffer(image)) {
        buffer = image;
        if (!filename) {
          throw new Error("images.upload requires opts.filename when passing a Buffer");
        }
      } else if (typeof image === "string") {
        buffer = fs.readFileSync(image);
        filename = filename || path.basename(image);
      } else {
        throw new Error("images.upload expects a file path or a Buffer");
      }

      const contentType = opts.contentType || mimeTypeFor(filename);
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: contentType }), filename);
      form.append("purpose", opts.purpose || "image");
      if (opts.ref) {
        form.append("ref", opts.ref);
      }

      const apiPrefix = resolveAPIPrefix(config.version);
      const uploadUrl = `${config.url}/${config.ghostPath}/api${apiPrefix}images/upload/`;

      const headers = {
        Authorization: `Ghost ${config.generateToken(config.key, apiPrefix)}`
      };
      if (config.acceptVersionHeader) {
        headers["Accept-Version"] = config.acceptVersionHeader;
      }
      if (config.userAgent) {
        headers["User-Agent"] =
          typeof config.userAgent === "boolean"
            ? `GhostAdminSDK/${packageVersion}`
            : config.userAgent;
      }

      const response = await fetch(uploadUrl, { method: "POST", headers, body: form });
      const rawBody = await response.text();
      let parsedBody;
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
      } catch (e) {
        parsedBody = rawBody;
      }

      if (!response.ok) {
        const apiError = parsedBody && parsedBody.errors && parsedBody.errors[0];
        const error = new Error(
          apiError
            ? apiError.message
            : `Image upload failed with status code ${response.status}`
        );
        if (apiError && apiError.type) {
          error.name = apiError.type;
        }
        throw error;
      }

      return parsedBody && parsedBody.images && parsedBody.images[0];
    }
  };

  return api;

  function makeResourceRequest(
    resourceType,
    queryParams = {},
    body = "",
    method = "GET",
    urlParams = {}
  ) {
    return makeApiRequest({
      endpoint: endpointFor(resourceType, urlParams),
      method,
      queryParams,
      body
    }).then(data => {
      if (method === "DELETE") {
        return data;
      }

      if (!Array.isArray(data[resourceType])) {
        return data[resourceType];
      }
      if (data[resourceType].length === 1 && !data.meta) {
        return data[resourceType][0];
      }
      return Object.assign(data[resourceType], { meta: data.meta });
    });
  }

  function endpointFor(resource, { id, slug, email } = {}) {
    const { ghostPath, version } = config;

    const apiPrefix = resolveAPIPrefix(version);
    let endpoint = `/${ghostPath}/api${apiPrefix}${resource}/`;

    if (id) {
      endpoint = `${endpoint}${id}/`;
    } else if (slug) {
      endpoint = `${endpoint}slug/${slug}/`;
    } else if (email) {
      endpoint = `${endpoint}email/${email}/`;
    }

    return endpoint;
  }

  function makeApiRequest({ endpoint, method, body, queryParams = {}, headers = {} }) {
    const { url: apiUrl, key, version, makeRequest } = config;
    const url = `${apiUrl}${endpoint}`;

    let authorizationHeader;
    const audience = resolveAPIPrefix(version);
    authorizationHeader = `Ghost ${config.generateToken(key, audience)}`;

    const ghostHeaders = {
      Authorization: authorizationHeader
    };

    if (config.userAgent) {
      if (typeof config.userAgent === "boolean") {
        ghostHeaders["User-Agent"] = `GhostAdminSDK/${packageVersion}`;
      } else {
        headers["User-Agent"] = config.userAgent;
      }
    }

    if (config.acceptVersionHeader) {
      ghostHeaders["Accept-Version"] = config.acceptVersionHeader;
    }

    headers = Object.assign({}, headers, ghostHeaders);

    return makeRequest({
      url,
      method,
      data: body,
      params: queryParams,
      headers
    }).catch(err => {
      /**
       * @NOTE:
       *
       * If you are overriding `makeRequest`, we can't garante that the returned format is the same, but
       * we try to detect & return a proper error instance.
       */
      if (err.response && err.response.data && err.response.data.errors) {
        const props = err.response.data.errors[0];
        const toThrow = new Error(props.message);
        const keys = Object.keys(props);

        toThrow.name = props.type;

        keys.forEach(k => {
          toThrow[k] = props[k];
        });

        // @TODO: bring back with a better design idea. if you log the error, the stdout is hard to read
        //        if we return the full response object, which includes also the request etc.
        // toThrow.response = err.response;
        throw toThrow;
      } else {
        delete err.request;
        delete err.config;
        delete err.response;
        throw err;
      }
    });
  }
};
