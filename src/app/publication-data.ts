// ABOUTME: Shares one request-time publication snapshot across public server components.
// ABOUTME: Prevents metadata and page rendering from observing different database states.
import { connection } from "next/server";
import { cache } from "react";

import { loadPublicationContent } from "@/content/publication-data";

export const loadPublicPageContent = cache(async () => {
  await connection();
  return loadPublicationContent();
});
