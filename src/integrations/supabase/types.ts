export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      companies: {
        Row: {
          app_name: string | null
          brand_accent: string
          brand_primary: string
          created_at: string
          id: string
          is_active: boolean
          logo_url: string | null
          max_accounts: number
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          app_name?: string | null
          brand_accent?: string
          brand_primary?: string
          created_at?: string
          id?: string
          is_active?: boolean
          logo_url?: string | null
          max_accounts?: number
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          app_name?: string | null
          brand_accent?: string
          brand_primary?: string
          created_at?: string
          id?: string
          is_active?: boolean
          logo_url?: string | null
          max_accounts?: number
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      email_domains: {
        Row: {
          company_id: string
          created_at: string
          domain: string
          id: string
          imap_host: string
          imap_port: number
          imap_secure: boolean
          smtp_host: string
          smtp_port: number
          smtp_secure: boolean
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          domain: string
          id?: string
          imap_host: string
          imap_port?: number
          imap_secure?: boolean
          smtp_host: string
          smtp_port?: number
          smtp_secure?: boolean
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          domain?: string
          id?: string
          imap_host?: string
          imap_port?: number
          imap_secure?: boolean
          smtp_host?: string
          smtp_port?: number
          smtp_secure?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_domains_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      mail_accounts: {
        Row: {
          company_id: string
          created_at: string
          credentials_ciphertext: string | null
          display_name: string | null
          email_address: string
          id: string
          imap_host: string | null
          imap_port: number | null
          imap_secure: boolean | null
          is_default: boolean
          last_synced_at: string | null
          normalized_email: string | null
          smtp_host: string | null
          smtp_port: number | null
          smtp_secure: boolean | null
          source_domain_id: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          company_id: string
          created_at?: string
          credentials_ciphertext?: string | null
          display_name?: string | null
          email_address: string
          id?: string
          imap_host?: string | null
          imap_port?: number | null
          imap_secure?: boolean | null
          is_default?: boolean
          last_synced_at?: string | null
          normalized_email?: string | null
          smtp_host?: string | null
          smtp_port?: number | null
          smtp_secure?: boolean | null
          source_domain_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string
          credentials_ciphertext?: string | null
          display_name?: string | null
          email_address?: string
          id?: string
          imap_host?: string | null
          imap_port?: number | null
          imap_secure?: boolean | null
          is_default?: boolean
          last_synced_at?: string | null
          normalized_email?: string | null
          smtp_host?: string | null
          smtp_port?: number | null
          smtp_secure?: boolean | null
          source_domain_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mail_accounts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "mail_accounts_source_domain_fkey"
            columns: ["source_domain_id", "company_id"]
            isOneToOne: false
            referencedRelation: "email_domains"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      mail_folders: {
        Row: {
          account_id: string
          canonical: string | null
          company_id: string
          created_at: string
          delimiter: string | null
          highest_modseq: number | null
          id: string
          last_synced_at: string | null
          path: string
          supported: boolean
          total: number
          uidnext: number | null
          uidvalidity: number | null
          unread: number
          updated_at: string
        }
        Insert: {
          account_id: string
          canonical?: string | null
          company_id: string
          created_at?: string
          delimiter?: string | null
          highest_modseq?: number | null
          id?: string
          last_synced_at?: string | null
          path: string
          supported?: boolean
          total?: number
          uidnext?: number | null
          uidvalidity?: number | null
          unread?: number
          updated_at?: string
        }
        Update: {
          account_id?: string
          canonical?: string | null
          company_id?: string
          created_at?: string
          delimiter?: string | null
          highest_modseq?: number | null
          id?: string
          last_synced_at?: string | null
          path?: string
          supported?: boolean
          total?: number
          uidnext?: number | null
          uidvalidity?: number | null
          unread?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mail_folders_account_company_fkey"
            columns: ["account_id", "company_id"]
            isOneToOne: false
            referencedRelation: "mail_accounts"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      mail_messages: {
        Row: {
          account_id: string
          answered: boolean
          cc_addrs: Json | null
          company_id: string
          created_at: string
          deleted_at: string | null
          draft: boolean
          flagged: boolean
          folder_id: string
          from_addr: Json | null
          has_attachments: boolean
          id: string
          in_reply_to: string | null
          internal_date: string | null
          keywords: string[]
          message_id: string | null
          modseq: number | null
          seen: boolean
          size_bytes: number | null
          subject: string | null
          to_addrs: Json | null
          uid: number
          uidvalidity: number
          updated_at: string
        }
        Insert: {
          account_id: string
          answered?: boolean
          cc_addrs?: Json | null
          company_id: string
          created_at?: string
          deleted_at?: string | null
          draft?: boolean
          flagged?: boolean
          folder_id: string
          from_addr?: Json | null
          has_attachments?: boolean
          id?: string
          in_reply_to?: string | null
          internal_date?: string | null
          keywords?: string[]
          message_id?: string | null
          modseq?: number | null
          seen?: boolean
          size_bytes?: number | null
          subject?: string | null
          to_addrs?: Json | null
          uid: number
          uidvalidity: number
          updated_at?: string
        }
        Update: {
          account_id?: string
          answered?: boolean
          cc_addrs?: Json | null
          company_id?: string
          created_at?: string
          deleted_at?: string | null
          draft?: boolean
          flagged?: boolean
          folder_id?: string
          from_addr?: Json | null
          has_attachments?: boolean
          id?: string
          in_reply_to?: string | null
          internal_date?: string | null
          keywords?: string[]
          message_id?: string | null
          modseq?: number | null
          seen?: boolean
          size_bytes?: number | null
          subject?: string | null
          to_addrs?: Json | null
          uid?: number
          uidvalidity?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mail_messages_account_company_fkey"
            columns: ["account_id", "company_id"]
            isOneToOne: false
            referencedRelation: "mail_accounts"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "mail_messages_folder_company_fkey"
            columns: ["folder_id", "company_id"]
            isOneToOne: false
            referencedRelation: "mail_folders"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      mail_sync_dedupe: {
        Row: {
          account_id: string
          attempt: number
          claimed_at: string | null
          company_id: string
          created_at: string
          dedupe_key: string
          folder_id: string
          kind: string
          msg_id: number
          priority: number
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          account_id: string
          attempt?: number
          claimed_at?: string | null
          company_id: string
          created_at?: string
          dedupe_key: string
          folder_id: string
          kind: string
          msg_id?: number
          priority?: number
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          account_id?: string
          attempt?: number
          claimed_at?: string | null
          company_id?: string
          created_at?: string
          dedupe_key?: string
          folder_id?: string
          kind?: string
          msg_id?: number
          priority?: number
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "mail_sync_dedupe_account_company_fk"
            columns: ["account_id", "company_id"]
            isOneToOne: false
            referencedRelation: "mail_accounts"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "mail_sync_dedupe_folder_company_fk"
            columns: ["folder_id", "company_id"]
            isOneToOne: false
            referencedRelation: "mail_folders"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      mail_sync_schedule: {
        Row: {
          account_id: string
          cadence_seconds: number
          company_id: string
          created_at: string
          enabled: boolean
          folder_id: string
          kind: string
          last_enqueued_at: string | null
          next_run_at: string
          priority: number
          updated_at: string
        }
        Insert: {
          account_id: string
          cadence_seconds?: number
          company_id: string
          created_at?: string
          enabled?: boolean
          folder_id: string
          kind: string
          last_enqueued_at?: string | null
          next_run_at?: string
          priority?: number
          updated_at?: string
        }
        Update: {
          account_id?: string
          cadence_seconds?: number
          company_id?: string
          created_at?: string
          enabled?: boolean
          folder_id?: string
          kind?: string
          last_enqueued_at?: string | null
          next_run_at?: string
          priority?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mail_sync_schedule_account_company_fk"
            columns: ["account_id", "company_id"]
            isOneToOne: false
            referencedRelation: "mail_accounts"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "mail_sync_schedule_folder_company_fk"
            columns: ["folder_id", "company_id"]
            isOneToOne: false
            referencedRelation: "mail_folders"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      mail_sync_state: {
        Row: {
          account_id: string
          attempts: number
          company_id: string
          created_at: string
          error_code: string | null
          error_message: string | null
          flags_need_reconcile: boolean
          folder_id: string | null
          highest_modseq: number | null
          id: string
          last_attempt_at: string | null
          last_reconcile_at: string | null
          last_success_at: string | null
          lock_expires_at: string | null
          locked_at: string | null
          locked_by: string | null
          newest_synced_uid: number | null
          oldest_synced_uid: number | null
          sync_status: string
          uidnext: number | null
          uidvalidity: number | null
          updated_at: string
        }
        Insert: {
          account_id: string
          attempts?: number
          company_id: string
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          flags_need_reconcile?: boolean
          folder_id?: string | null
          highest_modseq?: number | null
          id?: string
          last_attempt_at?: string | null
          last_reconcile_at?: string | null
          last_success_at?: string | null
          lock_expires_at?: string | null
          locked_at?: string | null
          locked_by?: string | null
          newest_synced_uid?: number | null
          oldest_synced_uid?: number | null
          sync_status?: string
          uidnext?: number | null
          uidvalidity?: number | null
          updated_at?: string
        }
        Update: {
          account_id?: string
          attempts?: number
          company_id?: string
          created_at?: string
          error_code?: string | null
          error_message?: string | null
          flags_need_reconcile?: boolean
          folder_id?: string | null
          highest_modseq?: number | null
          id?: string
          last_attempt_at?: string | null
          last_reconcile_at?: string | null
          last_success_at?: string | null
          lock_expires_at?: string | null
          locked_at?: string | null
          locked_by?: string | null
          newest_synced_uid?: number | null
          oldest_synced_uid?: number | null
          sync_status?: string
          uidnext?: number | null
          uidvalidity?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "mail_sync_state_account_company_fkey"
            columns: ["account_id", "company_id"]
            isOneToOne: false
            referencedRelation: "mail_accounts"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "mail_sync_state_folder_company_fkey"
            columns: ["folder_id", "company_id"]
            isOneToOne: false
            referencedRelation: "mail_folders"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          company_id: string | null
          created_at: string
          email: string
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          company_id?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          company_id?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          company_id: string | null
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          company_id?: string | null
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      adjust_mail_folder_counts_atomic: {
        Args: {
          p_account_id: string
          p_company_id: string
          p_folder_id: string
          p_total_delta: number
          p_unread_delta: number
        }
        Returns: {
          total: number
          unread: number
        }[]
      }
      claim_mail_sync_jobs: {
        Args: {
          p_batch_size?: number
          p_global_concurrency?: number
          p_lease_seconds?: number
          p_per_account_concurrency?: number
          p_per_company_concurrency?: number
          p_worker_id: string
        }
        Returns: {
          enqueued_at: string
          message: Json
          msg_id: number
          read_ct: number
          vt: string
        }[]
      }
      claim_mail_sync_lock: {
        Args: {
          p_account_id: string
          p_company_id: string
          p_folder_id: string
          p_locked_by: string
          p_ttl_seconds: number
        }
        Returns: boolean
      }
      cleanup_mail_sync_jobs: {
        Args: {
          p_completed_retention_days?: number
          p_dead_retention_days?: number
        }
        Returns: {
          completed_purged: number
          dead_purged: number
        }[]
      }
      complete_mail_sync_job: {
        Args: { p_msg_id: number; p_worker_id: string }
        Returns: boolean
      }
      enqueue_mail_sync_job: {
        Args: {
          p_account_id: string
          p_company_id: string
          p_delay_seconds?: number
          p_folder_id: string
          p_kind: string
          p_priority?: number
        }
        Returns: {
          dedupe_key: string
          inserted: boolean
          msg_id: number
        }[]
      }
      fail_mail_sync_job: {
        Args: {
          p_action: string
          p_delay_seconds: number
          p_error_code: string
          p_error_message: string
          p_msg_id: number
          p_worker_id: string
        }
        Returns: boolean
      }
      get_mail_sync_queue_metrics: {
        Args: never
        Returns: {
          archived_last_hour: number
          dead: number
          dedupe_active: number
          oldest_queued_seconds: number
          queued: number
          running: number
        }[]
      }
      release_mail_sync_lock: {
        Args: {
          p_account_id: string
          p_company_id: string
          p_error_code?: string
          p_error_msg?: string
          p_folder_id: string
          p_locked_by: string
          p_status: string
        }
        Returns: boolean
      }
      verify_mail_sync_tick_token: {
        Args: { p_token: string }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "super_admin" | "company_admin" | "end_user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["super_admin", "company_admin", "end_user"],
    },
  },
} as const
