"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Mode } from "@/lib/verdict";

/**
 * The slide-out panel and the controls that live in it.
 *
 * Shared because the same two settings decide what every verdict says, and a
 * setting reachable from only one screen is a setting nobody finds — the mode
 * used to live behind a chip on an item page, which is exactly the wrong place
 * to go looking for why a list is empty.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-20 bg-black/50" onClick={onClose} aria-hidden />
      )}
      <aside
        // Always rendered and translated off-screen so it slides rather than
        // appears; inert while shut keeps it out of the tab order too.
        inert={!open}
        aria-label={title}
        className={`border-circuit-border bg-ground-iron fixed top-0 right-0 z-30 h-full w-full max-w-[24rem] overflow-y-auto border-l p-24 transition-transform duration-200 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between gap-16">
          <h2 className="text-subheading tracking-subheading">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-body-sm text-fern-link hover:text-phosphor-white cursor-pointer"
          >
            close
          </button>
        </div>
        {children}
      </aside>
    </>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-24">
      <p className="text-caption tracking-caption text-deep-fern mb-8 uppercase">
        {label}
      </p>
      {children}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  disabled,
  onChange,
}: {
  value: T;
  options: [T, string][];
  disabled: boolean;
  onChange: (next: T) => void;
}) {
  return (
    <div className="border-circuit-border bg-void-black flex rounded-xl border p-4">
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          disabled={disabled}
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={`text-body-sm tracking-body-sm flex-1 rounded-lg px-12 py-8 font-medium transition-colors duration-150 ${
            value === id
              ? "bg-lime-pulse text-void-black"
              : "text-sage-60 hover:bg-carbon-veil hover:text-phosphor-white cursor-pointer"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** POSTs a settings change and refreshes whatever is on screen. */
export function useVerdictPost() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const post = (body: Record<string, unknown>) =>
    startTransition(async () => {
      await fetch("/api/verdict", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      router.refresh();
    });
  return { post, pending };
}

/**
 * The two global settings: whether verdicts are computed at all, and the bar
 * they have to clear.
 */
export function VerdictSettings({
  mode,
  thresholdPercent,
}: {
  mode: Mode;
  thresholdPercent: number;
}) {
  const { post, pending } = useVerdictPost();
  const [threshold, setThreshold] = useState(String(thresholdPercent));

  return (
    <>
      <Field label="verdict">
        <Segmented<Mode>
          value={mode}
          options={[
            ["automatic", "Automatic"],
            ["manual", "Manual"],
          ]}
          disabled={pending}
          onChange={(next) => post({ mode: next })}
        />
      </Field>
      <p className="text-body-sm tracking-body-sm text-deep-fern mt-8">
        {mode === "automatic"
          ? "Every item is judged by the threshold below. Anything you mark yourself still wins."
          : "Nothing is judged for you — only the items you mark carry a verdict, so the worth-breaking list stays empty until you switch to Automatic."}
      </p>

      {mode === "automatic" && (
        <Field label="mark as worth over">
          <span className="text-body-sm tracking-body-sm text-sage-40 flex items-center gap-8">
            <input
              type="number"
              inputMode="decimal"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              onBlur={() => {
                const v = Number.parseFloat(threshold.replace(",", "."));
                if (Number.isFinite(v) && v !== thresholdPercent) {
                  post({ thresholdPercent: v });
                }
              }}
              aria-label="worth-breaking threshold, percent"
              className="border-circuit-border focus:border-lime-pulse text-body-sm text-phosphor-white w-64 border-0 border-b bg-transparent px-0 py-4 text-right tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            % profit
          </span>
        </Field>
      )}
    </>
  );
}

/** The settings drawer on its own, for pages with no single item to mark. */
export function SettingsButton({
  mode,
  thresholdPercent,
}: {
  mode: Mode;
  thresholdPercent: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        className="text-caption tracking-caption text-fern-link hover:text-lime-pulse cursor-pointer uppercase"
      >
        settings
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Worth breaking?">
        <VerdictSettings mode={mode} thresholdPercent={thresholdPercent} />
      </Drawer>
    </>
  );
}
