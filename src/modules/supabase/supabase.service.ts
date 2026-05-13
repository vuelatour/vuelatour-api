import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { EnvVars } from '../../config/env.schema';

@Injectable()
export class SupabaseService implements OnModuleInit {
  private serviceClient!: SupabaseClient;
  private supabaseUrl!: string;
  private anonKey!: string;

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  onModuleInit() {
    this.supabaseUrl = this.config.get('SUPABASE_URL', { infer: true });
    this.anonKey = this.config.get('SUPABASE_ANON_KEY', { infer: true });
    const serviceKey = this.config.get('SUPABASE_SERVICE_ROLE_KEY', { infer: true });

    this.serviceClient = createClient(this.supabaseUrl, serviceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  get service(): SupabaseClient {
    return this.serviceClient;
  }

  forRequest(jwt: string): SupabaseClient {
    return createClient(this.supabaseUrl, this.anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
      },
    });
  }
}
