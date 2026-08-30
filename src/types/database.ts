/**
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate whenever the schema changes:
 *
 *     npm run db:types
 *
 * The current contents are correct and current: KITH has no tables yet. The
 * first migration in `supabase/migrations/` (Phase 3, identity) will replace
 * this with the real shape, and every Supabase call in the app becomes
 * type-checked against it at that moment — no `any`, no hand-written row types
 * that drift away from the database.
 *
 * Helper aliases live in `src/types/supabase.ts` so that regenerating this file
 * cannot clobber them.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: { [_ in never]: never };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
