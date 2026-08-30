"use client";

import { useRef, useState, useTransition } from "react";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { removeAvatarAction, setAvatarAction } from "@/features/profile/actions";
import { AVATAR_ACCEPT, AVATAR_MAX_BYTES, AVATAR_MAX_EDGE } from "@/features/profile/schema";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { BUCKETS } from "@/lib/supabase/storage";
import { cn } from "@/lib/utils/cn";

/**
 * Avatar upload.
 *
 * The file goes straight from the browser to Supabase Storage rather than
 * through a server action. Server actions serialise their arguments, so routing
 * a 2MB image through one means base64-ing it into a request body, buffering it
 * in a serverless function, and paying for the bandwidth twice. Storage exists
 * for exactly this, and its RLS policy already restricts the write to the
 * uploader's own folder — the server is not adding a check by being in the middle.
 *
 * The image is resized to 512px and re-encoded as WebP before it leaves the
 * page. A phone camera produces 4MB of JPEG for something that renders at 48px;
 * shrinking it client-side means the upload is fast, the bucket stays small, and
 * the 2MB limit is never something a normal user has to think about.
 */

/** Draws the image to a canvas at a bounded size and re-encodes it. */
async function resizeToWebp(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);

  try {
    const scale = Math.min(1, AVATAR_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");

    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.85),
    );

    if (!blob) throw new Error("Could not encode the image.");
    return blob;
  } finally {
    // Bitmaps hold decoded pixel data; a few unreleased ones is tens of megabytes.
    bitmap.close();
  }
}

export interface AvatarUploaderProps {
  name: string;
  userId: string;
  avatarUrl: string | null;
  hasAvatar: boolean;
}

export function AvatarUploader({ name, userId, avatarUrl, hasAvatar }: AvatarUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  async function upload(file: File) {
    setError(null);

    if (!AVATAR_ACCEPT.includes(file.type as (typeof AVATAR_ACCEPT)[number])) {
      setError("Use a JPEG, PNG or WebP image.");
      return;
    }

    let blob: Blob;
    try {
      blob = await resizeToWebp(file);
    } catch {
      setError("That image could not be read. Try a different one.");
      return;
    }

    if (blob.size > AVATAR_MAX_BYTES) {
      setError("That image is still too large after resizing.");
      return;
    }

    // A fresh filename every time rather than a fixed `avatar.webp`. Overwriting
    // one path means every cached and signed URL keeps serving the old picture
    // until it expires; a new name makes the change immediate. The previous
    // object is deleted by the server action once the new path is recorded.
    const path = `${userId}/${crypto.randomUUID()}.webp`;

    const supabase = getSupabaseBrowserClient();
    const { error: uploadError } = await supabase.storage
      .from(BUCKETS.avatars)
      .upload(path, blob, { contentType: "image/webp", upsert: false });

    if (uploadError) {
      setError("The upload did not go through. Try again.");
      return;
    }

    // Local preview so the new picture appears immediately, rather than waiting
    // for a revalidation round trip and a fresh signed URL.
    setPreview(URL.createObjectURL(blob));

    const formData = new FormData();
    formData.set("path", path);
    const result = await setAvatarAction({ status: "idle" }, formData);
    if (result.status === "error") setError(result.message);
  }

  return (
    <div className="flex items-center gap-5">
      <div className="relative">
        <Avatar name={name} size="xl" seed={userId} src={preview ?? avatarUrl} />
        {busy ? (
          <span className="absolute inset-0 grid place-items-center rounded-full bg-[color-mix(in_oklab,var(--ground)_65%,transparent)]">
            <Icon name="info" size={20} className="animate-pulse text-ember" />
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="quiet"
            size="sm"
            icon="plus"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {hasAvatar || preview ? "Replace" : "Upload a picture"}
          </Button>

          {hasAvatar || preview ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() =>
                startTransition(async () => {
                  setPreview(null);
                  const result = await removeAvatarAction({ status: "idle" }, new FormData());
                  if (result.status === "error") setError(result.message);
                })
              }
            >
              Remove
            </Button>
          ) : null}
        </div>

        <p className={cn("text-xs", error ? "text-signal" : "text-fg-faint")}>
          {error ?? "JPEG, PNG or WebP. Resized to 512px in your browser before it uploads."}
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={AVATAR_ACCEPT.join(",")}
        className="sr-only"
        aria-label="Choose a profile picture"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset so choosing the same file twice fires change again.
          event.target.value = "";
          if (file) startTransition(() => void upload(file));
        }}
      />
    </div>
  );
}
