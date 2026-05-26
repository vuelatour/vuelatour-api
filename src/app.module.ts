import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { validateEnv } from './config/env.schema';
import type { EnvVars } from './config/env.schema';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AuthModule } from './common/auth/auth.module';
import { AuthGuard } from './common/guards/auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { SupabaseModule } from './modules/supabase/supabase.module';
import { HealthModule } from './modules/health/health.module';
import { UsersModule } from './modules/users/users.module';
import { MeModule } from './modules/me/me.module';
import { AircraftModule } from './modules/aircraft/aircraft.module';
import { EnginesModule } from './modules/engines/engines.module';
import { PropellersModule } from './modules/propellers/propellers.module';
import { ClientsModule } from './modules/clients/clients.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { BankAccountsModule } from './modules/bank-accounts/bank-accounts.module';
import { CardsModule } from './modules/cards/cards.module';
import { AirportsModule } from './modules/airports/airports.module';
import { IssuingEntitiesModule } from './modules/issuing-entities/issuing-entities.module';
import { RoutesModule } from './modules/routes/routes.module';
import { QuotesModule } from './modules/quotes/quotes.module';
import { FlightsModule } from './modules/flights/flights.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { PilotsModule } from './modules/pilots/pilots.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { FacturacionModule } from './modules/facturacion/facturacion.module';
import { EngineeringModule } from './modules/engineering/engineering.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { CajaChicaModule } from './modules/caja-chica/caja-chica.module';
import { ConciliacionModule } from './modules/conciliacion/conciliacion.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env.local', '.env'],
      validate: (raw) => validateEnv(raw),
    }),
    ScheduleModule.forRoot(),
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
    AuthModule,
    HealthModule,
    UsersModule,
    MeModule,
    AircraftModule,
    EnginesModule,
    PropellersModule,
    ClientsModule,
    ProvidersModule,
    BankAccountsModule,
    CardsModule,
    AirportsModule,
    IssuingEntitiesModule,
    RoutesModule,
    QuotesModule,
    FlightsModule,
    CalendarModule,
    ExpensesModule,
    PilotsModule,
    RealtimeModule,
    AlertsModule,
    FacturacionModule,
    EngineeringModule,
    InventoryModule,
    CajaChicaModule,
    ConciliacionModule,
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
