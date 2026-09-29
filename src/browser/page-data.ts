/**
 * Small, optional helpers for reading data from the current page inside a
 * browser step handler. Page data is untrusted input: return it as step
 * output and validate it downstream. Password fields are never read.
 */

/** Server default for the maximum accepted step output size (1 MiB). */
export const MAX_OUTPUT_BYTES = 1024 * 1024;

export class OutputTooLargeError extends Error {
  readonly retryable = false;
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(
      `step output is ${bytes} bytes of JSON, which exceeds the ${limit}-byte limit; ` +
        "return a smaller result (e.g. selected fields or a summary) instead of raw page content",
    );
    this.name = "OutputTooLargeError";
  }
}

/** UTF-8 byte length of `value` serialized as JSON (`undefined` counts as `{}`). */
export function jsonByteLength(value: unknown): number {
  const text = JSON.stringify(value === undefined ? {} : value);
  return new TextEncoder().encode(text ?? "null").length;
}

/** Throw `OutputTooLargeError` when `value` serializes to more than `limit` bytes. */
export function assertOutputSize(value: unknown, limit: number = MAX_OUTPUT_BYTES): void {
  const bytes = jsonByteLength(value);
  if (bytes > limit) throw new OutputTooLargeError(bytes, limit);
}

type Root = ParentNode;

function resolveElement<T extends Element>(target: string | T, root: Root = document): T | null {
  return typeof target === "string" ? root.querySelector<T>(target) : target;
}

export interface ReadFormOptions {
  /** Include `<input type="hidden">` values (often CSRF tokens). Default: false. */
  includeHidden?: boolean;
  root?: Root;
}

export type FormValues = Record<string, string | string[]>;

/**
 * Read a form's current values as plain JSON. Repeated names (checkbox groups,
 * multi-selects) become arrays. Password and file inputs are always skipped,
 * hidden inputs unless `includeHidden` is set.
 */
export function readForm(target: string | HTMLFormElement, options: ReadFormOptions = {}): FormValues {
  const form = resolveElement<HTMLFormElement>(target, options.root);
  if (!form) throw new Error(`readForm: no form matches ${typeof target === "string" ? target : "the element"}`);
  const values: FormValues = {};
  const add = (name: string, value: string) => {
    const existing = values[name];
    if (existing === undefined) values[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else values[name] = [existing, value];
  };
  for (const element of Array.from(form.elements)) {
    const field = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (!field.name || field.disabled) continue;
    if (field instanceof HTMLInputElement) {
      const type = field.type.toLowerCase();
      if (type === "password" || type === "file") continue;
      if (type === "hidden" && !options.includeHidden) continue;
      if (type === "submit" || type === "button" || type === "reset" || type === "image") continue;
      if ((type === "checkbox" || type === "radio") && !field.checked) continue;
      add(field.name, field.value);
    } else if (field instanceof HTMLSelectElement) {
      for (const option of Array.from(field.selectedOptions)) add(field.name, option.value);
    } else if (field instanceof HTMLTextAreaElement) {
      add(field.name, field.value);
    }
  }
  return values;
}

/** The user's current text selection, or `""`. */
export function readSelection(): string {
  return typeof getSelection === "function" ? (getSelection()?.toString() ?? "") : "";
}

/** Trimmed text content of the first element matching `selector`, or `null`. */
export function querySelectorText(selector: string, root: Root = document): string | null {
  const element = root.querySelector(selector);
  return element ? (element.textContent ?? "").trim() : null;
}

/** Trimmed text content of every element matching `selector`. */
export function querySelectorAllText(selector: string, root: Root = document): string[] {
  return Array.from(root.querySelectorAll(selector), (element) => (element.textContent ?? "").trim());
}
