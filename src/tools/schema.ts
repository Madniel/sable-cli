import { ToolInputError } from '../util/errors.js';

/**
 * A deliberately small JSON Schema subset: enough to describe tool inputs for a
 * model and to validate what comes back, without pulling in a dependency.
 */

export interface PropertySchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: readonly string[];
  items?: { type: 'string' | 'number' | 'boolean' };
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

export interface ObjectSchema {
  type: 'object';
  properties: Record<string, PropertySchema>;
  required: string[];
  additionalProperties: false;
}

export function objectSchema(
  properties: Record<string, PropertySchema>,
  required: string[] = [],
): ObjectSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * Validate `input` against `schema`, applying declared defaults.
 * Throws `ToolInputError` with a message aimed at the model, not the user.
 */
export function validate(
  schema: ObjectSchema,
  input: unknown,
  toolName: string,
): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ToolInputError(
      `${toolName}: expected an object of arguments, got ${describe(input)}.`,
    );
  }

  const source = input as Record<string, unknown>;

  if ('__malformed_json__' in source) {
    throw new ToolInputError(
      `${toolName}: arguments were not valid JSON. Re-issue the call with well-formed JSON.`,
    );
  }

  const unknownKeys = Object.keys(source).filter((key) => !(key in schema.properties));
  if (unknownKeys.length > 0) {
    throw new ToolInputError(
      `${toolName}: unknown argument(s) ${unknownKeys.map((k) => `"${k}"`).join(', ')}. ` +
        `Accepted: ${Object.keys(schema.properties).join(', ')}.`,
    );
  }

  const out: Record<string, unknown> = {};

  for (const [key, property] of Object.entries(schema.properties)) {
    const present = key in source && source[key] !== undefined && source[key] !== null;

    if (!present) {
      if (schema.required.includes(key)) {
        throw new ToolInputError(`${toolName}: missing required argument "${key}".`);
      }
      if (property.default !== undefined) out[key] = property.default;
      continue;
    }

    out[key] = coerce(toolName, key, property, source[key]);
  }

  return out;
}

function coerce(toolName: string, key: string, property: PropertySchema, value: unknown): unknown {
  const fail = (expected: string): never => {
    throw new ToolInputError(
      `${toolName}: argument "${key}" must be ${expected}, got ${describe(value)}.`,
    );
  };

  switch (property.type) {
    case 'string': {
      if (typeof value !== 'string') fail('a string');
      const text = value as string;
      if (property.enum && !property.enum.includes(text)) {
        fail(`one of: ${property.enum.join(', ')}`);
      }
      return text;
    }

    case 'number':
    case 'integer': {
      // Models sometimes send numbers as strings; accept that rather than burning a turn.
      const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof num !== 'number' || !Number.isFinite(num)) fail('a number');
      const numeric = num as number;
      if (property.type === 'integer' && !Number.isInteger(numeric)) fail('an integer');
      if (property.minimum !== undefined && numeric < property.minimum) {
        fail(`at least ${property.minimum}`);
      }
      if (property.maximum !== undefined && numeric > property.maximum) {
        fail(`at most ${property.maximum}`);
      }
      return numeric;
    }

    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return fail('a boolean');
    }

    case 'array': {
      if (!Array.isArray(value)) fail('an array');
      const items = value as unknown[];
      const itemType = property.items?.type;
      if (itemType) {
        for (const [index, item] of items.entries()) {
          if (typeof item !== itemType) {
            throw new ToolInputError(
              `${toolName}: argument "${key}[${index}]" must be a ${itemType}, got ${describe(item)}.`,
            );
          }
        }
      }
      return items;
    }

    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('an object');
      return value;
    }
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return `a string (${JSON.stringify(value.slice(0, 40))})`;
  return String(value);
}
