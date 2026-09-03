import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { ConfiguracionModule } from '../configuracion/configuracion.module';
import { PilotsModule } from '../pilots/pilots.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { UsersModule } from '../users/users.module';
import { MeCapturasService } from './me-capturas.service';
import { MeController } from './me.controller';

@Module({
  imports: [
    UsersModule,
    PilotsModule,
    ConfiguracionModule,
    CalendarModule,
    RealtimeModule,
  ],
  controllers: [MeController],
  providers: [MeCapturasService],
})
export class MeModule {}
