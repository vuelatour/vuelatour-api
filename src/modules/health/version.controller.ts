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

@ApiTags('Health')
@Controller({ path: 'version', version: '1' })
export class VersionController {
  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'API name, version and environment' })
  get() {
    return {
      name: pkg.name,
      version: pkg.version,
      env: this.config.get('NODE_ENV', { infer: true }),
    };
  }
}
