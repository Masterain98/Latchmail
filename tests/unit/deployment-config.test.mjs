import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeploymentConfigurationError,
  createWranglerConfig,
  readDeploymentValues,
  readRuntimeSecrets,
  writeDeploymentArtifacts,
} from "../../scripts/cloudflare-config.mjs";
import { deployCloudflare } from "../../scripts/deploy-cloudflare.mjs";

const temporaryDirectories = [];
const validEnvironment = {
  WRANGLER_CI_OVERRIDE_NAME: "my-latchmail",
  LATCHMAIL_D1_DATABASE_NAME: "mail_index_01",
  LATCHMAIL_D1_DATABASE_ID: "9f14a2d8-6b70-4a5c-8d31-7f67ce06e487",
  LATCHMAIL_R2_BUCKET_NAME: "my-private-mail",
  APP_ORIGIN: "https://mail.example.com",
  ADMIN_PASSWORD: "a-secure-administrator-password-1234",
  SESSION_SECRET: "an-independent-session-secret-12345",
};

async function temporaryRoot() {
  const directory = await mkdtemp(join(tmpdir(), "latchmail-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Cloudflare deployment configuration", () => {
  it("accepts user-selected resources and defaults the environment", () => {
    const values = readDeploymentValues(validEnvironment);
    expect(values).toEqual({
      workerName: "my-latchmail",
      d1DatabaseName: "mail_index_01",
      d1DatabaseId: "9f14a2d8-6b70-4a5c-8d31-7f67ce06e487",
      r2BucketName: "my-private-mail",
      appOrigin: "https://mail.example.com",
      environmentName: "production",
    });
    const config = createWranglerConfig(values);
    expect(config.d1_databases[0].binding).toBe("DB");
    expect(config.r2_buckets[0].binding).toBe("MAIL_STORAGE");
    expect(config.assets.binding).toBe("ASSETS");
    expect(config.triggers.crons).toEqual(["* * * * *"]);
  });

  it("uses an explicit Worker name outside Workers Builds", () => {
    const values = readDeploymentValues({
      ...validEnvironment,
      WRANGLER_CI_OVERRIDE_NAME: "",
      LATCHMAIL_WORKER_NAME: "chosen-worker",
      ENVIRONMENT: "staging",
    });
    expect(values.workerName).toBe("chosen-worker");
    expect(values.environmentName).toBe("staging");
  });

  it("preserves an existing D1 name instead of imposing a project naming scheme", () => {
    const values = readDeploymentValues({
      ...validEnvironment,
      LATCHMAIL_D1_DATABASE_NAME: "Customer Mail Index.v2",
    });
    expect(values.d1DatabaseName).toBe("Customer Mail Index.v2");
  });

  it.each([
    ["missing D1 ID", { LATCHMAIL_D1_DATABASE_ID: "" }],
    ["malformed D1 ID", { LATCHMAIL_D1_DATABASE_ID: "not-an-id" }],
    ["public Origin path", { APP_ORIGIN: "https://mail.example.com/inbox" }],
    ["insecure public Origin", { APP_ORIGIN: "http://mail.example.com" }],
    ["invalid R2 name", { LATCHMAIL_R2_BUCKET_NAME: "Private_Mail" }],
  ])("rejects %s", (_label, overrides) => {
    expect(() =>
      readDeploymentValues({ ...validEnvironment, ...overrides }),
    ).toThrow(DeploymentConfigurationError);
  });

  it("validates required and optional runtime secrets", () => {
    const secrets = readRuntimeSecrets({
      ...validEnvironment,
      ADMIN_API_TOKEN: "independent-automation-token-123456",
      WEBHOOK_SIGNING_SECRET:
        "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    });
    expect(Object.keys(secrets)).toEqual([
      "ADMIN_PASSWORD",
      "SESSION_SECRET",
      "ADMIN_API_TOKEN",
      "WEBHOOK_SIGNING_SECRET",
    ]);
    expect(() =>
      readRuntimeSecrets({ ...validEnvironment, ADMIN_PASSWORD: "too-short" }),
    ).toThrow(/ADMIN_PASSWORD/);
    expect(() =>
      readRuntimeSecrets({
        ...validEnvironment,
        WEBHOOK_SIGNING_SECRET: "not-base64",
      }),
    ).toThrow(/WEBHOOK_SIGNING_SECRET/);
  });

  it("keeps secrets out of the generated config and removes artifacts", async () => {
    const root = await temporaryRoot();
    const artifacts = await writeDeploymentArtifacts({
      root,
      environment: validEnvironment,
    });
    const config = await readFile(artifacts.configPath, "utf8");
    expect(config).not.toContain(validEnvironment.ADMIN_PASSWORD);
    expect(config).not.toContain(validEnvironment.SESSION_SECRET);
    expect(await readFile(artifacts.secretsPath, "utf8")).toContain(
      validEnvironment.ADMIN_PASSWORD,
    );
    await artifacts.cleanup();
    await expect(readFile(artifacts.configPath, "utf8")).rejects.toThrow();
    await expect(readFile(artifacts.secretsPath, "utf8")).rejects.toThrow();
  });

  it("always cleans deployment artifacts when Wrangler fails", async () => {
    const root = await temporaryRoot();
    let argumentsList;
    await expect(
      deployCloudflare({
        root,
        environment: validEnvironment,
        run: async (received) => {
          argumentsList = received;
          throw new Error("synthetic upload failure");
        },
      }),
    ).rejects.toThrow("synthetic upload failure");
    expect(argumentsList).toContain("--secrets-file");
    await expect(
      readFile(join(root, ".wrangler/generated/runtime-secrets.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("cleans deployment artifacts after a successful upload", async () => {
    const root = await temporaryRoot();
    await deployCloudflare({
      root,
      environment: validEnvironment,
      run: async (argumentsList) => {
        const configIndex = argumentsList.indexOf("--config") + 1;
        const secretsIndex = argumentsList.indexOf("--secrets-file") + 1;
        await expect(
          readFile(join(root, argumentsList[configIndex]), "utf8"),
        ).resolves.toContain('"binding": "DB"');
        await expect(
          readFile(join(root, argumentsList[secretsIndex]), "utf8"),
        ).resolves.toContain(validEnvironment.SESSION_SECRET);
      },
    });
    await expect(
      readFile(join(root, ".wrangler/generated/wrangler.generated.json"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(root, ".wrangler/generated/runtime-secrets.json"), "utf8"),
    ).rejects.toThrow();
  });
});
