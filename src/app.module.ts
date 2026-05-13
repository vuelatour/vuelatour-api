import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { validateEnv } from './config/env.schema';
import type { EnvVars } from './config/env.schema';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AuthGuard } from './common/guards/auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { SupabaseModule } from './modules/supabase/supabase.module';
import { HealthModule } from './modules/health/health.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (raw) => validateEnv(raw),
    }),
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          genReqId: (req) => {
            const headerId = req.headers['x-request-id'];
            return typeof headerId === 'string' && headerId.length > 0
              ? headerId
              : randomUUID();
          },
          transport:
            config.get('NODE_ENV', { infer: true }) === 'development'
              ? {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    translateTime: 'SYS:HH:MM:ss',
                    ignore: 'pid,hostname',
                  },
                }
              : undefined,
          redact: {
            paths: ['req.headers.authorization', 'req.headers.cookie'],
            remove: true,
          },
        },
      }),
    }),
    SupabaseModule,
    HealthModule,
    UsersModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
