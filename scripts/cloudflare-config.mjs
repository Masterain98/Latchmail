import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const D1_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKER_NAME_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,253}[A-Za-z0-9])?$/;
const R2_NAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

export class DeploymentConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeploymentConfigurationError";
  }
}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value)
    throw new DeploymentConfigurationError(
      `Missing required build variable or secret: ${name}.`,
    );
  return value;
}

function requiredSecret(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0)
    throw new DeploymentConfigurationError(
      `Missing required build variable or secret: ${name}.`,
    );
  return value;
}

function validatePattern(name, value, pattern, description) {
  if (!pattern.test(value))
    throw new DeploymentConfigurationError(
      `${name} is invalid; expected ${description}.`,
    );
  return value;
}

function validatePlainValue(name, value, maximumLength, description) {
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 31 || code === 127);
    })
  )
    throw new DeploymentConfigurationError(
      `${name} is invalid; expected ${description}.`,
    );
  return value;
}

function validateOrigin(value, allowLocalHttp = false) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new DeploymentConfigurationError(
      "APP_ORIGIN must be a valid absolute Origin.",
    );
  }
  const localHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(allowLocalHttp && localHost))
    throw new DeploymentConfigurationError(
      "APP_ORIGIN must use HTTPS (HTTP is allowed only for local development).",
    );
  if (value !== parsed.origin)
    throw new DeploymentConfigurationError(
      "APP_ORIGIN must contain only scheme, host and optional port, with no path or trailing slash.",
    );
  return value;
}

function validateSecret(name, value) {
  if (value.length < 32 || value.length > 4096)
    throw new DeploymentConfigurationError(
      `${name} must contain between 32 and 4096 characters.`,
    );
  return value;
}

function validateWebhookSecret(value) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value))
    throw new DeploymentConfigurationError(
      "WEBHOOK_SIGNING_SECRET must be standard Base64 for exactly 32 bytes.",
    );
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value)
    throw new DeploymentConfigurationError(
      "WEBHOOK_SIGNING_SECRET must be standard Base64 for exactly 32 bytes.",
    );
  return value;
}

export function readDeploymentValues(environment = process.env) {
  const workerName =
    environment.WRANGLER_CI_OVERRIDE_NAME?.trim() ||
    environment.LATCHMAIL_WORKER_NAME?.trim();
  if (!workerName)
    throw new DeploymentConfigurationError(
      "Missing Worker name: Workers Builds must provide WRANGLER_CI_OVERRIDE_NAME, or set LATCHMAIL_WORKER_NAME.",
    );

  const environmentName = environment.ENVIRONMENT?.trim() || "production";
  return {
    workerName: validatePattern(
      "Worker name",
      workerName,
      WORKER_NAME_PATTERN,
      "1-255 letters, digits or interior hyphens",
    ),
    d1DatabaseName: validatePlainValue(
      "LATCHMAIL_D1_DATABASE_NAME",
      required(environment, "LATCHMAIL_D1_DATABASE_NAME"),
      255,
      "the exact existing D1 name without control characters",
    ),
    d1DatabaseId: validatePattern(
      "LATCHMAIL_D1_DATABASE_ID",
      required(environment, "LATCHMAIL_D1_DATABASE_ID"),
      D1_ID_PATTERN,
      "a D1 database UUID",
    ),
    r2BucketName: validatePattern(
      "LATCHMAIL_R2_BUCKET_NAME",
      required(environment, "LATCHMAIL_R2_BUCKET_NAME"),
      R2_NAME_PATTERN,
      "3-63 lowercase letters, digits or interior hyphens",
    ),
    appOrigin: validateOrigin(required(environment, "APP_ORIGIN")),
    environmentName: validatePlainValue(
      "ENVIRONMENT",
      environmentName,
      64,
      "a 1-64 character label without control characters",
    ),
  };
}

export function readRuntimeSecrets(environment = process.env) {
  const secrets = {
    ADMIN_PASSWORD: validateSecret(
      "ADMIN_PASSWORD",
      requiredSecret(environment, "ADMIN_PASSWORD"),
    ),
    SESSION_SECRET: validateSecret(
      "SESSION_SECRET",
      requiredSecret(environment, "SESSION_SECRET"),
    ),
  };
  const apiToken = environment.ADMIN_API_TOKEN;
  if (apiToken)
    secrets.ADMIN_API_TOKEN = validateSecret("ADMIN_API_TOKEN", apiToken);
  const webhookSecret = environment.WEBHOOK_SIGNING_SECRET;
  if (webhookSecret)
    secrets.WEBHOOK_SIGNING_SECRET = validateWebhookSecret(webhookSecret);
  return secrets;
}

export function localDeploymentValues(environment = process.env) {
  return {
    workerName: validatePattern(
      "LATCHMAIL_WORKER_NAME",
      environment.LATCHMAIL_WORKER_NAME?.trim() || "latchmail-local",
      WORKER_NAME_PATTERN,
      "1-255 letters, digits or interior hyphens",
    ),
    d1DatabaseName: validatePlainValue(
      "LATCHMAIL_D1_DATABASE_NAME",
      environment.LATCHMAIL_D1_DATABASE_NAME?.trim() || "latchmail-local",
      255,
      "the exact existing D1 name without control characters",
    ),
    d1DatabaseId: validatePattern(
      "LATCHMAIL_D1_DATABASE_ID",
      environment.LATCHMAIL_D1_DATABASE_ID?.trim() ||
        "00000000-0000-4000-8000-000000000001",
      D1_ID_PATTERN,
      "a D1 database UUID",
    ),
    r2BucketName: validatePattern(
      "LATCHMAIL_R2_BUCKET_NAME",
      environment.LATCHMAIL_R2_BUCKET_NAME?.trim() || "latchmail-local",
      R2_NAME_PATTERN,
      "3-63 lowercase letters, digits or interior hyphens",
    ),
    appOrigin: validateOrigin(
      environment.APP_ORIGIN?.trim() || "http://127.0.0.1:8787",
      true,
    ),
    environmentName: validatePlainValue(
      "ENVIRONMENT",
      environment.ENVIRONMENT?.trim() || "local",
      64,
      "a 1-64 character label without control characters",
    ),
  };
}

export function checkDeploymentValues() {
  return {
    workerName: "latchmail-check",
    d1DatabaseName: "latchmail-check",
    d1DatabaseId: "00000000-0000-4000-8000-000000000002",
    r2BucketName: "latchmail-check",
    appOrigin: "https://latchmail-check.example.invalid",
    environmentName: "check",
  };
}

export function createWranglerConfig(values) {
  return {
    $schema: "../../node_modules/wrangler/config-schema.json",
    name: values.workerName,
    main: "../../src/worker/index.ts",
    compatibility_date: "2026-09-10",
    compatibility_flags: ["nodejs_compat"],
    rules: [{ type: "Text", globs: ["**/*.sql"], fallthrough: true }],
    assets: {
      directory: "../../dist",
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: ["/api/*", "/healthz", "/cdn-cgi/handler/email"],
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: values.d1DatabaseName,
        database_id: values.d1DatabaseId,
      },
    ],
    r2_buckets: [
      { binding: "MAIL_STORAGE", bucket_name: values.r2BucketName },
    ],
    vars: {
      APP_ORIGIN: values.appOrigin,
      ENVIRONMENT: values.environmentName,
    },
    triggers: { crons: ["* * * * *"] },
  };
}

export async function writeGeneratedConfig({
  root = process.cwd(),
  values,
  filename = "wrangler.generated.json",
}) {
  const generatedDirectory = resolve(root, ".wrangler", "generated");
  await mkdir(generatedDirectory, { recursive: true });
  const configPath = join(generatedDirectory, filename);
  await writeFile(
    configPath,
    `${JSON.stringify(createWranglerConfig(values), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return configPath;
}

export async function writeDeploymentArtifacts({
  root = process.cwd(),
  environment = process.env,
} = {}) {
  const values = readDeploymentValues(environment);
  const secrets = readRuntimeSecrets(environment);
  const generatedDirectory = resolve(root, ".wrangler", "generated");
  await mkdir(generatedDirectory, { recursive: true });
  const configPath = await writeGeneratedConfig({
    root,
    values,
  });
  const secretsPath = join(generatedDirectory, "runtime-secrets.json");
  try {
    await writeFile(
      secretsPath,
      `${JSON.stringify(secrets, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(secretsPath, 0o600).catch(() => undefined);
  } catch (error) {
    await Promise.all([
      rm(configPath, { force: true }),
      rm(secretsPath, { force: true }),
    ]);
    throw error;
  }

  return {
    configPath,
    secretsPath,
    configArgument: relative(root, configPath),
    secretsArgument: relative(root, secretsPath),
    async cleanup() {
      await Promise.all([
        rm(configPath, { force: true }),
        rm(secretsPath, { force: true }),
      ]);
    },
  };
}
