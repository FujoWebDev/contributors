import { readFileSync, readdirSync, watch } from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { TeamContributor } from "./schema.js";
import { PROJECTS } from "./data/projects.js";

const TEAM_DIR = path.resolve(process.cwd(), "team");
const PROJECTS_FILE = path.resolve(process.cwd(), "code/data/projects.ts");
interface ValidationResult {
  file: string;
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

class InvalidRoleError extends Error {
  constructor(projectName: string, filePath: string) {
    super(`Invalid role in project "${projectName}" for file ${filePath}.`);
  }
}

function formatValidationError(error: any, filePath: string): string {
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

function validateTeamFile(filePath: string): ValidationResult {
  const result: ValidationResult = {
    file: filePath,
    isValid: false,
    errors: [],
    warnings: [],
  };

  try {
    const content = readFileSync(filePath, "utf-8");
    const data = parse(content);

    const validation = TeamContributor.safeParse(data);
    if (validation.success) {
      result.isValid = true;
    } else {
      result.errors = validation.error.errors.map((error) =>
        formatValidationError(error, filePath)
      );
    }
  } catch (error) {
    result.errors.push(
      `Failed to parse file: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  return result;
}

function validateAllTeamFiles(): ValidationResult[] {
  const results: ValidationResult[] = [];

  try {
    const files = readdirSync(TEAM_DIR)
      .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
      .map((file) => path.join(TEAM_DIR, file));

    for (const file of files) {
      results.push(validateTeamFile(file));
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

function runValidation(isWatchMode: boolean = false): void {
  const results = validateAllTeamFiles();
  printResults(results);
  if (isWatchMode) {
    console.log("Waiting for more changes...");
  }
}

function startWatchMode(): void {
  console.log("Time to watch 👀");

  // Run initial validation
  runValidation();

  const watchers: Array<{ close: () => void }> = [];

  const teamWatcher = watch(
    TEAM_DIR,
    { recursive: false },
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
  const schemaFile = path.resolve(process.cwd(), "code/schema.ts");
  const schemaWatcher = watch(schemaFile, (eventType) => {
    console.log(`${eventType}: ${schemaFile}`);
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
  runValidation();

  // Exit with error code if validation failed
  const results = validateAllTeamFiles();
  const hasErrors = results.some((r) => !r.isValid);
  process.exit(hasErrors ? 1 : 0);
}
