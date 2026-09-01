/**
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate after every schema change:
 *
 *     npm run db:types
 *
 * Produced by scripts/generate-database-types.mjs, which applies
 * supabase/migrations/ to an in-memory Postgres and introspects the catalog.
 * The migrations are the source of truth; if this file disagrees with them, it
 * is this file that is wrong. `npm run db:types:check` fails CI when they drift.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      blocks: {
        Row: {
          blocker_id: string;
          blocked_id: string;
          reason: string | null;
          created_at: string;
        };
        Insert: {
          blocker_id: string;
          blocked_id: string;
          reason?: string | null;
          created_at?: string;
        };
        Update: {
          blocker_id?: string;
          blocked_id?: string;
          reason?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      call_participants: {
        Row: {
          call_id: string;
          user_id: string;
          joined_at: string | null;
          left_at: string | null;
          media_state: Json;
        };
        Insert: {
          call_id: string;
          user_id: string;
          joined_at?: string | null;
          left_at?: string | null;
          media_state?: Json;
        };
        Update: {
          call_id?: string;
          user_id?: string;
          joined_at?: string | null;
          left_at?: string | null;
          media_state?: Json;
        };
        Relationships: [];
      };
      calls: {
        Row: {
          id: string;
          conversation_id: string;
          initiator_id: string | null;
          kind: Database["public"]["Enums"]["call_kind"];
          status: Database["public"]["Enums"]["call_status"];
          started_at: string;
          answered_at: string | null;
          ended_at: string | null;
          end_reason: Database["public"]["Enums"]["call_end_reason"] | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          conversation_id: string;
          initiator_id?: string | null;
          kind?: Database["public"]["Enums"]["call_kind"];
          status?: Database["public"]["Enums"]["call_status"];
          started_at?: string;
          answered_at?: string | null;
          ended_at?: string | null;
          end_reason?: Database["public"]["Enums"]["call_end_reason"] | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          conversation_id?: string;
          initiator_id?: string | null;
          kind?: Database["public"]["Enums"]["call_kind"];
          status?: Database["public"]["Enums"]["call_status"];
          started_at?: string;
          answered_at?: string | null;
          ended_at?: string | null;
          end_reason?: Database["public"]["Enums"]["call_end_reason"] | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      conversation_members: {
        Row: {
          conversation_id: string;
          user_id: string;
          role: Database["public"]["Enums"]["member_role"];
          joined_at: string;
          left_at: string | null;
          last_read_at: string;
          muted_until: string | null;
        };
        Insert: {
          conversation_id: string;
          user_id: string;
          role?: Database["public"]["Enums"]["member_role"];
          joined_at?: string;
          left_at?: string | null;
          last_read_at?: string;
          muted_until?: string | null;
        };
        Update: {
          conversation_id?: string;
          user_id?: string;
          role?: Database["public"]["Enums"]["member_role"];
          joined_at?: string;
          left_at?: string | null;
          last_read_at?: string;
          muted_until?: string | null;
        };
        Relationships: [];
      };
      conversations: {
        Row: {
          id: string;
          kind: Database["public"]["Enums"]["conversation_kind"];
          title: string | null;
          created_by: string | null;
          dm_key: string | null;
          last_message_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          kind?: Database["public"]["Enums"]["conversation_kind"];
          title?: string | null;
          created_by?: string | null;
          dm_key?: string | null;
          last_message_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          kind?: Database["public"]["Enums"]["conversation_kind"];
          title?: string | null;
          created_by?: string | null;
          dm_key?: string | null;
          last_message_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      couple_answers: {
        Row: {
          prompt_id: string;
          user_id: string;
          body: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          prompt_id: string;
          user_id: string;
          body: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          prompt_id?: string;
          user_id?: string;
          body?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      couple_prompts: {
        Row: {
          id: string;
          couple_id: string;
          prompt_date: string;
          question: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          couple_id: string;
          prompt_date?: string;
          question: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          couple_id?: string;
          prompt_date?: string;
          question?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      couples: {
        Row: {
          id: string;
          user_low: string;
          user_high: string;
          status: Database["public"]["Enums"]["couple_status"];
          proposed_by: string;
          anniversary: string | null;
          created_at: string;
          updated_at: string;
          ended_at: string | null;
          visibility: Database["public"]["Enums"]["couple_visibility"];
        };
        Insert: {
          id?: string;
          user_low: string;
          user_high: string;
          status?: Database["public"]["Enums"]["couple_status"];
          proposed_by: string;
          anniversary?: string | null;
          created_at?: string;
          updated_at?: string;
          ended_at?: string | null;
          visibility?: Database["public"]["Enums"]["couple_visibility"];
        };
        Update: {
          id?: string;
          user_low?: string;
          user_high?: string;
          status?: Database["public"]["Enums"]["couple_status"];
          proposed_by?: string;
          anniversary?: string | null;
          created_at?: string;
          updated_at?: string;
          ended_at?: string | null;
          visibility?: Database["public"]["Enums"]["couple_visibility"];
        };
        Relationships: [];
      };
      friend_requests: {
        Row: {
          id: string;
          requester_id: string;
          addressee_id: string;
          status: Database["public"]["Enums"]["friend_request_status"];
          message: string | null;
          created_at: string;
          responded_at: string | null;
        };
        Insert: {
          id?: string;
          requester_id: string;
          addressee_id: string;
          status?: Database["public"]["Enums"]["friend_request_status"];
          message?: string | null;
          created_at?: string;
          responded_at?: string | null;
        };
        Update: {
          id?: string;
          requester_id?: string;
          addressee_id?: string;
          status?: Database["public"]["Enums"]["friend_request_status"];
          message?: string | null;
          created_at?: string;
          responded_at?: string | null;
        };
        Relationships: [];
      };
      friendships: {
        Row: {
          user_low: string;
          user_high: string;
          became_friends_at: string;
        };
        Insert: {
          user_low: string;
          user_high: string;
          became_friends_at?: string;
        };
        Update: {
          user_low?: string;
          user_high?: string;
          became_friends_at?: string;
        };
        Relationships: [];
      };
      game_moves: {
        Row: {
          session_id: string;
          seq: number;
          player_id: string | null;
          payload: Json;
          created_at: string;
        };
        Insert: {
          session_id: string;
          seq: number;
          player_id?: string | null;
          payload: Json;
          created_at?: string;
        };
        Update: {
          session_id?: string;
          seq?: number;
          player_id?: string | null;
          payload?: Json;
          created_at?: string;
        };
        Relationships: [];
      };
      game_players: {
        Row: {
          session_id: string;
          user_id: string;
          seat: number;
          is_ready: boolean;
          score: number;
          placement: number | null;
          joined_at: string;
          left_at: string | null;
        };
        Insert: {
          session_id: string;
          user_id: string;
          seat: number;
          is_ready?: boolean;
          score?: number;
          placement?: number | null;
          joined_at?: string;
          left_at?: string | null;
        };
        Update: {
          session_id?: string;
          user_id?: string;
          seat?: number;
          is_ready?: boolean;
          score?: number;
          placement?: number | null;
          joined_at?: string;
          left_at?: string | null;
        };
        Relationships: [];
      };
      game_sessions: {
        Row: {
          id: string;
          game_key: string;
          conversation_id: string | null;
          couple_id: string | null;
          host_id: string;
          status: Database["public"]["Enums"]["game_status"];
          state: Json;
          state_version: number;
          seed: number;
          config: Json;
          created_at: string;
          updated_at: string;
          started_at: string | null;
          ended_at: string | null;
          turn_seat: number | null;
          rematch_of: string | null;
        };
        Insert: {
          id?: string;
          game_key: string;
          conversation_id?: string | null;
          couple_id?: string | null;
          host_id: string;
          status?: Database["public"]["Enums"]["game_status"];
          state?: Json;
          state_version?: number;
          seed?: number;
          config?: Json;
          created_at?: string;
          updated_at?: string;
          started_at?: string | null;
          ended_at?: string | null;
          turn_seat?: number | null;
          rematch_of?: string | null;
        };
        Update: {
          id?: string;
          game_key?: string;
          conversation_id?: string | null;
          couple_id?: string | null;
          host_id?: string;
          status?: Database["public"]["Enums"]["game_status"];
          state?: Json;
          state_version?: number;
          seed?: number;
          config?: Json;
          created_at?: string;
          updated_at?: string;
          started_at?: string | null;
          ended_at?: string | null;
          turn_seat?: number | null;
          rematch_of?: string | null;
        };
        Relationships: [];
      };
      games: {
        Row: {
          key: string;
          name: string;
          tagline: string | null;
          audience: Database["public"]["Enums"]["game_audience"];
          pace: Database["public"]["Enums"]["game_pace"];
          min_players: number;
          max_players: number;
          enabled: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          key: string;
          name: string;
          tagline?: string | null;
          audience?: Database["public"]["Enums"]["game_audience"];
          pace?: Database["public"]["Enums"]["game_pace"];
          min_players: number;
          max_players: number;
          enabled?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          key?: string;
          name?: string;
          tagline?: string | null;
          audience?: Database["public"]["Enums"]["game_audience"];
          pace?: Database["public"]["Enums"]["game_pace"];
          min_players?: number;
          max_players?: number;
          enabled?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      invite_codes: {
        Row: {
          id: string;
          code_hash: string;
          created_by: string;
          note: string | null;
          max_uses: number;
          uses: number;
          expires_at: string;
          revoked_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          code_hash: string;
          created_by: string;
          note?: string | null;
          max_uses?: number;
          uses?: number;
          expires_at?: string;
          revoked_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          code_hash?: string;
          created_by?: string;
          note?: string | null;
          max_uses?: number;
          uses?: number;
          expires_at?: string;
          revoked_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      invite_redemptions: {
        Row: {
          invite_id: string;
          user_id: string;
          redeemed_at: string;
        };
        Insert: {
          invite_id: string;
          user_id: string;
          redeemed_at?: string;
        };
        Update: {
          invite_id?: string;
          user_id?: string;
          redeemed_at?: string;
        };
        Relationships: [];
      };
      message_reactions: {
        Row: {
          message_id: string;
          user_id: string;
          emoji: string;
          created_at: string;
        };
        Insert: {
          message_id: string;
          user_id: string;
          emoji: string;
          created_at?: string;
        };
        Update: {
          message_id?: string;
          user_id?: string;
          emoji?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      messages: {
        Row: {
          id: string;
          conversation_id: string;
          sender_id: string | null;
          kind: Database["public"]["Enums"]["message_kind"];
          body: string | null;
          reply_to_id: string | null;
          attachments: Json;
          metadata: Json;
          created_at: string;
          edited_at: string | null;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          conversation_id: string;
          sender_id?: string | null;
          kind?: Database["public"]["Enums"]["message_kind"];
          body?: string | null;
          reply_to_id?: string | null;
          attachments?: Json;
          metadata?: Json;
          created_at?: string;
          edited_at?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          conversation_id?: string;
          sender_id?: string | null;
          kind?: Database["public"]["Enums"]["message_kind"];
          body?: string | null;
          reply_to_id?: string | null;
          attachments?: Json;
          metadata?: Json;
          created_at?: string;
          edited_at?: string | null;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      notifications: {
        Row: {
          id: string;
          user_id: string;
          kind: Database["public"]["Enums"]["notification_kind"];
          actor_id: string | null;
          payload: Json;
          read_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          kind: Database["public"]["Enums"]["notification_kind"];
          actor_id?: string | null;
          payload?: Json;
          read_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          kind?: Database["public"]["Enums"]["notification_kind"];
          actor_id?: string | null;
          payload?: Json;
          read_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          username: string;
          display_name: string;
          avatar_path: string | null;
          bio: string | null;
          pronouns: string | null;
          accent: Database["public"]["Enums"]["profile_accent"];
          status: Database["public"]["Enums"]["presence_status"];
          status_text: string | null;
          status_expires_at: string | null;
          last_seen_at: string;
          created_at: string;
          updated_at: string;
          birthday: string | null;
          username_changed_at: string | null;
          deleted_at: string | null;
        };
        Insert: {
          id: string;
          username: string;
          display_name: string;
          avatar_path?: string | null;
          bio?: string | null;
          pronouns?: string | null;
          accent?: Database["public"]["Enums"]["profile_accent"];
          status?: Database["public"]["Enums"]["presence_status"];
          status_text?: string | null;
          status_expires_at?: string | null;
          last_seen_at?: string;
          created_at?: string;
          updated_at?: string;
          birthday?: string | null;
          username_changed_at?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          id?: string;
          username?: string;
          display_name?: string;
          avatar_path?: string | null;
          bio?: string | null;
          pronouns?: string | null;
          accent?: Database["public"]["Enums"]["profile_accent"];
          status?: Database["public"]["Enums"]["presence_status"];
          status_text?: string | null;
          status_expires_at?: string | null;
          last_seen_at?: string;
          created_at?: string;
          updated_at?: string;
          birthday?: string | null;
          username_changed_at?: string | null;
          deleted_at?: string | null;
        };
        Relationships: [];
      };
      reports: {
        Row: {
          id: string;
          reporter_id: string;
          reported_id: string;
          reason: Database["public"]["Enums"]["report_reason"];
          detail: string | null;
          message_id: string | null;
          conversation_id: string | null;
          status: Database["public"]["Enums"]["report_status"];
          reviewed_at: string | null;
          reviewed_by: string | null;
          moderator_note: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          reporter_id: string;
          reported_id: string;
          reason: Database["public"]["Enums"]["report_reason"];
          detail?: string | null;
          message_id?: string | null;
          conversation_id?: string | null;
          status?: Database["public"]["Enums"]["report_status"];
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          moderator_note?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          reporter_id?: string;
          reported_id?: string;
          reason?: Database["public"]["Enums"]["report_reason"];
          detail?: string | null;
          message_id?: string | null;
          conversation_id?: string | null;
          status?: Database["public"]["Enums"]["report_status"];
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          moderator_note?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      security_events: {
        Row: {
          id: string;
          user_id: string | null;
          event: string;
          ip: string | null;
          user_agent: string | null;
          metadata: Json;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          event: string;
          ip?: string | null;
          user_agent?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          event?: string;
          ip?: string | null;
          user_agent?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Relationships: [];
      };
      user_settings: {
        Row: {
          user_id: string;
          discoverable: boolean;
          who_can_call: Database["public"]["Enums"]["permission_scope"];
          who_can_message: Database["public"]["Enums"]["permission_scope"];
          read_receipts: boolean;
          typing_indicators: boolean;
          theme: Database["public"]["Enums"]["theme_preference"];
          motion: Database["public"]["Enums"]["motion_preference"];
          notification_prefs: Json;
          created_at: string;
          updated_at: string;
          who_can_propose: Database["public"]["Enums"]["permission_scope"];
        };
        Insert: {
          user_id: string;
          discoverable?: boolean;
          who_can_call?: Database["public"]["Enums"]["permission_scope"];
          who_can_message?: Database["public"]["Enums"]["permission_scope"];
          read_receipts?: boolean;
          typing_indicators?: boolean;
          theme?: Database["public"]["Enums"]["theme_preference"];
          motion?: Database["public"]["Enums"]["motion_preference"];
          notification_prefs?: Json;
          created_at?: string;
          updated_at?: string;
          who_can_propose?: Database["public"]["Enums"]["permission_scope"];
        };
        Update: {
          user_id?: string;
          discoverable?: boolean;
          who_can_call?: Database["public"]["Enums"]["permission_scope"];
          who_can_message?: Database["public"]["Enums"]["permission_scope"];
          read_receipts?: boolean;
          typing_indicators?: boolean;
          theme?: Database["public"]["Enums"]["theme_preference"];
          motion?: Database["public"]["Enums"]["motion_preference"];
          notification_prefs?: Json;
          created_at?: string;
          updated_at?: string;
          who_can_propose?: Database["public"]["Enums"]["permission_scope"];
        };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      abandon_stale_games: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      anonymise_account: {
        Args: {
          p_user_id: string;
        };
        Returns: undefined;
      };
      answer_call: {
        Args: {
          p_call_id: string;
        };
        Returns: undefined;
      };
      are_friends: {
        Args: {
          other_user: string;
        };
        Returns: boolean;
      };
      block_user: {
        Args: {
          p_user_id: string;
          p_reason?: string | null;
        };
        Returns: undefined;
      };
      broadcast_call: {
        Args: {
          p_call_id: string;
          p_event: string;
        };
        Returns: undefined;
      };
      broadcast_game: {
        Args: {
          p_session_id: string;
          p_event: string;
          p_public: Json;
          p_private?: Json | null;
        };
        Returns: undefined;
      };
      can_add_conversation_member: {
        Args: {
          target_conversation: string;
          target_user: string;
        };
        Returns: boolean;
      };
      can_call_conversation: {
        Args: {
          p_conversation_id: string;
        };
        Returns: boolean;
      };
      can_open_conversation_with: {
        Args: {
          other_user: string;
        };
        Returns: boolean;
      };
      can_post_to_conversation: {
        Args: {
          target_conversation: string;
        };
        Returns: boolean;
      };
      can_propose_to: {
        Args: {
          other_user: string;
        };
        Returns: boolean;
      };
      can_start_game: {
        Args: {
          p_session_id: string;
        };
        Returns: boolean;
      };
      can_view_game_session: {
        Args: {
          target_session: string;
        };
        Returns: boolean;
      };
      commit_game_move: {
        Args: {
          p_session_id: string;
          p_actor: string;
          p_expected_version: number;
          p_state: Json;
          p_move: Json;
          p_turn_seat?: number | null;
          p_scores?: Json | null;
          p_finished?: boolean | null;
        };
        Returns: number;
      };
      consume_invite: {
        Args: {
          p_code_hash: string;
        };
        Returns: string;
      };
      couple_marker: {
        Args: {
          target_user: string;
        };
        Returns: {
            partner_id: string | null;
            partner_username: string | null;
            partner_display_name: string | null;
            anniversary: string | null;
        }[];
      };
      create_couple_game: {
        Args: {
          p_couple_id: string;
          p_game_key: string;
          p_config?: Json | null;
          p_rematch_of?: string | null;
        };
        Returns: string;
      };
      create_game_session: {
        Args: {
          p_conversation_id: string;
          p_game_key: string;
          p_config?: Json | null;
          p_rematch_of?: string | null;
        };
        Returns: string;
      };
      end_call: {
        Args: {
          p_call_id: string;
          p_reason?: Database["public"]["Enums"]["call_end_reason"] | null;
        };
        Returns: undefined;
      };
      end_couple: {
        Args: {
          p_couple_id: string;
        };
        Returns: undefined;
      };
      expire_abandoned_calls: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      expire_ringing_calls: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      get_active_call: {
        Args: Record<PropertyKey, never>;
        Returns: {
            id: string | null;
            conversation_id: string | null;
            initiator_id: string | null;
            kind: Database["public"]["Enums"]["call_kind"] | null;
            status: Database["public"]["Enums"]["call_status"] | null;
            started_at: string | null;
            answered_at: string | null;
            is_initiator: boolean | null;
            joined_at: string | null;
            other_user_id: string | null;
            other_username: string | null;
            other_display_name: string | null;
            other_avatar_path: string | null;
            participant_count: number | null;
        }[];
      };
      get_game_session: {
        Args: {
          p_session_id: string;
        };
        Returns: {
            id: string | null;
            game_key: string | null;
            game_name: string | null;
            min_players: number | null;
            max_players: number | null;
            pace: Database["public"]["Enums"]["game_pace"] | null;
            audience: Database["public"]["Enums"]["game_audience"] | null;
            conversation_id: string | null;
            couple_id: string | null;
            host_id: string | null;
            status: Database["public"]["Enums"]["game_status"] | null;
            state_version: number | null;
            turn_seat: number | null;
            seed: number | null;
            config: Json | null;
            rematch_of: string | null;
            created_at: string | null;
            started_at: string | null;
            ended_at: string | null;
            my_seat: number | null;
            can_start: boolean | null;
        }[];
      };
      get_my_couple: {
        Args: Record<PropertyKey, never>;
        Returns: {
            id: string | null;
            partner_id: string | null;
            partner_username: string | null;
            partner_display_name: string | null;
            partner_avatar_path: string | null;
            partner_status: Database["public"]["Enums"]["presence_status"] | null;
            partner_last_seen_at: string | null;
            status: Database["public"]["Enums"]["couple_status"] | null;
            visibility: Database["public"]["Enums"]["couple_visibility"] | null;
            anniversary: string | null;
            started_at: string | null;
            prompt_count: number | null;
        }[];
      };
      has_answered_prompt: {
        Args: {
          target_prompt: string;
        };
        Returns: boolean;
      };
      is_blocked_either: {
        Args: {
          other_user: string;
        };
        Returns: boolean;
      };
      is_call_participant: {
        Args: {
          target_call: string;
        };
        Returns: boolean;
      };
      is_conversation_member: {
        Args: {
          target_conversation: string;
        };
        Returns: boolean;
      };
      is_couple_member: {
        Args: {
          target_couple: string;
        };
        Returns: boolean;
      };
      is_couple_prompt_member: {
        Args: {
          target_prompt: string;
        };
        Returns: boolean;
      };
      is_game_player: {
        Args: {
          target_session: string;
        };
        Returns: boolean;
      };
      is_username_available: {
        Args: {
          p_username: string;
        };
        Returns: boolean;
      };
      join_game_session: {
        Args: {
          p_session_id: string;
        };
        Returns: number;
      };
      leave_game_session: {
        Args: {
          p_session_id: string;
        };
        Returns: undefined;
      };
      list_blocked: {
        Args: Record<PropertyKey, never>;
        Returns: {
            id: string | null;
            username: string | null;
            display_name: string | null;
            avatar_path: string | null;
            reason: string | null;
            blocked_at: string | null;
        }[];
      };
      list_calls: {
        Args: {
          p_limit?: number | null;
          p_before?: string | null;
        };
        Returns: {
            id: string | null;
            conversation_id: string | null;
            initiator_id: string | null;
            kind: Database["public"]["Enums"]["call_kind"] | null;
            status: Database["public"]["Enums"]["call_status"] | null;
            started_at: string | null;
            answered_at: string | null;
            ended_at: string | null;
            end_reason: Database["public"]["Enums"]["call_end_reason"] | null;
            is_initiator: boolean | null;
            joined_at: string | null;
            duration_seconds: number | null;
            other_user_id: string | null;
            other_username: string | null;
            other_display_name: string | null;
            other_avatar_path: string | null;
            participant_count: number | null;
        }[];
      };
      list_conversations: {
        Args: Record<PropertyKey, never>;
        Returns: {
            conversation_id: string | null;
            kind: Database["public"]["Enums"]["conversation_kind"] | null;
            title: string | null;
            last_message_at: string | null;
            last_message_body: string | null;
            last_message_sender_id: string | null;
            last_message_kind: Database["public"]["Enums"]["message_kind"] | null;
            unread_count: number | null;
            member_count: number | null;
            other_user_id: string | null;
            other_username: string | null;
            other_display_name: string | null;
            other_avatar_path: string | null;
            other_status: Database["public"]["Enums"]["presence_status"] | null;
            other_last_seen_at: string | null;
        }[];
      };
      list_couple_games: {
        Args: {
          p_couple_id: string;
          p_limit?: number | null;
        };
        Returns: {
            id: string | null;
            game_key: string | null;
            game_name: string | null;
            status: Database["public"]["Enums"]["game_status"] | null;
            our_score: number | null;
            created_at: string | null;
            ended_at: string | null;
        }[];
      };
      list_couple_invitations: {
        Args: Record<PropertyKey, never>;
        Returns: {
            id: string | null;
            direction: string | null;
            other_id: string | null;
            other_username: string | null;
            other_display_name: string | null;
            other_avatar_path: string | null;
            created_at: string | null;
        }[];
      };
      list_couple_prompts: {
        Args: {
          p_couple_id: string;
          p_limit?: number | null;
        };
        Returns: {
            id: string | null;
            prompt_date: string | null;
            question: string | null;
            my_answer: string | null;
            partner_answer: string | null;
            partner_has_answered: boolean | null;
            created_at: string | null;
        }[];
      };
      list_friend_requests: {
        Args: {
          p_direction: string;
        };
        Returns: {
            request_id: string | null;
            created_at: string | null;
            message: string | null;
            id: string | null;
            username: string | null;
            display_name: string | null;
            avatar_path: string | null;
            pronouns: string | null;
            accent: Database["public"]["Enums"]["profile_accent"] | null;
            status: Database["public"]["Enums"]["presence_status"] | null;
            last_seen_at: string | null;
        }[];
      };
      list_friends: {
        Args: Record<PropertyKey, never>;
        Returns: {
            id: string | null;
            username: string | null;
            display_name: string | null;
            avatar_path: string | null;
            bio: string | null;
            pronouns: string | null;
            accent: Database["public"]["Enums"]["profile_accent"] | null;
            status: Database["public"]["Enums"]["presence_status"] | null;
            status_text: string | null;
            last_seen_at: string | null;
            friends_since: string | null;
        }[];
      };
      list_game_players: {
        Args: {
          p_session_id: string;
        };
        Returns: {
            user_id: string | null;
            username: string | null;
            display_name: string | null;
            avatar_path: string | null;
            seat: number | null;
            is_ready: boolean | null;
            score: number | null;
            placement: number | null;
            is_host: boolean | null;
            left_at: string | null;
        }[];
      };
      list_game_sessions: {
        Args: {
          p_conversation_id: string;
          p_limit?: number | null;
        };
        Returns: {
            id: string | null;
            game_key: string | null;
            game_name: string | null;
            status: Database["public"]["Enums"]["game_status"] | null;
            host_id: string | null;
            player_count: number | null;
            max_players: number | null;
            am_i_in: boolean | null;
            created_at: string | null;
            ended_at: string | null;
        }[];
      };
      list_games: {
        Args: Record<PropertyKey, never>;
        Returns: {
            key: string | null;
            name: string | null;
            tagline: string | null;
            audience: Database["public"]["Enums"]["game_audience"] | null;
            pace: Database["public"]["Enums"]["game_pace"] | null;
            min_players: number | null;
            max_players: number | null;
            enabled: boolean | null;
        }[];
      };
      list_messages: {
        Args: {
          p_conversation_id: string;
          p_before_created_at?: string | null;
          p_before_id?: string | null;
          p_limit?: number | null;
        };
        Returns: {
            id: string | null;
            conversation_id: string | null;
            sender_id: string | null;
            kind: Database["public"]["Enums"]["message_kind"] | null;
            body: string | null;
            reply_to_id: string | null;
            created_at: string | null;
            edited_at: string | null;
            deleted_at: string | null;
            sender_username: string | null;
            sender_display_name: string | null;
            sender_avatar_path: string | null;
            reactions: Json | null;
        }[];
      };
      list_my_game_sessions: {
        Args: {
          p_limit?: number | null;
        };
        Returns: {
            id: string | null;
            game_key: string | null;
            game_name: string | null;
            status: Database["public"]["Enums"]["game_status"] | null;
            conversation_id: string | null;
            conversation_title: string | null;
            player_count: number | null;
            max_players: number | null;
            my_seat: number | null;
            my_score: number | null;
            my_placement: number | null;
            created_at: string | null;
            ended_at: string | null;
        }[];
      };
      list_my_sessions: {
        Args: Record<PropertyKey, never>;
        Returns: {
            id: string | null;
            created_at: string | null;
            refreshed_at: string | null;
            user_agent: string | null;
            ip: string | null;
            aal: string | null;
        }[];
      };
      list_notifications: {
        Args: {
          p_limit?: number | null;
        };
        Returns: {
            id: string | null;
            kind: Database["public"]["Enums"]["notification_kind"] | null;
            payload: Json | null;
            read_at: string | null;
            created_at: string | null;
            actor_id: string | null;
            actor_username: string | null;
            actor_display_name: string | null;
            actor_avatar_path: string | null;
        }[];
      };
      mark_conversation_read: {
        Args: {
          p_conversation_id: string;
        };
        Returns: undefined;
      };
      mark_notifications_read: {
        Args: {
          p_ids?: string[] | null;
        };
        Returns: number;
      };
      mfa_satisfied: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      open_couple_prompt: {
        Args: {
          p_couple_id: string;
          p_question: string;
        };
        Returns: string;
      };
      partner_answered_prompt: {
        Args: {
          target_prompt: string;
        };
        Returns: boolean;
      };
      propose_couple: {
        Args: {
          other_user: string;
        };
        Returns: string;
      };
      prune_notifications: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      record_invite_redemption: {
        Args: {
          p_invite_id: string;
          p_user_id: string;
        };
        Returns: undefined;
      };
      release_invite: {
        Args: {
          p_invite_id: string;
        };
        Returns: undefined;
      };
      report_user: {
        Args: {
          p_reported_id: string;
          p_reason: Database["public"]["Enums"]["report_reason"];
          p_detail?: string | null;
          p_message_id?: string | null;
          p_conversation_id?: string | null;
        };
        Returns: string;
      };
      respond_to_couple: {
        Args: {
          p_couple_id: string;
          p_accept: boolean;
        };
        Returns: Database["public"]["Enums"]["couple_status"];
      };
      ring_timeout: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      search_profiles: {
        Args: {
          p_query: string;
        };
        Returns: {
            id: string | null;
            username: string | null;
            display_name: string | null;
            avatar_path: string | null;
            bio: string | null;
            pronouns: string | null;
            accent: Database["public"]["Enums"]["profile_accent"] | null;
            status: Database["public"]["Enums"]["presence_status"] | null;
            status_text: string | null;
            last_seen_at: string | null;
            relationship: string | null;
        }[];
      };
      set_call_media_state: {
        Args: {
          p_call_id: string;
          p_state: Json;
        };
        Returns: undefined;
      };
      set_couple_details: {
        Args: {
          p_couple_id: string;
          p_anniversary?: string | null;
          p_visibility?: Database["public"]["Enums"]["couple_visibility"] | null;
        };
        Returns: undefined;
      };
      set_game_ready: {
        Args: {
          p_session_id: string;
          p_ready: boolean;
        };
        Returns: undefined;
      };
      start_call: {
        Args: {
          p_conversation_id: string;
          p_kind?: Database["public"]["Enums"]["call_kind"] | null;
        };
        Returns: string;
      };
      start_dm: {
        Args: {
          other_user: string;
        };
        Returns: string;
      };
      start_game_session: {
        Args: {
          p_session_id: string;
          p_actor: string;
          p_state: Json;
          p_turn_seat?: number | null;
        };
        Returns: number;
      };
      start_group: {
        Args: {
          p_title: string;
          p_member_ids: string[];
        };
        Returns: string;
      };
      toggle_reaction: {
        Args: {
          p_message_id: string;
          p_emoji: string;
        };
        Returns: boolean;
      };
      topic_uuid: {
        Args: {
          topic: string;
          prefix: string;
        };
        Returns: string;
      };
      touch_last_seen: {
        Args: Record<PropertyKey, never>;
        Returns: undefined;
      };
      unblock_user: {
        Args: {
          p_user_id: string;
        };
        Returns: undefined;
      };
    };
    Enums: {
      call_end_reason: "hung_up" | "declined" | "missed" | "failed" | "cancelled" | "expired";
      call_kind: "audio" | "video";
      call_status: "ringing" | "active" | "ended" | "missed" | "declined";
      conversation_kind: "dm" | "group";
      couple_status: "pending" | "active" | "ended";
      couple_visibility: "private" | "friends";
      friend_request_status: "pending" | "accepted" | "declined" | "cancelled";
      game_audience: "group" | "couple";
      game_pace: "turn_based" | "realtime";
      game_status: "lobby" | "active" | "finished" | "abandoned";
      member_role: "owner" | "member";
      message_kind: "text" | "image" | "file" | "system" | "call_event";
      motion_preference: "full" | "reduced" | "off";
      notification_kind: "friend_request" | "friend_accepted" | "message" | "call_missed" | "game_invite" | "couple_request" | "couple_prompt" | "system";
      permission_scope: "everyone" | "friends" | "nobody";
      presence_status: "auto" | "active" | "away" | "busy" | "invisible";
      profile_accent: "ember" | "lantern" | "moss" | "signal" | "plum" | "ice";
      report_reason: "harassment" | "threats" | "spam" | "impersonation" | "inappropriate_content" | "other";
      report_status: "open" | "reviewing" | "actioned" | "dismissed";
      theme_preference: "dusk" | "daylight" | "system";
    };
    CompositeTypes: { [_ in never]: never };
  };
};
