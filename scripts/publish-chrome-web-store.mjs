import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const API_ORIGIN = "https://chromewebstore.googleapis.com";
const WEB_STORE_SCOPE = "https://www.googleapis.com/auth/chromewebstore";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 60;

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

function base64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString("base64url");
}

function parseServiceAccount(rawCredentials) {
  let credentials;
  try {
    credentials = JSON.parse(rawCredentials);
  } catch (error) {
    throw new Error(`CWS_SERVICE_ACCOUNT_JSON is not valid JSON: ${error.message}`);
  }

  for (const field of ["client_email", "private_key"]) {
    if (typeof credentials[field] !== "string" || !credentials[field].trim()) {
      throw new Error(`CWS_SERVICE_ACCOUNT_JSON is missing ${field}`);
    }
  }

  return credentials;
}

function createServiceAccountAssertion(credentials) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const tokenUri = credentials.token_uri || DEFAULT_TOKEN_URI;
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const payload = {
    iss: credentials.client_email,
    scope: WEB_STORE_SCOPE,
    aud: tokenUri,
    iat: issuedAt,
    exp: issuedAt + 3_600,
  };
  const unsignedToken = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(payload),
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();
  const signature = signer.sign(credentials.private_key);

  return {
    assertion: `${unsignedToken}.${base64Url(signature)}`,
    tokenUri,
  };
}

async function parseJsonResponse(response, operation) {
  const body = await response.text();
  let payload = {};

  if (body) {
    try {
      payload = JSON.parse(body);
    } catch {
      payload = { rawResponse: body };
    }
  }

  if (!response.ok) {
    throw new Error(
      `${operation} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }

  return payload;
}

async function createAccessToken(credentials) {
  const { assertion, tokenUri } = createServiceAccountAssertion(credentials);
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const payload = await parseJsonResponse(response, "Google OAuth token exchange");

  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("Google OAuth token exchange returned no access_token");
  }

  return payload.access_token;
}

function itemUrl(publisherId, itemId, action, upload = false) {
  const prefix = upload ? "/upload/v2" : "/v2";
  return `${API_ORIGIN}${prefix}/publishers/${encodeURIComponent(
    publisherId,
  )}/items/${encodeURIComponent(itemId)}:${action}`;
}

function authorizedHeaders(accessToken, extra = {}) {
  return {
    authorization: `Bearer ${accessToken}`,
    ...extra,
  };
}

async function uploadPackage(accessToken, publisherId, itemId, packagePath) {
  const archive = await readFile(packagePath);
  const response = await fetch(itemUrl(publisherId, itemId, "upload", true), {
    method: "POST",
    headers: authorizedHeaders(accessToken, {
      "content-type": "application/zip",
    }),
    body: archive,
  });

  return parseJsonResponse(response, "Chrome Web Store package upload");
}

async function fetchItemStatus(accessToken, publisherId, itemId) {
  const response = await fetch(itemUrl(publisherId, itemId, "fetchStatus"), {
    headers: authorizedHeaders(accessToken),
  });

  return parseJsonResponse(response, "Chrome Web Store status check");
}

async function waitForUpload(accessToken, publisherId, itemId, initialState) {
  if (initialState === "SUCCEEDED") {
    return;
  }
  if (initialState === "FAILED") {
    throw new Error("Chrome Web Store rejected the uploaded package");
  }
  if (initialState !== "IN_PROGRESS") {
    throw new Error(`unexpected Chrome Web Store upload state: ${initialState}`);
  }

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, POLL_INTERVAL_MS),
    );
    const status = await fetchItemStatus(accessToken, publisherId, itemId);
    const uploadState = status.lastAsyncUploadState;
    console.log(
      `Chrome Web Store upload status (${attempt}/${MAX_POLL_ATTEMPTS}): ${
        uploadState || "unknown"
      }`,
    );

    if (uploadState === "SUCCEEDED") {
      return;
    }
    if (uploadState === "FAILED") {
      throw new Error("Chrome Web Store failed while processing the uploaded package");
    }
  }

  throw new Error("timed out waiting for Chrome Web Store to process the package");
}

async function publishItem(accessToken, publisherId, itemId) {
  const response = await fetch(itemUrl(publisherId, itemId, "publish"), {
    method: "POST",
    headers: authorizedHeaders(accessToken, {
      "content-type": "application/json",
    }),
    body: JSON.stringify({
      publishType: "DEFAULT_PUBLISH",
    }),
  });

  return parseJsonResponse(response, "Chrome Web Store publish request");
}

async function main() {
  const publisherId = requiredEnv("CWS_PUBLISHER_ID");
  const itemId = requiredEnv("CWS_ITEM_ID");
  const packagePath = resolve(requiredEnv("CWS_PACKAGE_PATH"));
  const credentials = parseServiceAccount(
    requiredEnv("CWS_SERVICE_ACCOUNT_JSON"),
  );

  console.log(`Preparing Chrome Web Store item ${itemId}`);
  const accessToken = await createAccessToken(credentials);
  const upload = await uploadPackage(
    accessToken,
    publisherId,
    itemId,
    packagePath,
  );
  console.log(
    `Uploaded ${packagePath}; version=${upload.crxVersion || "pending"}; state=${
      upload.uploadState || "unknown"
    }`,
  );

  await waitForUpload(
    accessToken,
    publisherId,
    itemId,
    upload.uploadState,
  );

  const publish = await publishItem(accessToken, publisherId, itemId);
  console.log(
    `Chrome Web Store submission accepted; state=${publish.state || "unknown"}`,
  );

  for (const warning of publish.warningInfo?.warnings || []) {
    console.warn(
      `Chrome Web Store warning ${warning.reason || "UNKNOWN"}: ${
        warning.description || "No description"
      }`,
    );
  }
}

await main().catch((error) => {
  console.error(`Chrome Web Store release failed: ${error.message}`);
  process.exitCode = 1;
});
