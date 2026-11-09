import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import type { EnvVars } from '../../config/env.schema';

interface PackageJson {
  name: string;
  version: string;
}

const pkg = JSON.parse(
  readFileSync(join(process.cwd(), 'package.json'), 'utf-8'),
) as PackageJson;

/** Cuánto se espera a pyservices para su `/version` (no es un health). */
export const PYSERVICES_VERSION_TIMEOUT_MS = 3000;

@ApiTags('Health')
@Controller({ path: 'version', version: '1' })
export class VersionController {
  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'API name, version and environment (+ pyservices commit)',
  })
  async get() {
    return {
      name: pkg.name,
      version: pkg.version,
      env: this.config.get('NODE_ENV', { infer: true }),
      // COMPUERTA de pyservices (9-nov-2026, API 0.0.129): el commit
      // DESPLEGADO de pyservices (`GET <PYSERVICES_BASE_URL>/version`, ruta
      // pública que solo dice qué código corre). Su URL en Railway es
      // interna (`*.railway.internal`) y no se alcanza desde fuera: el API
      // la consulta por quien verifica un deploy. null si no está
      // configurado o no responde a tiempo; nunca tumba esta ruta.
      pyservices: await this.versionPyservices(),
    };
  }

  private async versionPyservices(): Promise<{
    commit: string | null;
  } | null> {
    const baseUrl = this.config
      .get('PYSERVICES_BASE_URL', { infer: true })
      ?.replace(/\/+$/, '');
    if (!baseUrl) return null;
    try {
      const res = await fetch(`${baseUrl}/version`, {
        signal: AbortSignal.timeout(PYSERVICES_VERSION_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { commit?: unknown };
      return {
        commit: typeof body.commit === 'string' ? body.commit : null,
      };
    } catch {
      return null;
    }
  }
}
