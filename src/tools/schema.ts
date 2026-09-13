import { MALFORMED_JSON_KEY } from '../providers/tool-input.js';
import { ToolInputError } from '../util/errors.js';

export type PropertyType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';

export interface PropertySchema {
  type: PropertyType;
  description: string;
  enum?: readonly string[];
  items?: { type: 'string' | 'number' | 'boolean' | 'object' };
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

export function validate(
  schema: ObjectSchema,
  input: unknown,
  toolName: string,
): Record<string, unknown> {
  const source = asArgumentObject(input, toolName);
  rejectUnknownKeys(schema, source, toolName);

  const validated: Record<string, unknown> = {};

  for (const [key, property] of Object.entries(schema.properties)) {
    const value = source[key];
    const provided = key in source && value !== undefined && value !== null;

    if (!provided) {
      if (schema.required.includes(key)) {
        throw new ToolInputError(`${toolName}: missing required argument "${key}".`);
      }
      if (property.default !== undefined) validated[key] = property.default;
      continue;
    }

    validated[key] = coerce(toolName, key, property, value);
  }

  return validated;
}

function asArgumentObject(input: unknown, toolName: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ToolInputError(
      `${toolName}: expected an object of arguments, got ${describe(input)}.`,
    );
  }

  if (MALFORMED_JSON_KEY in input) {
    throw new ToolInputError(
      `${toolName}: arguments were not valid JSON. Re-issue the call with well-formed JSON.`,
    );
  }

  return input as Record<string, unknown>;
}

function rejectUnknownKeys(
  schema: ObjectSchema,
  source: Record<string, unknown>,
  toolName: string,
): void {
  const unknown = Object.keys(source).filter((key) => !(key in schema.properties));
  if (unknown.length === 0) return;

  throw new ToolInputError(
    `${toolName}: unknown argument(s) ${unknown.map((key) => `"${key}"`).join(', ')}. ` +
      `Accepted: ${Object.keys(schema.properties).join(', ')}.`,
  );
}

function coerce(toolName: string, key: string, property: PropertySchema, value: unknown): unknown {
  switch (property.type) {
    case 'string':
      return coerceString(toolName, key, property, value);
    case 'number':
    case 'integer':
      return coerceNumber(toolName, key, property, value);
    case 'boolean':
      return coerceBoolean(toolName, key, value);
    case 'array':
      return coerceArray(toolName, key, property, value);
    case 'object':
      return coerceObject(toolName, key, value);
  }
}

function coerceString(
  toolName: string,
  key: string,
  property: PropertySchema,
  value: unknown,
): string {
  if (typeof value !== 'string') throw typeError(toolName, key, 'a string', value);

  if (property.enum && !property.enum.includes(value)) {
    throw typeError(toolName, key, `one of: ${property.enum.join(', ')}`, value);
  }

  return value;
}

function coerceNumber(
  toolName: string,
  key: string,
  property: PropertySchema,
  value: unknown,
): number {
  const candidate = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

  if (typeof candidate !== 'number' || !Number.isFinite(candidate)) {
    throw typeError(toolName, key, 'a number', value);
  }
  if (property.type === 'integer' && !Number.isInteger(candidate)) {
    throw typeError(toolName, key, 'an integer', value);
  }
  if (property.minimum !== undefined && candidate < property.minimum) {
    throw typeError(toolName, key, `at least ${property.minimum}`, value);
  }
  if (property.maximum !== undefined && candidate > property.maximum) {
    throw typeError(toolName, key, `at most ${property.maximum}`, value);
  }

  return candidate;
}

function coerceBoolean(toolName: string, key: string, value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw typeError(toolName, key, 'a boolean', value);
}

function coerceArray(
  toolName: string,
  key: string,
  property: PropertySchema,
  value: unknown,
): unknown[] {
  if (!Array.isArray(value)) throw typeError(toolName, key, 'an array', value);

  const expected = property.items?.type;
  if (!expected) return value;

  for (const [index, item] of value.entries()) {
    const matches = expected === 'object' ? isPlainObject(item) : typeof item === expected;
    if (!matches) throw typeError(toolName, `${key}[${index}]`, `a ${expected}`, item);
  }

  return value;
}

function coerceObject(toolName: string, key: string, value: unknown): object {
  if (!isPlainObject(value)) throw typeError(toolName, key, 'an object', value);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeError(
  toolName: string,
  key: string,
  expected: string,
  value: unknown,
): ToolInputError {
  return new ToolInputError(
    `${toolName}: argument "${key}" must be ${expected}, got ${describe(value)}.`,
  );
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return `a string (${JSON.stringify(value.slice(0, 40))})`;
  return String(value);
}
