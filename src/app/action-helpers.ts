import { redirect } from "next/navigation";

import { DomainError } from "@/domain/errors";



export function text(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function verbatimText(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

export function optional(form: FormData, key: string) {
  const value = text(form, key);
  return value || undefined;
}

export function errorMessage(error: unknown) {
  return error instanceof DomainError ? error.message : "Something went wrong. Please try again.";
}

export function fail(path: string, error: unknown): never {
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(errorMessage(error))}`);
}
