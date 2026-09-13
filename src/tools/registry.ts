import type { ToolSpec } from '../providers/types.js';
import { ToolInputError } from '../util/errors.js';
import { validate } from './schema.js';
import type { Tool, ToolKind } from './types.js';

import { editFileTool } from './edit-file.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { listDirTool } from './list-dir.js';
import { multiEditTool } from './multi-edit.js';
import { readFileTool } from './read-file.js';
import { shellTool } from './shell.js';
import { writeFileTool } from './write-file.js';

export const BUILT_IN_TOOLS: Tool[] = [
  listDirTool,
  globTool,
  readFileTool,
  grepTool,
  editFileTool,
  multiEditTool,
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

  ofKind(kind: ToolKind): Tool[] {
    return this.list().filter((tool) => tool.kind === kind);
  }

  readOnly(): ToolRegistry {
    return new ToolRegistry(this.ofKind('read'));
  }

  specs(): ToolSpec[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.schema as unknown as Record<string, unknown>,
    }));
  }

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
