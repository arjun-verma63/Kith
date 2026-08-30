/**
 * Every word on the landing page, in one file.
 *
 * Copy is the loudest signal of whether a product was made by people. Keeping it
 * out of the JSX means it can be read and edited as writing, in one sitting,
 * without hunting through markup — and it makes the voice easy to audit: plain,
 * warm, specific, and never claiming more than the architecture actually does.
 */

export const NAV_LINKS = [
  { href: "#room", label: "The room" },
  { href: "#features", label: "Features" },
  { href: "#games", label: "Games" },
  { href: "#privacy", label: "Privacy" },
] as const;

export const HERO = {
  eyebrow: "Invitation only",
  headline: ["Your people.", "Your space."],
  lead: "A private room for the handful of people you actually talk to. Messages, calls, and games worth staying up for. No feed, no algorithm, no strangers.",
  primaryCta: "Request an invite",
  secondaryCta: "Sign in",
  roomLabel: "In the room",
  arrivalNote: "just came online",
} as const;

export const PREVIEW = {
  eyebrow: "The room",
  index: "01",
  title: "Everything happens in one place.",
  lead: "One window. Talk, call, play, and see who is around — without switching apps or losing the thread.",
  tabs: [
    { key: "messages", label: "Messages" },
    { key: "calls", label: "Calls" },
    { key: "games", label: "Games" },
  ],
} as const;

export const FEATURES = {
  eyebrow: "What it is",
  index: "02",
  title: "Built for six, not six million.",
  lead: "Almost every decision in KITH gets easier when the room is small. So we made the room small on purpose.",
  items: [
    {
      number: "01",
      title: "Presence you can feel",
      body: "You can see who is around before you say anything. Their light comes up when they arrive and cools when they drift off. No status menus, no green dots, no “active 3 hours ago”.",
    },
    {
      number: "02",
      title: "Messages that stay put",
      body: "No discovery, no suggestions, no accounts you did not ask for. Conversations with the people already in the room, and no way for anyone else to get in.",
    },
    {
      number: "03",
      title: "Calls that go direct",
      body: "Voice, video and screen share connect peer to peer. Your call does not route through a datacentre unless your network leaves it no other option.",
    },
    {
      number: "04",
      title: "Your people, always in view",
      body: "Everyone you know here sits at the bottom of the sidebar, permanently. Not a list you open — just who is in the room with you. That only works because there are six of you.",
    },
  ],
} as const;

export const GAMES = {
  eyebrow: "Games",
  index: "03",
  title: "Something to do with your hands.",
  lead: "Turn-based games you can pick up mid-conversation, and fast ones for when everyone is already on a call. Scores are kept. Nobody forgets who won.",
  items: [
    { name: "Word Rush", kind: "Fast", players: "2–6", note: "Sixty seconds. One letter. Go." },
    { name: "Draw & Guess", kind: "Fast", players: "3–6", note: "Your friends cannot draw." },
    {
      name: "Trivia Night",
      kind: "Turn-based",
      players: "2–6",
      note: "Rounds you can leave and come back to.",
    },
    {
      name: "Co-op Escape",
      kind: "Co-op",
      players: "2–4",
      note: "One room, four people, no talking over each other.",
    },
  ],
  footnote:
    "Every game is one folder and one row in a table — the engine, lobby, scoring and rematch flow are shared. Adding one is a weekend, not a quarter.",
} as const;

export const COUPLE = {
  eyebrow: "Couple",
  index: "04",
  title: "A smaller room inside the room.",
  lead: "If two of you want a corner of KITH to yourselves, you can have one. It is warmer and quieter in there. It is not covered in hearts.",
  question: "What is something you changed your mind about this year?",
  answered: {
    name: "Ada",
    text: "That I hate mornings. Turns out I hate my alarm.",
  },
  waiting: {
    name: "Rafa",
    hint: "Answer to reveal",
  },
  points: [
    "A daily question you both answer before either of you can read the other's.",
    "Games built for two, not six-player games with four seats empty.",
    "The dates you would otherwise forget, kept somewhere you will both see them.",
  ],
} as const;

export const PRIVACY = {
  eyebrow: "Privacy",
  index: "05",
  title: "Nobody gets in.",
  lead: "Private is a structural claim, not a marketing one. Here is exactly what it means in KITH, and what it does not.",
  specs: [
    {
      label: "Invitation only",
      body: "There is no public sign-up page. Without a valid invite from someone already inside, an account cannot be created at all.",
    },
    {
      label: "Enforced in the database",
      body: "Who can read what is a Postgres row-level rule, not an application check. A bug in the interface cannot leak a conversation, because the interface was never the thing holding the door.",
    },
    {
      label: "Two-factor, properly",
      body: "App-based two-factor codes, and the operations that matter re-verify them at the database level rather than trusting a screen you have already passed.",
    },
    {
      label: "Calls go direct",
      body: "Voice and video connect peer to peer. We record who called whom and for how long, so you have a call history. We never see or store what was said.",
    },
    {
      label: "Nothing to sell",
      body: "No ads, no trackers, no third-party analytics. There is no business model here that would ever require reading your messages.",
    },
  ],
  honest: {
    label: "What we do not claim",
    body: "Messages are not end-to-end encrypted. They are stored encrypted at rest in a database we operate, which means an administrator with direct database access could read them. If that is not good enough for what you need to say, use Signal — we would rather tell you that than imply otherwise.",
  },
} as const;

export const FINAL_CTA = {
  title: "Six people. One room.",
  lead: "KITH opens by invitation. If someone sent you here, you already have everything you need to get in.",
  primaryCta: "Request an invite",
  secondaryCta: "Sign in",
} as const;

export const FOOTER = {
  tagline: "Your people. Your space.",
  note: "Built for six people, and it shows.",
} as const;

export const AUTH_DIALOG = {
  "request-invite": {
    title: "KITH is invitation only",
    description: "There is no public sign-up, by design.",
    body: "Accounts can only be created with an invite from someone already inside. If you know someone in a KITH room, ask them — they can send you one from their settings. If you do not, this is not the product for you yet, and that is the point.",
  },
  "sign-in": {
    title: "Sign in is not open yet",
    description: "Accounts arrive in the next phase of the build.",
    body: "KITH is being built in public, one working phase at a time. Authentication — invite-gated sign-up, email verification, password recovery and two-factor — is next. Nothing here is a mockup waiting to be wired up; when this button signs you in, it will be because sign-in actually exists.",
  },
} as const;
