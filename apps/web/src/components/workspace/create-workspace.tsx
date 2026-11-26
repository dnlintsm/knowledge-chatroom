"use client";

import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { STARTING_LEVELS, isSlug, slugify, SLUG_MAX, type StartingLevels } from "@/lib/workspace-choice";
import type { WorkspaceInfo } from "@/lib/workspace-request";

/**
 * Creating a workspace (docs/workspaces.md, "Screens"): its name,
 * its address (made from the name until the user edits it) and the knowledge
 * levels it starts with. The API server makes the user its Owner.
 */
export function CreateWorkspaceForm({
  onCreated,
  onCancel,
}: {
  onCreated: (workspace: WorkspaceInfo) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [levels, setLevels] = useState<StartingLevels>("standard");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: "name" | "slug" | null; message: string } | null>(null);
  const ids = useId();
  const nameInput = useRef<HTMLInputElement>(null);

  useEffect(() => nameInput.current?.focus(), []);

  const address = slugEdited ? slug : slugify(name);
  const slugProblem =
    address && !isSlug(address)
      ? `Use lower-case letters, digits and single dashes, at most ${SLUG_MAX} characters.`
      : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.replace(/\s+/g, " ").trim();
    if (!trimmed) {
      setError({ field: "name", message: "Give the workspace a name." });
      return;
    }
    if (slugProblem) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Without an address the server makes one from the name, numbered when taken.
        body: JSON.stringify({ name: trimmed, ...(address ? { slug: address } : {}), levels: STARTING_LEVELS[levels] }),
      });
      const body = (await res.json().catch(() => null)) as (WorkspaceInfo & { error?: string }) | null;
      if (res.status === 201 && body?.slug) {
        onCreated(body);
        return;
      }
      setError({
        field: res.status === 409 ? "slug" : null,
        message:
          res.status === 409
            ? "Another workspace already has this address. Choose another."
            : (body?.error ?? `Couldn't create the workspace (${res.status}).`),
      });
    } catch {
      setError({ field: null, message: "Couldn't reach the server. Try again." });
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit} aria-label="Create a workspace" className="flex flex-col gap-4 text-sm" noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-name`} className="font-medium">
          Name
        </label>
        <Input
          ref={nameInput}
          id={`${ids}-name`}
          value={name}
          maxLength={200}
          placeholder="e.g. Etch research"
          aria-invalid={error?.field === "name" || undefined}
          onChange={(e) => setName(e.target.value)}
        />
        {error?.field === "name" && <p className="text-xs text-red-500">{error.message}</p>}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-slug`} className="font-medium">
          Address
        </label>
        <div className="flex items-center gap-1">
          <span className="text-[var(--muted-foreground)]">/w/</span>
          <Input
            id={`${ids}-slug`}
            value={address}
            maxLength={SLUG_MAX}
            placeholder={slugify(name) || "made-from-the-name"}
            aria-invalid={Boolean(slugProblem) || error?.field === "slug" || undefined}
            aria-describedby={`${ids}-slug-hint`}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value.toLowerCase());
              if (error?.field === "slug") setError(null);
            }}
          />
        </div>
        <p id={`${ids}-slug-hint`} className={slugProblem || error?.field === "slug" ? "text-xs text-red-500" : "text-xs text-[var(--muted-foreground)]"}>
          {slugProblem ?? (error?.field === "slug" ? error.message : "Made from the name; you can change it.")}
        </p>
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 font-medium">Starting levels</legend>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name={`${ids}-levels`}
            checked={levels === "standard"}
            onChange={() => setLevels("standard")}
            className="mt-1"
          />
          <span>
            Tech, module, loop, process
            <span className="block text-xs text-[var(--muted-foreground)]">The knowledge levels this app is built around.</span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name={`${ids}-levels`}
            checked={levels === "empty"}
            onChange={() => setLevels("empty")}
            className="mt-1"
          />
          <span>
            Empty
            <span className="block text-xs text-[var(--muted-foreground)]">No levels: files and experiments at the workspace root only.</span>
          </span>
        </label>
      </fieldset>
      {error && error.field === null && (
        <p role="alert" className="text-xs text-red-500">
          {error.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button type="submit" size="sm" disabled={busy || Boolean(slugProblem)}>
          {busy ? "Creating…" : "Create workspace"}
        </Button>
      </div>
    </form>
  );
}

/** The create form in a dialog, from the workspace switcher. */
export function CreateWorkspaceDialog({
  onCreated,
  onClose,
}: {
  onCreated: (workspace: WorkspaceInfo) => void;
  onClose: () => void;
}) {
  return (
    <Dialog label="Create a workspace" onClose={onClose}>
      <CreateWorkspaceForm onCreated={onCreated} onCancel={onClose} />
    </Dialog>
  );
}

/** A small modal dialog: closes on Escape, the close button or a click outside. */
export function Dialog({
  label,
  onClose,
  wide = false,
  children,
}: {
  label: string;
  onClose: () => void;
  /** A wider box, for a dialog that lists things. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null;
    if (!box.current?.contains(focused)) box.current?.focus();
    return () => focused?.focus?.();
  }, []);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className={`w-full ${wide ? "max-w-xl" : "max-w-md"} rounded-lg border border-[var(--border)] bg-[var(--background)] p-4 text-[var(--foreground)] max-h-[80vh] overflow-y-auto shadow-xl outline-none`}
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{label}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-6 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--secondary)] cursor-pointer"
          >
            <X className="size-4" />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
