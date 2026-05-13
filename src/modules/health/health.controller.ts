import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { SupabaseService } from '../supabase/supabase.service';

@ApiTags('Health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly supabase: SupabaseService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Liveness + Supabase connectivity check' })
  async check() {
    let dbStatus: 'ok' | 'error' = 'ok';
    let dbError: string | undefined;
    try {
      const { error } = await this.supabase.service
        .from('usuario')
        .select('id', { count: 'exact', head: true });
      if (error) {
        dbStatus = 'error';
        dbError = error.message;
      }
    } catch (e) {
      dbStatus = 'error';
      dbError = e instanceof Error ? e.message : 'unknown';
    }
    return {
      status: dbStatus === 'ok' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      supabase: { status: dbStatus, error: dbError },
    };
  }
}
