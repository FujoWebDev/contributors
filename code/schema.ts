import { z } from "zod";
import { PROJECT_ROLES, PROJECTS } from "./data/projects";
import {
  SocialsSchema,
  transformSocial,
} from "@fujocoded/zod-transform-socials";

const Role = <T extends z.ZodEnum<any> | z.ZodString = z.ZodString>(
  roleType: T | z.ZodString = z.string()
) =>
  z.union([
    roleType,
    z.object({
      role: roleType,
      details: z.string(),
    }),
  ]);

const Roles = z.object(
  Object.fromEntries(
    PROJECTS.map((project) => [
      project,
      Role(PROJECT_ROLES[project]).array().default([]),
    ])
  )
);

export const TeamContributor = z.object({
  name: z.string(),
  avatar: z.string(),
  roles: Roles,
  contacts: SocialsSchema.array()
    .default([])
    .transform((contacts) => contacts.map(transformSocial)),
});
