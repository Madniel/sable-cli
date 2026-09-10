import type { ToolSpec } from '../providers/types.js';
import { ToolInputError } from '../util/errors.js';
import { validate } from './schema.js';
import type { Tool } from './types.js';

import { editFileTool } from './edit-file.js';
import { grepTool } from './grep.js';
import { listDirTool } from './list-dir.js';
import { readFileTool } from './read-file.js';
import { shellTool } from './shell.js';
import { writeFileTool } from './write-file.js';

export const BUILT_IN_TOOLS: Tool[] = [
  listDirTool,
  readFileTool,
  grepTool,
  editFileTool,
  writeFileTool,
  shellTool,
];

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[] = BUILT_IN_TOOLS) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Keep only tools that do not modify anything. Used by `--approval readonly`. */
  readOnly(): ToolRegistry {
    return new ToolRegistry(this.list().filter((tool) => tool.kind === 'read'));
  }

  /** The tool definitions sent to the model. */
  specs(): ToolSpec[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.schema as unknown as Record<string, unknown>,
    }));
  }

  /** Validate raw model-supplied input against the tool's schema. */
  validateInput(name: string, input: unknown): Record<string, unknown> {
    const tool = this.get(name);
    if (!tool) {
      throw new ToolInputError(
        `Unknown tool "${name}". Available tools: ${this.names().join(', ')}.`,
      );
    }
    return validate(tool.schema, input, name);
  }
}
