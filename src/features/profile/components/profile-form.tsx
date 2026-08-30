"use client";

import { useActionState, useState } from "react";

import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { PresenceEmber } from "@/components/ui/presence-ember";
import { FormBanner, FormFields, SubmitButton } from "@/features/auth/components/auth-form";
import { fieldError } from "@/features/auth/components/field-error";
import { idleFormState } from "@/features/auth/schema";
import { updateProfileAction } from "@/features/profile/actions";
import { AvatarUploader } from "@/features/profile/components/avatar-uploader";
import { ACCENTS, STATUSES, type Accent, type ProfileStatus } from "@/features/profile/schema";
import type { ProfileView } from "@/features/profile/queries";
import { cn } from "@/lib/utils/cn";

const STATUS_COPY: Record<ProfileStatus, { label: string; note: string }> = {
  auto: { label: "Automatic", note: "Lit when you are here, cooling when you drift off." },
  active: { label: "Active", note: "Say you are around." },
  away: { label: "Away", note: "Here, but not really." },
  busy: { label: "Busy", note: "Around, but do not expect a reply." },
  invisible: { label: "Invisible", note: "Nobody sees you as online. Ever." },
};

const ACCENT_LABEL: Record<Accent, string> = {
  ember: "Ember",
  lantern: "Lantern",
  moss: "Moss",
  signal: "Signal",
  plum: "Plum",
  ice: "Ice",
};

export function ProfileForm({ profile }: { profile: ProfileView }) {
  const [state, formAction] = useActionState(updateProfileAction, idleFormState);
  const [bio, setBio] = useState(profile.bio ?? "");
  const [status, setStatus] = useState<ProfileStatus>(profile.status as ProfileStatus);
  const [accent, setAccent] = useState<Accent>(profile.accent as Accent);

  const [year, month, day] = (profile.birthday ?? "").split("-");

  return (
    <>
      <FormBanner state={state} />

      <form action={formAction} noValidate className="flex flex-col gap-10">
        <section className="flex flex-col gap-5">
          <h2 className="label text-fg-faint">Picture</h2>
          <AvatarUploader
            name={profile.display_name}
            userId={profile.id}
            avatarUrl={profile.avatarUrl}
            hasAvatar={Boolean(profile.avatar_path)}
          />
        </section>

        <FormFields>
          <section className="flex flex-col gap-5">
            <h2 className="label text-fg-faint">Who you are</h2>

            <Field label="Display name" error={fieldError(state, "displayName")}>
              {(props) => (
                <Input
                  {...props}
                  name="displayName"
                  defaultValue={profile.display_name}
                  maxLength={40}
                  required
                />
              )}
            </Field>

            <Field
              label="Username"
              hint="Letters, numbers and underscores. Changeable once every 30 days."
              error={fieldError(state, "username")}
            >
              {(props) => (
                <Input
                  {...props}
                  name="username"
                  defaultValue={profile.username}
                  spellCheck={false}
                  minLength={3}
                  maxLength={20}
                  required
                />
              )}
            </Field>

            <Field
              label="Pronouns"
              hint="Optional. Shown next to your name."
              error={fieldError(state, "pronouns")}
            >
              {(props) => (
                <Input
                  {...props}
                  name="pronouns"
                  defaultValue={profile.pronouns ?? ""}
                  placeholder="they/them"
                  maxLength={24}
                />
              )}
            </Field>

            <Field label="Bio" hint={`${bio.length}/280`} error={fieldError(state, "bio")}>
              {(props) => (
                <Textarea
                  {...props}
                  name="bio"
                  value={bio}
                  onChange={(event) => setBio(event.target.value)}
                  maxLength={280}
                  rows={3}
                  placeholder="Two lines, tops."
                />
              )}
            </Field>

            <fieldset className="flex flex-col gap-1.5">
              <legend className="label mb-1.5 text-fg-dim">Birthday</legend>
              <p className="mb-1 text-xs text-fg-faint">
                Optional. Your people see the day and month, never the year.
              </p>
              <div className="flex gap-2">
                <Input
                  name="birthdayDay"
                  defaultValue={day ?? ""}
                  inputMode="numeric"
                  placeholder="DD"
                  aria-label="Day"
                  className="w-20 text-center"
                />
                <Input
                  name="birthdayMonth"
                  defaultValue={month ?? ""}
                  inputMode="numeric"
                  placeholder="MM"
                  aria-label="Month"
                  className="w-20 text-center"
                />
                <Input
                  name="birthdayYear"
                  defaultValue={year ?? ""}
                  inputMode="numeric"
                  placeholder="YYYY"
                  aria-label="Year"
                  className="w-24 text-center"
                />
              </div>
              {fieldError(state, "birthday") ? (
                <p className="text-xs text-signal">{fieldError(state, "birthday")}</p>
              ) : null}
            </fieldset>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="label text-fg-faint">Status</h2>

            {/* A radio group rather than a select: five options, each needing a
                line of explanation, and "Invisible" in particular deserves to be
                read before it is chosen. */}
            <div role="radiogroup" aria-label="Status" className="flex flex-col gap-1.5">
              {STATUSES.map((value) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-soft border px-3.5 py-3",
                    "transition-colors duration-[var(--t-quick)]",
                    status === value
                      ? "border-ember bg-[var(--wash-accent)]"
                      : "border-line hover:border-line-lit hover:bg-[var(--wash-hover)]",
                  )}
                >
                  <input
                    type="radio"
                    name="status"
                    value={value}
                    checked={status === value}
                    onChange={() => setStatus(value)}
                    className="control-focus mt-1 size-3.5 accent-[var(--ember)]"
                  />
                  <span className="flex flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2 text-sm text-fg-loud">
                      {STATUS_COPY[value].label}
                      {value === "invisible" ? null : (
                        <PresenceEmber
                          state={value === "auto" || value === "active" ? "lit" : "cooling"}
                          size="sm"
                        />
                      )}
                    </span>
                    <span className="text-xs text-fg-dim">{STATUS_COPY[value].note}</span>
                  </span>
                </label>
              ))}
            </div>

            <Field
              label="Status message"
              hint="Optional. A line under your name."
              error={fieldError(state, "statusText")}
            >
              {(props) => (
                <Input
                  {...props}
                  name="statusText"
                  defaultValue={profile.status_text ?? ""}
                  maxLength={60}
                  placeholder="Deep in a spreadsheet"
                />
              )}
            </Field>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="label text-fg-faint">Your colour</h2>
            <p className="-mt-2 text-xs text-fg-faint">
              Used for your initials and the light beside your name.
            </p>

            <div role="radiogroup" aria-label="Accent colour" className="flex flex-wrap gap-2">
              {ACCENTS.map((value) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-full border py-1.5 pr-3 pl-2",
                    "text-xs transition-colors duration-[var(--t-quick)]",
                    accent === value
                      ? "border-line-lit bg-raised text-fg-loud"
                      : "border-line text-fg-dim hover:border-line-lit",
                  )}
                >
                  <input
                    type="radio"
                    name="accent"
                    value={value}
                    checked={accent === value}
                    onChange={() => setAccent(value)}
                    className="sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className="size-4 rounded-full"
                    style={{ background: `var(--${value})` }}
                  />
                  {ACCENT_LABEL[value]}
                </label>
              ))}
            </div>
          </section>

          <div className="flex justify-start">
            <SubmitButton idleLabel="Save changes" />
          </div>
        </FormFields>
      </form>
    </>
  );
}
