import { readFileSync, readdirSync, watch } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { type ContributorSchema as ContributorSchemaType } from "../contributors/_schema";
import { createJiti } from "jiti";

import { parse } from "yaml";

import z from "zod";

const jiti = createJiti(import.meta.url);

async function getContributor() {
  // Clear schema cache to pick up changes
  Object.keys(jiti.cache).forEach((key) => {
    if (key.includes("_schema")) {
      delete jiti.cache[key];
    }
  });
  const { ContributorSchema } = (await jiti.import(
    "../contributors/_schema"
  )) as { ContributorSchema: typeof ContributorSchemaType };
  // @ts-expect-error This is fucked up because it's type of image in Astro
  return ContributorSchema({ image: z.string });
}

const TEAM_DIR = path.resolve(process.cwd(), "contributors");
const PROJECTS_FILE = path.resolve(
  process.cwd(),
  "contributors/_schema/projects.ts"
);
const SCHEMA_FILE = path.resolve(
  process.cwd(),
  "contributors/_schema/index.ts"
);

// Global abort controller to manage running validations
let currentValidationController: AbortController | null = null;
interface ValidationResult {
  file: string;
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

class InvalidRoleError extends Error {
  constructor(roleName: string, projectName: string, filePath: string) {
    super(
      `Invalid role ${roleName} in project "${projectName}" for file ./${path.relative(
        process.cwd(),
        filePath
      )}.`
    );
  }
}

class InvalidProjectError extends Error {
  constructor(projectName: string, filePath: string) {
    super(
      `Invalid project "${projectName}" for file ./${path.relative(
        process.cwd(),
        filePath
      )}.`
    );
  }
}

function formatValidationError(error: any, filePath: string): string {
  if (error.code === "unrecognized_keys") {
    if (error.path.length === 1 && error.path[0].includes("roles")) {
      const projectName = error.keys[0];
      throw new InvalidProjectError(projectName, filePath);
    }
  }
  if (error.code === "invalid_union") {
    // Handle role validation errors more clearly
    const path = error.path.join(".");
    if (path.includes("roles.")) {
      const projectName = path.split(".")[1];
      const roleName = error.unionErrors
        // TODO: figure out zod typings
        .flatMap((e: any) => e.issues)
        .find((issue: any) => issue.code == "invalid_enum_value")?.received;
      throw new InvalidRoleError(roleName, projectName, filePath);
    }
  }

  if (error.path && error.path.length > 0) {
    return `${error.path.join(".")}: ${error.message}`;
  }

  return error.message;
}

async function validateTeamFile(
  filePath: string,
  signal?: AbortSignal
): Promise<ValidationResult> {
  const result: ValidationResult = {
    file: filePath,
    isValid: false,
    errors: [],
    warnings: [],
  };

  try {
    signal?.throwIfAborted();

    const content = readFileSync(filePath, "utf-8");
    const data = parse(content);
    const Contributor = await getContributor();

    const validation = await Contributor.superRefine(
      async (contributor, ctx) => {
        const avatarPath = path.resolve(
          path.dirname(filePath),
          // @ts-expect-error This is fucked up because it's type of image in Astro
          contributor.avatar
        );
        try {
          await access(avatarPath);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `No avatar file found at ./${path.relative(
              process.cwd(),
              avatarPath
            )}`,
            path: ["avatar"],
          });
        }
      }
    ).safeParseAsync(data);
    if (validation.success) {
      result.isValid = true;
    } else {
      result.errors = validation.error.errors.map((error) =>
        formatValidationError(error, filePath)
      );
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    result.errors.push(
      `Failed to parse file: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return result;
}

function validateAllTeamFiles(signal?: AbortSignal) {
  const results: Promise<ValidationResult>[] = [];

  try {
    const files = readdirSync(TEAM_DIR)
      .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
      .map((file) => path.join(TEAM_DIR, file));

    for (const file of files) {
      results.push(validateTeamFile(file, signal));
    }
  } catch (error) {
    console.error(
      `Error reading team directory: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return results;
}

async function printResults(
  results: ValidationResult[],
  isWatchMode: boolean = false
) {
  if (isWatchMode) {
    console.clear();
  }
  const hasErrors = results.some((r) => r.errors.length > 0);

  if (hasErrors) {
    console.log("❌ Found errors:\n");
    console.log("--------------------------------");
    for (const result of results) {
      if (result.errors.length > 0) {
        console.log(`./team/${path.relative(process.cwd(), result.file)}:`);
        for (const error of result.errors) {
          console.log(`  - ${error}`);
        }
      }
    }
    console.log("--------------------------------\n");
  } else {
    console.log("🎉 Great news:");
  }

  console.log(
    `${results.filter((r) => r.isValid).length}/${results.length} files valid`
  );

  if (hasErrors) {
    const Contributor = await getContributor();
    console.log("\n💡 Tips:");
    console.log(
      `   • Project names and roles must match those in ./${path.relative(
        process.cwd(),
        PROJECTS_FILE
      )}`
    );
    console.log(
      `   • Ensure all required fields (${Object.entries(Contributor.shape)
        .filter(([_, field]) => !field.isOptional())
        .map(([fieldKey]) => fieldKey)
        .join(", ")}) are present`
    );
    console.log("   • Verify contact URLs are valid");
  }
}

async function runValidation(isWatchMode: boolean = false) {
  // Cancel any existing validation
  currentValidationController?.abort();

  // Create new abort controller for this validation
  currentValidationController = new AbortController();
  const signal = currentValidationController.signal;

  try {
    if (isWatchMode) {
      console.clear();
    }
    console.log("Running validation...");

    // Needs to wait or it's not clear anything is happening
    await sleep(200);

    const results = await Promise.all(await validateAllTeamFiles(signal));
    const hasErrors = results.some((r) => !r.isValid);

    await printResults(await Promise.all(results));
    if (isWatchMode) {
      console.log("Waiting for more changes...");
    }
    return hasErrors;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return false;
    }
    throw error;
  } finally {
    if (currentValidationController?.signal === signal) {
      currentValidationController = null;
    }
  }
}

function startWatchMode(): void {
  console.log("Time to watch 👀");

  // Run initial validation
  runValidation(true);

  const watchers: Array<{ close: () => void }> = [];

  const teamWatcher = watch(
    TEAM_DIR,
    { recursive: true },
    (eventType, filename) => {
      if (
        filename &&
        (filename.endsWith(".yaml") || filename.endsWith(".yml"))
      ) {
        runValidation(true);
      }
    }
  );
  watchers.push(teamWatcher);

  const projectsWatcher = watch(PROJECTS_FILE, () => {
    runValidation(true);
  });
  watchers.push(projectsWatcher);

  const schemaWatcher = watch(SCHEMA_FILE, () => {
    runValidation(true);
  });
  watchers.push(schemaWatcher);

  process.on("SIGINT", () => {
    console.log("\n👋 Bye bye!");
    watchers.forEach((watcher) => watcher.close());
    process.exit(0);
  });
}

const isWatchMode =
  process.argv.includes("--watch") || process.argv.includes("-w");

if (isWatchMode) {
  startWatchMode();
} else {
  const hasErrors = await runValidation();

  process.exit(hasErrors ? 1 : 0);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
