import { afterEach, describe, expect, it, vi } from "vitest";

// 用假的 .env 內容取代檔案系統，不讀寫真實檔案
const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));
vi.mock("node:fs", () => ({ default: fsMock }));

const ENV_FILE_URL = "postgresql://switchboard:switchboard_dev@localhost:5435/switchboard?schema=public";

// 有 prisma.config.ts 時 Prisma CLI 不載入 .env，而 schema.prisma 的
// env("DATABASE_URL") 只讀 process.env，所以斷言的是 process.env
async function loadConfig() {
  vi.resetModules();
  await import("../prisma.config");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("prisma.config.ts", () => {
  it("loads DATABASE_URL from .env into process.env for schema.prisma", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(`# local dev\nDATABASE_URL="${ENV_FILE_URL}"\nREDIS_URL=""\n`);

    await loadConfig();

    expect(process.env.DATABASE_URL).toBe(ENV_FILE_URL);
  });

  it("keeps DATABASE_URL from the environment and skips .env", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@db:5432/switchboard");

    await loadConfig();

    expect(process.env.DATABASE_URL).toBe("postgresql://ci:ci@db:5432/switchboard");
    expect(fsMock.readFileSync).not.toHaveBeenCalled();
  });
});
