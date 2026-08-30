"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { AUTH_DIALOG } from "@/features/landing/copy";

/**
 * Every call to action on the landing page routes through here.
 *
 * **This is the single swap point for authentication.** When Phase 2 lands and
 * `/sign-in` and `/invite` exist, `AuthCta` becomes a `<Link>` — one file
 * changes and every CTA on the page goes live. Nothing else on the landing page
 * knows or cares how authentication works.
 *
 * Until then the buttons do something real rather than pretending: they explain
 * that KITH is invitation-only and that sign-in genuinely does not exist yet. A
 * button that looks live and silently does nothing is what makes a whole product
 * feel like a mockup.
 *
 * The dialog lives once, in the provider, rather than once per button. Six CTAs
 * rendering six identical modals into the DOM is the kind of thing that is
 * invisible until it is six of something more expensive.
 */

export type AuthIntent = keyof typeof AUTH_DIALOG;

interface AuthDialogApi {
  request: (intent: AuthIntent) => void;
}

const AuthDialogContext = createContext<AuthDialogApi | null>(null);

export function AuthDialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // Held through the exit transition so the panel does not blank out as it goes.
  const [intent, setIntent] = useState<AuthIntent>("request-invite");

  const request = useCallback((next: AuthIntent) => {
    setIntent(next);
    setOpen(true);
  }, []);

  const api = useMemo<AuthDialogApi>(() => ({ request }), [request]);
  const copy = AUTH_DIALOG[intent];

  return (
    <AuthDialogContext.Provider value={api}>
      {children}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={copy.title}
        description={copy.description}
        size="sm"
        footer={
          <Button variant="quiet" onClick={() => setOpen(false)}>
            Understood
          </Button>
        }
      >
        <p className="leading-body text-fg-dim">{copy.body}</p>
      </Dialog>
    </AuthDialogContext.Provider>
  );
}

export interface AuthCtaProps extends Omit<ButtonProps, "onClick" | "children"> {
  intent: AuthIntent;
  children: ReactNode;
}

export function AuthCta({ intent, children, ...props }: AuthCtaProps) {
  const context = useContext(AuthDialogContext);

  if (!context) {
    throw new Error("<AuthCta> must be rendered inside <AuthDialogProvider>.");
  }

  return (
    <Button data-auth-intent={intent} onClick={() => context.request(intent)} {...props}>
      {children}
    </Button>
  );
}
