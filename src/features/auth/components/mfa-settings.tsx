"use client";

import { useActionState, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { FormBanner, FormFields, SubmitButton } from "@/components/ui/form";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { MAX_FACTORS, TOTP_DIGITS, type MfaState } from "@/features/auth/mfa";
import {
  beginEnrollmentAction,
  cancelEnrollmentAction,
  confirmEnrollmentAction,
  removeFactorAction,
  type EnrollmentStart,
} from "@/features/auth/mfa-actions";
import { fieldError, idleFormState } from "@/lib/forms";

/**
 * Settings → Security → two-factor authentication.
 *
 * ── What is on screen and what is deliberately not ───────────────────────────
 *
 * The QR code is an SVG data URI rendered by Supabase Auth. We do not draw it,
 * and there is no QR library in this project — a client-side QR renderer would
 * mean the secret being handled by our code on its way to a canvas, which is a
 * worse place for it than the one it is already in.
 *
 * The secret is shown in text as well, because a phone with a broken camera is a
 * real thing and typing it in is the documented fallback in every authenticator
 * app. It is shown once, during setup, and is never fetched again: after
 * enrolment finishes there is no endpoint in KITH that can return it, because
 * Supabase does not expose one and we did not keep a copy.
 *
 * ── Why removal asks for a code ──────────────────────────────────────────────
 *
 * The session is already at aal2 by the time this page is reachable, so the
 * check is not about proving identity again from scratch. It is about the window
 * an aal2 session leaves open — it lasts as long as the token does, and this is
 * the one action that makes every future sign-in easier. Six digits closes it.
 */

export function MfaSettings({ status }: { status: MfaState }) {
  const [enrollment, setEnrollment] = useState<EnrollmentStart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const start = () => {
    setError(null);
    startTransition(async () => {
      const result = await beginEnrollmentAction();
      if (result.ok) setEnrollment(result.enrollment);
      else setError(result.reason);
    });
  };

  const cancel = (factorId: string) => {
    setEnrollment(null);
    startTransition(async () => {
      await cancelEnrollmentAction(factorId);
    });
  };

  return (
    <Panel tone="flat" padding="none" className="rounded-soft">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <span className="label text-fg-faint">Two-factor authentication</span>
        {status.enabled ? (
          <Badge tone="moss" caps>
            On
          </Badge>
        ) : (
          <Badge caps>Off</Badge>
        )}
      </header>

      <div className="flex flex-col gap-4 p-4">
        {status.enabled ? (
          <FactorList
            factors={status.factors}
            canEnroll={status.canEnroll}
            onAdd={start}
            pending={pending}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="max-w-prose text-sm leading-body text-fg-dim">
              You will be asked for a {TOTP_DIGITS}-digit code from an authenticator app each time
              you sign in. Google Authenticator, 1Password, Bitwarden, Aegis — any of them work, and
              none of them need a phone signal.
            </p>
            <div>
              <Button variant="lit" size="sm" loading={pending} onClick={start}>
                Enable 2FA
              </Button>
            </div>
          </div>
        )}

        {error ? (
          <p role="status" className="text-sm text-signal">
            {error}
          </p>
        ) : null}

        <RecoveryNote enabled={status.enabled} factorCount={status.factors.length} />
      </div>

      {enrollment ? (
        <EnrollDialog
          enrollment={enrollment}
          onCancel={() => cancel(enrollment.factorId)}
          onDone={() => setEnrollment(null)}
        />
      ) : null}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

function FactorList({
  factors,
  canEnroll,
  onAdd,
  pending,
}: {
  factors: MfaState["factors"];
  canEnroll: boolean;
  onAdd: () => void;
  pending: boolean;
}) {
  const [removing, setRemoving] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {factors.map((factor) => (
          <li
            key={factor.id}
            className="flex items-center gap-3 rounded-inset border border-line px-3 py-2.5"
          >
            <span
              aria-hidden="true"
              className="grid size-7 shrink-0 place-items-center rounded-full bg-[color-mix(in_oklab,var(--moss)_14%,transparent)] text-moss"
            >
              <Icon name="shield" size={14} />
            </span>

            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-fg-loud">
                {factor.friendlyName ?? "Authenticator"}
              </span>
              <span className="text-2xs text-fg-faint">
                Added{" "}
                {new Date(factor.createdAt).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </span>
            </span>

            <Button variant="ghost" size="sm" onClick={() => setRemoving(factor.id)}>
              {factors.length === 1 ? "Disable" : "Remove"}
            </Button>
          </li>
        ))}
      </ul>

      {canEnroll ? (
        <div>
          <Button variant="quiet" size="sm" loading={pending} onClick={onAdd}>
            Add another device
          </Button>
        </div>
      ) : (
        <p className="text-2xs text-fg-faint">
          {MAX_FACTORS} authenticators is the limit. Remove one to add another.
        </p>
      )}

      {removing ? (
        <RemoveDialog
          factorId={removing}
          last={factors.length === 1}
          name={factors.find((f) => f.id === removing)?.friendlyName ?? "this authenticator"}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function EnrollDialog({
  enrollment,
  onCancel,
  onDone,
}: {
  enrollment: EnrollmentStart;
  /** Backing out before the first code — the half-made factor is thrown away. */
  onCancel: () => void;
  /** Closing after it worked. There is nothing to clean up. */
  onDone: () => void;
}) {
  const [state, formAction] = useActionState(confirmEnrollmentAction, idleFormState);
  const [showSecret, setShowSecret] = useState(false);

  const done = state.status === "success";

  return (
    <Dialog
      open
      onClose={done ? onDone : onCancel}
      title="Set up two-factor"
      {...(done
        ? {}
        : { description: "Scan this with your authenticator app, then type the code it shows." })}
      size="sm"
      dismissible={!done}
      footer={
        done ? (
          <Button variant="lit" size="sm" onClick={onDone}>
            Done
          </Button>
        ) : undefined
      }
    >
      <FormBanner state={state} />

      {done ? null : (
        <div className="flex flex-col gap-4">
          {/* Rendered by Supabase Auth as an SVG data URI. Not next/image: the
              source is a data URI with no remote host to optimise, and running
              it through the image pipeline would only add a proxy. */}
          <div className="flex justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={enrollment.qrCode}
              alt="QR code for your authenticator app"
              width={180}
              height={180}
              className="bg-white rounded-inset border border-line p-2"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => setShowSecret((value) => !value)}
              className="control-focus self-start rounded-edge text-2xs text-fg-faint underline underline-offset-2 hover:text-fg-dim"
            >
              {showSecret ? "Hide the setup key" : "No camera? Enter a key instead"}
            </button>

            {showSecret ? (
              <code className="numeric block rounded-inset border border-line bg-sunken px-3 py-2 text-2xs break-all text-fg">
                {enrollment.secret}
              </code>
            ) : null}
          </div>

          <form action={formAction}>
            <input type="hidden" name="factorId" value={enrollment.factorId} />

            <FormFields>
              <Field label="Code from your app" error={fieldError(state, "code")}>
                {(props) => (
                  <Input
                    {...props}
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="000000"
                    maxLength={TOTP_DIGITS + 2}
                    required
                    autoFocus
                    className="numeric tracking-[0.3em]"
                  />
                )}
              </Field>

              <SubmitButton idleLabel="Turn it on" />
            </FormFields>
          </form>
        </div>
      )}
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */

function RemoveDialog({
  factorId,
  last,
  name,
  onClose,
}: {
  factorId: string;
  last: boolean;
  name: string;
  onClose: () => void;
}) {
  const [state, formAction] = useActionState(removeFactorAction, idleFormState);
  const done = state.status === "success";

  return (
    <Dialog
      open
      onClose={onClose}
      title={last ? "Turn off two-factor" : "Remove an authenticator"}
      {...(done
        ? {}
        : {
            description: last
              ? "Your password will be the only thing protecting this account."
              : `Removing ${name}. Enter a code from any authenticator you still have.`,
          })}
      size="sm"
      footer={
        done ? (
          <Button variant="lit" size="sm" onClick={onClose}>
            Done
          </Button>
        ) : undefined
      }
    >
      <FormBanner state={state} />

      {done ? null : (
        <form action={formAction}>
          <input type="hidden" name="factorId" value={factorId} />

          <FormFields>
            <Field label="Current code" error={fieldError(state, "code")}>
              {(props) => (
                <Input
                  {...props}
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  maxLength={TOTP_DIGITS + 2}
                  required
                  autoFocus
                  className="numeric tracking-[0.3em]"
                />
              )}
            </Field>

            <SubmitButton idleLabel={last ? "Turn it off" : "Remove it"} />
          </FormFields>
        </form>
      )}
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The honest paragraph.
 *
 * TOTP has no "forgot my phone" link and cannot have one: the server would need
 * to be able to produce a code on your behalf, which is precisely the thing the
 * scheme exists to prevent. Recovery codes are the usual answer and Supabase
 * Auth does not issue them, so the answer here is a second device — and saying
 * so plainly, before the phone is lost rather than after.
 */
function RecoveryNote({ enabled, factorCount }: { enabled: boolean; factorCount: number }) {
  if (!enabled) return null;

  return (
    <p className="max-w-prose rounded-inset border border-line bg-sunken px-3 py-2.5 text-2xs leading-body text-fg-dim">
      {factorCount === 1 ? (
        <>
          <span className="text-fg-loud">Add a second device.</span> If you lose this one, there is
          no code we can send you — that is the point of the scheme. A second authenticator on a
          tablet or a desktop app is the only way back in that does not involve asking whoever runs
          this KITH to remove your factor by hand.
        </>
      ) : (
        <>
          You have {factorCount} authenticators. Losing one is inconvenient; losing all of them
          means asking whoever runs this KITH to remove them for you.
        </>
      )}
    </p>
  );
}
