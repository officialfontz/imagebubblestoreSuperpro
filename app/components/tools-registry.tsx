"use client";

// Attaches the client components to the tool list. Kept apart from
// lib/tools.tsx so the list itself stays light enough for the rail.

import { TOOL_DEFS } from "@/lib/tools";
import ShrinkTool from "./ShrinkTool";
import TextTool from "./TextTool";

const COMPONENTS: Record<string, React.ComponentType> = {
  shrink: ShrinkTool,
  replace: TextTool,
};

for (const t of TOOL_DEFS) t.component = COMPONENTS[t.slug];

export { TOOL_DEFS };
