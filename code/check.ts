import { readFileSync, readdirSync, watch } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { TeamContributor as TeamContributorFunction } from "../team/_schema";
import z from "zod";

const TEAM_DIR = path.resolve(process.cwd(), "team");
const PROJECTS_FILE = path.resolve(process.cwd(), "team/_schema/projects.ts");
const SCHEMA_FILE = path.resolve(process.cwd(), "team/_schema/index.ts");

// Global abort controller to manage running validations
let currentValidationController: AbortController | null = null;
interface ValidationResult {
  file: string;
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

class InvalidRoleError extends Error {
  constructor(projectName: string, filePath: string) {
    super(
      `Invalid role in project "${projectName}" for file ./${path.relative(
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

// @ts-expect-error This is fucked up because it's type of image in Astro
const TeamContributor = TeamContributorFunction({ image: z.string})

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
      throw new InvalidRoleError(projectName, filePath);
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

    const validation = await TeamContributor.superRefine(
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

function printResults(results: ValidationResult[]): void {
  console.clear();
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
    console.log("\n💡 Tips:");
    console.log(
      `   • Project names and roles must match those in ./${path.relative(
        process.cwd(),
        PROJECTS_FILE
      )}`
    );
    console.log(
      `   • Ensure all required fields (${Object.entries(TeamContributor.shape)
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
    console.clear();
    console.log("Running validation...");

    // Needs to wait or it's not clear anything is happening
    await sleep(200);

    const results = await Promise.all(await validateAllTeamFiles(signal));
    const hasErrors = results.some((r) => !r.isValid);

    printResults(await Promise.all(results));
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
  runValidation();

  const watchers: Array<{ close: () => void }> = [];

  const teamWatcher = watch(
    TEAM_DIR,
    { recursive: true },
    (eventType, filename) => {
      console.log(`${eventType}: ${filename}`);
      if (
        filename &&
        (filename.endsWith(".yaml") || filename.endsWith(".yml"))
      ) {
        runValidation();
      }
    }
  );
  watchers.push(teamWatcher);

  // Watch projects file
  const projectsWatcher = watch(PROJECTS_FILE, (eventType) => {
    console.log(`${eventType}: ${PROJECTS_FILE}`);
    runValidation();
  });
  watchers.push(projectsWatcher);

  // Watch schema file
  const schemaWatcher = watch(SCHEMA_FILE, (eventType) => {
    console.log(`${eventType}: ${SCHEMA_FILE}`);
    runValidation();
  });
  watchers.push(schemaWatcher);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n👋 Bye bye!");
    watchers.forEach((watcher) => watcher.close());
    process.exit(0);
  });
}

// Check if running in watch mode
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
