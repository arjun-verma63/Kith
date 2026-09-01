import type Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { ButtonLink, type ButtonLinkProps } from "@/components/ui/button";

/**
 * Every call to action on the landing page routes through here.
 *
 * Until authentication existed these opened a dialog explaining that it did not.
 * Now they are links to the real thing — which was always the plan, and is why
 * the swap was one file. `typedRoutes` checks the hrefs at build time, so
 * renaming a route breaks the build rather than the page.
 */

/*
 * A server component. There is nothing client about either export — the CTA is a
 * link with a lookup table, and the provider below has been a pass-through since
 * the dialog it owned was replaced by navigation.
 */
export type AuthIntent = "sign-in" | "request-invite";

const HREF: Record<AuthIntent, ComponentProps<typeof Link>["href"]> = {
  "sign-in": "/login",
  "request-invite": "/signup",
};

export type AuthCtaProps = Omit<ButtonLinkProps<string>, "href" | "children"> & {
  intent: AuthIntent;
  children: ReactNode;
};

export function AuthCta({ intent, children, ...props }: AuthCtaProps) {
  return (
    <ButtonLink href={HREF[intent]} data-auth-intent={intent} {...props}>
      {children}
    </ButtonLink>
  );
}

/**
 * Kept as a pass-through so the landing page composition does not change shape.
 * The dialog it used to own is gone: the CTAs navigate now.
 */
export function AuthDialogProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
