# Performance audit

Measured 2 September 2026, on the production build. Three things were changed.
Most of the checklist was audited and found already correct, and that half is
written down too — an audit that only records what it changed reads as if
everything else was never looked at.

---

## 1. A method error, first

I began by measuring `.next/static/chunks/` and concluded that **zod (277 kB) was
shipping to every signed-in route**. It is not.

That directory holds chunks for the RSC and server-action graphs as well as the
browser bundle, and `page_client-reference-manifest.js` lists every module in the
reference graph — including the server half. Zod appears in **no route's
`entryJSFiles` and not in `build-manifest.json`**, which is what a browser
actually downloads.

Worth recording because the wrong reading would have led to a real refactor —
splitting six modules into "vocabulary" and "schema" halves — to fix nothing. The
right question is _"is this chunk in an entry?"_, not _"is this chunk on disk?"_

Turbopack had already tree-shaken the schemas out of the client copies: the
vocabulary chunks that carry `REASON_LABELS` and `NOTIFICATION_KINDS` contain no
zod symbols at all.

---

## 2. What was measured

|                                              | raw                                                   |
| -------------------------------------------- | ----------------------------------------------------- |
| Shared baseline, every page                  | **428 kB** (react-dom 229, framework 162, runtime 37) |
| Landing page, route JS                       | **230 kB** (was 240)                                  |
| Signed-in routes, route JS                   | ~670–734 kB                                           |
| Polyfills (`nomodule`, legacy browsers only) | 110 kB                                                |

The signed-in routes barely differ from each other, which means almost all of
that 670 kB is the shared `(app)` layout rather than any page — the presence
provider, the call provider and the notification bell, each of which needs the
Supabase realtime client (248 kB).

Gzipped, the baseline is roughly 135 kB and a signed-in route roughly 190 kB more.
For a six-person app whose assets are content-hashed and cached immutably by the
service worker, that is a first-visit cost and close to nothing thereafter.

---

## 3. Changed

### Seven avatar signers became one

The finding with the most round trips behind it.

Seven feature modules each had a private copy of `signAvatars`. Every copy
batched correctly — `createSignedUrls` takes a set, so none was an N+1 on its own
— but none of them could see the others. One render of a conversation made a
**separate call to Supabase Storage for each**:

```
the shell   listFriends · listNotifications · getOwnProfile
            getActiveCall · getMyCouple
the page    listMessages · listConversationMembers
```

Five to seven sequential calls, mostly to sign the same six people, because the
room appears in the friends list, in the notification feed and as the senders of
the messages.

Now one implementation with a request-scoped path→URL map (`cache()` with no
arguments returns the same value for one request). The friends list pays for the
six people; the thread that follows pays for nothing.

Two of the seven were found not by reading but by the invariant in
`perf.test.mjs` — they signed inline mid-query rather than through a named
helper, so the grep that found the other five missed them.

**Not cached across requests.** It would help: a signed URL changes every second
the clock ticks, so the same avatar is a new URL on each page load and the
browser re-downloads it. But that means handing one person a token minted for
another. Everybody who receives an avatar path is already entitled to the file,
so the argument is winnable — it is still an argument, and it belongs in a change
made deliberately with a measurement behind it.

### `getCurrentUser()` is request-cached

`getUser()` is a **network call**. That is the entire reason the codebase uses it
rather than `getSession()`, which reads the cookie and believes it.

A single render asks two or three times — the shell through `getOwnProfile`, the
page directly — and each call constructed a fresh client, so nothing deduplicated
them. `cache()` scopes one answer to one request, which is exactly how long the
answer is valid.

Not cached any harder than that: a stale session is the thing this function
exists to prevent.

### Four landing sections stopped being client components

`features-section`, `games-section`, `privacy-section` and `final-cta` were
marked `"use client"` while containing no hooks, no handlers and no browser APIs.
They compose `Reveal`, which is the animated part — and a server component may
render a client component and pass it children, so only the wrapper needed to
ship.

`auth-cta.tsx` too: `AuthCta` is a link with a lookup table, and
`AuthDialogProvider` has been a pass-through fragment since the dialog it owned
was replaced by navigation.

240 kB → 230 kB on the public landing page. Modest, and the correct architecture
regardless — markup and copy belong on the server.

---

## 4. Audited, already correct

| Checked                | Found                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event listeners        | 19 added, 19 removed, balanced **per file**                                                                                                                               |
| Realtime subscriptions | Every `.channel()` has a matching removal                                                                                                                                 |
| Shared channel         | Ref-counted; release is idempotent, closes only at zero                                                                                                                   |
| WebRTC cleanup         | `close()` idempotent, clears all three timers, detaches senders **without stopping tracks another connection may be using**, nulls every handler                          |
| Game synchronisation   | Push, not polling — realtime subscription with a matching unsubscribe                                                                                                     |
| Game board timers      | All five tick at 4 Hz and all five stop when the round ends                                                                                                               |
| Chat pagination        | Keyset (`p_before_created_at` + `p_before_id`), bounded page size. Nothing anywhere uses `OFFSET`, which would both slow down and skip rows as messages arrive mid-scroll |
| Context providers      | All three memoise their value                                                                                                                                             |
| Query batching         | Every list query batches; no N+1 remained after §3                                                                                                                        |

---

## 5. Considered and not done

**Framer Motion (149 kB) on the landing page.** Used by four components, all of
them landing. It does not leak into the signed-in app — asserted, because that is
the regression worth catching. Removing it means rewriting the hero and the
scroll reveals in CSS, which is a design change wearing an optimisation's
clothes. The landing page's job is to look good.

**Lazy-loading WebRTC out of `CallProvider`** (~90 kB of source, on every
signed-in page). Tempting, and not done: `usePeerConnection` is a _hook_, called
unconditionally, so it cannot be dynamically imported without restructuring the
most delicate code in the app. The provider also has to stay eager enough to ring
on an incoming call from any page. A first-load-only saving, on assets the
service worker caches immutably, is not worth that risk.

**A bundle-size budget in CI.** Sizes move for reasons nobody caused — a Next
upgrade, a React patch — and a threshold that fails on those gets raised until it
means nothing. The numbers are in §2 with the date they were taken.

**`next/image` for avatars.** It would be _worse_. Avatars are signed URLs whose
signature changes every second, so `/_next/image` would key its cache on a URL
that is never the same twice and re-optimise the same picture on every render. A
plain `<img loading="lazy">` in a token-sized box is right, and has no layout
shift because the box is sized independently of the image.

---

## 6. Testing

```
npm run perf:test    24 assertions
```

Only things that cost a round trip or leak a resource, and that come back
silently. A duplicated signer is not a bug anybody notices — it is four extra
Storage calls per render, and it existed because seven modules each wrote their
own.

The suite found two of them itself, and it also got one check wrong on the first
run: flagging `ringtone.ts`, `shared-channel.ts`, `user-channel.ts` and
`supabase-signaling.ts` as needlessly client. Those are `.ts` modules that are
browser-only through `AudioContext` and the browser Supabase client, which the
heuristic did not know about. The check now looks only at `.tsx` and knows a
wider set of browser APIs — the check was wrong, not the code, which is an
argument for keeping this kind of signal narrow.

### What it cannot tell you

Nothing here is a runtime measurement. No page was loaded, no render was profiled
and no query was timed against a real database. The round-trip counts in §3 are
derived from reading the call graph, and the bundle numbers from the build output.

A profiler on a real deployment would be the next thing, and would answer the one
question this audit could not: whether the 190 kB gzipped per signed-in route
actually costs anything on the devices these six people use.
